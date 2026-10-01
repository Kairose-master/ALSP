# ALSP

**Agent License Session Protocol** — experimental, license-bound usage sessions for AI agents.

## Runnable reference: Doctor interop #001

The new `alsp-exact-session-v0.2` profile groups **ordinary x402 exact-per-call payments** into one buyer-side, budget-bounded session. It uses an off-chain hash-linked journal and Doctor's existing server-signed responses. It performs **zero SessionRegistry writes**.

```text
review terms + open local session (no payment, no escrow)
  -> fetch Doctor's 402 challenge
  -> enforce pinned Base / USDC / payee / per-call and session budgets
  -> persist reservation, nonce and signed EIP-3009 authorization
  -> record submission intent BEFORE sending the paid request once
  -> persist original response BEFORE verification
  -> verify Doctor signature + request/payment binding
  -> independently check USDC AuthorizationUsed + Transfer via Base RPC
  -> repeat within budget, end access, export buyer-sealed session archive
```

**This is not authorize-max / settle-actual, batch settlement, a funded session, or provider acceptance of ALSP license terms.** `maxTotal` is a local budget, not locked money. Existing Doctor signatures do not contain an ALSP session ID; this client links them to its own terms and log. A production bilateral profile needs explicit provider assent.

### Start without money or keys

Node.js **22.16+** (uses Node's experimental `node:sqlite`).

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run doctor:probe
```

`doctor:probe` requests the real public 402 challenge and signer metadata only. It creates no payment signatures, invokes no paid service, and writes `data/doctor-report.json`. It must not be reported as a successful paid interop test.

Tests include real EIP-191 and EIP-712 signatures and a local HTTP provider, but **mock ledger evidence**. No paid LLM, wallet, mainnet funds, or third-party service is needed for `npm test`.

### Explicit small paid trial (not enabled by default)

See [the interop runbook](docs/INTEROP-001.md). Requires a funded **Base USDC** wallet, independently checked Doctor signer pin, reviewed local terms file, exact mainnet opt-in, and an explicit atomic-unit cap. The runner caps a trial at 10 calls / **10,000 atomic USDC (0.01 USDC)**. Solana is deliberately unsupported in this first implementation.

Do not paste wallet keys into issues, chat, commits or CI. Never fund the public fixture accounts in `test/crypto.test.mjs`.

### Failure and recovery

A timeout, invalid signature, missing settlement, RPC error or restart cannot silently release budget or cause a fresh payment authorization. The call remains `RECONCILIATION_REQUIRED`. Re-running a persisted idempotency key returns its existing state without re-probing, re-signing or resending. Reconcile the original response/transaction; do not delete the journal or start a fresh session to “retry”.

The SQLite journal is sensitive: it temporarily contains bearer payment authorizations, is opened with mode `0600`, and uses WAL / `synchronous=FULL` and transactional reservations. This is a single-machine research client, **not a multi-tenant wallet service**. Keep SQLite and its WAL together; no forced reset or automatic cancellation is provided.

The v0.3 reference adds generic provider/payment/receipt adapter boundaries, bilateral agreement verification, and an immutable `CLOSED` state while preserving Interop #001 archives and exact-per-call behavior. `upto` and batch remain explicitly unsupported. See [REFERENCE-v0.3](docs/REFERENCE-v0.3.md) and the synthetic independent-provider Interop #002 foundation test.

### Evidence boundaries

- Doctor signature: server provenance plus request and payment binding, not semantic truth.
- RPC-confirmed USDC events: settlement evidence from the configured RPC, not a trustless light-client proof or absolute finality.
- Buyer-sealed archive: integrity of the buyer's local record, not provider assent, log completeness, or fairness of billing.
- `verifyBuyerSeal(archive, expectedBuyer)` checks the seal/chain integrity, not response quality.
- Final-head anchoring / Merkle batching are possible later; **no anchoring adapter is implemented or claimed here**.

[Profile and state-machine notes](docs/REFERENCE-v0.2.md) · [Interop runbook](docs/INTEROP-001.md)

## Legacy v0.1 research sketch

`contracts/ALSPRegistry.sol`, `docs/PROTOCOL.md`, `examples/checkin.json` and `examples/checkout.json` retain the original check-in / check-out design, including overdue handling. They are **not invoked by the v0.2 runner**. The legacy contract trusts a payment attestor and does not verify x402 settlement itself. It has not been audited or deployed as part of this work.

A genuinely funded session profile may remove buyer-default/overdue handling after proving allocation, expiry and recovery invariants. A signed spending authorization alone is not a reservation of funds. The legacy debt model is not silently changed by this compatibility experiment.

## Whitepaper and license

Bilingual whitepaper: https://handsel.gitbook.io/alsp-whitepaper/

No repository-wide software license has been selected. Do not infer permission to deploy or redistribute from visibility alone. This PR does not change the existing licensing decision or the v0.1 whitepaper.
