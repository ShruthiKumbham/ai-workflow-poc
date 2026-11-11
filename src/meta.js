// Portal metadata: requests, artifacts (the things a reviewer approves), catalog, lineage,
// data-quality results, semantic layer, reports, alerts and an audit trail.
import crypto from 'node:crypto';
import { run, all, one } from './db.js';

export const META_DDL = `
CREATE SCHEMA IF NOT EXISTS meta;
CREATE TABLE IF NOT EXISTS meta.requests (
  id VARCHAR PRIMARY KEY, created_at TIMESTAMP, requester VARCHAR, persona VARCHAR, text VARCHAR,
  intent VARCHAR, status VARCHAR, engine VARCHAR, artifact_id VARCHAR, message VARCHAR);
CREATE TABLE IF NOT EXISTS meta.artifacts (
  id VARCHAR PRIMARY KEY, request_id VARCHAR, kind VARCHAR, title VARCHAR, status VARCHAR,
  created_at TIMESTAMP, decided_at TIMESTAMP, reviewer VARCHAR, review_comment VARCHAR,
  engine VARCHAR, summary VARCHAR, payload VARCHAR);
CREATE TABLE IF NOT EXISTS meta.catalog (
  dataset VARCHAR PRIMARY KEY, layer VARCHAR, title VARCHAR, description VARCHAR, owner VARCHAR,
  source_system VARCHAR, columns VARCHAR, row_count BIGINT, tags VARCHAR, artifact_id VARCHAR,
  registered_at TIMESTAMP, dq_status VARCHAR);
CREATE TABLE IF NOT EXISTS meta.lineage (
  from_node VARCHAR, to_node VARCHAR, transform VARCHAR, artifact_id VARCHAR, created_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS meta.dq_results (
  run_id VARCHAR, artifact_id VARCHAR, stage VARCHAR, dataset VARCHAR, check_name VARCHAR,
  severity VARCHAR, failed BIGINT, total BIGINT, threshold VARCHAR, passed BOOLEAN, detail VARCHAR, run_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS meta.measures (
  name VARCHAR PRIMARY KEY, label VARCHAR, kind VARCHAR, fact_table VARCHAR, expression VARCHAR,
  numerator VARCHAR, denominator VARCHAR, multiplier DOUBLE, format VARCHAR, definition VARCHAR,
  artifact_id VARCHAR, registered_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS meta.reports (
  id VARCHAR PRIMARY KEY, title VARCHAR, artifact_id VARCHAR, dataset VARCHAR, spec VARCHAR,
  reconciliation VARCHAR, published_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS meta.alerts (
  id VARCHAR PRIMARY KEY, name VARCHAR, artifact_id VARCHAR, spec VARCHAR, sql VARCHAR, status VARCHAR,
  created_at TIMESTAMP, last_evaluated_at TIMESTAMP, last_result VARCHAR);
CREATE TABLE IF NOT EXISTS meta.part_exceptions (
  artifact_id VARCHAR, dataset VARCHAR, raw_value VARCHAR, normalized VARCHAR, reason VARCHAR,
  suggestion VARCHAR, row_count BIGINT);
CREATE TABLE IF NOT EXISTS meta.layer_rules (
  dataset VARCHAR PRIMARY KEY, rules VARCHAR, artifact_id VARCHAR, updated_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS meta.audit (
  ts TIMESTAMP, actor VARCHAR, action VARCHAR, object VARCHAR, detail VARCHAR);
`;

export function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export async function audit(actor, action, object, detail = '') {
  await run(`INSERT INTO meta.audit VALUES (now(), ?, ?, ?, ?)`, [actor, action, object, typeof detail === 'string' ? detail : JSON.stringify(detail)]);
}

// ---- requests -------------------------------------------------------------
export async function createRequest({ requester, persona, text }) {
  const id = newId('REQ');
  await run(`INSERT INTO meta.requests VALUES (?, now(), ?, ?, ?, NULL, 'received', NULL, NULL, NULL)`, [id, requester, persona, text]);
  await audit(requester, 'request.submitted', id, text);
  return id;
}

