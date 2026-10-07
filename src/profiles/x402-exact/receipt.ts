import { recoverMessageAddress } from 'viem';
import { address, atomic, canonical, digest, DOCTOR_PROVIDER, hash32, inputOf, object, text, type ProviderProfile, type ReceiptEvidence, type Terms } from './protocol.js';
import type { Call } from './journal.js';

export interface SignerPin { address: string; validFrom?: string; validUntil?: string; }
function timestamp(value: unknown): number {
  const s = text(value), n = Date.parse(s);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== s) throw new Error('Invalid receipt timestamp');
  return n;
}
/**
 * Verifies provenance and request/payment binding of an `eip191-canonical-json-v1` receipt, NOT the truth of the response.
 * The receipt format is the one Doctor documents; any provider that emits it can be verified with its own profile.
 */
export async function verifyReceipt(call: Call, terms: Terms, pins: SignerPin[], p: ProviderProfile = DOCTOR_PROVIDER, now = Date.now()): Promise<ReceiptEvidence> {
  if (!call.wire || !call.prepared || call.wire.status !== 200) throw new Error('No successful JSON response');
  const body = object(call.wire.body), r = object(body.receipt);
  p.validateBody?.(body);
  if (r.algorithm !== 'eip191-canonical-json-v1' || r.route !== p.receipt.route || r.input_sha256 !== digest({ route: p.receipt.route, input: inputOf(call.input, p) })) throw new Error('Wrong algorithm or request binding');
  const signedAt = timestamp(r.signed_at);
  if (signedAt < call.createdAt - 60000 || signedAt > now + 30000) throw new Error('Receipt outside request time window');
  const signature = text(r.signature);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Invalid server signature');
  const unsigned = { ...r }; delete unsigned.signature;
  const signer = address(await recoverMessageAddress({ message: canonical({ ...body, receipt: unsigned }), signature: signature as `0x${string}` }));
  if (signer !== address(r.signer)) throw new Error('Receipt signature mismatch');
  const matchingPins = pins.filter(pin => address(pin.address) === signer);
  const pinned = matchingPins.some(pin => (!pin.validFrom || signedAt >= Date.parse(pin.validFrom)) && (!pin.validUntil || signedAt < Date.parse(pin.validUntil)));
  // A certificate must not override an explicit validity restriction on this key.
  if (matchingPins.length && !pinned) throw new Error('Pinned signer outside validity window');
  if (!pinned) {
    // A rotated key must be certified by the separately pinned payout authority.
    const cert = object(r.cert);
    if (cert.service !== p.receipt.service || address(cert.signer) !== signer || address(cert.authority) !== address(terms.provider) || !/^\d{4}-\d{2}-\d{2}$/.test(text(cert.valid_from))) throw new Error('Untrusted signing key');
    const validFrom = Date.parse(`${cert.valid_from}T00:00:00.000Z`);
    if (!Number.isFinite(validFrom) || new Date(validFrom).toISOString().slice(0, 10) !== cert.valid_from || signedAt < validFrom) throw new Error('Invalid certificate date');
    const message = `${p.receipt.certHeader}\nservice: ${cert.service}\nsigner: ${cert.signer}\nvalid_from: ${cert.valid_from}`;
    const authority = await recoverMessageAddress({ message, signature: text(cert.signature) as `0x${string}` });
    if (address(authority) !== address(terms.provider)) throw new Error('Invalid signer certificate');
  }
  const pay = object(r.payment), a = call.prepared.authorization;
  if (pay.proof !== 'eip3009' || pay.network !== terms.network || address(pay.asset) !== address(terms.asset) || address(pay.pay_to) !== address(terms.provider) || address(pay.payer) !== address(terms.payer) || atomic(pay.amount) !== atomic(call.amount) || hash32(pay.nonce) !== a.nonce) throw new Error('Receipt belongs to another payment');
  return { requestId: text(r.request_id), signer, signedAt: text(r.signed_at), responseHash: digest(body) };
}
/** Backward-compatible verifier bound to the pinned Doctor profile. */
export const verifyDoctorReceipt = (call: Call, terms: Terms, pins: SignerPin[], now = Date.now()) => verifyReceipt(call, terms, pins, DOCTOR_PROVIDER, now);
