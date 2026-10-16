import test from 'node:test';
import assert from 'node:assert/strict';
import { T54Facilitator, xrplInvoiceField } from '../dist/integrations/t54-facilitator.js';

const requirement = {
  scheme: 'exact', network: 'xrpl:1', asset: 'XRP',
  payTo: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  amount: '1000000', maxTimeoutSeconds: 600,
  extra: { invoiceId: 'alsp-session-call-1', sourceTag: 804681468 }
};
const payload = { x402Version: 2, accepted: requirement, payload: { signedTxBlob: 'AABB', invoiceId: requirement.extra.invoiceId } };

test('InvoiceID field hashes UTF-8 invoice identifier', () => {
  assert.match(xrplInvoiceField(requirement.extra.invoiceId), /^[A-F0-9]{64}$/);
});
test('verify sends the x402 v2 envelope to the testnet facilitator', async () => {
  let called = false;
  const client = new T54Facilitator('xrpl:1', async (url, options) => {
    called = true;
    assert.equal(url, 'https://xrpl-facilitator-testnet.t54.ai/verify');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { paymentPayload: payload, paymentRequirements: requirement });
    return new Response(JSON.stringify({ isValid: true }), { status: 200 });
  });
  assert.deepEqual(await client.verify(payload, requirement), { isValid: true });
  assert.equal(called, true);
});
test('settle requires opt-in and rejects mainnet', async () => {
  const client = new T54Facilitator('xrpl:1', async () => new Response(JSON.stringify({ success: true, network: 'xrpl:1', transaction: 'A'.repeat(64) })));
  await assert.rejects(client.settle(payload, requirement, false));
  assert.equal((await client.settle(payload, requirement, true)).success, true);
  const mainnet = new T54Facilitator('xrpl:0', async () => { throw new Error('must not fetch'); });
  await assert.rejects(mainnet.settle(payload, { ...requirement, network: 'xrpl:0' }, true));
});
test('mismatched requirements and XRP decimals are rejected before network', async () => {
  const client = new T54Facilitator('xrpl:1', async () => { throw new Error('must not fetch'); });
  await assert.rejects(client.verify(payload, { ...requirement, amount: '2000000' }));
  const wrong = { ...requirement, amount: '0.1' };
  await assert.rejects(client.verify({ ...payload, accepted: wrong }, wrong));
});
