import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.js';
import { XRPL_PAY_TO } from '../api/xrpl-directory.js';

async function request(path, headers = {}, method = 'GET') {
  const response = { headers: {}, statusCode: 0, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = JSON.parse(value); return this; }
  };
  const req = { method, url: path, headers, async *[Symbol.asyncIterator]() {} };
  await handler(req, response);
  return response;
}

test('unpaid XRPL resource emits testnet x402 402 header', async () => {
  const r = await request('/api/xrpl/paid-resource');
  assert.equal(r.statusCode, 402);
  assert.equal(r.body.accepts[0].payTo, XRPL_PAY_TO);
  assert.equal(r.body.accepts[0].network, 'xrpl:1');
  assert.equal(r.body.accepts[0].amount, '1000');
  assert.match(r.body.accepts[0].extra.invoiceId, /^[0-9A-F]{64}$/);
  assert.deepEqual(JSON.parse(Buffer.from(r.headers['payment-required'], 'base64').toString()), r.body);
});

test('paid requests fail closed rather than granting access', async () => {
  const r = await request('/api/xrpl/paid-resource', { 'payment-signature': 'bogus' });
  assert.equal(r.statusCode, 501);
  assert.match(r.body.error, /not yet implemented/);
});

test('directory is discoverable and discloses no live settlement', async () => {
  const r = await request('/api/xrpl/directory');
  assert.equal(r.statusCode, 200);
  assert.match(r.body.description, /not yet live/);
});

test('well-known XRPL discovery remains explicitly experimental', async () => {
  const r = await request('/.well-known/x402');
  assert.equal(r.statusCode, 200);
  assert.match(r.body.description, /not yet live/);
  assert.equal(r.body.resources[0].url, 'https://alsp.vercel.app/api/xrpl/paid-resource');
});
