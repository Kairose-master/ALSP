# Interop #001 — Doctor, exact-per-call, no Registry

## Acceptance criteria

A single session records multiple ordinary Doctor preflight calls, enforces a local maximum budget, verifies response signatures and independent ledger evidence, survives a duplicate/restart without making a fresh payment, and exports a hash-linked buyer-sealed archive. **No extra Registry write.**

This does not demonstrate batch settlement, pre-funded authorization, Solana support, provider license assent or semantically correct diagnoses.

## 1. No-money check

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run doctor:probe
```

Inspect `data/doctor-report.json`. The synthetic policy used by `probe` has no signer and cannot spend. It fetches only Doctor's preflight challenge and published signing-key metadata. GitHub Actions runs this check separately from deterministic tests, with no payment credentials. An offline local HTTP test uses real signatures but fabricated ledger evidence.

## 2. Prepare a separately authorized paid trial

Do not run until the wallet owner explicitly approves the displayed cap. Use a dedicated Base USDC wallet with only the intended trial funds. Do not use the fixture keys. Do not put keys in shell arguments, committed `.env` files, logs or chat; inject `ALSP_PRIVATE_KEY` securely in the process environment.

Independently check the Doctor signing key against the operator/published metadata, then set `ALSP_RECEIPT_SIGNER`. It is NOT the payer private key and is not necessarily the payout address. Set `ALSP_RPC_URL` to a trusted Base HTTPS RPC (default `https://mainnet.base.org`).

Create a local `reviewed-terms.txt` containing the terms you reviewed. Its SHA-256 is committed into this buyer-side session. Doctor's existing service has not thereby agreed to new ALSP terms. Coordinate explicit provider assent separately if that is part of the experiment.

```bash
export ALSP_ENABLE_MAINNET=I_ACCEPT_EXACT_PER_CALL_SPEND
# ALSP_PRIVATE_KEY and ALSP_RECEIPT_SIGNER must already be securely configured.
npm run doctor:paid -- --max-total 3000 --calls 3 --terms-file ./reviewed-terms.txt
```

The cap is **3,000 atomic USDC = 0.003 USDC**. Every supported challenge must charge at most **1,000 units per call**. The first-runner hard limit is 10 calls and 10,000 units total. It makes no ERC-20 approval or registry transaction; the existing facilitator submits ordinary EIP-3009 transfers.

The provider-coordinated fixed preflight target is `https://ichimoku-signal.fizzl.eu/signal/BTC-USDT`. Every Doctor request carries `User-Agent: alsp-interop/001` so the operator can correlate buyer and provider logs. Each call is a separate service purchase, even if Doctor serves a cached diagnosis.

Save the printed session ID. The SQLite file contains sensitive signed authorizations and must remain local. Paid archives contain input/payment metadata; do not publish them without review.

## 3. Resume / reconcile safely

The CLI stops immediately at the first unresolved call. **Do not start a new session to retry it.** A crash before `end` can resume with the same journal, session ID, cap, call count and terms file:

```bash
npm run doctor:paid -- --session SESSION_ID --max-total 3000 --calls 3 --terms-file ./reviewed-terms.txt
```

Already known keys are never re-probed/re-signed/re-sent. An unresolved call must be reconciled separately. This path does not require a private key or mainnet-spend opt-in:

```bash
npm run doctor:reconcile -- --session SESSION_ID --call-id CALL_ID
```

If the original response was lost, request the original signed response and settlement metadata from the provider; put `{ "status": 200, "body": <original JSON>, "settlement": <decoded PAYMENT-RESPONSE> }` in a private JSON file and pass `--evidence ./original-response.json`. It must match the original nonce/input and pass the same signature and ledger checks. A conflicting captured response is not overwritten.

A valid signed response with delayed RPC visibility remains unresolved until an explicit reconcile succeeds. A payment without a recoverable valid response must **not** be labelled successful service delivery. This client intentionally has no automatic refund, release, cancel, or server-response recovery API.

Exit codes: `0` completed operation; `2` unresolved call; `1` configuration/transport failure. Inspect the report rather than treating a probe's exit 0 as proof of a paid session.

## Provider-side correlation contract

Before spending, tell the Doctor operator:
- network: Base mainnet (`eip155:8453`)
- payer address from the dedicated trial wallet
- User-Agent: `alsp-interop/001`
- target: `https://ichimoku-signal.fizzl.eu/signal/BTC-USDT`

After the trial, share only reviewed non-secret evidence for each call: UTC timestamp, verified settlement transaction hash, provider receipt/request ID, ALSP call ID, plus the ALSP session ID and final head hash. Never share the private key or bearer payment authorization/signature.

## What to send the Doctor operator

Send the exact commit/PR, Node version, immutable terms digest, intended call count/cap and whether the test is **unpaid**, **local/mocked ledger**, or **real paid Base**. After a real trial, report verified transaction hashes and any failure without exposing wallet keys or unspent authorization signatures.

Initial implementation status: see the PR's CI evidence. Never claim the paid interop has run merely because the reference or unpaid probe passes.
