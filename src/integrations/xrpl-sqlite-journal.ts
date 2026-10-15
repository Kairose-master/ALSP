/**
 * Durable, testnet-only XRPL settlement attempt journal.
 * Stores transaction hash and redacted facilitator response, never signed blobs.
 * This is a separate reconciliation store; it does not mutate ALSP core Journal.
 */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { XrplLedgerEvidence } from './xrpl-evidence.js';
import type { XrplSettlementJournal } from './xrpl-settlement.js';

const HEX64 = /^[0-9A-Fa-f]{64}$/;
export class SqliteXrplSettlementJournal implements XrplSettlementJournal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Journal path must be a regular file');
        chmodSync(path, 0o600);
      } else closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS xrpl_attempts (
        call_id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('SUBMITTED','RECONCILIATION_REQUIRED','VERIFIED')),
        response TEXT, evidence TEXT
      );`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async beginSettlement(callId: string, transactionHash: string): Promise<void> {
    if (!callId || callId.length > 128 || !HEX64.test(transactionHash)) throw new Error('Invalid settlement identity');
    this.transaction(() => {
      if (this.db.prepare('SELECT call_id FROM xrpl_attempts WHERE call_id=?').get(callId)) throw new Error('Settlement already attempted: reconcile, never resend');
      this.db.prepare('INSERT INTO xrpl_attempts(call_id,transaction_hash,state) VALUES(?,?,?)').run(callId, transactionHash.toUpperCase(), 'SUBMITTED');
    });
  }
  async recordFacilitatorResponse(callId: string, response: unknown): Promise<void> {
    // Explicit allowlist prevents accidental persistence of secrets or signed transactions.
    const r = response && typeof response === 'object' ? response as Record<string, unknown> : {};
    const safe = { success: r.success === true, transaction: typeof r.transaction === 'string' ? r.transaction : null, network: typeof r.network === 'string' ? r.network : null };
    this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM xrpl_attempts WHERE call_id=?').get(callId);
      if (!row || row.state !== 'SUBMITTED') throw new Error('No active submission');
      this.db.prepare('UPDATE xrpl_attempts SET response=? WHERE call_id=?').run(JSON.stringify(safe), callId);
    });
  }
  async markVerified(callId: string, evidence: XrplLedgerEvidence): Promise<void> {
    if (!evidence.validated || evidence.result !== 'tesSUCCESS' || !HEX64.test(evidence.hash)) throw new Error('Invalid ledger proof');
    this.transaction(() => {
      const row = this.db.prepare('SELECT state,transaction_hash FROM xrpl_attempts WHERE call_id=?').get(callId);
      if (!row || String(row.transaction_hash) !== evidence.hash.toUpperCase()) throw new Error('Unknown transaction');
      if (row.state === 'VERIFIED') return;
      this.db.prepare('UPDATE xrpl_attempts SET state=?,evidence=? WHERE call_id=?')
        .run('VERIFIED', JSON.stringify(evidence), callId);
    });
  }
  async markUnresolved(callId: string): Promise<void> {
    this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM xrpl_attempts WHERE call_id=?').get(callId);
      if (!row || row.state === 'VERIFIED') return;
      this.db.prepare('UPDATE xrpl_attempts SET state=? WHERE call_id=?').run('RECONCILIATION_REQUIRED', callId);
    });
  }
  attempt(callId: string): { transactionHash: string; state: string; response: unknown; evidence: XrplLedgerEvidence | null } | null {
    const row = this.db.prepare('SELECT * FROM xrpl_attempts WHERE call_id=?').get(callId);
    if (!row) return null;
    return {
      transactionHash: String(row.transaction_hash),
      state: String(row.state),
      response: row.response ? JSON.parse(String(row.response)) as unknown : null,
      evidence: row.evidence ? JSON.parse(String(row.evidence)) as XrplLedgerEvidence : null,
    };
  }
}
