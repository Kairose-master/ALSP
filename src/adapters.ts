import { address, atomic, digest, hash32, object, text, type Prepared, type Quote, type ReceiptEvidence, type Terms, type WireResponse, type Verified } from './protocol.js';
import type { Call } from './journal.js';

/** Provider boundary: an unpaid offer probe and exactly one explicit paid send. */
export interface ProviderAdapter {
  probe(url: string): Promise<unknown>;
  send(url: string, payment: Prepared): Promise<WireResponse>;
}
/** Capability boundary. Implementations must reject capabilities they do not implement. */
export interface PaymentAdapter {
  readonly capabilities?: ReadonlySet<'exact-per-call' | 'upto' | 'batch'>;
  prepare(quote: Quote, terms: Terms, nonce: string, now: number): Promise<Prepared>;
  validate?(prepared: Prepared, quote: Quote, terms: Terms, nonce: string, now: number): void;
}
export interface ReceiptEvidenceAdapter {
  verify(call: Call, terms: Terms): Promise<Verified>;
}
export interface ProviderReceiptVerifier {
  verifyReceipt(call: Call, terms: Terms): Promise<ReceiptEvidence>;
}
export function requireImplementedCapability(adapter: PaymentAdapter, capability: 'exact-per-call' | 'upto' | 'batch'): void {
  if (!adapter.capabilities?.has(capability)) throw new Error(`Unsupported payment capability: ${capability}`);
  if (capability !== 'exact-per-call') throw new Error(`Capability is not enabled in ALSP v0.3: ${capability}`);
}
export function createSessionAdapters(provider: ProviderAdapter, payment: PaymentAdapter, receipt: ReceiptEvidenceAdapter) {
  requireImplementedCapability(payment, 'exact-per-call');
  return { ...provider, ...payment, ...receipt };
}
/** x402 v2 offer/receipt composition point. It verifies the receipt's binding envelope;
 * chain finality remains the responsibility of a settlement evidence adapter.
 */
export class X402OfferReceiptEnvelopeValidator {
  verify(call: Call, terms: Terms): { requestId: string; signer: string; responseHash: string; signedAt: string } {
    if (!call.wire || !call.prepared || call.wire.status < 200 || call.wire.status >= 300) throw new Error('No successful x402 response');
    const body = object(call.wire.body), offer = object(body.offer), receipt = object(body.receipt);
    if (Number(body.x402Version) !== 2 || digest(offer) !== digest(call.prepared.quote)) throw new Error('x402 offer does not match the paid quote');
    if (receipt.success !== true || digest(receipt.offer) !== digest(offer)) throw new Error('x402 receipt does not bind to the offer');
    const transaction = text(receipt.transaction), signedAt = text(receipt.timestamp), signer = text(receipt.payTo);
    if (!/^0x[0-9a-fA-F]{64}$/.test(transaction) || !Number.isFinite(Date.parse(signedAt))) throw new Error('Malformed x402 receipt');
    if (text(receipt.network) !== terms.network || address(receipt.asset) !== address(terms.asset)
      || address(receipt.payTo) !== address(terms.provider) || address(receipt.payer) !== address(terms.payer)
      || atomic(receipt.amount) !== atomic(call.amount) || hash32(receipt.nonce) !== hash32(call.nonce)) throw new Error('x402 receipt payment binding mismatch');
    return { requestId: transaction.toLowerCase(), signer, responseHash: digest(body), signedAt };
  }
}
/** @deprecated Use X402OfferReceiptEnvelopeValidator; this validates bindings, not signatures. */
export class X402OfferReceiptAdapter extends X402OfferReceiptEnvelopeValidator {}
