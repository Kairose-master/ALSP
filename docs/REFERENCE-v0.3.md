# ALSP Reference v0.3

This reference extends Interop #001 without changing the frozen archive profile identifier (`alsp-exact-session-v0.2`), event-chain encoding, or Doctor EIP-191 receipt verifier. `GenericTerms` uses `ProviderProfile` and `PaymentProfile` as separate provider-neutral inputs; normalization validates their binding before storing the terms hash. Doctor-specific values remain compatibility constants for the v0.2 transport, receipt, and Base settlement implementations. Existing v0.2 archives remain readable and retain their original buyer-only acceptance meaning.

## Wire model

Each provider exposes an x402 v2 offer through the provider adapter. ALSP validates the resource URL against the requested endpoint and selects only a supported `exact` option matching the agreed network, asset, and payee. The client reserves the atomic amount, creates a one-time nonce, prepares one payment authorization, durably records submission intent, sends once, stores the original response, then verifies receipt and settlement evidence.

The reference `Quote` is the accepted x402 offer commitment: `{x402Version, resource, accepted}`. The `Prepared` authorization is the payment-adapter representation of one exact call. Provider transport owns the x402 wire headers and body. The quote and response hashes join the existing session journal; no session-wide escrow or registry operation is implied.

## Bilateral agreement

`BilateralSessionAgreement` is provider-signed EIP-191 over the canonical JSON payload (signature excluded):

```json
{
  "profile": "alsp-session-agreement-v0.3",
  "sessionId": "…",
  "termsHash": "sha256(canonical buyer terms)",
  "scope": "https://provider.example/api",
  "maxCalls": 10,
  "expiry": 1790000000000,
  "pricingPolicy": {
    "mode": "exact-per-call",
    "network": "eip155:8453",
    "asset": "0x…",
    "payTo": "0x…",
    "maxPerCall": "1000",
    "maxTotal": "5000"
  },
  "provider": "0x…",
  "signature": "0x…"
}
```

Verification binds signer to the terms provider, session ID, terms hash, endpoint scope, call cap, expiry, and exact pricing limits. `Journal.createBilateral(GenericTerms)` starts in `PROPOSED`; `agree()` verifies and stores the complete signed agreement and includes it in the hash-chain event; only `activate()` makes it `ACTIVE`. Call reservation rejects every state except ACTIVE. `Journal.create()` accepts only the legacy terms profile and is the Interop #001 compatibility path. Legacy `Terms.license.acceptance: "buyer-only"` remains buyer-side acceptance and is not provider assent.

## Adapter architecture

- `ProviderAdapter`: unpaid offer probe and one explicit send; transport policy belongs to the provider implementation.
- `PaymentAdapter`: preparation and validation of a payment plus declared capabilities. The only enabled capability is `exact-per-call`.
- `ReceiptEvidenceAdapter`: combines provider receipt and settlement verification into normalized evidence.
- `ProviderReceiptVerifier`: provider receipt-specific evidence boundary. `DoctorEip191ReceiptAdapter` preserves the existing Doctor receipt verifier.
- `X402OfferReceiptEnvelopeValidator`: checks x402 v2 offer/receipt envelope and payment-field bindings. It does not validate signature provenance or delivery; chain settlement still requires an independent settlement verifier. `X402OfferReceiptAdapter` is a deprecated compatibility alias.

`upto` and `batch` are named capability boundaries only. Capability selection fails closed unless an implementation declares it, and the reference rejects both even if declared. They are not implemented or tested as payment modes.

## Normative state transitions

### Call states

| Current | Allowed next state | Condition |
| --- | --- | --- |
| `RESERVED` | `AUTHORIZED`, `RECONCILIATION_REQUIRED` | Authorization prepared, or preparation failed/uncertain |
| `AUTHORIZED` | `SUBMITTED`, `RECONCILIATION_REQUIRED` | Durable submission intent before send, or uncertain failure |
| `SUBMITTED` | `VERIFIED`, `RECONCILIATION_REQUIRED` | Required evidence verifies, or any uncertainty |
| `RECONCILIATION_REQUIRED` | `VERIFIED` | Original response/transaction evidence verifies; never resend |
| `VERIFIED` | — | Terminal |

