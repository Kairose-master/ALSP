import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const nearbySnapshot = resolve(ROOT, '../alsp-main-snapshot');
const repositoryRoot = resolve(ROOT, '../../../');
const defaultAlspRoot = existsSync(resolve(nearbySnapshot, 'package.json')) ? nearbySnapshot : repositoryRoot;
const ALSP_ROOT = resolve(process.env.ALSP_ROOT || defaultAlspRoot);
const requireFromAlsp = createRequire(resolve(ALSP_ROOT, 'package.json'));
const { keccak256, toHex, verifyTypedData } = requireFromAlsp('viem');
const evm = await import(pathToFileURL(resolve(ALSP_ROOT, 'dist/profiles/x402-exact/evm.js')).href);
const journalModule = await import(pathToFileURL(resolve(ALSP_ROOT, 'dist/profiles/x402-exact/journal.js')).href);
const receiptModule = await import(pathToFileURL(resolve(ALSP_ROOT, 'dist/profiles/x402-exact/receipt.js')).href);
const protocol = await import(pathToFileURL(resolve(ALSP_ROOT, 'dist/profiles/x402-exact/protocol.js')).href);
const sessionModule = await import(pathToFileURL(resolve(ALSP_ROOT, 'dist/profiles/x402-exact/session.js')).href);
const httpModule = await import(pathToFileURL(resolve(ALSP_ROOT, 'dist/profiles/x402-exact/http.js')).href);
const { AUTHORIZATION_TYPES, evmSigner, verifySettlement } = evm;
const { Journal, verifyChain } = journalModule;
const { verifyReceipt } = receiptModule;
const { ASSET, PROFILE, defineProvider, digest, object, pack, unpack } = protocol;
const { SessionClient } = sessionModule;
const { x402Transport } = httpModule;
const MAIN_SHA = '545221097a48cb6480c58b5d43e05f302acef30f';
const TREE_SHA = 'a671253b8c85414a1da9e1fd52a35e15a8abc66c';
const RESOURCE = 'https://www.mahastrategies.com/api/v1/compress';
const NETWORK = 'eip155:8453';
const PAY_TO = '0xec84c1cd6602bbe387bc8e6f0d3c062f2762de28';
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const EXPIRY = NOW + 60 * 60 * 1000;
const BUYER_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const buyer = evmSigner(BUYER_KEY);
const endpointUrl = new URL(RESOURCE);
const transferTopic = keccak256(toHex('Transfer(address,address,uint256)'));
const usedTopic = keccak256(toHex('AuthorizationUsed(address,bytes32)'));

function fail(message) {
  throw new Error(message);
}

function validateMahaInput(value) {
  const v = object(value);
  const allowed = new Set(['clientRequestId', 'task', 'tokenBudget', 'documents', 'provenance', 'scoring', 'budgetMode']);
  if (Object.keys(v).some((key) => !allowed.has(key))) fail('Unexpected Maha request property');
  if (typeof v.clientRequestId !== 'string' || v.clientRequestId.length < 8 || v.clientRequestId.length > 120) fail('Invalid clientRequestId');
  if (typeof v.task !== 'string' || v.task.length < 8 || v.task.length > 1200) fail('Invalid task');
  if (!Number.isInteger(v.tokenBudget) || v.tokenBudget < 64 || v.tokenBudget > 16000) fail('Invalid tokenBudget');
  if (!Array.isArray(v.documents) || v.documents.length < 1 || v.documents.length > 8) fail('Invalid documents');
  for (const document of v.documents) {
    const d = object(document);
    const keys = Object.keys(d);
    if (keys.some((key) => !['id', 'title', 'text'].includes(key))) fail('Unexpected document property');
    if (typeof d.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(d.id)) fail('Invalid document id');
    if (typeof d.text !== 'string' || d.text.length === 0) fail('Document text is required');
    if (d.title !== undefined && (typeof d.title !== 'string' || d.title.length < 1 || d.title.length > 160)) fail('Invalid document title');
  }
  if (v.provenance !== undefined && !['full', 'compact', 'none'].includes(v.provenance)) fail('Invalid provenance');
  if (v.scoring !== undefined && !['bm25', 'keyword'].includes(v.scoring)) fail('Invalid scoring');
  if (v.budgetMode !== undefined && !['guaranteed', 'estimated'].includes(v.budgetMode)) fail('Invalid budgetMode');
  const bodyBytes = Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (bodyBytes > 450000) fail('Maha request body exceeds 450000 bytes');

  // ALSP currently requires a flat string map and appends it to the resource URL.
  // This encoding is only a local fixture probe; it is not Maha's POST JSON contract.
  return { payload: JSON.stringify(v) };
}

