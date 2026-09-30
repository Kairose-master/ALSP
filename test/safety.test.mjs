import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { Journal, PROFILE, NETWORK, ASSET, PAY_TO, DOCTOR, ROUTE, canonical, digest, verifyDoctorReceipt } from '../dist/index.js';
const key = `0x${'11'.repeat(32)}`, buyer = privateKeyToAccount(key);
const seller = privateKeyToAccount(`0x${'22'.repeat(32)}`), authority = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const now = Date.now(), input = { url: `${DOCTOR}/demo/broken`, method: 'GET' };
const terms = { profile: PROFILE, payer: buyer.address, provider: PAY_TO, network: NETWORK, asset: ASSET, endpoint: `${DOCTOR}/api/v1/preflight`, maxTotal: '3000', maxPerCall: '1000', maxCalls: 3, expiresAt: now + 600000, license: { uri: 'urn:synthetic:terms', sha256: createHash('sha256').update('reviewed fixture').digest('hex'), acceptance: 'buyer-only' } };

test('a valid certificate cannot override an explicitly expired pinned key', async () => {
  const valid_from = new Date(now - 86400000).toISOString().slice(0, 10);
  const cert = { service: 'x402-doctor', signer: seller.address, authority: authority.address, valid_from,
    signature: await authority.signMessage({ message: `fizzl receipt signer\nservice: x402-doctor\nsigner: ${seller.address}\nvalid_from: ${valid_from}` }) };
  const nonce = `0x${'44'.repeat(32)}`;
  const receipt = { request_id: 'synthetic', route: ROUTE, input_sha256: digest({ route: ROUTE, input }), signed_at: new Date(now).toISOString(), signer: seller.address, algorithm: 'eip191-canonical-json-v1', cert,
    payment: { network: NETWORK, asset: ASSET, pay_to: authority.address, amount: '1000', payer: buyer.address, nonce, proof: 'eip3009' } };
  const body = { verdict: 'no_go', safe_to_pay: false, summary: 'fixture', recommended_option: null, options: [], reasons: [], signals: {}, receipt };
  body.receipt.signature = await seller.signMessage({ message: canonical(body) });
  const call = { createdAt: now, amount: '1000', input, prepared: { authorization: { nonce } }, wire: { status: 200, body } };
  await assert.rejects(verifyDoctorReceipt(call, { ...terms, provider: authority.address }, [{ address: seller.address, validUntil: new Date(now - 1).toISOString() }], now), /outside validity/);
});
test('rerunning paid CLI with an unfinished journal cannot silently create a fresh session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alsp-cli-')), db = join(dir, 'journal.sqlite'), file = join(dir, 'terms.txt');
  writeFileSync(file, 'reviewed fixture');
  const j = new Journal(db); const id = j.create(terms); j.close();
  const blockNetwork = 'data:text/javascript,globalThis.fetch=()=>{console.error("UNEXPECTED_NETWORK");process.exit(88)}';
  try {
    const result = spawnSync(process.execPath, ['--import', blockNetwork, 'scripts/doctor.mjs', 'paid', '--journal', db, '--max-total', '3000', '--calls', '3', '--terms-file', file], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, ALSP_ENABLE_MAINNET: 'I_ACCEPT_EXACT_PER_CALL_SPEND', ALSP_PRIVATE_KEY: key, ALSP_RECEIPT_SIGNER: seller.address },
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /resumeRequired/); assert.ok(result.stderr.includes(id));
    assert.ok(!result.stderr.includes('UNEXPECTED_NETWORK')); assert.ok(!result.stderr.includes(key));
    const check = new Journal(db); assert.deepEqual(check.unfinishedForPayer(buyer.address), [id]); check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('paid mode without explicit opt-in fails before network or signing', () => {
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>process.exit(88)', 'scripts/doctor.mjs', 'paid'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ALSP_ENABLE_MAINNET: '', ALSP_PRIVATE_KEY: '', ALSP_RECEIPT_SIGNER: seller.address },
  });
  assert.equal(result.status, 1);
});
