import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomic, canonical, digest, DOCTOR_PROVIDER, inputOf, PROFILE, validateTerms, type Prepared, type ProviderProfile, type Quote, type RequestInput, type Terms, type Verified, type WireResponse } from './protocol.js';

export interface Call {
  id: string; sessionId: string; requestKey: string; requestHash: string;
  input: RequestInput; quote: Quote; amount: string; nonce: string; createdAt: number;
  state: 'RESERVED' | 'AUTHORIZED' | 'SUBMITTED' | 'RECONCILIATION_REQUIRED' | 'VERIFIED';
  prepared: Prepared | null; wire: WireResponse | null; verified: Verified | null;
}
export interface EventRow { seq: number; previous: string; head: string; event: unknown; }
export class Journal {
  private db: DatabaseSync;
  /** A journal is bound to one provider profile; its terms must match that profile. */
  constructor(path: string, readonly provider: ProviderProfile = DOCTOR_PROVIDER) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Journal must be a regular file');
        chmodSync(path, 0o600);
      } else { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, terms TEXT NOT NULL, state TEXT NOT NULL, head TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(session_id,request_key));
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE REFERENCES calls(id));
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE REFERENCES calls(id));
      CREATE TABLE IF NOT EXISTS events(session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, previous TEXT NOT NULL, head TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id,seq));`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  session(id: string): { terms: Terms; state: string; head: string; seq: number } {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error('Unknown session');
    return { terms: JSON.parse(String(row.terms)) as Terms, state: String(row.state), head: String(row.head), seq: Number(row.seq) };
  }
  create(terms: Terms, now = Date.now()): string {
    validateTerms(terms, this.provider);
    if (terms.expiresAt <= now) throw new Error('Session already expired');
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(id, canonical(terms), 'ACTIVE', digest({ profile: PROFILE, sessionId: id, terms }), 0);
    return id;
  }
  unfinishedForPayer(payer: string): string[] {
    return this.db.prepare('SELECT id FROM sessions').all().map(row => String(row.id)).filter(id => {
      const s = this.session(id);
      return s.terms.payer.toLowerCase() === payer.toLowerCase() && (s.state === 'ACTIVE' || this.calls(id).some(c => c.state !== 'VERIFIED'));
    });
  }
  private append(sessionId: string, event: unknown): void {
    const s = this.session(sessionId), seq = s.seq + 1;
    const head = digest({ profile: PROFILE, sessionId, seq, previous: s.head, event });
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(sessionId, seq, s.head, head, canonical(event));
    this.db.prepare('UPDATE sessions SET seq=?,head=? WHERE id=?').run(seq, head, sessionId);
  }
  calls(sessionId: string): Call[] {
    return this.db.prepare('SELECT value FROM calls WHERE session_id=? ORDER BY rowid').all(sessionId).map(r => JSON.parse(String(r.value)) as Call);
  }
  call(id: string): Call {
    const row = this.db.prepare('SELECT value FROM calls WHERE id=?').get(id);
    if (!row) throw new Error('Unknown call');
    return JSON.parse(String(row.value)) as Call;
  }
  find(sessionId: string, key: string, input: RequestInput): Call | null {
    if (!/^[\w.-]{1,100}$/.test(key)) throw new Error('Invalid idempotency key');
    const requestHash = digest({ endpoint: this.session(sessionId).terms.endpoint, input: inputOf(input, this.provider) });
    const row = this.db.prepare('SELECT value FROM calls WHERE session_id=? AND request_key=?').get(sessionId, key);
    if (!row) return null;
    const c = JSON.parse(String(row.value)) as Call;
    if (c.requestHash !== requestHash) throw new Error('Idempotency key reused for different input');
    return c;
  }
  private put(c: Call): void { this.db.prepare('UPDATE calls SET value=? WHERE id=?').run(canonical(c), c.id); }
  reserve(sessionId: string, key: string, input: RequestInput, quote: Quote, now = Date.now()): { call: Call; created: boolean } {
    return this.transaction(() => {
      const old = this.find(sessionId, key, input);
      if (old) return { call: old, created: false };
      const s = this.session(sessionId), calls = this.calls(sessionId), amount = atomic(quote.accepted.amount);
      if (s.state !== 'ACTIVE' || now >= s.terms.expiresAt) throw new Error('Session not active');
      if (amount <= 0n || amount > atomic(s.terms.maxPerCall) || calls.length >= s.terms.maxCalls) throw new Error('Per-call policy exceeded');
      // Include every unresolved reservation: a network error never frees funds.
      if (calls.reduce((sum, c) => sum + atomic(c.amount), 0n) + amount > atomic(s.terms.maxTotal)) throw new Error('Session budget exceeded');
      const c: Call = { id: randomUUID(), sessionId, requestKey: key, requestHash: digest({ endpoint: s.terms.endpoint, input: inputOf(input, this.provider) }), input, quote, amount: amount.toString(), nonce: `0x${randomBytes(32).toString('hex')}`, createdAt: now, state: 'RESERVED', prepared: null, wire: null, verified: null };
      this.db.prepare('INSERT INTO calls VALUES(?,?,?,?)').run(c.id, sessionId, key, canonical(c));
      this.db.prepare('INSERT INTO payments VALUES(?,?)').run(`${s.terms.network}:${s.terms.asset.toLowerCase()}:${s.terms.payer.toLowerCase()}:${c.nonce}`, c.id);
      this.append(sessionId, { kind: 'reserved', callId: c.id, requestKey: key, requestHash: c.requestHash, amount: c.amount, nonce: c.nonce });
      return { call: c, created: true };
    });
  }
  prepared(id: string, prepared: Prepared): void {
    this.transaction(() => {
      const c = this.call(id);
      if (c.state !== 'RESERVED') throw new Error('Already authorized');
      c.prepared = prepared; c.state = 'AUTHORIZED'; this.put(c);
      // Signed bearer authorization stays in the 0600 journal, not the public log.
      this.append(c.sessionId, { kind: 'authorized', callId: id, paymentHash: digest(prepared) });
    });
  }
  submitted(id: string, now = Date.now()): void {
    this.transaction(() => {
      const c = this.call(id), s = this.session(c.sessionId);
      if (c.state !== 'AUTHORIZED' || !c.prepared || s.state !== 'ACTIVE' || now >= s.terms.expiresAt) throw new Error('Cannot submit');
      c.state = 'SUBMITTED'; this.put(c);
      this.append(c.sessionId, { kind: 'submission_intent', callId: id });
    });
  }
  capture(id: string, wire: WireResponse): void {
    this.transaction(() => {
      const c = this.call(id);
      if (!c.prepared || !['SUBMITTED', 'RECONCILIATION_REQUIRED'].includes(c.state)) throw new Error('Call was not submitted');
      if (c.wire) { if (digest(c.wire) !== digest(wire)) throw new Error('Conflicting response evidence'); return; }
      c.wire = wire; this.put(c);
      this.append(c.sessionId, { kind: 'response', callId: id, responseHash: digest(wire) });
    });
  }
  unresolved(id: string): void {
    this.transaction(() => {
      const c = this.call(id);
      if (c.state === 'VERIFIED' || c.state === 'RECONCILIATION_REQUIRED') return;
      c.state = 'RECONCILIATION_REQUIRED'; this.put(c);
      this.append(c.sessionId, { kind: 'reconciliation_required', callId: id });
    });
  }
  verified(id: string, proof: Verified): void {
    this.transaction(() => {
      const c = this.call(id), s = this.session(c.sessionId);
      if (c.state === 'VERIFIED') return;
      if (!c.wire || !c.prepared) throw new Error('Missing evidence');
      this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(`${s.terms.provider.toLowerCase()}:${proof.receipt.requestId}`, id);
      c.verified = proof; c.state = 'VERIFIED'; this.put(c);
      this.append(c.sessionId, { kind: 'verified', callId: id, amount: c.amount, proof });
    });
  }
  resume(sessionId: string, now = Date.now()): void {
    this.transaction(() => {
      const s = this.session(sessionId), calls = this.calls(sessionId);
      if (s.state === 'ACTIVE') return;
      if (now >= s.terms.expiresAt) throw new Error('Session expired');
      if (calls.some(c => c.state !== 'VERIFIED')) throw new Error('Unresolved call prevents resume');
      if (calls.length >= s.terms.maxCalls) throw new Error('Session call limit reached');
      if (calls.reduce((sum, c) => sum + atomic(c.amount), 0n) >= atomic(s.terms.maxTotal)) throw new Error('Session budget exhausted');
      this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run('ACTIVE', sessionId);
      this.append(sessionId, { kind: 'access_resumed', reason: 'continue_after_reconciliation' });
    });
  }
  end(sessionId: string): void {
    this.transaction(() => {
      const s = this.session(sessionId);
      if (s.state !== 'ACTIVE') return;
      this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run('ENDED', sessionId);
      this.append(sessionId, { kind: 'access_ended' });
    });
  }
  export(sessionId: string) {
    const s = this.session(sessionId), calls = this.calls(sessionId);
    const events: EventRow[] = this.db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY seq').all(sessionId).map(r => ({ seq: Number(r.seq), previous: String(r.previous), head: String(r.head), event: JSON.parse(String(r.event)) as unknown }));
    return { profile: PROFILE, sessionId, terms: s.terms, termsHash: digest(s.terms), headHash: s.head, events,
      summary: { state: s.state === 'ACTIVE' ? 'ACTIVE' : calls.every(c => c.state === 'VERIFIED') ? 'CLOSED' : 'RECONCILIATION_REQUIRED', allocatedTotal: calls.reduce((sum, c) => sum + atomic(c.amount), 0n).toString(), verifiedSpent: calls.filter(c => c.state === 'VERIFIED').reduce((sum, c) => sum + atomic(c.amount), 0n).toString(), unresolved: calls.filter(c => c.state !== 'VERIFIED').length, calls: calls.length, registryWrites: 0, settlementMode: 'exact-per-call', licenseAcceptance: 'buyer-only' },
      evidence: calls.map(c => ({ callId: c.id, input: c.input, quote: c.quote, nonce: c.nonce, wire: c.wire, verified: c.verified })) };
  }
}
export function verifyChain(archive: ReturnType<Journal['export']>): boolean {
  try {
    if (archive.profile !== PROFILE || archive.termsHash !== digest(archive.terms)) return false;
    let head = digest({ profile: PROFILE, sessionId: archive.sessionId, terms: archive.terms });
    for (const [i, r] of archive.events.entries()) {
      if (r.seq !== i + 1 || r.previous !== head) return false;
      head = digest({ profile: PROFILE, sessionId: archive.sessionId, seq: r.seq, previous: head, event: r.event });
      if (head !== r.head) return false;
    }
    return head === archive.headHash;
  } catch { return false; }
}
