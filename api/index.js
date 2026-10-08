// Vercel serverless entry point. Every request is self-contained: the demo runs a full session
// scenario in-process (mock provider + mock ledger + in-memory journal) and returns the trace.
import { handle } from '../demo/handler.mjs';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 65536) break; }
  const [status, payload] = await handle(req.method, url.pathname, body, { query: url.search.slice(1) });
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(status).send(JSON.stringify(payload));
}
