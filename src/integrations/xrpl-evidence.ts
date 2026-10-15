/**
 * XRPL payment evidence binding for ALSP.
 * Independent of the EVM x402 profile. No settlement or signature claims.
 */
import { createHash } from 'node:crypto';

export interface XrplPaymentBinding {
  sessionId: string;
  callId: string;
  network: string;
  invoiceId: string;
  destination: string;
  currency: string;
  amount: string;
  issuer?: string;
}

const hex64 = /^[0-9A-F]{64}$/;
const decimal = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function invoiceIdForCall(sessionId: string, callId: string): string {
  if (!sessionId || !callId) throw new Error('Missing ALSP identity');
  return createHash('sha256').update(JSON.stringify(['ALSP-XRPL-INVOICE-V1', sessionId, callId])).digest('hex').toUpperCase();
}

export function validateXrplBinding(binding: XrplPaymentBinding): void {
  if (!binding.sessionId || !binding.callId) throw new Error('Missing ALSP identity');
  if (!/^xrpl:[a-zA-Z0-9_-]+$/.test(binding.network)) throw new Error('Invalid XRPL network');
  if (!hex64.test(binding.invoiceId) || binding.invoiceId !== invoiceIdForCall(binding.sessionId, binding.callId))
    throw new Error('Invoice ID does not match ALSP call');
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(binding.destination)) throw new Error('Invalid classic address shape');
  if (!decimal.test(binding.amount) || !/[1-9]/.test(binding.amount)) throw new Error('Invalid amount');
  if (!/^[A-Z0-9]{3,40}$/.test(binding.currency)) throw new Error('Invalid currency');
  if (binding.currency !== 'XRP' && !binding.issuer) throw new Error('Issued currency requires issuer');
  if (binding.currency === 'XRP' && binding.issuer) throw new Error('Native XRP cannot have issuer');
}

/** Accept only validated ledger evidence from an independently trusted XRPL source. */
export interface XrplLedgerEvidence {
  validated: boolean;
  transactionType: string;
  result: string;
  hash: string;
  ledgerIndex: number;
  invoiceId: string;
  destination: string;
  deliveredAmount: { currency: string; value: string; issuer?: string };
}

export function verifyXrplSettlement(binding: XrplPaymentBinding, evidence: XrplLedgerEvidence): boolean {
  validateXrplBinding(binding);
  if (!evidence.validated || evidence.transactionType !== 'Payment' || evidence.result !== 'tesSUCCESS') return false;
  if (!hex64.test(evidence.hash) || !Number.isSafeInteger(evidence.ledgerIndex) || evidence.ledgerIndex <= 0) return false;
  if (evidence.invoiceId !== binding.invoiceId || evidence.destination !== binding.destination) return false;
  const actual = evidence.deliveredAmount;
  if (!actual || actual.currency !== binding.currency || (actual.issuer ?? undefined) !== (binding.issuer ?? undefined)) return false;
  if (!decimal.test(actual.value)) return false;
  // Exact decimal equality without floating-point rounding.
  const normalize = (v: string) => { const [whole = '', fraction = ''] = v.split('.'); return whole.replace(/^0+(?=\d)/, '') + '.' + fraction.replace(/0+$/, ''); };
  return normalize(actual.value) === normalize(binding.amount);
}
