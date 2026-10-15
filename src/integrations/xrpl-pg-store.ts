/**
 * Shared transactional XRPL invoice + settlement store (PostgreSQL).
 * One row per invoice; the row is the single source of truth for challenge, reservation and proof.
 * Reservation is one atomic conditional UPDATE, and transaction_hash is UNIQUE, so concurrent
 * serverless instances cannot both settle one invoice or reuse one payment. Signed blobs are never stored.
 */
import type { XrplLedgerEvidence } from './xrpl-evidence.js';
import type { XrplSettlementJournal } from './xrpl-settlement.js';
import type { XrplRequirement } from './t54-facilitator.js';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export type InvoiceState = 'OPEN' | 'SETTLING' | 'RECONCILIATION_REQUIRED' | 'VERIFIED';
export interface InvoiceRecord {
  invoiceId: string; sessionId: string; callId: string; requirement: XrplRequirement;
  expiresAt: Date; state: InvoiceState; transactionHash: string | null;
  response: unknown; evidence: XrplLedgerEvidence | null;
}
const HEX64 = /^[0-9A-Fa-f]{64}$/;

export const XRPL_SCHEMA = `
CREATE TABLE IF NOT EXISTS xrpl_invoices (
  invoice_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL UNIQUE,
  requirement JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','SETTLING','RECONCILIATION_REQUIRED','VERIFIED')),
  transaction_hash TEXT UNIQUE CHECK (transaction_hash IS NULL OR transaction_hash ~ '^[0-9A-F]{64}$'),
  response JSONB,
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'OPEN') = (transaction_hash IS NULL))
);
CREATE INDEX IF NOT EXISTS xrpl_invoices_pending ON xrpl_invoices (state) WHERE state IN ('SETTLING','RECONCILIATION_REQUIRED');
`;

function toRecord(row: Record<string, unknown>): InvoiceRecord {
  return {
    invoiceId: String(row.invoice_id), sessionId: String(row.session_id), callId: String(row.call_id),
    requirement: row.requirement as XrplRequirement, expiresAt: new Date(row.expires_at as string | Date),
    state: row.state as InvoiceState, transactionHash: row.transaction_hash ? String(row.transaction_hash) : null,
    response: row.response ?? null, evidence: (row.evidence ?? null) as XrplLedgerEvidence | null,
  };
}

export class PgXrplStore implements XrplSettlementJournal {
  constructor(private readonly db: Queryable) {}
  async migrate(): Promise<void> { await this.db.query(XRPL_SCHEMA); }

  async createInvoice(i: { invoiceId: string; sessionId: string; callId: string; requirement: XrplRequirement; expiresAt: Date }): Promise<void> {
    await this.db.query(
      'INSERT INTO xrpl_invoices(invoice_id,session_id,call_id,requirement,expires_at) VALUES($1,$2,$3,$4::jsonb,$5)',
      [i.invoiceId, i.sessionId, i.callId, JSON.stringify(i.requirement), i.expiresAt]);
  }
  async getInvoice(invoiceId: string): Promise<InvoiceRecord | null> {
    const r = await this.db.query('SELECT * FROM xrpl_invoices WHERE invoice_id=$1', [invoiceId]);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }
  async getByTransaction(hash: string): Promise<InvoiceRecord | null> {
    const r = await this.db.query('SELECT * FROM xrpl_invoices WHERE transaction_hash=$1', [hash.toUpperCase()]);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  /** Atomic reservation: OPEN and unexpired -> SETTLING, bound to one transaction hash. Rejects every duplicate. */
  async beginSettlement(callId: string, transactionHash: string): Promise<void> {
    if (!callId || callId.length > 128 || !HEX64.test(transactionHash)) throw new Error('Invalid settlement identity');
    let rowCount: number | null;
    try {
      ({ rowCount } = await this.db.query(
        "UPDATE xrpl_invoices SET state='SETTLING', transaction_hash=$2 WHERE call_id=$1 AND state='OPEN' AND expires_at > now()",
        [callId, transactionHash.toUpperCase()]));
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new Error('Payment transaction already used: reconcile, never resend');
      throw e;
    }
    if (rowCount !== 1) throw new Error('Settlement already attempted or invoice not open: reconcile, never resend');
  }
  async recordFacilitatorResponse(callId: string, response: unknown): Promise<void> {
    const r = response && typeof response === 'object' ? response as Record<string, unknown> : {};
    const safe = { success: r.success === true, transaction: typeof r.transaction === 'string' ? r.transaction : null, network: typeof r.network === 'string' ? r.network : null };
    const res = await this.db.query("UPDATE xrpl_invoices SET response=$2::jsonb WHERE call_id=$1 AND state IN ('SETTLING','RECONCILIATION_REQUIRED')", [callId, JSON.stringify(safe)]);
    if (res.rowCount !== 1) throw new Error('No active submission');
  }
  async markVerified(callId: string, evidence: XrplLedgerEvidence): Promise<void> {
    if (!evidence.validated || evidence.result !== 'tesSUCCESS' || !HEX64.test(evidence.hash)) throw new Error('Invalid ledger proof');
    const res = await this.db.query(
      "UPDATE xrpl_invoices SET state='VERIFIED', evidence=$3::jsonb WHERE call_id=$1 AND transaction_hash=$2 AND state IN ('SETTLING','RECONCILIATION_REQUIRED')",
      [callId, evidence.hash.toUpperCase(), JSON.stringify(evidence)]);
    if (res.rowCount === 1) return;
    const cur = await this.db.query('SELECT state,transaction_hash FROM xrpl_invoices WHERE call_id=$1', [callId]);
    const row = cur.rows[0];
    if (row && row.state === 'VERIFIED' && row.transaction_hash === evidence.hash.toUpperCase()) return; // idempotent
    throw new Error('Unknown transaction');
  }
  async markUnresolved(callId: string): Promise<void> {
    await this.db.query("UPDATE xrpl_invoices SET state='RECONCILIATION_REQUIRED' WHERE call_id=$1 AND state='SETTLING'", [callId]);
  }
  /** Durable pending attempts for read-only recovery after restart. */
  async pendingAttempts(): Promise<Array<{ callId: string; transactionHash: string; state: string }>> {
    const r = await this.db.query("SELECT call_id,transaction_hash,state FROM xrpl_invoices WHERE state IN ('SETTLING','RECONCILIATION_REQUIRED') ORDER BY created_at");
    return r.rows.map(row => ({ callId: String(row.call_id), transactionHash: String(row.transaction_hash), state: String(row.state) }));
  }
  async bindingFor(callId: string): Promise<InvoiceRecord | null> {
    const r = await this.db.query('SELECT * FROM xrpl_invoices WHERE call_id=$1', [callId]);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }
}
