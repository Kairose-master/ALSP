# ALSP

**Agent License Session Protocol** is an experimental umbrella protocol repository for session-bound operations, evidence, and reconciliation. It contains shared Core vocabulary and two distinct profiles:

```text
ALSP Core
├── x402 Exact Profile   runnable buyer-side compatibility reference
└── License Profile      legacy check-in/check-out research design
```

Core does not prescribe a payment rail or require an on-chain registry. The x402 Exact reference keeps ordinary x402 `exact` payments and groups separate per-call settlements into a local, buyer-side session. The License Profile preserves the earlier license lifecycle idea; it is not implemented by the current runner. See [Core](spec/CORE.md), [x402 Exact](spec/PROFILE-X402-EXACT.md), and [License](spec/PROFILE-LICENSE.md).

## Current validation level

- **Local / mocked ledger:** TypeScript tests exercise EIP-191/EIP-712 signatures and local HTTP behavior with **mock ledger evidence**, not mainnet settlement.
- **Free probe:** `doctor:probe` checks the live public 402 challenge and signer metadata without paying. It is a compatibility probe only.
- **Buyer-side paid Base/USDC run:** [PR #7](https://github.com/Kairose-master/ALSP/pull/7) records three ordinary x402 `exact` payments grouped into one bounded ALSP session, independent settlement verification for all three, reconciliation of uncertain outcomes without replacement payments, and closure with zero unresolved calls. No additional registry transactions were required. This is buyer-side live-payment evidence; provider-side cross-check remains pending.
- **Browser client:** [PR #9](https://github.com/Kairose-master/ALSP/pull/9) adds the wallet-signed client and stateless proxy. `test/demo.test.mjs` exercises the browser journal, replay, reconciliation and archive verification in Node with a mock provider/ledger. [PR #10](https://github.com/Kairose-master/ALSP/pull/10) adds corrupt/inaccessible-storage and competing-reservation regressions with an injected shared lock manager. These are not a browser mainnet paid run or an actual multi-tab browser test.
- **Unverified:** provider-side correlation/assent, fully verified bilateral interoperability, and x402 standards adoption. ALSP remains an experimental proposal/profile. See the [validation record](docs/INTEROP-001.md#validation-record-as-of-2026-10-08) for evidence boundaries.
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

## Web client (wallet-signed, any x402 exact provider)

`public/` is a browser client for the same profile, and `api/index.js` / `demo/server.mjs` expose a **stateless** proxy + verifier built from the library. Design:

- **Your wallet signs.** Each EIP-3009 `TransferWithAuthorization` is signed by an injected EIP-1193 wallet (MetaMask etc.) with `eth_signTypedData_v4`; the buyer seal uses `personal_sign`. No server ever sees a private key.
- **Your browser keeps the journal.** `public/alsp-browser.js` mirrors the Node journal (reserve → authorized → submission intent → response → verified, same budgets, same hash chain) in `localStorage`. Read/modify/write transitions are serialized across same-origin tabs with Web Locks and persisted before the network side effect; corrupt/inaccessible storage or unavailable browser locks fail closed. Exported archives verify with the library's `verifyChain` / `verifyBuyerSeal`.
- **The server is replaceable.** It only fetches the 402 challenge, forwards one signed payment, runs `verifyReceipt` + `verifySettlement`, and checks archives. It stores nothing. Run your own: anything you proxy through sees the bearer authorization in transit.
- **Any provider.** A `ProviderProfile` (origin, paid path, network, asset, payout address, receipt binding) replaces the former hard-coded Doctor constants; `DOCTOR_PROVIDER` is the preset. Custom profiles get generic request/body validation; providers must emit the `eip191-canonical-json-v1` receipt format.

```bash
npm run demo          # http://127.0.0.1:3402
```

Two more pages ship with the client: `learn.html`, a step-by-step walkthrough of the session concept on a simulated provider, and `agent.html`, where an AI agent (Claude, via `demo/agent.mjs`) is given a mission and hard caps and runs a whole session itself: terms, budgeted calls, a lost response, reconciliation, export and report. The model only decides; every tool executes in the browser on the real journal, in a free sandbox or live with your wallet.

**Disposable session wallet.** Both pages can pay from a session wallet instead of your main wallet: a fresh key generated in the browser (`public/session-wallet.js`) that you fund with exactly what a run may spend. It signs EIP-3009 payments and the buyer seal without prompts, so an agent runs unattended, and leftovers sweep back to your main wallet through an authorization your main wallet submits. This is a session key, not ERC-4337: no smart account, bundler or paymaster, because x402 `exact` already has the facilitator pay gas. The key lives in `localStorage`; treat it as pocket cash.

Deploy to Vercel as-is (`vercel.json`, `api/index.js`). Optional env: `ALSP_RPC_URL` (read-only HTTPS RPC for `eip155:8453`), `ALSP_ALLOWED_ORIGINS` (restrict which provider origins the proxy forwards to), `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` (enable the agent page; default model `claude-opus-5-5`). Real Base USDC is spent; start with the smallest caps, pin the receipt signer from an independent source, and never delete a journal with unresolved calls.

## Repository map

- `src/core/` — shared, payment-agnostic protocol vocabulary.
- `src/profiles/x402-exact/` — current TypeScript reference implementation.
- `src/profiles/license/` — reserved for a future executable License Profile; current legacy fixtures remain in `examples/knowledge-api/`.
- `spec/` — Core and profile specifications.
- `contracts/license/experimental/` — legacy Solidity research sketch, outside Core requirements.
- `examples/doctor/` — x402 Exact client example (CLI).
- `public/`, `demo/`, `api/` — wallet-signed web client, local server and Vercel function.
- `examples/knowledge-api/` — legacy check-in/check-out fixtures.

The package root `dist/index.js` remains a backward-compatible entry point for the x402 Exact reference exports. Direct implementation imports should use `dist/profiles/x402-exact/`.

## Whitepaper and license

Bilingual whitepaper: https://handsel.gitbook.io/alsp-whitepaper/

No repository-wide software license has been selected. Do not infer permission to deploy or redistribute from visibility alone.