const provider = defineProvider({
  id: 'maha-context-compression-synthetic',
  label: 'Maha Context Compiler (offline synthetic profile)',
  origin: endpointUrl.origin,
  endpointPath: endpointUrl.pathname,
  method: 'POST',
  network: NETWORK,
  asset: { address: ASSET, name: 'USD Coin', version: '2' },
  payTo: PAY_TO,
  receipt: { mode: 'unsigned' },
  input: validateMahaInput,
});

const input = {
  clientRequestId: 'alsp-offline-ctx-0001',
  task: 'Select evidence passages for a synthetic review.',
  tokenBudget: 512,
  documents: [{
    id: 'doc.synthetic-1',
    title: 'Synthetic fixture only',
    text: 'This synthetic sentence is fixture content; it is not Maha source material.',
  }],
  provenance: 'compact',
  scoring: 'bm25',
  budgetMode: 'estimated',
};

function freshLedger(fault = 'normal') {
  const state = {
    fault,
    paidCount: 0,
    sendCount: 0,
    prepareCount: 0,
    nonces: new Set(),
    recordsByTransaction: new Map(),
    observations: [],
    recoverableWire: null,
    mockTransaction: null,
  };

  function topicAddress(address) {
    return '0x' + address.slice(2).toLowerCase().padStart(64, '0');
  }

  function rpc(method, params) {
    if (method === 'eth_chainId') return Promise.resolve('0x2105');
    if (method === 'eth_getTransactionReceipt') {
      return Promise.resolve(state.recordsByTransaction.get(String(params[0]).toLowerCase())?.receipt ?? null);
    }
    if (method === 'eth_blockNumber') {
      const last = Array.from(state.recordsByTransaction.values()).at(-1);
      return Promise.resolve('0x' + ((last?.height ?? 1) + 1).toString(16));
    }
    if (method === 'eth_getBlockByNumber') {
      const number = Number(BigInt(String(params[0])));
      const entry = Array.from(state.recordsByTransaction.values()).find((item) => item.height === number);
      return Promise.resolve(entry ? { number: params[0], hash: entry.blockHash } : null);
    }
    return Promise.reject(new Error('Unsupported mock RPC method: ' + method));
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    if (u.origin !== provider.origin || u.pathname !== provider.endpointPath || init.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }
    const headers = new Headers(init.headers);
    const paymentHeader = headers.get('payment-signature');
    state.observations.push({
      method: init.method,
      path: u.pathname,
      payloadQueryPresent: u.searchParams.has('payload'),
      requestBodyPresent: init.body !== undefined && init.body !== null,
      paymentHeaderPresent: Boolean(paymentHeader),
    });
    if (!paymentHeader) {
      const challenge = {
        x402Version: 2,
        resource: { url: RESOURCE, description: 'Synthetic fixture resource; no Maha request was sent.' },
        accepts: [{
          scheme: 'exact',
          network: NETWORK,
          asset: ASSET,
          payTo: PAY_TO,
          amount: '1000',
          maxTimeoutSeconds: 120,
          extra: { name: 'USD Coin', version: '2' },
        }],
      };
      return new Response(JSON.stringify(challenge), {
        status: 402,
        headers: { 'content-type': 'application/json', 'payment-required': pack(challenge) },
      });
    }

    const payment = object(unpack(paymentHeader));
    const auth = object(object(payment.payload).authorization);
    const signature = String(object(payment.payload).signature);
    const amount = String(payment.accepted?.amount ?? '');
    const verified = await verifyTypedData({
      address: auth.from,
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ASSET },
      types: AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      signature,
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
    });
    if (!verified || auth.from.toLowerCase() !== buyer.address.toLowerCase()) fail('Fixture EIP-3009 signature did not verify');
    if (auth.to.toLowerCase() !== PAY_TO.toLowerCase() || auth.value !== '1000' || amount !== '1000') fail('Fixture payment did not match public mapping');
    if (state.nonces.has(auth.nonce.toLowerCase())) return new Response('authorization already used', { status: 409 });
    state.nonces.add(auth.nonce.toLowerCase());
    state.paidCount += 1;
    state.sendCount += 1;

    const height = state.paidCount;
    const transaction = keccak256(toHex('maha-offline-fixture:' + auth.nonce));
    const blockHash = keccak256(toHex('alsp-mock-block:' + height));
    const receipt = {
      status: '0x1',
      transactionHash: transaction,
      blockNumber: '0x' + height.toString(16),
      blockHash,
      logs: [
        { address: ASSET, topics: [usedTopic, topicAddress(auth.from), auth.nonce.toLowerCase()], data: '0x' },
        {
          address: ASSET,
          topics: [transferTopic, topicAddress(auth.from), topicAddress(PAY_TO)],
          data: '0x' + BigInt(auth.value).toString(16).padStart(64, '0'),
        },
      ],
    };
    state.recordsByTransaction.set(transaction.toLowerCase(), { transaction, blockHash, height, receipt });
    const settlement = { success: true, network: NETWORK, transaction, payer: buyer.address };
    state.mockTransaction = transaction;
    const body = {
      syntheticFixture: true,
      note: 'Not a Maha response schema and contains no compiled context.',
      outputHash: 'sha256:' + createHash('sha256').update('offline synthetic output marker').digest('hex'),
    };
    if (state.fault === 'lost-no-wire') {
      state.recoverableWire = null;
      throw new Error('synthetic socket loss after mock settlement; no response retained');
    }
    if (state.fault === 'lost-recover-null') {
      state.recoverableWire = { status: 200, body: null, settlement };
      throw new Error('synthetic socket loss after mock settlement; recovery has no output body');
    }
    if (state.fault === 'null-body-200') {
      state.recoverableWire = { status: 200, body: null, settlement };
      return new Response(null, { status: 200, headers: { 'payment-response': pack(settlement) } });
    }
    state.recoverableWire = { status: 200, body, settlement };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'payment-response': pack(settlement) },
    });
  }

  return { state, rpc, fetchImpl };
}

