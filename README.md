# ALSP

**Agent License Session Protocol** is an experimental umbrella protocol repository for session-bound operations, evidence, and reconciliation. It contains shared Core vocabulary and two distinct profiles:

```text
ALSP Core
├── x402 Exact Profile   runnable buyer-side compatibility reference
└── License Profile      legacy check-in/check-out research design
```

Core does not prescribe a payment rail or require an on-chain registry. The x402 Exact reference keeps ordinary x402 `exact` payments and groups separate per-call settlements into a local, buyer-side session. The License Profile preserves the earlier license lifecycle idea; it is not implemented by the current runner. See [Core](spec/CORE.md), [x402 Exact](spec/PROFILE-X402-EXACT.md), and [License](spec/PROFILE-LICENSE.md).

## Current validation level

- TypeScript reference implementation and local tests are available.
- Tests exercise EIP-191/EIP-712 signatures and local HTTP behavior, but use **mock ledger evidence**.
- `doctor:probe` checks the live public 402 challenge and signer metadata without paying. It is a compatibility probe only.
- There is no paid mainnet interoperability run in this `main` baseline. Do not describe the implementation as live-settlement validated.
- `contracts/license/experimental/ALSPRegistry.sol` is an unaudited legacy sketch. The x402 Exact profile does not invoke it, and Core does not require it.

## Doctor x402 Exact reference

Node.js **22.16+** (uses Node's experimental `node:sqlite`).

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run doctor:probe
```

`doctor:probe` creates no payment signatures and invokes no paid service. Paid trials are opt-in and documented in the [interop runbook](docs/INTEROP-001.md). They require a funded Base USDC wallet, independently checked signer pin, reviewed local terms, explicit mainnet opt-in, and a small atomic-unit cap. Never paste wallet keys into issues, chat, commits, or CI.

The runner persists reservation, nonce, signed authorization, submission intent, and original response in a local SQLite WAL journal. Ambiguous outcomes stay `RECONCILIATION_REQUIRED`; the client does not automatically authorize a replacement payment. This is a single-machine research client, not a multi-tenant wallet service.

### Evidence boundaries

- Doctor signature: server provenance and request/payment binding, not semantic truth.
- RPC-confirmed USDC events: settlement evidence from the configured RPC, not a trustless light-client proof or absolute finality.
- Buyer-sealed archive: integrity of the buyer's local record, not provider assent, log completeness, or billing fairness.
- No registry write or final-head anchoring is implemented in this profile.

## Repository map

- `src/core/` — shared, payment-agnostic protocol vocabulary.
- `src/profiles/x402-exact/` — current TypeScript reference implementation.
- `src/profiles/license/` — reserved for a future executable License Profile; current legacy fixtures remain in `examples/knowledge-api/`.
- `spec/` — Core and profile specifications.
- `contracts/license/experimental/` — legacy Solidity research sketch, outside Core requirements.
- `examples/doctor/` — x402 Exact client example.
- `examples/knowledge-api/` — legacy check-in/check-out fixtures.

The package root `dist/index.js` remains a backward-compatible entry point for the x402 Exact reference exports. Direct implementation imports should use `dist/profiles/x402-exact/`.

## Whitepaper and license

Bilingual whitepaper: https://handsel.gitbook.io/alsp-whitepaper/

No repository-wide software license has been selected. Do not infer permission to deploy or redistribute from visibility alone.
