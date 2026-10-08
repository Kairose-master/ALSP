// In-process x402 v2 `exact` provider plus a tiny mock EVM ledger.
// It answers through a fetch-compatible function, so the real ALSP client code runs against it
// without a network, inside a test, a local server or a serverless function.
import { keccak256, toHex, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AUTHORIZATION_TYPES, canonical, chainIdOf, defineProvider, digest, genericInput, pack, unpack } from '../dist/index.js';

// Public throwaway demo keys. These accounts MUST NEVER be funded on any real chain.
export const DEMO_PAYTO_KEY = `0x${'51'.repeat(32)}`;
export const DEMO_SIGNER_KEY = `0x${'52'.repeat(32)}`;
export const DEMO_STRANGER_KEY = `0x${'53'.repeat(32)}`;
export const DEMO_ASSET = '0x0000000000000000000000000000000000031337';

const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
const USED = keccak256(toHex('AuthorizationUsed(address,bytes32)'));
const topic = a => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const FAULTS = {
  'none': 'Normal paid call',
  'lost-response': 'Provider settles, but the response never reaches the client (timeout after payment)',
  'rpc-down': 'Response arrives, but the ledger RPC is unavailable during verification',
  'bad-receipt': 'Provider signs the receipt with an unpinned key (must fail closed)',
  'overprice': 'Provider quotes above the per-call cap (must be refused before any signature)',
};

