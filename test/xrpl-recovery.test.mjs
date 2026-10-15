import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteXrplSettlementJournal } from '../dist/integrations/xrpl-sqlite-journal.js';
import { XrplSettlementCoordinator } from '../dist/integrations/xrpl-settlement.js';

test('recovery never invokes facilitator settle and leaves missing binding unresolved', async () => {
  const journal = new SqliteXrplSettlementJournal(':memory:');
  try {
    await journal.beginSettlement('call-1', 'A'.repeat(64));
    await journal.beginSettlement('call-2', 'B'.repeat(64));
    const pending = journal.pendingAttempts();
    assert.equal(pending.length, 2);
    const facilitator = { network: 'xrpl:1', async settle() { throw new Error('must not resettle'); } };
    const coordinator = new XrplSettlementCoordinator(journal, facilitator, async () => { throw new Error('must not query without binding'); });
    const result = await coordinator.recoverPending(pending, async () => null);
    assert.deepEqual(result, { verified: [], unresolved: ['call-1', 'call-2'] });
    assert.equal(journal.attempt('call-1').state, 'RECONCILIATION_REQUIRED');
    assert.equal(journal.attempt('call-2').state, 'RECONCILIATION_REQUIRED');
    assert.equal(journal.pendingAttempts().length, 2);
  } finally { journal.close(); }
});
