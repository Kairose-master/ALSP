import { BrowserJournal, BrowserSessionClient, PROFILE, canonical, digest, injectedWallet, inputOf, serverApi, sha256Text, verifyChain } from './alsp-browser.js';
import { mountSessionWallet } from './session-wallet.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 10) => s ? `${String(s).slice(0, n)}…` : '—';
const usdc = a => `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
const api = serverApi(''), journal = new BrowserJournal();
let meta = null, wallet = null, selected = null, busy = false, payerMode = 'injected', sessionBox = null;
const payerWallet = () => payerMode === 'session' ? sessionBox?.wallet : wallet;
function setPayer(m) {
  payerMode = m; $('#sessionWalletBox').hidden = m !== 'session';
  if (m === 'session' && !sessionBox) {
    sessionBox = mountSessionWallet($('#sessionWalletBox'), { api, log, chain: () => { const p = currentProvider(); return { network: p.network, asset: p.asset, rpcUrl: $('#rpcUrl').value.trim() || undefined }; }, injected: () => wallet?.address ? { ethereum: globalThis.ethereum, address: wallet.address } : null });
    sessionBox.refresh();
  }
}

const log = (text, kind = '') => { const el = document.createElement('div'); el.className = `log ${kind}`; el.textContent = `${new Date().toLocaleTimeString()} ${text}`; $('#log').prepend(el); };
const setBusy = b => { busy = b; document.querySelectorAll('button[data-busy]').forEach(x => x.disabled = b); };

// ---------- provider ----------
function currentProvider() {
  const p = JSON.parse($('#providerJson').value);
  if (!p || typeof p !== 'object') throw new Error('Provider profile must be a JSON object');
  return p;
}
function loadPreset(id) {
  const p = id === 'custom' ? { id: 'my-provider', label: 'My x402 exact provider', origin: 'https://api.example.com', endpointPath: '/v1/paid', method: 'GET', signerPath: '/.well-known/x402-signer.json', network: 'eip155:8453', asset: { address: meta.presets['x402-doctor'].asset.address, name: 'USD Coin', version: '2' }, payTo: '0x0000000000000000000000000000000000000000', receipt: { route: 'GET /v1/paid', service: 'my-provider', certHeader: 'my-provider receipt signer' } } : meta.presets[id];
  $('#providerJson').value = JSON.stringify(p, null, 2);
  $('#input').value = id === 'x402-doctor' ? JSON.stringify({ url: meta.interopTarget, method: 'GET' }, null, 2) : JSON.stringify({ q: 'example' }, null, 2);
  $('#rpcUrl').value = meta.defaultRpc[p.network] ?? '';
  $('#pin').value = '';
  $('#signerDoc').textContent = '';
}
async function fetchSigner() {
  try {
    setBusy(true);
    const r = await api.signer(currentProvider());
    $('#signerDoc').textContent = r.signerDocument ? JSON.stringify(r.signerDocument, null, 2) : 'No signer document published at signerPath.';
    log('Fetched the provider\'s published signer document. Check it against an independent source before pinning.');
  } catch (e) { log(`Signer fetch failed: ${e.message}`, 'bad'); } finally { setBusy(false); }
}

// ---------- wallet ----------
async function connect() {
  try {
    wallet = injectedWallet();
    const a = await wallet.connect();
    $('#wallet').textContent = a; $('#connect').textContent = 'Connected';
    log(`Wallet connected: ${a}`);
    renderSessions();
  } catch (e) { log(`Wallet: ${e.message}`, 'bad'); }
}

// ---------- session ----------
async function createSession() {
  try {
    const payer = payerWallet();
    if (!payer?.address) throw new Error(payerMode === 'session' ? 'Session wallet not ready' : 'Connect a wallet first');
    const p = currentProvider(), license = $('#license').value;
    if (!license.trim()) throw new Error('Paste the provider terms you reviewed; their SHA-256 is committed in the session');
    const maxTotal = $('#maxTotal').value.trim(), maxPerCall = $('#maxPerCall').value.trim(), maxCalls = Number($('#maxCalls').value), ttl = Number($('#ttl').value);
    const terms = { profile: PROFILE, payer: payer.address, provider: p.payTo, network: p.network, asset: p.asset.address, endpoint: `${p.origin}${p.endpointPath}`, maxTotal, maxPerCall, maxCalls, expiresAt: Date.now() + ttl * 1000, license: { uri: $('#licenseUri').value.trim() || 'urn:alsp:locally-reviewed-terms', sha256: await sha256Text(license), acceptance: 'buyer-only' } };
    if (!confirm(`Create a session that may spend up to ${usdc(maxTotal)} (≤ ${usdc(maxPerCall)} per call, ≤ ${maxCalls} calls) from ${payer.address} to ${p.payTo} on ${p.network}?\n\n${payerMode === 'session' ? 'The disposable session wallet signs automatically; its balance is the real limit.' : 'Every payment still needs a wallet signature.'}`)) return;
    const id = await journal.create(terms, p);
    log(`Session ${id} created (terms hash ${short(await digest(terms), 16)})`, 'ok');
    selected = id; renderSessions(); renderSession();
  } catch (e) { log(`Create session failed: ${e.message}`, 'bad'); }
}
function client() {
  const pin = $('#pin').value.trim();
  if (!pin) throw new Error('Enter the independently checked receipt signer pin');
  return new BrowserSessionClient(journal, { api, wallet: payerWallet(), pins: [{ address: pin }], rpcUrl: $('#rpcUrl').value.trim() || undefined, onStep: (step, c, err) => {
    const label = { replay: 'Idempotent replay: persisted call returned, no new signature or payment', probe: 'Fetching 402 challenge (unpaid)', reserved: `Reserved ${c ? usdc(c.amount) : ''} and nonce ${c ? short(c.nonce, 12) : ''}; asking the wallet to sign`, submitting: 'Submission intent journaled; sending the signed authorization once', verifying: 'Verifying receipt signature and RPC settlement' }[step];
    if (step === 'error') log(`Call ${c ? short(c.id, 8) : ''}: ${err.message}. Funds stay reserved; nothing is retried automatically.`, 'bad'); else log(label);
  } });
}
async function makeCall() {
  try {
    if (!selected) throw new Error('Select or create a session');
    if (!payerWallet()?.address) throw new Error('Connect a wallet or enable the session wallet first');
    const input = JSON.parse($('#input').value), key = $('#key').value.trim() || `call-${journal.calls(selected).length + 1}`;
    const s = journal.session(selected); inputOf(input, s.provider);
    setBusy(true);
    const c = await client().call(selected, key, input);
    log(`Call "${key}" → ${c.state}${c.state === 'VERIFIED' ? ` · ${usdc(c.amount)} · tx ${short(c.verified.ledger.transaction, 14)}` : ''}`, c.state === 'VERIFIED' ? 'ok' : 'warn');
    $('#key').value = '';
  } catch (e) { log(`Call failed: ${e.message}`, 'bad'); }
  finally { setBusy(false); renderSessions(); renderSession(); }
}
async function reconcile(callId, withEvidence) {
  try {
    let evidence;
    if (withEvidence) {
      const raw = prompt('Paste the recovered original response as JSON: {"status":200,"body":{...},"settlement":{...}}');
      if (!raw) return; evidence = JSON.parse(raw);
    }
    setBusy(true);
    const c = await client().reconcile(callId, evidence);
    log(`Reconcile ${short(callId, 8)} → ${c.state}`, c.state === 'VERIFIED' ? 'ok' : 'warn');
  } catch (e) { log(`Reconcile failed: ${e.message}`, 'bad'); }
  finally { setBusy(false); renderSessions(); renderSession(); }
}
async function endSession() { try { await journal.end(selected); log('Session ended'); } catch (e) { log(e.message, 'bad'); } renderSessions(); renderSession(); }
async function resumeSession() { try { await journal.resume(selected); log('Session resumed within the original cap', 'ok'); } catch (e) { log(`Resume refused: ${e.message}`, 'bad'); } renderSessions(); renderSession(); }
async function forgetSession() { try { if (!confirm('Delete this session\'s local journal? Only possible when every call is VERIFIED. Export the archive first.')) return; await journal.forget(selected); selected = null; log('Local journal deleted'); } catch (e) { log(e.message, 'bad'); } renderSessions(); renderSession(); }
async function exportArchive(seal) {
  try {
    const report = await journal.export(selected);
    let archive = report;
    if (seal) {
      const sealer = [payerWallet(), wallet, sessionBox?.wallet].find(w => w?.address && w.address.toLowerCase() === report.terms.payer.toLowerCase());
      if (!sealer) throw new Error('The payer wallet of this session is not available to seal');
      const manifest = { profile: PROFILE, sessionId: selected, archiveSha256: await digest(report), headHash: report.headHash };
      const signature = await sealer.signMessage(canonical(manifest));
      archive = { ...report, buyerSeal: { manifest, signer: sealer.address, signature } };
    }
    const local = await verifyChain(report);
    let remote = null;
    try { remote = await api.verifyArchive(archive); } catch (e) { log(`Server-side archive check unavailable: ${e.message}`, 'warn'); }
    log(`Archive exported · chain ${local ? 'intact' : 'BROKEN'} (local)${remote ? ` · server: chain ${remote.chain ? 'ok' : 'BROKEN'}${remote.seal !== null ? `, buyer seal ${remote.seal ? 'valid' : 'INVALID'}` : ''}` : ''}`, local ? 'ok' : 'bad');
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `alsp-session-${selected}${seal ? '-sealed' : ''}.json`; a.click();
  } catch (e) { log(`Export failed: ${e.message}`, 'bad'); }
}

// ---------- rendering ----------
function renderSessions() {
  const list = journal.list(), el = $('#sessions');
  if (!list.length) { el.innerHTML = '<div class="empty">No sessions in this browser yet.</div>'; return; }
  el.innerHTML = list.map(s => `<button class="sess ${s.id === selected ? 'active' : ''}" data-id="${s.id}"><span class="mono">${short(s.id, 8)}</span> <span class="state ${s.state}">${s.state}</span><br><small>${esc(s.providerId)} · ${s.calls} calls${s.unresolved ? ` · <b class="warn">${s.unresolved} unresolved</b>` : ''} · ${new Date(s.createdAt).toLocaleString()}</small></button>`).join('');
  el.querySelectorAll('.sess').forEach(b => b.onclick = () => { selected = b.dataset.id; renderSessions(); renderSession(); });
}
async function renderSession() {
  const out = $('#session');
  if (!selected) { out.innerHTML = '<div class="empty">Select a session.</div>'; return; }
  const s = journal.session(selected), report = await journal.export(selected), sm = report.summary;
  const tiles = [['State', s.state === 'ACTIVE' ? 'ACTIVE' : sm.state], ['Allocated', usdc(sm.allocatedTotal)], ['Verified spent', usdc(sm.verifiedSpent)], ['Unresolved', sm.unresolved], ['Calls', `${sm.calls} / ${s.terms.maxCalls}`], ['Expires', new Date(s.terms.expiresAt).toLocaleTimeString()]];
  const calls = s.calls.map(c => `<tr><td><code>${esc(c.requestKey)}</code></td><td class="mono">${esc(JSON.stringify(c.input)).slice(0, 80)}</td><td><span class="state ${c.state}">${c.state}</span></td><td>${usdc(c.amount)}</td><td class="mono" title="${esc(c.nonce)}">${short(c.nonce, 12)}</td><td class="mono" title="${esc(c.verified?.ledger.transaction ?? '')}">${c.verified ? `<a href="https://basescan.org/tx/${esc(c.verified.ledger.transaction)}" target="_blank" rel="noopener">${short(c.verified.ledger.transaction, 12)}</a>` : c.wire?.settlement?.transaction ? short(c.wire.settlement.transaction, 12) : '—'}</td>
    <td>${c.state !== 'VERIFIED' ? `<button data-busy data-rec="${c.id}">${c.wire ? 'Re-verify' : 'Verify'}</button> ${c.wire ? '' : `<button data-busy data-rec-ev="${c.id}">Attach response</button>`}` : `<span class="muted">${esc(c.verified.receipt.requestId)}</span>`}</td></tr>`).join('');
  const events = s.events.map(e => `<tr><td>${e.seq}</td><td><code>${esc(e.event.kind)}</code></td><td class="mono" title="${esc(e.head)}">${short(e.head, 16)}</td><td class="mono">${esc(JSON.stringify(e.event)).slice(0, 140)}</td></tr>`).join('');
  out.innerHTML = `
    <div class="strip">${tiles.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
    <p class="hint">Session <span class="mono">${esc(selected)}</span> · payer ${short(s.terms.payer, 12)} → ${esc(s.provider.label)} (${short(s.terms.provider, 12)}) · ${esc(s.terms.network)} · terms hash ${short(report.termsHash, 16)} · head ${short(report.headHash, 16)}</p>
    <div class="actions">
      ${s.state === 'ACTIVE' ? '<button data-busy id="end">End session</button>' : '<button data-busy id="resume">Resume</button>'}
      <button data-busy id="exportPlain">Export archive</button><button data-busy id="exportSealed">Export + buyer seal</button><button id="forget">Delete local journal</button>
    </div>
    <details open><summary>Calls (${s.calls.length})</summary><table><thead><tr><th>key</th><th>input</th><th>state</th><th>amount</th><th>nonce</th><th>tx</th><th>evidence</th></tr></thead><tbody>${calls || '<tr><td colspan="7" class="muted">No calls yet.</td></tr>'}</tbody></table></details>
    <details><summary>Event chain (${s.events.length})</summary><table><thead><tr><th>#</th><th>kind</th><th>head</th><th>event</th></tr></thead><tbody>${events}</tbody></table></details>
    <details><summary>Terms</summary><pre>${esc(JSON.stringify(s.terms, null, 2))}</pre></details>`;
  $('#end') && ($('#end').onclick = endSession); $('#resume') && ($('#resume').onclick = resumeSession);
  $('#exportPlain').onclick = () => exportArchive(false); $('#exportSealed').onclick = () => exportArchive(true); $('#forget').onclick = forgetSession;
  out.querySelectorAll('[data-rec]').forEach(b => b.onclick = () => reconcile(b.dataset.rec, false));
  out.querySelectorAll('[data-rec-ev]').forEach(b => b.onclick = () => reconcile(b.dataset.recEv, true));
  if (busy) setBusy(true);
}

// ---------- boot ----------
$('#connect').onclick = connect; $('#create').onclick = createSession; $('#call').onclick = makeCall; $('#fetchSigner').onclick = fetchSigner;
$('#preset').onchange = e => loadPreset(e.target.value);
document.querySelectorAll('input[name=payer]').forEach(r => r.onchange = e => setPayer(e.target.value));
$('#usePublishedSigner').onclick = () => { try { const d = JSON.parse($('#signerDoc').textContent); const a = d.signer ?? d.address ?? (Array.isArray(d.signers) ? (d.signers.find(x => x.status === 'current') ?? d.signers[0])?.address : undefined); if (!a) throw new Error('no signer field'); $('#pin').value = a; log('Pin copied from the published document. This is trust-on-first-use unless you verified it elsewhere.', 'warn'); } catch (e) { log(`Could not read a signer address: ${e.message}`, 'bad'); } };
(async () => {
  try {
    meta = await api.meta();
    const sel = $('#preset');
    for (const p of Object.values(meta.presets)) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o); }
    const custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = 'Custom provider profile (JSON)'; sel.appendChild(custom);
    loadPreset(Object.keys(meta.presets)[0]);
    if (meta.allowedOrigins) log(`This deployment only proxies: ${meta.allowedOrigins.join(', ')}`);
    renderSessions(); renderSession();
    if (globalThis.ethereum) log('Wallet detected. Connect to begin.'); else log('No injected wallet detected. Install MetaMask (or any EIP-1193 wallet) on Base to pay.', 'warn');
  } catch (e) { log(`Could not load server metadata: ${e.message}`, 'bad'); }
})();