function newHarness(fault = 'normal') {
  const ledger = freshLedger(fault);
  const journal = new Journal(':memory:', provider);
  const terms = {
    profile: PROFILE,
    payer: buyer.address,
    provider: PAY_TO,
    network: NETWORK,
    asset: ASSET,
    endpoint: RESOURCE,
    maxTotal: '3000',
    maxPerCall: '1000',
    maxCalls: 3,
    expiresAt: EXPIRY,
    license: {
      uri: 'urn:alsp:synthetic:maha-context-compression',
      sha256: digest('offline buyer-side terms fixture'),
      acceptance: 'buyer-only',
    },
  };
  const sessionId = journal.create(terms, NOW);
  const transport = x402Transport(provider, ledger.fetchImpl);
  const adapters = {
    probe: transport.probe,
    prepare: async (quote, t, nonce, now) => {
      ledger.state.prepareCount += 1;
      return buyer.prepare(quote, t, nonce, now);
    },
    send: transport.send,
    verify: async (call, t) => {
      const receipt = await verifyReceipt(call, t, [], provider, NOW);
      const chain = await verifySettlement(call, t, ledger.rpc, 2);
      return { receipt, ledger: chain, semanticCorrectness: 'not-verified' };
    },
  };
  return { ledger, journal, sessionId, terms, client: new SessionClient(journal, adapters, () => NOW) };
}

function reservedEvent(report) {
  return report.events.find((row) => row.event?.kind === 'reserved')?.event;
}

function nativeSummary(report) {
  const evidence = report.evidence[0];
  return {
    termsHash: report.termsHash,
    termsProfile: report.terms.profile,
    resource: evidence?.quote?.resource?.url ?? null,
    quote: evidence?.quote?.accepted ?? null,
    callId: evidence?.callId ?? null,
    requestKey: reservedEvent(report)?.requestKey ?? null,
    requestHash: reservedEvent(report)?.requestHash ?? null,
    nonce: evidence?.nonce ?? null,
    transaction: evidence?.verified?.ledger?.transaction ?? evidence?.wire?.settlement?.transaction ?? null,
    requestId: evidence?.verified?.receipt?.requestId ?? null,
    signer: evidence?.verified?.receipt?.signer ?? null,
    wireStatus: evidence?.wire?.status ?? null,
    wireBody: evidence?.wire?.body ?? null,
    callState: report.summary.state,
    verifiedSpent: report.summary.verifiedSpent,
    unresolved: report.summary.unresolved,
  };
}

