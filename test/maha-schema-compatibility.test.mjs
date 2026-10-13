import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as alsp from '../dist/index.js';
import {
  CONTRACT, PROVENANCE, OFFER, REQUEST_SCHEMA, OUTPUT_SCHEMA, assertSupportedSchema,
  sha256Bytes, validateSchema, validateRequest, validateSerializedRequest, validateOutput, validateReceivedOutput,
} from '../examples/maha-json-post/contract.mjs';
import { createFixture, syntheticInput } from '../examples/maha-json-post/fixture.mjs';

// Every test is in-process. A forgotten injected transport must fail, never make a live request.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Network forbidden in offline schema regressions'); };
test.after(() => { globalThis.fetch = realFetch; });

test('official schema pins have exact provenance and include the published output contract', () => {
  const expected = ['6fa66b72dcb04ca80e3a7db746cbb9b2a91cfeb4b8cb66b14a278f9c332a6988', '27251cdc111fbe92a748a8f328bdb133dbdbd931bf79d7295a9b62b00d097f6b'];
  for (const [index, source] of PROVENANCE.sources.entries()) {
    assert.equal(source.sha256, expected[index]);
    assert.equal(sha256Bytes(readFileSync(new URL(`../examples/maha-json-post/contracts/${source.file}`, import.meta.url))), source.sha256);
  }
  assert.equal(CONTRACT.reverifiedAt, '2026-10-13T03:48:22Z');
  assert.equal(CONTRACT.outputSchemaPointer, '/contract/output/schema');
  assert.equal(OUTPUT_SCHEMA, OFFER.contract.output.schema);
  for (const schema of [REQUEST_SCHEMA, OFFER.contract.input.schema, OUTPUT_SCHEMA]) assert.doesNotThrow(() => assertSupportedSchema(schema));
  assert.deepEqual(validateRequest(OFFER.contract.input.example), OFFER.contract.input.example);
  assert.deepEqual(validateOutput(OFFER.contract.output.example), OFFER.contract.output.example);
  assert.throws(() => { OUTPUT_SCHEMA.properties.context.type = 'boolean'; }, TypeError);
  for (const patch of [{ anyOf: [] }, { $ref: 'https://invalid.test/schema' }, { type: ['string', 'null'] }, { additionalProperties: { type: 'string' } }]) {
    assert.throws(() => assertSupportedSchema({ ...REQUEST_SCHEMA, ...patch }), /Unsupported/);
  }
});

test('actual unpaid and paid request bytes, and transport-received UTF-8 JSON, satisfy the pins', async () => {
  const h = createFixture();
  try {
    const input = syntheticInput(), call = await h.client.call(h.sessionId, 'unicode-wire', input);
    assert.equal(call.state, 'VERIFIED');
    assert.equal(h.state.requestBodies.length, 2);
    assert.equal(h.state.requestBodies[0], h.state.requestBodies[1]);
    for (const [index, body] of h.state.requestBodies.entries()) {
      assert.equal(body, alsp.canonical(input));
      assert.match(body, /\\uac00/); // Korean is ASCII-escaped on the request wire.
      assert.match(body, /\\ud83d\\ude80/); // An astral emoji serializes as two surrogate escapes.
      assert.ok(!body.includes('가상'));
      assert.deepEqual(validateSerializedRequest(Buffer.from(body, 'utf8')), input);
      assert.equal(sha256Bytes(Buffer.from(body, 'utf8')), h.state.observations[index].bodySha256);
      assert.equal(Buffer.byteLength(body, 'utf8'), h.state.observations[index].bytes);
      assert.equal(h.state.observations[index].schemaValidation, 'valid');
    }
    const bytes = h.state.receivedResponseBytes;
    assert.match(bytes.toString('utf8'), /가상 결과입니다. 🚀/); // Response uses literal UTF-8.
    assert.ok(bytes.length > bytes.toString('utf8').length);
    assert.deepEqual(validateReceivedOutput(bytes, call.wire.body), call.wire.body);
    assert.equal(h.state.outputSchemaObservation.status, 'valid');
    assert.equal(h.state.outputSchemaObservation.wireBodySha256, sha256Bytes(bytes));
    assert.equal(h.state.outputSchemaObservation.parsedBodySha256, alsp.digest(call.wire.body));
    assert.notEqual(h.state.outputSchemaObservation.wireBodySha256, h.state.outputSchemaObservation.parsedBodySha256);
    assert.equal(call.wire.body.task, input.task);
    assert.deepEqual(call.wire.body.includedPassages.map(p => p.text), input.documents.map(d => d.text));
    assert.notEqual(call.wire.body.inputHash, `sha256:${alsp.digest(input)}`);
    assert.notEqual(alsp.digest(input), call.requestHash);
    assert.equal(call.verified.receipt.signer, 'none');
    assert.equal(call.verified.semanticCorrectness, 'not-verified');
  } finally { h.close(); }
});