Illegal transitions throw. An unresolved call moves the session to `RECONCILIATION_REQUIRED` and blocks new reservations. Recovery verifies captured evidence without signing or sending again. Resume requires every prior call verified and remaining expiry, call-count, and budget capacity.

### Session states

| Current | Allowed next state | Condition |
| --- | --- | --- |
| `PROPOSED` | `AGREED` | Provider signature verified and full agreement durably recorded |
| `AGREED` | `ACTIVE`, `CLOSED` | Explicit activation, or session abandoned |
| `ACTIVE` | `RECONCILIATION_REQUIRED` | Any call becomes uncertain, or end requested with unresolved calls |
| `ACTIVE` | `CLOSED` | End requested and every call is verified |
| `RECONCILIATION_REQUIRED` | `ACTIVE` | All calls verified; resume policy permits more calls |
| `RECONCILIATION_REQUIRED` | `CLOSED` | End requested after evidence is resolved |
| `CLOSED` | — | Immutable terminal state |

Older stored `ENDED` sessions are read as `CLOSED` when all calls were verified and as `RECONCILIATION_REQUIRED` when evidence is unresolved. A closed session cannot be resumed. A closed session's terms and event chain are not rewritten.

## Security properties and limits

- Every authorization is exact per call. Reservations include unresolved calls and are never freed on timeout.
- Submission intent is durable before the network side effect. Retries by idempotency key return the existing call; the client does not automatically replay a paid request.
- Provider and receipt adapters are trust boundaries; implementations must bind offer, response, payer, payee, asset, amount, and settlement evidence before returning `VERIFIED`.
- Receipt provenance does not prove semantic correctness. RPC-confirmed events do not constitute trustless finality. A buyer seal proves local archive integrity, not provider assent or journal completeness.
- Journal files contain bearer payment authorizations and require restrictive local permissions. This is not a hosted wallet or multi-tenant service.
- Agreement signing and exchange remain out-of-band; no provider discovery, escrow, or automatic provider signature exchange exists. Signature validity establishes provider assent to these terms, not service correctness.
- `upto`, funded sessions, batch settlement, refund/cancel paths, cross-chain payments, and registry anchoring are non-goals for this release. Unsupported payment modes are rejected.

## Community implementation reports (non-normative)

Two Reddit implementation reports informed the boundaries above:

- [An x402 builder's postmortem on payment intent IDs, pre-side-effect intent records, reconciliation, and cross-merchant budget accounting](https://www.reddit.com/r/x402/comments/1uzm02s/i_posted_my_agent_payment_infrastructure_here_a/). ALSP already persists a local reservation and submission intent before the paid send, never frees an uncertain reservation, and requires reconciliation. Its ledger is still local to one journal; it cannot establish a buyer's spend across unrelated sessions, devices, or merchants.
- [A discussion of x402 safety tooling and seller-signed delivery receipts](https://www.reddit.com/r/BASE/comments/1uej6gh/x402_on_base_feels_like_a_big_unlock_for_ai/). The suggested receipt binds settlement, an idempotency key, and a response hash. The `X402OfferReceiptEnvelopeValidator` here only checks an offer/receipt envelope and payment fields; it does not verify a provider signature or prove delivery.
- [A report on x402 composition failures around replay protection, holds, and post-settlement crashes](https://www.reddit.com/r/x402/comments/1uxo0ia/i_built_payment_infrastructure_for_ai_agents_to/). It reinforces the no-automatic-resend and reconciliation rules, but does not establish a protocol standard.

These are field reports and community opinions, not normative protocol specifications. They motivate future tests for provider-issued idempotency/delivery evidence, recovery from independent settlement records, and buyer-side budget enforcement across multiple providers. The current synthetic Interop #002 test demonstrates adapter decoupling only; it is not a live provider interoperability result.
