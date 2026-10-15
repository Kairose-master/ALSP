import test from 'node:test';\nimport { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { invoiceIdForCall, validateXrplBinding, verifyXrplSettlement } from '../dist/integrations/xrpl-evidence.js';

const binding = {
  sessionId: 'session-1', callId: 'call-1', network: 'xrpl:1',
  invoiceId: invoiceIdForCall('session-1', 'call-1'),
  destination: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  currency: 'XRP', amount: '1.5'
};
const evidence = {
  validated: true, transactionType: 'Payment', result: 'tesSUCCESS',
  hash: 'A'.repeat(64), ledgerIndex: 100,
  invoiceId: createHash('sha256').update(binding.invoiceId).digest('hex').toUpperCase(), destination: binding.destination,
  deliveredAmount: { currency: 'XRP', value: '1.5000' }
};

test('invoice is deterministic and call-bound', () => {
  assert.equal(invoiceIdForCall('session-1', 'call-1'), binding.invoiceId);
  assert.notEqual(invoiceIdForCall('session-1', 'call-2'), binding.invoiceId);
  assert.throws(() => validateXrplBinding({ ...binding, invoiceId: 'B'.repeat(64) }));
});
test('validated exact payment passes only with matching fields', () => {
  assert.equal(verifyXrplSettlement(binding, evidence), true);
  for (const patch of [
    { validated: false }, { result: 'tecPATH_DRY' }, { invoiceId: 'B'.repeat(64) },
    { destination: 'rWrong' }, { deliveredAmount: { currency: 'XRP', value: '1.4' } }
  ]) assert.equal(verifyXrplSettlement(binding, { ...evidence, ...patch }), false);
});
test('issued currency requires issuer and exact match', () => {
  assert.throws(() => validateXrplBinding({ ...binding, currency: 'USD' }));
  assert.equal(verifyXrplSettlement({ ...binding, currency: 'USD', issuer: binding.destination },
    { ...evidence, deliveredAmount: { currency: 'USD', issuer: 'rOther', value: '1.5' } }), false);
});
