#!/usr/bin/env node
// Real cryptographic signatures over public fixture keys; entirely fictitious payments.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import * as alsp from '../../dist/index.js';
import { createPriceAgreementProvider } from './provider.mjs';

// PUBLIC THROWAWAY FIXTURES. Never fund these addresses or use these keys elsewhere.
export const DEMO_BUYER_KEY = `0x${'11'.repeat(32)}`;
export const DEMO_WRONG_BUYER_KEY = `0x${'12'.repeat(32)}`;
export const DEMO_LICENSE_TEXT = 'ALSP offline fixed-price agreement demonstration, version 1. Synthetic data only; no service warranty. Each successful call is individually mock-settled.';
export const DEMO_TERMS_SHA256 = createHash('sha256').update(DEMO_LICENSE_TEXT).digest('hex');
const clone = value => JSON.parse(alsp.canonical(value));

/** Reusable test fixture; its database and every API/RPC request remain in-process. */
export async function createDemoFixture({
  provider = createPriceAgreementProvider(), buyerKey = DEMO_BUYER_KEY,
  agreementOverrides = {}, termsOverrides = {}, journalPath = ':memory:', now = Date.now,
} = {}) {
  const buyer = alsp.evmSigner(buyerKey), buyerAccount = privateKeyToAccount(buyerKey);
  const profile = provider.profile, createdAt = now();
  const offer = await provider.createOffer({
    profile: alsp.PRICE_AGREEMENT_PROFILE, agreementId: 'offline-fixed-price-001',
    buyer: buyer.address, provider: profile.payTo, network: profile.network,
    asset: profile.asset.address, endpoint: provider.endpoint, method: profile.method,
    termsVersion: 'offline-demo-v1', termsSha256: DEMO_TERMS_SHA256,
    unitPrice: '600', maxCalls: 3, maxTotal: '1800',
    validFrom: Math.max(0, createdAt - 1000), expiresAt: createdAt + 600000,
    ...agreementOverrides,
  });
  const agreement = { ...offer, buyerSignature: await buyerAccount.signMessage({ message: alsp.buyerAcceptanceMessage(offer) }) };
  await provider.register(agreement);
  const terms = {
    profile: alsp.PROFILE, payer: buyer.address, provider: profile.payTo,
    network: profile.network, asset: profile.asset.address, endpoint: provider.endpoint,
    maxTotal: '7500', maxPerCall: '2500', maxCalls: 3, expiresAt: agreement.terms.expiresAt,
    license: { uri: 'urn:alsp:offline-demo:terms:v1', sha256: agreement.terms.termsSha256, acceptance: 'bilateral' },
    priceAgreement: agreement, ...termsOverrides,
  };
  const pins = [{ address: provider.signer }];
  const rpc = alsp.jsonRpc(provider.rpcUrl, provider.fetchImpl);
  const transport = alsp.x402Transport(profile, provider.fetchImpl, agreement);
  const signing = { payments: 0 };
  const adapters = {
    ...transport,
    async prepare(...args) { signing.payments++; return buyer.prepare(...args); },
    async verify(call, sessionTerms) {
      const receipt = await alsp.verifyReceipt(call, sessionTerms, pins, profile, now());
      const ledger = await alsp.verifySettlement(call, sessionTerms, rpc);
      // The same log-binding checks ran against our fake RPC, never a live chain.
      if (call.wire?.settlement?.mock !== true) throw new Error('Missing explicit mock settlement marker');
      return { receipt, ledger: { ...ledger, verification: 'mock-settled' }, semanticCorrectness: 'not-verified' };
    },
  };
  const journal = new alsp.Journal(journalPath, profile);
  let sessionId;
  try { sessionId = journal.create(terms, now()); }
  catch (error) { journal.close(); throw error; }
  const client = new alsp.SessionClient(journal, adapters, now);
  return { provider, profile, buyer, agreement, terms, journal, sessionId, client, adapters, pins, rpc, signing,
    close() { journal.close(); } };
}

async function rejectionDemonstrations(fixture) {
  const { provider, agreement, buyer, journal, sessionId, adapters, signing, terms, profile } = fixture;
  const outcomes = [];
  async function rejected(name, action) {
    let failure;
    try { await action(); } catch (error) { failure = error; }
    assert.ok(failure, `${name} must be rejected`);
    outcomes.push({ scenario: name, rejected: true, reason: failure.message });
  }
  const wrong = privateKeyToAccount(DEMO_WRONG_BUYER_KEY);
  const offer = { terms: agreement.terms, providerSignature: agreement.providerSignature };
  await rejected('wrong buyer', async () => provider.register({ ...agreement,
    buyerSignature: await wrong.signMessage({ message: alsp.buyerAcceptanceMessage(offer) }) }));
  const tampered = clone(agreement);
  tampered.terms.maxTotal = '1801';
  await rejected('tampered signed terms', () => provider.register(tampered));
  const current = Date.now();
  const expiredOffer = await provider.createOffer({ ...agreement.terms, agreementId: 'offline-expired',
    validFrom: current - 120000, expiresAt: current - 60000 });
  const expired = { ...expiredOffer, buyerSignature: await buyer.signManifest(alsp.buyerAcceptanceMessage(expiredOffer)) };
  await rejected('expired agreement', () => provider.register(expired));

  const input = { symbol: 'BTC-USDT' }, url = alsp.requestUrl(terms, input, profile);
  const originalChallenge = await adapters.probe(url);
  for (const [scenario, amount] of [['quote above agreed price', '700'], ['quote below agreed price', '500']]) {
    const altered = clone(originalChallenge);
    altered.accepts[0].amount = amount;
    assert.ok(BigInt(amount) < BigInt(terms.maxPerCall), 'The general cap alone would allow this quote');
    const client = new alsp.SessionClient(journal, { ...adapters, probe: async () => altered });
    await rejected(`${scenario} (${amount}, below general cap ${terms.maxPerCall})`,
      () => client.call(sessionId, `reject-${amount}`, input));
  }
  assert.equal(signing.payments, 0, 'Rejections must happen before any payment signature');
  assert.equal(journal.calls(sessionId).length, 0, 'Rejected quotes must not allocate calls');
  assert.equal(provider.state.paid, 0, 'Rejected agreements must not mock-settle');
  return outcomes;
}