async function runSuccess() {
  const h = newHarness('normal');
  try {
    const call = await h.client.call(h.sessionId, input.clientRequestId, structuredClone(input));
    h.journal.end(h.sessionId);
    const report = h.journal.export(h.sessionId);
    assert.equal(call.state, 'VERIFIED');
    assert.equal(report.summary.verifiedSpent, '1000');
    assert.equal(report.evidence[0].wire.status, 200);
    assert.equal(h.ledger.state.paidCount, 1);
    assert.equal((await verifyChain(report)), true);
    return {
      report,
      observation: nativeSummary(report),
      fixture: {
        independentMockLedgerState: 'mock-settled',
        deliveryObservation: 'synthetic HTTP 200 body observed; not a Maha response',
        paymentCount: h.ledger.state.paidCount,
        transaction: h.ledger.state.mockTransaction,
        requestObservation: h.ledger.state.observations.at(-1),
      },
    };
  } finally {
    h.journal.close();
  }
}

async function runNoWireUnrecoverable() {
  const h = newHarness('lost-no-wire');
  try {
    const call = await h.client.call(h.sessionId, input.clientRequestId, structuredClone(input));
    assert.equal(call.state, 'RECONCILIATION_REQUIRED');
    assert.equal(call.wire, null);
    const replay = await h.client.call(h.sessionId, input.clientRequestId, structuredClone(input));
    assert.equal(replay.id, call.id);
    assert.equal(h.ledger.state.sendCount, 1);
    assert.equal(h.ledger.state.prepareCount, 1);
    await h.client.reconcile(call.id);
    h.journal.end(h.sessionId);
    const report = h.journal.export(h.sessionId);
    assert.equal(report.summary.state, 'RECONCILIATION_REQUIRED');
    assert.equal(report.summary.allocatedTotal, '1000');
    assert.equal(report.summary.verifiedSpent, '0');
    assert.equal(report.summary.unresolved, 1);
    assert.equal(report.evidence[0].wire, null);
    assert.equal(await verifyChain(report), true);
    return {
      report,
      observation: nativeSummary(report),
      fixture: {
        independentMockLedgerState: 'mock-settled',
        deliveryObservation: 'no response received',
        originalOutputRecoverable: false,
        paymentCount: h.ledger.state.paidCount,
        transaction: h.ledger.state.mockTransaction,
        responseEvidenceRetainedByMock: false,
        retrySameRequestKeyAddedPayment: h.ledger.state.sendCount !== 1,
      },
    };
  } finally {
    h.journal.close();
  }
}

async function runLostThenRecoverNull() {
  const h = newHarness('lost-recover-null');
  try {
    const call = await h.client.call(h.sessionId, input.clientRequestId, structuredClone(input));
    assert.equal(call.state, 'RECONCILIATION_REQUIRED');
    assert.equal(call.wire, null);
    h.journal.end(h.sessionId);
    const beforeRecovery = h.journal.export(h.sessionId);
    const replay = await h.client.call(h.sessionId, input.clientRequestId, structuredClone(input));
    assert.equal(replay.id, call.id);
    assert.equal(h.ledger.state.sendCount, 1);
    assert.equal(h.ledger.state.prepareCount, 1);
    const recovered = await h.client.reconcile(call.id, h.ledger.state.recoverableWire);
    assert.equal(recovered.state, 'VERIFIED');
    assert.equal(recovered.wire.status, 200);
    assert.equal(recovered.wire.body, null);
    const afterRecovery = h.journal.export(h.sessionId);
    assert.equal(afterRecovery.summary.state, 'CLOSED');
    assert.equal(afterRecovery.summary.verifiedSpent, '1000');
    assert.equal(afterRecovery.evidence[0].verified.receipt.signer, 'none');
    assert.equal(afterRecovery.evidence[0].verified.receipt.requestId, 'unsigned:' + recovered.nonce);
    assert.equal(afterRecovery.evidence[0].wire.body, null);
    assert.equal(afterRecovery.evidence[0].verified.ledger.verification, 'rpc-confirmed');
    assert.equal(h.ledger.state.paidCount, 1);
    assert.equal(h.ledger.state.sendCount, 1);
    assert.equal(await verifyChain(beforeRecovery), true);
    assert.equal(await verifyChain(afterRecovery), true);
    return {
      beforeRecovery,
      afterRecovery,
      observation: {
        before: nativeSummary(beforeRecovery),
        after: nativeSummary(afterRecovery),
      },
      fixture: {
        independentMockLedgerState: 'mock-settled',
        deliveryObservation: 'HTTP 200 WireResponse recovered with a null body; no output payload recovered',
        originalOutputRecoverable: false,
        responseEvidenceRecovered: true,
        paymentCount: h.ledger.state.paidCount,
        paymentSubmissions: h.ledger.state.sendCount,
        transaction: h.ledger.state.mockTransaction,
        requestObservation: h.ledger.state.observations.at(-1),
      },
    };
  } finally {
    h.journal.close();
  }
}

