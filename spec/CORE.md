# ALSP Core

**Status: conceptual vocabulary, not a frozen wire standard.** This document describes common session concepts used to organize profile specifications. The current executable reference is the x402 Exact Profile; Core does not define or require its payment rules.

## Concepts

- **Session:** a bounded grouping of related operations under a terms commitment.
- **Operation:** one profile-defined action associated with a session.
- **Receipt:** a profile-defined statement about an operation and its evidence.
- **Evidence:** an artifact identified by a digest, optionally with a retrieval URI.
- **Evidence head:** a profile-defined commitment linking records in order.
- **Reconciliation:** resolving an operation whose outcome is uncertain using evidence for that original operation.

`src/core/types.ts` supplies only shared TypeScript vocabulary. It does not provide a generic session engine, canonical encoding, persistence, cryptographic verification, or state transitions. Profiles define those details and state their own trust assumptions.

## Non-requirements

Core does not require a blockchain, an on-chain registry, escrow, a payment scheme, license enforcement, provider assent, a particular hash algorithm, or a common serialization format. An implementation may use a local journal and no registry.

## Profile relationship

- [x402 Exact](./PROFILE-X402-EXACT.md) groups ordinary x402 exact payments into a local, buyer-side session. Each call settles independently.
- [License](./PROFILE-LICENSE.md) preserves the earlier check-in/check-out research model. Its Solidity registry is experimental and is not a Core dependency.

The profiles are complementary experiments, not evidence that one profile's guarantees apply to the other.
