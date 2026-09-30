# ALSP v0.1 — Initial Protocol Snippet

ALSP models paid knowledge/tool access as a **license session**, not as a file sale.

## Lifecycle

```text
terms presented
  -> x402 CHECK-IN payment
  -> SessionRegistry.openSession()
  -> licensed service access
  -> hash-linked usage checkpoints
  -> checkout quote
  -> x402 CHECK-OUT payment
  -> SessionRegistry.settleCheckout()
  -> closed session receipt
```

Access expiry and settlement default are intentionally separate. Expiry stops new service calls; it does not erase accepted debt and does not by itself mark the buyer as delinquent.

## Hash linkage

The reference profile starts with:

```text
H0 = termsHash
H1 = hash(sessionId, seq=1, prev=H0, usageReceipt1)
H2 = hash(sessionId, seq=2, prev=H1, usageReceipt2)
...
Hn = checkout / settlement event
```

The contract stores only the current head and sequence. Evidence documents and signatures remain off-chain and must be retained by both parties. Merkle batching may be added later for checkpoint inclusion; it does not prove semantic truth or log completeness.

## Trust boundary

The Solidity snippet deliberately uses a **payment attestor role**. Standard x402 transfers do not automatically execute arbitrary ALSP contract methods. The attestor must validate a payment's chain, token, payer, payee, amount, phase, terms/session binding and uniqueness before calling `openSession` or `settleCheckout`.

This is a compatibility design, not a trustless-payment claim. A future same-chain router could make payment and registry transition atomic.

## Provider-local restriction

If a non-zero checkout charge is frozen and remains unpaid past `settlementDue`, the session can become `Overdue`. The provider may then reject **new** check-ins from that buyer.

The restriction is deliberately local to `(provider, buyer)`. It does not create a global blacklist. An overdue buyer must still be able to inspect evidence, dispute, reconcile and pay.

## Not implemented yet

- x402 payment adapter and durable idempotency journal
- buyer/provider EIP-712 usage acknowledgment validation
- dispute state and resolution authority
- activation/payment crash recovery
- test vectors and property tests
- real payment integration
- smart-account signature profile
- legal enforceability or DRM

Whitepaper: https://handsel.gitbook.io/alsp-whitepaper/
