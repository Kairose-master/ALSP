import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { PROFILE, digest, canonical, agreementPayload, verifyProviderAgreement } from '../dist/index.js';

test('provider bilateral agreement signs and binds session terms and exact pricing policy', async () => {
  const provider = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const terms = { profile: PROFILE, payer: '0x1111111111111111111111111111111111111111', provider: provider.address,
    network: 'eip155:8453', asset: '0x3333333333333333333333333333333333333333', endpoint: 'https://provider.example/api',
    maxTotal: '200', maxPerCall: '20', maxCalls: 10, expiresAt: Date.now() + 60_000,
    license: { uri: 'urn:fixture:terms', sha256: digest('terms'), acceptance: 'buyer-only' } };
  const sessionId = 'session-fixture';
  const payload = agreementPayload(sessionId, terms, { mode: 'exact-per-call', network: terms.network, asset: terms.asset, payTo: terms.provider, maxPerCall: terms.maxPerCall, maxTotal: terms.maxTotal });
  const agreement = { ...payload, signature: await provider.signMessage({ message: canonical(payload) }) };
  assert.equal(await verifyProviderAgreement(agreement, terms, sessionId), true);
  assert.equal(await verifyProviderAgreement(agreement, terms, 'other-session'), false);
  assert.equal(await verifyProviderAgreement({ ...agreement, scope: 'https://other.example/' }, terms, sessionId), false);
});
