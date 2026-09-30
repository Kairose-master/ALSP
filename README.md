# ALSP

**Agent License Session Protocol** — an experimental check-in / licensed-access / check-out settlement protocol for AI agents.

ALSP treats paid knowledge and tool access as a bounded session:

```text
CHECK-IN payment
  -> immutable license terms
  -> scoped service access
  -> hash-linked accepted usage
  -> CHECK-OUT payment
  -> settled / overdue session state
```

The core distinction is simple:

> License expiry stops new access. It does not erase an already accepted settlement obligation — and expiry alone is not proof of default.

## Initial snippet

- `contracts/ALSPRegistry.sol` — EVM session state-machine sketch
- `docs/PROTOCOL.md` — trust boundaries and lifecycle
- `examples/checkin.json` — synthetic check-in terms
- `examples/checkout.json` — synthetic checkout quote

This is **research code**, not deployed or audited production infrastructure. The current registry trusts a configured payment attestor; it does not independently verify x402 settlement.

## Whitepaper

Bilingual GitBook: https://handsel.gitbook.io/alsp-whitepaper/

## Current research questions

1. Does license-bound session settlement solve a real provider/customer problem better than ordinary API subscriptions or invoicing?
2. Can payment confirmation and registry transitions be made crash-safe without duplicate charges?
3. Which usage facts can be jointly acknowledged mechanically, and which remain legal/off-chain assertions?
4. Does provider-local loss of future access meaningfully deter default under weak identity assumptions?

## License

No software license has been selected yet. Do not infer permission to deploy or redistribute from repository visibility alone.
