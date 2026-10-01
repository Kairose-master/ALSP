import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, SessionClient, GENERIC_PROFILE, digest, createSessionAdapters, requireImplementedCapability, X402OfferReceiptEnvelopeValidator, agreementPayload, canonical, normalizeTerms, transitionCall, transitionSession, verifyChain } from '../dist/index.js';
import { privateKeyToAccount } from 'viem/accounts';

test('upto and batch payment capabilities fail closed', () => {
  const adapter = { capabilities: new Set(['exact-per-call', 'upto', 'batch']) };
  assert.throws(() => requireImplementedCapability(adapter, 'upto'), /not enabled/);
  assert.throws(() => requireImplementedCapability(adapter, 'batch'), /not enabled/);
  assert.throws(() => requireImplementedCapability({ capabilities: new Set(['exact-per-call']) }, 'batch'), /Unsupported payment capability/);
});

test('standard x402 offer/receipt evidence is bound to the exact call payment', () => {
  const terms = { payer: '0x1111111111111111111111111111111111111111', provider: '0x2222222222222222222222222222222222222222', network: 'eip155:8453', asset: '0x3333333333333333333333333333333333333333' };
  const offer = { x402Version: 2, resource: { url: 'https://provider.example/api' }, accepted: { scheme: 'exact', amount: '17' } };
  const call = { amount: '17', nonce: `0x${'a'.repeat(64)}`, prepared: { quote: offer }, wire: { status: 200, body: { x402Version: 2, offer, receipt: {
    offer, success: true, transaction: `0x${'b'.repeat(64)}`, timestamp: new Date().toISOString(), payTo: terms.provider,
    payer: terms.payer, asset: terms.asset, network: terms.network, amount: '17', nonce: `0x${'a'.repeat(64)}`,
  } } } };
  assert.equal(new X402OfferReceiptEnvelopeValidator().verify(call, terms).requestId, `0x${'b'.repeat(64)}`);
  assert.throws(() => new X402OfferReceiptEnvelopeValidator().verify({ ...call, amount: '18' }, terms), /binding mismatch/);
});

test('normative state machine rejects illegal and terminal transitions', () => {
  assert.throws(() => transitionSession('PROPOSED', 'ACTIVE'), /Forbidden session transition/);
  assert.throws(() => transitionSession('CLOSED', 'ACTIVE'), /Forbidden session transition/);
  assert.throws(() => transitionCall('RESERVED', 'SUBMITTED'), /Forbidden call transition/);
  assert.throws(() => transitionCall('VERIFIED', 'RECONCILIATION_REQUIRED'), /Forbidden call transition/);
});

test('generic bilateral independent provider completes agreement, multiple calls, reconciliation, and CLOSED', async () => {
  const now = Date.now(), payer = '0x1111111111111111111111111111111111111111';
  const signer = privateKeyToAccount(`0x${'22'.repeat(32)}`), provider = signer.address, asset = '0x3333333333333333333333333333333333333333';
  const terms = { profile: GENERIC_PROFILE, payer, providerProfile: { id: 'synthetic-provider', address: provider, endpoint: 'https://provider.example/api/infer' },
    paymentProfile: { id: 'synthetic-chain-token', scheme: 'exact-per-call', network: 'eip155:999999', asset, payTo: provider },
    maxTotal: '40', maxPerCall: '20', maxCalls: 3, expiresAt: now + 60_000,
    license: { uri: 'urn:fixture:terms', sha256: digest('fixture terms'), acceptance: 'buyer-only' } };
  const protocolTerms = normalizeTerms(terms);
  const input = { url: 'https://target.example/resource' };
  const offer = { x402Version: 2, resource: { url: 'https://provider.example/api/infer?url=https%3A%2F%2Ftarget.example%2Fresource' }, accepts: [
    { scheme: 'exact', network: protocolTerms.network, asset, payTo: provider, amount: '17', maxTimeoutSeconds: 60, extra: { reference: 'synthetic' } },
  ] };
  const quote = { x402Version: 2, resource: offer.resource, accepted: offer.accepts[0] };
  let sends = 0;
  const adapters = createSessionAdapters({
    probe: async () => offer,
    send: async () => { sends++; if (sends === 1) throw new Error('synthetic uncertain transport'); return { status: 200, body: { result: 'synthetic' }, settlement: { transaction: `0x${'a'.repeat(64)}` } }; },
  }, {
    capabilities: new Set(['exact-per-call']),
    prepare: async (q, t, nonce) => ({ quote: q, authorization: { from: t.payer, to: t.provider, value: q.accepted.amount, nonce, validAfter: String(Math.floor(now / 1000) - 1), validBefore: String(Math.floor(now / 1000) + 30) }, signature: `0x${'a'.repeat(130)}` }),
  }, {
    verify: async call => ({ receipt: { requestId: call.id, signer: provider, responseHash: digest(call.wire.body), signedAt: new Date(now).toISOString() },
      ledger: { transaction: `0x${'a'.repeat(64)}`, blockHash: `0x${'b'.repeat(64)}`, blockNumber: '1', confirmations: 1, verification: 'rpc-confirmed' }, semanticCorrectness: 'not-verified' }),
  });
  const journal = new Journal(':memory:');
  try {
    const id = journal.createBilateral(terms, now);
    assert.throws(() => journal.create(protocolTerms, now), /require createBilateral/);
    const payload = agreementPayload(id, protocolTerms, { mode: 'exact-per-call', network: protocolTerms.network, asset: protocolTerms.asset, payTo: protocolTerms.provider, maxPerCall: protocolTerms.maxPerCall, maxTotal: protocolTerms.maxTotal });
    await assert.rejects(() => new SessionClient(journal, adapters, () => now).call(id, 'premature', input), /Session not active/);
    await journal.agree(id, { ...payload, signature: await signer.signMessage({ message: canonical(payload) }) });
    assert.equal(journal.export(id).events.some(e => e.event.kind === 'bilateral_agreement'), true);
    journal.activate(id);
    const client = new SessionClient(journal, adapters, () => now);
    const uncertain = await client.call(id, 'independent-1', input);
    assert.equal(uncertain.state, 'RECONCILIATION_REQUIRED');
    const call = await client.reconcile(uncertain.id, { status: 200, body: { result: 'synthetic recovered' }, settlement: {} });
    assert.equal(call.state, 'VERIFIED');
    assert.equal(call.amount, '17');
    journal.resume(id, now);
    const second = await client.call(id, 'independent-2', input);
    assert.equal(second.state, 'VERIFIED');
    journal.end(id);
    const archive = journal.export(id);
    assert.equal(archive.summary.state, 'CLOSED');
    assert.equal(verifyChain(archive), true);
    assert.equal(verifyChain({ ...archive, agreement: { ...archive.agreement, scope: 'https://tampered.example' } }), false);
  } finally { journal.close(); }
});
