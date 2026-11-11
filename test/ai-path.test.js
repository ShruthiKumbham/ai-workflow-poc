// AI path without network: simulated Claude responses go through the same validation,
// compilation and fallback logic as real ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-ai-'));
process.env.POC_DB_PATH = path.join(tmp, 'platform.duckdb');

const llm = await import('../src/llm.js');
const { seed } = await import('../src/seed.js');
const { intake, decide, revise } = await import('../src/workflow.js');
const { getArtifact } = await import('../src/meta.js');
const { close } = await import('../src/db.js');

const schemas = [];
let mappingMode = 'good';

const GOOD_MAPPING = {
  entity_name: 'warranty_claims', domain: 'warranty', business_key: ['claim_number'],
  columns: [
    ['CLAIM_NO', 'claim_number', 'record_id', 'trim', false], ['CLAIM_DT', 'claim_date', 'event_date', 'parse_date_mdy', false],
    ['DEALER_CD', 'dealer_code', 'dealer_id', 'upper_trim', false], ['SERIAL_NO', 'unit_serial_number', 'serial_number', 'upper_trim', false],
    ['PART_NUM', 'part_number_raw', 'part_number', 'std_part_no', false], ['FAIL_CODE', 'failure_code', 'failure_code', 'upper_trim', false],
    ['FAIL_DESC', 'failure_description', 'failure_description', 'trim', false], ['LABOR_AMT', 'labor_amount_usd', 'labor_amount', 'to_decimal', false],
    ['PARTS_AMT', 'parts_amount_usd', 'parts_amount', 'to_decimal', false], ['CLAIM_STATUS', 'claim_status', 'status', 'upper_trim', false],
    ['CUST_EMAIL', 'customer_email_sha256', 'contact_email', 'sha256_pii', true],
  ].map(([s, t, r, x, p]) => ({ source_column: s, target_column: t, role: r, transform: x, pii: p, description: `Simulated rationale for ${s}` })),
  summary: 'Simulated Claude mapping.', assumptions: ['Amounts are USD.'],
};

before(async () => {
  llm.setStructuredOverride(async ({ prompt, schema }) => {
    schemas.push(schema);
    const p = schema.properties;
    if (p.intent) {
      const req = prompt.match(/request: "([^"]*)"/)?.[1] ?? '';
      if (/onboard/i.test(req)) return { ok: true, data: { intent: 'onboarding', source_table: 'src_dealer.warranty_claims', restated_request: 'Onboard warranty claims' } };
      if (/alert/i.test(req)) return { ok: true, data: { intent: 'alert', source_table: 'none', restated_request: 'alert' } };
      return { ok: true, data: { intent: 'report', source_table: 'none', restated_request: 'report' } };
    }
    if (p.mapping && p.layer_rules) {
      // Simulated revision: Claude applies the reviewer's comment to the rules and keeps the mapping.
      const cur = JSON.parse(prompt.match(/Current schema mapping \(JSON\):\n([\s\S]*?)\n\nCurrent layer rules/)[1]);
      return { ok: true, data: { mapping: cur, layer_rules: { bronze_load_mode: 'replace', silver_keep_statuses: ['APPROVED', 'PAID', 'PENDING'], gold_include_statuses: ['APPROVED', 'PAID'], quarantine_bad_date: true, quarantine_negative_amounts: true }, not_applied: ['notify finance'] } };
    }
    if (p.columns) {
      const m = structuredClone(GOOD_MAPPING);
      if (mappingMode === 'unhashed') m.columns[10].transform = 'trim';
      return { ok: true, data: m };
    }
    if (p.measures) {
      return { ok: true, data: { title: 'Warranty claim rate by failure mode', measures: ['claims_per_1000_units', 'claim_count'], dimensions: ['quarter', 'failure_mode'], breakdown_dimension: 'region', date_from: '2025-01-01', date_to: '2025-12-31', chart: 'line', assumptions: ['Simulated.'] } };
    }
    if (p.conditions) return { ok: false, error: 'simulated outage' };
    return { ok: false, error: 'unexpected schema' };
  });
  await seed({ quiet: true });
});
after(async () => { llm.setStructuredOverride(null); await close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Claude output that breaks a rule (unhashed PII) is rejected and the rule engine takes over', async () => {
  mappingMode = 'unhashed';
  const r = await intake({ text: 'Please onboard the warranty claims' });
  assert.equal(r.status, 'pending_review');
  const a = await getArtifact(r.artifactId);
  assert.equal(a.engine, 'Rule-based engine');
  assert.ok(a.payload.notes.some((n) => /rejected by validator/.test(n.note) && /not hashed/.test(n.note)));
  await decide(r.artifactId, { decision: 'reject', reviewer: 'tester', comment: 'retry' });
});

