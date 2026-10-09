import { recoverMessageAddress } from 'viem';
import { address, canonical, digest, PRICE_AGREEMENT_PROFILE, validateAgreementTime, validatePriceAgreementTerms, type PriceAgreementTerms, type SignedPriceAgreement } from './protocol.js';

/** Human-reviewable, role-separated EIP-191 messages. Never a token authorization. */
export function providerOfferMessage(terms: PriceAgreementTerms): string {
  validatePriceAgreementTerms(terms);
  return canonical({ domain: PRICE_AGREEMENT_PROFILE, role: 'provider-offer', terms });
}
export function buyerAcceptanceMessage(offer: Pick<SignedPriceAgreement, 'terms' | 'providerSignature'>): string {
  validatePriceAgreementTerms(offer.terms);
  return canonical({ domain: PRICE_AGREEMENT_PROFILE, role: 'buyer-acceptance', terms: offer.terms, providerOfferHash: digest({ terms: offer.terms, providerSignature: offer.providerSignature }) });
}
/** Checks both EOA signatures and the validity window; identity pins are checked by validateTerms. */
export async function verifyPriceAgreement(value: SignedPriceAgreement, now = Date.now()): Promise<void> {
  const agreement = JSON.parse(canonical(value)) as SignedPriceAgreement;
  validatePriceAgreementTerms(agreement.terms);
  validateAgreementTime(agreement, now);
  for (const signature of [agreement.providerSignature, agreement.buyerSignature]) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Invalid agreement signature');
  }
  const provider = await recoverMessageAddress({ message: providerOfferMessage(agreement.terms), signature: agreement.providerSignature });
  const offer = { terms: agreement.terms, providerSignature: agreement.providerSignature };
  const buyer = await recoverMessageAddress({ message: buyerAcceptanceMessage(offer), signature: agreement.buyerSignature });
  if (address(provider) !== address(agreement.terms.provider) || address(buyer) !== address(agreement.terms.buyer)) throw new Error('Invalid bilateral price agreement signatures');
}
