// Testnet-only buyer for the XRPL x402 merchant. Throwaway wallet funded by the public testnet faucet.
// Usage: node scripts/xrpl-e2e-buyer.mjs <resource-url>   (XRPL_TESTNET_RPC_URL optional; seed is never printed)
import { Wallet } from 'xrpl';
import { createHash } from 'node:crypto';

const url = process.argv[2];
if (!url) throw new Error('usage: xrpl-e2e-buyer.mjs <resource-url>');
const RPC = process.env.XRPL_TESTNET_RPC_URL || 'https://s.altnet.rippletest.net:51234/';
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) })).json()).result;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const faucet = await (await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
const wallet = Wallet.fromSeed(faucet.seed);
console.log('buyer', wallet.address, 'funded', faucet.amount);
let info;
for (let i = 0; i < 20; i++) { info = await rpc('account_info', { account: wallet.address, ledger_index: 'validated' }); if (info.account_data) break; await sleep(3000); }
if (!info.account_data) throw new Error('buyer account not visible on validated ledger');

const r402 = await fetch(url);
console.log('unpaid status', r402.status);
const req = (await r402.json()).accepts[0];
if (req.network !== 'xrpl:1') throw new Error('refusing non-testnet requirement');
const ledger = await rpc('ledger', { ledger_index: 'validated' });
const { tx_blob, hash } = wallet.sign({
  TransactionType: 'Payment', Account: wallet.address, Destination: req.payTo, Amount: req.amount, Fee: '12',
  Sequence: info.account_data.Sequence, LastLedgerSequence: Number(ledger.ledger_index) + 60,
  SourceTag: req.extra.sourceTag, InvoiceID: createHash('sha256').update(req.extra.invoiceId, 'utf8').digest('hex').toUpperCase(),
});
console.log('signed tx', hash);
const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: req, payload: { signedTxBlob: tx_blob, invoiceId: req.extra.invoiceId } })).toString('base64');
for (let i = 0; i < 8; i++) {
  const paid = await fetch(url, { headers: { 'payment-signature': header } });
  const body = await paid.json();
  console.log('paid attempt', i + 1, 'status', paid.status);
  console.log(JSON.stringify(body, null, 2));
  if (paid.status === 200) {
    const again = await fetch(url, { headers: { 'payment-signature': header } });
    console.log('resubmit status', again.status, 'identical body', JSON.stringify(await again.json()) === JSON.stringify(body));
    break;
  }
  if (paid.status !== 202) { process.exitCode = 1; break; }
  await sleep(5000);
}
