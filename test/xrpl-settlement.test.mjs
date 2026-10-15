import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { invoiceIdForCall } from '../dist/integrations/xrpl-evidence.js';
import { XrplSettlementCoordinator } from '../dist/integrations/xrpl-settlement.js';

const invoiceId = invoiceIdForCall('s1', 'c1');
const destination = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const hash = 'A'.repeat(64);
const binding = { sessionId: 's1', callId: 'c1', network: 'xrpl:1', invoiceId, destination, currency: 'XRP', amount: '1' };
const requirement = { scheme: 'exact', network: 'xrpl:1', asset: 'XRP', payTo: destination, amount: '1000000', maxTimeoutSeconds: 60, extra: { invoiceId, sourceTag: 123 } };
const payload = { x402Version: 2, accepted: requirement, payload: { signedTxBlob: 'AABB', invoiceId: requirement.extra.invoiceId } };
const rpc = async () => new Response(JSON.stringify({ result: {
  status: 'success', validated: true, hash, ledger_index: 10,
  tx_json: { TransactionType: 'Payment', Destination: destination, InvoiceID: createHash('sha256').update(invoiceId).digest('hex').toUpperCase() },
  meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1000000' }
} }));
function makeJournal() {
  const events = [];
  const journal = {
    async beginSettlement(id, tx) { events.push('begin'); assert.equal(id, 'c1'); assert.equal(tx, hash); },
    async recordFacilitatorResponse() { events.push('response'); },
    async markVerified() { events.push('verified'); },
    async markUnresolved() { events.push('unresolved'); }
  };
  return { journal, events };
}
test('settlement requires journal intent and ledger proof before verification', async () => {
  const { journal, events } = makeJournal();
  const facilitator = { network: 'xrpl:1', async settle() { assert.deepEqual(events, ['begin']); events.push('settle'); return { success: true, transaction: hash }; } };
  const coordinator = new XrplSettlementCoordinator(journal, facilitator, rpc);
  await coordinator.settleOnce({ callId: 'c1', transactionHash: hash, binding, requirement, payload });
  assert.deepEqual(events, ['begin', 'settle', 'response', 'verified']);
});
test('ambiguous settlement never marks verified and reconciliation never resettles', async () => {
  const { journal, events } = makeJournal();
  const facilitator = { network: 'xrpl:1', async settle() { throw new Error('timeout'); } };
  const coordinator = new XrplSettlementCoordinator(journal, facilitator, rpc);
  await assert.rejects(coordinator.settleOnce({ callId: 'c1', transactionHash: hash, binding, requirement, payload }));
  assert.deepEqual(events, ['begin', 'unresolved']);
  await coordinator.reconcile('c1', hash, binding);
  assert.deepEqual(events, ['begin', 'unresolved', 'verified']);
});
test('journal intent failure prevents settlement', async () => {
  const { journal, events } = makeJournal();
  journal.beginSettlement = async () => { throw new Error('duplicate'); };
  const facilitator = { network: 'xrpl:1', async settle() { throw new Error('must not settle'); } };
  await assert.rejects(new XrplSettlementCoordinator(journal, facilitator, rpc).settleOnce({ callId: 'c1', transactionHash: hash, binding, requirement, payload }));
  assert.deepEqual(events, []);
});
