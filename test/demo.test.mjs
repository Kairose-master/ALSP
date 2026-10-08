import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evmSigner, verifyBuyerSeal, verifyChain } from '../dist/index.js';
import { handle } from '../demo/handler.mjs';
import { BrowserJournal, BrowserSessionClient, PROFILE, canonical, digest, sha256Text, verifyChain as browserVerifyChain } from '../public/alsp-browser.js';
import { createMockProvider } from './mock-provider.mjs';

// Public throwaway buyer key. MUST NEVER be funded.
const BUYER_KEY = `0x${'11'.repeat(32)}`;
const memoryStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
function sharedLocks() {
  const tails = new Map();
  return { request(name, _options, callback) {
    const previous = tails.get(name) ?? Promise.resolve();
    let release;
    const tail = new Promise(resolve => { release = resolve; });
    tails.set(name, tail);
    return previous.then(callback).finally(release);
  } };
}

/** Drives the browser client exactly like app.js does, against the stateless handler and an in-process provider. */
async function harness({ price = '1000', origin = 'https://oracle.example', maxTotal = '3000', locks = sharedLocks() , receiptMode = 'signed' } = {}) {
  const mock = createMockProvider({ price, origin , receiptMode });
  const deps = { fetchImpl: mock.fetchImpl };
  const api = {
    post: async (path, body) => { const [status, data] = await handle('POST', path, JSON.stringify(body), deps); if (status !== 200) throw new Error(data.error); return data; },
    probe: (p, t, i) => api.post('/api/x402/probe', { provider: p, terms: t, input: i }),
    send: (p, t, i, prepared, nonce) => api.post('/api/x402/send', { provider: p, terms: t, input: i, prepared, nonce }),
    verify: (p, t, call, pins, rpcUrl) => api.post('/api/x402/verify', { provider: p, terms: t, call, pins, rpcUrl }),
    verifyArchive: archive => api.post('/api/archive/verify', { archive }),
  };
  const signer = evmSigner(BUYER_KEY);
  const wallet = { address: signer.address, prepare: signer.prepare, signMessage: signer.signManifest };
  const journal = new BrowserJournal(memoryStorage(), locks);
  const { profile } = mock, providerJson = JSON.parse(JSON.stringify(profile));
  const terms = { profile: PROFILE, payer: signer.address, provider: profile.payTo, network: profile.network, asset: profile.asset.address, endpoint: `${profile.origin}${profile.endpointPath}`, maxTotal, maxPerCall: '1000', maxCalls: 3, expiresAt: Date.now() + 600000, license: { uri: 'urn:alsp:test', sha256: await sha256Text('reviewed fixture terms'), acceptance: 'buyer-only' } };
  const sessionId = await journal.create(terms, providerJson);
  const steps = [];
  const client = new BrowserSessionClient(journal, { api, wallet, pins: [{ address: mock.signer }], rpcUrl: `${origin}/rpc`, onStep: s => steps.push(s) });
  return { mock, api, journal, wallet, terms, sessionId, client, steps };
}

