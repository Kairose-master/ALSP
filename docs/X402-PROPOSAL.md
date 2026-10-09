# Proposal draft: ALSP session extension for x402 v2

**Status:** discussion draft for upstream x402  
**Proposed extension key:** `alsp-session`

## Summary

ALSP (Agent License Session Protocol) proposes an optional x402 v2 extension for grouping multiple related x402 commercial interactions into a bounded session with a common terms commitment and explicit reconciliation semantics.

It is **not a payment scheme**. It does not replace `exact`, `upto`, `batch-settlement`, or `auth-capture`. Payment authorization, verification, and settlement remain the responsibility of the selected x402 scheme.

The extension addresses a layer that x402 v2 explicitly leaves out of core: session handling.

## Problem

An autonomous agent often performs several paid requests as part of one task. Individual x402 payments can prove or settle each request, but the application still needs to answer:

- Which paid calls belonged to the same bounded commercial session?
- Which license or usage terms were accepted for that session?
- What scope or budget constrained the session?
- How should a client behave when a paid request may have settled but its response or settlement verification is temporarily inconclusive?
- How can receipts from several calls be linked into a tamper-evident session record without requiring an on-chain registry write per call?

A naive retry after an uncertain paid request can create duplicate economic effects. A purely local grouping, meanwhile, has no interoperable wire representation.

## Proposed role in x402

ALSP should use the existing x402 v2 extension mechanism.

Conceptually:

```text
x402 payment scheme
  exact / upto / batch-settlement / auth-capture
                 |
                 v
       offer-receipt extension
      signed commercial artifacts
                 |
                 v
          alsp-session
 session identity + terms commitment
 scope/budget + receipt linkage
 reconciliation + final evidence head
```

The proposal should compose with the existing `offer-receipt` extension rather than redefine signed offers or receipts.

## Minimal wire semantics

A server that supports the profile MAY advertise:

```json
{
  "extensions": {
    "alsp-session": {
      "info": {
        "version": 1,
        "sessionId": "urn:uuid:...",
        "termsHash": "sha256:...",
        "scope": {
          "resource": "https://api.example.com/tool",
          "maxCalls": 20,
          "maxAmount": "20000"
        },
        "expiresAt": 1790780000,
        "receiptMode": "offer-receipt",
        "anchoring": "none"
      },
      "schema": {}
    }
  }
}
```

The exact JSON Schema is intentionally left for the standards discussion. The first upstream issue should establish semantics before freezing field placement.

A client that accepts the session echoes the advertised extension according to x402 v2 extension rules. Client-added fields could carry a session-local call identifier or previous evidence head if the standards discussion considers those appropriate.

## Terms commitment

`termsHash` commits to application-level terms outside the payment scheme: license, usage scope, policy, or another canonical terms document.

ALSP does not define the legal meaning of those terms. It only defines how a session identifies the commitment that the parties chose to use.

A production bilateral profile should make provider assent explicit. A buyer-only local hash is useful evidence but MUST NOT be represented as provider acceptance.

## Reconciliation

ALSP distinguishes an uncertain outcome from default or failure.

A minimal client lifecycle is:

```text
ACTIVE
  -> PAYMENT_SUBMITTED
  -> VERIFIED
  -> ACTIVE

or

ACTIVE
  -> PAYMENT_SUBMITTED
  -> RECONCILIATION_REQUIRED
  -> VERIFIED
  -> ACTIVE / CLOSED
```

When a paid request has an uncertain outcome, the client MUST NOT create a replacement payment merely to recover from the uncertainty. It should preserve the original authorization/evidence and reconcile that same attempt.

The extension does not prescribe a chain-specific reconciliation mechanism. The selected x402 scheme and receipt evidence determine how settlement is checked.

## Receipts and evidence

ALSP SHOULD reuse x402 `offer-receipt` artifacts when available.

A session record can link:

- x402 payment/settlement evidence,
- signed x402 receipts,
- application response hashes,
- session-local call identifiers,
- the terms commitment,
- previous evidence head.

The log MAY remain off-chain. An implementation MAY anchor only a final head hash or a batch head. An on-chain SessionRegistry is not required by this proposal.

A signed receipt proves that the signer made the signed statement. It does not by itself prove semantic correctness of the returned service result.

## Payment-scheme independence

Examples:

### exact

Several ordinary `exact` purchases can be grouped into one ALSP session. Each call settles independently.

### upto / auth-capture

A future profile can bind a bounded authorization/capture lifecycle to one ALSP session. A signed maximum authorization MUST NOT be described as reserved funds unless the underlying mechanism actually reserves funds.

### batch-settlement

Batch settlement may reduce settlement overhead while ALSP supplies the application-level session and evidence semantics.

## Non-goals

ALSP does not:

