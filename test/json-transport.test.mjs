import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import {
  ASSET, DOCTOR_PROVIDER, PROFILE, Journal, SessionClient, canonical, defineProvider, digest,
  doctorTransport, evmSigner, inputOf, pack, requestBody, requestUrl, selectQuote,
  verifySettlement, verifySettlementTransaction, x402Transport,
} from '../dist/index.js';

// Ephemeral in-memory fixture account; no signing key is persisted or funded.
const signer = evmSigner(generatePrivateKey());
const payTo = `0x${'92'.repeat(20)}`, stranger = `0x${'93'.repeat(20)}`;
const TX = `0x${'94'.repeat(32)}`, BLOCK = `0x${'95'.repeat(32)}`, NONCE = `0x${'96'.repeat(32)}`;
const now = Date.now();
const profile = defineProvider({
  id: 'json-fixture', label: 'Offline JSON fixture', origin: 'https://json.alsp.local', endpointPath: '/paid',
  method: 'POST', requestEncoding: 'json', network: 'eip155:8453',
  asset: { address: ASSET, name: 'USD Coin', version: '2' }, payTo, receipt: { mode: 'unsigned' },
});
const terms = {
  profile: PROFILE, payer: signer.address, provider: payTo, network: profile.network, asset: ASSET,
  endpoint: `${profile.origin}${profile.endpointPath}`, maxTotal: '3000', maxPerCall: '1000', maxCalls: 3,
  expiresAt: now + 600000, license: { uri: 'urn:offline:json-fixture', sha256: digest('offline fixture'), acceptance: 'buyer-only' },
};
const challenge = {
  x402Version: 2, resource: { url: terms.endpoint }, accepts: [{ scheme: 'exact', network: terms.network,
    asset: ASSET, payTo, amount: '1000', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
};
const input = { z: ['한', true, null, 7], nested: { z: false, a: { value: 'body-only' } } };
const quote = selectQuote(challenge, terms, input, profile);
const topic = a => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
function ledger() {
  return { status: '0x1', transactionHash: TX, blockNumber: '0x64', blockHash: BLOCK, logs: [
    { address: ASSET, topics: [keccak256(toHex('AuthorizationUsed(address,bytes32)')), topic(signer.address), NONCE], data: '0x' },
    { address: ASSET, topics: [keccak256(toHex('Transfer(address,address,uint256)')), topic(signer.address), topic(payTo)], data: `0x${(1000n).toString(16).padStart(64, '0')}` },
  ] };
}
const rpcFor = (overrides = {}) => async (method, params) => {
  if (method === 'eth_getTransactionReceipt') assert.deepEqual(params, [TX]);
  const responses = { eth_chainId: '0x2105', eth_getTransactionReceipt: ledger(), eth_blockNumber: '0x65', eth_getBlockByNumber: { hash: BLOCK }, ...overrides };
  assert.ok(method in responses, `Unexpected RPC: ${method}`);
  return structuredClone(responses[method]);
};
async function callFixture() {
  return { id: 'fixture', sessionId: 'session', requestKey: 'one', requestHash: digest({ endpoint: terms.endpoint, input }),
    input, quote, amount: '1000', nonce: NONCE, createdAt: now, state: 'RECONCILIATION_REQUIRED',
    prepared: await signer.prepare(quote, terms, NONCE, now), wire: null, verified: null };
}
function fetchFixture(captured) {
  return async (url, init) => {
    captured.push({ url, body: init.body, method: init.method, headers: new Headers(init.headers) });
    if (!new Headers(init.headers).has('payment-signature')) return new Response(JSON.stringify(challenge), { status: 402, headers: { 'payment-required': pack(challenge) } });
    return new Response('{"result":"fixture"}', { status: 200, headers: { 'payment-response': pack({ success: true, network: terms.network, transaction: TX }) } });
  };
}

test('JSON is an explicit bounded POST opt-in; nested values stay out of the URL', () => {
  for (const patch of [{ requestEncoding: 'form' }, { method: 'GET' }, { maxRequestBytes: 0 }, { maxRequestBytes: -1 }, { maxRequestBytes: 1.5 }, { maxRequestBytes: 1024 * 1024 + 1 }, { requestEncoding: 'query', maxRequestBytes: 10 }]) {
    assert.throws(() => defineProvider({ ...profile, ...patch }));
  }
  assert.equal(requestUrl(terms, input, profile), terms.endpoint);
  assert.equal(requestBody(input, profile), canonical(input));
  assert.match(requestBody(input, profile), /\\ud55c/);
  assert.throws(() => requestUrl({ ...terms, endpoint: `${terms.endpoint}?leak=true` }, input, profile));
  const reordered = { nested: { a: { value: 'body-only' }, z: false }, z: ['한', true, null, 7] };
  assert.equal(requestBody(input, profile), requestBody(reordered, profile));
  assert.equal(digest({ endpoint: terms.endpoint, input: inputOf(input, profile) }), digest({ endpoint: terms.endpoint, input: inputOf(reordered, profile) }));
});

test('JSON input snapshots reject non-JSON values instead of silently dropping or coercing them', () => {
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'surprise' });
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 'secret' });
  const decoratedArray = []; decoratedArray.extra = 'lost';
  const invalid = [null, [], new Date(), { a: undefined }, { a: () => 1 }, { a: Symbol('value') }, { a: 1n },
    { a: NaN }, { a: Infinity }, { a: new Map() }, { a: new Date() }, { a: [, 1] }, cycle,
    { [Symbol('key')]: 'lost' }, accessor, hidden, { a: decoratedArray }];
  for (const value of invalid) assert.throws(() => inputOf(value, profile));
  let deep = {}; for (let i = 0; i < 66; i++) deep = { child: deep };
  assert.throws(() => inputOf(deep, profile), /nesting/);
  const source = { a: [{ value: true }] }, snapshot = inputOf(source, profile);
  source.a[0].value = false;
  assert.equal(snapshot.a[0].value, true);
  const normalized = defineProvider({ ...profile, input: value => ({ nested: value.nested, count: Number(value.count) }) });
  assert.deepEqual(inputOf({ nested: { ok: true }, count: '2', ignored: 'field' }, normalized), { count: 2, nested: { ok: true } });
  assert.throws(() => inputOf({}, defineProvider({ ...profile, input: () => ({ value: undefined }) })));
});

