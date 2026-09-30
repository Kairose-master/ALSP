import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, verifyTypedData } from 'viem';
import { Journal, SessionClient, PROFILE, DOCTOR, NETWORK, ASSET, PAY_TO, ROUTE, digest, canonical, pack, unpack, selectQuote, evmSigner, AUTHORIZATION_TYPES, verifyDoctorReceipt, verifyBaseSettlement, doctorTransport, verifyBuyerSeal } from '../dist/index.js';

// Public throwaway test keys. These accounts MUST NEVER be funded.
const buyer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const seller = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const TX = `0x${'44'.repeat(32)}`, BLOCK = `0x${'55'.repeat(32)}`;
const now = Date.now();
const input = { url: `${DOCTOR}/demo/broken`, method: 'GET' };
const terms = { profile: PROFILE, payer: buyer.address, provider: PAY_TO, network: NETWORK, asset: ASSET, endpoint: `${DOCTOR}/api/v1/preflight`, maxTotal: '3000', maxPerCall: '1000', maxCalls: 3, expiresAt: now + 600000, license: { uri: 'urn:synthetic:terms', sha256: digest('fixture'), acceptance: 'buyer-only' } };
const challenge = { x402Version: 2, resource: { url: terms.endpoint }, accepts: [{ scheme: 'exact', network: NETWORK, amount: '1000', asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
const quote = selectQuote(challenge, terms, input);
async function signedBody(prepared, changes = {}, account = seller, suppliedTerms = terms) {
  const receipt = { request_id: prepared.authorization.nonce, route: ROUTE, input_sha256: digest({ route: ROUTE, input }), signed_at: new Date(now).toISOString(), signer: account.address, algorithm: 'eip191-canonical-json-v1',
    payment: { network: NETWORK, asset: ASSET, pay_to: suppliedTerms.provider, amount: '1000', payer: buyer.address, nonce: prepared.authorization.nonce, proof: 'eip3009' }, ...changes };
  const body = { verdict: 'no_go', safe_to_pay: false, summary: 'Synthetic: intentionally broken target; 한😀', recommended_option: null, options: [], reasons: [], signals: {}, receipt };
  return { ...body, receipt: { ...receipt, signature: await account.signMessage({ message: canonical(body) }) } };
}
async function callFixture() {
  const prepared = await evmSigner(`0x${'11'.repeat(32)}`).prepare(quote, terms, `0x${'66'.repeat(32)}`, now);
  const body = await signedBody(prepared);
  return { id: 'fixture-call', sessionId: 'fixture-session', input, quote, amount: '1000', nonce: prepared.authorization.nonce, createdAt: now, prepared, state: 'SUBMITTED', wire: { status: 200, body, settlement: { success: true, network: NETWORK, transaction: TX, payer: buyer.address } } };
}
function ledger(call, patch = {}) {
  const topic = a => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  return { status: '0x1', transactionHash: TX, blockNumber: '0x64', blockHash: BLOCK, logs: [
    { address: ASSET, topics: [keccak256(toHex('AuthorizationUsed(address,bytes32)')), topic(buyer.address), call.nonce], data: '0x' },
    { address: ASSET, topics: [keccak256(toHex('Transfer(address,address,uint256)')), topic(buyer.address), topic(PAY_TO)], data: `0x${(1000n).toString(16).padStart(64, '0')}` },
  ], ...patch };
}
function rpcFor(call, overrides = {}) {
  const responses = { eth_chainId: '0x2105', eth_getTransactionReceipt: ledger(call), eth_blockNumber: '0x65', eth_getBlockByNumber: { hash: BLOCK }, ...overrides };
  return async method => { if (!(method in responses)) throw new Error('Unexpected RPC'); return responses[method]; };
}

test('EIP-3009 signature verifies against exact amount/domain/payer/nonce', async () => {
  const c = await callFixture(), a = c.prepared.authorization;
  const parameters = { address: buyer.address, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ASSET }, types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', signature: c.prepared.signature,
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } };
  assert.equal(await verifyTypedData(parameters), true);
  assert.equal(await verifyTypedData({ ...parameters, message: { ...parameters.message, value: 1001n } }), false);
});
test('a signed no_go verdict is a valid delivered diagnosis, not proof of semantic truth', async () => {
  const c = await callFixture();
  const proof = await verifyDoctorReceipt(c, terms, [{ address: seller.address }], now);
  assert.equal(proof.signer, seller.address.toLowerCase());
  const chain = await verifyBaseSettlement(c, terms, rpcFor(c));
  assert.equal(chain.verification, 'rpc-confirmed'); assert.equal(chain.confirmations, 2);
});
test('changed body, absent signatures and unknown signers fail closed', async () => {
  const c = await callFixture();
  await assert.rejects(verifyDoctorReceipt(c, terms, [{ address: stranger.address }], now));
  const tampered = structuredClone(c); tampered.wire.body.summary = 'attacker';
  await assert.rejects(verifyDoctorReceipt(tampered, terms, [{ address: seller.address }], now));
  delete tampered.wire.body.receipt.signature;
  await assert.rejects(verifyDoctorReceipt(tampered, terms, [{ address: seller.address }], now));
});
test('cryptographically valid but wrong request, route, time or payment is rejected', async () => {
  const c = await callFixture(), original = c.wire.body.receipt.payment;
  const changes = [ { route: 'GET /other' }, { input_sha256: digest('wrong') }, { algorithm: 'unknown' }, { signed_at: new Date(now + 60000).toISOString() }, { signed_at: new Date(now - 60001).toISOString() },
    ...[{ amount: '1001' }, { payer: stranger.address }, { nonce: `0x${'77'.repeat(32)}` }, { asset: stranger.address }, { network: 'eip155:1' }, { pay_to: stranger.address }, { proof: 'svm-transaction' }].map(p => ({ payment: { ...original, ...p } })) ];
  for (const patch of changes) { c.wire.body = await signedBody(c.prepared, patch); await assert.rejects(verifyDoctorReceipt(c, terms, [{ address: seller.address }], now)); }
});
test('pinned signer validity windows are enforced', async () => {
  const c = await callFixture();
  await assert.rejects(verifyDoctorReceipt(c, terms, [{ address: seller.address, validUntil: new Date(now - 1).toISOString() }], now));
  await assert.rejects(verifyDoctorReceipt(c, terms, [{ address: seller.address, validFrom: 'not-a-date' }], now));
});
test('authority-signed rotated key certificate works; unrelated authority does not', async () => {
  const c = await callFixture(), t = { ...terms, provider: stranger.address };
  const cert = { service: 'x402-doctor', signer: seller.address, valid_from: new Date(now - 86400000).toISOString().slice(0, 10), authority: stranger.address };
  cert.signature = await stranger.signMessage({ message: `fizzl receipt signer\nservice: ${cert.service}\nsigner: ${cert.signer}\nvalid_from: ${cert.valid_from}` });
  c.wire.body = await signedBody(c.prepared, { cert }, seller, t);
  assert.ok(await verifyDoctorReceipt(c, t, [], now));
  await assert.rejects(verifyDoctorReceipt(c, terms, [], now));
});
test('signed service response alone never counts as chain settlement', async () => {
  const c = await callFixture();
  for (const settlement of [null, {}, { success: false, transaction: TX, network: NETWORK }, { success: true, transaction: TX, network: 'eip155:1' }, { success: true, transaction: TX, network: NETWORK, payer: stranger.address }]) {
    await assert.rejects(verifyBaseSettlement({ ...c, wire: { ...c.wire, settlement } }, terms, rpcFor(c)));
  }
});
test('wrong chain, failed/reorged/unconfirmed tx and missing events fail verification', async () => {
  const c = await callFixture();
  for (const overrides of [{ eth_chainId: '0x1' }, { eth_getTransactionReceipt: null }, { eth_getTransactionReceipt: ledger(c, { status: '0x0' }) }, { eth_getTransactionReceipt: ledger(c, { logs: [] }) }, { eth_blockNumber: '0x64' }, { eth_getBlockByNumber: { hash: TX } }]) {
    await assert.rejects(verifyBaseSettlement(c, terms, rpcFor(c, overrides)));
  }
  for (const modify of [l => l[0].topics[2] = TX, l => l[1].data = '0x03e9', l => l[1].address = stranger.address, l => l[1].removed = true]) {
    const receipt = ledger(c); modify(receipt.logs);
    await assert.rejects(verifyBaseSettlement(c, terms, rpcFor(c, { eth_getTransactionReceipt: receipt })));
  }
});
test('local HTTP interop: real signatures, two exact calls, mocked ledger, one sealed off-chain session', async () => {
  let paid = 0; const seen = new Set(); const received = [];
  const server = createServer(async (req, res) => {
    try {
      if (!req.headers['payment-signature']) { res.writeHead(402, { 'payment-required': pack(challenge), 'content-type': 'application/json' }); res.end(JSON.stringify(challenge)); return; }
      const payload = unpack(req.headers['payment-signature']), a = payload.payload.authorization;
      const verified = await verifyTypedData({ address: buyer.address, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ASSET }, types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', signature: payload.payload.signature,
        message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });
      assert.equal(verified, true); assert.equal(a.value, '1000'); assert.equal(seen.has(a.nonce), false);
      seen.add(a.nonce); paid++;
      const prepared = { quote, authorization: a, signature: payload.payload.signature }; received.push(prepared);
      res.writeHead(200, { 'content-type': 'application/json', 'payment-response': pack({ success: true, transaction: TX, network: NETWORK, payer: buyer.address }) });
      res.end(JSON.stringify(await signedBody(prepared)));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const transport = doctorTransport((url, init) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`, init));
  const j = new Journal(':memory:');
  try {
    const id = j.create(terms, now), signer = evmSigner(`0x${'11'.repeat(32)}`);
    const client = new SessionClient(j, { ...transport, prepare: signer.prepare, verify: async c => ({ receipt: await verifyDoctorReceipt(c, terms, [{ address: seller.address }], now), ledger: await verifyBaseSettlement(c, terms, rpcFor(c)), semanticCorrectness: 'not-verified' }) }, () => now);
    for (const key of ['one', 'one', 'two']) assert.equal((await client.call(id, key, input)).state, 'VERIFIED');
    assert.equal(paid, 2); assert.equal(received.length, 2);
    j.end(id); const report = j.export(id);
    assert.equal(report.summary.verifiedSpent, '2000'); assert.equal(report.summary.registryWrites, 0); assert.equal(report.summary.state, 'CLOSED');
    const manifest = { profile: PROFILE, sessionId: id, headHash: report.headHash, archiveSha256: digest(report) };
    const archive = { ...report, buyerSeal: { manifest, signer: buyer.address, signature: await signer.signManifest(canonical(manifest)) } };
    assert.equal(await verifyBuyerSeal(archive, buyer.address), true);
    assert.equal(await verifyBuyerSeal(archive, stranger.address), false);
    archive.evidence[0].wire.body.summary = 'tampered';
    assert.equal(await verifyBuyerSeal(archive, buyer.address), false);
  } finally { j.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
