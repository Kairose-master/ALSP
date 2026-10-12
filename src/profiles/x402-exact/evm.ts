import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { address, atomic, canonical, chainIdOf, digest, hash32, object, text, validateAgreementQuote, type LedgerEvidence, type Prepared, type Quote, type Terms } from './protocol.js';
import type { Call } from './journal.js';

export const AUTHORIZATION_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const;
/** EIP-3009 signer. The EIP-712 domain name/version come from the quote's `extra`, the chain from the terms' network. */
export function evmSigner(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signManifest: (message: string) => account.signMessage({ message }),
    async prepare(quote: Quote, terms: Terms, nonce: string, now: number): Promise<Prepared> {
      if (address(account.address) !== address(terms.payer)) throw new Error('Wrong payer key');
      const seconds = Math.floor(now / 1000);
      const authorization = { from: account.address, to: quote.accepted.payTo, value: quote.accepted.amount, nonce,
        validAfter: String(Math.max(0, seconds - 5)), validBefore: String(Math.min(seconds + quote.accepted.maxTimeoutSeconds, Math.floor(terms.expiresAt / 1000))) };
      const signature = await account.signTypedData({
        domain: { name: String(quote.accepted.extra.name), version: String(quote.accepted.extra.version), chainId: chainIdOf(terms.network), verifyingContract: terms.asset as `0x${string}` },
        primaryType: 'TransferWithAuthorization', types: AUTHORIZATION_TYPES,
        message: { from: account.address, to: authorization.to as `0x${string}`, value: atomic(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: nonce as `0x${string}` },
      });
      return { quote, authorization, signature };
    },
  };
}
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
const USED = keccak256(toHex('AuthorizationUsed(address,bytes32)'));
const topicAddress = (a: string): string => `0x${address(a).slice(2).padStart(64, '0')}`;
function hexInt(v: unknown): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error('Invalid RPC integer');
  return BigInt(v);
}
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const LOOPBACK = /^(localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\])$/;
/** Read-only JSON-RPC client. HTTPS is required except for loopback hosts (local demo chains). */
export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  const u = new URL(url);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname))) || u.username || u.password || u.hash) throw new Error('RPC must be explicitly configured HTTPS (HTTP only on loopback)');
  let id = 0;
  return async (method, params) => {
    if (!['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_call'].includes(method)) throw new Error('Read-only RPC method required');
    const requestId = ++id, ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      if (!r.ok) throw new Error('RPC HTTP failure');
      const chunks: Uint8Array[] = []; let size = 0; const reader = r.body?.getReader();
      if (!reader) throw new Error('No RPC body');
      try {
        while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error('RPC response too large'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      const response = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (response.id !== requestId || response.jsonrpc !== '2.0' || response.error || !('result' in response)) throw new Error('Invalid RPC response');
      return response.result;
    } finally { clearTimeout(timer); ctrl.abort(); }
  };
}
/** Backward-compatible Base mainnet RPC factory. */
export const baseRpc = (url = 'https://mainnet.base.org', fetchImpl: typeof fetch = fetch): Rpc => jsonRpc(url, fetchImpl);
/** Checks trusted RPC evidence separately from the server's signed receipt. The expected chain comes from the terms' network. */
export async function verifySettlement(call: Call, terms: Terms, rpc: Rpc, minConfirmations = 2): Promise<LedgerEvidence> {
  if (!call.wire || !call.prepared) throw new Error('Missing payment evidence');
  const settlement = object(call.wire.settlement);
  if (settlement.success !== true || settlement.network !== terms.network || (settlement.payer !== undefined && address(settlement.payer) !== address(terms.payer))) throw new Error('No successful settlement response');
  return verifySettlementTransaction(call, terms, hash32(settlement.transaction), rpc, minConfirmations);
}
/**
 * Independently locate settlement without a provider response. Returns ledger evidence only:
 * this does not prove delivery and does not reconcile or close a native session.
 */