test('JSON size counts canonical wire bytes, including escaped Unicode', () => {
  const value = { text: '한' }, size = Buffer.byteLength(canonical(value));
  const exact = defineProvider({ ...profile, maxRequestBytes: size });
  assert.equal(requestBody(value, exact), canonical(value));
  assert.throws(() => inputOf(value, defineProvider({ ...profile, maxRequestBytes: size - 1 })), /too large/);
  assert.throws(() => inputOf({ text: 'x'.repeat(65536) }, profile), /too large/);
  assert.doesNotThrow(() => inputOf({ text: 'x'.repeat(65536) }, defineProvider({ ...profile, maxRequestBytes: 1024 * 1024 })));
});

test('unpaid probe and paid submission send identical canonical JSON bytes and content type', async () => {
  const captured = [], transport = x402Transport(profile, fetchFixture(captured));
  assert.deepEqual(await transport.probe(terms.endpoint, input), challenge);
  const prepared = await signer.prepare(quote, terms, NONCE, now);
  const wire = await transport.send(terms.endpoint, prepared, input);
  assert.equal(wire.status, 200);
  assert.equal(captured.length, 2);
  for (const request of captured) {
    assert.equal(request.url, terms.endpoint); assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('content-type'), 'application/json');
    assert.equal(request.body, canonical(input));
  }
  assert.equal(captured[0].headers.has('payment-signature'), false);
  assert.equal(captured[1].headers.has('payment-signature'), true);
  assert.equal(captured[1].headers.get('accept'), 'application/json');
});

test('missing, oversized or query-contaminated JSON requests fail before fetch', async () => {
  let fetched = 0;
  const transport = x402Transport(profile, async () => { fetched++; throw new Error('must not fetch'); });
  await assert.rejects(transport.probe(terms.endpoint), /input required/);
  await assert.rejects(transport.send(terms.endpoint, await signer.prepare(quote, terms, NONCE, now)), /input required/);
  await assert.rejects(transport.probe(`${terms.endpoint}?nested=flattened`, input), /query/);
  await assert.rejects(transport.probe(terms.endpoint, { text: 'x'.repeat(65536) }), /too large/);
  assert.equal(fetched, 0);
});

test('Doctor and default query POST transports retain their no-body behavior and old adapter arity', async () => {
  const doctorTerms = { ...terms, endpoint: `${DOCTOR_PROVIDER.origin}${DOCTOR_PROVIDER.endpointPath}` };
  const doctorInput = { url: 'https://example.test/path', method: 'POST' };
  const doctorUrl = requestUrl(doctorTerms, doctorInput);
  assert.equal(new URL(doctorUrl).searchParams.get('url'), doctorInput.url);
  assert.deepEqual([...new URL(doctorUrl).searchParams.keys()], ['url', 'method']);
  assert.equal(requestBody(doctorInput), undefined);
  let doctorRequest;
  await doctorTransport(async (url, init) => {
    doctorRequest = { url, init };
    return new Response('{}', { status: 402, headers: { 'payment-required': pack({ marker: 'default' }) } });
  }).probe(doctorUrl);
  assert.equal(doctorRequest.init.method, 'GET'); assert.equal(doctorRequest.init.body, undefined);
  assert.equal(new Headers(doctorRequest.init.headers).has('content-type'), false);
  const queryProfile = defineProvider({ ...profile, requestEncoding: undefined });
  const url = requestUrl(terms, { prompt: 'flat value' }, queryProfile);
  assert.equal(new URL(url).searchParams.get('prompt'), 'flat value');
  assert.throws(() => requestUrl(terms, input, queryProfile), /short strings/);
  const captured = [], transport = x402Transport(queryProfile, fetchFixture(captured));
  await transport.probe(url);
  await transport.send(url, await signer.prepare(quote, terms, NONCE, now));
  assert.ok(captured.every(r => r.method === 'POST' && r.body === undefined && !r.headers.has('content-type')));
});

