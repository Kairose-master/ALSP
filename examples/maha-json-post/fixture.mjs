// Fully in-process fixture. No real Maha execution, network fetch, RPC or funded key.
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import { keccak256, toHex, verifyTypedData } from 'viem';
import * as alsp from '../../dist/index.js';
import { CONTRACT, sha256Bytes, validateRequest, validateSerializedRequest, validateOutput, validateReceivedOutput } from './contract.mjs';

export const NOW = Date.parse('2026-10-12T10:00:00.000Z');
export const MOCK_NETWORK = 'eip155:31337';
export const MOCK_ASSET = '0x0000000000000000000000000000000000031337';
export const MOCK_PAYEE = '0x0000000000000000000000000000000000000042';
export const FAULTS = ['success', 'lost-no-wire', 'lost-recovered-null', 'null-body-200'];
const USED = keccak256(toHex('AuthorizationUsed(address,bytes32)'));
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
const topic = address => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function syntheticInput() {
  return {
    clientRequestId: 'synthetic-context-request-001',
    task: 'Find the synthetic release condition and rollback trigger. 가상 배포 조건과 복구 기준을 확인해요. 🚀',
    tokenBudget: 128,
    documents: [
      { id: 'synthetic-release', title: 'Synthetic release note / 가상 배포 🚀', text: 'SYNTHETIC SOURCE ALPHA: Release the imaginary service after all local checks pass. This is invented test data, not an operational instruction. 가상 자료입니다. 🧪 e\u0301' },
      { id: 'synthetic-rollback', title: 'Synthetic rollback note / 가상 복구 🔄', text: 'SYNTHETIC SOURCE BETA: Roll back the imaginary service if its simulated error counter exceeds two. This is invented test data. 테스트 자료예요. 👩‍💻' },
    ],
    provenance: 'compact', scoring: 'bm25', budgetMode: 'guaranteed',
  };
}
function syntheticOutput(input) {
  const context = 'SYNTHETIC COMPILED OUTPUT: Local checks precede the imaginary release; a simulated error count above two triggers rollback. 가상 결과입니다. 🚀';
  // Schema-shaped synthetic output only. Hash algorithms and token estimation do not claim Maha implementation parity.
  const body = {
    version: '0.1.0', packId: `ctxpack_${alsp.digest(input).slice(0, 32)}`,
    clientRequestId: input.clientRequestId, task: input.task, tokenBudget: input.tokenBudget, context,
    metrics: { originalBytes: Buffer.byteLength(input.documents.map(d => d.text).join('')), compiledBytes: Buffer.byteLength(context), originalEstimatedTokens: 50, compiledEstimatedTokens: 25, tokensSaved: 25, estimatedReductionPercent: 50, sourceCount: input.documents.length, sourceCoveragePercent: 100, duplicatePassagesRemoved: 0 },
    includedPassages: input.documents.map(d => ({ sourceId: d.id, passageId: `${d.id}:1`, passageHash: `sha256:${alsp.digest(d.text)}`, text: d.text })),
    sources: input.documents.map(d => ({ sourceId: d.id, title: d.title ?? '', sourceHash: `sha256:${alsp.digest(d.text)}`, originalEstimatedTokens: 25, passageCount: 1, includedPassageIds: [`${d.id}:1`], includedEstimatedTokens: 12 })),
    warnings: ['Synthetic fixture: no compression service or token estimator ran.'],
    warningCodes: ['model_neutral_token_estimates', 'extractive_selection_not_verification'],
    retentionBoundaries: { selectionType: 'extractive', evidenceRetention: 'best_effort', claimVerificationPerformed: false, completenessGuaranteed: false, hallucinationPreventionGuaranteed: false, tokenCountType: 'model_neutral_estimate' },
    // Domain-separated placeholder deliberately differs from local inputDigest.
    inputHash: `sha256:${alsp.digest({ syntheticProviderHash: input })}`, outputHash: `sha256:${alsp.digest(context)}`,
    sourceTextStored: false, compiledContextStored: false,
  };
  validateOutput(body);
  return body;
}

