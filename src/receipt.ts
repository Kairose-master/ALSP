import { recoverMessageAddress } from 'viem';
import { address, atomic, canonical, digest, hash32, inputOf, object, ROUTE, text, type ReceiptEvidence, type Terms } from './protocol.js';
import type { Call } from './journal.js';

export interface SignerPin { address: string; validFrom?: string; validUntil?: string; }
function timestamp(value: unknown): number {
  const s = text(value), n = Date.parse(s);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== s) throw new Error('Invalid receipt timestamp');
  return n;
}
/** Verifies provenance and request/payment binding, NOT the truth of a verdict. */
export async function verifyDoctorReceipt(call: Call, terms: Terms, pins: SignerPin[], now = Date.now()): Promise<ReceiptEvidence> {
  if (!call.wire || !call.prepared || call.wire.status !== 200) throw new Error('No successful JSON response');
  const body = object(call.wire.body), r = object(body.receipt);
  if (!['go', 'caution', 'no_go'].includes(String(body.verdict)) || typeof body.safe_to_pay !== 'boolean' || typeof body.summary !== 'string' || !Array.isArray(body.options) || !Array.isArray(body.reasons)) throw new Error('Invalid preflight response shape');
  object(body.signals);
  if (body.recommended_option !== null && (!Number.isSafeInteger(body.recommended_option) || Number(body.recommended_option) < 0 || Number(body.recommended_option) >= body.options.length)) throw new Error('Invalid recommended option');
  if (r.algorithm !== 'eip191-canonical-json-v1' || r.route !== ROUTE || r.input_sha256 !== digest({ route: ROUTE, input: inputOf(call.input) })) throw new Error('Wrong algorithm or request binding');
  const signedAt = timestamp(r.signed_at);
  if (signedAt < call.createdAt - 60000 || signedAt > now + 30000) throw new Error('Receipt outside request time window');
  const signature = text(r.signature);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Invalid server signature');
  const unsigned = { ...r }; delete unsigned.signature;
  const signer = address(await recoverMessageAddress({ message: canonical({ ...body, receipt: unsigned }), signature: signature as `0x${string}` }));
  if (signer !== address(r.signer)) throw new Error('Receipt signature mismatch');
  const pinned = pins.some(pin => address(pin.address) === signer && (!pin.validFrom || signedAt >= Date.parse(pin.validFrom)) && (!pin.validUntil || signedAt < Date.parse(pin.validUntil)));
  if (!pinned) {
    // A rotated key must be certified by the separately pinned payout authority.
    const cert = object(r.cert);
    if (cert.service !== 'x402-doctor' || address(cert.signer) !== signer || address(cert.authority) !== address(terms.provider) || !/^\d{4}-\d{2}-\d{2}$/.test(text(cert.valid_from))) throw new Error('Untrusted signing key');
    const validFrom = Date.parse(`${cert.valid_from}T00:00:00.000Z`);
    if (!Number.isFinite(validFrom) || new Date(validFrom).toISOString().slice(0, 10) !== cert.valid_from || signedAt < validFrom) throw new Error('Invalid certificate date');
    const message = `fizzl receipt signer\nservice: ${cert.service}\nsigner: ${cert.signer}\nvalid_from: ${cert.valid_from}`;
    const authority = await recoverMessageAddress({ message, signature: text(cert.signature) as `0x${string}` });
    if (address(authority) !== address(terms.provider)) throw new Error('Invalid signer certificate');
  }
  const p = object(r.payment), a = call.prepared.authorization;
  if (p.proof !== 'eip3009' || p.network !== terms.network || address(p.asset) !== address(terms.asset) || address(p.pay_to) !== address(terms.provider) || address(p.payer) !== address(terms.payer) || atomic(p.amount) !== atomic(call.amount) || hash32(p.nonce) !== a.nonce) throw new Error('Receipt belongs to another payment');
  return { requestId: text(r.request_id), signer, signedAt: text(r.signed_at), responseHash: digest(body) };
}
