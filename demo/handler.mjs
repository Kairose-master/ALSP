// Stateless x402 Exact proxy + verifier shared by the local server and the Vercel function.
// The browser owns the wallet and the journal; this side only does what the library already does:
// fetch the 402 challenge, forward one signed payment, verify receipts/settlement, verify archives.
// It never stores keys, authorizations or responses.
import { agentEnabled, agentTurn, MODEL as AGENT_MODEL } from './agent.mjs';
import { DOCTOR_PROVIDER, PROFILE, address, atomic, boundedFetch, canonical, defineProvider, digest, hash32, jsonRpc, object, providerJson, requestUrl, selectQuote, validatePrepared, validateTerms, verifyBuyerSeal, verifyChain, verifyReceipt, verifySettlement, x402Transport } from '../dist/index.js';

const MAX_BODY = 512 * 1024;
const PRESETS = { [DOCTOR_PROVIDER.id]: DOCTOR_PROVIDER };
const DEFAULT_RPC = { 'eip155:8453': process.env.ALSP_RPC_URL || 'https://mainnet.base.org' };
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\..*|10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*|169\.254\..*|0\.0\.0\.0|\[.*\])$/i;

function allowedOrigins() {
  const raw = process.env.ALSP_ALLOWED_ORIGINS;
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : null;
}
/** Resolves a provider profile sent by the browser. Presets keep their validators; custom profiles get the generic ones. */
function resolveProvider(value) {
  const v = object(value);
  if (typeof v.id === 'string' && PRESETS[v.id] && Object.keys(v).length === 1) return PRESETS[v.id];
  const p = defineProvider({ id: v.id, label: v.label, origin: v.origin, endpointPath: v.endpointPath, method: v.method, signerPath: v.signerPath ?? undefined, network: v.network, asset: object(v.asset), payTo: v.payTo, receipt: object(v.receipt) });
  const host = new URL(p.origin);
  if (host.protocol !== 'https:' || PRIVATE_HOST.test(host.hostname)) throw new Error('Remote providers must be public HTTPS origins');
  const allow = allowedOrigins();
  if (allow && !allow.includes(p.origin) && !PRESETS[p.id]) throw new Error('Provider origin is not in ALSP_ALLOWED_ORIGINS');
  return p;
}
function rpcFor(terms, requested, deps) {
  const url = typeof requested === 'string' && requested ? requested : DEFAULT_RPC[terms.network];
  if (!url) throw new Error('No RPC URL configured for this network');
  const u = new URL(url);
  if (u.protocol !== 'https:' || PRIVATE_HOST.test(u.hostname)) throw new Error('RPC URL must be a public HTTPS endpoint');
  return jsonRpc(url, deps?.fetchImpl ?? fetch);
}
/** A payment verified seconds after settlement often has 1 confirmation or an RPC that has not indexed the receipt yet.
 *  Those are transient, so retry them for a bounded time; every other failure is final. */
