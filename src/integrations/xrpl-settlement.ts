/**
 * Testnet-only XRPL settlement coordinator.
 * Caller supplies durable journal methods. No automatic retry of settlement.
 * A successful facilitator response is NOT proof of ledger finality.
 */
import { T54Facilitator, type XrplPaymentPayload, type XrplRequirement } from './t54-facilitator.js';
import { fetchVerifiedXrplPayment } from './xrpl-ledger.js';
import type { XrplPaymentBinding, XrplLedgerEvidence } from './xrpl-evidence.js';

export interface XrplSettlementJournal {
  /** Atomically persist the payment attempt before any network submission. Must reject duplicates. */
  beginSettlement(callId: string, transactionHash: string): Promise<void>;
  /** Persist the untrusted facilitator response before ledger verification. */
  recordFacilitatorResponse(callId: string, response: unknown): Promise<void>;
  /** Persist independently validated ledger evidence. */
  markVerified(callId: string, evidence: XrplLedgerEvidence): Promise<void>;
  /** Leave budget reserved and require operator reconciliation. */
  markUnresolved(callId: string): Promise<void>;
}

export interface XrplSettlementInput {
  callId: string;
  transactionHash: string;
  binding: XrplPaymentBinding;
  requirement: XrplRequirement;
  payload: XrplPaymentPayload;
}

export class XrplSettlementCoordinator {
  constructor(
    private readonly journal: XrplSettlementJournal,
    private readonly facilitator: T54Facilitator,
    private readonly ledgerFetch: typeof fetch = fetch,
  ) {}
  async settleOnce(input: XrplSettlementInput): Promise<XrplLedgerEvidence> {
    if (this.facilitator.network !== 'xrpl:1' || input.binding.network !== 'xrpl:1' ||
        input.requirement.network !== 'xrpl:1') throw new Error('Testnet only');
    if (input.callId !== input.binding.callId) throw new Error('Call identity mismatch');
    if (input.requirement.extra.invoiceId !== input.binding.invoiceId) throw new Error('Invoice identity mismatch');
    // The caller must ensure this journal method is atomic and durable.
    await this.journal.beginSettlement(input.callId, input.transactionHash);
    try {
      const settlement = await this.facilitator.settle(input.payload, input.requirement, true);
      await this.journal.recordFacilitatorResponse(input.callId, settlement);
      if (!settlement.success) throw new Error('Facilitator settlement rejected');
      if (typeof settlement.transaction !== 'string' || settlement.transaction.toUpperCase() !== input.transactionHash.toUpperCase())
        throw new Error('Facilitator transaction mismatch');
      const proof = await fetchVerifiedXrplPayment(input.transactionHash, input.binding, this.ledgerFetch);
      await this.journal.markVerified(input.callId, proof);
      return proof;
    } catch (error) {
      try { await this.journal.markUnresolved(input.callId); } catch { /* original failure retained */ }
      throw error;
    }
  }
  /** Recovery never invokes facilitator settlement. Missing bindings remain unresolved. */
  async recoverPending(
    pending: ReadonlyArray<{ callId: string; transactionHash: string }>,
    bindingFor: (callId: string) => Promise<XrplPaymentBinding | null>,
  ): Promise<{ verified: string[]; unresolved: string[] }> {
    const verified: string[] = [], unresolved: string[] = [];
    for (const attempt of pending) {
      try {
        const binding = await bindingFor(attempt.callId);
        if (!binding) throw new Error('Missing persisted payment binding');
        await this.reconcile(attempt.callId, attempt.transactionHash, binding);
        verified.push(attempt.callId);
      } catch {
        unresolved.push(attempt.callId);
        try { await this.journal.markUnresolved(attempt.callId); } catch { /* report unresolved */ }
      }
    }
    return { verified, unresolved };
  }
  /** Reconciliation performs read-only ledger lookup, never calls /settle again. */
  async reconcile(callId: string, transactionHash: string, binding: XrplPaymentBinding): Promise<XrplLedgerEvidence> {
    if (callId !== binding.callId || binding.network !== 'xrpl:1') throw new Error('Invalid reconciliation identity');
    try {
      const proof = await fetchVerifiedXrplPayment(transactionHash, binding, this.ledgerFetch);
      await this.journal.markVerified(callId, proof);
      return proof;
    } catch (error) {
      try { await this.journal.markUnresolved(callId); } catch { /* preserve original error */ }
      throw error;
    }
  }
}
