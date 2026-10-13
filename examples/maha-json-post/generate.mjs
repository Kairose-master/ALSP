#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, lstatSync, chmodSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as alsp from '../../dist/index.js';
import { CONTRACT } from './contract.mjs';
import { createFixture, FAULTS, syntheticInput } from './fixture.mjs';

export function redactArchive(archive) {
  assert.equal(alsp.verifyChain(archive), true);
  const projection = structuredClone(archive);
  for (const evidence of projection.evidence) {
    evidence.input = { redacted: true, sha256: alsp.digest(evidence.input) };
    if (evidence.wire?.body !== null && evidence.wire?.body !== undefined) {
      evidence.wire.body = { redacted: true, sha256: alsp.digest(evidence.wire.body) };
    }
  }
  return { kind: 'redacted-native-archive-projection', sourceArchiveSha256: alsp.digest(archive),
    redactions: ['evidence[].input', 'evidence[].wire.body when non-null'],
    verificationBoundary: 'Event chain is unchanged. Raw input/output and complete archive integrity require the private outbox; this projection is not an unmodified native export or provider attestation.',
    eventChainValid: alsp.verifyChain(projection), archive: projection };
}

export async function runScenario(fault, options = {}) {
  const h = createFixture({ fault, ...options });
  try {
    const input = syntheticInput(), key = 'synthetic-local-purchase-001';
    let call = await h.client.call(h.sessionId, key, input);
    const initial = h.journal.export(h.sessionId);
    if (fault.startsWith('lost-')) { assert.equal(call.state, 'RECONCILIATION_REQUIRED'); assert.equal(call.wire, null); }
    const beforeObservation = structuredClone(call);
    const settlementObservation = await h.observeSettlement(call);
    // Independent ledger checking must not manufacture a response or alter native lifecycle.
    assert.deepEqual(h.journal.call(call.id), beforeObservation);
    for (let i = 0; i < 2; i++) assert.equal((await h.client.call(h.sessionId, key, input)).id, call.id);
    call = await h.client.reconcile(call.id);
    if (fault === 'lost-no-wire') {
      assert.equal(call.wire, null); assert.equal(call.verified, null); assert.equal(h.state.recoverableWire, null);
    }
    if (fault === 'lost-recovered-null') call = await h.client.reconcile(call.id, h.state.recoverableWire);
    h.journal.end(h.sessionId);
    const archive = h.journal.export(h.sessionId);
    const nativeState = fault === 'lost-no-wire' ? 'RECONCILIATION_REQUIRED' : 'CLOSED';
    assert.equal(archive.summary.state, nativeState);
    assert.equal(archive.summary.allocatedTotal, '1000');
    assert.equal(archive.summary.verifiedSpent, fault === 'lost-no-wire' ? '0' : '1000');
    assert.deepEqual({ authorizations: h.state.authorizations, submissions: h.state.submissions, settlements: h.state.settlements, refunds: h.state.refunds },
      { authorizations: 1, submissions: 1, settlements: 1, refunds: 0 });
    const inputDigest = alsp.digest(input);
    assert.equal(call.requestHash, alsp.digest({ endpoint: h.terms.endpoint, input }));
    assert.notEqual(inputDigest, call.requestHash);
    const outputObservation = h.state.outputSchemaObservation.status === 'valid'
      ? { status: 'observed-synthetic', usableOutputObserved: true, responseBodySha256: alsp.digest(call.wire.body), providerAuthenticity: 'unattested', semanticCorrectness: 'not-verified', economicValue: 'not-verified', schema: h.state.outputSchemaObservation }
      : { status: 'unresolved', usableOutputObserved: false, originalOutputRecoverable: false, reason: call.wire?.body === null ? 'HTTP 200 with null body does not establish delivery' : 'No schema-valid output received', schema: h.state.outputSchemaObservation, refundClaimed: false };
    const companion = {
      scenario: fault,
      request: { localRequestKey: key, clientRequestIdSha256: alsp.digest(input.clientRequestId),
        inputDigest, inputDigestAlgorithm: 'bare lowercase hex SHA-256 of canonical input only',
        requestHash: call.requestHash, requestHashAlgorithm: 'SHA-256(canonical({endpoint,input}))',
        providerInputHashClaimed: false,
        caveat: 'Local bare input digest is distinct from endpoint-bound requestHash; neither claims Maha inputHash algorithm parity.',
        transport: h.state.observations },
      native: { callState: call.state, sessionState: archive.summary.state, wireResponsePresent: call.wire !== null, wireBodyNull: call.wire?.body === null,
        allocatedTotal: archive.summary.allocatedTotal, verifiedSpent: archive.summary.verifiedSpent, unresolvedCalls: archive.summary.unresolved },
      settlementObservation, outputObservation,
      counters: { probes: h.state.probes, authorizations: h.state.authorizations, submissions: h.state.submissions, settlements: h.state.settlements, refunds: h.state.refunds },
      noAutomaticRepayment: true,
    };
    return {
      public: { companion, initial: redactArchive(initial), final: redactArchive(archive) },
      private: { input, privateKey: h.privateKey, call, initialArchive: initial, finalArchive: archive, ledgerRecoveryMaterial: h.state.records,
        recoverableWire: h.state.recoverableWire },
    };
  } finally { h.close(); }
}

function secureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Output must be a real directory');
  chmodSync(path, 0o700);
}
function writeNew(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}
export async function generate({ outDir } = {}) {
  if (!outDir) throw new Error('An explicit output directory is required');
  const root = resolve(outDir), publicDir = join(root, 'public'), privateDir = join(root, 'private-outbox');
  secureDirectory(root);
  // Fail before generating a key, opening a journal, or mock-submitting on reuse.
  if (readdirSync(root).length) throw new Error('Output directory must be empty');
  writeFileSync(join(root, '.generation-started'), 'Synthetic fixture output; use a new directory for another run.\n', { mode: 0o600, flag: 'wx' });
  secureDirectory(publicDir); secureDirectory(privateDir);
  const results = [];
  for (const fault of FAULTS) {
    const dir = join(privateDir, fault); secureDirectory(dir);
    const result = await runScenario(fault, { journalPath: join(dir, 'journal.sqlite') });
    writeNew(join(dir, 'raw-input.json'), result.private.input);
    writeNew(join(dir, 'private-material.json'), { warning: 'Synthetic ephemeral key and bearer authorization. Never fund. Do not share this outbox.', ...result.private });
    writeNew(join(publicDir, `${fault}.json`), result.public);
    results.push(result.public.companion);
  }
  const manifest = {
    exampleVersion: 'maha-json-post-schema-observation-v2', syntheticOnly: true,
    baseCommit: '545221097a48cb6480c58b5d43e05f302acef30f', contract: CONTRACT,
    publicEndpointExecuted: false, livePayments: 0, liveRpcCalls: 0,
    actualTransportOrigin: 'https://maha-json-fixture.invalid', actualNetwork: 'eip155:31337',
    publicPaymentMetadataUsedForExecution: false,
    boundaries: [
      'Request validation uses actual serialized fetch bytes; output validation uses observed response bytes and transport-received JSON against pinned official schemas.',
      'Schema-valid unsigned output does not prove authenticity, factual correctness or economic value. Local inputDigest does not reproduce Maha inputHash.',
      'The real request contract is copied into an in-process synthetic provider. No Maha service, wallet, RPC, or facilitator is contacted.',
      'Cryptographic signatures verify only an ephemeral synthetic key on a mock chain/domain; all settlement evidence is mock-settled.',
      'Native VERIFIED/CLOSED is preserved and is not proof that a usable output was delivered.',
      'No response is synthesized for the no-wire settlement check. Output remains unresolved and the reserved budget is not released.',
      'Public files are redacted projections plus companion observations. Raw input, native exports, signatures, and recovery material stay in private-outbox.',
      'Generated IDs, keys and nonces vary each run. Behavior and digest relationships are reproducible, bytes are not deterministic.',
      'No refunds, recovery endpoint, provider storage/retention guarantees, or stronger idempotency semantics are asserted.',
    ],
    scenarios: results.map(r => ({ scenario: r.scenario, native: r.native, settlement: r.settlementObservation.status, output: r.outputObservation.status, counters: r.counters })),
  };
  writeNew(join(publicDir, 'manifest.json'), manifest);
  writeFileSync(join(publicDir, 'README.txt'), 'Synthetic ALSP JSON POST / lost-output fixture. Share only this public directory.\nSee manifest.json for evidence limits. Each scenario file contains a redacted archive projection and separate observations.\nCLOSED/VERIFIED never implies recovered output. mock-settled never implies real payment.\n', { mode: 0o600, flag: 'wx' });
  return { publicDir, privateDir, manifest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2] ?? `data/maha-json-post-${Date.now()}`;
  generate({ outDir: output }).then(result => console.log(JSON.stringify({ publicDir: result.publicDir, privateOutboxExcludedFromSharing: true, scenarios: result.manifest.scenarios }, null, 2)))
    .catch(() => { console.error('Synthetic fixture failed; no real endpoint or payment was used. Do not share the private outbox.'); process.exitCode = 1; });
}
