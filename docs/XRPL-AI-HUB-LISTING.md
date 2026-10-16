# XRPL AI Hub listing readiness (PR #20)

Target: https://xrpl-ai.org/join/service

The registration form accepts an origin URL (auto-discovers `/.well-known/x402`) or a direct endpoint URL, then validates HTTP 402 and XRPL payment requirements. It is **not** a code-repository submission.

## Release gates

- [ ] Deploy a publicly reachable, stable **merchant/resource** endpoint, not the buyer-side ALSP client or t54 facilitator URL.
- [ ] Unpaid request returns HTTP 402 with a syntactically valid `PAYMENT-REQUIRED` header using the registry's accepted XRPL network identifier; verify the exact on-wire shape against the live validator.
- [ ] `/.well-known/x402` advertises the same real resource with `name` and `description` (currently only `/api/xrpl/directory` exists; this gate is NOT met).
- [ ] Merchant owns/controls the `payTo` destination and has explicitly approved the testnet/mainnet network and pricing. Do not substitute a facilitator address as the payee.
- [ ] An authorized payment can be verified, settled and reconciled on the target network; a replay cannot grant service twice.
- [ ] Session budget enforcement is connected to the actual merchant flow; XRPL journal alone is not the ALSP x402 Exact session journal.
- [ ] Verify the deployed URL independently with `curl -i`, and only then submit the URL at the registration form.

## Current state

PR #20 includes an XRPL testnet facilitator transport, ledger evidence verifier, SQLite settlement journal and reconciliation helpers. They are **not** an independently deployed, end-to-end paid XRPL resource. The `/settle` client intentionally requires explicit testnet opt-in and blocks mainnet. Do not represent this PR as a live registered service.

Registration is a separate external action and should be performed only after the live endpoint meets the above checks. If no live endpoint exists, the registration page provides a manual directory-listing path via support@t54.ai.

Source: https://xrpl-ai.org/join/service

## Deployment architecture blocker (verified 2026-10-15)

The Vercel entrypoint `api/index.js` currently returns HTTP 501 whenever a payment header is present. This is intentional fail-closed behavior, not a working merchant. The SQLite journal in `src/integrations/xrpl-sqlite-journal.ts` is a single-host durable implementation and cannot provide cross-instance transaction serialization or persistent state on ephemeral Vercel functions. Do **not** wire it directly to the serverless endpoint.

To enable a merchant safely, provision a shared transactional store and enforce unique payment transaction hashes plus unique call IDs in the **same durable transaction** before any facilitator settlement. Persist the exact challenge requirements and payment binding across requests, reject expired/unrecognized invoices, and return content only after independent validated-ledger proof. On ambiguous settlement outcomes, retain unresolved state and reconcile read-only without retrying /settle. Verify real funded testnet end-to-end behavior before registration; CI and preview READY are insufficient. No production/mainnet promotion is authorized by this document.

## Status update (2026-10-15, after merchant implementation)

Implemented in PR #20: PostgreSQL store (`xrpl-pg-store.ts`), merchant flow (`xrpl-merchant.ts`), live mode in `api/index.js` enabled **only** when `DATABASE_URL`/`POSTGRES_URL` (or `XRPL_DATABASE_URL`) is set; otherwise the endpoint stays fail-closed and non-live.

Verified: 101 tests including real-Postgres concurrency, replay, timeout/restart recovery and expiry; **real testnet E2E** through a local harness (real t54 `/verify` + `/settle`, real XRPL testnet ledger) returning HTTP 200 with a ledger-verified evidence record, idempotent on resubmission and settled exactly once.

Findings from the real E2E (not caught by mocks): t54 requires `payload.invoiceId` (raw requirement value) next to `signedTxBlob`; some servers omit `meta.delivered_amount`; the payee account must exist on testnet (it was activated via the public faucet; a 1000-drop payment cannot create it, `tecNO_DST_INSUF_XRP`).

Remaining gates (external): provision PostgreSQL on the Vercel project and set `DATABASE_URL`; run `scripts/xrpl-e2e-buyer.mjs` against the deployed URL; `curl -i` the public URL and `/.well-known/x402`; then submit at the registration form.
