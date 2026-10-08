// Turns any x402 v2 URL into a provider profile by reading its own 402 challenge (unpaid).
// Generic providers do not sign receipts, so the profile is `receipt: { mode: 'unsigned' }`:
// verification rests on the RPC-confirmed USDC settlement bound to this call's nonce and amount.
import { atomic, defineProvider, object, providerJson, text, unpack } from '../dist/index.js';

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\..*|10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*|169\.254\..*|0\.0\.0\.0|\[.*\])$/i;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'provider';

/** Known-good public endpoints, listed in the CDP x402 directory. Pinned payout addresses are read live from each 402, never hard-coded. */
export const TEMPLATES = [
  { id: 'ping-402rates', label: '402rates ping (0.001 USDC)', url: 'https://api.402rates.com/v1/ping', note: 'Cheapest smoke test: a paid ping.' },
  { id: 'crypto-news-otto', label: 'OttoAI crypto news (0.001 USDC)', url: 'https://x402.ottoai.services/crypto-news', note: 'Latest crypto headlines.' },
  { id: 'crypto-price-apitoll', label: 'APIToll crypto price (0.001 USDC)', url: 'https://crypto.apitoll.cloud/v1/crypto/price?symbol=BTC', note: 'Spot price; change the symbol parameter.' },
  { id: 'block-number-onesource', label: 'OneSource Base block number (0.001 USDC)', url: 'https://api.onesource.io/api/chain/block-number', note: 'On-chain read; authorization window is 1 hour.' },
  { id: 'candles-hyperextend', label: 'Hyperextend BTC 1m candle (0.002 USDC)', url: 'https://api.hyperextend.xyz/v1/candles/BTC/1m/latest', note: 'Latest 1-minute candle.' },
  { id: 'random-fact', label: 'Random fact (0.01 USDC)', url: 'https://randomfactsx402.vercel.app/api/random-fact', note: 'Toy endpoint.' },
  { id: 'ichimoku-fizzl', label: 'Ichimoku BTC-USDT signal (0.02 USDC)', url: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', note: 'Same operator as Doctor.' },
];

export async function discoverProvider(url, fetchImpl = fetch, { network = 'eip155:8453' } = {}) {
  const u = new URL(text(url));
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || PRIVATE_HOST.test(u.hostname)) throw new Error('Discovery needs a public HTTPS URL');
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
  let r;
  try { r = await fetchImpl(u.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: ctrl.signal, headers: { 'user-agent': 'alsp-interop/001', accept: 'application/json' } }); }
  finally { clearTimeout(timer); }
  if (r.status !== 402) throw new Error(`Expected HTTP 402 from the resource, got ${r.status}`);
  const header = r.headers.get('payment-required');
  const raw = await r.text();
  const challenge = object(header ? unpack(header) : JSON.parse(raw));
  if (challenge.x402Version !== 2) throw new Error('Only x402 v2 challenges are supported');
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
  const seen = accepts.map(a => { try { const o = object(a); return `${o.scheme}@${o.network}`; } catch { return 'invalid'; } });
  const options = [];
  for (const entry of accepts) {
    try {
      const a = object(entry), extra = object(a.extra);
      if (a.scheme !== 'exact' || a.network !== network || typeof extra.name !== 'string' || typeof extra.version !== 'string') continue;
      if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009') continue;
      options.push({ amount: atomic(a.amount).toString(), asset: text(a.asset), payTo: text(a.payTo), maxTimeoutSeconds: Number(a.maxTimeoutSeconds), extra });
    } catch { /* unsupported option */ }
  }
  options.sort((x, y) => (BigInt(x.amount) < BigInt(y.amount) ? -1 : 1));
  const best = options[0];
  if (!best) throw new Error(`No exact EIP-3009 option on ${network}; offered: ${[...new Set(seen)].join(', ') || 'none'}`);
  const resource = challenge.resource && typeof challenge.resource === 'object' ? object(challenge.resource) : {};
  const profile = defineProvider({ id: slug(`${u.hostname}${u.pathname}`), label: `${u.hostname}${u.pathname}`, origin: u.origin, endpointPath: u.pathname, method: 'GET', network,
    asset: { address: best.asset, name: best.extra.name, version: best.extra.version }, payTo: best.payTo, receipt: { mode: 'unsigned' } });
  return { profile: providerJson(profile), input: Object.fromEntries(u.searchParams), quote: { amount: best.amount, maxTimeoutSeconds: best.maxTimeoutSeconds, description: typeof resource.description === 'string' ? resource.description : null, resourceUrl: typeof resource.url === 'string' ? resource.url : null }, offered: [...new Set(seen)] };
}
