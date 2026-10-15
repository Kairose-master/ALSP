import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverT54, t54Network, T54Error } from '../dist/integrations/t54-xrpl.js';

test('t54 networks remain explicitly separated', () => {
  assert.equal(t54Network('mainnet'), 'xrpl:0');
  assert.equal(t54Network('testnet'), 'xrpl:1');
  assert.throws(() => t54Network('unknown'), T54Error);
});

test('capability discovery is GET-only and defaults to testnet', async () => {
  let calls = 0;
  const result = await discoverT54('testnet', { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://xrpl-facilitator-testnet.t54.ai/supported');
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ kinds: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.supported, { kinds: [] });
});

test('invalid responses and HTTP failures fail closed', async () => {
  await assert.rejects(discoverT54('testnet', { fetchImpl: async () => new Response('failure', { status: 503 }) }), T54Error);
  await assert.rejects(discoverT54('testnet', { fetchImpl: async () => new Response('[]', { status: 200 }) }), T54Error);
});
