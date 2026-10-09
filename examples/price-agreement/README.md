# Buyer-specific signed price agreement (offline demo)

This opt-in **experimental Node profile** adds one missing distinction: the provider and buyer both sign the same fixed-price agreement before three independent x402 `exact` purchases. A private spending cap alone does not establish a negotiated price.

```sh
npm ci --ignore-scripts
npm run demo:price-agreement
```

Node 22.16+ is required. The example uses public throwaway keys, an in-process provider and a **mock ledger only**. It performs no network requests, real payments, deployments or wallet prompts. Never fund these fixture addresses. The archive contains signed agreement/receipt evidence and unsigned authorization fields, but no private keys or payment bearer signatures.

## What the run demonstrates

- A provider-signed offer and buyer-signed acceptance bind the agreement ID, both EOAs, endpoint/method, network/asset, terms version/hash, fixed unit price, total/call allowance and validity window.
- The mock provider verifies and registers that bilateral agreement. The buyer presents it with each request using the local `alsp-price-agreement` header.
- Public prices change from 1,000 to 1,500 to 2,000 atomic units. This buyer still pays **600 per call**, three times, using different EIP-3009 nonces and mock settlement transaction IDs.
- The general per-call cap is higher than the agreed price. A quote for another price fails even if it is below that cap. The quote and signed receipt must carry the same agreement ID/hash.
- Wrong buyers, tampered terms, expired agreements, allowance exhaustion and wrong-price quotes fail closed. No automatic fallback silently pays the public price.
- A buyer-sealed archive is independently checked for both agreement signatures, pinned provider receipt signatures, exact per-call links, transitions, counts and amounts. Historical verification works after expiry. It reports `mock-settled`, never proof of on-chain settlement.

See `test/price-agreement.test.mjs` for adversarial checks, including archives that an attacker re-seals with the genuine buyer fixture key after changing their contents.

## Interface and evidence boundaries

`Terms.priceAgreement` is optional. Existing Doctor, browser and buyer-only calls retain their current APIs and behavior; the browser UI does not negotiate or enforce this experimental agreement. The new Node path requires `license.acceptance: 'bilateral'`, a matching terms-document hash, signed receipts and an explicitly pinned provider profile. Each party signs a role-separated EIP-191 canonical JSON message; buyer acceptance also commits to the exact provider offer. Canonicalization is the repository's existing ASCII / sorted UTF-16 JSON, **not RFC 8785**. EOAs only; no smart-account signature support is implied.

The provider's in-memory registry accounts across sessions by agreement identity and rejects conflicting reuse. The SQLite journal also counts all reservations for that agreement across its own sessions, including unresolved calls. Neither is a production durable/distributed provider ledger. Restarting the mock provider resets its registry. A separate journal cannot prove global allowance consumption; the provider must enforce that itself. An archive proves only the included records, not all purchases ever made under the agreement.

`verifyPriceAgreementArchive` requires an expected buyer, provider profile and receipt signer pins supplied by the verifier. It checks archived signatures and linkage, not semantic answer quality, legal enforceability, upstream interoperability or payment finality. Payment signatures are deliberately not exported; the verifier does not reconstruct or verify them. Stored `rpc-confirmed` metadata alone is not fresh independent RPC verification. The mock evidence is permanently labeled as such.

## Relationship to upstream x402

[x402 PR #935](https://github.com/coinbase/x402/pull/935) provides adjacent optional signed-offer and signed-receipt concepts. This demo reuses the repository's existing signed-response mechanism and keeps ordinary per-call `exact` authorizations. Its role-separated bilateral envelope, local header and `extra.alspAgreement` / `receipt.agreement` links are **ALSP experimental fields**, not an implementation of the upstream `offer-receipt` wire format. No new settlement scheme, facilitator behavior, registry, escrow or standards adoption is claimed.

The unchanged live Doctor service has not signed this demo agreement. Local bilateral signature tests do not establish external provider assent, provider demand or a new paid interoperability run.
