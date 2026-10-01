import { recoverMessageAddress } from 'viem';
import { address, canonical, digest, text, type Terms } from './protocol.js';

export interface BilateralSessionAgreement {
  profile: 'alsp-session-agreement-v0.3';
  sessionId: string;
  termsHash: string;
  scope: string;
  maxCalls: number;
  expiry: number;
  pricingPolicy: { mode: 'exact-per-call'; network: string; asset: string; payTo: string; maxPerCall: string; maxTotal: string };
  provider: string;
  signature: string;
}
export type AgreementPayload = Omit<BilateralSessionAgreement, 'signature'>;
export function agreementPayload(sessionId: string, terms: Terms, pricingPolicy: BilateralSessionAgreement['pricingPolicy']): AgreementPayload {
  return { profile: 'alsp-session-agreement-v0.3', sessionId: text(sessionId), termsHash: digest(terms), scope: terms.endpoint,
    maxCalls: terms.maxCalls, expiry: terms.expiresAt, pricingPolicy: { ...pricingPolicy }, provider: address(terms.provider) };
}
async function verifyAgreement(agreement: BilateralSessionAgreement, terms: Terms, expectedSessionId: string): Promise<boolean> {
  if (agreement.profile !== 'alsp-session-agreement-v0.3' || agreement.sessionId !== expectedSessionId || agreement.termsHash !== digest(terms)
    || agreement.scope !== terms.endpoint || agreement.maxCalls !== terms.maxCalls || agreement.expiry !== terms.expiresAt
    || address(agreement.provider) !== address(terms.provider) || agreement.pricingPolicy.mode !== 'exact-per-call'
    || agreement.pricingPolicy.network !== terms.network || address(agreement.pricingPolicy.asset) !== address(terms.asset)
    || address(agreement.pricingPolicy.payTo) !== address(terms.provider) || agreement.pricingPolicy.maxPerCall !== terms.maxPerCall
    || agreement.pricingPolicy.maxTotal !== terms.maxTotal) return false;
  const { signature, ...payload } = agreement;
  try {
    const signer = await recoverMessageAddress({ message: canonical(payload), signature: text(signature) as `0x${string}` });
    return address(signer) === address(terms.provider);
  } catch { return false; }
}
export async function verifyProviderAgreement(agreement: BilateralSessionAgreement, terms: Terms, expectedSessionId: string): Promise<boolean> {
  try { return await verifyAgreement(agreement, terms, expectedSessionId); } catch { return false; }
}