test('session freezes a pre-await normalized snapshot and sends the persisted input with the same hash/body', async () => {
  const normalizedProfile = defineProvider({ ...profile, input: value => ({ prompt: value.prompt.trim(), data: value.data }) });
  const supplied = { prompt: ' original ', data: { options: ['first', { enabled: true }] } };
  const expected = { prompt: 'original', data: { options: ['first', { enabled: true }] } };
  const journal = new Journal(':memory:', normalizedProfile), id = journal.create(terms, now);
  const captured = [], transport = x402Transport(normalizedProfile, fetchFixture(captured));
  let release, seenProbe, seenSend, signed = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const client = new SessionClient(journal, {
    probe: async (url, snapshot) => {
      seenProbe = snapshot;
      assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.data.options[1]));
      assert.throws(() => { snapshot.data.options[1].enabled = false; }, TypeError);
      const response = await transport.probe(url, snapshot);
      await waiting;
      return response;
    },
    prepare: async (...args) => { signed++; return signer.prepare(...args); },
    send: async (url, prepared, snapshot) => {
      seenSend = snapshot;
      assert.ok(Object.isFrozen(snapshot.data.options));
      return transport.send(url, prepared, snapshot);
    },
    verify: async () => { throw new Error('No delivery verification in this transport-only test'); },
  }, () => now);
  try {
    const pending = client.call(id, 'stable', supplied);
    supplied.prompt = 'changed'; supplied.data.options[0] = 'changed'; supplied.data.options[1].enabled = false;
    release();
    const call = await pending;
    assert.equal(call.state, 'RECONCILIATION_REQUIRED');
    assert.deepEqual(call.input, expected);
    assert.deepEqual(seenProbe, expected); assert.deepEqual(seenSend, expected); assert.notEqual(seenProbe, seenSend);
    assert.equal(call.requestHash, digest({ endpoint: terms.endpoint, input: expected }));
    assert.equal(captured.length, 2); assert.ok(captured.every(r => r.body === canonical(expected)));
    assert.equal((await client.call(id, 'stable', expected)).id, call.id);
    await assert.rejects(client.call(id, 'stable', supplied), /different input/);
    assert.equal(captured.length, 2); assert.equal(signed, 1);
  } finally { journal.close(); }
});

test('oversized session input creates no reservation, signature or network call', async () => {
  const journal = new Journal(':memory:', profile), id = journal.create(terms, now);
  const forbidden = async () => { assert.fail('Invalid request must fail before adapters'); };
  try {
    const client = new SessionClient(journal, { probe: forbidden, prepare: forbidden, send: forbidden, verify: forbidden }, () => now);
    await assert.rejects(client.call(id, 'large', { text: 'x'.repeat(65536) }), /too large/);
    assert.equal(journal.calls(id).length, 0); assert.equal(journal.export(id).events.length, 0);
  } finally { journal.close(); }
});

test('in-place normalizers receive mutable owned copies in JSON and legacy query sessions', async () => {
  for (const requestEncoding of ['json', 'query']) {
    const p = defineProvider({ ...profile, requestEncoding, input: value => { value.prompt = value.prompt.trim(); return value; } });
    const supplied = { prompt: ' original ' };
    assert.deepEqual(inputOf(supplied, p), { prompt: 'original' });
    assert.equal(supplied.prompt, ' original ');
    assert.deepEqual(inputOf(Object.freeze({ prompt: ' original ' }), p), { prompt: 'original' });
    const journal = new Journal(':memory:', p), id = journal.create(terms, now), captured = [];
    const transport = x402Transport(p, fetchFixture(captured));
    const client = new SessionClient(journal, { ...transport, prepare: signer.prepare, verify: async () => { throw new Error('transport-only test'); } }, () => now);
    try {
      const call = await client.call(id, 'normalizer', supplied);
      assert.equal(call.state, 'RECONCILIATION_REQUIRED'); assert.deepEqual(call.input, { prompt: 'original' });
      assert.equal(supplied.prompt, ' original '); assert.equal(captured.length, 2);
      for (const request of captured) {
        if (requestEncoding === 'json') assert.equal(request.body, '{"prompt":"original"}');
        else assert.equal(new URL(request.url).searchParams.get('prompt'), 'original');
      }
    } finally { journal.close(); }
  }
});

