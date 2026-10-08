import { serverApi, verifyChain, verifyMissionChain } from './alsp-browser.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 12) => s ? `${String(s).slice(0, n)}…` : '—';
const usdc = a => `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
const api = serverApi('');
let entries = [], filter = 'all', selected = null;

const tile = (k, v) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;

function renderList() {
  const kinds = ['all', ...new Set(entries.map(e => e.kind))];
  $('#filters').innerHTML = kinds.map(k => `<button class="${k === filter ? 'on' : ''}" data-k="${k}">${k}${k === 'all' ? ` (${entries.length})` : ` (${entries.filter(e => e.kind === k).length})`}</button>`).join('');
  $('#filters').querySelectorAll('button').forEach(b => b.onclick = () => { filter = b.dataset.k; renderList(); });
  const shown = entries.filter(e => filter === 'all' || e.kind === filter);
  $('#list').innerHTML = shown.length ? shown.map(e => `<button class="entry ${e.id === selected ? 'active' : ''}" data-id="${esc(e.id)}"><span class="kind">${esc(e.kind)}</span>${esc(e.title)}<br><small>${new Date(e.at).toLocaleString()} · ${(e.size / 1024).toFixed(1)} KB</small></button>`).join('') : '<div class="empty">No entries yet. Agent runs, measurements and exported archives appear here.</div>';
  $('#list').querySelectorAll('.entry').forEach(b => b.onclick = () => open(b.dataset.id));
}
async function open(id) {
  selected = id; renderList();
  const el = $('#detail'); el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const log = await api.logs.get(id);
    if (log.error) throw new Error(log.error);
    const s = log.summary ?? {}, p = log.payload ?? {};
    let head = `<p><span class="kind">${esc(log.kind)}</span><b>${esc(log.title)}</b><br><span class="muted">${new Date(log.at).toLocaleString()}${log.origin ? ` · ${esc(log.origin)}` : ''} · <code>${esc(id)}</code></span></p>`;
    let body = '';
    if (log.kind === 'agent-run') {
      body += `<div class="strip">${tile('Mode', s.mode)}${tile('Outcome', s.outcome)}${tile('Turns', s.turns)}${tile('Tokens', s.tokens)}${tile('Allocated', s.allocated !== undefined ? usdc(s.allocated) : '—')}${tile('Verified', s.verifiedSpent !== undefined ? usdc(s.verifiedSpent) : '—')}${tile('Unresolved', s.unresolved ?? '—')}${tile('Providers', (s.providers ?? []).join(', ') || '—')}</div>`;
      if (p.comparison) body += `<p class="hint muted">Plain x402 replay: ${p.comparison.payments} payments, ${usdc(p.comparison.spent)}, ${p.comparison.doublePaid} double-paid · session: ${s.payments ?? '—'} payments, ${usdc(s.allocated ?? 0)}.</p>`;
      if (p.archive) { const ok = p.archive.kind === 'mission' ? await verifyMissionChain(p.archive) : await verifyChain(p.archive); body += `<p>Archive chain ${ok ? '<span class="ok">intact</span>' : '<span class="bad">BROKEN</span>'} · head <code>${esc(p.archive.headHash)}</code></p>`; }
      if (Array.isArray(p.transcript)) body += `<details open><summary>Transcript (${p.transcript.length} entries)</summary><div class="transcript">${p.transcript.map(t => `<div class="${esc(t.cls || '')}">${esc(t.text)}</div>`).join('')}</div></details>`;
    } else if (log.kind === 'measurement') {
      body += `<div class="strip">${tile('Calls', s.calls)}${tile('Verified', s.verified)}${tile('Ambiguous', s.ambiguous)}${tile('Ambiguity rate', s.calls ? `${((s.ambiguous / s.calls) * 100).toFixed(1)}%` : '—')}${tile('Spent', usdc(s.spent ?? 0))}${tile('Providers', s.providers ?? '—')}</div>`;
      if (Array.isArray(p.perProvider)) body += `<table><thead><tr><th>provider</th><th>calls</th><th>verified</th><th>lost response</th><th>verify failed</th><th>refused</th><th>after reconcile</th><th>p50 ms</th><th>spent</th></tr></thead><tbody>${p.perProvider.map(r => `<tr><td>${esc(r.provider)}</td><td>${r.calls}</td><td class="ok">${r.verified}</td><td class="warn">${r.lostResponse}</td><td class="warn">${r.verifyFailed}</td><td>${r.refused}</td><td>${r.unresolvedAfterReconcile}</td><td>${r.p50}</td><td>${usdc(r.spent)}</td></tr>`).join('')}</tbody></table>`;
      if (Array.isArray(p.rows)) body += `<details><summary>Per-call rows (${p.rows.length})</summary><table><thead><tr><th>#</th><th>provider</th><th>state</th><th>ms</th><th>error</th><th>tx</th></tr></thead><tbody>${p.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.provider)}</td><td>${esc(r.state)}</td><td>${r.ms}</td><td class="muted">${esc(r.error ?? '')}</td><td class="mono">${short(r.tx)}</td></tr>`).join('')}</tbody></table></details>`;
    } else if (log.kind === 'session' || log.kind === 'mission') {
      const a = p.archive ?? p;
      const ok = a.kind === 'mission' ? await verifyMissionChain(a) : await verifyChain(a);
      body += `<div class="strip">${tile('State', a.summary?.state)}${tile('Allocated', usdc(a.summary?.allocatedTotal ?? 0))}${tile('Verified', usdc(a.summary?.verifiedSpent ?? 0))}${tile('Unresolved', a.summary?.unresolved)}${tile('Calls', a.summary?.calls)}${tile('Chain', ok ? 'intact' : 'BROKEN')}</div><p>head <code>${esc(a.headHash)}</code>${a.buyerSeal ? ` · sealed by <code>${esc(a.buyerSeal.signer)}</code>` : ''}</p>`;
    }
    body += `<details><summary>Summary JSON</summary><pre>${esc(JSON.stringify(s, null, 2))}</pre></details><details><summary>Raw payload</summary><pre>${esc(JSON.stringify(p, null, 2).slice(0, 200000))}</pre></details>`;
    el.innerHTML = head + body;
  } catch (e) { el.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
}
(async () => {
  try {
    const r = await api.logs.list(300);
    $('#status').textContent = r.enabled ? `${r.backend} · ${r.entries.length} entries` : 'logs not configured on this deployment (connect a Vercel Blob store)';
    entries = r.entries; renderList();
    const id = new URLSearchParams(location.search).get('id'); if (id) open(id);
  } catch (e) { $('#status').textContent = e.message; }
})();
