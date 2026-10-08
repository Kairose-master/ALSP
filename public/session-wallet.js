// Disposable session wallet: a fresh EOA generated in this browser whose only funds are what you
// send it. It signs EIP-3009 payments and the buyer seal without prompts, so an agent can run a
// session autonomously; the amount you fund is the hard spend limit, and leftovers sweep back to
// your main wallet through another EIP-3009 authorization that your main wallet submits.
//
// Not ERC-4337: no smart account, bundler or paymaster is involved. x402 `exact` already pays gas
// through the facilitator, so an EOA with USDC and zero ETH is enough. The key lives in this
// browser's localStorage; treat it as cash in a pocket, not as a vault.
import { encodeFunctionData, generatePrivateKey, numberToHex, parseSignature, privateKeyToAccount } from './vendor/viem.js';
import { AUTHORIZATION_TYPES, chainIdOf, lower, randomNonce } from './alsp-browser.js';

const KEY = 'alsp:session-wallet:v1';
const ERC20 = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] },
];

/** Loads the stored session key or creates one. `storage` is injectable for tests. */
export function sessionWallet(storage = globalThis.localStorage) {
  let record = null;
  try { record = JSON.parse(storage.getItem(KEY) || 'null'); } catch { record = null; }
  if (!record || !/^0x[0-9a-fA-F]{64}$/.test(record.privateKey)) { record = { privateKey: generatePrivateKey(), createdAt: Date.now() }; storage.setItem(KEY, JSON.stringify(record)); }
  const account = privateKeyToAccount(record.privateKey);
  return {
    kind: 'session', address: account.address, createdAt: record.createdAt,
    async connect() { return account.address; },
    async ensureChain() {},
    /** EIP-3009 TransferWithAuthorization, same construction as the library's evmSigner. */
    async prepare(quote, terms, nonce, now = Date.now()) {
      if (lower(account.address) !== lower(terms.payer)) throw new Error('Session wallet is not the session payer');
      const seconds = Math.floor(now / 1000);
      const authorization = { from: account.address, to: quote.accepted.payTo, value: quote.accepted.amount, nonce, validAfter: String(Math.max(0, seconds - 5)), validBefore: String(Math.min(seconds + quote.accepted.maxTimeoutSeconds, Math.floor(terms.expiresAt / 1000))) };
      const signature = await account.signTypedData({ domain: { name: String(quote.accepted.extra.name), version: String(quote.accepted.extra.version), chainId: chainIdOf(terms.network), verifyingContract: terms.asset }, types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
        message: { from: account.address, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce } });
      return { quote, authorization, signature };
    },
    async signMessage(message) { return account.signMessage({ message }); },
    /** Signs an authorization that moves `value` atomic units from this wallet to `to`; anyone can submit it. */
    async sweepAuthorization({ to, value, chainId, asset, assetName = 'USD Coin', assetVersion = '2', ttlSeconds = 3600 }) {
      const seconds = Math.floor(Date.now() / 1000), nonce = randomNonce();
      const message = { from: account.address, to, value: BigInt(value), validAfter: BigInt(Math.max(0, seconds - 5)), validBefore: BigInt(seconds + ttlSeconds), nonce };
      const signature = await account.signTypedData({ domain: { name: assetName, version: assetVersion, chainId, verifyingContract: asset }, types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message });
      const { v, r, s } = parseSignature(signature);
      return { message, signature, calldata: encodeFunctionData({ abi: ERC20, functionName: 'transferWithAuthorization', args: [message.from, message.to, message.value, message.validAfter, message.validBefore, nonce, Number(v), r, s] }) };
    },
    exportPrivateKey() { return record.privateKey; },
    forget() { storage.removeItem(KEY); },
  };
}
/** ERC-20 transfer calldata, for funding the session wallet from an injected wallet. */
export const transferCalldata = (to, value) => encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, BigInt(value)] });