test('independent settlement accepts a transaction locator without reading or synthesizing a response', async () => {
  const call = await callFixture();
  Object.defineProperty(call, 'wire', { get: () => { throw new Error('wire must not be read'); } });
  const proof = await verifySettlementTransaction(call, terms, TX, rpcFor());
  assert.equal(proof.transaction, TX); assert.equal(proof.confirmations, 2); assert.equal(proof.verification, 'rpc-confirmed');
  assert.equal(call.state, 'RECONCILIATION_REQUIRED'); assert.equal(call.verified, null);
  const wireCall = await callFixture();
  await assert.rejects(verifySettlement(wireCall, terms, rpcFor()), /Missing payment evidence/);
  wireCall.wire = { status: 200, body: {}, settlement: { success: true, network: terms.network, transaction: TX } };
  assert.deepEqual(await verifySettlement(wireCall, terms, rpcFor()), proof);
});

test('independent settlement rejects changed persisted authorization/quote bindings before RPC', async () => {
  const original = await callFixture();
  const mutations = [
    c => { c.prepared = null; }, c => { c.amount = '999'; }, c => { c.nonce = TX; },
    c => { c.prepared.authorization.from = stranger; }, c => { c.prepared.authorization.to = stranger; },
    c => { c.prepared.authorization.value = '999'; }, c => { c.prepared.authorization.nonce = TX; },
    c => { c.prepared.quote.resource.url += '/changed'; }, c => { c.quote.accepted.amount = '999'; },
    c => { c.quote.accepted.network = 'eip155:1'; }, c => { c.quote.accepted.asset = stranger; },
    c => { c.quote.accepted.payTo = stranger; }, c => { c.prepared.signature = '0x'; },
    c => { c.prepared.authorization.validAfter = c.prepared.authorization.validBefore; },
    c => { c.prepared.authorization.validBefore = String(Math.floor(terms.expiresAt / 1000) + 1); },
  ];
  for (const mutate of mutations) {
    const call = structuredClone(original); mutate(call); let requests = 0;
    await assert.rejects(verifySettlementTransaction(call, terms, TX, async () => { requests++; throw new Error('must not call RPC'); }));
    assert.equal(requests, 0);
  }
});

test('independent settlement snapshots persisted bindings before asynchronous RPC reads', async () => {
  const call = await callFixture(), suppliedTerms = structuredClone(terms);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const rpc = rpcFor();
  const pending = verifySettlementTransaction(call, suppliedTerms, TX, async (method, params) => {
    await waiting;
    return rpc(method, params);
  });
  call.nonce = TX; call.amount = '999'; call.prepared.authorization.from = stranger;
  suppliedTerms.payer = stranger; suppliedTerms.provider = stranger;
  release();
  assert.equal((await pending).transaction, TX);
});

test('independent settlement preserves wrong-chain, receipt, reorg, confirmation and log rejection checks', async () => {
  const call = await callFixture();
  for (const overrides of [
    { eth_chainId: '0x1' }, { eth_getTransactionReceipt: null }, { eth_getTransactionReceipt: { ...ledger(), status: '0x0' } },
    { eth_getTransactionReceipt: { ...ledger(), transactionHash: BLOCK } }, { eth_getTransactionReceipt: { ...ledger(), logs: [] } },
    { eth_blockNumber: '0x64' }, { eth_blockNumber: '0x63' }, { eth_getBlockByNumber: { hash: TX } },
  ]) await assert.rejects(verifySettlementTransaction(call, terms, TX, rpcFor(overrides)));
  for (const mutate of [
    logs => { logs[0].topics[2] = TX; }, logs => { logs[0].topics[1] = topic(stranger); },
    logs => { logs[1].topics[1] = topic(stranger); }, logs => { logs[1].topics[2] = topic(stranger); },
    logs => { logs[1].data = '0x03e9'; }, logs => { logs[1].address = stranger; }, logs => { logs[1].removed = true; },
  ]) {
    const receipt = ledger(); mutate(receipt.logs);
    await assert.rejects(verifySettlementTransaction(call, terms, TX, rpcFor({ eth_getTransactionReceipt: receipt })));
  }
  for (const count of [0, 1.5, 101]) await assert.rejects(verifySettlementTransaction(call, terms, TX, rpcFor(), count), /confirmations/);
  await assert.rejects(verifySettlementTransaction(call, terms, 'not-a-hash', rpcFor()));
});
