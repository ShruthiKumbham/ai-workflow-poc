// Review feedback (Nov 2026): request changes, editable Bronze/Silver/Gold layer rules,
// multi-condition alerts and report presentation choices. Runs offline with the rule engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-fb-'));
process.env.POC_DB_PATH = path.join(tmp, 'platform.duckdb');
process.env.AI_ENGINE = 'rules';

const { createApp, ensureSeeded } = await import('../src/server.js');
const { close } = await import('../src/db.js');

let server, base;
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const art = async (id) => (await call('GET', `/api/artifacts/${id}`)).body;
const approve = (id, extra = {}) => call('POST', `/api/artifacts/${id}/decision`, { decision: 'approve', reviewer: 'Test Steward', ...extra });
const revise = (id, body) => call('POST', `/api/artifacts/${id}/revise`, { reviewer: 'Test Steward', ...body });

before(async () => {
  await ensureSeeded();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let v1, v2;
test('onboarding proposes default layer rules and shows each layer', async () => {
  const r = await call('POST', '/api/intake', { text: 'Onboard warranty claims from the dealer portal' });
  v1 = r.body.artifactId;
  const p = (await art(v1)).payload;
  assert.deepEqual(p.layer_rules.status_values, ['APPROVED', 'PAID', 'PENDING', 'REJECTED']);
  assert.equal(p.layer_rules.bronze.load_mode, 'append');
  assert.deepEqual(p.layer_rules.gold.include_statuses, ['APPROVED', 'PAID', 'PENDING']);
  assert.match(p.sql.bronze, /INSERT INTO bronze\.dealer__warranty_claims BY NAME/);
  assert.ok(p.rule_descriptions.some((d) => d.layer === 'gold' && /REJECTED excluded/.test(d.rule)));
  const flow = Object.fromEntries(p.preview.layers.statusFlow.map((s) => [s.status, s]));
  assert.equal(flow.REJECTED.in_silver, true);
  assert.equal(flow.REJECTED.in_gold, false);
  assert.ok(p.preview.layers.bronzeSample.length > 0 && p.preview.layers.goldRows > 0);
});

test('request changes needs a comment or an edit, and reports what it could not apply', async () => {
  const empty = await revise(v1, { comment: '' });
  assert.equal(empty.status, 400);
  const vague = await revise(v1, { comment: 'Looks a bit off to me' });
  assert.equal(vague.status, 400);
  assert.match(vague.body.error, /not understood/);
});

test('a reviewer comment produces version 2 with the requested layer rules', async () => {
  const r = await revise(v1, { comment: 'Rename CLAIM_NO to claim_id. Keep only APPROVED and PAID in silver. Quarantine negative amounts.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.version, 2);
  v2 = r.body.artifactId;
  assert.equal((await art(v1)).status, 'superseded');
  const p = (await art(v2)).payload;
  assert.equal(p.revision.parent_id, v1);
  assert.equal(p.mapping.columns.find((c) => c.source_column === 'CLAIM_NO').target_column, 'claim_id');
  assert.deepEqual(p.layer_rules.silver.keep_statuses, ['APPROVED', 'PAID']);
  assert.deepEqual(p.layer_rules.gold.include_statuses, ['APPROVED', 'PAID']);
  assert.equal(p.layer_rules.silver.quarantine_negative_amounts, true);
  assert.match(p.sql.silver, /kept AS/);
  assert.ok(p.preview.counts.excluded_by_rule > 0);
  assert.ok(p.preview.quarantineReasons.some((q) => /negative/.test(q.reject_reason)));
  const c = p.preview.counts;
  assert.equal(c.bronze, c.silver + c.quarantine + c.excluded_by_rule + c.duplicates_removed);
  assert.equal((await approve(v1)).status, 409, 'superseded version cannot be approved');
});

test('edits made on the review screen are applied directly', async () => {
  const r = await revise(v2, { edits: { layer_rules: { gold_include_statuses: ['APPROVED'] }, columns: [{ source_column: 'FAIL_DESC', target_column: 'failure_text' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = (await art(r.body.artifactId)).payload;
  assert.equal(p.revision.version, 3);
  assert.deepEqual(p.layer_rules.gold.include_statuses, ['APPROVED']);
  assert.ok(p.revision.history.length === 2);
  // put Gold back to APPROVED + PAID for the rest of the run
  const back = await revise(r.body.artifactId, { comment: 'include PAID in gold' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  v2 = back.body.artifactId;
  assert.deepEqual((await art(v2)).payload.layer_rules.gold.include_statuses, ['APPROVED', 'PAID']);
  const d = await approve(v2, { acceptSuggestions: true });
  assert.equal(d.body.status, 'deployed', JSON.stringify(d.body));
});

let reportArtifact;
test('report Gold fact follows the onboarding rules and still reconciles to source', async () => {
  const r = await call('POST', '/api/intake', { text: 'Quarterly warranty cost by product line for 2025 as a stacked column chart, executive layout' });
  assert.equal(r.body.status, 'pending_review', r.body.message);
  reportArtifact = r.body.artifactId;
  const p = (await art(reportArtifact)).payload;
  assert.equal(p.spec.chart, 'stacked_column');
  assert.equal(p.spec.layout, 'executive');
  assert.match(p.sql.facts['gold.fct_warranty_claims'], /IN \('APPROVED', 'PAID'\)/);
  assert.ok(p.preview.reconciliation.passed, JSON.stringify(p.preview.reconciliation.lines));
  assert.match(p.preview.reconciliation.lines[0].rule, /APPROVED, PAID/);
});

test('report presentation can be changed through request changes', async () => {
  const r = await revise(reportArtifact, { comment: 'Use a line chart and add average claim cost' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = (await art(r.body.artifactId)).payload;
  assert.equal(p.spec.chart, 'line');
  assert.ok(p.spec.measures.includes('avg_claim_cost'));
  assert.ok(p.preview.reconciliation.passed);
  const t = await revise(r.body.artifactId, { edits: { layout: 'scorecard', chart: 'table' } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const d = await approve(t.body.artifactId);
  assert.equal(d.body.status, 'deployed', JSON.stringify(d.body));
  const rep = (await call('GET', `/api/reports/${d.body.result.reportId}`)).body;
  assert.equal(rep.data.layout, 'scorecard');
  assert.equal(rep.data.chart, 'table');
  const pdf = await fetch(`${base}/api/reports/${d.body.result.reportId}/pdf`);
  assert.equal(pdf.status, 200);
});

test('alerts can combine several conditions with AND / OR', async () => {
  const r = await call('POST', '/api/intake', { text: 'Alert me when monthly warranty cost for any product line rises more than 50% month over month and claims exceed 100' });
  assert.equal(r.body.status, 'pending_review', r.body.message);
  const p = (await art(r.body.artifactId)).payload;
  assert.equal(p.spec.conditions.length, 2);
  assert.equal(p.spec.combine, 'all');
  assert.deepEqual(p.spec.conditions.map((c) => c.measure), ['warranty_cost', 'claim_count']);
  assert.deepEqual(p.spec.conditions.map((c) => c.condition), ['pct_increase_gt', 'value_gt']);
  for (const row of p.preview.rows) assert.equal(row.triggered, row.met_1 && row.met_2);
  const any = await revise(r.body.artifactId, { comment: 'Fire when any condition holds' });
  assert.equal(any.status, 200, JSON.stringify(any.body));
  const q = (await art(any.body.artifactId)).payload;
  assert.equal(q.spec.combine, 'any');
  assert.ok(q.preview.triggered_count >= p.preview.triggered_count);
  for (const row of q.preview.rows) assert.equal(row.triggered, row.met_1 || row.met_2);
  const add = await revise(any.body.artifactId, { comment: 'Change 100 to 120' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal((await art(add.body.artifactId)).payload.spec.conditions[1].threshold, 120);
  const d = await approve(add.body.artifactId);
  assert.equal(d.body.status, 'deployed');
});

test('re-onboarding with an incremental load keeps Bronze history and rebuilds Gold', async () => {
  const r = await call('POST', '/api/intake', { text: 'Onboard warranty claims from the dealer portal' });
  const rev = await revise(r.body.artifactId, { edits: { layer_rules: { bronze_load_mode: 'incremental' } } });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const p = (await art(rev.body.artifactId)).payload;
  assert.match(p.sql.bronze, /WHERE coalesce\(/);
  assert.equal(p.preview.counts.bronze_batch, 0, 'nothing newer than the watermark');
  assert.ok(p.preview.checks.find((c) => /completeness/.test(c.name)).passed);
  const d = await approve(rev.body.artifactId);
  assert.equal(d.body.status, 'deployed', JSON.stringify(d.body));
  assert.deepEqual(d.body.result.rebuilt, ['gold.fct_warranty_claims']);
  const again = await call('POST', '/api/intake', { text: 'Warranty cost by region for 2025' });
  const a = (await art(again.body.artifactId)).payload;
  assert.ok(a.plan.reuse.includes('gold.fct_warranty_claims'));
  assert.ok(a.preview.reconciliation.passed, JSON.stringify(a.preview.reconciliation.lines));
  const audit = (await call('GET', '/api/audit')).body.map((x) => x.action);
  assert.ok(audit.includes('artifact.changes_requested'));
});
