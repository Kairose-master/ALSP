import { recoverMessageAddress } from 'viem';
import { Journal, verifyChain } from './journal.js';
import { address, canonical, digest, PROFILE } from './protocol.js';

export interface BuyerSeal {
  manifest: { profile: typeof PROFILE; sessionId: string; archiveSha256: string; headHash: string };
  signer: string;
  signature: `0x${string}`;
}
/** Checks buyer provenance and archive integrity, not service truth or chain finality. */
export async function verifyBuyerSeal(archive: ReturnType<Journal['export']> & { buyerSeal: BuyerSeal }, expectedBuyer: string): Promise<boolean> {
  try {
    const { buyerSeal, ...report } = archive, m = buyerSeal.manifest;
    if (!verifyChain(report) || address(report.terms.payer) !== address(expectedBuyer) || address(buyerSeal.signer) !== address(expectedBuyer)) return false;
    if (m.profile !== PROFILE || m.sessionId !== report.sessionId || m.headHash !== report.headHash || m.archiveSha256 !== digest(report)) return false;
    return address(await recoverMessageAddress({ message: canonical(m), signature: buyerSeal.signature })) === address(expectedBuyer);
  } catch { return false; }
}