test('two BrowserJournal instances serialize reservations against the shared session budget', async () => {
  const locks = sharedLocks(), h = await harness({ maxTotal: '1000', locks });
  const second = new BrowserJournal(h.journal.storage, locks);
  const quote = { accepted: { amount: '1000' } };
  const results = await Promise.allSettled([
    h.journal.reserve(h.sessionId, 'tab-a', { symbol: 'BTC-USDT' }, quote),
    second.reserve(h.sessionId, 'tab-b', { symbol: 'ETH-USDT' }, quote),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /Session budget exceeded/);
  assert.equal(h.journal.calls(h.sessionId).length, 1);
  assert.equal((await h.journal.export(h.sessionId)).summary.allocatedTotal, '1000');
});

test('corrupt or inaccessible browser storage fails closed and is never treated as an empty journal', async () => {
  const malformed = new BrowserJournal({ getItem: () => '{not json', setItem: () => { throw new Error('must not overwrite'); } });
  assert.throws(() => malformed.load(), /Journal data is corrupted/);
  assert.throws(() => malformed.list(), /Journal data is corrupted/);
  const blocked = new BrowserJournal({ getItem: () => { throw new Error('storage blocked'); }, setItem: () => {} });
  assert.throws(() => blocked.load(), /Journal storage is unavailable/);
  const invalidShape = new BrowserJournal({ getItem: () => JSON.stringify({ sessions: {}, receipts: {} }), setItem: () => {} });
  assert.throws(() => invalidShape.load(), /Journal data is invalid/);
});

test('browser journal + stateless proxy: two real signatures, one replay, archive verifies with the library', async () => {
  const h = await harness();
  const a = await h.client.call(h.sessionId, 'one', { symbol: 'BTC-USDT' });
  assert.equal(a.state, 'VERIFIED'); assert.equal(a.verified.ledger.verification, 'rpc-confirmed'); assert.equal(a.verified.receipt.signer, h.mock.signer.toLowerCase());
  const replay = await h.client.call(h.sessionId, 'one', { symbol: 'BTC-USDT' });
  assert.equal(replay.id, a.id); assert.equal(h.mock.state.paid, 1);
  await assert.rejects(h.client.call(h.sessionId, 'one', { symbol: 'ETH-USDT' }), /different input/);
  const b = await h.client.call(h.sessionId, 'two', { symbol: 'ETH-USDT' });
  assert.equal(b.state, 'VERIFIED'); assert.equal(h.mock.state.paid, 2);
  await h.journal.end(h.sessionId);
  const report = await h.journal.export(h.sessionId);
  assert.equal(report.summary.state, 'CLOSED'); assert.equal(report.summary.verifiedSpent, '2000');
  assert.ok(verifyChain(report)); assert.ok(await browserVerifyChain(report));
  // Buyer seal from the browser-side flow verifies with the Node library.
  const manifest = { profile: PROFILE, sessionId: h.sessionId, archiveSha256: await digest(report), headHash: report.headHash };
  const archive = { ...report, buyerSeal: { manifest, signer: h.wallet.address, signature: await h.wallet.signMessage(canonical(manifest)) } };
  assert.equal(await verifyBuyerSeal(archive, h.wallet.address), true);
  const remote = await h.api.verifyArchive(archive);
  assert.deepEqual({ chain: remote.chain, seal: remote.seal }, { chain: true, seal: true });
  archive.events[0].event.amount = '2'; assert.equal(verifyChain(archive), false);
  assert.ok(!JSON.stringify(report).includes(a.prepared.signature), 'bearer signature must not appear in the exported archive');
});
test('lost response keeps the reservation; reconciliation with the recovered original response verifies without a new payment', async () => {
  const h = await harness();
  h.mock.setFault('lost-response');
  const c = await h.client.call(h.sessionId, 'one', { symbol: 'BTC-USDT' });
  assert.equal(c.state, 'RECONCILIATION_REQUIRED'); assert.equal(c.wire, null); assert.equal(h.mock.state.paid, 1);
  h.mock.setFault('none');
  await h.journal.end(h.sessionId);
  await assert.rejects(h.journal.resume(h.sessionId), /Unresolved/);
  assert.equal((await h.journal.export(h.sessionId)).summary.state, 'RECONCILIATION_REQUIRED');
  assert.equal((await h.client.reconcile(c.id)).state, 'RECONCILIATION_REQUIRED');
  const recovered = h.mock.recover(c.nonce);
  assert.equal((await h.client.reconcile(c.id, recovered)).state, 'VERIFIED');
  assert.equal(h.mock.state.paid, 1);
});
test('RPC outage after capture is reconciled later; unpinned receipt signer fails closed', async () => {
  const h = await harness();
  h.mock.setFault('rpc-down');
  const c = await h.client.call(h.sessionId, 'one', { symbol: 'BTC-USDT' });
  assert.equal(c.state, 'RECONCILIATION_REQUIRED'); assert.ok(c.wire);
  h.mock.setFault('none');
  assert.equal((await h.client.reconcile(c.id)).state, 'VERIFIED');
  h.mock.setFault('bad-receipt');
  const bad = await h.client.call(h.sessionId, 'two', { symbol: 'ETH-USDT' });
  assert.equal(bad.state, 'RECONCILIATION_REQUIRED');
  h.mock.setFault('none');
  assert.equal((await h.client.reconcile(bad.id)).state, 'RECONCILIATION_REQUIRED', 'a receipt signed by an unpinned key never verifies');
});
test('quotes above the per-call cap are refused before any reservation or signature', async () => {
  const h = await harness({ price: '5000' });
  await assert.rejects(h.client.call(h.sessionId, 'one', { symbol: 'BTC-USDT' }), /No supported exact/);
  assert.equal(h.journal.calls(h.sessionId).length, 0); assert.equal(h.mock.state.paid, 0);
});
test('proxy refuses private origins, non-HTTPS providers, oversized bodies and unknown routes', async () => {
  const custom = { id: 'x', label: 'x', origin: 'https://oracle.example', endpointPath: '/api/v1/quote', method: 'GET', network: 'eip155:8453', asset: { address: `0x${'aa'.repeat(20)}`, name: 'USD Coin', version: '2' }, payTo: `0x${'bb'.repeat(20)}`, receipt: { route: 'GET /api/v1/quote', service: 'x', certHeader: 'x' } };
  for (const origin of ['https://127.0.0.1', 'https://localhost', 'https://10.0.0.1', 'https://foo.internal', 'http://oracle.example']) {
    const [status, data] = await handle('POST', '/api/x402/signer', JSON.stringify({ provider: { ...custom, origin } }));
    assert.equal(status, 400); assert.match(data.error, /HTTPS|loopback/i);
  }
  assert.equal((await handle('POST', '/api/x402/probe', 'x'.repeat(600000)))[0], 413);
  assert.equal((await handle('GET', '/api/nope', ''))[0], 404);
  const [, meta] = await handle('GET', '/api/meta', '');
  assert.ok(meta.presets['x402-doctor']); assert.equal(meta.presets['x402-doctor'].input, undefined);
});
test('send endpoint re-validates the signed authorization against the terms and nonce', async () => {
  const h = await harness();
  const providerJson = JSON.parse(JSON.stringify(h.mock.profile));
  const { quote } = await h.api.probe(providerJson, h.terms, { symbol: 'BTC-USDT' });
  const nonce = `0x${'77'.repeat(32)}`;
  const prepared = await h.wallet.prepare(quote, h.terms, nonce, Date.now());
  await assert.rejects(h.api.send(providerJson, h.terms, { symbol: 'BTC-USDT' }, { ...prepared, authorization: { ...prepared.authorization, value: '999' } }, nonce), /changed payment parameters/);
  await assert.rejects(h.api.send(providerJson, h.terms, { symbol: 'BTC-USDT' }, prepared, `0x${'78'.repeat(32)}`), /changed payment parameters/);
  assert.equal(h.mock.state.paid, 0);
});

// ---------- agent turn route ----------
import { TOOLS, agentTurn } from '../demo/agent.mjs';
test('agent turn forwards a validated transcript to the model with the ALSP tools and returns its content', async () => {
  let seen;
  const client = { messages: { create: async params => { seen = params; return { content: [{ type: 'text', text: 'Creating the session.' }, { type: 'tool_use', id: 'tu_1', name: 'create_session', input: { maxTotal: '3000', maxPerCall: '1000', maxCalls: 3, ttlSeconds: 600, licenseNote: 'demo' } }], stop_reason: 'tool_use', model: 'fake', usage: { input_tokens: 10, output_tokens: 5 } }; } } };
  const [status, data] = await agentTurn({ messages: [{ role: 'user', content: 'Mission: buy a quote' }] }, { client });
  assert.equal(status, 200); assert.equal(data.stop_reason, 'tool_use'); assert.equal(data.content[1].name, 'create_session');
  assert.deepEqual(seen.tools.map(t => t.name), TOOLS.map(t => t.name)); assert.ok(seen.tools.every(t => t.input_schema.type === 'object'));
  assert.equal(seen.messages.length, 1); assert.ok(seen.system[0].text.includes('RECONCILIATION_REQUIRED'));
  for (const bad of [{}, { messages: [] }, { messages: [{ role: 'assistant', content: 'x' }] }, { messages: [{ role: 'user', content: 5 }] }]) {
    await assert.rejects(agentTurn(bad, { client }));
  }
  const [unconfigured] = await agentTurn({ messages: [{ role: 'user', content: 'x' }] }, {});
  assert.equal(unconfigured, process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 200 : 503);
});
test('agent route is reachable through the handler and reports its availability in meta', async () => {
  const [, meta] = await handle('GET', '/api/meta', '');
  assert.equal(typeof meta.agent.enabled, 'boolean'); assert.ok(meta.agent.model);
  const client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model: 'fake', usage: {} }) } };
  const [status, data] = await handle('POST', '/api/agent/turn', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), { agent: { client } });
  assert.equal(status, 200); assert.equal(data.stop_reason, 'end_turn');
});
test('verify route waits out transient settlement errors but not final ones', async () => {
  const h = await harness();
  const providerJson = JSON.parse(JSON.stringify(h.mock.profile));
  const { quote } = await h.api.probe(providerJson, h.terms, { symbol: 'BTC-USDT' });
  const c = await h.client.call(h.sessionId, 'one', { symbol: 'BTC-USDT' });
  assert.equal(c.state, 'VERIFIED');
  // Simulate an RPC that has not indexed the receipt yet, then catches up.
  let rpcHits = 0;
  const lagging = async (url, init) => { if (new URL(url).pathname === '/rpc' && JSON.parse(init.body).method === 'eth_getTransactionReceipt' && ++rpcHits < 3) return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: null }), { headers: { 'content-type': 'application/json' } }); return h.mock.fetchImpl(url, init); };
  const post = async (deps) => handle('POST', '/api/x402/verify', JSON.stringify({ provider: providerJson, terms: h.terms, call: { ...c, verified: null }, pins: [{ address: h.mock.signer }], rpcUrl: 'https://oracle.example/rpc' }), deps);
  const [status, data] = await post({ fetchImpl: lagging, settleAttempts: 5, settleDelayMs: 1 });
  assert.equal(status, 200); assert.equal(data.verified.ledger.verification, 'rpc-confirmed'); assert.equal(rpcHits, 3);
  rpcHits = 0;
  const [impatient] = await post({ fetchImpl: lagging, settleAttempts: 1, settleDelayMs: 1 });
  assert.equal(impatient, 400);
  const [rejected, why] = await handle('POST', '/api/x402/verify', JSON.stringify({ provider: providerJson, terms: h.terms, call: { ...c, verified: null }, pins: [{ address: h.mock.stranger }], rpcUrl: 'https://oracle.example/rpc' }), { fetchImpl: h.mock.fetchImpl, settleAttempts: 5, settleDelayMs: 1 });
  assert.equal(rejected, 400); assert.match(why.error, /Expected an object|Untrusted signing key|Pinned/, 'an unpinned signer without a certificate is final, not retried');
  void quote;
});

