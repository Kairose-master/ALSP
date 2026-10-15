// Vercel serverless entry point. Every request is self-contained: the demo runs a full session
// scenario in-process (mock provider + mock ledger + in-memory journal) and returns the trace.
import { handle } from '../demo/handler.mjs';
import { xrplChallenge, xrplDirectoryMetadata, XRPL_RESOURCE } from './xrpl-directory.js';
import { getXrplMerchant } from './xrpl-merchant-runtime.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === XRPL_RESOURCE || url.pathname === '/api/xrpl/directory' || url.pathname === '/.well-known/x402') {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    const configuredHost = process.env.VERCEL_URL;
    const origin = configuredHost && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i.test(configuredHost)
      ? 'https://' + configuredHost
      : 'https://alsp.vercel.app';
    const merchant = await getXrplMerchant();
    if (req.method === 'GET' && (url.pathname === '/api/xrpl/directory' || url.pathname === '/.well-known/x402')) return res.status(200).json(xrplDirectoryMetadata(origin, Boolean(merchant)));
    if (url.pathname !== XRPL_RESOURCE || req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (merchant) {
      try {
        const result = await merchant.handle(origin, req.headers['payment-signature'] || req.headers['x-payment']);
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        return res.status(result.status).json(result.body);
      } catch (error) {
        console.error('xrpl merchant failure', error instanceof Error ? error.message : 'unknown');
        return res.status(503).json({ error: 'Merchant temporarily unavailable; no payment was settled by this request' });
      }
    }
    if (req.headers['payment-signature'] || req.headers['x-payment']) return res.status(501).json({ error: 'Paid XRPL settlement not yet implemented; payment not processed' });
    const challenge = xrplChallenge(origin);
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    return res.status(402).json(challenge);
  }
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 65536) break; }
  const [status, payload] = await handle(req.method, url.pathname, body, { query: url.search.slice(1) });
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(status).send(JSON.stringify(payload));
}
