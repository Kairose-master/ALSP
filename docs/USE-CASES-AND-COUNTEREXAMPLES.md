# ALSP use cases and counterexamples

**Evidence snapshot:** 2026-10-08 (Korea Standard Time)  
**Status:** scoping note; examples below are not claims of market validation or standards adoption.

This note narrows the proposed ALSP use case. It separates request-level x402 payment needs from the narrower case where a buyer and provider need verifiable evidence that several independent payments share one provider-approved agreement.

## Decision rule

Ordinary request-by-request x402 is sufficient when every paid request can stand on its own: its 402 challenge states the price or applicable per-request ceiling, the request is settled independently, and any retry protection is scoped to that same request (for example, an optional provider-supported `Idempotency-Key`). If the provider applies the same published terms to everyone and can manage its own payer-level operational state, a cross-payment agreement record is not required by that workflow.

ALSP is potentially useful only when all of the following matter:

1. **A shared agreement exists:** a buyer and provider have agreed to terms that differ from the provider's generally published terms, or to a bounded relationship with its own scope and expiry.
2. **Several independent payments fall under it:** each x402 payment remains separately challenged and settled.
3. **The shared context must be evidenced across parties or systems:** a later reviewer needs to identify which mutually recognized terms/version applied to those payments, rather than infer it from a buyer's private grouping.
4. **Request-level evidence is insufficient:** separate prices, receipts, and same-request idempotency do not establish the common agreement, its version, or its validity across the sequence.
5. **The provider recognizes the binding:** the provider has an explicit way to assent to or recognize the agreement identifier and terms commitment. A buyer-created session ID or buyer-sealed journal alone is unilateral evidence.

A session record can link interactions to a shared agreement; it does not itself prove service quality, SLA performance, legal enforceability, or that a provider accepted terms. Those require their own evidence and processes.

## Cases where request-level x402 is enough

| Scenario | Why a cross-payment ALSP agreement is not needed for this scenario |
| --- | --- |
| Public API with the same published terms for every buyer | Each 402 challenge and the published terms govern that request; there is no buyer-specific terms version to prove. |
| One-off purchase, even if it is expensive | A single payment has no cross-payment agreement lifecycle to link. |
| Independent calls priced separately with no negotiated relationship | Each call's price and settlement can be evaluated on its own. |
| Retrying the same operation | A provider-supported idempotency key can bind a retry to that operation. It does not create a shared agreement, but none is needed here. |
| Metered model request with a per-request ceiling and actual usage settlement under that ceiling | The limit and settlement are request-scoped; agreement state across calls adds no necessary evidence if terms are otherwise uniform. |
| Provider-side recurring monitor, refund, or customer-support state | The provider can manage this state internally by payer when no external party needs a shared, verifiable agreement binding. |

This boundary is intentionally narrow: idempotency addresses duplicate effects for the same logical request; it does not bind distinct requests to common negotiated terms. Conversely, the fact that it does not solve cross-request agreement binding is not, by itself, evidence that a provider needs ALSP.

## Candidate use cases that could justify ALSP

The examples in this section are **hypotheses to validate with providers and buyers**, unless an evidence note below explicitly says otherwise.

| Candidate | Shared evidence that may be needed | Evidence status |
| --- | --- | --- |
| Buyer-specific volume tier across many independent API calls | Provider-approved buyer/agreement ID, price schedule version or terms hash, effective period, and linkage of each settled call to that agreement. Per-call payment evidence alone may show what was paid, not which negotiated schedule governed the series. | Plausible candidate; Agent402.tools named volume pricing as a case where this may matter, but no deployment or broader demand is established. |
| Negotiated service-level agreement across paid requests | The applicable SLA/version and agreement scope must be identifiable across calls; separate telemetry or receipts would still be needed to establish uptime, latency, or other performance. | Plausible candidate; Agent402.tools named service levels as a possible case. No SLA implementation or demand evidence was supplied. |
| Enterprise/agent purchasing mandate with an agreed total cap and expiry across vendors or services | Provider-recognized scope, expiry, and budget context tied to the purchases, plus independently verifiable settlement records. | Design hypothesis only; not confirmed by the email or issue discussion. A buyer's local spending limit may suffice when no provider-side recognition or third-party audit is needed. |
| Contracted license or usage grant consumed through repeated paid calls | The license/usage terms version and the calls that consumed it, with provider assent and any required usage measurements. | Design hypothesis only; not confirmed demand. Licensing policy and usage metering remain application concerns. |