// ---------- disposable session wallet ----------
import { sessionWallet, transferCalldata } from '../public/session-wallet.js';
import { verifyTypedData } from 'viem';
import { AUTHORIZATION_TYPES } from '../dist/index.js';
test('session wallet signs valid EIP-3009 authorizations, sweeps and persists its key', async () => {
  const storage = memoryStorage();
  const w = sessionWallet(storage), again = sessionWallet(storage);
  assert.equal(w.address, again.address, 'key persists in storage');
  const quote = { accepted: { payTo: `0x${'bb'.repeat(20)}`, amount: '1000', maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } } };
  const terms = { payer: w.address, network: 'eip155:8453', asset: `0x${'aa'.repeat(20)}`, expiresAt: Date.now() + 600000 };
  const nonce = `0x${'77'.repeat(32)}`;
  const p = await w.prepare(quote, terms, nonce);
  const a = p.authorization;
  assert.equal(await verifyTypedData({ address: w.address, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: terms.asset }, types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', signature: p.signature,
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } }), true);
  await assert.rejects(w.prepare(quote, { ...terms, payer: `0x${'cc'.repeat(20)}` }, nonce), /not the session payer/);
  const sweep = await w.sweepAuthorization({ to: `0x${'dd'.repeat(20)}`, value: '2500', chainId: 8453, asset: terms.asset });
  assert.ok(sweep.calldata.startsWith('0xe3ee160e'), 'transferWithAuthorization(v,r,s) selector');
  assert.equal(await verifyTypedData({ address: w.address, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: terms.asset }, types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', signature: sweep.signature, message: sweep.message }), true);
  assert.ok(transferCalldata(w.address, '4000').startsWith('0xa9059cbb'), 'transfer selector');
  assert.match(w.exportPrivateKey(), /^0x[0-9a-f]{64}$/);
  w.forget(); assert.notEqual(sessionWallet(storage).address, w.address);
});
test('balance route reads balanceOf through the configured RPC', async () => {
  const h = await harness();
  const [status, data] = await handle('POST', '/api/x402/balance', JSON.stringify({ network: 'eip155:31337', asset: h.mock.profile.asset.address, address: h.wallet.address, rpcUrl: 'https://oracle.example/rpc' }), { fetchImpl: h.mock.fetchImpl });
  assert.equal(status, 200); assert.equal(data.balance, '4000');
  const [wrongChain] = await handle('POST', '/api/x402/balance', JSON.stringify({ network: 'eip155:8453', asset: h.mock.profile.asset.address, address: h.wallet.address, rpcUrl: 'https://oracle.example/rpc' }), { fetchImpl: h.mock.fetchImpl });
  assert.equal(wrongChain, 400);
});