const TRANSIENT = /Insufficient confirmations|Expected an object|RPC HTTP failure|RPC response too large|Invalid RPC response|No RPC body|fetch failed|aborted/i;
async function settleWithPatience(call, terms, rpc, deps) {
  const attempts = deps.settleAttempts ?? 6, delayMs = deps.settleDelayMs ?? 2500;
  for (let i = 1; ; i++) {
    try { return await verifySettlement(call, terms, rpc, 2); }
    catch (err) {
      if (i >= attempts || !(err instanceof Error) || !TRANSIENT.test(err.message)) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
function callOf(value) {
  const c = object(value);
  return { id: String(c.id ?? ''), sessionId: String(c.sessionId ?? ''), requestKey: String(c.requestKey ?? ''), requestHash: String(c.requestHash ?? ''), input: object(c.input), quote: object(c.quote), amount: atomic(c.amount).toString(), nonce: hash32(c.nonce), createdAt: Number(c.createdAt), state: String(c.state ?? ''), prepared: c.prepared ? object(c.prepared) : null, wire: c.wire ? object(c.wire) : null, verified: null };
}
function pinsOf(value) {
  if (!Array.isArray(value) || value.length > 8) throw new Error('pins must be a short array');
  return value.map(p => { const o = object(p); return { address: address(o.address), ...(o.validFrom ? { validFrom: String(o.validFrom) } : {}), ...(o.validUntil ? { validUntil: String(o.validUntil) } : {}) }; });
}

export async function handle(method, path, rawBody, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch, transport = p => x402Transport(p, fetchImpl);
  try {
    if (method === 'GET' && path === '/api/meta') {
      return [200, { profile: PROFILE, presets: Object.fromEntries(Object.values(PRESETS).map(p => [p.id, providerJson(p)])), defaultRpc: DEFAULT_RPC, allowedOrigins: allowedOrigins(), interopTarget: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', agent: { enabled: agentEnabled(), model: AGENT_MODEL } }];
    }
    if (method !== 'POST') return [404, { error: 'Not found' }];
    if (rawBody && rawBody.length > MAX_BODY) return [413, { error: 'Request too large' }];
    const body = object(rawBody ? JSON.parse(rawBody) : {});

    if (path === '/api/agent/turn') return agentTurn(body, deps.agent ?? {});
    if (path === '/api/x402/signer') {
      // Unpaid: the provider's published signer document. Shown for review only; it never becomes a pin by itself.
      const p = resolveProvider(body.provider);
      if (!p.signerPath) return [200, { signerDocument: null }];
      const r = await boundedFetch(`${p.origin}${p.signerPath}`, {}, fetchImpl, p);
      return [200, { signerDocument: r.status === 200 ? r.body : null, status: r.status }];
    }
    if (path === '/api/x402/probe') {
      // Unpaid: fetch and validate the 402 challenge, select the cheapest option within the terms. No signature exists yet.
      const p = resolveProvider(body.provider), terms = object(body.terms);
      validateTerms(terms, p);
      const url = requestUrl(terms, object(body.input), p);
      const challenge = await transport(p).probe(url);
      const quote = selectQuote(challenge, terms, object(body.input), p);
      return [200, { url, quote, challengeHash: digest(challenge) }];
    }
    if (path === '/api/x402/send') {
      // Paid: forward exactly one browser-signed authorization. The browser has already journaled submission intent.
      const p = resolveProvider(body.provider), terms = object(body.terms), prepared = object(body.prepared), nonce = hash32(body.nonce);
      validateTerms(terms, p);
      validatePrepared(prepared, prepared.quote, terms, nonce, Date.now());
      const a = prepared.quote.accepted;
      if (a.network !== terms.network || address(a.asset) !== address(terms.asset) || address(a.payTo) !== address(terms.provider) || atomic(a.amount) > atomic(terms.maxPerCall)) throw new Error('Quote outside terms');
      const url = requestUrl(terms, object(body.input), p);
      const wire = await transport(p).send(url, prepared);
      return [200, { wire }];
    }
    if (path === '/api/x402/verify') {
      // Evidence check only: provider signature + request/payment binding, then RPC-confirmed settlement.
      const p = resolveProvider(body.provider), terms = object(body.terms), call = callOf(body.call), pins = pinsOf(body.pins);
      validateTerms(terms, p);
      const receipt = await verifyReceipt(call, terms, pins, p);
      const ledger = await settleWithPatience(call, terms, rpcFor(terms, body.rpcUrl, deps), deps);
      return [200, { verified: { receipt, ledger, semanticCorrectness: 'not-verified' } }];
    }
    if (path === '/api/archive/verify') {
      const archive = object(body.archive);
      const chain = verifyChain(archive);
      const seal = archive.buyerSeal ? await verifyBuyerSeal(archive, address(object(archive.buyerSeal).signer)) : null;
      return [200, { chain, seal, headHash: archive.headHash, archiveSha256: archive.buyerSeal ? digest((({ buyerSeal: _s, ...rest }) => rest)(archive)) : null, canonicalBytes: canonical(archive).length }];
    }
    return [404, { error: 'Not found' }];
  } catch (err) {
    // Stable messages only; never echo request bodies (they can contain bearer authorizations).
    return [400, { ok: false, error: err instanceof Error ? err.message : 'unknown error' }];
  }
}
