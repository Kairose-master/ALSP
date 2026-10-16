/** t54 XRPL x402 v2 facilitator transport. No wallet signing or ledger verification. */
import { createHash } from 'node:crypto';

export const T54_TESTNET = 'https://xrpl-facilitator-testnet.t54.ai';
export const T54_MAINNET = 'https://xrpl-facilitator-mainnet.t54.ai';
export type T54Network = 'xrpl:0' | 'xrpl:1';

export interface XrplRequirement {
  scheme: 'exact';
  network: T54Network;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  extra: { invoiceId: string; sourceTag: number; issuer?: string; destinationTag?: number };
}
export interface XrplPaymentPayload {
  x402Version: 2;
  accepted: XrplRequirement;
  payload: { signedTxBlob: string; invoiceId: string };
}
export interface T54Settlement {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  [key: string]: unknown;
}
export function xrplInvoiceField(invoiceId: string): string {
  if (!invoiceId || invoiceId.length > 256) throw new Error('Invalid invoice identifier');
  return createHash('sha256').update(invoiceId, 'utf8').digest('hex').toUpperCase();
}
export function validateRequirement(r: XrplRequirement, expected: T54Network): void {
  if (r.scheme !== 'exact' || r.network !== expected) throw new Error('Scheme/network mismatch');
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(r.payTo)) throw new Error('Invalid destination shape');
  if (!r.extra || !r.extra.invoiceId || r.extra.invoiceId.length > 256) throw new Error('Missing invoice binding');
  if (!Number.isSafeInteger(r.extra.sourceTag) || r.extra.sourceTag < 0 || r.extra.sourceTag > 0xffffffff) throw new Error('Invalid source tag');
  if (r.extra.destinationTag !== undefined && (!Number.isSafeInteger(r.extra.destinationTag) || r.extra.destinationTag < 0 || r.extra.destinationTag > 0xffffffff)) throw new Error('Invalid destination tag');
  if (!Number.isSafeInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds <= 0) throw new Error('Invalid timeout');
  if (r.asset === 'XRP') {
    if (!/^[1-9][0-9]*$/.test(r.amount) || r.extra.issuer) throw new Error('XRP amount must be positive integer drops');
  } else {
    if (!/^(?:[A-Z0-9]{3}|[0-9A-F]{40})$/.test(r.asset) || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(r.amount) || !/[1-9]/.test(r.amount) || !r.extra.issuer)
      throw new Error('Invalid issued-currency requirement');
  }
}
export class T54Facilitator {
  readonly baseUrl: string;
  constructor(readonly network: T54Network = 'xrpl:1', private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = network === 'xrpl:1' ? T54_TESTNET : network === 'xrpl:0' ? T54_MAINNET : (() => { throw new Error('Unsupported network'); })();
  }
  private async post(path: '/verify' | '/settle', paymentPayload: XrplPaymentPayload, paymentRequirements: XrplRequirement): Promise<Record<string, unknown>> {
    validateRequirement(paymentRequirements, this.network);
    if (paymentPayload.x402Version !== 2 || paymentPayload.accepted.scheme !== 'exact' ||
      JSON.stringify(paymentPayload.accepted) !== JSON.stringify(paymentRequirements) ||
      !/^(?:[0-9a-fA-F]{2})+$/.test(paymentPayload.payload?.signedTxBlob ?? '') ||
      paymentPayload.payload?.invoiceId !== paymentRequirements.extra.invoiceId) throw new Error('Invalid signed payment envelope');
    const response = await this.fetchImpl(this.baseUrl + path, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ paymentPayload, paymentRequirements }), redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Facilitator HTTP failure: ' + response.status);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid facilitator response');
    return body as Record<string, unknown>;
  }
  verify(payload: XrplPaymentPayload, requirement: XrplRequirement): Promise<Record<string, unknown>> {
    return this.post('/verify', payload, requirement);
  }
  /** Never retry an ambiguous settlement automatically. Persist intent before calling. */
  async settle(payload: XrplPaymentPayload, requirement: XrplRequirement, explicitTestnetOptIn: boolean): Promise<T54Settlement> {
    if (this.network !== 'xrpl:1' || !explicitTestnetOptIn) throw new Error('Settlement disabled outside explicitly opted-in testnet');
    const result = await this.post('/settle', payload, requirement);
    if (typeof result.success !== 'boolean') throw new Error('Malformed settlement response');
    if (result.network !== undefined && result.network !== this.network) throw new Error('Settlement network mismatch');
    return result as T54Settlement;
  }
}