/** Run the complete offline scenario. Pass archivePath to write the buyer-sealed JSON. */
export async function runDemo({ archivePath, log = () => {} } = {}) {
  const fixture = await createDemoFixture();
  const { provider, profile, buyer, agreement, terms, journal, sessionId, client, pins, signing } = fixture;
  try {
    log('OFFLINE DEMO: public fixture keys, synthetic balances, and mock settlement only.');
    log('No real payment, wallet connection, remote service, or live interoperability is demonstrated.');
    await alsp.verifyPriceAgreement(agreement);
    log(`Bilateral agreement: ${agreement.terms.agreementId}; fixed unit price ${agreement.terms.unitPrice} atomic units; general per-call cap ${terms.maxPerCall}.`);
    const rejections = await rejectionDemonstrations(fixture);
    for (const rejection of rejections) log(`Rejected before payment signing: ${rejection.scenario}.`);

    const publicTransport = alsp.x402Transport(profile, provider.fetchImpl);
    const publicPrices = ['1000', '1500', '2000'];
    const symbols = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
    const calls = [];
    for (const [index, publicPrice] of publicPrices.entries()) {
      provider.setPublicPrice(publicPrice);
      const input = { symbol: symbols[index] };
      const publicChallenge = await publicTransport.probe(alsp.requestUrl(terms, input, profile));
      assert.equal(publicChallenge.accepts[0].amount, publicPrice);
      assert.equal(publicChallenge.accepts[0].extra.alspAgreement, undefined);
      const call = await client.call(sessionId, `quote-${index + 1}`, input);
      assert.equal(call.state, 'VERIFIED', 'Every call must independently verify its receipt and mock ledger entry');
      assert.equal(call.amount, '600');
      assert.equal(call.verified.ledger.verification, 'mock-settled');
      assert.deepEqual(call.wire.body.receipt.agreement, alsp.agreementLink(agreement));
      calls.push(call);
      log(`Call ${index + 1}: public quote ${publicPrice}; agreed quote/payment 600; mock-settled; nonce ${call.nonce}; transaction ${call.verified.ledger.transaction}.`);
    }
    assert.equal(new Set(calls.map(call => call.nonce)).size, 3);
    assert.equal(new Set(calls.map(call => call.verified.ledger.transaction)).size, 3);
    assert.equal(provider.state.paid, 3);
    assert.equal(signing.payments, 3);
    assert.deepEqual(provider.allowance(agreement.terms.agreementId), { calls: 3, total: '1800', maxCalls: 3, maxTotal: '1800' });
    // A local idempotent replay returns the persisted call without signing or paying.
    assert.equal((await client.call(sessionId, 'quote-1', { symbol: symbols[0] })).id, calls[0].id);
    assert.equal(provider.state.paid, 3);
    journal.end(sessionId);
    const report = journal.export(sessionId);
    const manifest = { profile: alsp.PROFILE, sessionId, archiveSha256: alsp.digest(report), headHash: report.headHash };
    const archive = { ...report, buyerSeal: { manifest, signer: buyer.address, signature: await buyer.signManifest(alsp.canonical(manifest)) } };
    const verification = await alsp.verifyPriceAgreementArchive(archive, buyer.address, profile, pins);
    assert.equal(verification.valid, true, 'Buyer seal, bilateral agreement, receipts, and per-call evidence must verify');
    assert.equal(verification.settlement, 'mock-settled');
    const serialized = `${JSON.stringify(archive, null, 2)}\n`;
    for (const call of calls) assert.ok(!serialized.includes(call.prepared.signature), 'Export must never contain bearer payment signatures');
    for (const key of [DEMO_BUYER_KEY, DEMO_WRONG_BUYER_KEY]) assert.ok(!serialized.includes(key), 'Export must not contain private keys');
    if (archivePath) {
      const destination = resolve(archivePath);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, serialized, { mode: 0o600 });
      log(`Buyer-sealed archive: ${destination}`);
    }
    log('Archive verified: bilateral agreement, 3 linked signed receipts, 3 unique mock settlements, total 1800 atomic units.');
    log('Archive verification checks stored evidence; it does not establish real-chain settlement or service correctness.');
    return { archive, verification, publicPrices, rejections, calls: archive.evidence, acceptedCalls: provider.acceptedCalls };
  } finally { fixture.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0]?.startsWith('-')) {
    console.error('Usage: node examples/price-agreement/demo.mjs [archive.json]');
    process.exitCode = 1;
  } else {
    runDemo({ archivePath: args[0] ?? 'data/price-agreement-archive.json', log: console.log }).catch(() => {
      // SDK/fetch errors can contain bearer authorizations; never print raw objects.
      console.error('Offline fixed-price demo failed. No live network or real payment was used.');
      process.exitCode = 1;
    });
  }
}
