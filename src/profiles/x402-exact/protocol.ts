import { createHash } from 'node:crypto';

export const PROFILE = 'alsp-exact-session-v0.2';
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
/** Parses a CAIP-2 `eip155:<chainId>` network identifier. */
export function chainIdOf(network: unknown): number {
  const m = /^eip155:(0|[1-9][0-9]{0,9})$/.exec(text(network));
  if (!m) throw new Error('Only eip155 networks are supported');
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid chain id');
  return id;
}
/** Doctor's documented ASCII / sorted UTF-16 canonical JSON, not RFC 8785. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('JSON nesting exceeds limit');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
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

/**
 * Describes one x402 `exact` provider the client is allowed to pay.
 * Every pinned value lives here; the protocol functions below take a profile instead of
 * hard-coding a single service. `DOCTOR_PROVIDER` is the original pinned reference target.
 */
export interface ProviderProfile {
  /** Stable identifier used for journals and presets. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Scheme + host[:port]. HTTPS is required except for loopback hosts. */
  origin: string;
  /** Paid endpoint path. The only path a payment may be sent to. */
  endpointPath: string;
  /** HTTP method of the paid endpoint. */
  method: 'GET' | 'POST';
  /** Optional unpaid public signer metadata path. */
  signerPath?: string;
  /** CAIP-2 network identifier, e.g. `eip155:8453`. */
  network: string;
  /** EIP-3009 asset and its EIP-712 domain name/version. */
  asset: { address: string; name: string; version: string };
  /** Pinned payout address. Also the authority that certifies rotated receipt signers. */
  payTo: string;
  /** Receipt binding: route string, cert service name and cert message header. */
  receipt: { route: string; service: string; certHeader: string };
  /** Validates/normalizes request parameters. Defaults to flat string query parameters. */
  input?: (value: unknown) => Record<string, string>;
  /** Validates the paid response body shape before signature checks. */
  validateBody?: (body: ObjectValue) => void;
}
/** JSON-serializable subset of a profile (no validator functions). */
export type ProviderProfileJson = Omit<ProviderProfile, 'input' | 'validateBody'>;

const LOOPBACK = /^(localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\])$/;
function pathOf(value: unknown): string {
  const s = text(value);
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(s) || s.includes('//') || s.includes('..')) throw new Error('Invalid provider path');
  return s;
}
/** Validates a profile and freezes it. Throws on anything that could widen the payment target. */
export function defineProvider(profile: ProviderProfile): ProviderProfile {
  const p = { ...profile };
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(p.id))) throw new Error('Invalid provider id');
  text(p.label);
  const origin = new URL(text(p.origin));
  if (origin.origin !== p.origin || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Provider origin must be scheme://host[:port]');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && LOOPBACK.test(origin.hostname))) throw new Error('Provider origin must be HTTPS (HTTP only on loopback)');
  pathOf(p.endpointPath);
  if (p.signerPath !== undefined) pathOf(p.signerPath);
  if (p.method !== 'GET' && p.method !== 'POST') throw new Error('Invalid provider method');
  chainIdOf(p.network);
  address(p.asset.address); text(p.asset.name); text(p.asset.version);
  address(p.payTo);
  text(p.receipt.route); text(p.receipt.service); text(p.receipt.certHeader);
  if (p.receipt.route !== `${p.method} ${p.endpointPath}`) throw new Error('Receipt route must match method and endpoint path');
  if (p.input !== undefined && typeof p.input !== 'function') throw new Error('Invalid input validator');
  if (p.validateBody !== undefined && typeof p.validateBody !== 'function') throw new Error('Invalid body validator');
  return Object.freeze(p);
}
/** Strips validator functions so a profile can be shown or stored as JSON. */
export function providerJson(p: ProviderProfile): ProviderProfileJson {
  const { input: _input, validateBody: _validateBody, ...json } = p;
  return json;
}
export const endpointUrl = (p: ProviderProfile): string => `${p.origin}${p.endpointPath}`;

/** Doctor preflight accepts exactly `url` (HTTPS, no credentials) and an optional GET/POST `method`. */
export function doctorInput(value: unknown): Record<string, string> {
  const v = object(value);
  if (Object.keys(v).some(k => k !== 'url' && k !== 'method')) throw new Error('Unsupported preflight parameter');
  const u = new URL(text(v.url));
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('Invalid target URL');
  if (v.method !== undefined && v.method !== 'GET' && v.method !== 'POST') throw new Error('Invalid target method');
  return v.method === undefined ? { url: text(v.url) } : { url: text(v.url), method: v.method };
}
/** Generic providers take a flat map of at most 16 short string parameters. */
export function genericInput(value: unknown): Record<string, string> {
  const v = object(value), keys = Object.keys(v).sort();
  if (keys.length > 16) throw new Error('Too many request parameters');
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) throw new Error('Invalid request parameter name');
    const s = v[k];
    if (typeof s !== 'string' || s.length > 2048) throw new Error('Request parameters must be short strings');
    out[k] = s;
  }
  return out;
}
/** Doctor returns a preflight verdict; its shape is checked before trusting the receipt. */
export function doctorBody(body: ObjectValue): void {
  if (!['go', 'caution', 'no_go'].includes(String(body.verdict)) || typeof body.safe_to_pay !== 'boolean' || typeof body.summary !== 'string' || !Array.isArray(body.options) || !Array.isArray(body.reasons)) throw new Error('Invalid preflight response shape');
  object(body.signals);
  if (body.recommended_option !== null && (!Number.isSafeInteger(body.recommended_option) || Number(body.recommended_option) < 0 || Number(body.recommended_option) >= body.options.length)) throw new Error('Invalid recommended option');
}

