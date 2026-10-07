import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evmSigner, verifyBuyerSeal, verifyChain } from '../dist/index.js';
import { handle } from '../demo/handler.mjs';
import { BrowserJournal, BrowserSessionClient, PROFILE, canonical, digest, sha256Text, verifyChain as browserVerifyChain } from '../public/alsp-browser.js';
import { createMockProvider } from './mock-provider.mjs';

// Public throwaway buyer key. MUST NEVER be funded.
const BUYER_KEY = `0x${'11'.repeat(32)}`;
const memoryStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

/** Drives the browser client exactly like app.js does, against the stateless handler and an in-process provider. */
async function harness({ price = '1000', origin = 'https://oracle.example' } = {}) {
  const mock = createMockProvider({ price, origin });
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
  const journal = new BrowserJournal(memoryStorage());
  const { profile } = mock, providerJson = JSON.parse(JSON.stringify(profile));
  const terms = { profile: PROFILE, payer: signer.address, provider: profile.payTo, network: profile.network, asset: profile.asset.address, endpoint: `${profile.origin}${profile.endpointPath}`, maxTotal: '3000', maxPerCall: '1000', maxCalls: 3, expiresAt: Date.now() + 600000, license: { uri: 'urn:alsp:test', sha256: await sha256Text('reviewed fixture terms'), acceptance: 'buyer-only' } };
  const sessionId = await journal.create(terms, providerJson);
  const steps = [];
  const client = new BrowserSessionClient(journal, { api, wallet, pins: [{ address: mock.signer }], rpcUrl: `${origin}/rpc`, onStep: s => steps.push(s) });
  return { mock, api, journal, wallet, terms, sessionId, client, steps };
}

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
  const client = { beta: { messages: { create: async params => { seen = params; return { content: [{ type: 'text', text: 'Creating the session.' }, { type: 'tool_use', id: 'tu_1', name: 'create_session', input: { maxTotal: '3000', maxPerCall: '1000', maxCalls: 3, ttlSeconds: 600, licenseNote: 'demo' } }], stop_reason: 'tool_use', model: 'fake', usage: { input_tokens: 10, output_tokens: 5 } }; } } } };
  const [status, data] = await agentTurn({ messages: [{ role: 'user', content: 'Mission: buy a quote' }] }, { client });
  assert.equal(status, 200); assert.equal(data.stop_reason, 'tool_use'); assert.equal(data.content[1].name, 'create_session');
  assert.deepEqual(seen.tools.map(t => t.name), TOOLS.map(t => t.name)); assert.ok(seen.tools.every(t => t.strict === true));
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
  const client = { beta: { messages: { create: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model: 'fake', usage: {} }) } } };
  const [status, data] = await handle('POST', '/api/agent/turn', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), { agent: { client } });
  assert.equal(status, 200); assert.equal(data.stop_reason, 'end_turn');
});
