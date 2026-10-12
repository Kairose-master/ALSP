// Pinned, read-only public contract snapshots. This example never fetches them at runtime.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonical } from '../../dist/index.js';

export const OFFER = JSON.parse(readFileSync(new URL('./contracts/offer.json', import.meta.url), 'utf8'));
export const REQUEST_SCHEMA = JSON.parse(readFileSync(new URL('./contracts/request.schema.json', import.meta.url), 'utf8'));
export const CONTRACT = Object.freeze({
  offerId: OFFER.offerId,
  metadataVersion: OFFER.metadataVersion,
  declarationUrl: OFFER.declarationUrl,
  resource: OFFER.resource,
  requestSchemaUrl: 'https://www.mahastrategies.com/context-pack-schema.json',
  observedAt: '2026-10-12',
  offerSnapshotSha256: createHash('sha256').update(readFileSync(new URL('./contracts/offer.json', import.meta.url))).digest('hex'),
  requestSchemaSnapshotSha256: createHash('sha256').update(readFileSync(new URL('./contracts/request.schema.json', import.meta.url))).digest('hex'),
  maxRequestBytes: OFFER.maxRequestBytes,
  providerTermsVersion: null,
  versionCaveat: 'metadataVersion is public discovery metadata, not signed provider terms or a payment quote.',
});

// Small validator for the keywords used by these two pinned contracts; no remote schema loading.
// This is fixture support, not a general JSON Schema implementation.
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
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) fail('too short');
    if (schema.maxLength !== undefined && length > schema.maxLength) fail('too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('pattern mismatch');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) fail('expected finite number/integer');
    if (schema.minimum !== undefined && value < schema.minimum) fail('below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('above maximum');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail('expected boolean');
  return value;
}
export function validateRequest(value) {
  // Canonicalization rejects non-JSON members; clone prevents mutation across awaits.
  const input = JSON.parse(canonical(value));
  validateSchema(input, REQUEST_SCHEMA);
  validateSchema(input, OFFER.contract.input.schema);
  if (new Set(input.documents.map(document => document.id)).size !== input.documents.length) throw new Error('Duplicate source ID');
  if (Buffer.byteLength(canonical(input), 'utf8') > CONTRACT.maxRequestBytes) throw new Error('Request byte limit exceeded');
  return input;
}
export const validateOutput = value => validateSchema(value, OFFER.contract.output.schema);
