// Smoke test for the live Claude connection: one tiny structured-output call.
// Usage: node scripts/claude-smoke.mjs   (reads poc/.env; never prints the key)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    const quoted = m[2].match(/^(['"])(.*)\1$/);
    process.env[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '').trim(); // drop inline "# comment"
  }
}
const llm = await import('../src/llm.js');
console.log('engine:', llm.engineInfo());
const r = await llm.structured({
  system: 'Reply with JSON.',
  prompt: 'Say hello in five words or fewer.',
  schema: { type: 'object', additionalProperties: false, required: ['greeting'], properties: { greeting: { type: 'string' } } },
  effort: 'low',
});
console.log(JSON.stringify({ ok: r.ok, data: r.data, error: r.error, model: r.model, usage: r.usage && { input: r.usage.input_tokens, output: r.usage.output_tokens } }, null, 2));
process.exit(r.ok ? 0 : 1);