- introduce a new payment scheme;
- replace x402 verification or settlement;
- require a blockchain registry;
- require one on-chain transaction per check-in/check-out;
- define identity or reputation;
- claim that payment proves service quality;
- turn a buyer-only terms hash into provider assent;
- require a specific chain.

## Implementation evidence

The current `main` contains a runnable buyer-side reference and browser client. Validation levels are distinct:

- **Local / mocked ledger:** EIP-191/EIP-712 signatures and local HTTP provider tests use **mock ledger evidence**.
- **Offline bilateral implementation:** [the fixed-price demo](../examples/price-agreement/README.md) tests a provider-recognized agreement signed by both fixture parties, three independent mock-settled calls, unchanged agreed pricing after public-price changes, and archive signature/link verification. Its local envelope does not claim upstream offer-receipt interoperability or external provider adoption.
- **Free probe:** `doctor:probe` checks the public 402 challenge and signer metadata without paying; it does not verify paid settlement.
- **Buyer-side live Base/USDC:** [PR #7](https://github.com/Kairose-master/ALSP/pull/7) records three ordinary x402 `exact` payments in one bounded ALSP session, independent settlement verification for all three, reconciliation of uncertain outcomes without replacement payments, and closure with zero unresolved calls, without additional registry transactions.
- **Browser tests:** [PR #9](https://github.com/Kairose-master/ALSP/pull/9) adds the client/stateless proxy; `test/demo.test.mjs` uses Node, a mock provider/ledger and fixture signatures to test replay, reconciliation and archive verification. [PR #10](https://github.com/Kairose-master/ALSP/pull/10) adds fail-closed storage handling and serialized-reservation regressions using an injected shared lock manager. This does not establish browser mainnet settlement or actual multi-tab browser verification.

Provider-side cross-check of the paid run remains pending. Buyer-side terms commitments and archive seals do not establish provider assent or fully verified bilateral interoperability. The proposal has not been established as an adopted x402 standard. See the [validation record and limitations](INTEROP-001.md#validation-record-as-of-2026-10-08).

## Relationship to x402 core

x402 v2 defines `extensions` as optional modular functionality and explicitly lists session handling mechanisms outside core protocol scope. ALSP is intended to remain in that optional layer.

The smallest useful standards outcome may therefore be:

1. agreement that bounded multi-payment sessions are a useful extension-level primitive;
2. agreement on session identity and terms-commitment semantics;
3. explicit reconciliation behavior for uncertain paid calls;
4. composition rules with `offer-receipt`;
5. only then, a stable JSON Schema and reference implementation.

## Open questions for x402 maintainers

1. Is an x402 extension the right abstraction, or should session semantics remain an application note/profile outside the wire protocol?
2. Should `sessionId` originate from the resource server, buyer, or a negotiated value?
3. Should a previous/final evidence-head hash travel on the wire, or remain an application artifact?
4. Which fields overlap enough with `offer-receipt` that ALSP should reference rather than duplicate them?
5. Should reconciliation semantics be normative for a session extension or only implementation guidance?
6. How should the model compose with `upto`, `auth-capture`, and `batch-settlement` without implying funds are reserved when they are not?
7. What privacy constraints should apply to cross-request session identifiers?

## Upstream issue draft

**Title:** Proposal: bounded session & reconciliation extension for multi-request x402 interactions

x402 already provides strong request-level payment primitives. For autonomous agents, I have been experimenting with a complementary problem: several paid calls often belong to one bounded task/session, and an uncertain response after payment must not cause the agent to blindly pay again.

I built ALSP as an experimental session layer and recently completed a live Base/USDC run: three ordinary x402 `exact` payments were grouped into one bounded session, all three settlements were independently verified, uncertain outcomes were reconciled without replacement payments, the session closed with zero unresolved calls, and no additional registry transactions were required.

I would like feedback on whether this belongs as an optional x402 v2 extension/profile.

The proposed primitive is deliberately small:

- session identity;
- terms commitment;
- bounded scope/budget metadata;
- linkage to existing signed receipts;
- explicit reconciliation semantics for uncertain paid calls;
- optional off-chain hash-linked evidence with final/batch anchoring rather than mandatory registry writes.

This is **not** a new payment scheme and would compose with `exact`, `upto`, `auth-capture`, or `batch-settlement`. It should also reuse the existing `offer-receipt` extension rather than invent another receipt format.

The main design questions are whether session identity belongs on the x402 wire at all, how it should be negotiated, and which evidence fields should remain application-local for privacy.

Reference implementation / discussion material:
https://github.com/Kairose-master/ALSP

Provider-side cross-check of the first live run is currently pending, so I am intentionally not claiming external interoperability verification yet.

Would maintainers prefer this direction as (a) an extension proposal, (b) an application profile/note, or (c) something that should remain entirely outside x402?
