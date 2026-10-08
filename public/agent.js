// Watch an AI agent (Claude) run a whole ALSP mission: one spend cap across several paid providers,
// one journaled session per provider. The model only decides; every tool runs here, in the browser,
// on the real journal. Sandbox mode uses in-page simulated providers and a simulated wallet; Live mode
// uses real providers through the proxy and your wallet (or a disposable session wallet) for signatures.
import { BrowserJournal, BrowserSessionClient, PROFILE, digest, injectedWallet, inputOf, serverApi, sha256Text, verifyMissionChain } from './alsp-browser.js';
import { createSimWorld, memoryStorage, naiveRun } from './sim.js';
import { mountSessionWallet } from './session-wallet.js';
import { isUnsigned } from './providers.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 12) => s ? `${String(s).slice(0, n)}…` : '—';
const usdc = a => `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
const MAX_TURNS = 30;
const dayStart = daysAgo => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000) - daysAgo * 86400; };
const LAST_DAYS = Array.from({ length: 5 }, (_, i) => { const ts = dayStart(i + 1); return { date: new Date(ts * 1000).toISOString().slice(0, 10), at: String(ts) }; });
const DAYS_TEXT = LAST_DAYS.map(d => `${d.date} (at=${d.at})`).join(', ');
const fillDays = t => String(t ?? '').replace('{{LAST_5_DAYS}}', DAYS_TEXT);
const inputLabel = i => Object.entries(i ?? {}).map(([k, v]) => `${k}=${v}`).join('&') || '(none)';

// Sandbox counterpart of each product: one simulated provider per role, with the candle role losing its first response.
const SANDBOX_WORLDS = {
  'btc-brief': [{ role: 'price', kind: 'price', price: '1000', input: { coins: 'BTC' } }, { role: 'candle', kind: 'candle', price: '2000', input: {}, loseResponseOnCall: 1 }, { role: 'news', kind: 'news', price: '1000', input: {} }],
  'btc-history': [{ role: 'price', kind: 'price', price: '1000', input: { coins: 'BTC' }, loseResponseOnCall: 2 }],
};

let meta = null, api = serverApi(''), wallet = null, mode = 'sandbox', payerMode = 'injected', sessionBox = null;
let liveProviders = []; // [{ role, profile, input, label, price }]
let run = null;

const log = (html, cls = '', text = null) => { const el = document.createElement('div'); el.className = `entry ${cls}`; el.innerHTML = html; $('#transcript').appendChild(el); el.scrollIntoView({ block: 'end' }); if (run) run.transcript.push({ cls, text: text ?? el.textContent }); return el; };
const logLine = (text, cls = '') => log(esc(text), cls, text);

// ---------- setup ----------
function caps() { return { maxTotal: $('#maxTotal').value.trim(), maxPerCall: $('#maxPerCall').value.trim(), maxCalls: Number($('#maxCalls').value) }; }
function product() { return meta.products.find(p => p.id === $('#product').value) ?? meta.products[0]; }
function setMode(m) { mode = m; document.body.dataset.mode = m; applyProduct(); }
function applyProduct() {
  const p = product();
  $('#mission').value = fillDays(p.mission); $('#maxTotal').value = p.caps.maxTotal; $('#maxPerCall').value = p.caps.maxPerCall; $('#maxCalls').value = p.caps.maxCalls;
  $('#productNote').textContent = p.note;
  if (mode === 'live') loadLiveProviders(p).catch(e => logLine(`Provider discovery failed: ${e.message}`, 'bad'));
}
async function loadLiveProviders(p) {
  liveProviders = []; renderProviderList('discovering…');
  for (const entry of p.providers) {
    const t = meta.templates.find(x => x.id === entry.template);
    try { const r = await api.discover(t.url); liveProviders.push({ role: entry.role, profile: r.profile, input: { ...r.input, ...entry.input }, label: t.label, price: r.quote.amount }); }
    catch (e) { liveProviders.push({ role: entry.role, error: e.message, label: t.label }); }
    renderProviderList();
  }
  const rpc = liveProviders.find(x => x.profile)?.profile.network; if (rpc) $('#rpcUrl').value = meta.defaultRpc[rpc] ?? $('#rpcUrl').value;
}
function renderProviderList(note) {
  const el = $('#providerList');
  if (!liveProviders.length) { el.innerHTML = `<li class="muted">${esc(note ?? 'No providers yet.')}</li>`; return; }
  el.innerHTML = liveProviders.map((x, i) => x.profile ? `<li><b>${esc(x.role)}</b> <span>${esc(x.profile.label)} · ${usdc(x.price)} · ${isUnsigned(x.profile) ? 'unsigned' : 'signed'} · payTo <code>${short(x.profile.payTo, 10)}</code> · <code>${esc(inputLabel(x.input))}</code></span><button data-rm="${i}">×</button></li>` : `<li><b>${esc(x.role)}</b> <span class="bad">${esc(x.label)}: ${esc(x.error)}</span><button data-rm="${i}">×</button></li>`).join('');
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { liveProviders.splice(Number(b.dataset.rm), 1); renderProviderList(); });
}
async function addProvider() {
  const url = $('#discoverUrl').value.trim(), role = $('#discoverRole').value.trim() || `p${liveProviders.length + 1}`;
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(role)) return alert('role id: lowercase letters, digits, dashes');
  if (liveProviders.some(x => x.role === role)) return alert('role already used');
  try { const r = await api.discover(url); liveProviders.push({ role, profile: r.profile, input: r.input, label: r.profile.label, price: r.quote.amount }); renderProviderList(); } catch (e) { alert(e.message); }
}
async function connect() { try { wallet = injectedWallet(); const a = await wallet.connect(); $('#wallet').textContent = a; $('#connect').textContent = 'Connected'; } catch (e) { alert(e.message); } }
function setPayer(m) {
  payerMode = m; $('#sessionWalletBox').hidden = m !== 'session';
  if (m === 'session' && !sessionBox) {
    sessionBox = mountSessionWallet($('#sessionWalletBox'), { api, log: logLine, chain: () => { const p = liveProviders.find(x => x.profile)?.profile; return { network: p?.network ?? 'eip155:8453', asset: p?.asset ?? { address: meta.presets['x402-doctor'].asset.address, name: 'USD Coin', version: '2' }, rpcUrl: $('#rpcUrl').value.trim() || undefined }; }, injected: () => wallet?.address ? { ethereum: globalThis.ethereum, address: wallet.address } : null });
    sessionBox.refresh();
  }
}

// ---------- tools (all on the real browser journal) ----------
const stringMap = v => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).map(([k, x]) => [k, typeof x === 'string' ? x : String(x)]));
const prov = role => { const p = run.providers[role]; if (!p) throw new Error(`Unknown provider role "${role}"; use list_providers`); return p; };
const sessionOf = role => { const p = prov(role); if (!p.sessionId) throw new Error(`No session for provider "${role}" yet; create_session first`); return p.sessionId; };
const summary = async () => {
  const m = run.journal.mission(run.missionId), db = run.journal.load();
  const allocated = run.journal.missionAllocated(m, db).toString();
  const sessions = [];
  for (const [role, p] of Object.entries(run.providers)) if (p.sessionId) { const r = await run.journal.export(p.sessionId), s = run.journal.session(p.sessionId); sessions.push({ provider: role, sessionId: p.sessionId, state: s.state === 'ACTIVE' ? 'ACTIVE' : r.summary.state, allocated: r.summary.allocatedTotal, verifiedSpent: r.summary.verifiedSpent, unresolved: r.summary.unresolved, calls: r.summary.calls, maxCalls: s.terms.maxCalls, sessionCap: s.terms.maxTotal }); }
  return { missionState: m.state, missionCap: m.maxTotal, allocated, remaining: (BigInt(m.maxTotal) - BigInt(allocated)).toString(), verifiedSpent: sessions.reduce((t, s) => t + BigInt(s.verifiedSpent), 0n).toString(), unresolved: sessions.reduce((t, s) => t + s.unresolved, 0), sessions };
};
const callView = c => ({ callId: c.id, key: c.requestKey, input: c.input, state: c.state, amount: c.amount, hasStoredResponse: Boolean(c.wire), lastError: c.state === 'VERIFIED' ? null : (run.errors.get(c.id) ?? null), tx: c.verified?.ledger.transaction ?? null, receiptId: c.verified?.receipt.requestId ?? null, response: c.state === 'VERIFIED' ? (({ receipt: _r, ...rest }) => rest)(c.wire.body) : null });
async function termsFor(p, args) {
  const c = caps(), prof = p.profile;
  const maxTotal = String(args.maxTotal), maxPerCall = String(args.maxPerCall), maxCalls = Number(args.maxCalls), ttl = Number(args.ttlSeconds);
  if (!/^[1-9]\d{0,11}$/.test(maxTotal) || !/^[1-9]\d{0,11}$/.test(maxPerCall)) throw new Error('Amounts must be positive atomic integer strings');
  if (BigInt(maxTotal) > BigInt(c.maxTotal) || BigInt(maxPerCall) > BigInt(c.maxPerCall) || maxCalls > c.maxCalls) throw new Error(`Above the human's limits: session maxTotal ≤ ${c.maxTotal} (mission cap), maxPerCall ≤ ${c.maxPerCall}, maxCalls ≤ ${c.maxCalls}`);
  return { profile: PROFILE, payer: run.wallet.address, provider: prof.payTo, network: prof.network, asset: prof.asset.address, endpoint: `${prof.origin}${prof.endpointPath}`, maxTotal, maxPerCall, maxCalls, expiresAt: Date.now() + ttl * 1000, license: { uri: 'urn:alsp:agent:locally-reviewed-terms', sha256: await sha256Text(String(args.licenseNote)), acceptance: 'buyer-only' } };
}
const TOOL_IMPL = {
  async list_providers() { return Object.entries(run.providers).map(([role, p]) => ({ provider: role, label: p.profile.label, endpoint: `${p.profile.origin}${p.profile.endpointPath}`, receipts: isUnsigned(p.profile) ? 'unsigned (ledger evidence only)' : 'signed', knownPrice: p.price ?? null, exampleInput: p.input, responseLookup: Boolean(p.recover), session: p.sessionId ? 'open' : 'none' })); },
  async probe_quote({ provider, input }) {
    input = stringMap(input); const p = prov(provider), c = caps(), prof = p.profile;
    const draft = { profile: PROFILE, payer: run.wallet.address, provider: prof.payTo, network: prof.network, asset: prof.asset.address, endpoint: `${prof.origin}${prof.endpointPath}`, maxTotal: c.maxTotal, maxPerCall: c.maxPerCall, maxCalls: c.maxCalls, expiresAt: Date.now() + 600000, license: { uri: 'urn:alsp:probe', sha256: await sha256Text('probe'), acceptance: 'buyer-only' } };
    inputOf(input, prof);
    const { quote } = await p.api.probe(p.wire, draft, input);
    return { provider, amount: quote.accepted.amount, usdc: usdc(quote.accepted.amount), payTo: quote.accepted.payTo, network: quote.accepted.network, asset: quote.accepted.asset };
  },
  async create_session(args) {
    const p = prov(args.provider);
    if (p.sessionId) throw new Error(`Provider "${args.provider}" already has session ${p.sessionId}`);
    const t = await termsFor(p, args);
    if (mode === 'live' && !confirm(`The agent wants a session with ${p.profile.label} that may spend up to ${usdc(t.maxTotal)} (≤ ${usdc(t.maxPerCall)} per call, ≤ ${t.maxCalls} calls) from ${t.payer} to ${t.provider}. Mission cap stays ${usdc(caps().maxTotal)}. Allow?`)) throw new Error('Human declined the session terms');
    p.sessionId = await run.journal.create(t, p.profile, Date.now(), { missionId: run.missionId });
    return { provider: args.provider, sessionId: p.sessionId, termsHash: await digest(t), ...await summary() };
  },
  async call({ provider, key, input }) {
    input = stringMap(input); const p = prov(provider), sid = sessionOf(provider);
    const c = await p.client.call(sid, key, input);
    return { provider, ...callView(c), note: c.state === 'VERIFIED' ? 'Paid and verified.' : c.wire ? 'Response stored but verification failed (see lastError). Transient → reconcile recover=false; receipt/signer rejected → final.' : 'No response was captured; the payment may or may not have settled. Use reconcile with recover=true. Never retry with a new key.' };
  },
  async reconcile({ callId, recover }) {
    const c = run.journal.call(callId); const role = Object.keys(run.providers).find(r => run.providers[r].sessionId === c.sessionId); const p = prov(role);
    let evidence;
    if (recover && !c.wire) {
      if (!p.recover) throw new Error('This provider offers no response lookup. The call stays unresolved until a human attaches the original response in the client.');
      evidence = await p.recover(c.nonce);
      if (!evidence) throw new Error('Provider has no record for this nonce; the payment may never have settled. Leave it unresolved.');
    }
    const r = await p.reconciler.reconcile(callId, evidence);
    return { provider: role, ...callView(r), recovered: Boolean(evidence) };
  },
  async session_status() { const s = await summary(); for (const x of s.sessions) x.callsDetail = run.journal.calls(x.sessionId).map(callView); return s; },
  async end_session({ provider }) { await run.journal.end(sessionOf(provider)); return await summary(); },
  async resume_session({ provider }) { await run.journal.resume(sessionOf(provider)); return await summary(); },
  async end_mission() { await run.journal.endMission(run.missionId); return await summary(); },
  async export_archive() {
    const a = await run.journal.exportMission(run.missionId); run.archive = a; $('#download').disabled = false;
    return { summary: a.summary, missionEvents: a.events.length, sessionEvents: a.sessions.map(s => ({ provider: s.provider.id, events: s.events.length, head: s.headHash })), headHash: a.headHash, termsHash: a.termsHash, chainIntact: await verifyMissionChain(a) };
  },
};
async function execTool(block) {
  const card = log(`<div class="tool"><span class="tname">⚙ ${esc(block.name)}</span> <code>${esc(JSON.stringify(block.input))}</code><div class="tresult running">running…</div></div>`, 'toolcall', `⚙ ${block.name} ${JSON.stringify(block.input)}`);
  const out = card.querySelector('.tresult');
  try {
    const impl = TOOL_IMPL[block.name]; if (!impl) throw new Error(`Unknown tool ${block.name}`);
    const result = await impl(block.input ?? {});
    out.className = 'tresult ok'; out.innerHTML = `<code>${esc(JSON.stringify(result))}</code>`; run.transcript.push({ cls: 'toolresult', text: JSON.stringify(result).slice(0, 4000) });
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (e) {
    out.className = 'tresult err'; out.textContent = `error: ${e.message}`; run.transcript.push({ cls: 'toolerror', text: `error: ${e.message}` });
    return { type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true };
  } finally { renderJournal(); }
}

// ---------- the loop ----------
async function start() {
  if (run && !run.done) return;
  if (!meta?.agent?.enabled) { log('<b>Agent mode is not configured on this deployment.</b> Set <code>ANTHROPIC_API_KEY</code> in the server environment.', 'bad'); return; }
  $('#transcript').innerHTML = ''; $('#download').disabled = true; $('#logLink').textContent = ''; $('#comparePanel').hidden = true;
  const journal = new BrowserJournal(memoryStorage());
  const noPayments = async () => { throw new Error('Reconciliation cannot create or send a payment'); };
  const providers = {}; let w, chainNetwork;
  const p = product();
  run = { journal, providers, missionId: null, messages: [], stopped: false, done: false, turns: 0, tokens: 0, archive: null, errors: new Map(), transcript: [], sims: [], product: p };
  const onStep = (step, c, err) => { if (step === 'error') { if (c) run.errors.set(c.id, err.message); logLine(`journal: ${err.message} → RECONCILIATION_REQUIRED`, 'warn'); } else if (step === 'reserved') logLine(`journal: reserved ${usdc(c.amount)} · nonce ${short(c.nonce)} · signing`, 'muted'); else if (step === 'submitting') logLine('journal: submission intent committed → sending once', 'muted'); renderJournal(); };
  if (mode === 'sandbox') {
    const worlds = SANDBOX_WORLDS[p.id] ?? SANDBOX_WORLDS['btc-brief'];
    for (const spec of worlds) {
      const sim = createSimWorld({ price: spec.price, kind: spec.kind, role: spec.role, loseResponseOnCall: spec.loseResponseOnCall ?? 0 });
      run.sims.push({ role: spec.role, sim, spec });
      w = w ?? sim.wallet; chainNetwork = sim.provider.network;
      providers[spec.role] = { profile: sim.provider, wire: sim.provider, input: spec.input, price: spec.price, api: sim.api, recover: sim.api.recover, pins: sim.pins, sessionId: null,
        client: new BrowserSessionClient(journal, { api: sim.api, wallet: sim.wallet, pins: sim.pins, onStep }), reconciler: new BrowserSessionClient(journal, { api: { ...sim.api, probe: noPayments, send: noPayments }, wallet: { address: sim.wallet.address, prepare: noPayments }, pins: sim.pins, onStep }) };
    }
  } else {
    const payer = payerMode === 'session' ? sessionBox?.wallet : wallet;
    if (!payer?.address) { log(payerMode === 'session' ? '<b>Session wallet not ready.</b>' : '<b>Connect a wallet first</b> (Live mode signs real USDC payments).', 'bad'); return; }
    const ready = liveProviders.filter(x => x.profile);
    if (!ready.length) { log('<b>No usable providers.</b> Pick a product or add a provider.', 'bad'); return; }
    const pin = $('#pin').value.trim();
    if (ready.some(x => !isUnsigned(x.profile)) && !pin) { log('<b>Enter the receipt signer pin</b> for the signed-receipt provider(s).', 'bad'); return; }
    const rpcUrl = $('#rpcUrl').value.trim() || undefined, pins = pin ? [{ address: pin }] : [];
    w = payer; chainNetwork = ready[0].profile.network;
    for (const x of ready) {
      const wire = x.profile.id === 'x402-doctor' ? { id: x.profile.id } : x.profile;
      providers[x.role] = { profile: x.profile, wire, input: x.input, price: x.price, api, recover: null, pins, sessionId: null,
        client: new BrowserSessionClient(journal, { api, wallet: payer, pins, rpcUrl, onStep }), reconciler: new BrowserSessionClient(journal, { api: { ...api, probe: noPayments, send: noPayments }, wallet: { address: payer.address, prepare: noPayments }, pins, rpcUrl, onStep }) };
    }
    if (payerMode === 'session') { await sessionBox.refresh(); log(`<b>Disposable session wallet</b> ${esc(payer.address)} pays; the agent signs without prompts. Its balance is the real limit.`, 'warn'); }
  }
  run.wallet = w;
  const c = caps();
  run.missionId = await journal.createMission({ label: p.label, maxTotal: c.maxTotal, payer: w.address, network: chainNetwork });
  const context = `Mode: ${mode === 'sandbox' ? 'SANDBOX (simulated providers and wallet; nothing real is paid, but the journal rules are real)' : `LIVE (real providers, real USDC on ${chainNetwork}; ${payerMode === 'session' ? 'the disposable session wallet signs automatically; its USDC balance is the real limit' : "the human's wallet signs each payment"})`}.
Mission id ${run.missionId}. Mission cap ${c.maxTotal} atomic (${usdc(c.maxTotal)}) across all providers; per session: maxPerCall ≤ ${c.maxPerCall}, maxCalls ≤ ${c.maxCalls}. 1000 atomic = 0.001 USDC.
Providers (call list_providers for details): ${Object.entries(providers).map(([r, x]) => `${r} = ${x.profile.label} (${x.price ? usdc(x.price) : 'price unknown'} per call, ${isUnsigned(x.profile) ? 'unsigned receipts' : 'signed receipts'}, example input ${JSON.stringify(x.input)})`).join('; ')}.
Payer: ${w.address}. Today (UTC): ${new Date().toISOString()}. Last five UTC days with their 00:00 unix timestamps: ${DAYS_TEXT}.

Mission: ${$('#mission').value.trim()}`;
  run.messages.push({ role: 'user', content: context });
  log(`<b>Mission</b><pre>${esc(context)}</pre>`, 'mission', context);
  $('#start').disabled = true; $('#stop').disabled = false; renderJournal();
  let outcome = 'finished';
  try {
    while (!run.stopped && run.turns < MAX_TURNS) {
      run.turns++; setStats();
      const thinkingEl = log('<span class="spinner"></span> thinking…', 'muted', '');
      let turn;
      try {
        const r = await fetch('/api/agent/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: run.messages }) });
        turn = await r.json(); if (!r.ok) throw new Error(turn.error || `HTTP ${r.status}`);
      } catch (e) { thinkingEl.remove(); run.transcript.pop(); log(`<b>Turn failed:</b> ${esc(e.message)}`, 'bad'); outcome = 'turn-failed'; break; }
      thinkingEl.remove(); run.transcript.pop();
      run.tokens += (turn.usage?.input_tokens ?? 0) + (turn.usage?.output_tokens ?? 0); setStats(turn.model);
      const toolUses = [];
      for (const block of turn.content) {
        if (block.type === 'thinking' && block.thinking) log(`<details><summary>reasoning</summary><div class="think">${esc(block.thinking)}</div></details>`, 'muted', `reasoning: ${block.thinking}`);
        else if (block.type === 'text' && block.text.trim()) log(`<div class="agent">${esc(block.text).replace(/\n/g, '<br>')}</div>`, 'agent', block.text);
        else if (block.type === 'tool_use') toolUses.push(block);
      }
      run.messages.push({ role: 'assistant', content: turn.content });
      if (turn.stop_reason === 'refusal') { log(`<b>The model declined to continue</b>${turn.stop_details?.category ? ` (${esc(turn.stop_details.category)})` : ''}.`, 'bad'); outcome = 'refusal'; break; }
      if (turn.stop_reason === 'max_tokens') { log('<b>Turn was cut off at max_tokens.</b>', 'bad'); outcome = 'max-tokens'; break; }
      if (turn.stop_reason !== 'tool_use' || !toolUses.length) break;
      const results = [];
      for (const block of toolUses) { if (run.stopped) break; results.push(await execTool(block)); }
      if (run.stopped) break;
      run.messages.push({ role: 'user', content: results });
    }
    if (run.stopped) { log('<b>Stopped by the human.</b> The journal keeps every reservation; nothing was retried.', 'warn'); outcome = 'stopped'; }
    else if (run.turns >= MAX_TURNS) { log(`<b>Turn limit (${MAX_TURNS}) reached.</b>`, 'warn'); outcome = 'turn-limit'; }
    else if (outcome === 'finished') log('<b>Agent finished.</b>', 'ok');
    if (mode === 'sandbox') await renderComparison();
  } finally { run.done = true; $('#start').disabled = false; $('#stop').disabled = true; renderJournal(); await publishLog(outcome).catch(e => logLine(`Log upload failed: ${e.message}`, 'warn')); }
}
function setStats(model) { $('#stats').textContent = `turn ${run.turns}/${MAX_TURNS} · ${run.tokens} tokens${model ? ` · ${model}` : ''}`; }

// ---------- the same product without ALSP ----------
async function renderComparison() {
  const panel = $('#comparePanel'), el = $('#compare');
  panel.hidden = false; el.innerHTML = '<span class="spinner"></span> replaying the same product with a plain x402 retry loop…';
  let naive = { payments: 0, spent: 0n, doublePaid: 0, missing: 0 }, sessionPayments = 0, labels = [];
  for (const { role, sim, spec } of run.sims) {
    const sid = run.providers[role].sessionId, inputs = sid ? run.journal.calls(sid).map(c => c.input) : [spec.input];
    const n = await naiveRun({ inputs, price: spec.price, loseResponseOnCall: spec.loseResponseOnCall ?? 0 });
    naive.payments += n.payments; naive.spent += BigInt(n.spent); naive.doublePaid += n.doublePaid; naive.missing += n.rows.filter(r => !r.got).length; sessionPayments += sim.world.paid;
    labels.push(`${role}: ${inputs.map(inputLabel).join(', ')}`);
  }
  const a = await run.journal.exportMission(run.missionId), m = run.journal.mission(run.missionId);
  const alsp = { payments: sessionPayments, spent: a.summary.allocatedTotal, doublePaid: sessionPayments - a.summary.calls, unresolved: a.summary.unresolved, events: a.events.length + a.sessions.reduce((t, s) => t + s.events.length, 0), head: a.headHash, cap: m.maxTotal };
  run.comparison = { payments: naive.payments, spent: naive.spent.toString(), doublePaid: naive.doublePaid, missing: naive.missing };
  const row = (label, x, y, good) => `<tr><th>${label}</th><td class="${good === 'b' ? 'badc' : ''}">${x}</td><td class="${good === 'b' ? 'good' : ''}">${y}</td></tr>`;
  el.innerHTML = `<p class="hint">Same product (${esc(labels.join(' · '))}), same prices, same lost response. Left: a plain x402 client that retries on error, one loop per provider. Right: this ALSP mission.</p>
    <table class="cmp"><thead><tr><th></th><th>Plain x402 retry loops</th><th>ALSP mission</th></tr></thead><tbody>
    ${row('Payments settled by the providers', naive.payments, alsp.payments, naive.payments > alsp.payments ? 'b' : '')}
    ${row('USDC spent', usdc(naive.spent), usdc(alsp.spent), naive.spent > BigInt(alsp.spent) ? 'b' : '')}
    ${row('Paid twice for one answer', naive.doublePaid, alsp.doublePaid, naive.doublePaid > alsp.doublePaid ? 'b' : '')}
    ${row('Spend cap across providers', 'none (each loop keeps paying)', `${usdc(alsp.cap)} mission cap enforced before signing`, 'b')}
    ${row('Lost response handled by', 'paying again', 'reconciling the original evidence', 'b')}
    ${row('Answers without a verified payment', naive.missing, alsp.unresolved, '')}
    ${row('Evidence left behind', 'none', `mission chain + ${a.sessions.length} session chains (${alsp.events} events), head ${short(alsp.head, 14)}`, 'b')}
    </tbody></table>
    <p class="hint">Scale it: a 1,000-call job with a 1% timeout rate overpays ~10 times and nobody can prove what was bought from whom. With a mission the cap is one hard stop across every provider, every retry is free, and the archive is the invoice.</p>`;
}

// ---------- central log ----------
async function publishLog(outcome) {
  if (!meta?.logs?.enabled) return;
  const a = run.archive ?? (run.missionId ? await run.journal.exportMission(run.missionId) : null);
  const summary = { mode, product: run.product.id, outcome, turns: run.turns, tokens: run.tokens, providers: Object.keys(run.providers), payer: run.wallet?.address, allocated: a?.summary.allocatedTotal, verifiedSpent: a?.summary.verifiedSpent, unresolved: a?.summary.unresolved, calls: a?.summary.calls, payments: mode === 'sandbox' ? run.sims.reduce((t, x) => t + x.sim.world.paid, 0) : a?.summary.calls, headHash: a?.headHash };
  const r = await api.logs.put({ kind: 'agent-run', title: `${mode} · ${run.product.label} · ${outcome}`, origin: location.host, summary, payload: { mission: run.messages[0]?.content, transcript: run.transcript, archive: a, comparison: run.comparison ?? null } });
  $('#logLink').innerHTML = `Published to <a href="./logs.html?id=${encodeURIComponent(r.id)}">run logs</a>.`;
}

// ---------- journal panel ----------
async function renderJournal() {
  const el = $('#journal');
  if (!run?.missionId) { el.innerHTML = '<div class="empty">No mission yet.</div>'; return; }
  const a = await run.journal.exportMission(run.missionId), m = run.journal.mission(run.missionId);
  const tiles = [['Mission', m.state === 'ACTIVE' ? 'ACTIVE' : a.summary.state], ['Cap', usdc(m.maxTotal)], ['Allocated', usdc(a.summary.allocatedTotal)], ['Verified', usdc(a.summary.verifiedSpent)], ['Unresolved', a.summary.unresolved], ['Sessions', a.sessions.length]];
  let html = `<div class="strip">${tiles.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div><p class="hint">mission ${short(run.missionId, 8)} · head ${short(m.head, 14)} · ${m.events.length} mission events</p>`;
  for (const s of a.sessions) {
    const role = Object.keys(run.providers).find(r => run.providers[r].sessionId === s.sessionId);
    html += `<h3>${esc(role)} · ${esc(s.provider.label)} <span class="state ${s.summary.state}">${s.summary.state}</span></h3><p class="hint">cap ${usdc(s.terms.maxTotal)} · ${s.summary.calls}/${s.terms.maxCalls} calls · ${s.events.length} events · head ${short(s.headHash, 12)}</p>
      <table><thead><tr><th>key</th><th>input</th><th>state</th><th>amount</th><th>tx</th></tr></thead><tbody>${run.journal.calls(s.sessionId).map(c => `<tr><td><code>${esc(c.requestKey)}</code></td><td class="mono">${esc(inputLabel(c.input)).slice(0, 48)}</td><td><span class="state ${c.state}">${c.state}</span></td><td>${usdc(c.amount)}</td><td class="mono">${short(c.verified?.ledger.transaction)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No calls yet.</td></tr>'}</tbody></table>`;
  }
  el.innerHTML = html;
}

// ---------- boot ----------
$('#start').onclick = start;
$('#stop').onclick = () => { if (run) run.stopped = true; };
$('#connect').onclick = connect;
$('#discoverBtn').onclick = addProvider;
$('#download').onclick = () => { if (!run?.archive) return; const blob = new Blob([JSON.stringify(run.archive, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `alsp-mission-${run.missionId}.json`; a.click(); };
document.querySelectorAll('input[name=mode]').forEach(r => r.onchange = e => setMode(e.target.value));
document.querySelectorAll('input[name=payer]').forEach(r => r.onchange = e => setPayer(e.target.value));
$('#product').onchange = applyProduct;
(async () => {
  try {
    meta = await api.meta();
    $('#agentInfo').textContent = meta.agent?.enabled ? `Agent model: ${meta.agent.model}${meta.logs?.enabled ? ' · logs on' : ' · logs off'}` : 'Agent mode is not configured on this deployment (ANTHROPIC_API_KEY missing).';
    for (const p of meta.products) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; $('#product').appendChild(o); }
    setMode('sandbox');
  } catch (e) { $('#agentInfo').textContent = `Could not load server metadata: ${e.message}`; }
})();
