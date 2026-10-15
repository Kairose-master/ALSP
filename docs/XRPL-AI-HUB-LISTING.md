# XRPL AI Hub listing readiness (PR #20)

Target: https://xrpl-ai.org/join/service

The registration form accepts an origin URL (auto-discovers `/.well-known/x402`) or a direct endpoint URL, then validates HTTP 402 and XRPL payment requirements. It is **not** a code-repository submission.

## Release gates

- [ ] Deploy a publicly reachable, stable **merchant/resource** endpoint, not the buyer-side ALSP client or t54 facilitator URL.
- [ ] Unpaid request returns HTTP 402 with a syntactically valid `PAYMENT-REQUIRED` header using the registry's accepted XRPL network identifier; verify the exact on-wire shape against the live validator.
- [ ] `/.well-known/x402` advertises the same real resource with `name` and `description`.
- [ ] Merchant owns/controls the `payTo` destination and has explicitly approved the testnet/mainnet network and pricing. Do not substitute a facilitator address as the payee.
- [ ] An authorized payment can be verified, settled and reconciled on the target network; a replay cannot grant service twice.
- [ ] Session budget enforcement is connected to the actual merchant flow; XRPL journal alone is not the ALSP x402 Exact session journal.
- [ ] Verify the deployed URL independently with `curl -i`, and only then submit the URL at the registration form.

## Current state

PR #20 includes an XRPL testnet facilitator transport, ledger evidence verifier, SQLite settlement journal and reconciliation helpers. They are **not** an independently deployed, end-to-end paid XRPL resource. The `/settle` client intentionally requires explicit testnet opt-in and blocks mainnet. Do not represent this PR as a live registered service.

Registration is a separate external action and should be performed only after the live endpoint meets the above checks. If no live endpoint exists, the registration page provides a manual directory-listing path via support@t54.ai.

Source: https://xrpl-ai.org/join/service