// ---------- unsigned (generic x402) providers and discovery ----------
import { discoverProvider, TEMPLATES } from '../demo/discover.mjs';
test('generic provider without signed receipts verifies by settlement only, still fails closed on ledger', async () => {
  const h = await harness({ receiptMode: 'unsigned' });
  assert.equal(h.mock.profile.receipt.mode, 'unsigned');
  const c = await h.client.call(h.sessionId, 'one', { symbol: 'BTC-USDT' });
  assert.equal(c.state, 'VERIFIED'); assert.equal(c.verified.receipt.signer, 'none'); assert.match(c.verified.receipt.requestId, /^unsigned:0x/);
  assert.equal(c.verified.ledger.verification, 'rpc-confirmed'); assert.equal(c.wire.body.receipt, undefined);
  h.mock.setFault('rpc-down');
  const d = await h.client.call(h.sessionId, 'two', { symbol: 'ETH-USDT' });
  assert.equal(d.state, 'RECONCILIATION_REQUIRED', 'without a signed receipt, a failed ledger check leaves nothing to trust');
  h.mock.setFault('none');
  assert.equal((await h.client.reconcile(d.id)).state, 'VERIFIED');
});
test('discovery builds an unsigned profile from a live 402 and refuses unsafe targets', async () => {
  const mock = createMockProvider({ origin: 'https://oracle.example', price: '2500' });
  const found = await discoverProvider('https://oracle.example/api/v1/quote?symbol=BTC-USDT', mock.fetchImpl, { network: 'eip155:31337' });
  assert.equal(found.profile.payTo, mock.payTo); assert.equal(found.profile.receipt.mode, 'unsigned'); assert.equal(found.profile.endpointPath, '/api/v1/quote');
  assert.deepEqual(found.input, { symbol: 'BTC-USDT' }); assert.equal(found.quote.amount, '2500');
  await assert.rejects(discoverProvider('https://oracle.example/api/v1/quote', mock.fetchImpl, { network: 'eip155:8453' }), /No exact EIP-3009 option on eip155:8453/);
  for (const bad of ['http://oracle.example/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://a.internal/x']) await assert.rejects(discoverProvider(bad, mock.fetchImpl), /public HTTPS/);
  await assert.rejects(discoverProvider('https://oracle.example/nope', mock.fetchImpl), /Expected HTTP 402/);
  const [status, data] = await handle('POST', '/api/x402/discover', JSON.stringify({ url: 'https://oracle.example/api/v1/quote', network: 'eip155:31337' }), { fetchImpl: mock.fetchImpl });
  assert.equal(status, 200); assert.equal(data.profile.id, 'oracle-example-api-v1-quote');
  const [, meta] = await handle('GET', '/api/meta', '');
  assert.ok(meta.templates.length >= 5); assert.ok(TEMPLATES.every(t => t.url.startsWith('https://')));
});