export async function updateRequest(id, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  await run(`UPDATE meta.requests SET ${sets} WHERE id = ?`, [...Object.values(fields).map((v) => v ?? null), id]);
}

export async function listRequests() {
  return all(`SELECT * FROM meta.requests ORDER BY created_at DESC`);
}

// ---- artifacts ------------------------------------------------------------
export async function createArtifact({ requestId, kind, title, engine, summary, payload }) {
  const id = newId(kind === 'onboarding' ? 'ONB' : kind === 'report' ? 'RPT' : 'ALR');
  await run(
    `INSERT INTO meta.artifacts VALUES (?, ?, ?, ?, 'pending_review', now(), NULL, NULL, NULL, ?, ?, ?)`,
    [id, requestId, kind, title, engine, summary, JSON.stringify(payload)]
  );
  await audit('system', 'artifact.generated', id, `${kind}: ${title}`);
  return id;
}

export async function getArtifact(id) {
  const a = await one(`SELECT * FROM meta.artifacts WHERE id = ?`, [id]);
  if (!a) return null;
  a.payload = parse(a.payload, {});
  return a;
}

export async function listArtifacts() {
  const rows = await all(`SELECT id, request_id, kind, title, status, created_at, decided_at, reviewer, review_comment, engine, summary FROM meta.artifacts ORDER BY created_at DESC`);
  return rows;
}

export async function setArtifactStatus(id, status, { reviewer, comment, payload } = {}) {
  if (payload) await run(`UPDATE meta.artifacts SET payload = ? WHERE id = ?`, [JSON.stringify(payload), id]);
  if (reviewer !== undefined) {
    await run(`UPDATE meta.artifacts SET status = ?, reviewer = ?, review_comment = ?, decided_at = now() WHERE id = ?`, [status, reviewer, comment ?? null, id]);
  } else {
    await run(`UPDATE meta.artifacts SET status = ? WHERE id = ?`, [status, id]);
  }
}

// ---- catalog & lineage ----------------------------------------------------
export async function registerDataset({ dataset, layer, title, description, owner, sourceSystem, columns, rowCount, tags = [], artifactId = null, dqStatus = 'not run' }) {
  await run(`DELETE FROM meta.catalog WHERE dataset = ?`, [dataset]);
  await run(`INSERT INTO meta.catalog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?)`, [
    dataset, layer, title, description, owner, sourceSystem, JSON.stringify(columns), rowCount, JSON.stringify(tags), artifactId, dqStatus,
  ]);
}

export async function listCatalog() {
  const rows = await all(`SELECT * FROM meta.catalog ORDER BY CASE layer WHEN 'source' THEN 0 WHEN 'bronze' THEN 1 WHEN 'silver' THEN 2 WHEN 'gold' THEN 3 ELSE 4 END, dataset`);
  return rows.map((r) => ({ ...r, columns: parse(r.columns, []), tags: parse(r.tags, []) }));
}

export async function getDataset(name) {
  const r = await one(`SELECT * FROM meta.catalog WHERE dataset = ?`, [name]);
  return r ? { ...r, columns: parse(r.columns, []), tags: parse(r.tags, []) } : null;
}

export async function addLineage(from, to, transform, artifactId = null) {
  await run(`DELETE FROM meta.lineage WHERE from_node = ? AND to_node = ?`, [from, to]);
  await run(`INSERT INTO meta.lineage VALUES (?, ?, ?, ?, now())`, [from, to, transform, artifactId]);
}

// Full upstream + downstream graph around a node.
export async function lineageGraph(node) {
  const edges = await all(`SELECT from_node, to_node, transform, artifact_id FROM meta.lineage`);
  if (!node) return { nodes: [...new Set(edges.flatMap((e) => [e.from_node, e.to_node]))], edges };
  const keep = new Set([node]);
  const walk = (dir) => {
    let frontier = [node];
    while (frontier.length) {
      const next = [];
      for (const n of frontier) {
        for (const e of edges) {
          const [a, b] = dir === 'up' ? [e.to_node, e.from_node] : [e.from_node, e.to_node];
          if (a === n && !keep.has(b)) { keep.add(b); next.push(b); }
        }
      }
      frontier = next;
    }
  };
  walk('up');
  walk('down');
  const sub = edges.filter((e) => keep.has(e.from_node) && keep.has(e.to_node));
  return { nodes: [...keep], edges: sub };
}

