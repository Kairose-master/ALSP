// XRPL testnet-only resource advertisement. Does not accept or settle payments yet.
// This intentionally cannot grant access on receipt of an unverified payment header.
import { createHash, randomUUID } from 'node:crypto';

export const XRPL_PAY_TO = 'rMRaxFZnyNHmqfafLbAdGbi9cHi24UhiaG';
export const XRPL_RESOURCE = '/api/xrpl/paid-resource';
export function xrplChallenge(origin) {
  const invoiceId = createHash('sha256').update('ALSP-XRPL-TESTNET-CHALLENGE-V1:' + randomUUID()).digest('hex').toUpperCase();
  return {
    x402Version: 2,
    error: 'Payment required; paid access is not enabled until settlement verification is deployed',
    resource: { url: origin + XRPL_RESOURCE, description: 'ALSP XRPL session evidence demonstration', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'xrpl:1',
      asset: 'XRP',
      amount: '1000',
      payTo: XRPL_PAY_TO,
      maxTimeoutSeconds: 600,
      extra: { invoiceId, sourceTag: 804681468 }
    }]
  };
}
export function xrplDirectoryMetadata(origin, live = false) {
  if (live) return {
    name: 'ALSP XRPL session evidence',
    description: 'Pay in XRP (x402 exact via t54) and receive a ledger-verified, payment-bound ALSP session evidence record as JSON.',
    resources: [{ url: origin + XRPL_RESOURCE, name: 'ALSP XRPL session evidence', description: 'Payment-bound, ledger-verified JSON evidence record (price set in the 402 challenge).' }]
  };
  return {
    name: 'ALSP XRPL testnet research endpoint',
    description: 'Experimental XRPL x402 challenge; settlement and paid fulfillment are not yet live.',
    resources: [{ url: origin + XRPL_RESOURCE, name: 'ALSP XRPL session evidence', description: 'Experimental testnet payment challenge (not a live paid API)' }]
  };
}
