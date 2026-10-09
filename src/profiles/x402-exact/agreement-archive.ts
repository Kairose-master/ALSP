import { verifyBuyerSeal, type BuyerSeal } from './archive.js';
import type { Call, Journal } from './journal.js';
import { verifyPriceAgreement } from './price-agreement.js';
import { verifyReceipt, type SignerPin } from './receipt.js';
import {
  address, atomic, canonical, digest, hash32, inputOf, matchesAgreementLink,
  object, selectQuote, text, validateAgreementTime, validateTerms,
  type Prepared, type ProviderProfile,
} from './protocol.js';

type SealedArchive = ReturnType<Journal['export']> & { buyerSeal: BuyerSeal };
export type PriceAgreementArchiveVerification =
  | { valid: false; reason: string }
  | {
    valid: true;
    agreementId: string;
    agreementHash: string;
    calls: number;
    total: string;
    state: 'ACTIVE' | 'CLOSED';
    settlement: 'mock-settled' | 'not-independently-verified';
    buyerSeal: 'verified';
    agreementSignatures: 'verified';
    providerReceipts: 'verified';
    authorizationSignatures: 'not-exported';
    semanticCorrectness: 'not-verified';
    logCompleteness: 'not-proven';
  };

function requireThat(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}

/**
 * Rechecks a fully reconciled agreement archive using the caller's trust anchors.
 * This is historical verification: expiry today does not invalidate older receipts.
 * It verifies neither payment bearer signatures (intentionally not exported) nor
 * fresh RPC settlement, and cannot prove omitted activity in other sessions.
 */