// ---------- the "why a session" comparison ----------
import { naiveRun } from '../public/sim.js';
test('a plain x402 retry loop pays twice for a lost response and has no cap; the session does neither', async () => {
  const symbols = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'DOGE-USDT', 'AVAX-USDT'];
  const naive = await naiveRun({ inputs: symbols.map(symbol => ({ symbol })), price: '1000', loseResponseOnCall: 2 });
  assert.equal(naive.payments, 6); assert.equal(naive.doublePaid, 1); assert.equal(naive.spent, '6000'); assert.ok(naive.rows.every(r => r.got));
  const h = await harness({ price: '1000' });
  // Same product under a 5-call, 0.005 USDC session with the same lost response on the 2nd call.
  const terms = { ...h.terms, maxTotal: '5000', maxCalls: 5 };
  const sessionId = await h.journal.create(terms, JSON.parse(JSON.stringify(h.mock.profile)));
  let n = 0;
  const originalSend = h.mock.fetchImpl;
  for (const symbol of symbols) {
    n++; h.mock.setFault(n === 2 ? 'lost-response' : 'none');
    await h.client.call(sessionId, `quote-${symbol.toLowerCase()}`, { symbol });
  }
  h.mock.setFault('none');
  const lost = h.journal.calls(sessionId).find(c => c.state !== 'VERIFIED');
  assert.ok(lost, 'the lost response is parked, not retried');
  assert.equal((await h.client.reconcile(lost.id, h.mock.recover(lost.nonce))).state, 'VERIFIED');
  const report = await h.journal.export(sessionId);
  assert.equal(h.mock.state.paid, 5); assert.equal(report.summary.allocatedTotal, '5000'); assert.equal(report.summary.unresolved, 0);
  await assert.rejects(h.client.call(sessionId, 'quote-extra', { symbol: 'XRP-USDT' }), /policy|budget/i);
  assert.equal(h.mock.state.paid, 5, 'the cap refused a 6th payment before any signature');
  void originalSend;
});

