// One turn of the "agent runs a session" loop. Stateless: the browser owns the transcript and
// executes every tool with its own journal and wallet; this side only asks Claude what to do next.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const MAX_MESSAGES = 80;

export const SYSTEM = `You are an autonomous buyer agent operating an ALSP x402 Exact session. You buy paid API responses with USDC under a budgeted, journaled session, and you narrate what you do for a human who is watching.

How a session works (these rules are enforced by the journal; respect them rather than fighting them):
- Terms come first: create_session commits payer, provider, two atomic budgets (maxTotal, maxPerCall), a call limit and an expiry. 1000 atomic = 0.001 USDC. Stay inside the caps the human gave you; never ask for more.
- Each paid call needs a unique request key. Reusing a key with the same input is a free replay; reusing it with different input is an error. Pick keys like "quote-btc".
- The journal commits before every side effect. A call that ends RECONCILIATION_REQUIRED may or may not have been paid: never call again with a new key to "retry" it. Use reconcile (with recover=true first if no response was stored). If it still cannot be verified, say so and leave it unresolved; do not spend around it.
- A RECONCILIATION_REQUIRED result carries lastError. "Insufficient confirmations" or an RPC error is transient: call reconcile with recover=false (at most twice). "Receipt" / "signer" / "Pinned" errors are final: the evidence was rejected, so report it and stop spending.
- Budget counts every reservation, including unresolved ones. probe_quote is free and tells you the current price before you commit.
- When the mission is done or blocked: end_session, then export_archive, then give the human a short final report: what was bought, what it cost, anything unresolved, and the archive head hash.

Style: before each tool call say in one short sentence what you are doing and why. Keep narration concrete (amounts, keys, states). Do not invent results; only report what tools returned. Respect the call limit and the mission's stated budget exactly.`;

export const TOOLS = [
  { name: 'probe_quote', description: 'Unpaid 402 probe. Returns the provider\'s current price and payout address for the given request parameters. Creates no signature.', input_schema: { type: 'object', properties: { input: { type: 'object', description: 'Request parameters, e.g. {"symbol":"BTC-USDT"} or for Doctor {"url":"https://…","method":"GET"}', additionalProperties: { type: 'string' } } }, required: ['input'], additionalProperties: false } },
  { name: 'create_session', description: 'Create the session terms. Amounts are atomic USDC strings (1000 = 0.001 USDC). Fails if above the human\'s hard caps.', input_schema: { type: 'object', properties: { maxTotal: { type: 'string' }, maxPerCall: { type: 'string' }, maxCalls: { type: 'integer', minimum: 1, maximum: 100 }, ttlSeconds: { type: 'integer', minimum: 60, maximum: 86400 }, licenseNote: { type: 'string', description: 'One line describing the provider terms you are accepting (buyer-only).' } }, required: ['maxTotal', 'maxPerCall', 'maxCalls', 'ttlSeconds', 'licenseNote'], additionalProperties: false } },
  { name: 'call', description: 'One paid call under the session: probe, reserve budget, sign once, send once, verify. Returns the call state, amount, tx and a summary of the paid response.', input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Idempotency key, [A-Za-z0-9_.-]{1,100}' }, input: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['key', 'input'], additionalProperties: false } },
  { name: 'reconcile', description: 'Resolve a RECONCILIATION_REQUIRED call using its original evidence. With recover=true, first ask the provider for the original response for that call\'s nonce (if it supports lookup). Never creates a payment.', input_schema: { type: 'object', properties: { callId: { type: 'string' }, recover: { type: 'boolean' } }, required: ['callId', 'recover'], additionalProperties: false } },
  { name: 'session_status', description: 'Current session summary: state, allocated, verified spent, unresolved calls, remaining calls and budget.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'end_session', description: 'Stop new calls. Exported state becomes CLOSED if every call is VERIFIED, else RECONCILIATION_REQUIRED.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'resume_session', description: 'Reopen an ended session to continue within its original cap. Refused while any call is unresolved.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'export_archive', description: 'Export the hash-chained archive and verify the chain. Returns summary, event count and head hash.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

function validMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) throw new Error(`messages must be 1..${MAX_MESSAGES} entries`);
  for (const m of value) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw new Error('Invalid message role');
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) throw new Error('Invalid message content');
  }
  if (value[0].role !== 'user') throw new Error('First message must be from the user');
  return value;
}

export function agentEnabled() { return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

/** Runs one model turn. `deps.client` lets tests inject a fake Anthropic client. */
export async function agentTurn(body, deps = {}) {
  const messages = validMessages(body.messages);
  const client = deps.client ?? (agentEnabled() ? new Anthropic({ maxRetries: 1, timeout: 60_000 }) : null);
  if (!client) return [503, { error: 'Agent mode is not configured on this deployment (set ANTHROPIC_API_KEY).' }];
  try {
    const response = await client.messages.create({
      model: deps.model ?? MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    });
    return [200, { content: response.content, stop_reason: response.stop_reason, stop_details: response.stop_details ?? null, model: response.model, usage: { input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens, cache_read_input_tokens: response.usage?.cache_read_input_tokens } }];
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return [503, { error: 'Agent mode: the deployment\'s Anthropic credential was rejected.' }];
    if (err instanceof Anthropic.RateLimitError) return [429, { error: 'Agent mode: rate limited, try again shortly.' }];
    if (err instanceof Anthropic.APIError) return [502, { error: `Agent mode: model API error ${err.status}: ${err.message}` }];
    throw err;
  }
}
