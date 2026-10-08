// Measurement runner: N paid micro-calls per provider under one mission cap, every outcome classified,
// one reconciliation attempt for anything ambiguous, and the numbers published to the run logs.
import { BrowserJournal, BrowserSessionClient, PROFILE, injectedWallet, serverApi, sha256Text } from './alsp-browser.js';
import { createSimWorld, memoryStorage } from './sim.js';
import { mountSessionWallet } from './session-wallet.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 12) => s ? `${String(s).slice(0, n)}…` : '—';
const usdc = a => `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = serverApi('');
let meta = null, mode = 'sandbox', wallet = null, payerMode = 'session', sessionBox = null, discovered = {}, run = null;
const DEFAULT_ON = ['ping-402rates', 'crypto-news-otto', 'crypto-price-apitoll'];

const line = (text, cls = '') => { const el = document.createElement('div'); el.className = `line ${cls}`; el.textContent = `${new Date().toLocaleTimeString()} ${text}`; $('#log').prepend(el); };

function chosen() { return [...document.querySelectorAll('#providers input:checked')].map(i => meta.templates.find(t => t.id === i.value)); }
async function updatePlan() {
  const n = Number($('#perProvider').value), list = chosen();
  let cap = 0n, notes = [];
  for (const t of list) {
    if (mode === 'live') {
      if (!discovered[t.id]) { try { discovered[t.id] = await api.discover(t.url); } catch (e) { notes.push(`${t.label}: ${e.message}`); continue; } }
      cap += BigInt(discovered[t.id].quote.amount) * BigInt(n);
    } else cap += 1000n * BigInt(n);
  }
  $('#cap').value = cap.toString();
  $('#planNote').textContent = `${list.length} providers × ${n} calls = ${list.length * n} paid calls, mission cap ${usdc(cap)}.${notes.length ? ' ' + notes.join(' · ') : ''}`;
}
function setMode(m) { mode = m; document.body.dataset.mode = m; if (m === 'live' && !sessionBox) mountWallet(); updatePlan(); }
function mountWallet() {
  sessionBox = mountSessionWallet($('#sessionWalletBox'), { api, log: line, chain: () => { const any = Object.values(discovered)[0]?.profile; return { network: any?.network ?? 'eip155:8453', asset: any?.asset ?? { address: meta.presets['x402-doctor'].asset.address, name: 'USD Coin', version: '2' }, rpcUrl: $('#rpcUrl').value.trim() || undefined }; }, injected: () => wallet?.address ? { ethereum: globalThis.ethereum, address: wallet.address } : null });
  sessionBox.refresh();
}
async function connect() { try { wallet = injectedWallet(); const a = await wallet.connect(); $('#wallet').textContent = a; $('#connect').textContent = 'Connected'; } catch (e) { alert(e.message); } }

// ---------- the measurement ----------
function classify(c, errorText) {
  if (c.state === 'VERIFIED') return 'verified';
  if (!c.wire) return 'lostResponse';
  return 'verifyFailed';
}
async function start() {
  if (run && !run.done) return;
  const list = chosen(), n = Number($('#perProvider').value), pause = Number($('#pause').value), lossRate = Number($('#lossRate').value);
  if (!list.length) return alert('Pick at least one provider');
  const journal = new BrowserJournal(memoryStorage()), noPayments = async () => { throw new Error('Reconciliation cannot create or send a payment'); };
  const providers = []; let payer, network, rpcUrl;
  if (mode === 'sandbox') {
    for (const t of list) { const sim = createSimWorld({ price: '1000', kind: 'price', role: t.id.replace(/[^a-z0-9]/g, '').slice(0, 12), lossRate, loseResponseOnCall: 0 }); payer = payer ?? sim.wallet; network = sim.provider.network; providers.push({ id: t.id, label: t.label, profile: sim.provider, wire: sim.provider, api: sim.api, wallet: sim.wallet, pins: sim.pins, price: '1000', input: {}, recover: sim.api.recover, sim }); }
  } else {
    payer = payerMode === 'session' ? sessionBox?.wallet : wallet;
    if (!payer?.address) return alert(payerMode === 'session' ? 'Session wallet not ready' : 'Connect a wallet first');
    rpcUrl = $('#rpcUrl').value.trim() || undefined;
    for (const t of list) { const d = discovered[t.id]; if (!d) continue; network = d.profile.network; providers.push({ id: t.id, label: t.label, profile: d.profile, wire: d.profile, api, wallet: payer, pins: [], price: d.quote.amount, input: d.input, recover: null }); }
    if (!providers.length) return alert('No usable providers');
    if (!confirm(`Pay ${list.length * n} real micro-calls (mission cap ${usdc($('#cap').value)}) from ${payer.address}?`)) return;
  }
  const missionId = await journal.createMission({ label: `measurement ${new Date().toISOString()}`, maxTotal: $('#cap').value, payer: payer.address, network });
  run = { journal, missionId, rows: [], stopped: false, done: false, errors: new Map(), startedAt: Date.now() };
  $('#start').disabled = true; $('#stop').disabled = false; $('#logLink').textContent = '';
  const onStep = (step, c, err) => { if (step === 'error' && c) run.errors.set(c.id, err.message); };
  for (const p of providers) {
    p.client = new BrowserSessionClient(journal, { api: p.api, wallet: p.wallet, pins: p.pins, rpcUrl, onStep });
    p.reconciler = new BrowserSessionClient(journal, { api: { ...p.api, probe: noPayments, send: noPayments }, wallet: { address: p.wallet.address, prepare: noPayments }, pins: p.pins, rpcUrl, onStep });
    const terms = { profile: PROFILE, payer: payer.address, provider: p.profile.payTo, network: p.profile.network, asset: p.profile.asset.address, endpoint: `${p.profile.origin}${p.profile.endpointPath}`, maxTotal: (BigInt(p.price) * BigInt(n)).toString(), maxPerCall: p.price, maxCalls: n, expiresAt: Date.now() + 3600000, license: { uri: 'urn:alsp:measurement', sha256: await sha256Text(`measurement ${p.label}`), acceptance: 'buyer-only' } };
    p.sessionId = await journal.create(terms, p.profile, Date.now(), { missionId });
  }
  line(`Mission ${missionId.slice(0, 8)} created: ${providers.length} providers × ${n} calls, cap ${usdc($('#cap').value)}`);
  try {
    for (let i = 1; i <= n && !run.stopped; i++) {
      for (const p of providers) {
        if (run.stopped) break;
        const t0 = performance.now();
        let row;
        try {
          const c = await p.client.call(p.sessionId, `m-${i}`, p.input);
          row = { provider: p.id, i, callId: c.id, state: c.state, outcome: classify(c), ms: Math.round(performance.now() - t0), error: run.errors.get(c.id) ?? null, tx: c.verified?.ledger.transaction ?? null, amount: c.amount, hasWire: Boolean(c.wire), nonce: c.nonce };
        } catch (e) { row = { provider: p.id, i, callId: null, state: 'REFUSED', outcome: 'refused', ms: Math.round(performance.now() - t0), error: e.message, tx: null, amount: '0', hasWire: false }; }
        run.rows.push(row); line(`${p.id} #${i} → ${row.state}${row.error ? ` (${row.error})` : ''} · ${row.ms} ms`, row.outcome === 'verified' ? 'ok' : row.outcome === 'refused' ? 'bad' : 'warn');
        renderResults(providers, n);
        if (pause) await sleep(pause);
      }
    }
    // One reconciliation pass: transient failures should clear; lost responses only clear where a lookup exists.
    for (const row of run.rows.filter(r => r.outcome !== 'verified' && r.callId)) {
      const p = providers.find(x => x.id === row.provider);
      try {
        let evidence; if (!row.hasWire && p.recover) evidence = await p.recover(row.nonce);
        const r = await p.reconciler.reconcile(row.callId, evidence ?? undefined);
        row.afterReconcile = r.state; row.reconcileError = r.state === 'VERIFIED' ? null : (run.errors.get(row.callId) ?? row.error);
        if (r.state === 'VERIFIED') row.tx = r.verified.ledger.transaction;
      } catch (e) { row.afterReconcile = row.state; row.reconcileError = e.message; }
    }
    await journal.endMission(missionId);
  } finally {
    run.done = true; $('#start').disabled = false; $('#stop').disabled = true;
    renderResults(providers, n, true);
    await publish(providers, n).catch(e => line(`Log upload failed: ${e.message}`, 'bad'));
  }
}
function perProvider(providers) {
  return providers.map(p => {
    const rows = run.rows.filter(r => r.provider === p.id), ms = rows.map(r => r.ms).sort((a, b) => a - b);
    return { provider: p.id, label: p.label, calls: rows.length, verified: rows.filter(r => r.outcome === 'verified').length, lostResponse: rows.filter(r => r.outcome === 'lostResponse').length, verifyFailed: rows.filter(r => r.outcome === 'verifyFailed').length, refused: rows.filter(r => r.outcome === 'refused').length,
      unresolvedAfterReconcile: rows.filter(r => r.outcome !== 'verified' && r.outcome !== 'refused' && r.afterReconcile !== 'VERIFIED').length, p50: ms.length ? ms[Math.floor(ms.length / 2)] : 0, spent: rows.filter(r => r.outcome !== 'refused').reduce((t, r) => t + BigInt(r.amount), 0n).toString() };
  });
}
function renderResults(providers, n, final = false) {
  const per = perProvider(providers), calls = run.rows.length, verified = run.rows.filter(r => r.outcome === 'verified').length, ambiguous = run.rows.filter(r => r.outcome === 'lostResponse' || r.outcome === 'verifyFailed').length;
  const stillUnresolved = per.reduce((t, r) => t + r.unresolvedAfterReconcile, 0), spent = per.reduce((t, r) => t + BigInt(r.spent), 0n);
  const tile = (k, v) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`;
  $('#results').innerHTML = `<div class="strip">${tile('Calls', `${calls} / ${providers.length * n}`)}${tile('Verified first try', verified)}${tile('Ambiguous first try', ambiguous)}${tile('Ambiguity rate', calls ? `${((ambiguous / calls) * 100).toFixed(1)}%` : '—')}${tile(final ? 'Unresolved after reconcile' : 'Unresolved (reconcile pending)', final ? stillUnresolved : ambiguous)}${tile('Spent', usdc(spent))}</div>
    <table><thead><tr><th>provider</th><th>calls</th><th class="ok">verified</th><th class="warn">lost response</th><th class="warn">verify failed</th><th>refused</th><th>after reconcile</th><th>p50 ms</th><th>spent</th></tr></thead><tbody>${per.map(r => `<tr><td>${esc(r.label)}</td><td>${r.calls}</td><td class="ok">${r.verified}</td><td class="warn">${r.lostResponse}</td><td class="warn">${r.verifyFailed}</td><td>${r.refused}</td><td>${final ? r.unresolvedAfterReconcile : '…'}</td><td>${r.p50}</td><td>${usdc(r.spent)}</td></tr>`).join('')}</tbody></table>
    <p class="hint">Ambiguous = the money may have moved but the client could not verify on the first try. "After reconcile" counts what stayed unresolved after one reconciliation pass: that is the residue a plain client would have retried (and paid for) blindly.</p>
    <details><summary>Per-call rows</summary><table><thead><tr><th>#</th><th>provider</th><th>state</th><th>after reconcile</th><th>ms</th><th>error</th><th>tx</th></tr></thead><tbody>${run.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.provider)}</td><td>${esc(r.state)}</td><td>${esc(r.afterReconcile ?? '')}</td><td>${r.ms}</td><td class="muted">${esc(r.reconcileError ?? r.error ?? '')}</td><td class="mono">${short(r.tx)}</td></tr>`).join('')}</tbody></table></details>`;
}
async function publish(providers, n) {
  if (!meta?.logs?.enabled) return;
  const per = perProvider(providers), calls = run.rows.length, ambiguous = run.rows.filter(r => r.outcome === 'lostResponse' || r.outcome === 'verifyFailed').length;
  const archive = await run.journal.exportMission(run.missionId);
  const r = await api.logs.put({ kind: 'measurement', title: `${mode} · ${providers.length} providers × ${n}`, origin: location.host, summary: { mode, calls, verified: run.rows.filter(r => r.outcome === 'verified').length, ambiguous, unresolvedAfterReconcile: per.reduce((t, x) => t + x.unresolvedAfterReconcile, 0), refused: run.rows.filter(r => r.outcome === 'refused').length, spent: per.reduce((t, x) => t + BigInt(x.spent), 0n).toString(), providers: providers.length, payer: providers[0]?.wallet.address, durationMs: Date.now() - run.startedAt, lossRate: mode === 'sandbox' ? Number($('#lossRate').value) : null }, payload: { perProvider: per, rows: run.rows, archive } });
  $('#logLink').innerHTML = `Published to <a href="./logs.html?id=${encodeURIComponent(r.id)}">run logs</a>.`;
}

// ---------- boot ----------
$('#start').onclick = start; $('#stop').onclick = () => { if (run) run.stopped = true; }; $('#connect').onclick = connect;
document.querySelectorAll('input[name=mode]').forEach(r => r.onchange = e => setMode(e.target.value));
document.querySelectorAll('input[name=payer]').forEach(r => r.onchange = e => { payerMode = e.target.value; });
$('#perProvider').onchange = updatePlan;
(async () => {
  try {
    meta = await api.meta();
    $('#status').textContent = meta.logs?.enabled ? 'logs on' : 'logs not configured';
    $('#providers').innerHTML = meta.templates.filter(t => !t.mission).map(t => `<label><input type="checkbox" value="${esc(t.id)}" ${DEFAULT_ON.includes(t.id) ? 'checked' : ''}> ${esc(t.label)}</label>`).join('');
    $('#providers').querySelectorAll('input').forEach(i => i.onchange = updatePlan);
    setMode('sandbox');
  } catch (e) { $('#status').textContent = e.message; }
})();
