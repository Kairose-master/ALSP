// Pinned, read-only public contract snapshots. This example never fetches them at runtime.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonical } from '../../dist/index.js';

export const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const PROVENANCE = JSON.parse(readFileSync(new URL('./contracts/provenance.json', import.meta.url), 'utf8'));
function loadPinned(name) {
  const pin = PROVENANCE.sources.find(source => source.file === name);
  const bytes = readFileSync(new URL(`./contracts/${name}`, import.meta.url));
  if (!pin || sha256Bytes(bytes) !== pin.sha256) throw new Error(`Contract snapshot integrity mismatch: ${name}`);
  return JSON.parse(bytes.toString('utf8'));
}
function freezeTree(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeTree); Object.freeze(value); }
  return value;
}
freezeTree(PROVENANCE);
export const OFFER = freezeTree(loadPinned('offer.json'));
export const REQUEST_SCHEMA = freezeTree(loadPinned('request.schema.json'));
export const OUTPUT_SCHEMA = OFFER.contract.output.schema;
export const CONTRACT = Object.freeze({
  offerId: OFFER.offerId,
  metadataVersion: OFFER.metadataVersion,
  declarationUrl: OFFER.declarationUrl,
  resource: OFFER.resource,
  requestSchemaUrl: 'https://www.mahastrategies.com/context-pack-schema.json',
  observedAt: PROVENANCE.retrievedAt,
  reverifiedAt: PROVENANCE.reverifiedAt,
  outputSchemaPointer: '/contract/output/schema',
  offerSnapshotSha256: createHash('sha256').update(readFileSync(new URL('./contracts/offer.json', import.meta.url))).digest('hex'),
  requestSchemaSnapshotSha256: createHash('sha256').update(readFileSync(new URL('./contracts/request.schema.json', import.meta.url))).digest('hex'),
  maxRequestBytes: OFFER.maxRequestBytes,
  providerTermsVersion: null,
  versionCaveat: 'metadataVersion is public discovery metadata, not signed provider terms or a payment quote.',
});

// Deliberately restricted to the pinned schema vocabulary. Reject new unsupported
// keywords rather than silently claiming compliance after a future pin update.
export function assertSupportedSchema(schema) {
  const common = ['$schema', 'title', 'description', 'default', 'type', 'const', 'enum'];
  const byType = { object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'],
    string: ['minLength', 'maxLength', 'pattern'], integer: ['minimum', 'maximum'], number: ['minimum', 'maximum'], boolean: [] };
  if (!schema || !Object.hasOwn(byType, schema.type)) throw new Error('Unsupported schema type');
  for (const key of Object.keys(schema)) if (![...common, ...byType[schema.type]].includes(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (schema.$schema && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('Unsupported schema dialect');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new Error('Unsupported additionalProperties schema');
  for (const item of [schema.const, ...(schema.enum ?? [])]) if (item !== null && typeof item === 'object') throw new Error('Unsupported non-scalar const/enum');
  if (schema.type === 'object') Object.values(schema.properties ?? {}).forEach(assertSupportedSchema);
  if (schema.type === 'array') assertSupportedSchema(schema.items);
}
[REQUEST_SCHEMA, OFFER.contract.input.schema, OUTPUT_SCHEMA].forEach(assertSupportedSchema);
// Fixture support, not a complete JSON Schema implementation or meta-schema validator.
export function validateSchema(value, schema, path = '$') {
  const fail = message => { throw new Error(`Contract ${path}: ${message}`); };
  if (schema.const !== undefined && value !== schema.const) fail('const mismatch');
  if (schema.enum && !schema.enum.includes(value)) fail('enum mismatch');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateSchema(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`unexpected ${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('expected array');
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('expected string');
    // JSON Schema counts code points: one astral emoji is one, a combining sequence may be several.
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) fail('too short');
    if (schema.maxLength !== undefined && length > schema.maxLength) fail('too long');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail('pattern mismatch');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('expected finite number/integer');
    if (schema.minimum !== undefined && value < schema.minimum) fail('below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('above maximum');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail('expected boolean');
  return value;
}
function validateRequestShape(input) {
  validateSchema(input, REQUEST_SCHEMA);
  validateSchema(input, OFFER.contract.input.schema);
  if (new Set(input.documents.map(document => document.id)).size !== input.documents.length) throw new Error('Duplicate source ID');
  return input;
}
export function validateRequest(value) {
  // Clone prevents mutation across awaits; size is measured after wire serialization.
  return validateSerializedRequest(canonical(value));
}
export function validateSerializedRequest(raw) {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
  if (bytes.byteLength > CONTRACT.maxRequestBytes) throw new Error('Request byte limit exceeded');
  return validateRequestShape(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export const validateOutput = value => validateSchema(value, OUTPUT_SCHEMA);
export function validateReceivedOutput(bytes, received) {
  // Validate bytes actually returned by the injected fetch and the JSON that the
  // real transport parsed, not only the object used to construct the response.
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (canonical(parsed) !== canonical(received)) throw new Error('Received response differs from observed bytes');
  return validateOutput(received);
}
