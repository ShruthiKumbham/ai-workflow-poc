// End-to-end: reference platform -> UC1 onboarding -> UC2 report -> UC3 alert, through the HTTP API,
// using the rule-based engine so it runs offline and deterministically.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-e2e-'));
process.env.POC_DB_PATH = path.join(tmp, 'platform.duckdb');
process.env.AI_ENGINE = 'rules';

const { createApp, ensureSeeded } = await import('../src/server.js');
const { close } = await import('../src/db.js');

let server, base;
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), ct };
};

before(async () => {
  await ensureSeeded();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a report that needs un-onboarded data is blocked with guidance', async () => {
  const r = await call('POST', '/api/intake', { text: 'Show monthly warranty cost by product line for 2025' });
  assert.equal(r.body.status, 'blocked');
  assert.match(r.body.message, /src_dealer\.warranty_claims/);
});

let onboardingId;
test('UC1: onboarding request produces a reviewable artifact; nothing is live yet', async () => {
  const r = await call('POST', '/api/intake', { text: 'Onboard warranty claims from the dealer portal' });
  assert.equal(r.body.status, 'pending_review', r.body.message);
  assert.equal(r.body.intent, 'onboarding');
  onboardingId = r.body.artifactId;
  const a = (await call('GET', `/api/artifacts/${onboardingId}`)).body;
  const roles = Object.fromEntries(a.payload.mapping.columns.map((c) => [c.source_column, c.role]));
  assert.equal(roles.CLAIM_NO, 'record_id');
  assert.equal(roles.PART_NUM, 'part_number');
  assert.equal(roles.CUST_EMAIL, 'contact_email');
  assert.match(a.payload.sql.bronze, /CREATE TABLE IF NOT EXISTS bronze\.dealer__warranty_claims/);
  assert.match(a.payload.sql.silver, /silver\.product_hierarchy/);
  assert.ok(a.payload.preview.checks.every((c) => c.severity !== 'error' || c.passed), 'blocking checks pass in dry run');
  assert.ok(a.payload.preview.exceptions.some((e) => e.suggestion), 'near-match part exceptions are suggested');
  // dry run must have been rolled back
  const cat = (await call('GET', '/api/catalog')).body;
  assert.ok(!cat.some((d) => d.dataset === 'silver.warranty_claims'), 'silver table is not live before approval');
});

test('approval gate requires a reviewer', async () => {
  const r = await call('POST', `/api/artifacts/${onboardingId}/decision`, { decision: 'approve', reviewer: '' });
  assert.equal(r.status, 400);
});

test('UC1: approval deploys, registers catalog + lineage + DQ', async () => {
  const r = await call('POST', `/api/artifacts/${onboardingId}/decision`, { decision: 'approve', reviewer: 'Test Steward', acceptSuggestions: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'deployed');
  const d = (await call('GET', '/api/catalog/silver.warranty_claims')).body;
  assert.equal(d.layer, 'silver');
  assert.ok(d.columns.find((c) => c.name === 'customer_email_hash')?.pii);
  assert.ok(d.dq.length > 0);
  assert.ok(d.sample.every((s) => !String(s.customer_email_hash ?? '').includes('@')), 'PII hashed');
  const lin = (await call('GET', '/api/lineage?node=silver.warranty_claims')).body;
  assert.ok(lin.nodes.includes('src_dealer.warranty_claims'));
  assert.ok(lin.nodes.includes('silver.product_hierarchy'));
  const again = await call('POST', `/api/artifacts/${onboardingId}/decision`, { decision: 'approve', reviewer: 'x' });
  assert.equal(again.status, 409, 'cannot approve twice');
});

let reportId;
test('UC2: requirement -> spec reusing fct_sales and building fct_warranty_claims; reconciles to source', async () => {
  const r = await call('POST', '/api/intake', { text: 'Show monthly warranty cost and claim rate per 1,000 units by product line for 2025, with a breakdown by region' });
  assert.equal(r.body.status, 'pending_review', r.body.message);
  const a = (await call('GET', `/api/artifacts/${r.body.artifactId}`)).body;
  const p = a.payload;
  assert.deepEqual(p.spec.measures, ['warranty_cost', 'claims_per_1000_units', 'units_sold']);
  assert.deepEqual(p.spec.dimensions, ['month', 'product_line']);
  assert.equal(p.spec.breakdown_dimension, 'region');
  assert.deepEqual(p.plan.reuse, ['gold.fct_sales']);
  assert.equal(p.plan.build[0].fact, 'gold.fct_warranty_claims');
  assert.ok(p.preview.reconciliation.passed, JSON.stringify(p.preview.reconciliation.lines));
  const d = await call('POST', `/api/artifacts/${r.body.artifactId}/decision`, { decision: 'approve', reviewer: 'Test Steward' });
  assert.equal(d.body.status, 'deployed', JSON.stringify(d.body));
  reportId = d.body.result.reportId;
});

test('UC2: published dashboard data and one-page PDF', async () => {
  const r = (await call('GET', `/api/reports/${reportId}`)).body;
  assert.equal(r.data.kpis.length, 3);
  assert.ok(r.data.time.rows.length >= 12 * 6);
  assert.ok(r.reconciliation.passed);
  assert.match(r.lineage, /src_dealer\.warranty_claims/);
  const pdf = await call('GET', `/api/reports/${reportId}/pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.ct, /application\/pdf/);
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  const pages = (pdf.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.equal(pages, 1, 'PDF is one page');
  const measures = (await call('GET', '/api/measures')).body.map((m) => m.name);
  assert.ok(measures.includes('claims_per_1000_units') && measures.includes('warranty_cost'));
});

test('UC2: second report reuses the Gold fact built by the first', async () => {
  const r = await call('POST', '/api/intake', { text: 'Warranty cost as % of revenue by vertical and quarter for 2025' });
  const a = (await call('GET', `/api/artifacts/${r.body.artifactId}`)).body;
  assert.ok(a.payload.plan.reuse.includes('gold.fct_warranty_claims'));
  assert.equal(a.payload.plan.build.length, 0);
  assert.ok(a.payload.preview.reconciliation.passed);
  const rej = await call('POST', `/api/artifacts/${r.body.artifactId}/decision`, { decision: 'reject', reviewer: 'Test Steward', comment: 'Need fiscal quarters' });
  assert.equal(rej.body.status, 'rejected');
});

test('UC3: plain-English alert rule, approved and evaluated', async () => {
  const r = await call('POST', '/api/intake', { text: 'Alert me when monthly warranty cost for any product line rises more than 50% month over month' });
  assert.equal(r.body.intent, 'alert');
  const a = (await call('GET', `/api/artifacts/${r.body.artifactId}`)).body;
  assert.equal(a.payload.spec.condition, 'pct_increase_gt');
  assert.equal(a.payload.spec.threshold, 50);
  assert.equal(a.payload.spec.dimension, 'product_line');
  const d = await call('POST', `/api/artifacts/${r.body.artifactId}/decision`, { decision: 'approve', reviewer: 'Test Steward' });
  assert.equal(d.body.status, 'deployed');
  const alerts = (await call('GET', '/api/alerts')).body;
  assert.equal(alerts.length, 1);
  const ev = (await call('POST', `/api/alerts/${alerts[0].id}/evaluate`)).body;
  assert.ok(['OK', 'TRIGGERED'].includes(ev.status));
});

test('audit trail records the full story', async () => {
  const actions = (await call('GET', '/api/audit')).body.map((a) => a.action);
  for (const a of ['request.submitted', 'artifact.generated', 'artifact.approved', 'onboarding.deployed', 'report.published', 'artifact.rejected', 'alert.activated']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
});
