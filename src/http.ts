import { DOCTOR, object, pack, unpack, type Prepared, type WireResponse } from './protocol.js';

export const INTEROP_USER_AGENT = 'alsp-interop/001';

/** No automatic retries, redirects, paid fetch wrappers, cookies or credentials. */
export async function boundedFetch(url: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<{ status: number; headers: Headers; body: unknown }> {
  const u = new URL(url);
  if (u.origin !== DOCTOR || !['/api/v1/preflight', '/.well-known/x402-doctor-signer.json'].includes(u.pathname) || u.username || u.password || u.hash) throw new Error('Unapproved upstream');
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', INTEROP_USER_AGENT);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('HTTP timeout; payment outcome may be unknown')); }, 30000); });
  const task = (async () => {
    const response = await fetchImpl(url, { ...init, headers, redirect: 'manual', credentials: 'omit', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) throw new Error('Redirect refused');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error('Response too large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) as unknown : null };
  })();
  try { return await Promise.race([task, deadline]); }
  finally { clearTimeout(timeout!); controller.abort(); }
}
export function doctorTransport(fetchImpl: typeof fetch = fetch) {
  return {
    async probe(url: string): Promise<unknown> {
      const r = await boundedFetch(url, { method: 'GET' }, fetchImpl);
      if (r.status !== 402) throw new Error(`Expected HTTP 402, got ${r.status}`);
      const challenge = unpack(r.headers.get('payment-required'));
      // A non-empty JSON body is a mirror, not an alternative authority.
      if (r.body && Object.keys(object(r.body)).length && object(r.body).x402Version !== undefined) {
        const { canonical } = await import('./protocol.js');
        if (canonical(r.body) !== canonical(challenge)) throw new Error('Conflicting challenge body/header');
      }
      return challenge;
    },
    async send(url: string, payment: Prepared): Promise<WireResponse> {
      const payload = { x402Version: 2, resource: payment.quote.resource, accepted: payment.quote.accepted, payload: { signature: payment.signature, authorization: payment.authorization } };
      const r = await boundedFetch(url, { method: 'GET', headers: { 'payment-signature': pack(payload), accept: 'application/json' } }, fetchImpl);
      const header = r.headers.get('payment-response');
      return { status: r.status, body: r.body, settlement: header ? unpack(header) : null };
    },
  };
}
