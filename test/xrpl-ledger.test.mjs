import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { invoiceIdForCall } from '../dist/integrations/xrpl-evidence.js';
import { fetchVerifiedXrplPayment } from '../dist/integrations/xrpl-ledger.js';

const invoiceId = invoiceIdForCall('s1', 'c1');
const binding = {
  sessionId: 's1', callId: 'c1', network: 'xrpl:1', invoiceId,
  destination: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', currency: 'XRP', amount: '1.5'
};
const hash = 'A'.repeat(64);
const transaction = {
  status: 'success', validated: true, hash, ledger_index: 100,
  tx_json: { TransactionType: 'Payment', InvoiceID: createHash('sha256').update(invoiceId).digest('hex').toUpperCase(), Destination: binding.destination },
  meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1500000' }
};
const mock = (result) => async (url, opts) => {
  assert.equal(url, 'https://s.altnet.rippletest.net:51234/');
  assert.equal(JSON.parse(opts.body).method, 'tx');
  return new Response(JSON.stringify({ result }), { status: 200 });
};
test('validated XRPL testnet payment matches exact invoice and delivered drops', async () => {
  const proof = await fetchVerifiedXrplPayment(hash, binding, mock(transaction));
  assert.equal(proof.deliveredAmount.value, '1.500000');
});
test('unvalidated and mismatched transactions fail closed', async () => {
  for (const patch of [
    { validated: false },
    { tx_json: { ...transaction.tx_json, InvoiceID: 'B'.repeat(64) } },
    { meta: { ...transaction.meta, delivered_amount: '1499999' } },
    { hash: 'B'.repeat(64) }
  ]) await assert.rejects(fetchVerifiedXrplPayment(hash, binding, mock({ ...transaction, ...patch })));
});
test('mainnet and invalid hashes never query RPC', async () => {
  await assert.rejects(fetchVerifiedXrplPayment(hash, { ...binding, network: 'xrpl:0' }, mock(transaction)));
  await assert.rejects(fetchVerifiedXrplPayment('bad', binding, mock(transaction)));
});