For each candidate, ALSP should be considered only if a real workflow has a named counterparty, a concrete failure or audit question, and a requirement for shared evidence. If the buyer only wants a private spending journal, a local session can be useful but does not demonstrate bilateral ALSP need.

## Agent402.tools: one provider's counterexample and boundary case

On 2026-10-08, Agent402.tools replied to a question about whether it needed agreement state across calls in its current service model. The sender said:

- each 402 response carries a request price or a metered-call ceiling, with settlement at actual usage under that ceiling;
- an optional `Idempotency-Key` binds a retry to the same request;
- the same published terms apply to every call, without per-buyer terms versioning;
- recurring-monitor and refund state is kept internally by payer; and
- the gap could matter more when a buyer and provider negotiate custom terms, such as volume pricing or service levels, and need to prove which version applied to each payment.

This is a concrete **provider-reported counterexample** to needing ALSP for that provider's described current model. It is also consistent with the narrower candidate use cases above. It does not establish that every Agent402 product behaves this way, and it does not represent the x402 ecosystem as a whole.

The email says it was sent by an AI assistant on behalf of Agent402.tools and may precede human review. Treat it as attributed operational testimony, not independent verification of production behavior or market research. No implementation artifacts, transaction records, customer interviews, or provider-side tests were included with the reply.

## Evidence ledger and limits

| Evidence | What it supports | What it does not establish |
| --- | --- | --- |
| Agent402.tools email, received 2026-10-08 22:29 KST | One provider-reported workflow where per-request pricing/ceiling, same-request idempotency, uniform public terms, and provider-managed payer state are considered sufficient; the sender identified negotiated volume pricing/SLA terms as a possible boundary case. | Independent operational verification, human-reviewed testimony, frequency of this model, demand from other providers, or ecosystem-wide conclusions. |
| x402 issue [#3646](https://github.com/x402-foundation/x402/issues/3646) | A proposal and open questions about binding multiple independent payments to one provider-recognized agreement; the issue body is a design proposal. | Community endorsement, maintainer interest, validated demand, or adoption. The issue had no comments in the 2026-10-08 snapshot. |
| ALSP [PR #7](https://github.com/Kairose-master/ALSP/pull/7) and [PR #12](https://github.com/Kairose-master/ALSP/pull/12) | A buyer-side Base/USDC run grouped three ordinary x402 `exact` payments into one bounded session; PR #12 records that provider-side cross-check remains pending. | Provider assent to ALSP terms/session ID, bilateral interoperability, or proof that a production provider needs the extension. |
| ALSP buyer-sealed archive and local session model | A buyer can preserve a tamper-evident record of its selected terms and linked interactions. | Provider acceptance, record completeness, billing fairness, or a mutually recognized agreement unless the provider separately assents. |

## Claims and next validation

The evidence supports a scoped statement: **ALSP may address a cross-payment agreement-evidence gap when parties negotiate shared terms and need provider-recognized proof across several independently settled calls.** It does not support a claim that providers generally need ALSP or that x402 has adopted it.

The next useful validation is targeted, not a broad adoption claim:

1. Ask providers that offer negotiated buyer-specific pricing or SLAs how they currently version terms and correlate payments to them.
2. Ask whether a buyer, provider, or downstream auditor has actually faced a dispute or reconciliation problem that request-level receipts and provider records did not resolve.
3. Test whether the provider would recognize an agreement identifier and terms commitment on each applicable payment, and what evidence it would sign or retain.
4. Record counterexamples where public terms, per-request limits, idempotency, or provider-internal state already solve the stated need.
5. Keep demand evidence, implementation evidence, and standards feedback separate. A working buyer-side prototype or an unanswered standards issue is not provider demand.

Until that evidence exists, keep ALSP experimental and optional, and describe the shared-agreement use case as a hypothesis under validation.
