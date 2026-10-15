/**
 * t54 XRPL x402 facilitator integration boundary.
 * Read-only capability discovery. This module does NOT authorize, sign, submit,
 * or settle payments. Never treat /supported as proof of successful settlement.
 */
export const T54_FACILITATORS = Object.freeze({
  testnet: 'https://xrpl-facilitator-testnet.t54.ai',
  mainnet: 'https://xrpl-facilitator-mainnet.t54.ai',
});
export type T54Environment = keyof typeof T54_FACILITATORS;
export type T54Capability = { environment: T54Environment; facilitator: string; supported: unknown };

export class T54Error extends Error {
  constructor(message: string, public readonly status?: number) { super(message); this.name = 'T54Error'; }
}
export function t54Network(environment: T54Environment): string {
  if (environment === 'mainnet') return 'xrpl:0';
  if (environment === 'testnet') return 'xrpl:1';
  throw new T54Error('Unsupported t54 environment');
}
export async function discoverT54(
  environment: T54Environment = 'testnet',
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<T54Capability> {
  const facilitator = T54_FACILITATORS[environment];
  if (!facilitator) throw new T54Error('Unsupported t54 environment');
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new T54Error('Invalid timeout');
  const response = await (options.fetchImpl ?? fetch)(facilitator + '/supported', {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) throw new T54Error('t54 /supported failed', response.status);
  const supported: unknown = await response.json();
  if (!supported || typeof supported !== 'object' || Array.isArray(supported))
    throw new T54Error('Invalid t54 capability response');
  return { environment, facilitator, supported };
}