// ---------- missions: one cap across several provider sessions ----------
import { verifyMissionChain } from '../public/alsp-browser.js';
test('a mission caps spend across provider sessions before signing and exports a verifiable combined archive', async () => {
  const a = createMockProvider({ origin: 'https://price.example', price: '1000' }), b = createMockProvider({ origin: 'https://news.example', price: '2000' });
  const signer = evmSigner(BUYER_KEY), wallet = { address: signer.address, prepare: signer.prepare, signMessage: signer.signManifest };
  const journal = new BrowserJournal(memoryStorage(), sharedLocks());
  const missionId = await journal.createMission({ label: 'brief', maxTotal: '4000', payer: signer.address, network: a.profile.network });
  const mk = async (mock, maxTotal, maxCalls) => {
    const deps = { fetchImpl: mock.fetchImpl };
    const api2 = { post: async (path, body) => { const [status, data] = await handle('POST', path, JSON.stringify(body), deps); if (status !== 200) throw new Error(data.error); return data; } };
    api2.probe = (p, t, i) => api2.post('/api/x402/probe', { provider: p, terms: t, input: i }); api2.send = (p, t, i, prepared, nonce) => api2.post('/api/x402/send', { provider: p, terms: t, input: i, prepared, nonce }); api2.verify = (p, t, call, pins, rpcUrl) => api2.post('/api/x402/verify', { provider: p, terms: t, call, pins, rpcUrl });
    const terms = { profile: PROFILE, payer: signer.address, provider: mock.profile.payTo, network: mock.profile.network, asset: mock.profile.asset.address, endpoint: `${mock.profile.origin}${mock.profile.endpointPath}`, maxTotal, maxPerCall: '2000', maxCalls, expiresAt: Date.now() + 600000, license: { uri: 'urn:test', sha256: await sha256Text('t'), acceptance: 'buyer-only' } };
    const sessionId = await journal.create(terms, JSON.parse(JSON.stringify(mock.profile)), Date.now(), { missionId });
    return { sessionId, client: new BrowserSessionClient(journal, { api: api2, wallet, pins: [{ address: mock.signer }], rpcUrl: `${mock.profile.origin}/rpc` }) };
  };
  await assert.rejects(journal.create({ profile: PROFILE, payer: signer.address, provider: a.profile.payTo, network: a.profile.network, asset: a.profile.asset.address, endpoint: `${a.profile.origin}/api/v1/quote`, maxTotal: '9000', maxPerCall: '1000', maxCalls: 9, expiresAt: Date.now() + 600000, license: { uri: 'u', sha256: await sha256Text('x'), acceptance: 'buyer-only' } }, JSON.parse(JSON.stringify(a.profile)), Date.now(), { missionId }), /exceeds the mission cap/);
  const price = await mk(a, '4000', 4), news = await mk(b, '4000', 2);
  assert.equal((await price.client.call(price.sessionId, 'p1', { symbol: 'BTC' })).state, 'VERIFIED');
  assert.equal((await news.client.call(news.sessionId, 'n1', {})).state, 'VERIFIED');
  assert.equal((await price.client.call(price.sessionId, 'p2', { symbol: 'ETH' })).state, 'VERIFIED');
  // 1000 + 2000 + 1000 = 4000 allocated: the news session alone would still allow 2000, the mission does not.
  await assert.rejects(news.client.call(news.sessionId, 'n2', {}), /Mission budget exceeded/);
  assert.equal(b.state.paid, 1, 'refused before any signature');
  await journal.endMission(missionId);
  const archive = await journal.exportMission(missionId);
  assert.equal(archive.summary.state, 'CLOSED'); assert.equal(archive.summary.allocatedTotal, '4000'); assert.equal(archive.sessions.length, 2); assert.deepEqual(archive.summary.providers, ['demo-oracle', 'demo-oracle']);
  assert.ok(await verifyMissionChain(archive));
  assert.ok(archive.sessions.every(s => verifyChain(s)));
  const tampered = structuredClone(archive); tampered.sessions[0].events[0].event.amount = '1'; assert.equal(await verifyMissionChain(tampered), false);
  const tampered2 = structuredClone(archive); tampered2.events[1].event.maxTotal = '1'; assert.equal(await verifyMissionChain(tampered2), false);
});
// ---------- central run log (file backend) ----------
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('run logs round-trip through the file backend and refuse bad entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alsp-logs-')); process.env.ALSP_LOG_DIR = dir;
  try {
    const [status, put] = await handle('POST', '/api/logs', JSON.stringify({ kind: 'measurement', title: 'Sandbox 2 × 3', summary: { calls: 6 }, payload: { rows: [] } }));
    assert.equal(status, 200); assert.match(put.id, /^\d{13}-measurement-sandbox-2-3-[0-9a-f]{8}$/);
    const [, listing] = await handle('GET', '/api/logs', '', { query: 'limit=10' });
    assert.equal(listing.enabled, true); assert.equal(listing.backend, 'file'); assert.equal(listing.entries[0].id, put.id); assert.equal(listing.entries[0].kind, 'measurement');
    const [, entry] = await handle('GET', `/api/logs/${put.id}`, '');
    assert.equal(entry.summary.calls, 6); assert.equal(entry.title, 'Sandbox 2 × 3');
    assert.equal((await handle('POST', '/api/logs', JSON.stringify({ kind: 'nope', title: 'x' })))[0], 400);
    assert.equal((await handle('GET', '/api/logs/../etc/passwd', ''))[0], 400);
    const [, meta] = await handle('GET', '/api/meta', ''); assert.equal(meta.logs.enabled, true); assert.ok(meta.products.length >= 2);
  } finally { delete process.env.ALSP_LOG_DIR; rmSync(dir, { recursive: true, force: true }); }
});