export async function verifyPriceAgreementArchive(
  archive: unknown,
  expectedBuyer: string,
  providerProfile: ProviderProfile,
  signerPins: SignerPin[],
): Promise<PriceAgreementArchiveVerification> {
  try {
    // Keep caller-supplied trust anchors stable across asynchronous verification.
    providerProfile = { ...providerProfile, asset: { ...providerProfile.asset }, receipt: { ...providerProfile.receipt } };
    signerPins = signerPins.map(pin => ({ ...pin }));
    // Own a plain JSON snapshot so asynchronous signature recovery cannot race a
    // caller mutating the evidence or envelope in place.
    const report = JSON.parse(canonical(archive)) as SealedArchive;
    const terms = report.terms;
    validateTerms(terms, providerProfile);
    const agreement = terms.priceAgreement;
    requireThat(agreement, 'Archive has no bilateral price agreement');
    requireThat(address(terms.payer) === address(expectedBuyer), 'Unexpected archive buyer');
    requireThat(await verifyBuyerSeal(report, expectedBuyer), 'Invalid buyer seal or event hash chain');
    await verifyPriceAgreement(agreement, agreement.terms.validFrom);

    requireThat(Array.isArray(report.evidence) && report.evidence.length > 0, 'Archive has no call evidence');
    requireThat(report.evidence.length <= terms.maxCalls && report.evidence.length <= agreement.terms.maxCalls, 'Call allowance exceeded');
    const total = BigInt(report.evidence.length) * atomic(agreement.terms.unitPrice);
    requireThat(total <= atomic(terms.maxTotal) && total <= atomic(agreement.terms.maxTotal), 'Total allowance exceeded');

    const evidence = new Map<string, {
      call: Call;
      quoteHash: string;
      authorizationHash: string;
      responseHash: string;
      proofHash: string;
    }>();
    const nonces = new Set<string>(), receiptIds = new Set<string>(), transactions = new Set<string>();
    let mockCalls = 0;
    for (const item of report.evidence) {
      const callId = text(item.callId);
      requireThat(!evidence.has(callId), 'Duplicate call evidence');
      const nonce = hash32(item.nonce);
      requireThat(item.nonce === nonce && !nonces.has(nonce), 'Duplicate or noncanonical payment nonce');
      nonces.add(nonce);
      const createdAt = item.createdAt;
      requireThat(Number.isSafeInteger(createdAt), 'Missing reservation timestamp');
      validateAgreementTime(agreement, createdAt!);
      requireThat(createdAt! < terms.expiresAt, 'Call reserved after session expiry');
      const quote = selectQuote({ x402Version: item.quote.x402Version, resource: item.quote.resource, accepts: [item.quote.accepted] }, terms, item.input, providerProfile);
      requireThat(digest(quote) === digest(item.quote), 'Archived quote is not the selected agreement quote');

      requireThat(item.authorization, 'Missing unsigned authorization fields');
      const authorization = item.authorization;
      requireThat(Object.keys(authorization).sort().join(',') === 'from,nonce,to,validAfter,validBefore,value', 'Unexpected authorization fields');
      requireThat(address(authorization.from) === address(terms.payer)
        && address(authorization.to) === address(terms.provider)
        && atomic(authorization.value) === atomic(agreement.terms.unitPrice)
        && hash32(authorization.nonce) === nonce, 'Authorization payment binding mismatch');
      const after = atomic(authorization.validAfter), before = atomic(authorization.validBefore);
      requireThat(after < before && before > BigInt(Math.floor(createdAt! / 1000))
        && before * 1000n <= BigInt(terms.expiresAt), 'Authorization lifetime exceeds session policy');

      requireThat(item.wire && item.verified, 'Unreconciled call evidence');
      requireThat(item.verified.semanticCorrectness === 'not-verified', 'Unsupported semantic-correctness claim');
      const bodyReceipt = object(object(item.wire.body).receipt);
      const signedAt = Date.parse(text(bodyReceipt.signed_at));
      requireThat(Number.isSafeInteger(signedAt), 'Invalid historical receipt time');
      requireThat(BigInt(signedAt) >= after * 1000n && BigInt(signedAt) < before * 1000n, 'Receipt is outside the archived authorization window');
      const call: Call = {
        id: callId, sessionId: report.sessionId, requestKey: '',
        requestHash: digest({ endpoint: terms.endpoint, input: inputOf(item.input, providerProfile) }),
        input: item.input, quote, amount: agreement.terms.unitPrice, nonce,
        createdAt: createdAt!, state: 'VERIFIED', wire: item.wire, verified: item.verified,
        // verifyReceipt consumes authorization fields, never this placeholder.
        prepared: { quote, authorization, signature: '0x' } satisfies Prepared,
      };
      const receipt = await verifyReceipt(call, terms, signerPins, providerProfile, signedAt);
      requireThat(digest(receipt) === digest(item.verified.receipt), 'Archived receipt proof differs from independent verification');
      requireThat(!receiptIds.has(receipt.requestId), 'Duplicate provider receipt ID');
      receiptIds.add(receipt.requestId);

      const settlement = object(item.wire.settlement), ledger = item.verified.ledger;
      const transaction = hash32(ledger.transaction);
      requireThat(settlement.success === true && settlement.network === terms.network
        && address(settlement.payer) === address(terms.payer)
        && hash32(settlement.transaction) === transaction, 'Settlement metadata does not match the payment');
      requireThat(!transactions.has(transaction), 'Duplicate settlement transaction');
      transactions.add(transaction);
      hash32(ledger.blockHash);
      atomic(ledger.blockNumber);
      requireThat(Number.isSafeInteger(ledger.confirmations) && ledger.confirmations >= 0, 'Invalid archived confirmation count');
      if (ledger.verification === 'mock-settled') {
        requireThat(settlement.mock === true && bodyReceipt.settlement_mode === 'mock-settled', 'Signed mock settlement marker missing');
        mockCalls++;
      } else {
        requireThat(ledger.verification === 'rpc-confirmed' && settlement.mock !== true && bodyReceipt.settlement_mode !== 'mock-settled', 'Conflicting settlement labels');
      }
      evidence.set(callId, {
        call, quoteHash: digest(quote), authorizationHash: digest(authorization),
        responseHash: digest(item.wire), proofHash: digest(item.verified),
      });
    }
    // A mixed mock/live archive is not a coherent result for this demo verifier.
    requireThat(mockCalls === 0 || mockCalls === evidence.size, 'Mixed mock and non-mock settlement evidence');

    type Progress = { stage: 'RESERVED' | 'AUTHORIZED' | 'SUBMITTED' | 'VERIFIED'; response: boolean; unresolved: boolean };
    const progress = new Map<string, Progress>(), requestKeys = new Set<string>();
    let active = true;
    for (const row of report.events) {
      const event = object(row.event), kind = text(event.kind);
      if (kind === 'access_ended') {
        requireThat(active, 'Duplicate session ending');
        active = false;
        continue;
      }
      if (kind === 'access_resumed') {
        requireThat(!active && event.reason === 'continue_after_reconciliation'
          && [...progress.values()].every(p => p.stage === 'VERIFIED'), 'Invalid session resume');
        requireThat(progress.size < terms.maxCalls
          && progress.size < agreement.terms.maxCalls
          && BigInt(progress.size) * atomic(agreement.terms.unitPrice) < atomic(terms.maxTotal)
          && BigInt(progress.size) * atomic(agreement.terms.unitPrice) < atomic(agreement.terms.maxTotal), 'Exhausted session or agreement resumed');
        active = true;
        continue;
      }
      const callId = text(event.callId), item = evidence.get(callId);
      requireThat(item, 'Event refers to missing call evidence');
      const call = item.call;
      if (kind === 'reserved') {
        const key = text(event.requestKey);
        requireThat(active && !progress.has(callId) && /^[\w.-]{1,100}$/.test(key) && !requestKeys.has(key), 'Invalid or duplicate reservation');
        requireThat(event.requestHash === call.requestHash && event.amount === call.amount && event.nonce === call.nonce
          && event.createdAt === call.createdAt && event.quoteHash === item.quoteHash
          && matchesAgreementLink(event.agreement, agreement), 'Reservation evidence binding mismatch');
        requestKeys.add(key);
        progress.set(callId, { stage: 'RESERVED', response: false, unresolved: false });
        continue;
      }
      const state = progress.get(callId);
      requireThat(state, 'Call event precedes its reservation');
      switch (kind) {
        case 'authorized':
          requireThat(state.stage === 'RESERVED' && !state.unresolved
            && /^[a-f0-9]{64}$/.test(text(event.paymentHash))
            && event.authorizationHash === item.authorizationHash, 'Invalid authorization event or evidence link');
          state.stage = 'AUTHORIZED';
          break;
        case 'submission_intent':
          requireThat(active && state.stage === 'AUTHORIZED' && !state.unresolved, 'Invalid submission transition');
          state.stage = 'SUBMITTED';
          break;
        case 'response':
          requireThat(state.stage === 'SUBMITTED' && !state.response && event.responseHash === item.responseHash, 'Invalid response transition or evidence link');
          state.response = true;
          break;
        case 'reconciliation_required':
          requireThat(state.stage !== 'VERIFIED' && !state.unresolved, 'Invalid reconciliation transition');
          state.unresolved = true;
          break;
        case 'verified':
          requireThat(state.stage === 'SUBMITTED' && state.response && event.amount === call.amount
            && digest(event.proof) === item.proofHash, 'Invalid verified transition or proof link');
          state.stage = 'VERIFIED';
          state.unresolved = false;
          break;
        default:
          throw new Error('Unsupported agreement archive event');
      }
    }
    requireThat(progress.size === evidence.size && [...progress.values()].every(p => p.stage === 'VERIFIED'), 'Archive has unverified or missing call events');
    const summary = report.summary, state = active ? 'ACTIVE' : 'CLOSED';
    requireThat(summary.state === state && summary.calls === evidence.size && summary.unresolved === 0
      && summary.allocatedTotal === total.toString() && summary.verifiedSpent === total.toString()
      && summary.registryWrites === 0 && summary.settlementMode === 'exact-per-call'
      && summary.licenseAcceptance === 'bilateral' && summary.priceAgreementAcceptance === 'bilateral', 'Archive summary differs from verified evidence');

    return {
      valid: true, agreementId: agreement.terms.agreementId, agreementHash: digest(agreement.terms),
      calls: evidence.size, total: total.toString(), state,
      settlement: mockCalls ? 'mock-settled' : 'not-independently-verified',
      buyerSeal: 'verified', agreementSignatures: 'verified', providerReceipts: 'verified',
      authorizationSignatures: 'not-exported', semanticCorrectness: 'not-verified', logCompleteness: 'not-proven',
    };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'Invalid price agreement archive' };
  }
}