async function runDirectNullBody() {
  const h = newHarness('null-body-200');
  try {
    const call = await h.client.call(h.sessionId, input.clientRequestId, structuredClone(input));
    h.journal.end(h.sessionId);
    const report = h.journal.export(h.sessionId);
    assert.equal(call.state, 'VERIFIED');
    assert.equal(report.evidence[0].wire.status, 200);
    assert.equal(report.evidence[0].wire.body, null);
    assert.equal(report.evidence[0].verified.receipt.signer, 'none');
    assert.equal(report.summary.verifiedSpent, '1000');
    assert.equal(await verifyChain(report), true);
    return { report, observation: nativeSummary(report) };
  } finally {
    h.journal.close();
  }
}

const success = await runSuccess();
const noWire = await runNoWireUnrecoverable();
const recoveredNull = await runLostThenRecoverNull();
const directNull = await runDirectNullBody();
const requestHash = reservedEvent(success.report)?.requestHash ?? null;

const sample = {
  fixtureMetadata: {
    purpose: 'Offline synthetic ALSP export exercise; no Maha endpoint or public RPC was called.',
    repository: 'Kairose-master/ALSP',
    mainSha: MAIN_SHA,
    treeSha: TREE_SHA,
    randomIds: 'Journal session IDs and authorization nonces are generated per run; scenario behavior is reproducible, bytes are not deterministic.',
    nativeExportsAreUnmodified: true,
  },
  nativeExports: {
    success: success.report,
    noWireAndUnrecoverableOutput: noWire.report,
    lostThenBodylessRecovery: {
      beforeRecovery: recoveredNull.beforeRecovery,
      afterRecovery: recoveredNull.afterRecovery,
    },
    directHttp200NullBody: directNull.report,
  },
  companion: {
    label: 'Non-normative comparison/fixture annotations; these are not ALSP native fields or provider evidence.',
    publicContractMapping: {
      offerId: 'context-compression',
      resource: RESOURCE,
      metadataVersion: '2026-08-10',
      metadataSchemaVersion: '1.0.0',
      catalogVersion: '0.2.3',
      catalogUpdatedAt: '2026-09-09',
      termsVersion: null,
      termsVersionNote: 'The metadata/catalog versions above are not a signed provider terms version.',
      requiresIdempotency: false,
      payment: {
        scheme: 'exact',
        network: NETWORK,
        asset: ASSET,
        payTo: PAY_TO,
        amount: '1000',
        decimals: 6,
        displayAmountUSDC: '0.001',
      },
      inputSchemaNotes: {
        clientRequestId: 'string, 8–120 chars',
        task: 'string, 8–1200 chars',
        tokenBudget: 'integer, 64–16000',
        documents: '1–8 items; id regex ^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$; non-empty text; optional title 1–160 chars',
        additionalOptions: {
          provenance: ['full', 'compact', 'none'],
          scoring: ['bm25', 'keyword'],
          budgetMode: ['guaranteed', 'estimated'],
        },
        unknownProperties: 'rejected at root and document level',
        requestBodyMaxBytes: 450000,
        settlementValidation: 'before settlement',
      },
      responseSchemaNotes: {
        version: '0.1.0',
        packIdPattern: '^ctxpack_[a-f0-9]{32}$',
        hashes: 'sha256: followed by 64 lowercase hexadecimal characters',
        bodyShape: 'Not fabricated in this fixture; no live or authoritative response body was fetched.',
      },
      sourceUrls: [
        'https://www.mahastrategies.com/api/discovery/x402-offers/context-compression',
        'https://www.mahastrategies.com/.well-known/maha/offer-selection.json',
        'https://www.mahastrategies.com/context-pack-schema.json',
        'https://www.mahastrategies.com/pricing',
        'https://www.mahastrategies.com/recipes/bazaar-discovery-to-payment',
      ],
    },
    alspNativeFieldMapping: {
      resource: 'terms.endpoint and evidence[].quote.resource.url',
      offerId: 'No native field; see publicContractMapping.offerId.',
      providerMetadataVersion: 'No native field; metadataVersion is non-normative and not signed terms.',
      requestOrPurchaseId: 'evidence[].callId is local ALSP identity; unsigned receipt requestId is unsigned:<nonce>, not a provider-issued ID. requestKey appears in the reserved event.',
      inputDigest: 'No standalone native input digest. reserved.event.requestHash is SHA-256(canonical({endpoint,input:normalizedInput})); it is not a bare input digest or Maha inputHash.',
      paymentFields: 'terms network/asset/provider plus evidence[].quote.accepted amount/payTo.',
      transaction: 'wire.settlement.transaction when a WireResponse exists; otherwise only the non-native mock-ledger annotation has the mock tx hash.',
      authorizationNonce: 'evidence[].nonce and the reserved event; the ordinary archive does not export the bearer signature.',
      settlementAndDelivery: 'No separate native settlement_status/delivery_status. The companion annotations are synthetic fixture observations only.',
      providerResponseAuthenticity: 'Unsigned mode records signer=none and a body digest; it does not authenticate response content.',
    },
    requestSerializationObservation: {
      method: 'POST',
      payloadQueryPresent: true,
      requestBodyPresent: false,
      matchesMahaJsonBodyContract: false,
      note: 'The actual ALSP x402 transport was exercised against an in-process fetch mock. Its flat string normalizer places JSON text in a query parameter and POST sends no JSON body.',
    },
    scenarios: {
      success: success.fixture,
      noWireAndUnrecoverableOutput: noWire.fixture,
      lostThenBodylessRecovery: recoveredNull.fixture,
      directHttp200NullBody: {
        nativeState: directNull.report.summary.state,
        bodyIsNull: directNull.report.evidence[0].wire.body === null,
        receiptSigner: directNull.report.evidence[0].verified.receipt.signer,
        settlementVerifierLabel: directNull.report.evidence[0].verified.ledger.verification,
        interpretation: 'Synthetic mock RPC only; VERIFIED does not mean content was delivered or authenticated.',
      },
    },
    snapshotSummaries: {
      success: success.observation,
      noWireAndUnrecoverableOutput: noWire.observation,
      lostThenBodylessRecovery: recoveredNull.observation,
      directHttp200NullBody: directNull.observation,
    },
    digestExample: {
      nativeRequestHashFromSuccessFixture: requestHash,
      means: 'This hash binds endpoint plus ALSP-normalized input; it is not the provider inputHash.',
    },
  },
};

await mkdir(ROOT, { recursive: true });
const mapping = sample.companion;
delete sample.companion;
await writeFile(resolve(ROOT, 'samples.json'), JSON.stringify(sample, null, 2) + '\n');
await writeFile(resolve(ROOT, 'maha-public-mapping.json'), JSON.stringify(mapping, null, 2) + '\n');
console.log(JSON.stringify({
  generated: resolve(ROOT, 'samples.json'),
  mapping: resolve(ROOT, 'maha-public-mapping.json'),
  mainSha: MAIN_SHA,
  cases: {
    success: success.report.summary.state,
    noWire: noWire.report.summary.state,
    noWireHasWireResponse: noWire.report.evidence[0].wire !== null,
    noWireMockPayments: noWire.fixture.paymentCount,
    recoveredNull: recoveredNull.afterRecovery.summary.state,
    recoveredNullBody: recoveredNull.afterRecovery.evidence[0].wire.body,
    recoveredNullMockPayments: recoveredNull.fixture.paymentCount,
    directNull: directNull.report.summary.state,
  },
}, null, 2));
