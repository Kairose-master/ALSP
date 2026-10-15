import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Wallet } from 'xrpl';
import { decode } from 'ripple-binary-codec';
import { PgXrplStore } from '../dist/integrations/xrpl-pg-store.js';
import { XrplMerchant, checkSignedBlob, transactionHashOfBlob } from '../dist/integrations/xrpl-merchant.js';
import { T54Facilitator, xrplInvoiceField } from '../dist/integrations/t54-facilitator.js';

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : 'TEST_DATABASE_URL not set';
const ORIGIN = 'https://example.test';
const buyer = Wallet.generate();
const headerOf = (accepted, blob) => Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signedTxBlob: blob } })).toString('base64');
function sign(req, over = {}) {
  const tx = { TransactionType: 'Payment', Account: buyer.address, Destination: req.payTo, Amount: req.amount, Fee: '12', Sequence: 1,
    LastLedgerSequence: 99999999, SourceTag: req.extra.sourceTag, InvoiceID: xrplInvoiceField(req.extra.invoiceId), ...over };
  return buyer.sign(tx).tx_blob;
}
function world({ settleBehavior = 'ok', ledger = 'ok' } = {}) {
  const calls = { verify: 0, settle: 0, ledger: 0 };
  const state = { settleBehavior, ledger };
  const facFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/verify')) { calls.verify++; return Response.json({ isValid: true, payer: buyer.address }); }
    calls.settle++;
    if (state.settleBehavior === 'timeout') throw new Error('timeout');
    const hash = transactionHashOfBlob(body.paymentPayload.payload.signedTxBlob);
    return Response.json({ success: true, transaction: hash, network: 'xrpl:1' });
  };
  const ledgerFetch = async (_u, init) => {
    calls.ledger++;
    if (state.ledger !== 'ok') return Response.json({ result: { status: 'error', error: 'txnNotFound' } });
    const hash = JSON.parse(init.body).params[0].transaction;
    const tx = state.txs.get(hash);
    return Response.json({ result: { status: 'success', validated: true, hash, ledger_index: 123, tx_json: tx, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: tx.Amount } } });
  };
  state.txs = new Map();
  return { calls, state, facFetch, ledgerFetch };
}
function merchant(pool, w, extra = {}) {
  return new XrplMerchant({ store: new PgXrplStore(pool), facilitator: new T54Facilitator('xrpl:1', w.facFetch), ledgerFetch: w.ledgerFetch,
    sleep: async () => {}, reconcileAttempts: 2, ...extra });
}
async function setup() {
  const pool = new pg.Pool({ connectionString: URL, max: 8 });
  await pool.query('DROP TABLE IF EXISTS xrpl_invoices');
  await new PgXrplStore(pool).migrate();
  return pool;
}
const prepare = async (m, w, over) => {
  const ch = await m.challenge(ORIGIN);
  const req = ch.body.accepts[0];
  const blob = sign(req, over);
  w.state.txs.set(transactionHashOfBlob(blob), decode(blob));
  return { ch, req, blob, hash: transactionHashOfBlob(blob) };
};

test('hash and blob checks bind payment to the issued requirement', { skip }, async () => {
  const pool = await setup(); const w = world(); const m = merchant(pool, w);
  const { req, blob, hash } = await prepare(m, w);
  assert.equal(checkSignedBlob(blob, req).hash, hash);
  assert.throws(() => checkSignedBlob(sign(req, { Amount: '999' }), req), /requirement/);
  assert.throws(() => checkSignedBlob(sign(req, { InvoiceID: 'AA'.repeat(32) }), req), /InvoiceID/);
  assert.throws(() => checkSignedBlob(sign(req, { SourceTag: 1 }), req), /SourceTag/);
  await pool.end();
});

test('paid flow: 402 -> verify -> settle once -> ledger proof -> 200, idempotent resubmission', { skip }, async () => {
  const pool = await setup(); const w = world(); const m = merchant(pool, w);
  const { ch, req, blob, hash } = await prepare(m, w);
  assert.equal(ch.status, 402);
  const header = headerOf(req, blob);
  const r = await m.handle(ORIGIN, header);
  assert.equal(r.status, 200);
  assert.equal(r.body.payment.transaction, hash);
  assert.equal(r.body.type, 'alsp.xrpl.session-evidence/v1');
  assert.match(r.body.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.parse(Buffer.from(r.headers['PAYMENT-RESPONSE'], 'base64').toString()).transaction, hash);
  const again = await m.handle(ORIGIN, header);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, r.body);
  assert.equal(w.calls.settle, 1);
  const stored = await pool.query('SELECT * FROM xrpl_invoices WHERE invoice_id=$1', [req.extra.invoiceId]);
  assert.equal(stored.rows[0].state, 'VERIFIED');
  assert.equal(JSON.stringify(stored.rows[0]).includes(blob), false);
  await pool.end();
});

