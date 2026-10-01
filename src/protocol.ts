import { createHash } from 'node:crypto';

export const PROFILE = 'alsp-exact-session-v0.2'; // frozen wire/profile identifier for Interop #001 archives
export const GENERIC_PROFILE = 'alsp-exact-session-v0.3';
/** Legacy Doctor/Base constants retained for the frozen v0.2 compatibility adapter. */
export const DOCTOR = 'https://x402-doctor.fizzl.eu';
export const ROUTE = 'GET /api/v1/preflight';
export const NETWORK = 'eip155:8453';
export const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as ObjectValue;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new Error('Invalid text');
  return value;
}
export function atomic(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Invalid atomic amount');
  const n = BigInt(value);
  if (n >= 2n ** 256n) throw new Error('Amount exceeds uint256');
  return n;
}
export function address(value: unknown): string {
  const s = text(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error('Invalid EVM address');
  return s.toLowerCase();
}
export function hash32(value: unknown): string {
  const s = text(value);
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('Invalid bytes32');
  return s.toLowerCase();
}
/** Doctor's documented ASCII / sorted UTF-16 canonical JSON, not RFC 8785. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('JSON nesting exceeds limit');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, v => canonical(v, depth + 1)).join(',')}]`;
  if (typeof value === 'object' && value && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(k => `${canonical(k)}:${canonical(object(value)[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Only finite plain JSON values are supported');
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function unpack(header: string | null): unknown {
  if (!header || header.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) throw new Error('Invalid payment header');
  const b = Buffer.from(header, 'base64');
  if (b.toString('base64').replace(/=+$/, '') !== header.replace(/=+$/, '')) throw new Error('Invalid base64');
  const value: unknown = JSON.parse(b.toString('utf8'));
  canonical(value);
  return value;
}
export const pack = (value: unknown): string => Buffer.from(canonical(value)).toString('base64');
export interface Terms {
  profile: typeof PROFILE | typeof GENERIC_PROFILE;
  payer: string;
  provider: string;
  network: string;
  asset: string;
  endpoint: string;
  maxTotal: string;
  maxPerCall: string;
  maxCalls: number;
  expiresAt: number;
  license: { uri: string; sha256: string; acceptance: 'buyer-only' };
  providerProfile?: ProviderProfile;
  paymentProfile?: PaymentProfile;
}
/** Provider identity and endpoint are independent of any payment rail. */
export interface ProviderProfile { id: string; address: string; endpoint: string; }
/** Exact payment constraints are independent of provider transport and business identity. */
export interface PaymentProfile { id: string; scheme: 'exact-per-call'; network: string; asset: string; payTo: string; }
/** Public v0.3 terms shape. The journal stores its validated normalized projection for runtime compatibility. */
export interface GenericTerms {
  profile: typeof GENERIC_PROFILE;
  payer: string;
  providerProfile: ProviderProfile;
  paymentProfile: PaymentProfile;
  maxTotal: string;
  maxPerCall: string;
  maxCalls: number;
  expiresAt: number;
  license: Terms['license'];
}
export function normalizeTerms(t: GenericTerms): Terms {
  if (t.profile !== GENERIC_PROFILE || t.paymentProfile.scheme !== 'exact-per-call') throw new Error('Unsupported generic terms profile');
  if (!text(t.providerProfile.id) || !text(t.paymentProfile.id)) throw new Error('Profile identifiers required');
  if (address(t.providerProfile.address) !== address(t.paymentProfile.payTo)) throw new Error('Provider payee must match provider identity');
  return { profile: t.profile, payer: t.payer, provider: t.providerProfile.address, endpoint: t.providerProfile.endpoint,
    network: t.paymentProfile.network, asset: t.paymentProfile.asset, maxTotal: t.maxTotal, maxPerCall: t.maxPerCall,
    maxCalls: t.maxCalls, expiresAt: t.expiresAt, license: t.license,
    providerProfile: t.providerProfile, paymentProfile: t.paymentProfile };
}
export function validateTerms(t: Terms): void {
  if (t.profile !== PROFILE && t.profile !== GENERIC_PROFILE) throw new Error('Unsupported payment profile');
  address(t.payer);
  address(t.provider); text(t.network); address(t.asset);
  if (t.profile === GENERIC_PROFILE) {
    if (!t.providerProfile || !t.paymentProfile || address(t.providerProfile.address) !== address(t.provider)
      || t.providerProfile.endpoint !== t.endpoint || t.paymentProfile.network !== t.network
      || address(t.paymentProfile.asset) !== address(t.asset) || address(t.paymentProfile.payTo) !== address(t.provider)
      || t.paymentProfile.scheme !== 'exact-per-call') throw new Error('Generic provider/payment profile mismatch');
    text(t.providerProfile.id); text(t.paymentProfile.id);
  }
  const endpoint = new URL(text(t.endpoint));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid provider endpoint');
  if (atomic(t.maxTotal) <= 0n || atomic(t.maxPerCall) <= 0n || atomic(t.maxPerCall) > atomic(t.maxTotal)) throw new Error('Invalid budget');
  if (!Number.isSafeInteger(t.maxCalls) || t.maxCalls < 1 || t.maxCalls > 100) throw new Error('Invalid call limit');
  if (!Number.isSafeInteger(t.expiresAt)) throw new Error('Invalid expiry');
  if (!t.license || t.license.acceptance !== 'buyer-only' || !/^[a-f0-9]{64}$/.test(t.license.sha256)) throw new Error('Explicit license commitment required');
  text(t.license.uri);
  canonical(t);
}
export interface RequestInput { url: string; method?: 'GET' | 'POST'; }
export function inputOf(value: RequestInput): Record<string, string> {
  const v = object(value);
  if (Object.keys(v).some(k => k !== 'url' && k !== 'method')) throw new Error('Unsupported preflight parameter');
  const u = new URL(text(value.url));
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('Invalid target URL');
  if (value.method !== undefined && value.method !== 'GET' && value.method !== 'POST') throw new Error('Invalid target method');
  return value.method === undefined ? { url: value.url } : { url: value.url, method: value.method };
}
export function requestUrl(terms: Terms, input: RequestInput): string {
  const url = new URL(terms.endpoint);
  for (const [k, v] of Object.entries(inputOf(input))) url.searchParams.set(k, v);
  return url.href;
}
export interface Quote {
  x402Version: 2;
  resource: ObjectValue;
  accepted: { scheme: 'exact'; network: string; asset: string; payTo: string; amount: string; maxTimeoutSeconds: number; extra: ObjectValue };
}
export function selectQuote(challenge: unknown, terms: Terms, input: RequestInput): Quote {
  validateTerms(terms);
  const c = object(challenge), r = object(c.resource);
  const expected = new URL(requestUrl(terms, input)), resource = new URL(text(r.url));
  if (c.x402Version !== 2 || resource.origin !== expected.origin || resource.pathname !== expected.pathname || resource.username || resource.password || resource.hash || (resource.search && resource.search !== expected.search)) throw new Error('Wrong resource or x402 version');
  if (!Array.isArray(c.accepts) || c.accepts.length > 32) throw new Error('Invalid accepts');
  const options: Quote['accepted'][] = [];
  for (const entry of c.accepts) {
    try {
      const a = object(entry), extra = object(a.extra);
      // v0.3 currently exposes a generic exact-per-call boundary only. `upto` and
      // batch options are intentionally rejected until settlement is implemented.
      if (a.scheme !== 'exact' || a.network !== terms.network || address(a.asset) !== address(terms.asset) || address(a.payTo) !== address(terms.provider)) continue;
      // The legacy EVM signer speaks EIP-3009. Do not silently interpret a
      // different transfer method as that authorization format.
      if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009') continue;
      if (!Number.isSafeInteger(a.maxTimeoutSeconds) || Number(a.maxTimeoutSeconds) < 1 || Number(a.maxTimeoutSeconds) > 300) continue;
      const amount = atomic(a.amount);
      if (amount === 0n || amount > atomic(terms.maxPerCall)) continue;
      options.push({ scheme: 'exact', network: terms.network, asset: text(a.asset), payTo: text(a.payTo), amount: amount.toString(), maxTimeoutSeconds: Number(a.maxTimeoutSeconds), extra });
    } catch { /* Malformed / unsupported options cannot authorize payment. */ }
  }
  options.sort((a, b) => atomic(a.amount) < atomic(b.amount) ? -1 : atomic(a.amount) > atomic(b.amount) ? 1 : 0);
  const accepted = options[0];
  if (!accepted) throw new Error('No supported exact-per-call option within policy');
  return { x402Version: 2, resource: r, accepted };
}
export interface Prepared {
  quote: Quote;
  authorization: { from: string; to: string; value: string; nonce: string; validAfter: string; validBefore: string };
  signature: string;
}
export function validatePrepared(p: Prepared, q: Quote, terms: Terms, nonce: string, now: number): void {
  const a = p.authorization;
  if (digest(p.quote) !== digest(q) || address(a.from) !== address(terms.payer) || address(a.to) !== address(terms.provider) || atomic(a.value) !== atomic(q.accepted.amount) || hash32(a.nonce) !== nonce) throw new Error('Signer changed payment parameters');
  const after = atomic(a.validAfter), before = atomic(a.validBefore), seconds = BigInt(Math.floor(now / 1000));
  if (after > seconds || before <= seconds || before > seconds + BigInt(q.accepted.maxTimeoutSeconds) || before * 1000n > BigInt(terms.expiresAt)) throw new Error('Invalid authorization lifetime');
  if (!/^0x[a-fA-F0-9]{130}$/.test(p.signature)) throw new Error('Invalid payment signature');
}
export interface WireResponse { status: number; body: unknown; settlement: unknown; }
export interface ReceiptEvidence { requestId: string; signer: string; responseHash: string; signedAt: string; }
export interface LedgerEvidence { transaction: string; blockHash: string; blockNumber: string; confirmations: number; verification: 'rpc-confirmed'; }
export interface Verified { receipt: ReceiptEvidence; ledger: LedgerEvidence; semanticCorrectness: 'not-verified'; }
