// MAINNET buyer: spends REAL XRP. Safe by default: without --yes-spend-real-xrp it only inspects the 402 challenge.
// Usage:
//   node scripts/xrpl-mainnet-buyer.mjs [url]                                  # dry run, no wallet needed
//   XRPL_BUYER_SEED=... node scripts/xrpl-mainnet-buyer.mjs [url] --yes-spend-real-xrp [--max-drops 20000]
// The seed is read only from the environment and is never printed.
import { Wallet } from 'xrpl';
import { createHash } from 'node:crypto';
import { access, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Stable JSON form for comparing replay responses independent of object key order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Submit the one already-signed payment until the merchant confirms settlement.
 * Every retry reuses the same header, so it cannot create a second signed payment.
 * A pending result or an inconsistent idempotency replay is a failure, never success.
 */
export async function submitPaymentUntilSettled({
  fetchImpl = fetch,
  url,
  header,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxAttempts = 8,
  retryDelayMs = 5000,
  onAttempt = () => {},
}) {
  let lastPendingBody;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let paid;
    let body;
    try {
      paid = await fetchImpl(url, { headers: { 'payment-signature': header } });
      body = await paid.json();
    } catch (error) {
      throw new Error(`Payment outcome is uncertain while awaiting settlement (attempt ${attempt}/${maxAttempts}): ${error?.message ?? error}. Do not create or submit a new payment; check the existing transaction before retrying.`);
    }
    onAttempt({ attempt, status: paid.status, body });

    if (paid.status === 200) {
      let replay;
      let replayBody;
      try {
        replay = await fetchImpl(url, { headers: { 'payment-signature': header } });
        replayBody = await replay.json();
      } catch (error) {
        throw new Error(`Payment was accepted, but the idempotency replay could not be verified: ${error?.message ?? error}. Do not submit a new payment; inspect the existing transaction and merchant record.`);
      }
      if (replay.status !== 200 || canonicalJson(replayBody) !== canonicalJson(body)) {
        throw new Error(`Payment was accepted, but the idempotency replay differed (first HTTP 200, replay HTTP ${replay.status}). Settlement response consistency is unverified. Do not submit a new payment; inspect the existing transaction and merchant record.`);
      }
      return body;
    }

    if (paid.status !== 202) {
      throw new Error(`Payment settlement was not confirmed (HTTP ${paid.status}). Do not create or submit a new payment; check the existing transaction and merchant state before retrying.`);
    }
    lastPendingBody = body;
    if (attempt < maxAttempts) await sleepImpl(retryDelayMs);
  }

  const pendingDetail = lastPendingBody === undefined ? '' : ` Last pending response: ${JSON.stringify(lastPendingBody)}.`;
  throw new Error(`Settlement remains unconfirmed after ${maxAttempts} HTTP 202 responses.${pendingDetail} The payment may still settle. Do not create or submit a new payment; check the signed transaction hash and merchant state before taking further action.`);
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => a.startsWith('http')) ?? 'https://alsp.vercel.app/api/xrpl/paid-resource';
  const spend = args.includes('--yes-spend-real-xrp');
  const maxIdx = args.indexOf('--max-drops');
  const maxDrops = BigInt(maxIdx >= 0 ? args[maxIdx + 1] : '20000');
  const pendingFile = path.resolve(process.cwd(), '.xrpl-mainnet-buyer.pending.json');
  const EXPECTED_PAYEE = 'rMRaxFZnyNHmqfafLbAdGbi9cHi24UhiaG';
  const RPC = process.env.XRPL_MAINNET_RPC_URL || 'https://xrplcluster.com/';
  const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) })).json()).result;
  const xrp = d => (Number(d) / 1e6).toFixed(6) + ' XRP';

  if (spend) {
    try {
      await access(pendingFile);
      throw new Error(`A prior mainnet payment has an unresolved outcome (${pendingFile}). Do not pay again. Verify its recorded transaction with XRPL and the merchant before removing this guard file.`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const r402 = await fetch(url);
  console.log('challenge status', r402.status);
  const challenge = await r402.json();
  if (r402.status !== 402) { console.log(JSON.stringify(challenge)); throw new Error('Expected HTTP 402 challenge'); }
  const req = challenge.accepts[0];
  console.log('network', req.network, '| amount', req.amount, 'drops =', xrp(req.amount), '| payTo', req.payTo);
  console.log('notice:', /NOTICE/.test(challenge.error) ? challenge.error : '(none)');
  if (req.network !== 'xrpl:0') throw new Error('Refusing: not mainnet');
  if (req.payTo !== EXPECTED_PAYEE) throw new Error('Refusing: unexpected payee ' + req.payTo);
  if (BigInt(req.amount) > maxDrops) throw new Error(`Refusing: ${req.amount} drops exceeds --max-drops ${maxDrops}`);
  if (!spend) { console.log('\nDry run only. Re-run with --yes-spend-real-xrp and XRPL_BUYER_SEED to pay ' + xrp(req.amount) + ' plus a ~0.000012 XRP network fee.'); return; }

  const seed = process.env.XRPL_BUYER_SEED;
  if (!seed) throw new Error('Set XRPL_BUYER_SEED in the environment (never paste it into chat or commit it)');
  const wallet = Wallet.fromSeed(seed);
  if (wallet.address === EXPECTED_PAYEE) throw new Error('Refusing: buyer and payee are the same account');
  const info = await rpc('account_info', { account: wallet.address, ledger_index: 'validated' });
  if (!info.account_data) throw new Error('Buyer account is not activated on mainnet');
  console.log('buyer', wallet.address, 'balance', xrp(info.account_data.Balance));
  const ledger = await rpc('ledger', { ledger_index: 'validated' });
  const { tx_blob, hash } = wallet.sign({
    TransactionType: 'Payment', Account: wallet.address, Destination: req.payTo, Amount: req.amount, Fee: '12',
    Sequence: info.account_data.Sequence, LastLedgerSequence: Number(ledger.ledger_index) + 60,
    SourceTag: req.extra.sourceTag, InvoiceID: createHash('sha256').update(req.extra.invoiceId, 'utf8').digest('hex').toUpperCase(),
  });
  console.log('prepared transaction', hash);
  const pendingRecord = {
    url,
    buyer: wallet.address,
    invoiceId: req.extra.invoiceId,
    transactionHash: hash,
    createdAt: new Date().toISOString(),
  };
  try {
    await writeFile(pendingFile, JSON.stringify(pendingRecord, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Another or prior mainnet payment is unresolved (${pendingFile}). Do not pay again. Verify its recorded transaction with XRPL and the merchant before removing this guard file.`);
    }
    throw new Error(`Could not create the pending-payment guard (${pendingFile}); no payment request was sent: ${error?.message ?? error}`);
  }
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req, payload: { signedTxBlob: tx_blob, invoiceId: req.extra.invoiceId } })).toString('base64');
  const body = await submitPaymentUntilSettled({
    url,
    header,
    onAttempt: ({ attempt, status, body: attemptBody }) => {
      console.log('attempt', attempt, 'status', status);
      console.log(JSON.stringify(attemptBody, null, 2));
    },
  });
  try {
    await unlink(pendingFile);
  } catch (error) {
    throw new Error(`Settlement was confirmed, but the pending-payment guard could not be removed (${pendingFile}): ${error?.message ?? error}. Verify the transaction before removing the guard manually.`);
  }
  console.log(JSON.stringify(body, null, 2));
  console.log('settlement confirmed; explorer: https://xrpscan.com/tx/' + hash);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