export function createFixture({ fault = 'success', journalPath = ':memory:', privateKey = generatePrivateKey(), responseTransform = response => response } = {}) {
  if (!FAULTS.includes(fault)) throw new Error('Unknown synthetic fault');
  const buyer = alsp.evmSigner(privateKey);
  const profile = alsp.defineProvider({
    id: 'maha-json-post-synthetic', label: 'Maha contract shape, offline synthetic ledger',
    origin: 'https://maha-json-fixture.invalid', endpointPath: '/api/v1/compress', method: 'POST',
    requestEncoding: 'json', maxRequestBytes: CONTRACT.maxRequestBytes, input: validateRequest,
    network: MOCK_NETWORK, asset: { address: MOCK_ASSET, name: 'Synthetic USD', version: '1' }, payTo: MOCK_PAYEE,
    receipt: { mode: 'unsigned' },
  });
  const endpoint = alsp.endpointUrl(profile);
  const terms = { profile: alsp.PROFILE, payer: buyer.address, provider: MOCK_PAYEE, network: MOCK_NETWORK, asset: MOCK_ASSET, endpoint,
    maxTotal: '1000', maxPerCall: '1000', maxCalls: 1, expiresAt: NOW + 600000,
    license: { uri: 'urn:alsp:synthetic:maha-json-post:v1', sha256: alsp.digest('synthetic fixture terms only'), acceptance: 'buyer-only' } };
  const state = { fault, probes: 0, authorizations: 0, submissions: 0, settlements: 0, refunds: 0, rpcCalls: 0, observations: [], requestBodies: [], receivedResponseBytes: null, outputSchemaObservation: { status: 'not-observed', validationSource: 'transport-received JSON' }, records: [], recoverableWire: null };
  const challenge = { x402Version: 2, resource: { url: endpoint, description: 'Synthetic contract-shaped JSON POST, not a Maha quote' }, accepts: [{ scheme: 'exact', network: MOCK_NETWORK, asset: MOCK_ASSET, payTo: MOCK_PAYEE, amount: '1000', maxTimeoutSeconds: 120, extra: { name: 'Synthetic USD', version: '1' } }] };

  async function fetchImpl(url, init = {}) {
    const u = new URL(url), headers = new Headers(init.headers);
    assert.equal(u.origin, profile.origin, 'No external request allowed');
    assert.equal(u.pathname, '/api/v1/compress');
    assert.equal(u.search, '', 'JSON input must not leak through a query');
    assert.equal(init.method, 'POST');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(typeof init.body, 'string');
    const input = validateSerializedRequest(init.body);
    assert.equal(init.body, alsp.canonical(input));
    const paymentHeader = headers.get('payment-signature');
    // Raw captures remain fixture-private; public projections copy only redacted observations.
    state.requestBodies.push(init.body);
    state.observations.push({ method: init.method, path: u.pathname, contentType: headers.get('content-type'), queryPresent: false,
      bodyPresent: true, bodySha256: sha256Bytes(Buffer.from(init.body, 'utf8')), bytes: Buffer.byteLength(init.body, 'utf8'),
      schemaValidation: 'valid', validationSource: 'actual serialized fetch body', paymentHeaderPresent: Boolean(paymentHeader) });
    if (!paymentHeader) { state.probes++; return json(402, challenge, { 'payment-required': alsp.pack(challenge) }); }
    state.submissions++;
    const payment = alsp.unpack(paymentHeader), auth = payment.payload.authorization;
    assert.equal(alsp.canonical(payment.accepted), alsp.canonical(challenge.accepts[0]));
    assert.equal(alsp.canonical(payment.resource), alsp.canonical(challenge.resource));
    assert.equal(auth.from.toLowerCase(), buyer.address.toLowerCase());
    assert.equal(auth.to.toLowerCase(), MOCK_PAYEE);
    assert.equal(auth.value, '1000');
    assert.ok(BigInt(auth.validAfter) <= BigInt(NOW / 1000) && BigInt(auth.validBefore) > BigInt(NOW / 1000));
    assert.equal(await verifyTypedData({ address: auth.from,
      domain: { name: 'Synthetic USD', version: '1', chainId: 31337, verifyingContract: MOCK_ASSET },
      types: alsp.AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', signature: payment.payload.signature,
      message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
    }), true);
    if (state.records.some(r => r.nonce === auth.nonce)) return json(409, { error: 'synthetic nonce already used' });
    state.settlements++;
    const transaction = keccak256(toHex(`synthetic-settlement:${auth.nonce}`));
    const blockHash = keccak256(toHex('synthetic-maha-fixture-block-1'));
    const receipt = { status: '0x1', transactionHash: transaction, blockNumber: '0x1', blockHash, logs: [
      { address: MOCK_ASSET, topics: [USED, topic(auth.from), auth.nonce], data: '0x' },
      { address: MOCK_ASSET, topics: [TRANSFER, topic(auth.from), topic(MOCK_PAYEE)], data: `0x${BigInt(auth.value).toString(16).padStart(64, '0')}` },
    ] };
    // Only an independently discoverable transaction locator + ledger receipt survive no-wire loss.
    state.records.push({ nonce: auth.nonce, transaction, blockHash, receipt });
    const settlement = { success: true, network: MOCK_NETWORK, transaction, payer: auth.from };
    if (fault === 'lost-no-wire') throw new Error('Synthetic response lost after mock settlement; no output retained');
    if (fault === 'lost-recovered-null') {
      state.recoverableWire = { status: 200, body: null, settlement };
      throw new Error('Synthetic lost response; bodyless payment-response record available locally');
    }
    if (fault === 'null-body-200') return new Response(null, { status: 200, headers: { 'payment-response': alsp.pack(settlement) } });
    return json(200, syntheticOutput(input), { 'payment-response': alsp.pack(settlement) });
  }
  async function rpc(method, params) {
    state.rpcCalls++;
    switch (method) {
      case 'eth_chainId': return '0x7a69';
      case 'eth_getTransactionReceipt': return structuredClone(state.records.find(r => r.transaction === params[0])?.receipt ?? null);
      case 'eth_blockNumber': return '0x2';
      case 'eth_getBlockByNumber': return params[0] === '0x1' && state.records.length ? { number: '0x1', hash: state.records[0].blockHash } : null;
      default: throw new Error('Unsupported read-only mock RPC method');
    }
  }
  const journal = new alsp.Journal(journalPath, profile), sessionId = journal.create(terms, NOW);
  let receivedBytes = null;
  const transport = alsp.x402Transport(profile, async (url, init) => {
    let response = await fetchImpl(url, init);
    if (new Headers(init.headers).has('payment-signature')) {
      // Test-only fault injection is after construction/validation of source output.
      response = await responseTransform(response);
      receivedBytes = Buffer.from(await response.clone().arrayBuffer());
      state.receivedResponseBytes = receivedBytes;
    }
    return response;
  });
  const adapters = { ...transport,
    async send(...args) {
      let wire;
      try { wire = await transport.send(...args); }
      catch (error) {
        state.outputSchemaObservation = { status: receivedBytes ? 'invalid-json' : 'not-observed',
          validationSource: 'transport-received JSON', ...(receivedBytes ? { wireBytes: receivedBytes.length, wireBodySha256: sha256Bytes(receivedBytes) } : {}) };
        throw error;
      }
      const observation = { validationSource: 'transport-received JSON', wireBytes: receivedBytes.length, wireBodySha256: sha256Bytes(receivedBytes) };
      if (wire.body === null) state.outputSchemaObservation = { ...observation, status: 'no-output' };
      else {
        try {
          validateReceivedOutput(receivedBytes, wire.body);
          state.outputSchemaObservation = { ...observation, status: 'valid', parsedBodySha256: alsp.digest(wire.body) };
        } catch {
          state.outputSchemaObservation = { ...observation, status: 'invalid', reason: 'Received JSON or UTF-8 does not satisfy pinned output contract' };
        }
      }
      // Shape checking is a companion observation: never redefine native settlement state.
      return wire;
    },
    async prepare(...args) { state.authorizations++; return buyer.prepare(...args); },
    async verify(call, t) {
      const receipt = await alsp.verifyReceipt(call, t, [], profile, NOW);
      const ledger = await alsp.verifySettlement(call, t, rpc);
      return { receipt, ledger: { ...ledger, verification: 'mock-settled' }, semanticCorrectness: 'not-verified' };
    },
  };
  const client = new alsp.SessionClient(journal, adapters, () => NOW);
  async function observeSettlement(call) {
    const locator = state.records.find(record => record.nonce === call.nonce)?.transaction;
    if (!locator) throw new Error('No independent mock transaction locator');
    const proof = await alsp.verifySettlementTransaction(call, terms, locator, rpc);
    return { status: 'mock-settled', evidenceSource: 'in-process mock ledger; independently checked from transaction locator',
      wireResponseRequired: false, proof: { ...proof, verification: 'mock-settled' } };
  }
  return { profile, terms, journal, sessionId, client, adapters, state, rpc, fetchImpl, privateKey, observeSettlement,
    close() { journal.close(); } };
}
