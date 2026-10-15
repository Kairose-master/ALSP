/**
 * Read-only XRPL JSON-RPC transaction evidence reader.
 * Only testnet endpoint is enabled; no transaction submission.
 * A validated ledger response is necessary, not sufficient, for ALSP settlement.
 */
import { verifyXrplSettlement, type XrplLedgerEvidence, type XrplPaymentBinding } from './xrpl-evidence.js';

export const XRPL_TESTNET_RPC = 'https://s.altnet.rippletest.net:51234/';
const HASH = /^[0-9A-Fa-f]{64}$/;

export function normalizeXrplTransaction(raw: unknown): XrplLedgerEvidence {
  if (!raw || typeof raw !== 'object') throw new Error('Missing XRPL transaction');
  const r = raw as Record<string, unknown>;
  const tx = (r.tx_json && typeof r.tx_json === 'object' ? r.tx_json : r) as Record<string, unknown>;
  const meta = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as Record<string, unknown>;
  const delivered = meta.delivered_amount;
  let deliveredAmount: XrplLedgerEvidence['deliveredAmount'];
  if (typeof delivered === 'string' && /^[0-9]+$/.test(delivered)) {
    const drops = BigInt(delivered);
    deliveredAmount = { currency: 'XRP', value: (drops / 1000000n).toString() + '.' + (drops % 1000000n).toString().padStart(6, '0') };
  } else if (delivered && typeof delivered === 'object') {
    const a = delivered as Record<string, unknown>;
    if (typeof a.currency !== 'string' || typeof a.value !== 'string' || typeof a.issuer !== 'string') throw new Error('Invalid issued amount');
    deliveredAmount = { currency: a.currency, value: a.value, issuer: a.issuer };
  } else throw new Error('Missing delivered amount');
  if (typeof tx.InvoiceID !== 'string' || typeof tx.Destination !== 'string' || typeof r.hash !== 'string' || !HASH.test(r.hash))
    throw new Error('Missing transaction binding');
  return {
    validated: r.validated === true,
    transactionType: String(tx.TransactionType ?? ''),
    result: String(meta.TransactionResult ?? ''),
    hash: r.hash.toUpperCase(),
    ledgerIndex: Number(r.ledger_index),
    invoiceId: tx.InvoiceID.toUpperCase(),
    destination: tx.Destination,
    deliveredAmount,
  };
}

export async function fetchVerifiedXrplPayment(
  transactionHash: string,
  binding: XrplPaymentBinding,
  fetchImpl: typeof fetch = fetch,
): Promise<XrplLedgerEvidence> {
  if (binding.network !== 'xrpl:1') throw new Error('Only XRPL testnet is enabled');
  if (!HASH.test(transactionHash)) throw new Error('Invalid transaction hash');
  const response = await fetchImpl(XRPL_TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ method: 'tx', params: [{ transaction: transactionHash, binary: false }] }),
    signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  if (!response.ok) throw new Error('XRPL RPC HTTP failure');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object') throw new Error('Malformed XRPL RPC response');
  const envelope = body as Record<string, unknown>;
  const result = envelope.result;
  if (!result || typeof result !== 'object') throw new Error('Missing XRPL RPC result');
  const r = result as Record<string, unknown>;
  if (r.status !== 'success' || r.error) throw new Error('XRPL RPC transaction not found');
  const evidence = normalizeXrplTransaction(r);
  if (evidence.hash !== transactionHash.toUpperCase() || !verifyXrplSettlement(binding, evidence))
    throw new Error('XRPL settlement evidence mismatch');
  return evidence;
}
