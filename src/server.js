// Standalone portal: static UI + JSON API.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, exclusive, all, one, q, tableExists } from './db.js';
import { engineInfo } from './llm.js';
import { seed } from './seed.js';
import { listSources } from './profiler.js';
import { intake, decide } from './workflow.js';
import { reportData, dataRange } from './reporting.js';
import { evaluateAlert } from './alerts.js';
import { renderReportPdf } from './pdf.js';
import * as meta from './meta.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional poc/.env (gitignored) for ANTHROPIC_API_KEY etc. Real environment variables win.
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE) && !process.env.POC_SKIP_ENV_FILE) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    const quoted = m[2].match(/^(['"])(.*)\1$/);
    process.env[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '').trim(); // drop inline "# comment"
  }
}
const conventions = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'conventions.json'), 'utf8'));

export async function ensureSeeded() {
  await connect();
  const ok = await exclusive(() => tableExists('meta.catalog'));
  if (!ok) await seed({ quiet: true });
}

const LAYER_ORDER = ['src_', 'bronze.', 'silver.', 'gold.', 'report:'];
const layerOf = (n) => LAYER_ORDER.findIndex((p) => n.startsWith(p));

export async function lineageText(node) {
  const g = await meta.lineageGraph(node);
  const groups = {};
  for (const n of g.nodes) { const l = layerOf(n); (groups[l] ||= []).push(n); }
  return Object.keys(groups).sort((a, b) => a - b).map((k) => groups[k].filter((n) => !n.startsWith('gold.dim_') && !n.startsWith('silver.part_')).join(', ')).filter(Boolean).join('  ->  ');
}

// Optional shared login for hosted demos: set PORTAL_PASSWORD (and optionally PORTAL_USER).
// When PORTAL_PASSWORD is unset (local use, tests) the portal stays open.
function basicAuth() {
  const password = process.env.PORTAL_PASSWORD;
  if (!password) return (req, res, next) => next();
  const user = process.env.PORTAL_USER || 'demo';
  const expected = Buffer.from(`${user}:${password}`);
  return (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    const given = scheme === 'Basic' && token ? Buffer.from(token, 'base64') : Buffer.alloc(0);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="AI workflow POC", charset="UTF-8"').status(401).send('Login required');
  };
}

export function createApp() {
  const app = express();
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(basicAuth());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(ROOT, 'public')));

  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (err) { res.status(err.status || 500).json({ error: String(err.message || err) }); }
  };
  const read = (fn) => h((req, res) => exclusive(() => fn(req, res)));

  app.get('/api/status', read(async () => {
    const c = async (sql) => (await one(sql)).n;
    return {
      engine: engineInfo(),
      reviewer: conventions.approval.default_reviewer,
      data_range: await dataRange(),
      counts: {
        pending: await c(`SELECT count(*) AS n FROM meta.artifacts WHERE status = 'pending_review'`),
        datasets: await c(`SELECT count(*) AS n FROM meta.catalog WHERE layer <> 'source'`),
        reports: await c(`SELECT count(*) AS n FROM meta.reports`),
        alerts: await c(`SELECT count(*) AS n FROM meta.alerts`),
        requests: await c(`SELECT count(*) AS n FROM meta.requests`),
      },
    };
  }));
  app.get('/api/conventions', (req, res) => res.json(conventions));
  app.get('/api/sources', read(() => listSources()));

  app.post('/api/intake', h(async (req) => {
    const text = String(req.body?.text || '').trim();
    if (!text) throw Object.assign(new Error('Please describe what you need.'), { status: 400 });
    return intake({ text, requester: req.body.requester || 'Demo user', persona: req.body.persona || 'engineer' });
  }));
  app.get('/api/requests', read(() => meta.listRequests()));

  app.get('/api/artifacts', read(() => meta.listArtifacts()));
  app.get('/api/artifacts/:id', read(async (req) => {
    const a = await meta.getArtifact(req.params.id);
    if (!a) throw Object.assign(new Error('Not found'), { status: 404 });
    return a;
  }));
  app.post('/api/artifacts/:id/decision', h((req) => decide(req.params.id, {
    decision: req.body?.decision, reviewer: String(req.body?.reviewer || '').trim(), comment: req.body?.comment || '', acceptSuggestions: Boolean(req.body?.acceptSuggestions),
  })));

  app.get('/api/catalog', read(() => meta.listCatalog()));
  app.get('/api/catalog/:dataset', read(async (req) => {
    const name = req.params.dataset;
    const d = await meta.getDataset(name);
    if (!d) throw Object.assign(new Error('Not found'), { status: 404 });
    const [s, t] = name.split('.');
    const sample = await all(`SELECT * FROM ${s}.${q(t)} LIMIT 15`);
    const dq = await meta.latestDq(name);
    const lineage = await meta.lineageGraph(name);
    const exceptions = await all(`SELECT * FROM meta.part_exceptions WHERE dataset = ? ORDER BY row_count DESC`, [name]);
    return { ...d, sample, dq, lineage, exceptions };
  }));
  app.get('/api/lineage', read((req) => meta.lineageGraph(req.query.node || null)));
  app.get('/api/measures', read(() => meta.listMeasures()));

  app.get('/api/reports', read(() => meta.listReports()));
  app.get('/api/reports/:id', read(async (req) => {
    const r = await meta.getReport(req.params.id);
    if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
    const data = await reportData(r.spec, r.dataset);
    const art = await meta.getArtifact(r.artifact_id);
    return { ...r, data, lineage: await lineageText(`report:${r.id}`), approval: { reviewer: art?.reviewer, decided_at: art?.decided_at, engine: art?.engine, comment: art?.review_comment } };
  }));
  app.get('/api/reports/:id/pdf', async (req, res) => {
    try {
      const { report, data, approval } = await exclusive(async () => {
        const r = await meta.getReport(req.params.id);
        if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
        const art = await meta.getArtifact(r.artifact_id);
        return { report: r, data: await reportData(r.spec, r.dataset), approval: { reviewer: art?.reviewer, decidedAt: art?.decided_at, engine: art?.engine, lineage: await lineageText(`report:${r.id}`) } };
      });
      const pdf = await renderReportPdf({ report, data, approval });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${report.id}.pdf"`);
      res.send(pdf);
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/alerts', read(() => meta.listAlerts()));
  app.post('/api/alerts/:id/evaluate', read(async (req) => {
    const a = await meta.getAlert(req.params.id);
    if (!a) throw Object.assign(new Error('Not found'), { status: 404 });
    return evaluateAlert(a);
  }));

  app.get('/api/audit', read(() => meta.listAudit()));
  app.post('/api/reset', h(async () => { await seed({ quiet: true }); return { ok: true }; }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4310);
  await ensureSeeded();
  createApp().listen(port, () => {
    const e = engineInfo();
    console.log(`AI engineering workflow portal running at http://localhost:${port}`);
    const hint = (process.env.AI_ENGINE || '').trim().toLowerCase() === 'rules' ? '  (AI_ENGINE=rules; set AI_ENGINE=auto to use Claude)' : '  (set ANTHROPIC_API_KEY to use Claude)';
    console.log(`AI engine: ${e.label}${e.mode === 'rules' ? hint : ''}`);
  });
}
