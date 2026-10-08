import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, verifyChain } from '../dist/profiles/x402-exact/journal.js';
import { SessionClient } from '../dist/profiles/x402-exact/session.js';
import { PROFILE, DOCTOR, ASSET, PAY_TO, NETWORK, canonical, digest, atomic, requestUrl, selectQuote, pack, unpack } from '../dist/profiles/x402-exact/protocol.js';
import { doctorTransport, boundedFetch } from '../dist/profiles/x402-exact/http.js';

const now = 1790770000000, payer = '0x1111111111111111111111111111111111111111';
const input = { url: 'https://example.com/paid', method: 'GET' };
function terms(extra = {}) { return { profile: PROFILE, payer, provider: PAY_TO, network: NETWORK, asset: ASSET, endpoint: `${DOCTOR}/api/v1/preflight`, maxTotal: '3000', maxPerCall: '1000', maxCalls: 3, expiresAt: now + 600000, license: { uri: 'urn:synthetic:test-terms', sha256: digest('fixture-terms'), acceptance: 'buyer-only' }, ...extra }; }
function challenge(extra = {}) { return { x402Version: 2, resource: { url: `${DOCTOR}/api/v1/preflight` }, accepts: [{ scheme: 'exact', network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: '1000', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' }, ...extra }] }; }
function fixture(t = terms()) {
  let sent = 0, signed = 0;
  const journal = new Journal(':memory:'), id = journal.create(t, now);
  const adapters = {
    probe: async () => challenge(),
    prepare: async (quote, t, nonce) => { signed++; return { quote, authorization: { from: payer, to: PAY_TO, value: quote.accepted.amount, nonce, validAfter: String(now / 1000 - 5), validBefore: String(now / 1000 + 60) }, signature: `0x${'a'.repeat(130)}` }; },
    send: async () => { sent++; return { status: 200, body: { synthetic: true }, settlement: { synthetic: true } }; },
    verify: async c => ({ receipt: { requestId: c.id, signer: PAY_TO, responseHash: digest(c.wire.body), signedAt: new Date(now).toISOString() }, ledger: { transaction: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', confirmations: 2, verification: 'rpc-confirmed' }, semanticCorrectness: 'not-verified' }),
  };
  return { journal, id, adapters, client: new SessionClient(journal, adapters, () => now), counts: () => ({ sent, signed }) };
}

test('canonical encoding matches Doctor UTF-16 sorted / ASCII profile', () => {
  assert.equal(canonical({ z: 1, a: '한😀\u007f', 'é': 0.000001 }), '{"a":"\\ud55c\\ud83d\\ude00\\u007f","z":1,"\\u00e9":0.000001}');
  for (const bad of [NaN, Infinity, undefined, 1n, new Date()]) assert.throws(() => canonical(bad));
  assert.equal(unpack(pack({ n: 1 })).n, 1);
  assert.throws(() => unpack('garbage!'));
});
test('atomic amounts use exact integers and reject suffixes, decimal, negative and overflow', () => {
  assert.equal(atomic('9007199254740993'), 9007199254740993n);
  for (const bad of ['1.0', '1k', '-1', '01', '1e3', '', '9'.repeat(80), 1, (2n ** 256n).toString()]) assert.throws(() => atomic(bad));
});
test('only exact v2 Base USDC and pinned payee/domain can be selected', () => {
  assert.equal(selectQuote(challenge(), terms(), input).accepted.amount, '1000');
  for (const patch of [{ amount: '0' }, { amount: '1001' }, { amount: '0.001' }, { scheme: 'upto' }, { network: 'solana:mainnet' }, { asset: payer }, { payTo: payer }, { extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } }, { maxTimeoutSeconds: Infinity }, { maxTimeoutSeconds: 3601 }]) {
    assert.throws(() => selectQuote(challenge(patch), terms(), input));
  }
  for (const patch of [{ x402Version: 1 }, { resource: { url: 'https://evil.example/api/v1/preflight' } }, { resource: { url: `${DOCTOR}/wrong` } }, { accepts: {} }]) assert.throws(() => selectQuote({ ...challenge(), ...patch }, terms(), input));
});
test('request input rejects arbitrary params and credentials; challenge query must agree when present', () => {
  assert.throws(() => requestUrl(terms(), { ...input, max_usd: '100' }));
  assert.throws(() => requestUrl(terms(), { url: 'https://key:secret@example.com/a' }));
  assert.throws(() => selectQuote({ ...challenge(), resource: { url: `${DOCTOR}/api/v1/preflight?url=wrong` } }, terms(), input));
});
test('unpaid transport validates 402 header and refuses conflicting mirrors', async () => {
  const c = challenge();
  const ok = doctorTransport(async () => new Response(JSON.stringify(c), { status: 402, headers: { 'payment-required': pack(c) } }));
  assert.deepEqual(await ok.probe(`${DOCTOR}/api/v1/preflight`), c);
  const bad = doctorTransport(async () => new Response(JSON.stringify({ ...c, x402Version: 1 }), { status: 402, headers: { 'payment-required': pack(c) } }));
  await assert.rejects(bad.probe(`${DOCTOR}/api/v1/preflight`));
  await assert.rejects(doctorTransport(async () => new Response('{}', { status: 200 })).probe(`${DOCTOR}/api/v1/preflight`));
});
test('Doctor transport sends stable Interop #001 User-Agent on probes', async () => {
  const c = challenge();
  let seen;
  const transport = doctorTransport(async (_url, init) => {
    seen = new Headers(init?.headers).get('user-agent');
    return new Response(JSON.stringify(c), { status: 402, headers: { 'payment-required': pack(c) } });
  });
  await transport.probe(`${DOCTOR}/api/v1/preflight`);
  assert.equal(seen, 'alsp-interop/001');
});
test('network guard rejects other hosts, routes, redirects and oversized bodies', async () => {
  let n = 0; const fetcher = async () => { n++; return new Response('{}'); };
  await assert.rejects(boundedFetch('https://evil.example', {}, fetcher));
  await assert.rejects(boundedFetch(`${DOCTOR}/admin`, {}, fetcher));
  assert.equal(n, 0);
  await assert.rejects(boundedFetch(`${DOCTOR}/api/v1/preflight`, {}, async () => new Response(null, { status: 302 })));
  await assert.rejects(boundedFetch(`${DOCTOR}/api/v1/preflight`, {}, async () => new Response('a'.repeat(2 * 1024 * 1024 + 1))));
});
test('successful synthetic session caches duplicates without a second signature or payment', async () => {
  const f = fixture();
  try {
    const a = await f.client.call(f.id, 'one', input), b = await f.client.call(f.id, 'one', input);
    assert.equal(a.state, 'VERIFIED'); assert.equal(a.id, b.id); assert.deepEqual(f.counts(), { sent: 1, signed: 1 });
    await assert.rejects(f.client.call(f.id, 'one', { url: 'https://example.com/other' }));
    assert.deepEqual(f.counts(), { sent: 1, signed: 1 });
  } finally { f.journal.close(); }
});
test('concurrent duplicate requests reserve once and spend once', async () => {
  const f = fixture();
  try {
    const calls = await Promise.all([f.client.call(f.id, 'one', input), f.client.call(f.id, 'one', input)]);
    assert.equal(new Set(calls.map(c => c.id)).size, 1); assert.equal(f.counts().sent, 1);
  } finally { f.journal.close(); }
});
test('concurrent distinct calls cannot exceed local session budget', async () => {
  const f = fixture(terms({ maxTotal: '1000' }));
  try {
    const calls = await Promise.allSettled([f.client.call(f.id, 'one', input), f.client.call(f.id, 'two', input)]);
    assert.equal(calls.filter(c => c.status === 'fulfilled').length, 1); assert.equal(f.counts().sent, 1);
  } finally { f.journal.close(); }
});
test('separate SQLite connections enforce the same budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alsp-')), path = join(dir, 'journal.sqlite');
  const a = new Journal(path), b = new Journal(path);
  try {
    const t = terms({ maxTotal: '1000' }), id = a.create(t, now), quote = selectQuote(challenge(), t, input);
    a.reserve(id, 'a', input, quote, now);
    assert.throws(() => b.reserve(id, 'b', input, quote, now));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('network failure retains reservation, forbids resending and blocks closing as settled', async () => {
  const f = fixture(terms({ maxTotal: '1000' }));
  f.adapters.send = async () => { throw new Error('timeout AFTER possible settlement'); };
  try {
    const c = await f.client.call(f.id, 'one', input);
    assert.equal(c.state, 'RECONCILIATION_REQUIRED'); assert.ok(c.prepared);
    assert.equal((await f.client.call(f.id, 'one', input)).id, c.id);
    await assert.rejects(f.client.call(f.id, 'two', input));
    f.journal.end(f.id);
    assert.equal(f.journal.export(f.id).summary.state, 'RECONCILIATION_REQUIRED');
  } finally { f.journal.close(); }
});
test('RPC failure after capture can reconcile after restart without a signer or paid transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alsp-')), path = join(dir, 'journal.sqlite'), f = fixture();
  f.journal.close(); const a = new Journal(path), id = a.create(terms(), now);
  let c;
  try {
    c = await new SessionClient(a, { ...f.adapters, verify: async () => { throw new Error('RPC down'); } }, () => now).call(id, 'one', input);
    assert.ok(c.wire); assert.equal(c.state, 'RECONCILIATION_REQUIRED');
  } finally { a.close(); }
  const b = new Journal(path), forbidden = async () => { throw new Error('Must not send/sign'); };
  try {
    const client = new SessionClient(b, { probe: forbidden, prepare: forbidden, send: forbidden, verify: f.adapters.verify }, () => now);
    assert.equal((await client.call(id, 'one', input)).state, 'RECONCILIATION_REQUIRED');
    assert.equal((await client.reconcile(c.id)).state, 'VERIFIED');
    b.end(id); assert.equal(b.export(id).summary.state, 'CLOSED');
    assert.ok(verifyChain(b.export(id))); assert.equal(f.counts().sent, 1);
  } finally { b.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('an early-ended session can resume only after reconciliation and continue within the original cap', async () => {
  const f = fixture();
  try {
    const first = await f.client.call(f.id, 'one', input);
    assert.equal(first.state, 'VERIFIED');
    f.journal.end(f.id);
    assert.equal(f.journal.export(f.id).summary.state, 'CLOSED');
    f.journal.resume(f.id, now);
    assert.equal(f.journal.session(f.id).state, 'ACTIVE');
    const second = await f.client.call(f.id, 'two', input);
    assert.equal(second.state, 'VERIFIED');
    assert.equal(f.journal.calls(f.id).length, 2);
    assert.equal(f.counts().sent, 2);
  } finally { f.journal.close(); }
});
test('resume refuses unresolved, expired, exhausted or call-limit sessions', async () => {
  const unresolved = fixture();
  unresolved.adapters.send = async () => { throw new Error('lost'); };
  try {
    await unresolved.client.call(unresolved.id, 'one', input);
    unresolved.journal.end(unresolved.id);
    assert.throws(() => unresolved.journal.resume(unresolved.id, now));
  } finally { unresolved.journal.close(); }

  const full = fixture(terms({ maxTotal: '1000', maxCalls: 3 }));
  try {
    await full.client.call(full.id, 'one', input);
    full.journal.end(full.id);
    assert.throws(() => full.journal.resume(full.id, now));
  } finally { full.journal.close(); }

  const limited = fixture(terms({ maxCalls: 1 }));
  try {
    await limited.client.call(limited.id, 'one', input);
    limited.journal.end(limited.id);
    assert.throws(() => limited.journal.resume(limited.id, now));
  } finally { limited.journal.close(); }

  const expired = fixture();
  try {
    expired.journal.end(expired.id);
    assert.throws(() => expired.journal.resume(expired.id, now + 600001));
  } finally { expired.journal.close(); }
});
test('fully verified call set can be ended after the final reconciliation without another paid run', async () => {
  const f = fixture();
  try {
    await f.client.call(f.id, 'one', input);
    await f.client.call(f.id, 'two', input);
    const third = await f.client.call(f.id, 'three', input);
    assert.equal(third.state, 'VERIFIED');
    const calls = f.journal.calls(f.id);
    assert.equal(calls.length, f.journal.session(f.id).terms.maxCalls);
    assert.ok(calls.every(call => call.state === 'VERIFIED'));
    f.journal.end(f.id);
    assert.equal(f.journal.export(f.id).summary.state, 'CLOSED');
    assert.equal(f.journal.export(f.id).summary.verifiedSpent, '3000');
  } finally { f.journal.close(); }
});
test('lost response can be attached for verification, never by creating a new payment', async () => {
  const f = fixture(); f.adapters.send = async () => { throw new Error('lost response'); };
  try {
    const c = await f.client.call(f.id, 'one', input);
    assert.equal((await f.client.reconcile(c.id)).state, 'RECONCILIATION_REQUIRED');
    assert.equal((await f.client.reconcile(c.id, { status: 200, body: { synthetic: true }, settlement: {} })).state, 'VERIFIED');
  } finally { f.journal.close(); }
});
test('changed signer amount is rejected before network submission', async () => {
  const f = fixture(), prepare = f.adapters.prepare;
  f.adapters.prepare = async (...args) => { const p = await prepare(...args); p.authorization.value = '2000'; return p; };
  try { assert.equal((await f.client.call(f.id, 'one', input)).state, 'RECONCILIATION_REQUIRED'); assert.equal(f.counts().sent, 0); }
  finally { f.journal.close(); }
});
test('expired or ended sessions cannot create new payments', async () => {
  const f = fixture();
  try {
    const later = new SessionClient(f.journal, f.adapters, () => now + 600001);
    await assert.rejects(later.call(f.id, 'one', input));
    f.journal.end(f.id); await assert.rejects(f.client.call(f.id, 'two', input));
    assert.equal(f.counts().signed, 0);
  } finally { f.journal.close(); }
});
test('provider receipt ID cannot verify two calls, even across sessions', async () => {
  const f = fixture(), verify = f.adapters.verify;
  f.adapters.verify = async (...args) => { const v = await verify(...args); v.receipt.requestId = 'same-server-id'; return v; };
  try {
    assert.equal((await f.client.call(f.id, 'one', input)).state, 'VERIFIED');
    const second = f.journal.create(terms(), now);
    assert.equal((await f.client.call(second, 'one', input)).state, 'RECONCILIATION_REQUIRED');
  } finally { f.journal.close(); }
});
test('archive is hash-linked, tampering is detected, bearer signatures are excluded', async () => {
  const f = fixture();
  try {
    await f.client.call(f.id, 'one', input); f.journal.end(f.id);
    const archive = f.journal.export(f.id);
    assert.equal(archive.summary.state, 'CLOSED'); assert.equal(archive.summary.registryWrites, 0);
    assert.ok(verifyChain(archive)); assert.ok(!JSON.stringify(archive).includes('a'.repeat(130)));
    archive.events[0].event.amount = '2'; assert.equal(verifyChain(archive), false);
  } finally { f.journal.close(); }
});
test('journal refuses a symlink target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alsp-'));
  try { symlinkSync('/dev/null', join(dir, 'db')); assert.throws(() => new Journal(join(dir, 'db'))); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
