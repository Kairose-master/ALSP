import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import {
  PROFILE, PRICE_AGREEMENT_PROFILE, Journal, SessionClient, agreementLink,
  buyerAcceptanceMessage, providerOfferMessage, verifyPriceAgreement,
  canonical, digest, selectQuote, validateTerms, evmSigner, verifyPriceAgreementArchive,
} from '../dist/index.js';
import { createMockProvider, DEMO_PAYTO_KEY } from './mock-provider.mjs';

// Public fixture keys. Never fund these addresses on any real chain.
const BUYER_KEY = `0x${'61'.repeat(32)}`;
const buyer = privateKeyToAccount(BUYER_KEY), providerAccount = privateKeyToAccount(DEMO_PAYTO_KEY);
const stranger = privateKeyToAccount(`0x${'62'.repeat(32)}`);
async function fixture() {
  const now = Date.now(), provider = createMockProvider({ price: '600' }), p = provider.profile;
  const agreementTerms = {
    profile: PRICE_AGREEMENT_PROFILE, agreementId: 'test-fixed-price', buyer: buyer.address,
    provider: p.payTo, network: p.network, asset: p.asset.address, endpoint: provider.endpoint, method: p.method,
    termsVersion: '2026-10-demo-v1', termsSha256: digest('fixture terms'), unitPrice: '600', maxCalls: 3,
    maxTotal: '1800', validFrom: now - 1000, expiresAt: now + 120000,
  };
  const offer = { terms: agreementTerms, providerSignature: await providerAccount.signMessage({ message: providerOfferMessage(agreementTerms) }) };
  const agreement = { ...offer, buyerSignature: await buyer.signMessage({ message: buyerAcceptanceMessage(offer) }) };
  const terms = { profile: PROFILE, payer: buyer.address, provider: p.payTo, network: p.network, asset: p.asset.address,
    endpoint: provider.endpoint, maxTotal: '10000', maxPerCall: '2500', maxCalls: 10, expiresAt: now + 120000,
    license: { uri: 'urn:alsp:demo-terms', sha256: agreementTerms.termsSha256, acceptance: 'bilateral' }, priceAgreement: agreement };
  const challenge = { x402Version: 2, resource: { url: provider.endpoint }, accepts: [{ scheme: 'exact', network: p.network, asset: p.asset.address, payTo: p.payTo, amount: '600', maxTimeoutSeconds: 60,
    extra: { name: p.asset.name, version: p.asset.version, alspAgreement: agreementLink(agreement) } }] };
  return { now, p, provider, agreement, terms, challenge, quote: selectQuote(challenge, terms, {}, p) };
}

test('provider offer and buyer acceptance bind every price-agreement field with distinct roles', async () => {
  const f = await fixture();
  await verifyPriceAgreement(f.agreement, f.now);
  const patches = [
    { agreementId: 'other' }, { buyer: stranger.address }, { provider: stranger.address }, { network: 'eip155:1' },
    { asset: stranger.address }, { endpoint: 'https://elsewhere.invalid/api' }, { method: 'POST' },
    { termsVersion: 'v2' }, { termsSha256: digest('other') }, { unitPrice: '601' }, { maxCalls: 4 },
    { maxTotal: '1801' }, { validFrom: f.now - 2000 }, { expiresAt: f.now + 180000 },
  ];
  for (const patch of patches) await assert.rejects(verifyPriceAgreement({ ...f.agreement, terms: { ...f.agreement.terms, ...patch } }, f.now));
  await assert.rejects(verifyPriceAgreement({ ...f.agreement, buyerSignature: f.agreement.providerSignature }, f.now));
  await assert.rejects(verifyPriceAgreement({ ...f.agreement, providerSignature: f.agreement.buyerSignature }, f.now));
  const unrelated = await stranger.signMessage({ message: providerOfferMessage(f.agreement.terms) });
  await assert.rejects(verifyPriceAgreement({ ...f.agreement, providerSignature: unrelated }, f.now));
});

test('agreement activity is a half-open interval and buyer/provider/terms pins cannot be substituted', async () => {
  const f = await fixture();
  await assert.rejects(verifyPriceAgreement(f.agreement, f.agreement.terms.validFrom - 1), /not active/);
  await verifyPriceAgreement(f.agreement, f.agreement.terms.validFrom);
  await assert.rejects(verifyPriceAgreement(f.agreement, f.agreement.terms.expiresAt), /not active/);
  for (const patch of [{ payer: stranger.address }, { provider: stranger.address }, { endpoint: 'https://elsewhere.invalid/api' }, { network: 'eip155:1' }, { asset: stranger.address }, { license: { ...f.terms.license, sha256: digest('wrong') } }]) {
    assert.throws(() => validateTerms({ ...f.terms, ...patch }, f.p));
  }
  assert.throws(() => validateTerms({ ...f.terms, priceAgreement: undefined }, f.p), /requires a signed/);
  assert.throws(() => validateTerms(f.terms, { ...f.p, method: 'POST' }));
  assert.throws(() => validateTerms(f.terms, { ...f.p, receipt: { mode: 'unsigned' } }));
});