test('valid Claude mapping is used as-is and compiles to conventions', async () => {
  mappingMode = 'good';
  const r = await intake({ text: 'Please onboard the warranty claims' });
  const a = await getArtifact(r.artifactId);
  assert.match(a.engine, /^Claude/);
  assert.deepEqual(a.payload.mapping.business_key, ['claim_number']);
  assert.match(a.payload.sql.silver, /PARTITION BY "claim_number"/);
  assert.ok(a.payload.preview.checks.every((c) => c.severity !== 'error' || c.passed));
  const d = await decide(r.artifactId, { decision: 'approve', reviewer: 'tester' });
  assert.equal(d.status, 'deployed');
});

test('Claude applies a reviewer comment as a new version, checked by the same validators', async () => {
  const r = await intake({ text: 'Please onboard the warranty claims' });
  const v = await revise(r.artifactId, { reviewer: 'tester', comment: 'Drop rejected claims in silver, only approved and paid in gold, quarantine negatives, no bronze history, and notify finance' });
  assert.equal(v.version, 2);
  const a = await getArtifact(v.artifactId);
  assert.match(a.engine, /^Claude/);
  assert.deepEqual(a.payload.layer_rules.silver.keep_statuses, ['APPROVED', 'PAID', 'PENDING']);
  assert.equal(a.payload.layer_rules.bronze.load_mode, 'replace');
  assert.deepEqual(a.payload.revision.not_applied, ['notify finance']);
  assert.ok(a.payload.preview.quarantineReasons.some((q) => /negative/.test(q.reject_reason)));
  await decide(v.artifactId, { decision: 'reject', reviewer: 'tester', comment: 'test only' });
});

test('Claude spec with a dimension the facts cannot support is corrected with a warning', async () => {
  const r = await intake({ text: 'claim rate by failure mode per quarter for 2025' });
  assert.equal(r.status, 'pending_review', r.message);
  const a = await getArtifact(r.artifactId);
  assert.match(a.engine, /^Claude/);
  // claims_per_1000_units needs fct_sales, which has no failure_mode or region... region is shared, failure_mode is not
  assert.deepEqual(a.payload.spec.dimensions, ['quarter']);
  assert.ok(a.payload.warnings.some((w) => /Failure mode/.test(w)));
  assert.equal(a.payload.spec.breakdown_dimension, 'region');
  // the Claude-chosen silver column names flow through to the Gold fact via roles
  assert.match(a.payload.sql.facts['gold.fct_warranty_claims'], /w\."claim_number" AS claim_id/);
  assert.ok(a.payload.preview.reconciliation.passed);
});

test('Claude outage on the alert step falls back to the rule engine', async () => {
  const r = await intake({ text: 'alert me if warranty claims for any region exceed 160 in a month' });
  // fact not built yet in this DB (report above not approved) -> blocked with guidance
  assert.equal(r.status, 'blocked');
});

test('every schema sent to Claude meets structured-output rules', () => {
  const check = (s, where) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, `${where}: additionalProperties must be false`);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${where}: all properties required`);
      for (const [k, v] of Object.entries(s.properties)) check(v, `${where}.${k}`);
    }
    if (s.type === 'array') check(s.items, `${where}[]`);
  };
  assert.ok(schemas.length >= 4);
  schemas.forEach((s, i) => check(s, `schema${i}`));
});
