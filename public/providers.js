// Provider picker shared by the client and the agent page: Doctor preset (signed receipts),
// known templates and "discover any x402 URL", both resolved live from the resource's own 402.
export function mountProviderPicker(els, { meta, api, log }) {
  const { select, json, input, rpc, discoverRow, url, button, note } = els;
  const setNote = t => { if (note) note.textContent = t; };
  function apply(profile, params, hint) {
    json.value = JSON.stringify(profile, null, 2);
    if (input) input.value = JSON.stringify(params, null, 2);
    if (rpc) rpc.value = meta.defaultRpc[profile.network] ?? '';
    setNote(hint);
    els.onChange?.(profile);
  }
  async function discover(target) {
    if (!/^https:\/\//.test(target)) throw new Error('Enter a public https:// URL that answers with x402 402');
    setNote('Discovering…');
    const r = await api.discover(target);
    apply(r.profile, r.input, `${r.profile.label}: exact ${Number(r.quote.amount) / 1e6} USDC per call to ${r.profile.payTo.slice(0, 10)}… · unsigned receipts (ledger evidence only) · offered: ${r.offered.join(', ')}`);
    log?.(`Discovered ${r.profile.label} from its 402: ${Number(r.quote.amount) / 1e6} USDC per call, payTo ${r.profile.payTo}. No signer pin is needed; settlement is verified on chain.`);
    return r;
  }
  select.innerHTML = '';
  const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; select.appendChild(o); };
  for (const p of Object.values(meta.presets)) add(`preset:${p.id}`, `${p.label} · signed receipts`);
  for (const t of meta.templates ?? []) add(`template:${t.id}`, t.label);
  add('discover', 'Discover any x402 URL…');
  add('custom', 'Custom profile JSON');
  select.onchange = async () => {
    const [kind, id] = select.value.split(':');
    if (discoverRow) discoverRow.hidden = kind !== 'discover';
    try {
      if (kind === 'preset') { const p = meta.presets[id]; apply(p, p.id === 'x402-doctor' ? { url: meta.interopTarget, method: 'GET' } : {}, `${p.label}: signed receipts, pin the signer below.`); }
      else if (kind === 'template') { const t = meta.templates.find(x => x.id === id); if (url) url.value = t.url; await discover(t.url); }
      else if (kind === 'custom') setNote('Edit the JSON. receipt.mode "unsigned" skips receipt signature checks; omit it for Doctor-style signed receipts.');
      else setNote('Paste a URL and press Discover.');
    } catch (e) { setNote(`Discovery failed: ${e.message}`); log?.(`Discovery failed: ${e.message}`, 'bad'); }
  };
  if (button) button.onclick = () => discover(url.value.trim()).catch(e => { setNote(`Discovery failed: ${e.message}`); log?.(`Discovery failed: ${e.message}`, 'bad'); });
  select.value = `preset:${Object.keys(meta.presets)[0]}`; select.onchange();
  return { current: () => JSON.parse(json.value), discover };
}
/** True when the profile verifies settlement only (no signed receipt, so no signer pin). */
export const isUnsigned = p => p?.receipt?.mode === 'unsigned';