// ---- layer rules (Bronze/Silver/Gold rules a reviewer agreed to) ---------
export async function saveLayerRules(dataset, rules, artifactId = null) {
  await run(`DELETE FROM meta.layer_rules WHERE dataset = ?`, [dataset]);
  await run(`INSERT INTO meta.layer_rules VALUES (?, ?, ?, now())`, [dataset, JSON.stringify(rules), artifactId]);
}

export async function getLayerRules(dataset) {
  const r = await one(`SELECT rules FROM meta.layer_rules WHERE dataset = ?`, [dataset]);
  return r ? parse(r.rules, null) : null;
}

// ---- data quality ---------------------------------------------------------
export async function saveDqResults(artifactId, stage, results) {
  const runId = newId('DQ');
  for (const r of results) {
    await run(`INSERT INTO meta.dq_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())`, [
      runId, artifactId, stage, r.dataset, r.name, r.severity, r.failed, r.total, String(r.threshold ?? ''), r.passed, r.detail ?? '',
    ]);
  }
  return runId;
}

export async function latestDq(dataset) {
  return all(
    `SELECT * FROM meta.dq_results WHERE dataset = ? AND stage = 'deploy'
     AND run_id = (SELECT run_id FROM meta.dq_results WHERE dataset = ? AND stage = 'deploy' ORDER BY run_at DESC LIMIT 1)`,
    [dataset, dataset]
  );
}

// ---- semantic layer -------------------------------------------------------
export async function registerMeasure(m, artifactId = null) {
  await run(`DELETE FROM meta.measures WHERE name = ?`, [m.name]);
  await run(`INSERT INTO meta.measures VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())`, [
    m.name, m.label, m.kind, m.fact ?? null, m.expression ?? null, m.numerator ?? null, m.denominator ?? null,
    m.multiplier ?? null, m.format, m.definition, artifactId,
  ]);
}

export async function listMeasures() {
  return all(`SELECT * FROM meta.measures ORDER BY kind, name`);
}

// ---- reports & alerts -----------------------------------------------------
export async function saveReport({ id, title, artifactId, dataset, spec, reconciliation }) {
  await run(`INSERT INTO meta.reports VALUES (?, ?, ?, ?, ?, ?, now())`, [id, title, artifactId, dataset, JSON.stringify(spec), JSON.stringify(reconciliation)]);
}

export async function listReports() {
  const rows = await all(`SELECT * FROM meta.reports ORDER BY published_at DESC`);
  return rows.map((r) => ({ ...r, spec: parse(r.spec, {}), reconciliation: parse(r.reconciliation, {}) }));
}

export async function getReport(id) {
  const r = await one(`SELECT * FROM meta.reports WHERE id = ?`, [id]);
  return r ? { ...r, spec: parse(r.spec, {}), reconciliation: parse(r.reconciliation, {}) } : null;
}

export async function saveAlert({ id, name, artifactId, spec, sql }) {
  await run(`INSERT INTO meta.alerts VALUES (?, ?, ?, ?, ?, 'active', now(), NULL, NULL)`, [id, name, artifactId, JSON.stringify(spec), sql]);
}

export async function listAlerts() {
  const rows = await all(`SELECT * FROM meta.alerts ORDER BY created_at DESC`);
  return rows.map((r) => ({ ...r, spec: parse(r.spec, {}), last_result: parse(r.last_result, null) }));
}

export async function getAlert(id) {
  const r = await one(`SELECT * FROM meta.alerts WHERE id = ?`, [id]);
  return r ? { ...r, spec: parse(r.spec, {}), last_result: parse(r.last_result, null) } : null;
}

export async function setAlertResult(id, result) {
  await run(`UPDATE meta.alerts SET last_evaluated_at = now(), last_result = ? WHERE id = ?`, [JSON.stringify(result), id]);
}

export async function listAudit(limit = 200) {
  return all(`SELECT * FROM meta.audit ORDER BY ts DESC LIMIT ${Number(limit) || 200}`);
}
