import { Journal, type Call } from './journal.js';
import { requestUrl, selectQuote, validatePrepared, type Prepared, type Quote, type RequestInput, type Terms, type Verified, type WireResponse } from './protocol.js';
import type { PaymentAdapter, ProviderAdapter, ReceiptEvidenceAdapter } from './adapters.js';

export interface SessionAdapters extends ProviderAdapter, PaymentAdapter, ReceiptEvidenceAdapter {}
export class SessionClient {
  constructor(readonly journal: Journal, private adapters: SessionAdapters, private now = Date.now) {}
  async call(sessionId: string, key: string, input: RequestInput): Promise<Call> {
    const existing = this.journal.find(sessionId, key, input);
    // Never re-probe, re-sign or automatically resend a persisted request.
    if (existing) return existing;
    const session = this.journal.session(sessionId), terms = session.terms;
    if (session.state !== 'ACTIVE' || this.now() >= terms.expiresAt) throw new Error('Session not active');
    const url = requestUrl(terms, input), quote = selectQuote(await this.adapters.probe(url), terms, input);
    const reserved = this.journal.reserve(sessionId, key, input, quote, this.now());
    if (!reserved.created) return reserved.call;
    const c = reserved.call;
    try {
      const prepared = await this.adapters.prepare(quote, terms, c.nonce, this.now());
      this.adapters.validate ? this.adapters.validate(prepared, quote, terms, c.nonce, this.now()) : validatePrepared(prepared, quote, terms, c.nonce, this.now());
      this.journal.prepared(c.id, prepared);
      this.journal.submitted(c.id, this.now()); // durable commit BEFORE network side effect
      const wire = await this.adapters.send(url, prepared);
      this.journal.capture(c.id, wire); // commit BEFORE receipt/RPC validation
      await this.reconcile(c.id);
    } catch {
      // Do not log thrown SDK/fetch objects: they can contain payment signatures.
      this.journal.unresolved(c.id);
    }
    return this.journal.call(c.id);
  }
  async reconcile(callId: string, recoveredResponse?: WireResponse): Promise<Call> {
    let c = this.journal.call(callId);
    if (c.state === 'VERIFIED') return c;
    try {
      if (recoveredResponse) this.journal.capture(callId, recoveredResponse);
      c = this.journal.call(callId);
      if (!c.wire || !c.prepared) throw new Error('Original response required; no automatic repayment');
      const proof = await this.adapters.verify(c, this.journal.session(c.sessionId).terms);
      this.journal.verified(callId, proof);
    } catch { this.journal.unresolved(callId); }
    return this.journal.call(callId);
  }
}
