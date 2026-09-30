import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { Journal, SessionClient, PROFILE, ASSET, PAY_TO, NETWORK, DOCTOR, canonical, digest, atomic, address, requestUrl, selectQuote, doctorTransport, boundedFetch, evmSigner, verifyDoctorReceipt, baseRpc, verifyBaseSettlement } from '../dist/index.js';

process.umask(0o077);
const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
  'max-total': { type: 'string' }, calls: { type: 'string', default: '3' }, journal: { type: 'string', default: 'data/doctor.sqlite' },
  session: { type: 'string' }, 'call-id': { type: 'string' }, evidence: { type: 'string' }, 'terms-file': { type: 'string' },
  output: { type: 'string', default: 'data/doctor-report.json' },
} });
const mode = positionals[0] ?? 'probe';
const INTEROP_TARGET = 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT';
const input = { url: INTEROP_TARGET, method: 'GET' };
let journal;
async function save(report) {
  const path = resolve(values.output); await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output: path, ...report.summary }, null, 2));
}
try {
  if (!['probe', 'paid', 'reconcile'].includes(mode) || positionals.length > 1) throw new Error('Use probe, paid or reconcile');
  const transport = doctorTransport();
  if (mode === 'probe') {
    // Synthetic buyer/terms used ONLY to validate the public challenge. No signer.
    const terms = { profile: PROFILE, payer: '0x1111111111111111111111111111111111111111', provider: PAY_TO, network: NETWORK, asset: ASSET, endpoint: `${DOCTOR}/api/v1/preflight`, maxTotal: '1000', maxPerCall: '1000', maxCalls: 1, expiresAt: Date.now() + 600000, license: { uri: 'urn:alsp:probe:no-agreement', sha256: digest('probe-only'), acceptance: 'buyer-only' } };
    const challenge = await transport.probe(requestUrl(terms, input));
    const quote = selectQuote(challenge, terms, input);
    const signerDocument = await boundedFetch(`${DOCTOR}/.well-known/x402-doctor-signer.json`);
    if (signerDocument.status !== 200) throw new Error('Signer document unavailable');
    await save({ mode, capturedAt: new Date().toISOString(), quote, signerDocument: signerDocument.body,
      summary: { challengeValidated: true, paidCalls: 0, signaturesCreated: 0, registryWrites: 0, paidInterop: 'not-run' } });
  } else {
    if (!values.journal || !process.env.ALSP_RECEIPT_SIGNER) throw new Error('Set an independently checked ALSP_RECEIPT_SIGNER pin and journal');
    const pins = [{ address: address(process.env.ALSP_RECEIPT_SIGNER) }];
    const rpc = baseRpc(process.env.ALSP_RPC_URL);
    const verify = async (call, terms) => ({ receipt: await verifyDoctorReceipt(call, terms, pins), ledger: await verifyBaseSettlement(call, terms, rpc), semanticCorrectness: 'not-verified' });
    if (mode === 'reconcile') {
      if (!values.session || !values['call-id']) throw new Error('Reconcile requires --session and --call-id');
      journal = new Journal(values.journal);
      if (journal.call(values['call-id']).sessionId !== values.session) throw new Error('Call/session mismatch');
      const noPayments = async () => { throw new Error('Reconciliation cannot create/send a payment'); };
      const client = new SessionClient(journal, { probe: noPayments, prepare: noPayments, send: noPayments, verify });
      await client.reconcile(values['call-id'], values.evidence ? JSON.parse(await readFile(values.evidence, 'utf8')) : undefined);
      await save(journal.export(values.session));
      if (journal.call(values['call-id']).state !== 'VERIFIED') process.exitCode = 2;
    } else {
      if (process.env.ALSP_ENABLE_MAINNET !== 'I_ACCEPT_EXACT_PER_CALL_SPEND' || !process.env.ALSP_PRIVATE_KEY || !values['max-total'] || !values['terms-file']) throw new Error('Paid mode requires explicit mainnet opt-in, private key, --max-total and --terms-file');
      const cap = atomic(values['max-total']), count = Number(values.calls);
      // Keep this first interop runner deliberately tiny; no unbounded test spend.
      if (cap <= 0n || cap > 10000n || !Number.isSafeInteger(count) || count < 1 || count > 10 || BigInt(count) * 1000n > cap) throw new Error('Trial allows 1-10 calls, at most 10000 atomic USDC (0.01 USDC)');
      const licenseBytes = await readFile(values['terms-file']);
      const signer = evmSigner(process.env.ALSP_PRIVATE_KEY);
      journal = new Journal(values.journal);
      const terms = { profile: PROFILE, payer: signer.address, provider: PAY_TO, network: NETWORK, asset: ASSET, endpoint: `${DOCTOR}/api/v1/preflight`, maxTotal: cap.toString(), maxPerCall: '1000', maxCalls: count, expiresAt: Date.now() + 600000, license: { uri: 'urn:alsp:locally-reviewed-terms', sha256: createHash('sha256').update(licenseBytes).digest('hex'), acceptance: 'buyer-only' } };
      let id = values.session;
      if (id) {
        const existing = journal.session(id).terms;
        if (address(existing.payer) !== address(signer.address) || existing.maxTotal !== terms.maxTotal || existing.maxCalls !== count || existing.license.sha256 !== terms.license.sha256) throw new Error('Resume policy differs from journal');
      } else {
        const unfinished = journal.unfinishedForPayer(signer.address);
        if (unfinished.length) {
          console.error(JSON.stringify({ resumeRequired: unfinished }));
          throw new Error('Existing journal session requires resume/reconciliation');
        }
        id = journal.create(terms);
      }
      console.log(JSON.stringify({ sessionId: id, network: NETWORK, payer: signer.address, target: INTEROP_TARGET, userAgent: 'alsp-interop/001', maxTotalAtomic: cap.toString(), note: 'Save this sessionId for --session resume; never delete an unresolved journal.' }));
      const client = new SessionClient(journal, { ...transport, prepare: signer.prepare, verify });
      for (let i = 0; i < count; i++) {
        const call = await client.call(id, `preflight-${i + 1}`, input);
        console.log(JSON.stringify({ callId: call.id, state: call.state }));
        if (call.state !== 'VERIFIED') { process.exitCode = 2; break; }
      }
      journal.end(id);
      const report = journal.export(id);
      // A buyer signature seals this local observation, not provider assent.
      const manifest = { profile: PROFILE, sessionId: id, archiveSha256: digest(report), headHash: report.headHash };
      await save({ ...report, buyerSeal: { manifest, signer: signer.address, signature: await signer.signManifest(canonical(manifest)) } });
    }
  }
} catch (err) {
  // Only our stable message, never a raw SDK error object / request headers.
  console.error(mode === 'probe' ? `Probe failed: ${err instanceof Error ? err.message : 'unknown error'}` : 'Interop stopped. Check flags, signer pin and journal; do not retry with a fresh session while a payment is unresolved.');
  process.exitCode = 1;
} finally { journal?.close(); }
