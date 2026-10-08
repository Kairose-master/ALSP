// Browser-side ALSP x402 Exact session client.
// Mirrors src/profiles/x402-exact/{protocol,journal,session}.ts: the buyer's journal lives in this
// browser (localStorage, one atomic write per transition), the wallet signs, and the stateless server
// only proxies HTTP and runs the library's verifiers. Archives exported here verify with the library's
// verifyChain / verifyBuyerSeal because the canonical encoding and hash chain are identical.

export const PROFILE = 'alsp-exact-session-v0.2';
export const AUTHORIZATION_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };

// ---------- canonical JSON (Doctor's sorted UTF-16 / ASCII profile, same as the library) ----------
export function canonical(value, depth = 0) {
  if (depth > 64) throw new Error('JSON nesting exceeds limit');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, v => canonical(v, depth + 1)).join(',')}]`;
  if (typeof value === 'object' && value && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(k => `${canonical(k)}:${canonical(value[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Only finite plain JSON values are supported');
}
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const sha256Text = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
export const digest = value => sha256Text(canonical(value));
export const randomNonce = () => `0x${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
export const atomic = v => { if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new Error('Invalid atomic amount'); return BigInt(v); };
export const lower = a => { if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('Invalid EVM address'); return a.toLowerCase(); };
export const chainIdOf = n => { const m = /^eip155:([1-9][0-9]{0,9})$/.exec(String(n)); if (!m) throw new Error('Only eip155 networks are supported'); return Number(m[1]); };

// ---------- request input normalization (must match the server's choice for the same profile) ----------
export function doctorInput(v) {
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => k !== 'url' && k !== 'method')) throw new Error('Doctor accepts only url and method');
  const u = new URL(String(v.url));
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('Invalid target URL');
  if (v.method !== undefined && v.method !== 'GET' && v.method !== 'POST') throw new Error('Invalid target method');
  return v.method === undefined ? { url: v.url } : { url: v.url, method: v.method };
}
export function genericInput(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object');
  const keys = Object.keys(v).sort(); if (keys.length > 16) throw new Error('Too many request parameters');
  const out = {};
  for (const k of keys) { if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k) || typeof v[k] !== 'string' || v[k].length > 2048) throw new Error('Request parameters must be short strings'); out[k] = v[k]; }
  return out;
}
export const inputOf = (value, provider) => (provider.id === 'x402-doctor' ? doctorInput : genericInput)(value);

// ---------- journal ----------
const KEY = 'alsp:v1';
const LOCK = `${KEY}:write`;
const empty = () => ({ sessions: {}, receipts: {}, payments: {} });
let localWriteQueue = Promise.resolve();
export class BrowserJournal {
  constructor(storage = globalThis.localStorage, locks = globalThis.navigator?.locks) { this.storage = storage; this.locks = locks; }
  load() {
    let raw;
    try { raw = this.storage.getItem(KEY); } catch (cause) { throw new Error('Journal storage is unavailable; refusing to continue without payment history', { cause }); }
    if (raw === null || raw === undefined) return empty();
    let db;
    try { if (typeof raw !== 'string') throw new Error('Storage value is not text'); db = JSON.parse(raw); } catch (cause) { throw new Error('Journal data is corrupted; refusing to continue without payment history', { cause }); }
    const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    if (!record(db) || !record(db.sessions) || !record(db.receipts) || !record(db.payments)) {
      throw new Error('Journal data is invalid; refusing to continue without payment history');
    }
    for (const [id, s] of Object.entries(db.sessions)) {
      if (!record(s) || s.id !== id || !record(s.terms) || !record(s.provider) || !['ACTIVE', 'ENDED'].includes(s.state) || typeof s.head !== 'string' || !Number.isSafeInteger(s.seq) || s.seq < 0 || !Number.isFinite(s.createdAt) || !Array.isArray(s.events) || !Array.isArray(s.calls) || s.seq !== s.events.length) {
        throw new Error('Journal data is invalid; refusing to continue without payment history');
      }
      for (const c of s.calls) if (!record(c) || c.sessionId !== id || typeof c.id !== 'string' || typeof c.requestKey !== 'string' || typeof c.requestHash !== 'string' || !['RESERVED', 'AUTHORIZED', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'VERIFIED'].includes(c.state)) {
        throw new Error('Journal data is invalid; refusing to continue without payment history');
      }
    }
    return db;
  }
  save(db) { this.storage.setItem(KEY, JSON.stringify(db)); }
  async withWriteLock(fn) {
    if (this.locks?.request) return this.locks.request(LOCK, { mode: 'exclusive' }, fn);
    // Node-based demos have no browser tabs. In browsers, never silently fall back to an
    // in-memory mutex: it would not coordinate other tabs sharing localStorage.
    if (globalThis.navigator) throw new Error('Browser reservation lock unavailable; refusing journal write');
    const previous = localWriteQueue;
    let release;
    localWriteQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  list() { return Object.values(this.load().sessions).sort((a, b) => b.createdAt - a.createdAt).map(s => ({ id: s.id, state: s.state, createdAt: s.createdAt, providerId: s.provider.id, payer: s.terms.payer, calls: s.calls.length, unresolved: s.calls.filter(c => c.state !== 'VERIFIED').length })); }
  session(id, db = this.load()) { const s = db.sessions[id]; if (!s) throw new Error('Unknown session'); return s; }
  calls(id) { return this.session(id).calls; }
  call(id, db = this.load()) { for (const s of Object.values(db.sessions)) { const c = s.calls.find(c => c.id === id); if (c) return c; } throw new Error('Unknown call'); }
  async create(terms, provider, now = Date.now()) {
    if (terms.expiresAt <= now) throw new Error('Session already expired');
    return this.withWriteLock(async () => {
      const db = this.load(), id = crypto.randomUUID();
      db.sessions[id] = { id, terms, provider, state: 'ACTIVE', head: await digest({ profile: PROFILE, sessionId: id, terms }), seq: 0, createdAt: now, events: [], calls: [] };
      this.save(db); return id;
    });
  }
  async append(s, event) {
    const seq = s.seq + 1, head = await digest({ profile: PROFILE, sessionId: s.id, seq, previous: s.head, event });
    s.events.push({ seq, previous: s.head, head, event }); s.seq = seq; s.head = head;
  }
  async find(sessionId, key, input) {
    if (!/^[\w.-]{1,100}$/.test(key)) throw new Error('Invalid idempotency key');
    const s = this.session(sessionId), requestHash = await digest({ endpoint: s.terms.endpoint, input: inputOf(input, s.provider) });
    const c = s.calls.find(c => c.requestKey === key);
    if (!c) return null;
    if (c.requestHash !== requestHash) throw new Error('Idempotency key reused for different input');
    return c;
  }
  async reserve(sessionId, key, input, quote, now = Date.now()) {
    return this.withWriteLock(async () => {
      // Recheck after acquiring the origin-wide lock; find() outside the lock is only a hint.
      const old = await this.find(sessionId, key, input);
      if (old) return { call: old, created: false };
      const db = this.load(), s = this.session(sessionId, db), amount = atomic(quote.accepted.amount);
      if (s.state !== 'ACTIVE' || now >= s.terms.expiresAt) throw new Error('Session not active');
      if (amount <= 0n || amount > atomic(s.terms.maxPerCall) || s.calls.length >= s.terms.maxCalls) throw new Error('Per-call policy exceeded');
      if (s.calls.reduce((sum, c) => sum + atomic(c.amount), 0n) + amount > atomic(s.terms.maxTotal)) throw new Error('Session budget exceeded');
      const nonce = randomNonce(), paymentId = `${s.terms.network}:${s.terms.asset.toLowerCase()}:${s.terms.payer.toLowerCase()}:${nonce}`;
      if (db.payments[paymentId]) throw new Error('Nonce collision');
      const c = { id: crypto.randomUUID(), sessionId, requestKey: key, requestHash: await digest({ endpoint: s.terms.endpoint, input: inputOf(input, s.provider) }), input, quote, amount: amount.toString(), nonce, createdAt: now, state: 'RESERVED', prepared: null, wire: null, verified: null };
      s.calls.push(c); db.payments[paymentId] = c.id;
      await this.append(s, { kind: 'reserved', callId: c.id, requestKey: key, requestHash: c.requestHash, amount: c.amount, nonce });
      this.save(db); return { call: c, created: true };
    });
  }
  async update(callId, fn) {
    return this.withWriteLock(async () => {
      const db = this.load(), c = this.call(callId, db), s = this.session(c.sessionId, db);
      const event = await fn(c, s, db);
      if (event) await this.append(s, event);
      this.save(db); return c;
    });
  }
  prepared(id, prepared) { return this.update(id, async c => { if (c.state !== 'RESERVED') throw new Error('Already authorized'); c.prepared = prepared; c.state = 'AUTHORIZED'; return { kind: 'authorized', callId: id, paymentHash: await digest(prepared) }; }); }
  submitted(id, now = Date.now()) { return this.update(id, async (c, s) => { if (c.state !== 'AUTHORIZED' || !c.prepared || s.state !== 'ACTIVE' || now >= s.terms.expiresAt) throw new Error('Cannot submit'); c.state = 'SUBMITTED'; return { kind: 'submission_intent', callId: id }; }); }
  capture(id, wire) { return this.update(id, async c => {
    if (!c.prepared || !['SUBMITTED', 'RECONCILIATION_REQUIRED'].includes(c.state)) throw new Error('Call was not submitted');
    if (c.wire) { if (await digest(c.wire) !== await digest(wire)) throw new Error('Conflicting response evidence'); return null; }
    c.wire = wire; return { kind: 'response', callId: id, responseHash: await digest(wire) }; }); }
  unresolved(id) { return this.update(id, async c => { if (c.state === 'VERIFIED' || c.state === 'RECONCILIATION_REQUIRED') return null; c.state = 'RECONCILIATION_REQUIRED'; return { kind: 'reconciliation_required', callId: id }; }); }
  verified(id, proof) { return this.update(id, async (c, s, db) => {
    if (c.state === 'VERIFIED') return null;
    if (!c.wire || !c.prepared) throw new Error('Missing evidence');
    const receiptId = `${s.terms.provider.toLowerCase()}:${proof.receipt.requestId}`;
    if (db.receipts[receiptId] && db.receipts[receiptId] !== id) throw new Error('Provider receipt already used by another call');
    db.receipts[receiptId] = id; c.verified = proof; c.state = 'VERIFIED';
    return { kind: 'verified', callId: id, amount: c.amount, proof }; }); }
  async resume(sessionId, now = Date.now()) {
    return this.withWriteLock(async () => {
      const db = this.load(), s = this.session(sessionId, db);
      if (s.state === 'ACTIVE') return;
      if (now >= s.terms.expiresAt) throw new Error('Session expired');
      if (s.calls.some(c => c.state !== 'VERIFIED')) throw new Error('Unresolved call prevents resume');
      if (s.calls.length >= s.terms.maxCalls) throw new Error('Session call limit reached');
      if (s.calls.reduce((sum, c) => sum + atomic(c.amount), 0n) >= atomic(s.terms.maxTotal)) throw new Error('Session budget exhausted');
      s.state = 'ACTIVE'; await this.append(s, { kind: 'access_resumed', reason: 'continue_after_reconciliation' }); this.save(db);
    });
  }
  async end(sessionId) {
    return this.withWriteLock(async () => {
      const db = this.load(), s = this.session(sessionId, db);
      if (s.state !== 'ACTIVE') return;
      s.state = 'ENDED'; await this.append(s, { kind: 'access_ended' }); this.save(db);
    });
  }
  async export(sessionId) {
    const s = this.session(sessionId), calls = s.calls, sum = list => list.reduce((t, c) => t + atomic(c.amount), 0n).toString();
    return { profile: PROFILE, sessionId, terms: s.terms, termsHash: await digest(s.terms), headHash: s.head, events: s.events.map(e => ({ seq: e.seq, previous: e.previous, head: e.head, event: e.event })),
      summary: { state: s.state === 'ACTIVE' ? 'ACTIVE' : calls.every(c => c.state === 'VERIFIED') ? 'CLOSED' : 'RECONCILIATION_REQUIRED', allocatedTotal: sum(calls), verifiedSpent: sum(calls.filter(c => c.state === 'VERIFIED')), unresolved: calls.filter(c => c.state !== 'VERIFIED').length, calls: calls.length, registryWrites: 0, settlementMode: 'exact-per-call', licenseAcceptance: 'buyer-only' },
      evidence: calls.map(c => ({ callId: c.id, input: c.input, quote: c.quote, nonce: c.nonce, wire: c.wire, verified: c.verified })) };
  }
  /** Permanently deletes a session's local record. Refuses while any call is unresolved. */
  forget(sessionId) {
    return this.withWriteLock(async () => {
      const db = this.load(), s = this.session(sessionId, db);
      if (s.calls.some(c => c.state !== 'VERIFIED')) throw new Error('Refusing to delete a journal with unresolved payments');
      delete db.sessions[sessionId]; this.save(db);
    });
  }
}
/** Same chain rule as the library's verifyChain, for a local self-check. */
export async function verifyChain(archive) {
  try {
    if (archive.profile !== PROFILE || archive.termsHash !== await digest(archive.terms)) return false;
    let head = await digest({ profile: PROFILE, sessionId: archive.sessionId, terms: archive.terms });
    for (const [i, r] of archive.events.entries()) {
      if (r.seq !== i + 1 || r.previous !== head) return false;
      head = await digest({ profile: PROFILE, sessionId: archive.sessionId, seq: r.seq, previous: head, event: r.event });
      if (head !== r.head) return false;
    }
    return head === archive.headHash;
  } catch { return false; }
}

// ---------- wallet (EIP-1193) ----------
export function injectedWallet(ethereum = globalThis.ethereum) {
  if (!ethereum) throw new Error('No EIP-1193 wallet found. Install MetaMask or another injected wallet.');
  let account = null;
  return {
    get address() { return account; },
    async connect() { const [a] = await ethereum.request({ method: 'eth_requestAccounts' }); account = a; return a; },
    async ensureChain(chainId) {
      const want = `0x${chainId.toString(16)}`;
      if ((await ethereum.request({ method: 'eth_chainId' })) === want) return;
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    },
    /** EIP-3009 TransferWithAuthorization via eth_signTypedData_v4. The wallet shows every field before signing. */
    async prepare(quote, terms, nonce, now = Date.now()) {
      if (!account || lower(account) !== lower(terms.payer)) throw new Error('Connected wallet is not the session payer');
      const chainId = chainIdOf(terms.network);
      await this.ensureChain(chainId);
      const seconds = Math.floor(now / 1000);
      const authorization = { from: account, to: quote.accepted.payTo, value: quote.accepted.amount, nonce, validAfter: String(Math.max(0, seconds - 5)), validBefore: String(Math.min(seconds + quote.accepted.maxTimeoutSeconds, Math.floor(terms.expiresAt / 1000))) };
      const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...AUTHORIZATION_TYPES },
        primaryType: 'TransferWithAuthorization', domain: { name: String(quote.accepted.extra.name), version: String(quote.accepted.extra.version), chainId, verifyingContract: terms.asset }, message: authorization };
      const signature = await ethereum.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] });
      if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) throw new Error('Wallet returned an invalid signature');
      return { quote, authorization, signature };
    },
    /** EIP-191 personal_sign over the UTF-8 message, matching the library's recoverMessageAddress. */
    async signMessage(message) {
      const bytes = new TextEncoder().encode(message);
      return ethereum.request({ method: 'personal_sign', params: [`0x${hex(bytes)}`, account] });
    },
  };
}

// ---------- server API ----------
export function serverApi(base = '') {
  async function post(path, body) {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  return {
    meta: async () => (await fetch(`${base}/api/meta`)).json(),
    signer: provider => post('/api/x402/signer', { provider }),
    probe: (provider, terms, input) => post('/api/x402/probe', { provider, terms, input }),
    send: (provider, terms, input, prepared, nonce) => post('/api/x402/send', { provider, terms, input, prepared, nonce }),
    verify: (provider, terms, call, pins, rpcUrl) => post('/api/x402/verify', { provider, terms, call, pins, rpcUrl }),
    verifyArchive: archive => post('/api/archive/verify', { archive }),
  };
}
const wireProvider = p => (p.id === 'x402-doctor' ? { id: p.id } : p);

// ---------- session client (same ordering guarantees as SessionClient in the library) ----------
export class BrowserSessionClient {
  constructor(journal, { api, wallet, pins, rpcUrl, now = Date.now, onStep = () => {} }) { Object.assign(this, { journal, api, wallet, pins, rpcUrl, now, onStep }); }
  async call(sessionId, key, input) {
    const existing = await this.journal.find(sessionId, key, input);
    if (existing) { this.onStep('replay', existing); return existing; } // never re-probe, re-sign or resend
    const s = this.journal.session(sessionId), provider = wireProvider(s.provider), terms = s.terms;
    inputOf(input, s.provider);
    this.onStep('probe');
    const { quote } = await this.api.probe(provider, terms, input);
    const reserved = await this.journal.reserve(sessionId, key, input, quote, this.now());
    if (!reserved.created) return reserved.call;
    const c = reserved.call;
    this.onStep('reserved', c);
    try {
      const prepared = await this.wallet.prepare(quote, terms, c.nonce, this.now());
      if (lower(prepared.authorization.from) !== lower(terms.payer) || prepared.authorization.value !== quote.accepted.amount || prepared.authorization.nonce !== c.nonce) throw new Error('Wallet changed payment parameters');
      await this.journal.prepared(c.id, prepared);
      await this.journal.submitted(c.id, this.now()); // durable commit BEFORE the network side effect
      this.onStep('submitting', c);
      const { wire } = await this.api.send(provider, terms, input, prepared, c.nonce);
      await this.journal.capture(c.id, wire); // commit BEFORE verification
      await this.reconcile(c.id);
    } catch (err) {
      this.onStep('error', c, err);
      await this.journal.unresolved(c.id);
    }
    return this.journal.call(c.id);
  }
  async reconcile(callId, recoveredResponse) {
    let c = this.journal.call(callId);
    if (c.state === 'VERIFIED') return c;
    const s = this.journal.session(c.sessionId);
    try {
      if (recoveredResponse) await this.journal.capture(callId, recoveredResponse);
      c = this.journal.call(callId);
      if (!c.wire || !c.prepared) throw new Error('Original response required; no automatic repayment');
      this.onStep('verifying', c);
      const { verified } = await this.api.verify(wireProvider(s.provider), s.terms, c, this.pins, this.rpcUrl);
      await this.journal.verified(callId, verified);
    } catch (err) { this.onStep('error', c, err); await this.journal.unresolved(callId); }
    return this.journal.call(callId);
  }
}
