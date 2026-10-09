// Offline-only provider for the experimental ALSP fixed-price agreement profile.
// No request leaves this process. The ledger and all money below are fictitious.
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AUTHORIZATION_TYPES, address, agreementLink, atomic, canonical, chainIdOf,
  endpointUrl, hash32, object, pack, providerOfferMessage, unpack,
  validateAgreementTime, validatePriceAgreementTerms, verifyPriceAgreement,
} from '../../dist/index.js';
import { createMockProvider, DEMO_PAYTO_KEY, DEMO_SIGNER_KEY, DEMO_STRANGER_KEY } from '../../test/mock-provider.mjs';

const clone = value => JSON.parse(canonical(value));
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

/**
 * A deliberately in-process fixture, not an HTTP server or production facilitator.
 * Registered agreement allowances are shared by every session using this instance.
 * Reservations are synchronous after signature checks, so concurrent requests cannot
 * overspend; a failure after reservation never frees allowance or the nonce.
 */
export function createPriceAgreementProvider({
  origin = 'https://agreement.alsp.local', publicPrice = '1000', unitPrice = '600',
  network = 'eip155:31337', now = Date.now,
} = {}) {
  if (atomic(unitPrice) <= 0n || atomic(publicPrice) <= 0n) throw new Error('Positive fixture prices required');
  const base = createMockProvider({ origin, price: unitPrice, network });
  const { profile, endpoint, rpcUrl, signer, payTo } = base;
  const providerAccount = privateKeyToAccount(DEMO_PAYTO_KEY);
  const receiptAccount = privateKeyToAccount(DEMO_SIGNER_KEY);
  const strangerAccount = privateKeyToAccount(DEMO_STRANGER_KEY);
  const agreements = new Map(), spentNonces = new Set(), recovered = new Map();
  const acceptedCalls = [];
  let currentPublicPrice = publicPrice;

  function checkProviderTerms(terms) {
    validatePriceAgreementTerms(terms);
    if (address(terms.provider) !== address(payTo) || terms.network !== profile.network ||
        address(terms.asset) !== address(profile.asset.address) || terms.endpoint !== endpointUrl(profile) ||
        terms.method !== profile.method || terms.unitPrice !== unitPrice) {
      throw new Error('Agreement does not match this fixture provider and its fixed price');
    }
  }

  async function createOffer(terms) {
    const copy = clone(terms);
    checkProviderTerms(copy);
    return { terms: copy, providerSignature: await providerAccount.signMessage({ message: providerOfferMessage(copy) }) };
  }

  async function register(agreement) {
    const copy = clone(agreement);
    checkProviderTerms(copy.terms);
    await verifyPriceAgreement(copy, now());
    // Recheck after the asynchronous verification; never replace a registration.
    const existing = agreements.get(copy.terms.agreementId);
    if (existing && canonical(existing.agreement) !== canonical(copy)) throw new Error('Conflicting agreement identity');
    if (!existing) agreements.set(copy.terms.agreementId, { agreement: copy, calls: 0, total: 0n });
    return agreementLink(copy);
  }

  function challengeFor(url, agreement) {
    return {
      x402Version: 2, resource: { url, description: 'Offline fixed-price agreement quote' },
      accepts: [{
        scheme: 'exact', network: profile.network, asset: profile.asset.address, payTo,
        amount: agreement ? agreement.terms.unitPrice : currentPublicPrice, maxTimeoutSeconds: 120,
        extra: { name: profile.asset.name, version: profile.asset.version,
          ...(agreement ? { alspAgreement: agreementLink(agreement) } : {}) },
      }],
    };
  }

  async function registered(header) {
    const supplied = object(unpack(header));
    const terms = object(supplied.terms), record = agreements.get(terms.agreementId);
    if (!record || canonical(supplied) !== canonical(record.agreement)) throw new Error('Unregistered or altered agreement');
    await verifyPriceAgreement(record.agreement, now());
    return record;
  }

  async function decorate(wire, agreement, observedPublicPrice) {
    if (wire.status !== 200) return wire;
    const body = clone(wire.body);
    const receipt = object(body.receipt);
    delete receipt.signature;
    receipt.agreement = agreementLink(agreement);
    receipt.settlement_mode = 'mock-settled'; // Included in the provider signature; cannot be relabeled by the buyer.
    // Keep the base fixture's unpinned-key fault useful for fail-closed testing.
    const account = address(receipt.signer) === address(signer) ? receiptAccount : strangerAccount;
    receipt.signature = await account.signMessage({ message: canonical(body) });
    const settlement = { ...object(wire.settlement), mock: true };
    const result = { status: wire.status, body, settlement };
    const nonce = hash32(object(receipt.payment).nonce);
    if (!recovered.has(nonce)) {
      acceptedCalls.push({ nonce, transaction: settlement.transaction, amount: object(receipt.payment).amount,
        publicPrice: observedPublicPrice, agreement: agreementLink(agreement), settlement: 'mock-settled' });
    }
    recovered.set(nonce, result);
    return result;
  }

  async function paid(url, init, record, challenge, header) {
    const agreement = record.agreement;
    let payload, authorization, signature, nonce;
    try {
      payload = object(unpack(header));
      const payment = object(payload.payload);
      authorization = object(payment.authorization);
      signature = payment.signature;
      if (payload.x402Version !== 2 || canonical(payload.resource) !== canonical(challenge.resource) ||
          canonical(payload.accepted) !== canonical(challenge.accepts[0])) throw new Error('Quote changed');
      nonce = hash32(authorization.nonce);
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
          address(authorization.from) !== address(agreement.terms.buyer) ||
          address(authorization.to) !== address(payTo) || authorization.value !== agreement.terms.unitPrice) {
        throw new Error('Payment does not belong to agreement buyer or price');
      }
      const value = atomic(authorization.value), validAfter = atomic(authorization.validAfter), validBefore = atomic(authorization.validBefore);
      function checkTime() {
        const current = now(), seconds = BigInt(Math.floor(current / 1000));
        validateAgreementTime(agreement, current);
        if (validAfter > seconds || validBefore <= seconds || validBefore > seconds + 120n ||
            validBefore * 1000n > BigInt(agreement.terms.expiresAt)) throw new Error('Payment lifetime exceeds agreement');
      }
      checkTime();
      const valid = await verifyTypedData({
        address: agreement.terms.buyer,
        domain: { name: profile.asset.name, version: profile.asset.version,
          chainId: chainIdOf(profile.network), verifyingContract: profile.asset.address },
        types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', signature,
        message: { from: authorization.from, to: authorization.to, value, validAfter, validBefore, nonce: authorization.nonce },
      });
      if (!valid) throw new Error('Invalid payment signature');
      checkTime();
    } catch {
      return json(402, { error: 'Agreement payment rejected' }, { 'payment-required': pack(challenge) });
    }

    // No await between these checks and reservation: atomic within this process.
    if (spentNonces.has(nonce)) return json(409, { error: 'Authorization already reserved or used' });
    if (record.calls >= agreement.terms.maxCalls || record.total + atomic(authorization.value) > atomic(agreement.terms.maxTotal)) {
      return json(409, { error: 'Price agreement allowance exhausted' });
    }
    spentNonces.add(nonce);
    record.calls++;
    record.total += atomic(authorization.value);
    const observedPublicPrice = currentPublicPrice;
    try {
      const response = await base.fetchImpl(url, init);
      const settlementHeader = response.headers.get('payment-response');
      const wire = { status: response.status, body: await response.json(), settlement: settlementHeader ? unpack(settlementHeader) : null };
      const result = await decorate(wire, agreement, observedPublicPrice);
      return json(result.status, result.body, result.settlement ? { 'payment-response': pack(result.settlement) } : {});
    } catch (error) {
      // Simulate recovery of a lost response without retrying or paying again.
      const original = base.recover(nonce);
      if (original) await decorate(original, agreement, observedPublicPrice);
      throw error;
    }
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    if (u.origin !== origin || u.username || u.password || u.hash) return json(404, { error: 'Unknown fixture URL' });
    if (u.pathname !== profile.endpointPath) return base.fetchImpl(url, init);
    if ((init.method ?? 'GET').toUpperCase() !== profile.method) return json(405, { error: 'Wrong method' });
    const headers = new Headers(init.headers), agreementHeader = headers.get('alsp-price-agreement');
    const paymentHeader = headers.get('payment-signature');
    let record;
    if (agreementHeader) {
      try { record = await registered(agreementHeader); }
      catch { return json(403, { error: 'A valid registered price agreement is required' }); }
    }
    const challenge = challengeFor(u.href, record?.agreement);
    if (!paymentHeader) return json(402, challenge, { 'payment-required': pack(challenge) });
    if (!record) return json(403, { error: 'This offline fixture settles registered agreements only' });
    return paid(u.href, init, record, challenge, paymentHeader);
  }

  return {
    profile, endpoint, rpcUrl, signer, payTo, fetchImpl, createOffer, register,
    // State belongs to the existing mock ledger. No live chain is involved.
    state: base.state,
    get publicPrice() { return currentPublicPrice; },
    get acceptedCalls() { return clone(acceptedCalls); },
    setPublicPrice(amount) {
      if (atomic(amount) <= 0n) throw new Error('Positive public price required');
      currentPublicPrice = amount;
    },
    allowance(agreementId) {
      const record = agreements.get(agreementId);
      return record ? { calls: record.calls, total: record.total.toString(),
        maxCalls: record.agreement.terms.maxCalls, maxTotal: record.agreement.terms.maxTotal } : null;
    },
    recover(nonce) { const wire = recovered.get(String(nonce).toLowerCase()); return wire ? clone(wire) : null; },
    setFault: base.setFault,
  };
}