export async function verifySettlementTransaction(call: Call, terms: Terms, transaction: string, rpc: Rpc, minConfirmations = 2): Promise<LedgerEvidence> {
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 100) throw new Error('Invalid confirmations');
  if (!call.prepared) throw new Error('Missing prepared payment evidence');
  // Snapshot only the binding fields. In particular, a WireResponse is neither required nor read.
  const bound = JSON.parse(canonical({ quote: call.quote, prepared: call.prepared, amount: call.amount, nonce: call.nonce, createdAt: call.createdAt })) as Pick<Call, 'quote' | 'prepared' | 'amount' | 'nonce' | 'createdAt'>;
  terms = JSON.parse(canonical(terms)) as Terms;
  const q = bound.quote, prepared = bound.prepared!, a = prepared.authorization, nonce = hash32(bound.nonce), amount = atomic(bound.amount);
  const endpoint = new URL(terms.endpoint), resource = new URL(text(q.resource.url));
  if (resource.origin !== endpoint.origin || resource.pathname !== endpoint.pathname || resource.username || resource.password || resource.hash) throw new Error('Persisted quote endpoint binding mismatch');
  if (q.x402Version !== 2 || q.accepted.scheme !== 'exact' || q.accepted.network !== terms.network || address(q.accepted.asset) !== address(terms.asset) || address(q.accepted.payTo) !== address(terms.provider) || atomic(q.accepted.amount) !== amount || amount <= 0n || amount > atomic(terms.maxPerCall) || amount > atomic(terms.maxTotal)) throw new Error('Persisted quote payment binding mismatch');
  validateAgreementQuote(q, terms);
  if (digest(prepared.quote) !== digest(q) || address(a.from) !== address(terms.payer) || address(a.to) !== address(terms.provider) || atomic(a.value) !== amount || hash32(a.nonce) !== nonce) throw new Error('Persisted prepared payment binding mismatch');
  const after = atomic(a.validAfter), before = atomic(a.validBefore);
  if (!Number.isSafeInteger(bound.createdAt) || !Number.isSafeInteger(terms.expiresAt) || after >= before || before <= BigInt(Math.floor(bound.createdAt / 1000)) || before * 1000n > BigInt(terms.expiresAt)) throw new Error('Invalid persisted authorization lifetime');
  if (!/^0x[a-fA-F0-9]{130}$/.test(prepared.signature)) throw new Error('Invalid persisted payment signature');
  const tx = hash32(transaction);
  if (hexInt(await rpc('eth_chainId', [])) !== BigInt(chainIdOf(terms.network))) throw new Error('RPC chain does not match the session network');
  const receipt = object(await rpc('eth_getTransactionReceipt', [tx]));
  if (receipt.status !== '0x1' || hash32(receipt.transactionHash) !== tx || !Array.isArray(receipt.logs)) throw new Error('Transaction not successful');
  const block = hexInt(receipt.blockNumber), blockHash = hash32(receipt.blockHash);
  const latest = hexInt(await rpc('eth_blockNumber', []));
  if (latest < block || latest - block + 1n < BigInt(minConfirmations)) throw new Error('Insufficient confirmations');
  const canonicalBlock = object(await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]));
  if (hash32(canonicalBlock.hash) !== blockHash) throw new Error('Non-canonical receipt block');
  let nonceFound = false, transferFound = false;
  for (const value of receipt.logs) {
    const log = object(value);
    if (address(log.address) !== address(terms.asset) || log.removed === true || !Array.isArray(log.topics)) continue;
    const topics = log.topics.map(hash32);
    if (topics[0] === USED && topics.length === 3 && topics[1] === topicAddress(terms.payer) && topics[2] === nonce) nonceFound = true;
    if (topics[0] === TRANSFER && topics.length === 3 && topics[1] === topicAddress(terms.payer) && topics[2] === topicAddress(terms.provider) && hexInt(log.data) === amount) transferFound = true;
  }
  if (!nonceFound || !transferFound) throw new Error('Missing bound USDC authorization/transfer logs');
  return { transaction: tx, blockHash, blockNumber: block.toString(), confirmations: Number(latest - block + 1n), verification: 'rpc-confirmed' };
}
/** Backward-compatible alias; the chain is taken from the terms' network. */
export const verifyBaseSettlement = verifySettlement;
