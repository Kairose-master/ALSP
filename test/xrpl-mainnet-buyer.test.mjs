import test from 'node:test';
import assert from 'node:assert/strict';
import { submitPaymentUntilSettled } from '../scripts/xrpl-mainnet-buyer.mjs';

function response(status, value) {
  return { status, async json() { return value; } };
}

test('eight pending responses fail closed and every retry reuses the same signed payment', async () => {
  const headers = [];
  const sleeps = [];
  let calls = 0;

  await assert.rejects(
    submitPaymentUntilSettled({
      url: 'https://merchant.invalid/resource',
      header: 'same-signed-payment',
      maxAttempts: 8,
      retryDelayMs: 5000,
      fetchImpl: async (_url, options) => {
        calls++;
        headers.push(options.headers['payment-signature']);
        return response(202, { status: 'pending' });
      },
      sleepImpl: async ms => sleeps.push(ms),
    }),
    error => {
      assert.match(error.message, /unconfirmed after 8 HTTP 202 responses/);
      assert.match(error.message, /Do not create or submit a new payment/);
      return true;
    },
  );

  assert.equal(calls, 8);
  assert.deepEqual(headers, Array(8).fill('same-signed-payment'));
  assert.deepEqual(sleeps, Array(7).fill(5000));
});

test('an inconsistent idempotency replay after HTTP 200 fails closed', async () => {
  const headers = [];
  const replies = [response(200, { receipt: 'confirmed' }), response(200, { receipt: 'different' })];

  await assert.rejects(
    submitPaymentUntilSettled({
      url: 'https://merchant.invalid/resource',
      header: 'same-signed-payment',
      fetchImpl: async (_url, options) => {
        headers.push(options.headers['payment-signature']);
        return replies.shift();
      },
    }),
    error => {
      assert.match(error.message, /Payment was accepted, but the idempotency replay differed/);
      assert.match(error.message, /Do not submit a new payment/);
      return true;
    },
  );

  assert.deepEqual(headers, ['same-signed-payment', 'same-signed-payment']);
});

test('a matching idempotency replay confirms settlement independent of JSON key order', async () => {
  const replies = [response(200, { receipt: 'confirmed', details: { a: 1, b: 2 } }), response(200, { details: { b: 2, a: 1 }, receipt: 'confirmed' })];

  const body = await submitPaymentUntilSettled({
    url: 'https://merchant.invalid/resource',
    header: 'same-signed-payment',
    fetchImpl: async () => replies.shift(),
  });

  assert.deepEqual(body, { receipt: 'confirmed', details: { a: 1, b: 2 } });
});
