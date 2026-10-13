import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as alsp from '../dist/index.js';
import { CONTRACT, OFFER, validateRequest, validateOutput } from '../examples/maha-json-post/contract.mjs';
import { createFixture, FAULTS, syntheticInput, NOW } from '../examples/maha-json-post/fixture.mjs';
import { generate, runScenario } from '../examples/maha-json-post/generate.mjs';

for (const fault of FAULTS) test(`Maha JSON POST: ${fault}, one authorization/submission, separate output observation`, async () => {
  const result = await runScenario(fault);
  const { companion, initial, final } = result.public;
  const missing = fault !== 'success';
  assert.equal(companion.settlementObservation.status, 'mock-settled');
  assert.equal(companion.settlementObservation.proof.verification, 'mock-settled');
  assert.equal(companion.settlementObservation.wireResponseRequired, false);
  assert.equal(companion.outputObservation.status, missing ? 'unresolved' : 'observed-synthetic');
  assert.equal(companion.native.sessionState, fault === 'lost-no-wire' ? 'RECONCILIATION_REQUIRED' : 'CLOSED');
  assert.equal(companion.native.callState, fault === 'lost-no-wire' ? 'RECONCILIATION_REQUIRED' : 'VERIFIED');
  assert.equal(companion.native.allocatedTotal, '1000');
  assert.equal(companion.counters.authorizations, 1);
  assert.equal(companion.counters.submissions, 1);
  assert.equal(companion.counters.settlements, 1);
  assert.equal(companion.counters.refunds, 0);
  assert.equal(companion.request.transport.length, 2);
  assert.deepEqual(companion.request.transport.map(x => x.paymentHeaderPresent), [false, true]);
  for (const observation of companion.request.transport) {
    assert.equal(observation.method, 'POST'); assert.equal(observation.path, '/api/v1/compress');
    assert.equal(observation.queryPresent, false); assert.equal(observation.bodyPresent, true);
    assert.equal(observation.contentType, 'application/json');
    assert.equal(observation.bodySha256, companion.request.inputDigest);
    assert.equal(observation.schemaValidation, 'valid');
    assert.equal(observation.validationSource, 'actual serialized fetch body');
  }
  assert.match(companion.request.inputDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(companion.request.inputDigest, companion.request.requestHash);
  assert.equal(companion.request.providerInputHashClaimed, false);
  assert.equal(alsp.verifyChain(initial.archive), true); assert.equal(alsp.verifyChain(final.archive), true);
  assert.equal(final.kind, 'redacted-native-archive-projection');
  assert.deepEqual(final.archive.evidence[0].input, { redacted: true, sha256: companion.request.inputDigest });
  if (fault === 'lost-no-wire') {
    assert.equal(final.archive.evidence[0].wire, null); assert.equal(final.archive.evidence[0].verified, null);
    assert.equal(companion.native.verifiedSpent, '0'); assert.equal(companion.native.unresolvedCalls, 1);
    assert.equal(result.private.recoverableWire, null);
    assert.ok(companion.settlementObservation.proof.transaction);
  } else if (missing) {
    assert.equal(final.archive.evidence[0].wire.body, null);
    assert.equal(final.archive.evidence[0].verified.receipt.signer, 'none');
    assert.equal(companion.outputObservation.usableOutputObserved, false);
  } else {
    validateOutput(result.private.call.wire.body);
    assert.equal(companion.outputObservation.schema.status, 'valid');
    assert.equal(companion.outputObservation.schema.validationSource, 'transport-received JSON');
    assert.equal(companion.outputObservation.economicValue, 'not-verified');
  }
  if (missing) assert.notEqual(companion.outputObservation.schema.status, 'valid');
});

test('Maha contract snapshots: explicit offer/version and valid nested synthetic input', () => {
  assert.equal(CONTRACT.offerId, 'context-compression');
  assert.equal(CONTRACT.metadataVersion, '2026-08-10');
  assert.equal(CONTRACT.resource.method, 'POST');
  assert.equal(new URL(CONTRACT.resource.url).pathname, '/api/v1/compress');
  assert.equal(CONTRACT.providerTermsVersion, null);
  const input = syntheticInput(); assert.deepEqual(validateRequest(input), input);
  const normalized = validateRequest(input); normalized.documents[0].text = 'mutated';
  assert.notEqual(normalized.documents[0].text, input.documents[0].text);
  assert.equal(OFFER.maxRequestBytes, 450000);
});

const invalidInputs = [
  ['missing clientRequestId', i => { delete i.clientRequestId; }],
  ['short clientRequestId', i => { i.clientRequestId = 'short'; }],
  ['long clientRequestId', i => { i.clientRequestId = 'x'.repeat(121); }],
  ['short task', i => { i.task = 'short'; }],
  ['long task', i => { i.task = 'x'.repeat(1201); }],
  ['low tokenBudget', i => { i.tokenBudget = 63; }],
  ['high tokenBudget', i => { i.tokenBudget = 16001; }],
  ['noninteger tokenBudget', i => { i.tokenBudget = 64.5; }],
  ['no documents', i => { i.documents = []; }],
  ['too many documents', i => { i.documents = Array.from({ length: 9 }, (_, n) => ({ id: `doc-${n}`, text: 'x' })); }],
  ['missing document text', i => { delete i.documents[0].text; }],
  ['empty document text', i => { i.documents[0].text = ''; }],
  ['invalid document ID', i => { i.documents[0].id = '../doc'; }],
  ['duplicate document ID', i => { i.documents[1].id = i.documents[0].id; }],
  ['extra root property', i => { i.payment = true; }],
  ['extra document property', i => { i.documents[0].privateField = true; }],
  ['inherited root property name', i => { Object.defineProperty(i, '__proto__', { value: { unexpected: true }, enumerable: true }); }],
  ['inherited document property name', i => { i.documents[0].constructor = { unexpected: true }; }],
  ['bad provenance', i => { i.provenance = 'invented'; }],
  ['byte limit', i => { i.documents[0].text = 'x'.repeat(450000); }],
];
for (const [name, mutate] of invalidInputs) test(`Maha input rejected before any authorization: ${name}`, async () => {
  const h = createFixture();
  try {
    const input = syntheticInput(); mutate(input);
    await assert.rejects(h.client.call(h.sessionId, 'invalid-input', input));
    assert.equal(h.state.authorizations, 0); assert.equal(h.state.submissions, 0); assert.equal(h.state.settlements, 0);
    assert.equal(h.journal.calls(h.sessionId).length, 0);
  } finally { h.close(); }
});

test('Maha contract accepts required min/max boundaries including 120-character request ID', () => {
  for (const edge of [0, 1]) {
    const input = syntheticInput();
    input.clientRequestId = 'x'.repeat(edge ? 120 : 8); input.task = 'x'.repeat(edge ? 1200 : 8);
    input.tokenBudget = edge ? 16000 : 64;
    input.documents = Array.from({ length: edge ? 8 : 1 }, (_, n) => ({ id: `source-${n}`, text: 'x' }));
    assert.deepEqual(validateRequest(input), input);
  }
});

test('Lost JSON response: changed input key rejected; read-only settlement cannot refund or release budget', async () => {
  const h = createFixture({ fault: 'lost-no-wire' });
  try {
    const input = syntheticInput(), c = await h.client.call(h.sessionId, 'one', input);
    await h.observeSettlement(c);
    const changed = structuredClone(input); changed.documents[0].text += 'Different content.';
    await assert.rejects(h.client.call(h.sessionId, 'one', changed), /different input/);
    await assert.rejects(h.client.call(h.sessionId, 'two', input), /policy|budget/i);
    h.journal.end(h.sessionId);
    assert.throws(() => h.journal.resume(h.sessionId, NOW), /Unresolved/);
    const report = h.journal.export(h.sessionId);
    assert.equal(report.summary.allocatedTotal, '1000'); assert.equal(report.summary.verifiedSpent, '0');
    assert.equal(h.state.authorizations, 1); assert.equal(h.state.submissions, 1); assert.equal(h.state.settlements, 1);
    assert.equal(h.state.refunds, 0);
  } finally { h.close(); }
});

test('Independent mock ledger check without WireResponse rejects forged receipt/payment evidence', async () => {
  const h = createFixture({ fault: 'lost-no-wire' });
  try {
    const c = await h.client.call(h.sessionId, 'one', syntheticInput());
    assert.equal(c.wire, null);
    const record = h.state.records[0], original = structuredClone(record.receipt);
    const check = (call = c, terms = h.terms, rpc = h.rpc, tx = record.transaction) => alsp.verifySettlementTransaction(call, terms, tx, rpc);
    assert.equal((await check()).verification, 'rpc-confirmed'); // relabeled mock-settled by fixture only after verification
    const badAddress = '0x0000000000000000000000000000000000000099';
    const topic = a => `0x${a.slice(2).padStart(64, '0')}`;
    for (const mutate of [
      r => { r.status = '0x0'; },
      r => { r.transactionHash = `0x${'aa'.repeat(32)}`; },
      r => { r.blockHash = `0x${'bb'.repeat(32)}`; },
      r => { r.logs[0].topics[2] = `0x${'cc'.repeat(32)}`; },
      r => { r.logs[0].topics[1] = topic(badAddress); },
      r => { r.logs[1].topics[2] = topic(badAddress); },
      r => { r.logs[1].topics[1] = topic(badAddress); },
      r => { r.logs[1].data = '0x3e9'; },
      r => { r.logs[1].address = badAddress; },
      r => { r.logs[0].removed = true; },
    ]) {
      record.receipt = structuredClone(original); mutate(record.receipt);
      await assert.rejects(check());
    }
    record.receipt = original;
    await assert.rejects(check(c, h.terms, async (method, params) => method === 'eth_chainId' ? '0x1' : h.rpc(method, params)), /chain/);
    await assert.rejects(check(c, h.terms, async (method, params) => method === 'eth_blockNumber' ? '0x1' : h.rpc(method, params)), /confirmations/);
    await assert.rejects(check(c, h.terms, h.rpc, `0x${'aa'.repeat(32)}`));
    for (const patch of [{ amount: '999' }, { nonce: `0x${'dd'.repeat(32)}` }, { prepared: null }]) await assert.rejects(check({ ...c, ...patch }));
    assert.equal(h.journal.call(c.id).state, 'RECONCILIATION_REQUIRED');
    assert.equal(h.journal.call(c.id).wire, null);
    assert.equal(h.state.authorizations, 1); assert.equal(h.state.submissions, 1);
  } finally { h.close(); }
});

test('Public export excludes raw input, compiled text, private keys, signatures and recovery material', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alsp-maha-private-'));
  try {
    const result = await generate({ outDir: root });
    const files = readdirSync(result.publicDir);
    assert.deepEqual(files.sort(), [...FAULTS.map(x => `${x}.json`), 'manifest.json', 'README.txt'].sort());
    const publicText = files.map(file => readFileSync(join(result.publicDir, file), 'utf8')).join('\n');
    assert.ok(!publicText.includes('SYNTHETIC SOURCE ALPHA'));
    assert.ok(!publicText.includes('SYNTHETIC COMPILED OUTPUT'));
    assert.ok(!publicText.includes('synthetic-context-request-001'));
    assert.ok(!publicText.includes('가상')); assert.ok(!publicText.includes('🚀'));
    assert.ok(!publicText.includes('requestBodies')); assert.ok(!publicText.includes('receivedResponseBytes'));
    assert.ok(!publicText.includes('privateKey')); assert.ok(!publicText.includes('recoverableWire'));
    for (const fault of FAULTS) {
      const path = join(result.privateDir, fault, 'private-material.json');
      const local = JSON.parse(readFileSync(path, 'utf8'));
      assert.ok(!publicText.includes(local.privateKey));
      assert.ok(!publicText.includes(local.call.prepared.signature));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(result.privateDir, fault, 'journal.sqlite')).mode & 0o777, 0o600);
      assert.equal(statSync(join(result.privateDir, fault)).mode & 0o777, 0o700);
    }
    const journalPath = join(result.privateDir, 'success', 'journal.sqlite');
    const beforeRerun = readFileSync(journalPath);
    await assert.rejects(generate({ outDir: root }), /empty|EEXIST/);
    assert.deepEqual(readFileSync(journalPath), beforeRerun, 'Rejected rerun must not change journal bytes or submit another mock call');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
