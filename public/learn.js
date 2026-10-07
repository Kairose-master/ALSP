// "What is a session?" — an interactive walkthrough that runs the real browser journal
// (state machine, budgets, idempotency, hash chain, export) against an in-page simulated
// provider, wallet and ledger. Signatures and settlement are simulated here; the real
// client verifies them server-side with the library.
import { BrowserJournal, BrowserSessionClient, PROFILE, digest, sha256Text, verifyChain } from './alsp-browser.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 12) => s ? `${String(s).slice(0, n)}…` : '—';
const usdc = a => `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lang = (navigator.language || '').startsWith('ko') ? 'ko' : 'en';
const t = (en, ko) => (lang === 'ko' ? ko : en);

// ---------- simulated world (clearly fake: no network, no keys, no real chain) ----------
const PAY_TO = '0x5eed000000000000000000000000000000000001', ASSET = '0x0000000000000000000000000000000000031337', SIGNER = '0x5eed000000000000000000000000000000000002';
const PAYER = '0xb0b0000000000000000000000000000000000001', NETWORK = 'eip155:31337', ENDPOINT = 'https://oracle.example/api/v1/quote';
const provider = { id: 'sim-oracle', label: 'Simulated price oracle', origin: 'https://oracle.example', endpointPath: '/api/v1/quote', method: 'GET', network: NETWORK, asset: { address: ASSET, name: 'USD Coin', version: '2' }, payTo: PAY_TO, receipt: { route: 'GET /api/v1/quote', service: 'sim-oracle', certHeader: 'sim' } };
const fakeHex = n => `0x${Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('')}`;
const world = { price: '1000', paid: 0, lostNext: false, responses: new Map(), block: 0 };
const quoteFor = () => ({ x402Version: 2, resource: { url: ENDPOINT }, accepted: { scheme: 'exact', network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: world.price, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } } });
const api = {
  probe: async () => { await sleep(150); return { quote: quoteFor() }; },
  send: async (_p, _t, input, prepared, nonce) => {
    await sleep(250);
    world.paid++; world.block++;
    const tx = fakeHex(32), body = { symbol: input.symbol, price: 123.45, receipt: { request_id: `req_${nonce.slice(2, 10)}`, route: provider.receipt.route, signer: SIGNER, payment: { proof: 'eip3009', amount: prepared.authorization.value, nonce } } };
    const wire = { status: 200, body, settlement: { success: true, network: NETWORK, transaction: tx, payer: PAYER } };
    world.responses.set(nonce, { wire, block: world.block });
    if (world.lostNext) { world.lostNext = false; throw new Error('socket hang up after the provider settled'); }
    return { wire };
  },
  verify: async (_p, _t, call) => {
    await sleep(200);
    const r = world.responses.get(call.nonce);
    if (!r) throw new Error('No settlement for this nonce');
    return { verified: { receipt: { requestId: r.wire.body.receipt.request_id, signer: SIGNER, responseHash: await digest(r.wire.body), signedAt: new Date().toISOString() }, ledger: { transaction: r.wire.settlement.transaction, blockHash: fakeHex(32), blockNumber: String(r.block), confirmations: 2, verification: 'rpc-confirmed' }, semanticCorrectness: 'not-verified' } };
  },
};
const wallet = { address: PAYER, async prepare(quote, terms, nonce, now) { await sleep(200); const s = Math.floor(now / 1000); return { quote, authorization: { from: PAYER, to: quote.accepted.payTo, value: quote.accepted.amount, nonce, validAfter: String(s - 5), validBefore: String(s + 120) }, signature: fakeHex(65) }; } };
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

// ---------- state ----------
let journal, client, reconciler, sessionId, session2, calls = {}, stepIndex = -1, running = false, lastSeqShown = 0;
const narration = [];
const note = (en, ko, kind = '') => { narration.unshift({ text: t(en, ko), kind }); renderNarration(); };
const onStep = (step, c, err) => {
  const m = { probe: ['Unpaid 402 probe: asking the provider for its price', '무료 402 프로브: 프로바이더에 가격을 묻는 중'], reserved: [`Reserved ${c ? usdc(c.amount) : ''} and a fresh nonce in the journal`, `저널에 ${c ? usdc(c.amount) : ''}와 새 nonce를 예약`], submitting: ['Submission intent committed; sending the signed authorization exactly once', '전송 의도 기록 완료; 서명된 승인을 정확히 한 번 전송'], verifying: ['Verifying receipt signature + ledger settlement', '영수증 서명 + 원장 정산 검증 중'], replay: ['Replay: the journal answered from its record. No probe, no signature, no payment.', '재생: 저널 기록으로 응답. 프로브·서명·결제 없음.'] }[step];
  if (step === 'error') note(`Ambiguous outcome: ${err.message}. The call becomes RECONCILIATION_REQUIRED; funds stay reserved; nothing is retried.`, `결과 불확실: ${err.message}. 호출은 RECONCILIATION_REQUIRED가 되고 예산은 예약된 채 유지되며 자동 재시도는 없습니다.`, 'warn');
  else if (m) note(m[0], m[1]);
  renderState();
};
async function reset() {
  journal = new BrowserJournal(memory()); world.paid = 0; world.lostNext = false; world.responses.clear(); world.block = 0; calls = {}; narration.length = 0; lastSeqShown = 0;
  client = new BrowserSessionClient(journal, { api, wallet, pins: [{ address: SIGNER }], onStep });
  const noPayments = async () => { throw new Error('Reconciliation cannot create or send a payment'); };
  reconciler = new BrowserSessionClient(journal, { api: { ...api, probe: noPayments, send: noPayments }, wallet: { address: PAYER, prepare: noPayments }, pins: [{ address: SIGNER }], onStep });
  sessionId = null; session2 = null; stepIndex = -1;
}
const termsFor = async (maxTotal, maxCalls) => ({ profile: PROFILE, payer: PAYER, provider: PAY_TO, network: NETWORK, asset: ASSET, endpoint: ENDPOINT, maxTotal, maxPerCall: '1000', maxCalls, expiresAt: Date.now() + 600000, license: { uri: 'urn:alsp:learn:reviewed-terms', sha256: await sha256Text('Example provider terms the buyer read before paying.'), acceptance: 'buyer-only' } });

// ---------- the steps ----------
const steps = [
  { title: ['Without a session', '세션이 없을 때'],
    body: ['A plain x402 <b>exact</b> call is one isolated payment: GET → 402 challenge → sign one EIP-3009 authorization → GET again → 200. Nothing links two such calls: no budget across them, no idempotency key, no shared evidence trail. If the response is lost you cannot tell whether you paid.<br><br>A <b>session</b> adds exactly those things. Press <b>Next</b> to build one.',
           '순수한 x402 <b>exact</b> 호출은 고립된 결제 한 건입니다: GET → 402 챌린지 → EIP-3009 승인 1회 서명 → 다시 GET → 200. 두 호출을 잇는 것은 아무것도 없습니다. 호출 간 예산도, 멱등성 키도, 공유되는 증거 기록도 없습니다. 응답이 유실되면 결제가 됐는지조차 알 수 없습니다.<br><br><b>세션</b>은 정확히 그것들을 더합니다. <b>Next</b>를 눌러 하나 만들어 보세요.'],
    run: async () => { const { quote } = await api.probe(); note(`Provider quotes ${usdc(quote.accepted.amount)} per call to ${short(quote.accepted.payTo)} on ${quote.accepted.network}.`, `프로바이더가 호출당 ${usdc(quote.accepted.amount)}을 ${short(quote.accepted.payTo)}로 ${quote.accepted.network}에서 요구합니다.`); } },
  { title: ['Terms: the immutable commitment', 'Terms: 불변의 약정'],
    body: ['A session starts with <b>Terms</b>: payer, provider endpoint, asset and network, two atomic budgets (<code>maxTotal</code>, <code>maxPerCall</code>), a call limit, an expiry, and the SHA-256 of the provider terms the buyer actually reviewed. Acceptance is <b>buyer-only</b>: the provider never signs these; they bound what <i>this client</i> will do.<br><br>The hash chain starts at <code>SHA256({profile, sessionId, terms})</code>. Every later event extends it, so the terms can never be swapped underneath the evidence.',
           '세션은 <b>Terms</b>로 시작합니다: 지불자, 프로바이더 엔드포인트, 자산과 네트워크, 두 개의 원자 단위 예산(<code>maxTotal</code>, <code>maxPerCall</code>), 호출 상한, 만료 시각, 그리고 바이어가 실제로 검토한 프로바이더 약관의 SHA-256. 수락은 <b>buyer-only</b>입니다. 프로바이더는 이 terms에 서명하지 않으며, terms는 <i>이 클라이언트</i>가 할 일을 제한합니다.<br><br>해시 체인은 <code>SHA256({profile, sessionId, terms})</code>에서 시작합니다. 이후 모든 이벤트가 이를 연장하므로 증거 밑에서 terms를 바꿔치기할 수 없습니다.'],
    run: async () => { const terms = await termsFor('3000', 3); sessionId = await journal.create(terms, provider); note(`Session ${short(sessionId, 8)} created · cap ${usdc(terms.maxTotal)} · ≤ ${usdc(terms.maxPerCall)}/call · ≤ ${terms.maxCalls} calls · termsHash ${short(await digest(terms), 16)}`, `세션 ${short(sessionId, 8)} 생성 · 총액 ${usdc(terms.maxTotal)} · 호출당 ≤ ${usdc(terms.maxPerCall)} · 최대 ${terms.maxCalls}회 · termsHash ${short(await digest(terms), 16)}`, 'ok'); } },
  { title: ['One call: reserve → authorize → submit → response → verify', '호출 하나: 예약 → 승인 → 전송 → 응답 → 검증'],
    body: ['<code>call(sessionId, key, input)</code> runs one paid operation under the terms. Each step is committed to the journal <b>before</b> the next side effect, and each commit appends an event to the chain. Watch the event list grow:<br><br><b>reserved</b> — budget and a fresh nonce taken atomically; the money is spoken for from here.<br><b>authorized</b> — the wallet signature exists; only its hash enters the log, never the bearer token.<br><b>submission_intent</b> — durable "I am about to send"; after this, a crash means "maybe paid".<br><b>response</b> — the original provider response is stored before anything is verified.<br><b>verified</b> — receipt signature, request/payment binding and RPC-confirmed USDC events agree.',
           '<code>call(sessionId, key, input)</code>은 terms 아래에서 유료 작업 하나를 수행합니다. 각 단계는 다음 부작용 <b>전에</b> 저널에 커밋되고, 커밋마다 체인에 이벤트가 추가됩니다. 이벤트 목록이 자라는 것을 보세요:<br><br><b>reserved</b> — 예산과 새 nonce를 원자적으로 확보. 이 시점부터 그 돈은 "찜"된 상태.<br><b>authorized</b> — 지갑 서명 생성. 로그에는 해시만 들어가고 bearer 토큰은 절대 들어가지 않음.<br><b>submission_intent</b> — "지금 보낸다"는 내구적 기록. 이후 크래시는 "결제됐을 수도 있음"을 뜻함.<br><b>response</b> — 검증 전에 프로바이더의 원본 응답을 먼저 저장.<br><b>verified</b> — 영수증 서명, 요청/결제 바인딩, RPC로 확인한 USDC 이벤트가 모두 일치.'],
    run: async () => { calls.one = await client.call(sessionId, 'quote-1', { symbol: 'BTC-USDT' }); note(`quote-1 → ${calls.one.state} · ${usdc(calls.one.amount)} · tx ${short(calls.one.verified?.ledger.transaction)}`, `quote-1 → ${calls.one.state} · ${usdc(calls.one.amount)} · tx ${short(calls.one.verified?.ledger.transaction)}`, 'ok'); } },
  { title: ['Idempotency: a key never pays twice', '멱등성: 같은 키는 두 번 결제하지 않음'],
    body: ['A <b>request key</b> names a request inside the session. Re-sending it (retry loop, crash recovery, double click) is safe: the journal answers from its record with no probe, no signature and no payment. Reusing a key with <i>different</i> input is a bug and is rejected.',
           '<b>요청 키</b>는 세션 안에서 요청을 식별합니다. 같은 키를 다시 보내는 것(재시도 루프, 크래시 복구, 더블클릭)은 안전합니다. 저널이 기록으로 응답하며 프로브·서명·결제가 없습니다. 같은 키를 <i>다른</i> 입력에 재사용하는 것은 버그이며 거부됩니다.'],
    run: async () => {
      const paid = world.paid; const again = await client.call(sessionId, 'quote-1', { symbol: 'BTC-USDT' });
      note(`Same key → same call ${short(again.id, 8)} · new payments: ${world.paid - paid}`, `같은 키 → 같은 호출 ${short(again.id, 8)} · 새 결제: ${world.paid - paid}건`, 'ok');
      try { await client.call(sessionId, 'quote-1', { symbol: 'ETH-USDT' }); } catch (e) { note(`Same key, different input → refused: ${e.message}`, `같은 키, 다른 입력 → 거부: ${e.message}`, 'warn'); }
    } },
  { title: ['Budgets are enforced before any signature', '예산은 서명 전에 강제됨'],
    body: ['The session cap counts <b>every</b> reservation, settled or not. Two more calls fit; a fourth does not, and it is refused before anything is signed. Budgets are per session, not a proof of reserved funds.',
           '세션 총액은 정산 여부와 무관하게 <b>모든</b> 예약을 셉니다. 두 번 더는 가능하지만 네 번째는 안 되며, 무엇이든 서명되기 전에 거부됩니다. 예산은 세션 단위이며 자금이 실제로 예치됐다는 증명은 아닙니다.'],
    run: async () => {
      calls.two = await client.call(sessionId, 'quote-2', { symbol: 'ETH-USDT' }); calls.three = await client.call(sessionId, 'quote-3', { symbol: 'SOL-USDT' });
      try { await client.call(sessionId, 'quote-4', { symbol: 'XRP-USDT' }); } catch (e) { note(`4th call → refused: ${e.message} · allocated ${usdc((await journal.export(sessionId)).summary.allocatedTotal)} of ${usdc('3000')}`, `4번째 호출 → 거부: ${e.message} · 할당 ${usdc((await journal.export(sessionId)).summary.allocatedTotal)} / ${usdc('3000')}`, 'warn'); }
    } },
  { title: ['Failure: ambiguity becomes RECONCILIATION_REQUIRED, never a retry', '실패: 불확실성은 RECONCILIATION_REQUIRED가 되지 재시도가 되지 않음'],
    body: ['A second session shows the failure path. The provider settles the payment but the response is lost on the wire. The client cannot know whether it paid, so the call is parked as <b>RECONCILIATION_REQUIRED</b>: the reservation stays, the budget stays consumed, the session cannot resume or close as settled, and nothing is resent.<br><br>Resolution needs the <b>original evidence</b> for that nonce (e.g. the provider\'s "look up my receipt" endpoint), never a new payment.',
           '두 번째 세션으로 실패 경로를 봅니다. 프로바이더는 결제를 정산했지만 응답이 전송 중 유실됩니다. 클라이언트는 결제 여부를 알 수 없으므로 호출을 <b>RECONCILIATION_REQUIRED</b>로 보류합니다. 예약은 남고, 예산은 소비된 채이며, 세션은 정산 완료로 재개·종료될 수 없고, 아무것도 재전송되지 않습니다.<br><br>해결에는 그 nonce에 대한 <b>원본 증거</b>(예: 프로바이더의 "내 영수증 조회" 엔드포인트)가 필요하며, 새 결제는 절대 아닙니다.'],
    run: async () => {
      session2 = await journal.create(await termsFor('2000', 2), provider); world.lostNext = true;
      calls.lost = await client.call(session2, 'quote-1', { symbol: 'BTC-USDT' });
      note(`quote-1 (session 2) → ${calls.lost.state} · response stored: ${Boolean(calls.lost.wire)} · provider did settle (${world.paid} settlements so far)`, `quote-1 (세션 2) → ${calls.lost.state} · 응답 저장됨: ${Boolean(calls.lost.wire)} · 프로바이더는 정산함 (지금까지 ${world.paid}건)`, 'warn');
      await journal.end(session2);
      try { await journal.resume(session2); } catch (e) { note(`Resume → refused: ${e.message} · export summary: ${(await journal.export(session2)).summary.state}`, `재개 → 거부: ${e.message} · 내보내기 요약: ${(await journal.export(session2)).summary.state}`, 'warn'); }
    } },
  { title: ['Reconciliation with the original evidence', '원본 증거로 재조정'],
    body: ['A reconciler has <b>no</b> probe, sign or send adapters at all. It attaches the recovered original response to the same call, verifies it, and only then marks it VERIFIED. The session can then resume and continue within its original cap.',
           '재조정기에는 프로브·서명·전송 어댑터가 <b>전혀</b> 없습니다. 복구한 원본 응답을 같은 호출에 붙이고, 검증한 뒤에야 VERIFIED로 표시합니다. 그러면 세션은 재개되어 원래 총액 안에서 계속할 수 있습니다.'],
    run: async () => {
      const recovered = world.responses.get(calls.lost.nonce).wire;
      const fixed = await reconciler.reconcile(calls.lost.id, recovered);
      note(`Reconcile with recovered response → ${fixed.state} · tx ${short(fixed.verified?.ledger.transaction)} · new payments: 0`, `복구 응답으로 재조정 → ${fixed.state} · tx ${short(fixed.verified?.ledger.transaction)} · 새 결제: 0건`, 'ok');
      await journal.resume(session2); note('Session 2 resumed; one call of budget remains.', '세션 2 재개; 예산상 호출 1회가 남음.', 'ok');
    } },
  { title: ['End and export: a self-contained evidence archive', '종료와 내보내기: 자체 완결적인 증거 아카이브'],
    body: ['Ending a session stops new calls. The export holds the terms, the hash-chained events and every original response. The chain is re-verified; a tampered copy fails. In the real client you also sign a manifest with your wallet (<b>buyer seal</b>): it proves <i>you</i> vouch for this exact archive, not that the provider agrees or that its answers were correct (<code>semanticCorrectness: not-verified</code>).',
           '세션을 종료하면 새 호출이 막힙니다. 내보내기에는 terms, 해시 체인으로 연결된 이벤트, 모든 원본 응답이 담깁니다. 체인은 재검증되며 변조된 사본은 실패합니다. 실제 클라이언트에서는 지갑으로 매니페스트에 서명(<b>buyer seal</b>)도 합니다. 이는 <i>당신</i>이 이 아카이브를 보증한다는 뜻이지, 프로바이더가 동의했다거나 답이 옳았다는 뜻은 아닙니다(<code>semanticCorrectness: not-verified</code>).'],
    run: async () => {
      await journal.end(sessionId); const report = await journal.export(sessionId);
      const ok = await verifyChain(report); const tampered = structuredClone(report); tampered.events[0].event.amount = '1';
      note(`Session 1 → ${report.summary.state} · ${report.events.length} events · chain intact: ${ok} · tampered copy intact: ${await verifyChain(tampered)} · bearer signature in archive: ${JSON.stringify(report).includes(calls.one.prepared.signature)}`, `세션 1 → ${report.summary.state} · 이벤트 ${report.events.length}개 · 체인 무결: ${ok} · 변조 사본 무결: ${await verifyChain(tampered)} · 아카이브에 bearer 서명 포함: ${JSON.stringify(report).includes(calls.one.prepared.signature)}`, 'ok');
      $('#archive').textContent = JSON.stringify(report, null, 2); $('#archiveBox').open = true;
    } },
  { title: ['Summary', '정리'],
    body: ['<pre class="diagram">session  = terms (immutable, hashed)\n         + a bounded set of calls, each with its own nonce, key and evidence\n         + budgets that count every reservation\n         + an append-only hash chain over every state transition\n         + an exported archive the buyer can seal\n\nACTIVE ──(calls)──▶ ENDED ──(export)──▶ CLOSED                   all calls VERIFIED\n                                     └─▶ RECONCILIATION_REQUIRED    any call unresolved\n\ncall:  RESERVED → AUTHORIZED → SUBMITTED → VERIFIED\n                                  └─(ambiguous)─▶ RECONCILIATION_REQUIRED ─(original evidence)─▶ VERIFIED</pre>Ready to do it for real? The <a href="./">client</a> runs this same journal with your wallet against a live provider.',
           '<pre class="diagram">세션  = terms (불변, 해시됨)\n      + 각자 nonce·키·증거를 가진 유한한 호출 집합\n      + 모든 예약을 세는 예산\n      + 모든 상태 전이를 잇는 추가 전용 해시 체인\n      + 바이어가 봉인할 수 있는 내보낸 아카이브\n\nACTIVE ──(호출)──▶ ENDED ──(내보내기)──▶ CLOSED                   모든 호출 VERIFIED\n                                      └─▶ RECONCILIATION_REQUIRED    미해결 호출 존재\n\n호출:  RESERVED → AUTHORIZED → SUBMITTED → VERIFIED\n                                  └─(불확실)─▶ RECONCILIATION_REQUIRED ─(원본 증거)─▶ VERIFIED</pre>실제로 해보려면 <a href="./">클라이언트</a>에서 같은 저널을 당신의 지갑과 실제 프로바이더에 대해 실행합니다.'],
    run: async () => {} },
];

// ---------- rendering ----------
function renderSteps() {
  $('#steps').innerHTML = steps.map((s, i) => `<li class="${i === stepIndex ? 'current' : i < stepIndex ? 'done' : ''}">${i + 1}. ${esc(t(...s.title))}</li>`).join('');
}
function renderStep() {
  const s = steps[stepIndex];
  $('#stepTitle').textContent = s ? `${stepIndex + 1}. ${t(...s.title)}` : t('Press Start', 'Start를 누르세요');
  $('#stepBody').innerHTML = s ? t(...s.body) : '';
  $('#next').textContent = stepIndex < 0 ? t('Start ▶', '시작 ▶') : stepIndex >= steps.length - 1 ? t('Restart ↺', '다시 ↺') : t('Next ▶', '다음 ▶');
}
function renderNarration() { $('#narration').innerHTML = narration.map(n => `<div class="log ${n.kind}">${esc(n.text)}</div>`).join(''); }
async function renderState() {
  const ids = [sessionId, session2].filter(Boolean);
  if (!ids.length) { $('#state').innerHTML = `<div class="empty">${t('No session yet.', '아직 세션이 없습니다.')}</div>`; return; }
  let html = '';
  for (const [i, id] of ids.entries()) {
    const s = journal.session(id), report = await journal.export(id), sm = report.summary;
    const tiles = [[t('State', '상태'), s.state === 'ACTIVE' ? 'ACTIVE' : sm.state], [t('Allocated', '할당'), usdc(sm.allocatedTotal)], [t('Verified', '검증됨'), usdc(sm.verifiedSpent)], [t('Unresolved', '미해결'), sm.unresolved], [t('Calls', '호출'), `${sm.calls} / ${s.terms.maxCalls}`], [t('Chain', '체인'), `${s.seq} ev · ${short(s.head, 10)}`]];
    html += `<h3>${t('Session', '세션')} ${i + 1} <span class="mono muted">${short(id, 8)}</span></h3><div class="strip">${tiles.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
      <table><thead><tr><th>key</th><th>input</th><th>state</th><th>amount</th><th>nonce</th><th>tx</th></tr></thead><tbody>${s.calls.map(c => `<tr><td><code>${esc(c.requestKey)}</code></td><td class="mono">${esc(c.input.symbol)}</td><td><span class="state ${c.state}">${c.state}</span></td><td>${usdc(c.amount)}</td><td class="mono">${short(c.nonce)}</td><td class="mono">${short(c.verified?.ledger.transaction)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${t('No calls yet.', '아직 호출이 없습니다.')}</td></tr>`}</tbody></table>
      <table class="events"><thead><tr><th>#</th><th>event</th><th>previous → head</th></tr></thead><tbody>${s.events.map(e => `<tr class="${e.seq > lastSeqShown && i === 0 ? 'new' : ''}"><td>${e.seq}</td><td><code>${esc(e.event.kind)}</code>${e.event.callId ? ` <span class="muted mono">${short(e.event.callId, 8)}</span>` : ''}</td><td class="mono">${short(e.previous, 8)} → ${short(e.head, 8)}</td></tr>`).join('')}</tbody></table>`;
  }
  $('#state').innerHTML = html;
}
async function next() {
  if (running) return;
  if (stepIndex >= steps.length - 1) { await reset(); renderAll(); return; }
  running = true; $('#next').disabled = true;
  stepIndex++; renderSteps(); renderStep();
  try { await steps[stepIndex].run(); } catch (e) { note(`Unexpected: ${e.message}`, `예상치 못한 오류: ${e.message}`, 'bad'); }
  if (sessionId) lastSeqShown = journal.session(sessionId).seq;
  await renderState(); running = false; $('#next').disabled = false;
}
function renderAll() { renderSteps(); renderStep(); renderNarration(); renderState(); $('#lang').textContent = lang === 'ko' ? 'EN' : '한국어'; $('#archive').textContent = ''; $('#archiveBox').open = false; }
$('#next').onclick = next;
$('#lang').onclick = () => { lang = lang === 'ko' ? 'en' : 'ko'; renderAll(); };
await reset(); renderAll();