test('the negotiated price is exact even below the general spending cap; no public fallback', async () => {
  const f = await fixture();
  for (const amount of ['500', '601', '1000', '2000']) {
    assert.ok(BigInt(amount) < BigInt(f.terms.maxPerCall));
    const challenge = structuredClone(f.challenge); challenge.accepts[0].amount = amount;
    assert.throws(() => selectQuote(challenge, f.terms, {}, f.p));
  }
  for (const link of [undefined, { agreementId: 'wrong', agreementHash: digest(f.agreement.terms) }, { ...agreementLink(f.agreement), agreementHash: digest('wrong') }]) {
    const c = structuredClone(f.challenge);
    if (link === undefined) delete c.accepts[0].extra.alspAgreement; else c.accepts[0].extra.alspAgreement = link;
    assert.throws(() => selectQuote(c, f.terms, {}, f.p));
  }
  const mixed = structuredClone(f.challenge); const publicOption = structuredClone(mixed.accepts[0]);
  publicOption.amount = '100'; delete publicOption.extra.alspAgreement; mixed.accepts.unshift(publicOption);
  assert.equal(selectQuote(mixed, f.terms, {}, f.p).accepted.amount, '600');
});

test('invalid assent and expiry during a slow probe fail before any payment signature', async () => {
  const f = await fixture();
  for (const mode of ['signature', 'slow-probe']) {
    const journal = new Journal(':memory:', f.p); let clock = f.now, signatures = 0, probes = 0;
    try {
      const terms = structuredClone(f.terms);
      if (mode === 'signature') terms.priceAgreement.buyerSignature = f.agreement.providerSignature;
      const id = journal.create(terms, clock);
      const client = new SessionClient(journal, { probe: async () => { probes++; clock = f.terms.expiresAt; return f.challenge; }, prepare: async () => { signatures++; throw new Error('must not sign'); }, send: async () => { throw new Error('must not send'); }, verify: async () => { throw new Error('must not verify'); } }, () => clock);
      await assert.rejects(client.call(id, 'one', {}));
      assert.equal(signatures, 0); assert.equal(journal.calls(id).length, 0); assert.equal(probes, mode === 'signature' ? 0 : 1);
    } finally { journal.close(); }
  }
});

