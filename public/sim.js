// In-page simulated x402 provider, wallet and ledger for sandbox runs.
// Nothing here touches a network, a key or a chain. The journal and session client that
// run against it are the real browser implementation (alsp-browser.js).
import { digest } from './alsp-browser.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fakeHex = n => `0x${Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('')}`;
export const SIM = {
  PAY_TO: '0x5eed000000000000000000000000000000000001', ASSET: '0x0000000000000000000000000000000000031337', SIGNER: '0x5eed000000000000000000000000000000000002',
  PAYER: '0xb0b0000000000000000000000000000000000001', NETWORK: 'eip155:31337', ENDPOINT: 'https://oracle.example/api/v1/quote',
};
export const simProvider = { id: 'sim-oracle', label: 'Simulated price oracle (sandbox)', origin: 'https://oracle.example', endpointPath: '/api/v1/quote', method: 'GET', network: SIM.NETWORK, asset: { address: SIM.ASSET, name: 'USD Coin', version: '2' }, payTo: SIM.PAY_TO, receipt: { route: 'GET /api/v1/quote', service: 'sim-oracle', certHeader: 'sim' } };

function priceOf(symbol) { let h = 0; for (const ch of String(symbol)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return ((h % 90000) + 10000) / 100; }

/** `loseResponseOnCall`: 1-based index of the paid call whose response is dropped after settlement (0 = never). */
export function createSimWorld({ price = '1000', loseResponseOnCall = 2, latency = 1, kind = 'price', lossRate = 0, role = null } = {}) {
  const world = { price, paid: 0, responses: new Map(), block: 0, loseResponseOnCall, kind, lossRate, role };
  const endpoint = role ? `https://${role}.oracle.example/api/v1/quote` : SIM.ENDPOINT;
  const quote = () => ({ x402Version: 2, resource: { url: endpoint }, accepted: { scheme: 'exact', network: SIM.NETWORK, asset: SIM.ASSET, payTo: SIM.PAY_TO, amount: world.price, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } } });
  const api = {
    probe: async () => { await sleep(150 * latency); return { quote: quote() }; },
    send: async (_p, _t, input, prepared, nonce) => {
      await sleep(300 * latency);
      world.paid++; world.block++;
      const symbol = String(input.coins ?? input.symbol ?? input.q ?? 'BTC').toUpperCase(), at = input.at ? Number(input.at) : null;
      const base = priceOf(`${symbol}@${at ?? 'now'}`), quotedAt = new Date().toISOString();
      const data = world.kind === 'candle' ? { symbol, interval: '1m', open: base, high: +(base * 1.004).toFixed(2), low: +(base * 0.996).toFixed(2), close: +(base * 1.001).toFixed(2), volume: Math.round(base * 37), quotedAt }
        : world.kind === 'news' ? { headlines: [`${symbol} steadies as funding resets`, 'Stablecoin supply hits a new high', 'L2 fees fall after upgrade'].map((title, i) => ({ title, source: 'sim-wire', publishedAt: new Date(Date.now() - i * 3600000).toISOString() })), quotedAt }
        : { symbol, at, price: base, currency: 'USD', quotedAt };
      const body = { ...data, source: `sim-${world.kind}`, receipt: { request_id: `req_${nonce.slice(2, 10)}`, route: simProvider.receipt.route, signer: SIM.SIGNER, payment: { proof: 'eip3009', amount: prepared.authorization.value, nonce } } };
      const wire = { status: 200, body, settlement: { success: true, network: SIM.NETWORK, transaction: fakeHex(32), payer: SIM.PAYER } };
      world.responses.set(nonce, { wire, block: world.block });
      if (world.paid === world.loseResponseOnCall || (world.lossRate > 0 && Math.random() < world.lossRate)) throw new Error('socket hang up after the provider settled');
      return { wire };
    },
    verify: async (_p, _t, call) => {
      await sleep(200 * latency);
      const r = world.responses.get(call.nonce);
      if (!r) throw new Error('No settlement found for this nonce');
      return { verified: { receipt: { requestId: r.wire.body.receipt.request_id, signer: SIM.SIGNER, responseHash: await digest(r.wire.body), signedAt: new Date().toISOString() }, ledger: { transaction: r.wire.settlement.transaction, blockHash: fakeHex(32), blockNumber: String(r.block), confirmations: 2, verification: 'rpc-confirmed' }, semanticCorrectness: 'not-verified' } };
    },
    /** The provider's "look up my original response by nonce" endpoint. */
    recover: async nonce => { await sleep(150 * latency); return world.responses.get(nonce)?.wire ?? null; },
  };
  const wallet = { address: SIM.PAYER, async prepare(q, terms, nonce, now) { await sleep(250 * latency); const s = Math.floor(now / 1000); return { quote: q, authorization: { from: SIM.PAYER, to: q.accepted.payTo, value: q.accepted.amount, nonce, validAfter: String(s - 5), validBefore: String(s + 120) }, signature: fakeHex(65) }; }, async signMessage() { await sleep(200 * latency); return fakeHex(65); } };
  const provider = role ? { ...simProvider, id: `sim-${role}`, label: `Simulated ${role} provider (sandbox)`, origin: `https://${role}.oracle.example`, endpointPath: '/api/v1/quote' } : simProvider;
  return { world, api, wallet, provider, pins: [{ address: SIM.SIGNER }] };
}
export const memoryStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

/**
 * What a plain x402 client does for the same product: no terms, no cap, no journal, retry on error.
 * Runs against a fresh simulated world with the same price and the same lost response, so the
 * difference with the session run is only the protocol, not luck.
 */
export async function naiveRun({ inputs, price = '1000', loseResponseOnCall = 2, maxRetries = 2, latency = 0 } = {}) {
  const sim = createSimWorld({ price, loseResponseOnCall, latency });
  const rows = [];
  for (const input of inputs) {
    let response = null, attempts = 0, error = null;
    while (!response && attempts <= maxRetries) {
      attempts++;
      try {
        const { quote } = await sim.api.probe();
        const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}`;
        const prepared = await sim.wallet.prepare(quote, { expiresAt: Date.now() + 600000 }, nonce, Date.now());
        response = (await sim.api.send(null, null, input, prepared, nonce)).wire; // a timeout here looks like "not paid" to a naive client
      } catch (e) { error = e.message; }
    }
    rows.push({ input, attempts, got: Boolean(response), error: response ? null : error });
  }
  const paid = sim.world.paid;
  return { rows, payments: paid, spent: (BigInt(price) * BigInt(paid)).toString(), doublePaid: paid - rows.filter(r => r.got).length, evidence: 'none', cap: 'none' };
}