for (const [field, limit] of [['clientRequestId', 120], ['task', 1200], ['title', 160]]) {
  test(`JSON Schema ${field} length counts Unicode code points at its boundary`, () => {
    for (const symbol of ['한', '🚀']) {
      const input = syntheticInput();
      const target = field === 'title' ? input.documents[0] : input;
      target[field] = symbol.repeat(limit);
      assert.equal(Array.from(target[field]).length, limit);
      if (symbol === '🚀') assert.equal(target[field].length, limit * 2);
      assert.deepEqual(validateRequest(input), input);
      target[field] += symbol;
      assert.throws(() => validateRequest(input), /too long/);
    }
  });
}

test('minimum length is not UTF-16 length, and combining/ZWJ sequences are not one code point', () => {
  const input = syntheticInput();
  input.clientRequestId = '🚀'.repeat(7);
  assert.equal(input.clientRequestId.length, 14);
  assert.throws(() => validateRequest(input), /too short/);
  input.clientRequestId += '🚀'; input.task = '🚀'.repeat(8);
  assert.doesNotThrow(() => validateRequest(input));
  const composed = 'é', decomposed = 'e\u0301', zwj = '👩‍💻';
  assert.equal(Array.from(composed).length, 1); assert.equal(Array.from(decomposed).length, 2); assert.equal(Array.from(zwj).length, 3);
  assert.doesNotThrow(() => validateSchema(composed, { type: 'string', maxLength: 1 }));
  for (const value of [decomposed, zwj]) assert.throws(() => validateSchema(value, { type: 'string', maxLength: 1 }), /too long/);
  input.documents[0].text = `${composed}/${decomposed}/${zwj}/\u0000/\n/"/\\`;
  assert.deepEqual(validateSerializedRequest(alsp.canonical(input)), input, 'No Unicode normalization or escape loss');
});

test('450,000-byte bound uses the exact serialized request, including escaped Korean and emoji', async () => {
  const h = createFixture();
  try {
    const input = syntheticInput(); input.documents = [{ id: 'unicode', text: '한🚀' }];
    input.documents[0].text += 'x'.repeat(CONTRACT.maxRequestBytes - Buffer.byteLength(alsp.canonical(input), 'utf8'));
    assert.equal(Buffer.byteLength(alsp.canonical(input), 'utf8'), 450000);
    assert.ok(Buffer.byteLength(JSON.stringify(input), 'utf8') < 450000);
    assert.doesNotThrow(() => validateRequest(input));
    const call = await h.client.call(h.sessionId, 'exact-byte-bound', input);
    assert.equal(call.state, 'VERIFIED');
    assert.deepEqual(h.state.observations.map(x => x.bytes), [450000, 450000]);
    input.documents[0].text += 'x';
    assert.throws(() => validateRequest(input), /byte limit/);
    // Significant whitespace is counted on the actual body, not removed before size validation.
    assert.throws(() => validateSerializedRequest(` ${h.state.requestBodies[0]}`), /byte limit/);
  } finally { h.close(); }
});

for (const [name, raw] of [
  ['malformed JSON', '{"documents":'], ['wrong root type', '[]'], ['missing required fields', '{}'],
  ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
]) test(`actual request body rejects ${name}`, async () => {
  assert.throws(() => validateSerializedRequest(raw));
  if (typeof raw === 'string') {
    const h = createFixture();
    try {
      await assert.rejects(h.fetchImpl(h.terms.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }));
      assert.equal(h.state.authorizations, 0); assert.equal(h.state.submissions, 0); assert.equal(h.state.settlements, 0);
    } finally { h.close(); }
  }
});

test('all required output fields are enforced at root and nested levels', () => {
  const example = OFFER.contract.output.example;
  for (const [schema, value] of [[OUTPUT_SCHEMA, example], [OUTPUT_SCHEMA.properties.metrics, example.metrics],
    [OUTPUT_SCHEMA.properties.retentionBoundaries, example.retentionBoundaries],
    [OUTPUT_SCHEMA.properties.includedPassages.items, example.includedPassages[0]], [OUTPUT_SCHEMA.properties.sources.items, example.sources[0]]]) {
    for (const key of schema.required) {
      const missing = structuredClone(value); delete missing[key];
      assert.throws(() => validateSchema(missing, schema), /missing/);
    }
  }
});

