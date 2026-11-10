// AI engine. Claude proposes (mappings, requirement breakdowns, alert rules) as schema-constrained
// JSON; deterministic code validates the proposal and compiles it into SQL. If Claude is not
// configured or a call fails, the rule-based engine (rules.js) produces the proposal instead and
// the artifact records which engine was used.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const MODEL_LABEL = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-fable-5-1': 'Claude Fable 5.1' };

let client = null;
let testOverride = null;

// Test seam: substitute the model call with a function returning { ok, data } (used by tests only).
export function setStructuredOverride(fn) { testOverride = fn; }

export function claudeEnabled() {
  if (testOverride) return true;
  const mode = (process.env.AI_ENGINE || 'auto').toLowerCase();
  if (mode === 'rules') return false;
  if (mode === 'claude') return true;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function engineInfo() {
  return claudeEnabled()
    ? { mode: 'claude', model: MODEL, label: MODEL_LABEL[MODEL] || MODEL }
    : { mode: 'rules', model: null, label: 'Rule-based engine (offline mode)' };
}

function getClient() {
  if (!client) client = new Anthropic({ timeout: 180_000, maxRetries: 1 });
  return client;
}

/**
 * Ask Claude for JSON matching `schema`. Returns { ok, data, error, usage }.
 * Never throws: callers fall back to the rule engine on !ok.
 */
export async function structured({ system, prompt, schema, effort = 'medium' }) {
  if (testOverride) return testOverride({ system, prompt, schema });
  if (!claudeEnabled()) return { ok: false, error: 'Claude not configured' };
  try {
    const res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.stop_reason === 'refusal') return { ok: false, error: `Model declined (${res.stop_details?.category ?? 'unspecified'})` };
    if (res.stop_reason === 'max_tokens') return { ok: false, error: 'Response truncated at max_tokens' };
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) return { ok: false, error: 'No text block in response' };
    return { ok: true, data: JSON.parse(text), usage: res.usage, model: res.model };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Claude authentication failed - check ANTHROPIC_API_KEY' };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: 'Claude rate limited' };
    if (err instanceof Anthropic.BadRequestError) {
      if (/credit balance/i.test(err.message)) return { ok: false, error: 'Anthropic account has no API credit - add credits under Plans & Billing' };
      return { ok: false, error: `Claude rejected the request: ${err.message}` };
    }
    if (err instanceof Anthropic.APIStatusError) return { ok: false, error: `Claude API error ${err.status}` };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: 'Could not reach the Claude API' };
    if (err instanceof SyntaxError) return { ok: false, error: 'Claude returned invalid JSON' };
    return { ok: false, error: String(err?.message || err) };
  }
}

export const SYSTEM_PROMPT = `You are the AI engineering assistant inside a data-platform portal for a heavy-duty transmission manufacturer.
You turn plain-English requests from data engineers and business users into precise, reviewable specifications.
Your output is never executed directly: deterministic code validates it and compiles it into SQL that follows the platform's
medallion conventions, and a human reviewer approves every result before it goes live. So:
- Choose only from the vocabularies you are given (roles, transforms, measures, dimensions). Never invent names outside them.
- Prefer the interpretation a careful engineer or analyst would choose; state assumptions briefly where the request is ambiguous.
- Keep descriptions short, factual and useful to the reviewer.`;
