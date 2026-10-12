# Maha JSON POST / lost-output synthetic fixture

A runnable, **offline** follow-up to the earlier query-only Maha export sample.
It uses the real pinned request shape for `POST /api/v1/compress`, but all
execution occurs in an injected, in-process mock at
`https://maha-json-fixture.invalid`. No request is sent to Maha's execution
endpoint, no real funds are used, and no public RPC is called.

## Run

Node 22.16+ is required (`node:sqlite`); the implementation was tested on Node
24.19.0. From the repository root:

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run demo:maha-json-post
# Or select a NEW output directory:
npm run build
node examples/maha-json-post/generate.mjs data/my-new-maha-fixture
```

The command prints only public-output paths, counters, and summaries. It creates:

- `data/maha-json-post-<timestamp>/public/`: redacted projections, separate
  settlement/output observations, a manifest, and four scenario files. This is
  the shareable evidence directory.
- `data/maha-json-post-<timestamp>/private-outbox/`: raw synthetic input, native
  exports, the SQLite journal, ephemeral signing key and bearer authorization,
  and local recovery/ledger material. **Do not share this directory.** Files use
  `0600`, directories use `0700`; `data/` is ignored by Git.

Every generated key is ephemeral and tied to the mock asset/domain. Never fund
or reuse it. Generator source describes how to reconstruct the synthetic
sentences; public exports contain no raw input or compiled text. Public contract
snapshots contain Maha's already-public illustrative examples, not user data.
Reusing an output directory fails rather than overwriting evidence. IDs, keys,
nonces, and transaction digests vary per run; behavior is reproducible.

A generated [public evidence snapshot](public-evidence/manifest.json) is checked in
under `public-evidence/`. It contains only redacted projections and companion
observations; the corresponding private outbox is not published.

## What each case demonstrates

| Scenario | Native final state | Separate settlement observation | Separate output observation |
| --- | --- | --- | --- |
| `success` | `VERIFIED` / `CLOSED` | independently checked `mock-settled` | schema-shaped synthetic output observed, unattested |
| `lost-no-wire` | `RECONCILIATION_REQUIRED` | independently checked `mock-settled`, no `WireResponse` required | unresolved; no output recoverable |
| `lost-recovered-null` | `VERIFIED` / `CLOSED` after attaching a bodyless local record | independently checked `mock-settled` | unresolved; HTTP 200/null is no output |
| `null-body-200` | `VERIFIED` / `CLOSED` | independently checked `mock-settled` | unresolved; HTTP 200/null is no output |

All cases sign once, submit once, and mock-settle once. Repeating the local
request key does not re-probe, re-sign, resend, or pay again. Read-only settlement
observation does not change the native call, manufacture a response, release its
reserved budget, create a replacement authorization, or establish a refund. An
unsigned native receipt's `unsigned:<nonce>` ID is a local placeholder, not a
Maha-issued request ID. `CLOSED`/`VERIFIED` is deliberately **not** repurposed as
proof that useful output arrived.

`lost-recovered-null` models an explicit bodyless record supplied locally. It
does not assert that Maha offers a recovery endpoint or stores output. The
`lost-no-wire` case retains no response record and verifies ledger evidence
through a separate transaction locator.

## Minimal opt-in implementation

Only the Node x402 Exact profile changes; Core, the browser client, journal schema,
and the native reconciliation lifecycle do not change.

- `ProviderProfile.requestEncoding: 'json'` opts into a POST JSON object;
  `maxRequestBytes` bounds canonical body bytes. Absent encoding retains query
  transport. The fixture validates the pinned Maha input contract (including
  450,000-byte limit) before any payment authorization.
- Optional input arguments on `probe(url, input)` and
  `send(url, prepared, input)` carry the same detached, frozen input snapshot.
  The transport sends canonical nested JSON plus `Content-Type: application/json`
  on both the unpaid challenge request and paid submission. Source documents
  never enter a query string.
- `verifySettlementTransaction(call, terms, transaction, rpc)` verifies a
  separately obtained transaction locator against persisted payment bindings,
  chain, successful receipt, confirmations, canonical block, authorization nonce,
  payer, payee, asset, and transfer amount. It requires no `WireResponse`, makes
  only read-only RPC calls, and does not update native state. Existing
  `verifySettlement` continues to validate its response settlement header before
  using the same checker. Fixture wrappers label successfully checked mock
  evidence `mock-settled`, never live `rpc-confirmed` evidence.

This is not end-to-end Maha interoperability, a new x402 standard, a nonce-to-body
payment extension, or a browser feature. EIP-3009 payment authorization does not
cryptographically bind the JSON body. The request hash binds it in the local
journal; the output remains unsigned and unattested. Provider-side idempotency,
recovery, refund, and retention behavior are not inferred from this fixture.

## Digests, versions, and redaction

The companion names `offerId: context-compression` and
`metadataVersion: 2026-08-10` explicitly. The public discovery version is not a
signed provider terms version; `providerTermsVersion` is `null`. The real live
402 challenge would be authoritative for payment terms. The mock uses chain
31337, a synthetic asset/payee, and an amount of 1000 synthetic atomic units; it
does not pay the public quoted service.

- `inputDigest`: bare lowercase hex SHA-256 of canonical **input alone**.
- Native `requestHash`: SHA-256 of canonical `{endpoint,input}`.
- These are distinct and are not claimed to reproduce Maha's `inputHash`.
  ALSP canonical JSON here is the existing sorted UTF-16/ASCII profile, not RFC
  8785. Synthetic output hashes and token counts do not claim algorithm parity
  with the service.

Public exports are explicitly labeled `redacted-native-archive-projection`.
They preserve the event hash chain and its head while replacing raw input and
non-null response bodies with digest/redaction objects. They are not unchanged
native exports and are not buyer-sealed. `verifyChain` validates events only;
it does not verify the redacted evidence, a provider's assent, billing fairness,
or service output. Recomputing the full `sourceArchiveSha256`, original request
binding, or raw response digest requires the private outbox.

## Pinned sources

Read-only public contract snapshots retrieved on 2026-10-12:

- [Discovery offer](https://www.mahastrategies.com/api/discovery/x402-offers/context-compression),
  `contracts/offer.json`, raw SHA-256
  `6fa66b72dcb04ca80e3a7db746cbb9b2a91cfeb4b8cb66b14a278f9c332a6988`.
- [Request schema](https://www.mahastrategies.com/context-pack-schema.json),
  `contracts/request.schema.json`, raw SHA-256
  `27251cdc111fbe92a748a8f328bdb133dbdbd931bf79d7295a9b62b00d097f6b`.

The fixture validates against both pinned request-schema representations and
also checks unique document IDs. Its small local validator implements only the
keywords used in these snapshots, not all of JSON Schema. Runtime generation
never refreshes these documents or calls their URLs.

Base implementation: ALSP main
`545221097a48cb6480c58b5d43e05f302acef30f`, verified 2026-10-12.
The old sample at
`763d68c3218f29452990b87964e8808ffd0ac083` was inspected as historical context;
its query-only transport observation is not relabeled as JSON support.

## Tests and limits

`test/maha-json-post.test.mjs` covers the four cases, request contract boundaries,
invalid input before authorization, distinct digests, key replay/conflict,
reserved-budget retention, independent settlement tampering, and public/private
file separation. `test/json-transport.test.mjs` covers opt-in transport and
compatibility/mutation boundaries. `npm test` also runs all existing tests.

No live provider execution/payment, live settlement, provider cross-check,
browser UI/multi-tab behavior, public deployment, push, or PR is part of this
example. Custom recovery headers, the additional Maha tools, new nonce-binding
variants, and wider refactors are out of scope.