const invalidOutputs = [
  ['wrong version', b => { b.version = '0.2.0'; }],
  ['bad packId', b => { b.packId = 'unverified-id'; }],
  ['short request ID', b => { b.clientRequestId = '🚀'.repeat(7); }],
  ['unknown root member', b => { b.authorization = true; }],
  ['wrong context type', b => { b.context = {}; }],
  ['fractional count', b => { b.metrics.originalBytes = 1.5; }],
  ['negative count', b => { b.metrics.tokensSaved = -1; }],
  ['out-of-range percentage', b => { b.metrics.sourceCoveragePercent = 101; }],
  ['unknown nested member', b => { b.metrics.charge = 0; }],
  ['bad passage ID', b => { b.includedPassages[0].passageId = 'unicode:0'; }],
  ['empty passage', b => { b.includedPassages[0].text = ''; }],
  ['bad passage hash', b => { b.includedPassages[0].passageHash = 'sha256:no'; }],
  ['empty sources', b => { b.sources = []; }],
  ['too many sources', b => { b.sources = Array(9).fill(b.sources[0]); }],
  ['wrong warning type', b => { b.warnings = [false]; }],
  ['unknown warning code', b => { b.warningCodes = ['invented']; }],
  ['false verification claim', b => { b.retentionBoundaries.claimVerificationPerformed = true; }],
  ['bad inputHash', b => { b.inputHash = 'sha256:' + 'A'.repeat(64); }],
  ['bare outputHash', b => { b.outputHash = 'f'.repeat(64); }],
  ['stored source claim', b => { b.sourceTextStored = true; }],
];
for (const [name, mutate] of invalidOutputs) test(`received JSON rejects ${name} even when fixture source was valid`, async () => {
  const h = createFixture({ responseTransform: async response => {
    const body = await response.json(); mutate(body);
    return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
  } });
  try {
    const call = await h.client.call(h.sessionId, `invalid-response-${name.replaceAll(' ', '-')}`, syntheticInput());
    assert.equal(call.wire.status, 200);
    assert.throws(() => validateOutput(call.wire.body));
    assert.equal(h.state.outputSchemaObservation.status, 'invalid');
    // Native unsigned receipt/settlement state remains independent of output quality.
    assert.equal(call.state, 'VERIFIED');
    assert.equal((await h.observeSettlement(call)).status, 'mock-settled');
    assert.equal(h.state.authorizations, 1); assert.equal(h.state.submissions, 1); assert.equal(h.state.settlements, 1); assert.equal(h.state.refunds, 0);
    await h.client.call(h.sessionId, `invalid-response-${name.replaceAll(' ', '-')}`, syntheticInput());
    assert.equal(h.state.submissions, 1);
  } finally { h.close(); }
});

test('malformed response JSON is unresolved, while replacement-decoded invalid UTF-8 is flagged independently', async () => {
  for (const malformed of [true, false]) {
    const h = createFixture({ responseTransform: async response => {
      const text = await response.text();
      const [before, after] = text.split('SYNTHETIC COMPILED OUTPUT');
      const bytes = malformed ? Buffer.from('{"context":') : Buffer.concat([Buffer.from(before), Buffer.from([0xc3, 0x28]), Buffer.from(after)]);
      return new Response(bytes, { status: 200, headers: response.headers });
    } });
    try {
      const call = await h.client.call(h.sessionId, 'bad-encoding', syntheticInput());
      assert.equal(h.state.outputSchemaObservation.status, malformed ? 'invalid-json' : 'invalid');
      assert.equal(call.state, malformed ? 'RECONCILIATION_REQUIRED' : 'VERIFIED');
      assert.equal((await h.observeSettlement(call)).status, 'mock-settled');
      assert.equal(h.state.submissions, 1); assert.equal(h.state.refunds, 0);
    } finally { h.close(); }
  }
});

test('schema success cannot establish output authenticity, cross-field correctness, value or Maha hash equivalence', () => {
  const output = structuredClone(OFFER.contract.output.example);
  output.context = 'A schema-valid but invented claim.';
  output.metrics.compiledBytes = 0; output.metrics.tokensSaved = 99999;
  output.inputHash = `sha256:${'0'.repeat(64)}`; output.outputHash = `sha256:${'1'.repeat(64)}`;
  assert.doesNotThrow(() => validateOutput(output), 'Published schema checks structure, not these semantic relationships');
  const raw = Buffer.from(JSON.stringify(output));
  assert.doesNotThrow(() => validateReceivedOutput(raw, output));
  assert.throws(() => validateReceivedOutput(raw, { ...output, context: 'Different received value' }), /differs/);
});
