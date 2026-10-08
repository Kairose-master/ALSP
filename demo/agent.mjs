// One turn of the "agent runs a session" loop. Stateless: the browser owns the transcript and
// executes every tool with its own journal and wallet; this side only asks Claude what to do next.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const MAX_MESSAGES = 80;

export const SYSTEM = `You are an autonomous buyer agent operating an ALSP mission: one spend cap across one or more x402 providers, each used through its own budgeted, journaled session. You buy paid API responses with USDC and narrate what you do for a human who is watching.

How it works (the journal enforces these rules; respect them rather than fighting them):
- The human fixed the mission cap and the list of providers (list_providers shows their roles, endpoints and parameters). You open one session per provider you need with create_session; its own caps must fit inside the mission cap, and the mission cap counts every reservation across all sessions. 1000 atomic = 0.001 USDC.
- probe_quote is free and tells you a provider's current price before you commit.
- Each paid call needs a unique request key within its session. Reusing a key with the same input is a free replay; reusing it with different input is an error.
- The journal commits before every side effect. A call that ends RECONCILIATION_REQUIRED may or may not have been paid: never call again with a new key to "retry" it. Use reconcile (recover=true first if no response was stored). If lastError says "Insufficient confirmations" or mentions RPC, that is transient: reconcile with recover=false, at most twice. "Receipt" / "signer" / "Pinned" errors are final: report and stop spending there.
- Providers marked unsigned do not sign receipts: VERIFIED then means the USDC settlement for that call's nonce and amount was confirmed on chain; the response itself is unattested. Say so in the report.
- If a provider's answer shows it does not do what the mission needs (wrong parameter, same data regardless of input), stop paying that provider and say why; do not burn budget probing it.
- When done or blocked: end_mission (which ends every session), then export_archive, then a short final report: what was bought from whom, cost per provider and total, anything unresolved, and the mission head hash.

Style: before each tool call say in one short sentence what you are doing and why. Be concrete (amounts, keys, states). Report only what tools returned.`;

const providerArg = { type: 'string', description: 'Provider role id from list_providers, e.g. "price"' };
export const TOOLS = [
  { name: 'list_providers', description: 'The providers the human attached to this mission: role id, label, endpoint, receipt mode, known price and the parameters they accept.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'probe_quote', description: 'Unpaid 402 probe of one provider. Returns its current price and payout address for the given parameters. Creates no signature.', input_schema: { type: 'object', properties: { provider: providerArg, input: { type: 'object', description: 'Request parameters, flat string map', additionalProperties: { type: 'string' } } }, required: ['provider', 'input'], additionalProperties: false } },
  { name: 'create_session', description: 'Open the session for one provider under the mission. Amounts are atomic USDC strings. Fails if above the mission cap or if that provider already has a session.', input_schema: { type: 'object', properties: { provider: providerArg, maxTotal: { type: 'string' }, maxPerCall: { type: 'string' }, maxCalls: { type: 'integer', minimum: 1, maximum: 100 }, ttlSeconds: { type: 'integer', minimum: 60, maximum: 86400 }, licenseNote: { type: 'string', description: 'One line on the provider terms you accept (buyer-only).' } }, required: ['provider', 'maxTotal', 'maxPerCall', 'maxCalls', 'ttlSeconds', 'licenseNote'], additionalProperties: false } },
  { name: 'call', description: 'One paid call to a provider under its session: probe, reserve, sign once, send once, verify. Returns state, amount, tx and the paid response.', input_schema: { type: 'object', properties: { provider: providerArg, key: { type: 'string', description: 'Idempotency key, [A-Za-z0-9_.-]{1,100}' }, input: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['provider', 'key', 'input'], additionalProperties: false } },
  { name: 'reconcile', description: 'Resolve a RECONCILIATION_REQUIRED call with its original evidence. recover=true first asks the provider for the original response by nonce when it supports lookup. Never creates a payment.', input_schema: { type: 'object', properties: { callId: { type: 'string' }, recover: { type: 'boolean' } }, required: ['callId', 'recover'], additionalProperties: false } },
  { name: 'session_status', description: 'Mission totals (cap, allocated, verified, unresolved) and every provider session with its calls.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'end_session', description: 'Stop new calls on one provider session.', input_schema: { type: 'object', properties: { provider: providerArg }, required: ['provider'], additionalProperties: false } },
  { name: 'resume_session', description: 'Reopen an ended provider session within its original cap. Refused while any of its calls is unresolved.', input_schema: { type: 'object', properties: { provider: providerArg }, required: ['provider'], additionalProperties: false } },
  { name: 'end_mission', description: 'End the mission: ends every session and commits each session head into the mission chain.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'export_archive', description: 'Export the mission archive (all session archives under the mission chain) and verify it. Returns summary, event counts and head hash.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
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