/** Creates a fresh provider + ledger. `price` is the atomic amount per call. */
export function createMockProvider({ origin = 'https://oracle.alsp.local', price = '1000', network = 'eip155:31337', receiptMode = 'signed' } = {}) {
  const payTo = privateKeyToAccount(DEMO_PAYTO_KEY), signer = privateKeyToAccount(DEMO_SIGNER_KEY), stranger = privateKeyToAccount(DEMO_STRANGER_KEY);
  const profile = defineProvider({
    id: 'demo-oracle', label: 'Demo price oracle (mock ledger)', origin, endpointPath: '/api/v1/quote', method: 'GET', signerPath: '/.well-known/x402-signer.json',
    network, asset: { address: DEMO_ASSET, name: 'USD Coin', version: '2' }, payTo: payTo.address,
    receipt: receiptMode === 'unsigned' ? { mode: 'unsigned' } : { route: 'GET /api/v1/quote', service: 'alsp-demo-oracle', certHeader: 'alsp demo receipt signer' },
  });
  const chainId = chainIdOf(network);
  const state = { fault: 'none', nonces: new Set(), blocks: [], responses: new Map(), paid: 0, rpcCalls: 0 };
  const endpoint = `${origin}/api/v1/quote`;
  const challengeFor = (resourceUrl, amount) => ({ x402Version: 2, resource: { url: resourceUrl, description: 'Demo spot price quote' }, accepts: [{ scheme: 'exact', network, asset: DEMO_ASSET, payTo: payTo.address, amount, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } }] });

  async function quote(url, init) {
    const u = new URL(url), input = genericInput(Object.fromEntries(u.searchParams));
    const headers = new Headers(init?.headers);
    const amount = state.fault === 'overprice' ? (BigInt(price) * 10n).toString() : price;
    const challenge = challengeFor(u.href, amount);
    const sig = headers.get('payment-signature');
    if (!sig) return json(402, challenge, { 'payment-required': pack(challenge) });
    // Paid request: validate the EIP-3009 authorization exactly like a facilitator would.
    const payload = unpack(sig), a = payload?.payload?.authorization, signature = payload?.payload?.signature;
    if (!a || typeof signature !== 'string') return json(400, { error: 'malformed payment' });
    const ok = await verifyTypedData({ address: a.from, domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: DEMO_ASSET }, types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', signature,
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });
    const nowSec = Math.floor(Date.now() / 1000);
    if (!ok || a.to.toLowerCase() !== payTo.address.toLowerCase() || a.value !== amount || BigInt(a.validBefore) <= BigInt(nowSec)) return json(402, { error: 'payment rejected' }, { 'payment-required': pack(challenge) });
    if (state.nonces.has(a.nonce.toLowerCase())) return json(409, { error: 'authorization already used' });
    // Settle on the mock ledger.
    state.nonces.add(a.nonce.toLowerCase()); state.paid++;
    const tx = keccak256(toHex(`settle:${a.nonce}`)), number = state.blocks.length + 1, hash = keccak256(toHex(`block:${number}`));
    state.blocks.push({ number, hash, receipt: { status: '0x1', transactionHash: tx, blockNumber: `0x${number.toString(16)}`, blockHash: hash, logs: [
      { address: DEMO_ASSET, topics: [USED, topic(a.from), a.nonce.toLowerCase()], data: '0x' },
      { address: DEMO_ASSET, topics: [TRANSFER, topic(a.from), topic(payTo.address)], data: `0x${BigInt(a.value).toString(16).padStart(64, '0')}` },
    ] } });
    // Build and sign the receipt (Doctor's eip191-canonical-json-v1 format, generic body).
    const symbol = (input.symbol ?? 'BTC-USDT').toUpperCase();
    const body = { symbol, price: syntheticPrice(symbol), currency: 'USD', source: 'alsp-demo-oracle', quotedAt: new Date().toISOString(),
      receipt: { request_id: `req_${tx.slice(2, 18)}`, route: 'GET /api/v1/quote', input_sha256: digest({ route: 'GET /api/v1/quote', input }), signed_at: new Date().toISOString(), signer: signer.address, algorithm: 'eip191-canonical-json-v1',
        payment: { proof: 'eip3009', network, asset: DEMO_ASSET, pay_to: payTo.address, payer: a.from, amount: a.value, nonce: a.nonce } } };
    const key = state.fault === 'bad-receipt' ? stranger : signer;
    if (key === stranger) body.receipt.signer = stranger.address;
    if (receiptMode === 'unsigned') delete body.receipt; else body.receipt.signature = await key.signMessage({ message: canonical(body) });
    const settlement = { success: true, network, transaction: tx, payer: a.from };
    state.responses.set(a.nonce.toLowerCase(), { status: 200, body, settlement });
    if (state.fault === 'lost-response') throw new Error('socket hang up after settlement');
    return json(200, body, { 'payment-response': pack(settlement) });
  }
  async function rpc(body) {
    state.rpcCalls++;
    if (state.fault === 'rpc-down') return new Response('upstream unavailable', { status: 503 });
    const { id, method, params } = JSON.parse(body);
    const head = state.blocks.length + 1; // one extra block on top of the latest settlement => 2 confirmations
    const result = {
      eth_chainId: () => `0x${chainId.toString(16)}`,
      eth_blockNumber: () => `0x${head.toString(16)}`,
      eth_call: () => `0x${(state.balance ?? 4000n).toString(16).padStart(64, '0')}`,
      eth_getTransactionReceipt: () => state.blocks.find(b => b.receipt.transactionHash === String(params[0]).toLowerCase())?.receipt ?? null,
      eth_getBlockByNumber: () => { const n = Number(params[0]), hash = n === head ? keccak256(toHex(`block:${head}`)) : state.blocks.find(b => b.number === n)?.hash; return hash ? { number: params[0], hash } : null; },
    }[method];
    if (!result) return json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported' } });
    return json(200, { jsonrpc: '2.0', id, result: result() });
  }
  /** fetch-compatible entry point for both the paid API and the mock JSON-RPC. */
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    if (u.origin !== origin) return new Response('not found', { status: 404 });
    if (u.pathname === '/api/v1/quote') return quote(url, init);
    if (u.pathname === '/.well-known/x402-signer.json') return json(200, { service: 'alsp-demo-oracle', signer: signer.address, authority: payTo.address, note: 'Demo signer. Pin this address independently before paying.' });
    if (u.pathname === '/rpc' && init.method === 'POST') return rpc(init.body);
    return new Response('not found', { status: 404 });
  }
  return {
    profile, fetchImpl, state, endpoint, rpcUrl: `${origin}/rpc`,
    signer: signer.address, stranger: stranger.address, payTo: payTo.address,
    setFault(f) { if (!(f in FAULTS)) throw new Error(`Unknown fault ${f}`); state.fault = f; },
    /** Simulates the provider's "look up my original response" support used during reconciliation. */
    recover(nonce) { return state.responses.get(String(nonce).toLowerCase()) ?? null; },
  };
}
function syntheticPrice(symbol) {
  let h = 0; for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((h % 90000) + 10000) / 100; // deterministic pseudo price between 100.00 and 999.99
}