/** Sends a transaction through an EIP-1193 provider after switching it to the right chain. */
export async function sendFromInjected(ethereum, { from, to, data, chainId }) {
  if (!ethereum) throw new Error('No injected wallet');
  const want = numberToHex(chainId);
  if ((await ethereum.request({ method: 'eth_chainId' })) !== want) await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
  return ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] });
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usdc = a => `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;

/**
 * Renders the session-wallet box into `el` and returns { wallet, refresh }.
 * opts: { chain(): {network, asset:{address,name,version}, rpcUrl}, injected(): {ethereum, address}|null, api, log }
 */
export function mountSessionWallet(el, opts) {
  let wallet = sessionWallet();
  let balance = null;
  const render = () => {
    el.innerHTML = `
      <div class="sw-addr"><span class="muted">Session address</span><br><code class="mono">${esc(wallet.address)}</code> <button data-act="copy" title="copy">⧉</button></div>
      <div class="sw-bal"><span class="muted">USDC balance</span> <b>${balance === null ? '—' : usdc(balance)}</b> <button data-act="refresh">↻</button></div>
      <div class="sw-fund"><input data-fund placeholder="atomic USDC to fund, e.g. 4000" style="width:160px;display:inline-block"> <button data-act="fund">Fund from connected wallet</button></div>
      <div class="actions" style="margin-top:8px"><button data-act="sweep">Sweep back to connected wallet</button><button data-act="rotate">New address</button><button data-act="export">Export key</button><button data-act="forget">Forget</button></div>
      <p class="hint">Fund it with exactly what this run may spend; that amount is the real limit. Nothing else should ever be sent here. Sweep back when done; export the key only if you must recover funds elsewhere.</p>`;
    el.querySelectorAll('button').forEach(b => b.onclick = () => act(b.dataset.act).catch(e => opts.log?.(`Session wallet: ${e.message}`, 'bad')));
  };
  const refresh = async () => {
    try {
      const c = opts.chain();
      const r = await opts.api.balance({ network: c.network, asset: c.asset.address, address: wallet.address, rpcUrl: c.rpcUrl });
      balance = r.balance;
    } catch (e) { balance = null; opts.log?.(`Balance check failed: ${e.message}`, 'warn'); }
    render();
  };
  async function act(name) {
    const c = opts.chain(), inj = opts.injected();
    if (name === 'copy') { await navigator.clipboard?.writeText(wallet.address); opts.log?.('Session address copied.'); }
    if (name === 'refresh') await refresh();
    if (name === 'fund') {
      const amount = el.querySelector('[data-fund]').value.trim();
      if (!/^[1-9]\d{0,11}$/.test(amount)) throw new Error('Enter the amount in atomic USDC (1000 = 0.001 USDC)');
      if (!inj?.address) throw new Error('Connect your main wallet first');
      if (!confirm(`Send ${usdc(amount)} from ${inj.address} to the session address ${wallet.address}? This is the hard spend limit for the run.`)) return;
      const tx = await sendFromInjected(inj.ethereum, { from: inj.address, to: c.asset.address, data: transferCalldata(wallet.address, amount), chainId: chainIdOf(c.network) });
      opts.log?.(`Funding transaction sent: ${tx}. Refresh the balance once it confirms.`, 'ok');
    }
    if (name === 'sweep') {
      if (!inj?.address) throw new Error('Connect your main wallet first (it submits the sweep and pays gas)');
      await refresh();
      if (!balance || BigInt(balance) === 0n) throw new Error('Nothing to sweep');
      if (!confirm(`Sweep ${usdc(balance)} from the session address back to ${inj.address}? Your main wallet will submit the transaction.`)) return;
      const auth = await wallet.sweepAuthorization({ to: inj.address, value: balance, chainId: chainIdOf(c.network), asset: c.asset.address, assetName: c.asset.name, assetVersion: c.asset.version });
      const tx = await sendFromInjected(inj.ethereum, { from: inj.address, to: c.asset.address, data: auth.calldata, chainId: chainIdOf(c.network) });
      opts.log?.(`Sweep transaction sent: ${tx}.`, 'ok');
    }
    if (name === 'rotate') { if (balance && BigInt(balance) > 0n && !confirm('This address still holds USDC. Export the key or sweep first. Rotate anyway?')) return; wallet.forget(); wallet = sessionWallet(); balance = null; render(); opts.onChange?.(wallet); }
    if (name === 'export') { if (confirm('Show the private key? Anyone who sees it can spend the session funds.')) prompt('Session wallet private key (copy, then close):', wallet.exportPrivateKey()); }
    if (name === 'forget') { if (balance && BigInt(balance) > 0n && !confirm('This address still holds USDC. Forgetting the key loses them. Continue?')) return; if (!confirm('Delete the session key from this browser?')) return; wallet.forget(); wallet = sessionWallet(); balance = null; render(); opts.onChange?.(wallet); }
  }
  render();
  return { get wallet() { return wallet; }, refresh };
}
