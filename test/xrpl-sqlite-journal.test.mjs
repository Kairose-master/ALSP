import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteXrplSettlementJournal } from '../dist/integrations/xrpl-sqlite-journal.js';

const hash = 'A'.repeat(64);
test('durable journal survives restart and prevents duplicate settlement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alsp-xrpl-'));
  const path = join(dir, 'journal.sqlite');
  try {
    let journal = new SqliteXrplSettlementJournal(path);
    await journal.beginSettlement('call1', hash);
    await journal.markUnresolved('call1');
    journal.close();
    journal = new SqliteXrplSettlementJournal(path);
    assert.equal(journal.attempt('call1').state, 'RECONCILIATION_REQUIRED');
    await assert.rejects(journal.beginSettlement('call1', hash));
    await assert.rejects(journal.beginSettlement('call2', hash));
    journal.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('journal stores redacted response and only matching ledger proof', async () => {
  const journal = new SqliteXrplSettlementJournal(':memory:');
  try {
    await journal.beginSettlement('call1', hash);
    await journal.recordFacilitatorResponse('call1', { success: true, transaction: hash, signedTxBlob: 'secret' });
    assert.equal(JSON.stringify(journal.attempt('call1').response).includes('secret'), false);
    const evidence = { validated: true, result: 'tesSUCCESS', hash, transactionType: 'Payment', ledgerIndex: 10, invoiceId: 'B'.repeat(64), destination: 'rTest', deliveredAmount: { currency: 'XRP', value: '1' } };
    await assert.rejects(journal.markVerified('call1', { ...evidence, hash: 'C'.repeat(64) }));
    await journal.markVerified('call1', evidence);
    assert.equal(journal.attempt('call1').state, 'VERIFIED');
    await journal.markUnresolved('call1');
    assert.equal(journal.attempt('call1').state, 'VERIFIED');
  } finally { journal.close(); }
});
