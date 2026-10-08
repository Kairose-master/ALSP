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
export function createSimWorld({ price = '1000', loseResponseOnCall = 2, latency = 1 } = {}) {
  const world = { price, paid: 0, responses: new Map(), block: 0, loseResponseOnCall };
  const quote = () => ({ x402Version: 2, resource: { url: SIM.ENDPOINT }, accepted: { scheme: 'exact', network: SIM.NETWORK, asset: SIM.ASSET, payTo: SIM.PAY_TO, amount: world.price, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } } });
  const api = {
    probe: async () => { await sleep(150 * latency); return { quote: quote() }; },
    send: async (_p, _t, input, prepared, nonce) => {
      await sleep(300 * latency);
      world.paid++; world.block++;
      const symbol = String(input.symbol ?? input.q ?? 'BTC-USDT').toUpperCase();
      const body = { symbol, price: priceOf(symbol), currency: 'USD', source: 'sim-oracle', quotedAt: new Date().toISOString(), receipt: { request_id: `req_${nonce.slice(2, 10)}`, route: simProvider.receipt.route, signer: SIM.SIGNER, payment: { proof: 'eip3009', amount: prepared.authorization.value, nonce } } };
      const wire = { status: 200, body, settlement: { success: true, network: SIM.NETWORK, transaction: fakeHex(32), payer: SIM.PAYER } };
      world.responses.set(nonce, { wire, block: world.block });
      if (world.paid === world.loseResponseOnCall) throw new Error('socket hang up after the provider settled');
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
  return { world, api, wallet, provider: simProvider, pins: [{ address: SIM.SIGNER }] };
}
export const memoryStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
