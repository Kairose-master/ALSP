# ALSP exact-session v0.2: compatibility profile

## Scope

A TypeScript / Node 22 client wraps the **existing** Doctor HTTP x402 v2 `exact` / Base USDC / EIP-3009 flow. Payment formation follows the published wire format using viem for EIP-712 signing; it is not a new facilitator or a claim of compatibility with every x402 scheme/extension. Permit2, smart accounts, v1, Solana and batch settlement are rejected, not silently emulated.

The first milestone is deliberately narrower than authorize-max → settle-actual. No deposit or registry is needed to start the local session, and every paid call still settles separately. It tests session accounting and evidence interoperability without requiring changes to Doctor.

## Agreement / trust model

Terms are immutable JSON with a digest of locally reviewed license bytes, payer, provider, endpoint, network/asset, call count, expiry and two atomic budgets. Acceptance is **buyer-only**. The unchanged Doctor service signs the request and payment metadata, NOT these ALSP terms. A hash is neither legal enforceability nor mutual agreement.

The client pins Doctor's payout and Base USDC addresses. Receipt verification requires an independently configured signing-key pin, or a signing-key certificate verified against the payout authority. Pin validity bounds and certificate start dates are checked. The paid CLI requires an explicit signer pin; the free metadata probe does not silently establish trust.

A provider response claiming `no_go` about an intentionally broken target can be a correctly delivered preflight service. Validation of its JSON/signature is not validation of its factual verdict; all verified records retain `semanticCorrectness: not-verified`.

## States and failure semantics

```text
session: ACTIVE -> ENDED -> exported CLOSED or RECONCILIATION_REQUIRED
call: RESERVED -> AUTHORIZED -> SUBMITTED -> VERIFIED
                      any ambiguous failure -> RECONCILIATION_REQUIRED
                                              -> VERIFIED after evidence reconciliation
```

`SUBMITTED` records durable submission *intent*: a crash immediately afterward may mean zero bytes were sent. Recovery conservatively assumes payment might have occurred. We do not claim exactly-once remote service execution. A request is attempted at most once by the runner for a persisted `(sessionId, requestKey)`. Different keys mean different calls.

Reservation, cap checks and nonce allocation happen in one SQLite `BEGIN IMMEDIATE` transaction. All allocations, including settled charges and unresolved ones, consume the session budget. No failed/expired authorization automatically releases capacity. Budgets are **per session**, not global across every process/wallet or proof of reserved funds. Do not create parallel sessions to bypass an approved trial cap.

The signer output is revalidated before being persisted. The database commit precedes network submission; the response is persisted before cryptographic verification/RPC checks. Duplicate keys with different inputs, duplicate server receipt IDs and reused payment nonces cannot settle separate calls. The public log contains hashes, not bearer authorizations.

No `OVERDUE` or buyer ban is necessary in this particular per-call compatibility client. This does **not** justify removing overdue handling from the legacy unsecured checkout model. A future funded profile needs a real reserve/escrow or correctly bounded channel, not just a signed maximum.

## Independent evidence layers

1. The whole Doctor response, without `receipt.signature`, is verified under its documented `eip191-canonical-json-v1` profile: JSON keys sorted by UTF-16 code units, JS number formatting, and ASCII `\\uXXXX` escaping from U+007F up. This is **not RFC 8785**. Golden Unicode/decimal tests cover the distinction.
2. Route, input hash, receipt time, payer, payee, asset, network, exact amount and authorization nonce must match the persisted call. A server signature for another purchase is not transferable.
3. The returned transaction is looked up on the separately configured Base RPC. Chain ID, receipt success, canonical block hash, minimum two confirmations, and bound USDC `AuthorizationUsed(payer, nonce)` plus `Transfer(payer, payee, amount)` events must agree. RPC failure is unknown, not evidence of nonpayment.
4. The local log starts with `SHA256(canonical({profile, sessionId, terms}))` and advances with `SHA256(canonical({profile, sessionId, seq, previous, event}))`. An exported manifest includes the archive digest/head and can be signed by the buyer. Buyers must retain original signed responses and their archive.

The SQLite file is private but not encrypted. Retain it with its WAL and back it up securely. The runner does not protect against compromised signing hosts, deleted/corrupted journals, dishonest configured RPCs or power-loss guarantees beyond SQLite/OS durability. Use a fresh dedicated wallet for a small trial; this is unaudited research code.

## Registry / anchoring

Default: no on-chain registry and zero extra anchoring transactions. The final head and archive digest are exported for later anchoring. Final-head anchoring or multi-session Merkle batching is a future adapter, not part of the acceptance test. Anchoring cannot prove complete logs, correct service output, or mutual agreement by itself.

## Sources inspected for this implementation

- Doctor `lib/receipt.js`, inspected 2026-09-30, Git blob `6d34e56ec52445826d23377696c3b66c238d462d`: https://github.com/Fizzl13/x402-doctor/blob/master/lib/receipt.js
- Doctor paid route/config: https://github.com/Fizzl13/x402-doctor/blob/master/lib/paid-api.js
- x402 v2 core: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- Exact/EIP-3009: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md

Upstream implementations can change. A changed challenge/signing format must fail closed and be reviewed, not guessed. No third-party source files are vendored by this profile.
