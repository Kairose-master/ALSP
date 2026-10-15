/**
 * XRPL testnet x402 merchant: challenge issuance, payment validation, verify/settle and fulfilment.
 * Fails closed. /settle is called at most once per invoice (reservation is atomic in the shared store);
 * any uncertain outcome is resolved only by read-only validated-ledger lookups.
 */
import { createHash, randomUUID } from 'node:crypto';
import { decode } from 'ripple-binary-codec';
import { T54Facilitator, validateRequirement, xrplInvoiceField, type XrplPaymentPayload, type XrplRequirement } from './t54-facilitator.js';
import { invoiceIdForCall, type XrplLedgerEvidence, type XrplPaymentBinding } from './xrpl-evidence.js';
import { fetchVerifiedXrplPayment } from './xrpl-ledger.js';
import { XrplSettlementCoordinator } from './xrpl-settlement.js';
import type { InvoiceRecord, PgXrplStore } from './xrpl-pg-store.js';

export const XRPL_PAY_TO = 'rMRaxFZnyNHmqfafLbAdGbi9cHi24UhiaG';
export const XRPL_SOURCE_TAG = 804681468;
export const XRPL_PRICE_DROPS = '1000';
export const CHALLENGE_TTL_SECONDS = 600;
const MAX_HEADER = 16 * 1024;

export interface MerchantResult { status: number; headers: Record<string, string>; body: unknown }
export interface MerchantDeps {
  store: PgXrplStore; facilitator: T54Facilitator; ledgerFetch?: typeof fetch;
  now?: () => Date; sleep?: (ms: number) => Promise<void>; reconcileAttempts?: number; reconcileDelayMs?: number;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v);
}
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const dropsToXrp = (drops: string) => { const d = BigInt(drops); return (d / 1000000n).toString() + '.' + (d % 1000000n).toString().padStart(6, '0'); };

/** XRPL transaction id = first 32 bytes of SHA-512 over 'TXN\0' || signed blob. */
export function transactionHashOfBlob(blobHex: string): string {
  const h = createHash('sha512').update(Buffer.concat([Buffer.from('54584E00', 'hex'), Buffer.from(blobHex, 'hex')])).digest();
  return h.subarray(0, 32).toString('hex').toUpperCase();
}
export function bindingOf(inv: InvoiceRecord): XrplPaymentBinding {
  return { sessionId: inv.sessionId, callId: inv.callId, network: inv.requirement.network, invoiceId: inv.invoiceId,
    destination: inv.requirement.payTo, currency: 'XRP', amount: dropsToXrp(inv.requirement.amount) };
}

/** Local, signature-independent check that the blob pays exactly this invoice. t54 /verify checks the signature. */
export function checkSignedBlob(blobHex: string, req: XrplRequirement): { hash: string; account: string } {
  let tx: Record<string, unknown>;
  try { tx = decode(blobHex) as Record<string, unknown>; } catch { throw new Error('Undecodable signed transaction'); }
  if (tx.TransactionType !== 'Payment' || tx.Destination !== req.payTo || tx.Amount !== req.amount) throw new Error('Payment does not match requirement');
  if (typeof tx.InvoiceID !== 'string' || tx.InvoiceID.toUpperCase() !== xrplInvoiceField(req.extra.invoiceId)) throw new Error('Payment InvoiceID mismatch');
  if (Number(tx.SourceTag) !== req.extra.sourceTag) throw new Error('Payment SourceTag mismatch');
  if (req.extra.destinationTag !== undefined && Number(tx.DestinationTag) !== req.extra.destinationTag) throw new Error('Payment DestinationTag mismatch');
  if (typeof tx.TxnSignature !== 'string' || typeof tx.Account !== 'string') throw new Error('Payment is not signed');
  return { hash: transactionHashOfBlob(blobHex), account: tx.Account };
}

export function parsePaymentHeader(raw: string): XrplPaymentPayload {
  if (raw.length > MAX_HEADER) throw new Error('Payment header too large');
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { throw new Error('Malformed payment header'); }
  const p = v as XrplPaymentPayload;
  if (!p || p.x402Version !== 2 || !p.accepted || typeof p.accepted !== 'object' || !p.accepted.extra ||
      typeof p.payload?.signedTxBlob !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(p.payload.signedTxBlob)) throw new Error('Malformed payment payload');
  return p;
}

/** The paid product: a self-describing, independently re-verifiable ALSP session evidence record. */
export function evidenceReceipt(inv: InvoiceRecord, ev: XrplLedgerEvidence) {
  const core = {
    type: 'alsp.xrpl.session-evidence/v1', sessionId: inv.sessionId, callId: inv.callId, network: inv.requirement.network,
    invoiceId: inv.invoiceId, ledgerInvoiceId: ev.invoiceId,
    payment: { transaction: ev.hash, ledgerIndex: ev.ledgerIndex, result: ev.result, validated: ev.validated,
      destination: ev.destination, delivered: ev.deliveredAmount },
  };
  return { ...core, digest: 'sha256:' + createHash('sha256').update(stable(core)).digest('hex'),
    verify: 'Look up payment.transaction on an XRPL testnet server (method "tx"); InvoiceID must equal ledgerInvoiceId = SHA-256(invoiceId), Destination and delivered_amount must match.' };
}

export class XrplMerchant {
  private readonly now: () => Date;
  constructor(private readonly d: MerchantDeps) { this.now = d.now ?? (() => new Date()); }

