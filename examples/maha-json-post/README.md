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

The [public evidence snapshot](public-evidence/manifest.json), regenerated on
2026-10-13, includes the Unicode fixture and received-schema observations below.
All public files contain only redacted projections and companion observations;
the corresponding private outbox is not published. Earlier v1 evidence remains
available in the parent commit `cd7b3264ed39d610d4b89f6fe7d121a61c9687d8`.

## What each case demonstrates

| Scenario | Native final state | Separate settlement observation | Separate output observation |
| --- | --- | --- | --- |
| `success` | `VERIFIED` / `CLOSED` | independently checked `mock-settled` | received synthetic JSON schema-valid, unattested |
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

Read-only public contract snapshots retrieved on 2026-10-12 and independently
re-fetched on 2026-10-13 at 03:48 UTC. Both official responses were HTTP 200 and
byte-for-byte unchanged. URLs, exact raw hashes, schema pointers and verification
time are pinned in `contracts/provenance.json`; loading fails on a hash mismatch:

- [Discovery offer](https://www.mahastrategies.com/api/discovery/x402-offers/context-compression),
  `contracts/offer.json`, raw SHA-256
  `6fa66b72dcb04ca80e3a7db746cbb9b2a91cfeb4b8cb66b14a278f9c332a6988`.
- [Request schema](https://www.mahastrategies.com/context-pack-schema.json),
  `contracts/request.schema.json`, raw SHA-256
  `27251cdc111fbe92a748a8f328bdb133dbdbd931bf79d7295a9b62b00d097f6b`.

The output contract is the published `/contract/output/schema` object inside
`contracts/offer.json`. It is not a guessed response contract or a new endpoint.
The fixture validates both pinned request-schema representations and also checks
unique document IDs. The small local validator implements only the keywords in
these snapshots, not all of JSON Schema; unsupported schema types/keywords fail
closed when loading the pins. Runtime generation never refreshes these documents
or calls their URLs. No dependencies were added.

## Observed schema and Unicode checks

After installing the lockfile dependencies, invoke the installed tools directly
to avoid npm update notifications/optional registry checks:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json
node --test test/maha-json-post.test.mjs test/maha-schema-compatibility.test.mjs
```

- Both the unpaid probe and single paid mock submission validate the actual
  serialized body at the injected fetch boundary. The byte limit applies to
  those exact bytes, including escapes/whitespace, rather than a re-serialized
  approximation. Public request observations record the raw body digest and
  byte count, never the body itself.
- The fixture captures bytes from the actual returned `Response` and validates
  the JSON parsed by ALSP's real transport against the official output schema.
  Mutations injected after mock output construction are therefore detected.
  Public output observations separate `wireBodySha256` (raw response bytes)
  from `parsedBodySha256` (ALSP canonical JSON). These differ for the fixture's
  literal UTF-8 response and must not be conflated.
- Synthetic sources contain Korean, astral emoji, combining accents and a ZWJ
  emoji. Requests use ALSP's existing ASCII-escaped JSON, so Korean characters
  occupy six wire bytes and an astral emoji occupies twelve. Responses use
  literal UTF-8. Round-trip checks preserve code points without normalization.
- JSON Schema string bounds count Unicode code points, not JavaScript UTF-16
  length, grapheme clusters or bytes. The regressions exercise 8/120 request-ID,
  8/1,200 task, 160 title and exact 450,000-byte request boundaries. A combining
  accent/ZWJ sequence can comprise several code points. See the
  [JSON Schema string-length definition](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.3.1).
- Required fields, nested arrays/objects, constants, enums, patterns, numeric
  bounds, malformed JSON and invalid UTF-8 have negative cases. A distinct
  synthetic placeholder supplies response `inputHash`; it deliberately differs
  from local `inputDigest` and does not implement Maha's canonical hash.

Schema results are companion evidence, independent of native receipt/settlement
verification. A schema-invalid HTTP 200 response can still be native `VERIFIED`;
its companion reports `invalid`. Empty/null bodies report `no-output`; no-wire
loss reports `not-observed`. Malformed JSON remains unresolved. The unchanged
native transport replacement-decodes invalid UTF-8, which the stricter companion
flags independently; this change does not harden the production decoder.

Schema-valid unsigned output does not establish authenticity, factual correctness,
compression quality, economic value, cross-field consistency or hash-algorithm
parity. Tests explicitly show that invented content and inconsistent metric/hash
values can satisfy the published structural schema. This is offline compatibility
coverage, not a live Maha interoperability result.

Base implementation: ALSP main
`545221097a48cb6480c58b5d43e05f302acef30f`, verified 2026-10-12.
The old sample at
`763d68c3218f29452990b87964e8808ffd0ac083` was inspected as historical context;
its query-only transport observation is not relabeled as JSON support.

## Tests and limits

Verified 2026-10-13 on Node 24.19.0: **146 tests passed** (including 34 new
schema/Unicode regressions), build and typecheck passed. The full suite was run
with npm update checks disabled and offline mode enabled; the focused Maha
suite runs directly with the installed Node/TypeScript tools.

`test/maha-json-post.test.mjs` covers the four cases, request contract boundaries,
invalid input before authorization, distinct digests, key replay/conflict,
reserved-budget retention, independent settlement tampering, and public/private
file separation. `test/json-transport.test.mjs` covers opt-in transport and
compatibility/mutation boundaries. `test/maha-schema-compatibility.test.mjs` adds
observed-wire, response-contract and Unicode regressions. `npm test` runs all
existing tests as well.

No live provider execution/payment, live settlement, provider cross-check,
browser UI/multi-tab behavior, public deployment, push, or PR is part of this
example. Custom recovery headers, the additional Maha tools, new nonce-binding
variants, and wider refactors are out of scope.
