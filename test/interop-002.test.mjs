import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, SessionClient, PROFILE, digest, createSessionAdapters, requireImplementedCapability, X402OfferReceiptAdapter } from '../dist/index.js';

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
  assert.equal(new X402OfferReceiptAdapter().verify(call, terms).requestId, `0x${'b'.repeat(64)}`);
  assert.throws(() => new X402OfferReceiptAdapter().verify({ ...call, amount: '18' }, terms), /binding mismatch/);
});

test('generic independent provider exact-per-call session works without provider-specific logic', async () => {
  const now = Date.now(), payer = '0x1111111111111111111111111111111111111111';
  const provider = '0x2222222222222222222222222222222222222222', asset = '0x3333333333333333333333333333333333333333';
  const terms = { profile: PROFILE, payer, provider, network: 'eip155:8453', asset, endpoint: 'https://provider.example/api/infer',
    maxTotal: '20', maxPerCall: '20', maxCalls: 1, expiresAt: now + 60_000,
    license: { uri: 'urn:fixture:terms', sha256: digest('fixture terms'), acceptance: 'buyer-only' } };
  const input = { url: 'https://target.example/resource' };
  const offer = { x402Version: 2, resource: { url: 'https://provider.example/api/infer?url=https%3A%2F%2Ftarget.example%2Fresource' }, accepts: [
    { scheme: 'exact', network: terms.network, asset, payTo: provider, amount: '17', maxTimeoutSeconds: 60, extra: { reference: 'synthetic' } },
  ] };
  const quote = { x402Version: 2, resource: offer.resource, accepted: offer.accepts[0] };
  const adapters = createSessionAdapters({
    probe: async () => offer,
    send: async () => ({ status: 200, body: { result: 'synthetic' }, settlement: { transaction: `0x${'a'.repeat(64)}` } }),
  }, {
    capabilities: new Set(['exact-per-call']),
    prepare: async (q, t, nonce) => ({ quote: q, authorization: { from: t.payer, to: t.provider, value: q.accepted.amount, nonce, validAfter: String(Math.floor(now / 1000) - 1), validBefore: String(Math.floor(now / 1000) + 30) }, signature: `0x${'a'.repeat(130)}` }),
  }, {
    verify: async call => ({ receipt: { requestId: call.id, signer: provider, responseHash: digest(call.wire.body), signedAt: new Date(now).toISOString() },
      ledger: { transaction: `0x${'a'.repeat(64)}`, blockHash: `0x${'b'.repeat(64)}`, blockNumber: '1', confirmations: 1, verification: 'rpc-confirmed' }, semanticCorrectness: 'not-verified' }),
  });
  const journal = new Journal(':memory:');
  try {
    const id = journal.create(terms, now), client = new SessionClient(journal, adapters, () => now);
    const call = await client.call(id, 'independent-1', input);
    assert.equal(call.state, 'VERIFIED');
    assert.equal(call.amount, '17');
    journal.end(id);
    assert.equal(journal.export(id).summary.state, 'CLOSED');
  } finally { journal.close(); }
});