  async challenge(origin: string, error?: string): Promise<MerchantResult> {
    const sessionId = randomUUID(), callId = randomUUID();
    const invoiceId = invoiceIdForCall(sessionId, callId);
    const requirement: XrplRequirement = { scheme: 'exact', network: 'xrpl:1', asset: 'XRP', amount: XRPL_PRICE_DROPS, payTo: XRPL_PAY_TO,
      maxTimeoutSeconds: CHALLENGE_TTL_SECONDS, extra: { invoiceId, sourceTag: XRPL_SOURCE_TAG } };
    validateRequirement(requirement, 'xrpl:1');
    await this.d.store.createInvoice({ invoiceId, sessionId, callId, requirement, expiresAt: new Date(this.now().getTime() + CHALLENGE_TTL_SECONDS * 1000) });
    const body = { x402Version: 2, error: error ?? 'Payment required',
      resource: { url: origin + '/api/xrpl/paid-resource', description: 'ALSP XRPL session evidence (testnet): payment-bound, ledger-verified JSON record', mimeType: 'application/json' },
      accepts: [requirement] };
    return { status: 402, headers: { 'PAYMENT-REQUIRED': b64(body) }, body };
  }

  async handle(origin: string, paymentHeader: string | undefined): Promise<MerchantResult> {
    if (!paymentHeader) return this.challenge(origin);
    let payload: XrplPaymentPayload;
    try { payload = parsePaymentHeader(paymentHeader); } catch (e) { return this.fail(400, (e as Error).message); }
    const inv = typeof payload.accepted.extra.invoiceId === 'string' ? await this.d.store.getInvoice(payload.accepted.extra.invoiceId) : null;
    if (!inv) return this.challenge(origin, 'Unknown invoice; pay the new requirement');
    if (stable(payload.accepted) !== stable(inv.requirement)) return this.fail(400, 'Payment does not match the issued requirement');
    let tx: { hash: string; account: string };
    try { tx = checkSignedBlob(payload.payload.signedTxBlob, inv.requirement); } catch (e) { return this.fail(400, (e as Error).message); }

    if (inv.state !== 'OPEN') {
      if (inv.transactionHash !== tx.hash) return this.fail(409, 'Invoice already paid or in settlement with a different transaction');
      return this.resolve(inv, tx);
    }
    if (inv.expiresAt.getTime() <= this.now().getTime()) return this.challenge(origin, 'Challenge expired; pay the new requirement');

    const canonical: XrplPaymentPayload = { x402Version: 2, accepted: inv.requirement, payload: payload.payload };
    try {
      const v = await this.d.facilitator.verify(canonical, inv.requirement);
      if (v.isValid !== true) return this.fail(402, 'Facilitator rejected payment: ' + String(v.invalidReason ?? 'invalid'));
      if (typeof v.payer === 'string' && v.payer !== tx.account) return this.fail(402, 'Payer mismatch');
    } catch { return this.fail(502, 'Facilitator verification unavailable; nothing was settled, retry'); }

    const coordinator = new XrplSettlementCoordinator(this.d.store, this.d.facilitator, this.d.ledgerFetch);
    try {
      await coordinator.settleOnce({ callId: inv.callId, transactionHash: tx.hash, binding: bindingOf(inv), requirement: inv.requirement, payload: canonical });
    } catch {
      const after = await this.d.store.getInvoice(inv.invoiceId);
      if (!after || after.transactionHash !== tx.hash) return this.fail(409, 'Payment could not be reserved (replay or concurrent use)');
      if (after.state !== 'VERIFIED') return this.resolve(after, tx);
    }
    const done = await this.d.store.getInvoice(inv.invoiceId);
    return done ? this.fulfil(done, tx) : this.fail(500, 'Invoice vanished');
  }

  /** Read-only recovery. Never calls /settle. */
  private async resolve(inv: InvoiceRecord, tx: { hash: string }): Promise<MerchantResult> {
    if (inv.state === 'VERIFIED') return this.fulfil(inv, tx);
    const coordinator = new XrplSettlementCoordinator(this.d.store, this.d.facilitator, this.d.ledgerFetch);
    const attempts = this.d.reconcileAttempts ?? 6, delay = this.d.reconcileDelayMs ?? 2000, sleep = this.d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    for (let i = 0; i < attempts; i++) {
      try {
        await coordinator.reconcile(inv.callId, tx.hash, bindingOf(inv));
        const done = await this.d.store.getInvoice(inv.invoiceId);
        if (done?.state === 'VERIFIED') return this.fulfil(done, tx);
      } catch { /* not validated yet or not found: keep polling the ledger */ }
      if (i < attempts - 1) await sleep(delay);
    }
    return { status: 202, headers: { 'retry-after': '10' },
      body: { status: 'settlement-pending', invoiceId: inv.invoiceId, transaction: tx.hash, message: 'Payment is not yet validated on the ledger. Re-send the same payment header to re-check; it will not be settled twice.' } };
  }
  private fulfil(inv: InvoiceRecord, tx: { hash: string }): MerchantResult {
    if (inv.state !== 'VERIFIED' || !inv.evidence || inv.evidence.hash !== tx.hash) return this.fail(500, 'No verified evidence');
    return { status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: inv.evidence.hash, network: inv.requirement.network }) }, body: evidenceReceipt(inv, inv.evidence) };
  }
  private fail(status: number, error: string): MerchantResult { return { status, headers: {}, body: { error } }; }
}

export { fetchVerifiedXrplPayment };
