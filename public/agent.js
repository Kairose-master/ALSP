// Watch an AI agent (Claude) run a whole ALSP session. The model only decides; every tool runs
// here, in the browser, on the real journal. Sandbox mode uses the in-page simulated provider
// and wallet; Live mode uses the real provider through the proxy and your wallet for signatures.
import { BrowserJournal, BrowserSessionClient, PROFILE, digest, injectedWallet, inputOf, serverApi, sha256Text, verifyChain } from './alsp-browser.js';
import { createSimWorld, memoryStorage } from './sim.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 12) => s ? `${String(s).slice(0, n)}…` : '—';
const usdc = a => `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
const MAX_TURNS = 24;
const MISSIONS = {
  sandbox: 'Buy spot quotes for BTC-USDT, ETH-USDT and SOL-USDT from the oracle. Handle any failure without ever paying twice. Then end the session, export the archive and report what you bought, what it cost and the archive head hash.',
  live: 'Run an x402 Doctor preflight on https://ichimoku-signal.fizzl.eu/signal/BTC-USDT and tell me whether it is safe to pay, with the reasons the service gave. Then end the session, export the archive and report the cost and the archive head hash.',
};

let meta = null, api = serverApi(''), wallet = null, mode = 'sandbox';
let run = null; // { journal, client, reconciler, sim, provider, providerWire, pins, rpcUrl, sessionId, messages, stopped, turns, tokens }

const log = (html, cls = '') => { const el = document.createElement('div'); el.className = `entry ${cls}`; el.innerHTML = html; $('#transcript').appendChild(el); el.scrollIntoView({ block: 'end' }); return el; };

// ---------- setup ----------
function caps() { return { maxTotal: $('#maxTotal').value.trim(), maxPerCall: $('#maxPerCall').value.trim(), maxCalls: Number($('#maxCalls').value) }; }
function currentProviderJson() { return JSON.parse($('#providerJson').value); }
function setMode(m) {
  mode = m; document.body.dataset.mode = m;
  $('#mission').value = MISSIONS[m];
  if (m === 'live' && meta) { const p = meta.presets['x402-doctor']; $('#providerJson').value = JSON.stringify(p, null, 2); $('#rpcUrl').value = meta.defaultRpc[p.network] ?? ''; }
}
async function connect() {
  try { wallet = injectedWallet(); const a = await wallet.connect(); $('#wallet').textContent = a; $('#connect').textContent = 'Connected'; } catch (e) { alert(e.message); }
}

// ---------- tool execution (all on the real browser journal) ----------
async function terms(args) {
  const c = caps(), p = run.provider;
  const maxTotal = String(args.maxTotal), maxPerCall = String(args.maxPerCall), maxCalls = Number(args.maxCalls), ttl = Number(args.ttlSeconds);
  if (!/^[1-9]\d{0,11}$/.test(maxTotal) || !/^[1-9]\d{0,11}$/.test(maxPerCall)) throw new Error('Amounts must be positive atomic integer strings');
  if (BigInt(maxTotal) > BigInt(c.maxTotal) || BigInt(maxPerCall) > BigInt(c.maxPerCall) || maxCalls > c.maxCalls) throw new Error(`Above the human's hard caps: maxTotal ≤ ${c.maxTotal}, maxPerCall ≤ ${c.maxPerCall}, maxCalls ≤ ${c.maxCalls}`);
  return { profile: PROFILE, payer: run.wallet.address, provider: p.payTo, network: p.network, asset: p.asset.address, endpoint: `${p.origin}${p.endpointPath}`, maxTotal, maxPerCall, maxCalls, expiresAt: Date.now() + ttl * 1000, license: { uri: 'urn:alsp:agent:locally-reviewed-terms', sha256: await sha256Text(String(args.licenseNote)), acceptance: 'buyer-only' } };
}
const summary = async id => { const r = await run.journal.export(id); const s = run.journal.session(id); return { state: s.state === 'ACTIVE' ? 'ACTIVE' : r.summary.state, allocated: r.summary.allocatedTotal, verifiedSpent: r.summary.verifiedSpent, unresolved: r.summary.unresolved, calls: r.summary.calls, maxCalls: s.terms.maxCalls, remainingBudget: (BigInt(s.terms.maxTotal) - BigInt(r.summary.allocatedTotal)).toString(), events: r.events.length, head: r.headHash }; };
const callView = c => ({ callId: c.id, key: c.requestKey, input: c.input, state: c.state, amount: c.amount, hasStoredResponse: Boolean(c.wire), lastError: c.state === 'VERIFIED' ? null : (run.errors.get(c.id) ?? null), tx: c.verified?.ledger.transaction ?? null, receiptId: c.verified?.receipt.requestId ?? null, response: c.state === 'VERIFIED' ? (({ receipt: _r, ...rest }) => rest)(c.wire.body) : null });