test('all sessions and SQLite connections share the agreement allowance including unresolved reservations', async () => {
  const f = await fixture(), dir = mkdtempSync(join(tmpdir(), 'alsp-agreement-')), path = join(dir, 'journal.sqlite');
  const a = new Journal(path, f.p), b = new Journal(path, f.p);
  try {
    const one = a.create(f.terms, f.now), two = b.create(f.terms, f.now);
    for (const [journal, id, key] of [[a, one, 'one'], [b, two, 'two'], [a, one, 'three']]) journal.reserve(id, key, {}, f.quote, f.now);
    assert.throws(() => b.reserve(two, 'four', {}, f.quote, f.now), /allowance exceeded/);
    const wrongQuote = structuredClone(f.quote); wrongQuote.accepted.amount = '700';
    assert.throws(() => a.reserve(one, 'wrong-price', {}, wrongQuote, f.now), /violates price agreement/);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('signer adapter mutations cannot broaden the quote approved and reserved by the journal', async () => {
  const f = await fixture(), journal = new Journal(':memory:', f.p); let sends = 0;
  try {
    const id = journal.create(f.terms, f.now), signer = evmSigner(BUYER_KEY);
    const client = new SessionClient(journal, { probe: async () => f.challenge, prepare: async (quote, terms, nonce, now) => {
      quote.accepted.amount = '700'; terms.priceAgreement.terms.unitPrice = '700';
      return signer.prepare(quote, terms, nonce, now);
    }, send: async () => { sends++; throw new Error('must not send'); }, verify: async () => { throw new Error('must not verify'); } }, () => f.now);
    assert.equal((await client.call(id, 'one', {})).state, 'RECONCILIATION_REQUIRED');
    assert.equal(sends, 0); assert.equal(journal.calls(id)[0].amount, '600');
  } finally { journal.close(); }
});

// Rebuild the buyer-controlled hash chain and seal after mutation. These tests must
// exercise independent agreement/receipt/link checks, not merely seal corruption.
async function reseal(archive, buyerAccount) {
  const { buyerSeal: _old, ...report } = structuredClone(archive);
  report.termsHash = digest(report.terms);
  let head = digest({ profile: PROFILE, sessionId: report.sessionId, terms: report.terms });
  for (const [i, row] of report.events.entries()) {
    row.seq = i + 1; row.previous = head;
    row.head = digest({ profile: PROFILE, sessionId: report.sessionId, seq: row.seq, previous: head, event: row.event }); head = row.head;
  }
  report.headHash = head;
  const manifest = { profile: PROFILE, sessionId: report.sessionId, headHash: head, archiveSha256: digest(report) };
  return { ...report, buyerSeal: { manifest, signer: buyerAccount.address, signature: await buyerAccount.signMessage({ message: canonical(manifest) }) } };
}

test('agreement total allowance is enforced independently of its call count', async () => {
  const f = await fixture(); f.terms.priceAgreement.terms.maxTotal = '1200';
  const j = new Journal(':memory:', f.p);
  try {
    const id = j.create(f.terms, f.now);
    const c = structuredClone(f.challenge); c.accepts[0].extra.alspAgreement = agreementLink(f.terms.priceAgreement);
    const quote = selectQuote(c, f.terms, {}, f.p);
    j.reserve(id, 'one', {}, quote, f.now); j.reserve(id, 'two', {}, quote, f.now);
    assert.throws(() => j.reserve(id, 'three', {}, quote, f.now), /allowance exceeded/);
  } finally { j.close(); }
});

test('a conflicting signed agreement identity cannot split the journal allowance', async () => {
  const f = await fixture(), journal = new Journal(':memory:', f.p);
  try {
    const first = journal.create(f.terms, f.now); journal.reserve(first, 'one', {}, f.quote, f.now);
    const conflicting = structuredClone(f.terms); conflicting.priceAgreement.terms.termsVersion = 'new-version';
    const second = journal.create(conflicting, f.now), challenge = structuredClone(f.challenge);
    challenge.accepts[0].extra.alspAgreement = agreementLink(conflicting.priceAgreement);
    assert.throws(() => journal.reserve(second, 'two', {}, selectQuote(challenge, conflicting, {}, f.p), f.now), /Conflicting agreement identity/);
  } finally { journal.close(); }
});

import { createDemoFixture, runDemo, DEMO_BUYER_KEY } from '../examples/price-agreement/demo.mjs';
import { createPriceAgreementProvider } from '../examples/price-agreement/provider.mjs';
import { pack, requestUrl, x402Transport } from '../dist/index.js';
let completedDemo;
async function demoResult() {
  completedDemo ??= runDemo();
  const result = await completedDemo, provider = createPriceAgreementProvider();
  return { ...result, buyer: privateKeyToAccount(DEMO_BUYER_KEY), profile: provider.profile, pins: [{ address: provider.signer }] };
}

test('offline demo keeps three independent calls at signed 600 despite 1000/1500/2000 public prices', async () => {
  const d = await demoResult();
  assert.deepEqual(d.publicPrices, ['1000', '1500', '2000']);
  assert.equal(d.verification.valid, true); assert.equal(d.verification.settlement, 'mock-settled');
  assert.equal(d.verification.authorizationSignatures, 'not-exported');
  assert.equal(d.verification.total, '1800'); assert.equal(d.verification.calls, 3);
  assert.equal(new Set(d.acceptedCalls.map(c => c.nonce)).size, 3);
  assert.equal(new Set(d.acceptedCalls.map(c => c.transaction)).size, 3);
  assert.ok(d.acceptedCalls.every(c => c.amount === '600' && c.settlement === 'mock-settled'));
  assert.equal(new Set(d.acceptedCalls.map(c => canonical(c.agreement))).size, 1);
  assert.ok(d.rejections.every(r => r.rejected));
});

test('provider rejects another payer, unlinked or wrong-price payment before mock settlement', async () => {
  const f = await createDemoFixture();
  try {
    const input = { symbol: 'BTC-USDT' }, url = requestUrl(f.terms, input, f.profile);
    const quote = selectQuote(await f.adapters.probe(url), f.terms, input, f.profile);
    let index = 1;
    for (const mode of ['buyer', 'price', 'link', 'no-agreement']) {
      const altered = structuredClone(quote), t = structuredClone(f.terms);
      if (mode === 'price') altered.accepted.amount = '700';
      if (mode === 'link') altered.accepted.extra.alspAgreement.agreementHash = digest('wrong');
      if (mode === 'buyer') t.payer = stranger.address;
      const signer = evmSigner(mode === 'buyer' ? `0x${'62'.repeat(32)}` : DEMO_BUYER_KEY);
      const prepared = await signer.prepare(altered, t, `0x${String(index++).padStart(64, '0')}`, Date.now());
      const transport = mode === 'no-agreement' ? x402Transport(f.profile, f.provider.fetchImpl) : f.adapters;
      const wire = await transport.send(url, prepared);
      assert.ok(wire.status === 402 || wire.status === 403, mode);
      assert.equal(f.provider.state.paid, 0); assert.equal(f.provider.allowance(f.agreement.terms.agreementId).calls, 0);
    }
  } finally { f.close(); }
});

test('provider checks active registered assent on every request, rejects tampering and expiry', async () => {
  let now = Date.now();
  const provider = createPriceAgreementProvider({ now: () => now });
  const f = await createDemoFixture({ provider, now: () => now });
  try {
    const url = requestUrl(f.terms, {}, f.profile), tampered = structuredClone(f.agreement);
    tampered.terms.termsVersion = 'tampered';
    await assert.rejects(x402Transport(f.profile, provider.fetchImpl, tampered).probe(url));
    now = f.agreement.terms.expiresAt;
    await assert.rejects(f.adapters.probe(url));
    assert.equal(provider.state.paid, 0); assert.equal(f.signing.payments, 0);
  } finally { f.close(); }
});

test('provider allowance is atomic across concurrent payments and independent buyer journals', async () => {
  const f = await createDemoFixture();
  try {
    const input = {}, url = requestUrl(f.terms, input, f.profile);
    const quote = selectQuote(await f.adapters.probe(url), f.terms, input, f.profile);
    const signer = evmSigner(DEMO_BUYER_KEY);
    const prepared = await Promise.all([1, 2, 3, 4].map(i => signer.prepare(quote, f.terms, `0x${i.toString(16).padStart(64, '0')}`, Date.now())));
    const wires = await Promise.all(prepared.map(p => f.adapters.send(url, p)));
    assert.deepEqual(wires.map(w => w.status).sort(), [200, 200, 200, 409]);
    assert.equal(f.provider.state.paid, 3);
    assert.equal(f.provider.allowance(f.agreement.terms.agreementId).total, '1800');
    // Starting another local journal cannot reset the provider-side allowance.
    const second = new Journal(':memory:', f.profile);
    try {
      const id = second.create(f.terms), client = new SessionClient(second, f.adapters);
      assert.equal((await client.call(id, 'new-journal', {})).state, 'RECONCILIATION_REQUIRED');
      assert.equal(f.provider.state.paid, 3);
    } finally { second.close(); }
    assert.equal((await f.adapters.send(url, prepared[0])).status, 409, 'same authorization cannot consume another call');
  } finally { f.close(); }
});

test('archive verifier independently rejects buyer-resealed forged evidence and transitions', async () => {
  const d = await demoResult();
  const mutations = [
    a => a.summary.verifiedSpent = '1',
    a => a.evidence.pop(),
    a => a.evidence.push(structuredClone(a.evidence[0])),
    a => a.evidence[0].wire.body.price = 0,
    a => a.evidence[0].wire.body.receipt.agreement.agreementId = 'other',
    a => a.evidence[0].quote.accepted.amount = '700',
    a => a.evidence[0].quote.accepted.extra.alspAgreement.agreementHash = digest('wrong'),
    a => a.evidence[0].authorization.from = stranger.address,
    a => a.evidence[0].authorization.validBefore = '99999999999',
    a => a.evidence[0].nonce = a.evidence[1].nonce,
    a => a.evidence[0].verified.ledger.transaction = a.evidence[1].verified.ledger.transaction,
    a => a.evidence[0].verified.ledger.verification = 'rpc-confirmed',
    a => a.terms.priceAgreement.terms.unitPrice = '601',
    a => a.terms.priceAgreement.buyerSignature = a.terms.priceAgreement.providerSignature,
    a => a.events.splice(a.events.findIndex(r => r.event.kind === 'authorized'), 1),
    a => a.events.splice(a.events.findIndex(r => r.event.kind === 'response'), 1),
    a => a.events.find(r => r.event.kind === 'reserved').event.quoteHash = digest('wrong'),
    a => a.events.find(r => r.event.kind === 'authorized').event.authorizationHash = digest('wrong'),
    a => a.events.find(r => r.event.kind === 'response').event.responseHash = digest('wrong'),
    a => a.events.reverse(),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const archive = structuredClone(d.archive); mutate(archive);
    const resealed = await reseal(archive, d.buyer);
    const result = await verifyPriceAgreementArchive(resealed, d.buyer.address, d.profile, d.pins);
    assert.equal(result.valid, false, `mutation ${index} must fail independent verification`);
  }
  assert.equal((await verifyPriceAgreementArchive(d.archive, stranger.address, d.profile, d.pins)).valid, false);
  assert.equal((await verifyPriceAgreementArchive(d.archive, d.buyer.address, { ...d.profile, payTo: stranger.address }, d.pins)).valid, false);
  assert.equal((await verifyPriceAgreementArchive(d.archive, d.buyer.address, d.profile, [{ address: stranger.address }])).valid, false);
});

test('historical signed archive still verifies after agreement expiry', async () => {
  const d = await demoResult(), realNow = Date.now;
  Date.now = () => d.archive.terms.priceAgreement.terms.expiresAt + 100000;
  try {
    const result = await verifyPriceAgreementArchive(d.archive, d.buyer.address, d.profile, d.pins);
    assert.equal(result.valid, true); assert.equal(result.settlement, 'mock-settled');
  } finally { Date.now = realNow; }
});

test('agreement signature verification snapshots input before asynchronous recovery', async () => {
  const f = await fixture(), changed = { ...f.agreement.terms, unitPrice: '700' };
  const forged = { terms: f.agreement.terms, providerSignature: f.agreement.providerSignature,
    buyerSignature: await buyer.signMessage({ message: buyerAcceptanceMessage({ terms: changed, providerSignature: f.agreement.providerSignature }) }) };
  const pending = verifyPriceAgreement(forged, f.now);
  forged.terms = changed;
  await assert.rejects(pending, /Invalid bilateral/);
});

test('ending and resuming cannot reopen exhausted agreement allowance with wider session caps', async () => {
  const f = await createDemoFixture({ termsOverrides: { maxCalls: 10 } });
  try {
    const second = f.journal.create(f.terms);
    for (let i = 0; i < 3; i++) {
      const id = i === 2 ? second : f.sessionId;
      assert.equal((await f.client.call(id, `resume-${i}`, {})).state, 'VERIFIED');
    }
    f.journal.end(f.sessionId);
    assert.throws(() => f.journal.resume(f.sessionId), /allowance exhausted/);
    assert.equal(f.journal.session(f.sessionId).state, 'ENDED');
  } finally { f.close(); }
});

test('fully re-linked buyer forgery cannot duplicate settlements, change receipt lifetime, or resume exhausted agreement', async () => {
  const d = await demoResult();
  for (const mode of ['transaction', 'lifetime', 'resume']) {
    const a = structuredClone(d.archive);
    if (mode === 'transaction') {
      const item = a.evidence[1];
      item.wire.settlement.transaction = a.evidence[0].wire.settlement.transaction;
      item.verified.ledger.transaction = a.evidence[0].verified.ledger.transaction;
      a.events.find(r => r.event.kind === 'response' && r.event.callId === item.callId).event.responseHash = digest(item.wire);
      a.events.find(r => r.event.kind === 'verified' && r.event.callId === item.callId).event.proof = item.verified;
    } else if (mode === 'lifetime') {
      const item = a.evidence[0];
      item.authorization.validAfter = String(Math.floor(Date.parse(item.wire.body.receipt.signed_at) / 1000) + 1);
      a.events.find(r => r.event.kind === 'authorized' && r.event.callId === item.callId).event.authorizationHash = digest(item.authorization);
    } else {
      a.terms.maxCalls = 10;
      a.events.push({ seq: 0, previous: '', head: '', event: { kind: 'access_resumed', reason: 'continue_after_reconciliation' } });
      a.summary.state = 'ACTIVE';
    }
    const result = await verifyPriceAgreementArchive(await reseal(a, d.buyer), d.buyer.address, d.profile, d.pins);
    assert.equal(result.valid, false, mode);
  }
});

test('buyer cannot remove every mock label and re-seal fixture evidence as a purported live run', async () => {
  const d = await demoResult(), a = structuredClone(d.archive);
  for (const item of a.evidence) {
    delete item.wire.settlement.mock;
    item.verified.ledger.verification = 'rpc-confirmed';
    a.events.find(r => r.event.kind === 'response' && r.event.callId === item.callId).event.responseHash = digest(item.wire);
    a.events.find(r => r.event.kind === 'verified' && r.event.callId === item.callId).event.proof = item.verified;
  }
  const result = await verifyPriceAgreementArchive(await reseal(a, d.buyer), d.buyer.address, d.profile, d.pins);
  assert.equal(result.valid, false);
});
