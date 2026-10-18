// MAINNET buyer: spends REAL XRP. Safe by default: without --yes-spend-real-xrp it only inspects the 402 challenge.
// Usage:
//   node scripts/xrpl-mainnet-buyer.mjs [url]                                  # dry run, no wallet needed
//   XRPL_BUYER_SEED=... node scripts/xrpl-mainnet-buyer.mjs [url] --yes-spend-real-xrp [--max-drops 20000]
// The seed is read only from the environment and is never printed.
import { Wallet } from 'xrpl';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('http')) ?? 'https://alsp.vercel.app/api/xrpl/paid-resource';
const spend = args.includes('--yes-spend-real-xrp');
const maxIdx = args.indexOf('--max-drops');
const maxDrops = BigInt(maxIdx >= 0 ? args[maxIdx + 1] : '20000');
const EXPECTED_PAYEE = 'rMRaxFZnyNHmqfafLbAdGbi9cHi24UhiaG';
const RPC = process.env.XRPL_MAINNET_RPC_URL || 'https://xrplcluster.com/';
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) })).json()).result;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xrp = d => (Number(d) / 1e6).toFixed(6) + ' XRP';

const r402 = await fetch(url);
console.log('challenge status', r402.status);
const challenge = await r402.json();
if (r402.status !== 402) { console.log(JSON.stringify(challenge)); process.exit(1); }
const req = challenge.accepts[0];
console.log('network', req.network, '| amount', req.amount, 'drops =', xrp(req.amount), '| payTo', req.payTo);
console.log('notice:', /NOTICE/.test(challenge.error) ? challenge.error : '(none)');
if (req.network !== 'xrpl:0') throw new Error('Refusing: not mainnet');
if (req.payTo !== EXPECTED_PAYEE) throw new Error('Refusing: unexpected payee ' + req.payTo);
if (BigInt(req.amount) > maxDrops) throw new Error(`Refusing: ${req.amount} drops exceeds --max-drops ${maxDrops}`);
if (!spend) { console.log('\nDry run only. Re-run with --yes-spend-real-xrp and XRPL_BUYER_SEED to pay ' + xrp(req.amount) + ' plus a ~0.000012 XRP network fee.'); process.exit(0); }

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
console.log('paying', xrp(req.amount), 'tx', hash);
const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req, payload: { signedTxBlob: tx_blob, invoiceId: req.extra.invoiceId } })).toString('base64');
for (let i = 0; i < 8; i++) {
  const paid = await fetch(url, { headers: { 'payment-signature': header } });
  const body = await paid.json();
  console.log('attempt', i + 1, 'status', paid.status);
  console.log(JSON.stringify(body, null, 2));
  if (paid.status === 200) {
    const again = await fetch(url, { headers: { 'payment-signature': header } });
    console.log('resubmit status', again.status, 'identical body', JSON.stringify(await again.json()) === JSON.stringify(body));
    console.log('explorer: https://xrpscan.com/tx/' + hash);
    break;
  }
  if (paid.status !== 202) { process.exitCode = 1; break; }
  await sleep(5000);
}