const TOOL_IMPL = {
  async probe_quote({ input }) {
    const c = caps(), p = run.provider;
    const draft = { profile: PROFILE, payer: run.wallet.address, provider: p.payTo, network: p.network, asset: p.asset.address, endpoint: `${p.origin}${p.endpointPath}`, maxTotal: c.maxTotal, maxPerCall: c.maxPerCall, maxCalls: c.maxCalls, expiresAt: Date.now() + 600000, license: { uri: 'urn:alsp:probe', sha256: await sha256Text('probe'), acceptance: 'buyer-only' } };
    inputOf(input, p);
    const { quote } = await run.api.probe(run.providerWire, draft, input);
    return { amount: quote.accepted.amount, usdc: usdc(quote.accepted.amount), payTo: quote.accepted.payTo, network: quote.accepted.network, asset: quote.accepted.asset };
  },
  async create_session(args) {
    if (run.sessionId) throw new Error('A session already exists for this run');
    const t = await terms(args);
    if (mode === 'live' && !confirm(`The agent wants to create a session that may spend up to ${usdc(t.maxTotal)} (≤ ${usdc(t.maxPerCall)} per call, ≤ ${t.maxCalls} calls) from ${t.payer} to ${t.provider}. Every payment will still ask your wallet to sign. Allow?`)) throw new Error('Human declined the session terms');
    run.sessionId = await run.journal.create(t, run.provider);
    return { sessionId: run.sessionId, termsHash: await digest(t), ...await summary(run.sessionId) };
  },
  async call({ key, input }) {
    if (!run.sessionId) throw new Error('Create a session first');
    const c = await run.client.call(run.sessionId, key, input);
    return { ...callView(c), note: c.state === 'VERIFIED' ? 'Paid and verified.' : c.wire ? 'Response stored but verification failed (see lastError). If it looks transient (confirmations, RPC), reconcile with recover=false; if the receipt or signer is rejected, it will never verify.' : 'No response was captured; the payment may or may not have settled. Use reconcile with recover=true. Never retry with a new key.' };
  },
  async reconcile({ callId, recover }) {
    const c = run.journal.call(callId);
    let evidence;
    if (recover && !c.wire) {
      if (!run.recover) throw new Error('This provider offers no response lookup. The call stays unresolved until a human attaches the original response in the client.');
      evidence = await run.recover(c.nonce);
      if (!evidence) throw new Error('Provider has no record for this nonce; the payment may never have settled. Leave it unresolved.');
    }
    const r = await run.reconciler.reconcile(callId, evidence);
    return { ...callView(r), recovered: Boolean(evidence) };
  },
  async session_status() { if (!run.sessionId) return { state: 'NO_SESSION' }; return { ...await summary(run.sessionId), calls: run.journal.calls(run.sessionId).map(callView) }; },
  async end_session() { await run.journal.end(run.sessionId); return await summary(run.sessionId); },
  async resume_session() { await run.journal.resume(run.sessionId); return await summary(run.sessionId); },
  async export_archive() {
    const report = await run.journal.export(run.sessionId);
    const chainOk = await verifyChain(report);
    run.archive = report; $('#download').disabled = false;
    return { summary: report.summary, events: report.events.length, headHash: report.headHash, termsHash: report.termsHash, chainIntact: chainOk };
  },
};
async function execTool(block) {
  const card = log(`<div class="tool"><span class="tname">⚙ ${esc(block.name)}</span> <code>${esc(JSON.stringify(block.input))}</code><div class="tresult running">running…</div></div>`, 'toolcall');
  const out = card.querySelector('.tresult');
  try {
    const impl = TOOL_IMPL[block.name]; if (!impl) throw new Error(`Unknown tool ${block.name}`);
    const result = await impl(block.input ?? {});
    out.className = 'tresult ok'; out.innerHTML = `<code>${esc(JSON.stringify(result))}</code>`;
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (e) {
    out.className = 'tresult err'; out.textContent = `error: ${e.message}`;
    return { type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true };
  } finally { renderJournal(); }
}

// ---------- the loop ----------
async function start() {
  if (run && !run.done) return;
  if (!meta?.agent?.enabled) { log('<b>Agent mode is not configured on this deployment.</b> Set <code>ANTHROPIC_API_KEY</code> (and optionally <code>ANTHROPIC_MODEL</code>) in the server environment.', 'bad'); return; }
  $('#transcript').innerHTML = ''; $('#download').disabled = true;
  const journal = new BrowserJournal(memoryStorage());
  let sim = null, provider, providerWire, pins, rpcUrl, w, a, recover = null;
  if (mode === 'sandbox') {
    sim = createSimWorld({ price: '1000', loseResponseOnCall: 2 });
    provider = sim.provider; providerWire = provider; pins = sim.pins; w = sim.wallet; a = sim.api; recover = sim.api.recover;
  } else {
    if (!wallet?.address) { log('<b>Connect a wallet first</b> (Live mode signs real USDC payments).', 'bad'); return; }
    const pin = $('#pin').value.trim(); if (!pin) { log('<b>Enter the receipt signer pin</b> you verified independently.', 'bad'); return; }
    provider = currentProviderJson(); providerWire = provider.id === 'x402-doctor' ? { id: provider.id } : provider; pins = [{ address: pin }]; rpcUrl = $('#rpcUrl').value.trim() || undefined; w = wallet; a = api;
  }
  const onStep = (step, c, err) => { if (step === 'error') { if (c) run.errors.set(c.id, err.message); log(`<span class="muted">journal:</span> ${esc(err.message)} → RECONCILIATION_REQUIRED`, 'warn'); } else if (step === 'reserved') log(`<span class="muted">journal:</span> reserved ${usdc(c.amount)} · nonce ${short(c.nonce)} · asking wallet to sign`, 'muted'); else if (step === 'submitting') log('<span class="muted">journal:</span> submission intent committed → sending once', 'muted'); renderJournal(); };
  const noPayments = async () => { throw new Error('Reconciliation cannot create or send a payment'); };
  run = { journal, sim, provider, providerWire, pins, rpcUrl, wallet: w, api: a, recover, sessionId: null, messages: [], stopped: false, done: false, turns: 0, tokens: 0, archive: null, errors: new Map(),
    client: new BrowserSessionClient(journal, { api: a, wallet: w, pins, rpcUrl, onStep }),
    reconciler: new BrowserSessionClient(journal, { api: { ...a, probe: noPayments, send: noPayments }, wallet: { address: w.address, prepare: noPayments }, pins, rpcUrl, onStep }) };
  const c = caps();
  const context = `Mode: ${mode === 'sandbox' ? 'SANDBOX (simulated provider and wallet; nothing real is paid, but the journal rules are real)' : 'LIVE (real provider, real USDC on ' + provider.network + ', every payment needs the human\'s wallet signature)'}.
Provider: ${provider.label} · endpoint ${provider.origin}${provider.endpointPath} · payTo ${provider.payTo}.
Request parameters this provider accepts: ${provider.id === 'x402-doctor' ? '{"url": "<https url to preflight>", "method": "GET"|"POST"}' : 'flat string map, e.g. {"symbol": "BTC-USDT"}'}.
Payer: ${w.address}. Provider response lookup for reconciliation: ${recover ? 'available' : 'NOT available'}.
Hard caps set by the human (atomic USDC; 1000 = 0.001 USDC): maxTotal ${c.maxTotal}, maxPerCall ${c.maxPerCall}, maxCalls ${c.maxCalls}. Stay at or below these.

Mission: ${$('#mission').value.trim()}`;
  run.messages.push({ role: 'user', content: context });
  log(`<b>Mission</b><pre>${esc(context)}</pre>`, 'mission');
  $('#start').disabled = true; $('#stop').disabled = false; renderJournal();
  try {
    while (!run.stopped && run.turns < MAX_TURNS) {
      run.turns++; setStats();
      const thinkingEl = log('<span class="spinner"></span> thinking…', 'muted');
      let turn;
      try {
        const r = await fetch('/api/agent/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: run.messages }) });
        turn = await r.json(); if (!r.ok) throw new Error(turn.error || `HTTP ${r.status}`);
      } catch (e) { thinkingEl.remove(); log(`<b>Turn failed:</b> ${esc(e.message)}`, 'bad'); break; }
      thinkingEl.remove();
      run.tokens += (turn.usage?.input_tokens ?? 0) + (turn.usage?.output_tokens ?? 0); setStats(turn.model);
      const toolUses = [];
      for (const block of turn.content) {
        if (block.type === 'thinking' && block.thinking) log(`<details><summary>reasoning</summary><div class="think">${esc(block.thinking)}</div></details>`, 'muted');
        else if (block.type === 'text' && block.text.trim()) log(`<div class="agent">${esc(block.text).replace(/\n/g, '<br>')}</div>`, 'agent');
        else if (block.type === 'tool_use') toolUses.push(block);
      }
      run.messages.push({ role: 'assistant', content: turn.content });
      if (turn.stop_reason === 'refusal') { log(`<b>The model declined to continue</b>${turn.stop_details?.category ? ` (${esc(turn.stop_details.category)})` : ''}.`, 'bad'); break; }
      if (turn.stop_reason === 'max_tokens') { log('<b>Turn was cut off at max_tokens.</b>', 'bad'); break; }
      if (turn.stop_reason !== 'tool_use' || !toolUses.length) break;
      const results = [];
      for (const block of toolUses) { if (run.stopped) break; results.push(await execTool(block)); }
      if (run.stopped) break;
      run.messages.push({ role: 'user', content: results });
    }
    if (run.stopped) log('<b>Stopped by the human.</b> The journal keeps every reservation; nothing was retried.', 'warn');
    else if (run.turns >= MAX_TURNS) log(`<b>Turn limit (${MAX_TURNS}) reached.</b>`, 'warn');
    else log('<b>Agent finished.</b>', 'ok');
  } finally { run.done = true; $('#start').disabled = false; $('#stop').disabled = true; renderJournal(); }
}
function setStats(model) { $('#stats').textContent = `turn ${run.turns}/${MAX_TURNS} · ${run.tokens} tokens${model ? ` · ${model}` : ''}`; }

// ---------- journal panel ----------
async function renderJournal() {
  const el = $('#journal');
  if (!run?.sessionId) { el.innerHTML = `<div class="empty">No session yet${run ? ' — the agent decides the terms' : ''}.</div>`; return; }
  const s = run.journal.session(run.sessionId), r = await run.journal.export(run.sessionId), sm = r.summary;
  const tiles = [['State', s.state === 'ACTIVE' ? 'ACTIVE' : sm.state], ['Allocated', usdc(sm.allocatedTotal)], ['Verified', usdc(sm.verifiedSpent)], ['Unresolved', sm.unresolved], ['Calls', `${sm.calls} / ${s.terms.maxCalls}`], ['Chain', `${s.seq} ev · ${short(s.head, 10)}`]];
  el.innerHTML = `<div class="strip">${tiles.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
    <p class="hint">cap ${usdc(s.terms.maxTotal)} · ≤ ${usdc(s.terms.maxPerCall)}/call · ${esc(s.provider.label)} · payer ${short(s.terms.payer)}</p>
    <table><thead><tr><th>key</th><th>input</th><th>state</th><th>amount</th><th>tx</th></tr></thead><tbody>${s.calls.map(c => `<tr><td><code>${esc(c.requestKey)}</code></td><td class="mono">${esc(JSON.stringify(c.input)).slice(0, 60)}</td><td><span class="state ${c.state}">${c.state}</span></td><td>${usdc(c.amount)}</td><td class="mono">${short(c.verified?.ledger.transaction)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No calls yet.</td></tr>'}</tbody></table>
    <table><thead><tr><th>#</th><th>event</th><th>head</th></tr></thead><tbody>${s.events.map(e => `<tr><td>${e.seq}</td><td><code>${esc(e.event.kind)}</code></td><td class="mono">${short(e.head, 14)}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- boot ----------
$('#start').onclick = start;
$('#stop').onclick = () => { if (run) run.stopped = true; };
$('#connect').onclick = connect;
$('#download').onclick = () => { if (!run?.archive) return; const blob = new Blob([JSON.stringify(run.archive, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `alsp-agent-session-${run.sessionId}.json`; a.click(); };
document.querySelectorAll('input[name=mode]').forEach(r => r.onchange = e => setMode(e.target.value));
const signerFromDoc = d => d?.signer ?? d?.address ?? (Array.isArray(d?.signers) ? (d.signers.find(x => x.status === 'current') ?? d.signers[0])?.address : undefined);
$('#usePublishedSigner').onclick = () => { try { const a = signerFromDoc(JSON.parse($('#signerDoc').textContent)); if (!a) throw new Error('no signer address in the document'); $('#pin').value = a; log(`Pin set from the provider's published document: ${esc(a)}. This is trust-on-first-use; compare it with the provider's repository or docs before paying real money.`, 'warn'); } catch (e) { alert(`Fetch the published signer first (${e.message}).`); } };
$('#fetchSigner').onclick = async () => { try { const r = await api.signer(currentProviderJson()); $('#signerDoc').textContent = r.signerDocument ? JSON.stringify(r.signerDocument, null, 2) : 'No signer document published.'; const d = r.signerDocument; const a = signerFromDoc(d); if (a && !$('#pin').value) $('#pin').placeholder = `published: ${a} (verify, then press Use as pin)`; } catch (e) { $('#signerDoc').textContent = e.message; } };
(async () => {
  try {
    meta = await api.meta();
    $('#agentInfo').textContent = meta.agent?.enabled ? `Agent model: ${meta.agent.model}` : 'Agent mode is not configured on this deployment (ANTHROPIC_API_KEY missing).';
    setMode('sandbox');
  } catch (e) { $('#agentInfo').textContent = `Could not load server metadata: ${e.message}`; }
})();