test('concurrent identical submissions settle exactly once across instances', { skip }, async () => {
  const pool = await setup(); const w = world();
  const ms = [merchant(pool, w), merchant(pool, w), merchant(pool, w), merchant(pool, w)];
  const { req, blob } = await prepare(ms[0], w);
  const header = headerOf(req, blob);
  const rs = await Promise.all(ms.map(m => m.handle(ORIGIN, header)));
  assert.equal(w.calls.settle, 1);
  assert.ok(rs.every(r => r.status === 200 || r.status === 202));
  assert.ok(rs.some(r => r.status === 200));
  assert.equal((await ms[0].handle(ORIGIN, header)).status, 200);
  assert.equal(w.calls.settle, 1);
  await pool.end();
});

test('a different payment for a paid invoice and a mismatched requirement are rejected', { skip }, async () => {
  const pool = await setup(); const w = world(); const m = merchant(pool, w);
  const a = await prepare(m, w);
  assert.equal((await m.handle(ORIGIN, headerOf(a.req, a.blob))).status, 200);
  const other = sign(a.req, { Sequence: 2 });
  w.state.txs.set(transactionHashOfBlob(other), decode(other));
  assert.equal((await m.handle(ORIGIN, headerOf(a.req, other))).status, 409);
  const b = await prepare(m, w);
  // replay invoice A's blob against invoice B's requirement
  assert.equal((await m.handle(ORIGIN, headerOf(b.req, a.blob))).status, 400);
  assert.equal((await m.handle(ORIGIN, headerOf({ ...b.req, amount: '1' }, b.blob))).status, 400);
  assert.equal((await m.handle(ORIGIN, 'not-base64-json')).status, 400);
  assert.equal(w.calls.settle, 1);
  await pool.end();
});

test('settle timeout is never retried; recovery is read-only and survives a restart', { skip }, async () => {
  const pool = await setup(); const w = world({ settleBehavior: 'timeout', ledger: 'missing' });
  const m1 = merchant(pool, w);
  const { req, blob, hash } = await prepare(m1, w);
  const header = headerOf(req, blob);
  const r1 = await m1.handle(ORIGIN, header);
  assert.equal(r1.status, 202);
  assert.equal(w.calls.settle, 1);
  assert.equal((await pool.query('SELECT state FROM xrpl_invoices WHERE invoice_id=$1', [req.extra.invoiceId])).rows[0].state, 'RECONCILIATION_REQUIRED');
  // "restart": brand-new merchant/store/pool; the ledger now shows the payment as validated
  const pool2 = new pg.Pool({ connectionString: URL, max: 2 });
  w.state.ledger = 'ok';
  const m2 = merchant(pool2, w);
  const pending = await new PgXrplStore(pool2).pendingAttempts();
  assert.deepEqual(pending.map(p => p.transactionHash), [hash]);
  const r2 = await m2.handle(ORIGIN, header);
  assert.equal(r2.status, 200);
  assert.equal(w.calls.settle, 1, 'must never re-call /settle');
  await pool.end(); await pool2.end();
});

test('expired challenges cannot be paid and unknown invoices get a fresh 402', { skip }, async () => {
  const pool = await setup(); const w = world(); let t = Date.now();
  const m = merchant(pool, w, { now: () => new Date(t) });
  const { req, blob } = await prepare(m, w);
  t += 601_000;
  const r = await m.handle(ORIGIN, headerOf(req, blob));
  assert.equal(r.status, 402);
  assert.equal(w.calls.settle, 0);
  const forged = { ...req, extra: { ...req.extra, invoiceId: 'AB'.repeat(32) } };
  assert.equal((await m.handle(ORIGIN, headerOf(forged, sign(forged)))).status, 402);
  await pool.end();
});