export const DOCTOR = 'https://x402-doctor.fizzl.eu';
export const ROUTE = 'GET /api/v1/preflight';
export const NETWORK = 'eip155:8453';
export const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
/** The original pinned reference target: x402 Doctor preflight on Base mainnet USDC. */
export const DOCTOR_PROVIDER: ProviderProfile = defineProvider({
  id: 'x402-doctor', label: 'x402 Doctor preflight (Base mainnet USDC)', origin: DOCTOR, endpointPath: '/api/v1/preflight', method: 'GET',
  signerPath: '/.well-known/x402-doctor-signer.json', network: NETWORK, asset: { address: ASSET, name: 'USD Coin', version: '2' }, payTo: PAY_TO,
  receipt: { route: ROUTE, service: 'x402-doctor', certHeader: 'fizzl receipt signer' }, input: doctorInput, validateBody: doctorBody,
});

export interface Terms {
  profile: typeof PROFILE;
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
}
export function validateTerms(t: Terms, p: ProviderProfile = DOCTOR_PROVIDER): void {
  if (t.profile !== PROFILE || t.network !== p.network || address(t.asset) !== address(p.asset.address) || address(t.provider) !== address(p.payTo)) throw new Error('Unsupported payment profile');
  address(t.payer);
  if (t.endpoint !== endpointUrl(p)) throw new Error('Terms endpoint does not match the provider profile');
  if (atomic(t.maxTotal) <= 0n || atomic(t.maxPerCall) <= 0n || atomic(t.maxPerCall) > atomic(t.maxTotal)) throw new Error('Invalid budget');
  if (!Number.isSafeInteger(t.maxCalls) || t.maxCalls < 1 || t.maxCalls > 100) throw new Error('Invalid call limit');
  if (!Number.isSafeInteger(t.expiresAt)) throw new Error('Invalid expiry');
  if (!t.license || t.license.acceptance !== 'buyer-only' || !/^[a-f0-9]{64}$/.test(t.license.sha256)) throw new Error('Explicit license commitment required');
  text(t.license.uri);
  canonical(t);
}
export type RequestInput = Record<string, unknown>;
export function inputOf(value: RequestInput, p: ProviderProfile = DOCTOR_PROVIDER): Record<string, string> {
  return (p.input ?? genericInput)(value);
}
export function requestUrl(terms: Terms, input: RequestInput, p: ProviderProfile = DOCTOR_PROVIDER): string {
  const url = new URL(terms.endpoint);
  for (const [k, v] of Object.entries(inputOf(input, p))) url.searchParams.set(k, v);
  return url.href;
}
export interface Quote {
  x402Version: 2;
  resource: ObjectValue;
  accepted: { scheme: 'exact'; network: string; asset: string; payTo: string; amount: string; maxTimeoutSeconds: number; extra: ObjectValue };
}
export function selectQuote(challenge: unknown, terms: Terms, input: RequestInput, p: ProviderProfile = DOCTOR_PROVIDER): Quote {
  validateTerms(terms, p);
  const c = object(challenge), r = object(c.resource);
  const expected = new URL(requestUrl(terms, input, p)), resource = new URL(text(r.url));
  if (c.x402Version !== 2 || resource.origin !== expected.origin || resource.pathname !== expected.pathname || resource.username || resource.password || resource.hash || (resource.search && resource.search !== expected.search)) throw new Error('Wrong resource or x402 version');
  if (!Array.isArray(c.accepts) || c.accepts.length > 32) throw new Error('Invalid accepts');
  const options: Quote['accepted'][] = [];
  for (const entry of c.accepts) {
    try {
      const a = object(entry), extra = object(a.extra);
      if (a.scheme !== 'exact' || a.network !== terms.network || address(a.asset) !== address(terms.asset) || address(a.payTo) !== address(terms.provider)) continue;
      if (extra.name !== p.asset.name || extra.version !== p.asset.version || (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009')) continue;
      if (!Number.isSafeInteger(a.maxTimeoutSeconds) || Number(a.maxTimeoutSeconds) < 1 || Number(a.maxTimeoutSeconds) > 300) continue;
      const amount = atomic(a.amount);
      if (amount === 0n || amount > atomic(terms.maxPerCall)) continue;
      options.push({ scheme: 'exact', network: terms.network, asset: text(a.asset), payTo: text(a.payTo), amount: amount.toString(), maxTimeoutSeconds: Number(a.maxTimeoutSeconds), extra });
    } catch { /* Malformed / unsupported options cannot authorize payment. */ }
  }
  options.sort((a, b) => atomic(a.amount) < atomic(b.amount) ? -1 : atomic(a.amount) > atomic(b.amount) ? 1 : 0);
  const accepted = options[0];
  if (!accepted) throw new Error(`No supported exact ${p.asset.name} option within policy`);
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
