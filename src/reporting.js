// Use case 2 - requirement to report.
// plain-English requirement -> measures/dimensions/period (AI, constrained to the semantic layer)
// -> plan: reuse existing Gold facts, build missing Gold facts + measures -> report mart
// -> dry run (dashboard data, reconciliation to source, DQ) -> reviewer approves -> publish.
import { all, one, run, q, lit, transaction, runScript, tableExists } from './db.js';
import { structured, SYSTEM_PROMPT, engineInfo } from './llm.js';
import * as rules from './rules.js';
import { ALL_MEASURES, BASE_MEASURES, DERIVED_MEASURES, DIMENSIONS, FACTS, baseComponents, factsFor, measureSql, fillDates } from './semantic.js';
import { listCatalog, registerDataset, addLineage, registerMeasure, saveDqResults, saveReport, audit, newId, getLayerRules, saveLayerRules } from './meta.js';

export async function dataRange() {
  const r = await one(`SELECT min(order_date)::VARCHAR AS min_d, max(order_date)::VARCHAR AS max_d FROM gold.fct_sales`);
  return { from: r.min_d, to: r.max_d };
}

export const CHARTS = { line: 'Line', column: 'Column', stacked_column: 'Stacked column', bar: 'Horizontal bar', table: 'Table only' };
export const LAYOUTS = { standard: 'Standard: KPIs, charts and detail table', executive: 'Executive: KPIs and one chart', scorecard: 'Scorecard: KPIs, breakdown and detail table' };

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'measures', 'dimensions', 'breakdown_dimension', 'date_from', 'date_to', 'chart', 'layout', 'assumptions'],
  properties: {
    title: { type: 'string', description: 'Short report title a business user would recognise' },
    measures: { type: 'array', items: { type: 'string', enum: Object.keys(ALL_MEASURES) }, description: '1-4 measures, most important first' },
    dimensions: { type: 'array', items: { type: 'string', enum: Object.keys(DIMENSIONS) }, description: 'Grouping for the main view: at most one time dimension first, then at most one other dimension' },
    breakdown_dimension: { type: 'string', enum: ['none', ...Object.keys(DIMENSIONS).filter((d) => !DIMENSIONS[d].time)], description: 'Optional secondary breakdown' },
    date_from: { type: 'string', description: 'YYYY-MM-DD' },
    date_to: { type: 'string', description: 'YYYY-MM-DD' },
    chart: { type: 'string', enum: Object.keys(CHARTS), description: 'Main visual. line / column / stacked_column need a time dimension; bar is horizontal bars for a category; table shows no chart' },
    layout: { type: 'string', enum: Object.keys(LAYOUTS), description: 'standard = KPIs + charts + detail table; executive = KPIs + one chart; scorecard = KPIs + breakdown + detail table' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
};


async function factStatus() {
  const out = {};
  for (const [name, f] of Object.entries(FACTS)) {
    const exists = await tableExists(name);
    let source = null;
    if (!exists && f.sourceTag) source = await findSilverSource(f);
    out[name] = { exists, buildable: Boolean(source), source };
  }
  return out;
}

async function sourceInfo(d) {
  const roles = Object.fromEntries(d.columns.filter((c) => c.role).map((c) => [c.role, c.name]));
  return { dataset: d.dataset, roles, hasHierarchy: d.columns.some((c) => c.name === 'product_line'), rules: await getLayerRules(d.dataset) };
}

async function findSilverSource(fact) {
  const cat = await listCatalog();
  for (const d of cat) {
    if (d.layer !== 'silver' || d.dataset.endsWith('__quarantine') || !d.tags.includes(fact.sourceTag)) continue;
    const info = await sourceInfo(d);
    if (fact.requiresRoles.every((r) => info.roles[r])) return info;
  }
  return null;
}

// Reconciliation recomputes totals from the raw source using the same layer rules the Gold fact
// was built with (statuses included in Gold, negative amounts quarantined or not).
function reconContext(factRules) {
  const r = factRules['gold.fct_warranty_claims'];
  if (!r) return {};
  return { warranty: { statuses: r.status_column ? r.gold.include_statuses : undefined, excludeNegative: Boolean(r.silver?.quarantine_negative_amounts) } };
}

async function factRulesFor(plan, facts) {
  const out = {};
  for (const b of plan.build) if (facts[b.fact].source?.rules) out[b.fact] = facts[b.fact].source.rules;
  for (const f of plan.reuse) { const r = await getLayerRules(f); if (r) out[f] = r; }
  return out;
}

// Gold facts already built from a Silver table are rebuilt when that table is re-onboarded,
// so they pick up the new layer rules.
export async function rebuildFactsFrom(silverDataset, artifactId) {
  const edges = await all(`SELECT DISTINCT to_node FROM meta.lineage WHERE from_node = ? AND to_node LIKE 'gold.fct_%'`, [silverDataset]);
  const cat = await listCatalog();
  const d = cat.find((x) => x.dataset === silverDataset);
  const done = [];
  for (const { to_node: fact } of edges) {
    if (!FACTS[fact] || !d || !(await tableExists(fact))) continue;
    const src = await sourceInfo(d);
    await runScript(factSql(fact, src));
    await run(`UPDATE meta.catalog SET row_count = (SELECT count(*) FROM ${fact}), registered_at = now() WHERE dataset = ?`, [fact]);
    if (src.rules) await saveLayerRules(fact, src.rules, artifactId);
    done.push(fact);
  }
  return done;
}

function specPrompt(text, facts, range) {
  const measures = Object.values(ALL_MEASURES).map((m) => {
    const fs = factsFor([m.name]);
    const avail = fs.every((f) => facts[f].exists || facts[f].buildable);
    return `- ${m.name}: ${m.label}. ${m.definition}${avail ? '' : ' (UNAVAILABLE: source not onboarded yet)'}`;
  }).join('\n');
  const dims = Object.entries(DIMENSIONS).map(([k, d]) => {
    const inFacts = Object.entries(FACTS).filter(([, f]) => f.dimensions.includes(k)).map(([n]) => n.replace('gold.', ''));
    return `- ${k}: ${d.label} (available in ${inFacts.join(', ')})`;
  }).join('\n');
  return `Business requirement: "${text}"

Break this requirement into a report specification using ONLY the measures and dimensions below.
Data is available from ${range.from} to ${range.to}. Today is ${new Date().toISOString().slice(0, 10)}.
If no period is stated, use the last 12 complete months of available data. "Last year" means the last full calendar year in the data.
A dimension can only be used if it is available in every fact the chosen measures come from.
Prefer measures marked available; if the request needs an unavailable one, still choose it (the portal will tell the user what to onboard).

Measures:
${measures}

Dimensions:
${dims}`;
}

export function validateSpec(spec, range) {
  const errors = [];
  const warnings = [];
  spec.measures = [...new Set((spec.measures || []).filter((m) => ALL_MEASURES[m]))].slice(0, 4);
  if (!spec.measures.length) errors.push('no valid measures');
  spec.dimensions = [...new Set((spec.dimensions || []).filter((d) => DIMENSIONS[d]))];
  const time = spec.dimensions.filter((d) => DIMENSIONS[d].time);
  const other = spec.dimensions.filter((d) => !DIMENSIONS[d].time);
  spec.dimensions = [...time.slice(0, 1), ...other.slice(0, 1)];
  if (other.length > 1 && (!spec.breakdown_dimension || spec.breakdown_dimension === 'none')) spec.breakdown_dimension = other[1];
  if (!DIMENSIONS[spec.breakdown_dimension] || spec.dimensions.includes(spec.breakdown_dimension)) spec.breakdown_dimension = 'none';
  const facts = factsFor(spec.measures);
  const ok = (d) => facts.every((f) => FACTS[f].dimensions.includes(d));
  for (const d of [...spec.dimensions]) if (!ok(d)) { warnings.push(`"${DIMENSIONS[d].label}" is not available for ${facts.map((f) => FACTS[f].label).join(' + ')}; dropped.`); spec.dimensions = spec.dimensions.filter((x) => x !== d); }
  if (spec.breakdown_dimension !== 'none' && !ok(spec.breakdown_dimension)) { warnings.push(`Breakdown "${DIMENSIONS[spec.breakdown_dimension].label}" not available for the chosen measures; dropped.`); spec.breakdown_dimension = 'none'; }
  if (!spec.dimensions.length) spec.dimensions = ['month'];
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
  if (!isDate(spec.date_from) || !isDate(spec.date_to) || spec.date_from > spec.date_to) errors.push('invalid date range');
  else {
    if (spec.date_from < range.from) { spec.date_from = range.from; }
    if (spec.date_to > range.to) { warnings.push(`Data is only available up to ${range.to}; period truncated.`); spec.date_to = range.to; }
  }
  const hasTime = spec.dimensions.some((d) => DIMENSIONS[d].time);
  const hasSeries = spec.dimensions.some((d) => !DIMENSIONS[d].time);
  const asked = spec.chart;
  if (!CHARTS[spec.chart]) spec.chart = hasTime ? 'line' : 'bar';
  if (hasTime && spec.chart === 'bar') spec.chart = 'column';
  if (!hasTime && ['line', 'column', 'stacked_column'].includes(spec.chart)) spec.chart = 'bar';
  if (spec.chart === 'stacked_column' && !hasSeries) spec.chart = 'column';
  if (CHARTS[asked] && asked !== spec.chart && !(asked === 'bar' && spec.chart === 'column')) warnings.push(`${CHARTS[asked]} chart does not fit this grouping; using ${CHARTS[spec.chart].toLowerCase()}.`);
  if (!LAYOUTS[spec.layout]) spec.layout = 'standard';
  if (!spec.title) spec.title = spec.measures.map((m) => ALL_MEASURES[m].label).join(', ');
  return { errors, warnings };
}

// ---- Gold fact builders ---------------------------------------------------
function factSql(factName, src) {
  const r = src.roles;
  const col = (role, fallback = 'NULL') => (r[role] ? `w.${q(r[role])}` : fallback);
  const hier = (c) => (src.hasHierarchy ? `coalesce(w.${c}, 'Unmapped')` : `'Unmapped'`);
  if (factName === 'gold.fct_warranty_claims') {
    // Gold inclusion rule agreed at onboarding (default: every status except REJECTED).
    const lr = src.rules;
    const statusExpr = `upper(trim(coalesce(${col('status', "''")}, '')))`;
    const statusWhere = lr?.status_column && r.status
      ? `${statusExpr} IN (${lr.gold.include_statuses.map(lit).join(', ')})`
      : `${statusExpr} <> 'REJECTED'`;
    const statusText = lr?.status_column ? `Gold layer rule from onboarding - include ${lr.gold.include_statuses.join(', ')}` : 'platform default - exclude REJECTED';
    return `-- Gold fact (new): one row per warranty claim in the included statuses, conformed to date, product hierarchy and dealer region
CREATE OR REPLACE TABLE gold.fct_warranty_claims AS
SELECT
  ${col('record_id')} AS claim_id,
  ${col('event_date')} AS claim_date,
  dd.year, dd.quarter, dd.month,
  ${src.hasHierarchy ? 'w.part_no_std' : 'NULL'} AS part_no,
  ${hier('model_family')} AS model_family,
  ${hier('product_line')} AS product_line,
  ${hier('vertical')} AS vertical,
  ${col('dealer_id')} AS dealer_code,
  coalesce(d.dealer_name, 'Unknown dealer') AS dealer_name,
  coalesce(d.region, 'Unknown') AS region,
  ${col('failure_code')} AS failure_code,
  coalesce(${col('failure_description')}, 'Not specified') AS failure_mode,
  ${col('status')} AS claim_status,
  -- statuses: ${statusText}
  coalesce(${col('labor_amount', '0')}, 0) AS labor_amount,
  coalesce(${col('parts_amount', '0')}, 0) AS parts_amount,
  coalesce(${col('labor_amount', '0')}, 0) + coalesce(${col('parts_amount', '0')}, 0) AS total_claim_amount
FROM ${src.dataset} w
JOIN gold.dim_date dd ON dd.date = ${col('event_date')}
LEFT JOIN silver.dealers d ON d.dealer_code = ${col('dealer_id')}
WHERE ${statusWhere};`;
  }
  if (factName === 'gold.fct_quality_inspections') {
    const ts = col('event_timestamp');
    return `-- Gold fact (new): one row per end-of-line inspection, conformed to date and product hierarchy
CREATE OR REPLACE TABLE gold.fct_quality_inspections AS
SELECT
  ${col('record_id')} AS inspection_id,
  ${ts}::DATE AS inspection_date,
  dd.year, dd.quarter, dd.month,
  ${src.hasHierarchy ? 'w.part_no_std' : 'NULL'} AS part_no,
  ${hier('model_family')} AS model_family,
  ${hier('product_line')} AS product_line,
  ${hier('vertical')} AS vertical,
  coalesce(${col('plant_code')}, 'Unknown') AS plant_code,
  coalesce(${col('test_type')}, 'Unknown') AS check_type,
  upper(${col('test_result')}) AS test_result,
  ${col('measured_value')} AS measured_value
FROM ${src.dataset} w
JOIN gold.dim_date dd ON dd.date = ${ts}::DATE;`;
  }
  throw new Error(`No builder for ${factName}`);
}

function slug(s) {
  return s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').split('_').slice(0, 6).join('_').slice(0, 40) || 'report';
}

function martSql(table, spec) {
  const dims = [...spec.dimensions, ...(spec.breakdown_dimension !== 'none' ? [spec.breakdown_dimension] : [])];
  const bases = [...new Set(spec.measures.flatMap(baseComponents))];
  const facts = [...new Set(bases.map((b) => BASE_MEASURES[b].fact))];
  const ctes = facts.map((f, i) => {
    const ms = bases.filter((b) => BASE_MEASURES[b].fact === f).map((b) => `${BASE_MEASURES[b].expression} AS ${b}`);
    return `  f${i} AS (\n    SELECT ${dims.join(', ')}, ${ms.join(', ')}\n    FROM ${f}\n    WHERE ${FACTS[f].dateColumn} BETWEEN DATE '${spec.date_from}' AND DATE '${spec.date_to}'\n    GROUP BY ALL\n  )`;
  });
  let select;
  if (facts.length === 1) {
    select = `SELECT * FROM f0`;
  } else {
    const dimCols = dims.map((d) => `coalesce(${facts.map((_, i) => `f${i}.${d}`).join(', ')}) AS ${d}`);
    const mCols = bases.map((b) => `coalesce(f${facts.indexOf(BASE_MEASURES[b].fact)}.${b}, 0) AS ${b}`);
    // Measures come from at most two facts today (e.g. warranty + sales for claim rate).
    select = `SELECT\n  ${[...dimCols, ...mCols].join(',\n  ')}\nFROM f0\n${facts.slice(1).map((_, i) => `FULL OUTER JOIN f${i + 1} ON ${dims.map((d) => `f${i + 1}.${d} IS NOT DISTINCT FROM f0.${d}`).join(' AND ')}`).join('\n')}`;
  }
  return `-- Gold report mart (new): ${spec.title}
-- Grain: ${dims.join(' x ')}; base measures: ${bases.join(', ')}; period ${spec.date_from} .. ${spec.date_to}
CREATE OR REPLACE TABLE ${table} AS
WITH
${ctes.join(',\n')}
${select};`;
}

// ---- dashboard data & reconciliation -------------------------------------
export async function reportData(spec, table) {
  const ms = spec.measures;
  const sel = ms.map((m) => `${measureSql(m)} AS ${m}`).join(', ');
  const kpiRow = await one(`SELECT ${sel} FROM ${table}`);
  const kpis = ms.map((m) => ({ name: m, label: ALL_MEASURES[m].label, format: ALL_MEASURES[m].format, value: kpiRow[m] }));
  const timeDim = spec.dimensions.find((d) => DIMENSIONS[d].time);
  const catDim = spec.dimensions.find((d) => !DIMENSIONS[d].time);
  const out = { kpis, chart: spec.chart, layout: spec.layout || 'standard', measures: ms.map((m) => ({ name: m, label: ALL_MEASURES[m].label, format: ALL_MEASURES[m].format, kind: ALL_MEASURES[m].kind })) };
  if (timeDim) {
    out.time = { dim: timeDim, series_dim: catDim || null, rows: await all(`SELECT ${timeDim} AS t, ${catDim ? `${catDim} AS s` : `'Total' AS s`}, ${sel} FROM ${table} GROUP BY ALL ORDER BY 1, 2`) };
  }
  const bd = spec.breakdown_dimension !== 'none' ? spec.breakdown_dimension : catDim;
  if (bd) out.breakdown = { dim: bd, rows: await all(`SELECT ${bd} AS k, ${sel} FROM ${table} GROUP BY ALL ORDER BY ${ms[0]} DESC NULLS LAST`) };
  const dims = [...spec.dimensions, ...(spec.breakdown_dimension !== 'none' ? [spec.breakdown_dimension] : [])];
  out.table = { columns: [...dims, ...ms], rows: await all(`SELECT ${dims.join(', ')}, ${sel} FROM ${table} GROUP BY ALL ORDER BY ${dims.map((_, i) => i + 1).join(', ')} LIMIT 400`) };
  return out;
}

export async function reconcile(spec, table, ctx = {}) {
  const bases = [...new Set(spec.measures.flatMap(baseComponents))];
  const lines = [];
  for (const b of bases) {
    const m = BASE_MEASURES[b];
    const report = (await one(`SELECT sum(${b})::DOUBLE AS v FROM ${table}`)).v ?? 0;
    const gold = (await one(`SELECT (${m.expression})::DOUBLE AS v FROM ${m.fact} WHERE ${FACTS[m.fact].dateColumn} BETWEEN DATE '${spec.date_from}' AND DATE '${spec.date_to}'`)).v ?? 0;
    const check = typeof m.sourceCheck === 'function' ? m.sourceCheck(ctx) : m.sourceCheck;
    const source = (await one(fillDates(check, spec.date_from, spec.date_to))).v ?? 0;
    const src = Number(source);
    const tol = m.format === 'int' ? 0 : 0.01;
    const diff = Number(report) - src;
    let rule = m.definition;
    if (m.fact === 'gold.fct_warranty_claims' && ctx.warranty) {
      rule += ` Layer rules applied: statuses ${ctx.warranty.statuses ? ctx.warranty.statuses.join(', ') : 'all except REJECTED'}${ctx.warranty.excludeNegative ? '; negative amounts quarantined' : ''}.`;
    }
    lines.push({ measure: b, label: m.label, format: m.format, source: src, gold: Number(gold), report: Number(report), difference: Math.round(diff * 100) / 100, passed: Math.abs(diff) <= tol, rule });
  }
  return { tolerance: 'exact for counts, +/- 0.01 for amounts', passed: lines.every((l) => l.passed), lines, period: [spec.date_from, spec.date_to] };
}

async function martChecks(table, spec, newFacts) {
  const dims = [...spec.dimensions, ...(spec.breakdown_dimension !== 'none' ? [spec.breakdown_dimension] : [])];
  const out = [];
  const rows = (await one(`SELECT count(*) AS n FROM ${table}`)).n;
  out.push({ dataset: table, name: 'Report mart is not empty', severity: 'error', failed: rows ? 0 : 1, total: rows, threshold: '> 0 rows', passed: rows > 0, detail: `${rows} rows` });
  const nulls = (await one(`SELECT count(*) AS n FROM ${table} WHERE ${dims.map((d) => `${d} IS NULL`).join(' OR ')}`)).n;
  out.push({ dataset: table, name: 'No null dimension values', severity: 'warning', failed: nulls, total: rows, threshold: '0', passed: nulls === 0, detail: '' });
  for (const f of newFacts) {
    const n = (await one(`SELECT count(*) AS n FROM ${f}`)).n;
    const k = (await one(`SELECT count(*) - count(DISTINCT ${f === 'gold.fct_warranty_claims' ? 'claim_id' : 'inspection_id'}) AS n FROM ${f}`)).n;
    out.push({ dataset: f, name: 'Fact grain is unique', severity: 'error', failed: k, total: n, threshold: '0', passed: k === 0, detail: `${n} rows` });
    const unm = (await one(`SELECT count(*) AS n FROM ${f} WHERE product_line = 'Unmapped'`)).n;
    out.push({ dataset: f, name: 'Rows with unmapped product line', severity: 'warning', failed: unm, total: n, threshold: '<= 5%', passed: n ? unm / n <= 0.05 : true, detail: n ? `${((unm / n) * 100).toFixed(1)}% shown as "Unmapped" so totals still reconcile` : '' });
  }
  return out;
}

// ---- propose ---------------------------------------------------------------
export async function proposeReport({ requestText }) {
  const notes = [];
  const range = await dataRange();
  const facts = await factStatus();
  let spec = null;
  let engine = 'rules';
  const ai = await structured({ system: SYSTEM_PROMPT, prompt: specPrompt(requestText, facts, range), schema: SPEC_SCHEMA });
  let warnings = [];
  if (ai.ok) {
    const v = validateSpec(ai.data, range);
    if (v.errors.length) notes.push({ step: 'Requirement breakdown', engine: 'claude', note: `Claude spec rejected: ${v.errors.join('; ')}. Fell back to rule engine.` });
    else { spec = ai.data; engine = 'claude'; warnings = v.warnings; notes.push({ step: 'Requirement breakdown', engine: 'claude', note: `Broken down by ${engineInfo().label}; passed validation.` }); }
  } else if (engineInfo().mode === 'claude') {
    notes.push({ step: 'Requirement breakdown', engine: 'claude', note: `Claude unavailable (${ai.error}); used rule engine.` });
  }
  if (!spec) {
    spec = rules.decomposeRequirement(requestText, { dataEnd: range.to });
    const v = validateSpec(spec, range);
    if (v.errors.length) throw new Error(`Could not interpret the requirement: ${v.errors.join('; ')}`);
    warnings = v.warnings;
    notes.push({ step: 'Requirement breakdown', engine: 'rules', note: 'Broken down by rule-based glossary matcher.' });
  }
  return buildReport({ requestText, spec, warnings, notes, engine, facts });
}

async function buildReport({ requestText, spec, warnings, notes, engine, facts }) {
  facts ||= await factStatus();
  // Plan: reuse / build / blocked
  const needed = factsFor(spec.measures);
  const plan = { reuse: [], build: [], blocked: [] };
  for (const f of needed) {
    if (facts[f].exists) plan.reuse.push(f);
    else if (facts[f].buildable) plan.build.push({ fact: f, from: facts[f].source.dataset });
    else plan.blocked.push(f);
  }
  if (plan.blocked.length) {
    const what = plan.blocked.map((f) => FACTS[f]).map((f) => (f.subject === 'warranty' ? 'warranty claims (src_dealer.warranty_claims)' : f.subject === 'inspection' ? 'quality inspections (src_mes.quality_inspections)' : f.label));
    return { blocked: true, spec, message: `This report needs ${what.join(' and ')}, which ${what.length > 1 ? 'are' : 'is'} not on the platform in Silver yet. Ask a data engineer to onboard it first, e.g. "Onboard ${what[0].replace(/.*\((.*)\)/, '$1')}".`, notes };
  }
  const registered = new Set((await all(`SELECT name FROM meta.measures`)).map((r) => r.name));
  const allMeasureNames = [...new Set([...spec.measures, ...spec.measures.flatMap(baseComponents)])];
  const measuresNew = allMeasureNames.filter((m) => !registered.has(m)).map((m) => ALL_MEASURES[m]);
  const measuresReused = allMeasureNames.filter((m) => registered.has(m));
  const factRules = await factRulesFor(plan, facts);
  const ctx = reconContext(factRules);

  let table = `gold.rpt_${slug(spec.title)}`;
  if (await tableExists(table)) table = `${table}_${Math.random().toString(36).slice(2, 6)}`;
  const sql = { facts: Object.fromEntries(plan.build.map((b) => [b.fact, factSql(b.fact, facts[b.fact].source)])), mart: martSql(table, spec) };
  notes.push({ step: 'Plan', engine: 'deterministic', note: `Reuse ${plan.reuse.length ? plan.reuse.join(', ') : 'none'}; build ${plan.build.length ? plan.build.map((b) => b.fact).join(', ') : 'no new facts'}; mart ${table}.` });

  const preview = await transaction(async () => {
    for (const s of Object.values(sql.facts)) await runScript(s);
    await runScript(sql.mart);
    const data = await reportData(spec, table);
    const reconciliation = await reconcile(spec, table, ctx);
    const checks = await martChecks(table, spec, plan.build.map((b) => b.fact));
    return { data, reconciliation, checks };
  }, { commit: false });
  notes.push({ step: 'Dry run', engine: 'deterministic', note: `Report built in a rolled-back transaction; reconciliation ${preview.reconciliation.passed ? 'passed' : 'FAILED'}.` });

  const summary = `${spec.measures.length} measure(s) x ${[...spec.dimensions, spec.breakdown_dimension].filter((d) => d && d !== 'none').length} dimension(s), ${spec.date_from} .. ${spec.date_to}; ${CHARTS[spec.chart].toLowerCase()} chart, ${spec.layout} layout. Reuses ${plan.reuse.length} Gold table(s), builds ${plan.build.length} new fact(s) + 1 report mart, registers ${measuresNew.length} new measure(s). Reconciliation to source: ${preview.reconciliation.passed ? 'passed' : 'FAILED'}.`;
  return {
    blocked: false,
    title: spec.title, summary, engine,
    payload: { request_text: requestText, spec, warnings, plan, table, sql, fact_rules: factRules, measures_new: measuresNew, measures_reused: measuresReused, preview, notes },
  };
}

const specText = (s) => `${s.measures.join(', ')} by ${[...s.dimensions, s.breakdown_dimension].filter((d) => d && d !== 'none').join(' x ')}; ${s.date_from}..${s.date_to}; ${s.chart} chart; ${s.layout} layout; "${s.title}"`;

export async function reviseReport(payload, { edits = {}, comment = '' }) {
  const range = await dataRange();
  const old = payload.spec;
  if (!old.layout) old.layout = 'standard';
  let spec = structuredClone(old);
  const notes = [];
  let engine = 'rules';
  let notApplied = [];
  for (const k of ['chart', 'layout', 'breakdown_dimension', 'date_from', 'date_to', 'title']) if (edits[k] !== undefined && edits[k] !== '') spec[k] = edits[k];
  if (Array.isArray(edits.measures) && edits.measures.length) spec.measures = edits.measures;
  if (Array.isArray(edits.dimensions) && edits.dimensions.length) spec.dimensions = edits.dimensions;
  if (specText(spec) !== specText(old)) notes.push({ step: 'Reviewer edits', engine: 'deterministic', note: specText(spec) });

  if (comment.trim()) {
    const before = specText(spec);
    const facts = await factStatus();
    const ai = await structured({
      system: SYSTEM_PROMPT,
      prompt: `A reviewer asked for changes to this report specification.\n\nReviewer comment: "${comment}"\n\nCurrent specification (JSON):\n${JSON.stringify(spec, null, 1)}\n\nReturn the complete revised specification. Change only what the comment asks for.\n\n${specPrompt(payload.request_text, facts, range).split('\n').slice(2).join('\n')}`,
      schema: SPEC_SCHEMA,
    });
    let used = false;
    if (ai.ok) {
      const cand = ai.data;
      const v = validateSpec(cand, range);
      if (v.errors.length) notes.push({ step: 'Revision', engine: 'claude', note: `Claude revision rejected: ${v.errors.join('; ')}. Used rule engine.` });
      else { spec = cand; engine = 'claude'; used = true; }
    } else if (engineInfo().mode === 'claude') notes.push({ step: 'Revision', engine: 'claude', note: `Claude unavailable (${ai.error}); used rule engine.` });
    if (!used) notApplied = rules.reviseReportFromComment(comment, spec).unrecognised;
    const after = specText(spec);
    notes.push({ step: 'Revision', engine, note: `${after !== before ? `From the comment: ${after}` : 'No change could be derived from the comment'}${notApplied.length ? `. Not applied: ${notApplied.join(' | ')}` : ''}.` });
  }
  const v = validateSpec(spec, range);
  if (v.errors.length) throw Object.assign(new Error(`The requested change makes the report invalid: ${v.errors.join('; ')}`), { status: 400 });
  if (specText(spec) === specText(old)) {
    throw Object.assign(new Error(`No change could be applied${notApplied.length ? ` (not understood: ${notApplied.join(' | ')})` : ''}. Change the presentation on the review screen, or phrase the comment like "use a stacked column chart", "executive layout", "add average claim cost", "break down by dealer" or "for 2024".`), { status: 400 });
  }
  const proposal = await buildReport({ requestText: payload.request_text, spec, warnings: v.warnings, notes, engine });
  if (proposal.blocked) throw Object.assign(new Error(proposal.message), { status: 400 });
  return { ...proposal, changes: [`Was: ${specText(old)}`, `Now: ${specText(spec)}`], notApplied };
}

// ---- deploy ------------------------------------------------------------------
export async function deployReport(artifact, { reviewer }) {
  const p = artifact.payload;
  const { spec, table, plan } = p;
  const factRules = { ...(p.fact_rules || {}) };
  for (const f of plan.reuse) { const r = await getLayerRules(f); if (r) factRules[f] = r; }
  const result = await transaction(async () => {
    for (const s of Object.values(p.sql.facts)) await runScript(s);
    await runScript(p.sql.mart);
    const reconciliation = await reconcile(spec, table, reconContext(factRules));
    const checks = await martChecks(table, spec, plan.build.map((b) => b.fact));
    const blocking = checks.filter((c) => c.severity === 'error' && !c.passed);
    if (blocking.length) throw new Error(`Blocking checks failed: ${blocking.map((b) => b.name).join('; ')}`);
    return { reconciliation, checks };
  }, { commit: true });

  const cols = async (t) => {
    const [s, n] = t.split('.');
    return all(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [s, n]);
  };
  for (const b of plan.build) {
    const f = FACTS[b.fact];
    await registerDataset({ dataset: b.fact, layer: 'gold', title: f.label, description: `Built by the portal from ${b.from} for "${spec.title}".`, owner: reviewer, sourceSystem: b.from.split('.')[1], columns: await cols(b.fact), rowCount: (await one(`SELECT count(*) AS n FROM ${b.fact}`)).n, tags: ['fact', f.subject, 'built by portal'], artifactId: artifact.id, dqStatus: 'passed' });
    await addLineage(b.from, b.fact, 'fact build (Gold layer rules)', artifact.id);
    await addLineage('gold.dim_date', b.fact, 'join', artifact.id);
    if (b.fact === 'gold.fct_warranty_claims') await addLineage('silver.dealers', b.fact, 'dealer region', artifact.id);
    if (factRules[b.fact]) await saveLayerRules(b.fact, factRules[b.fact], artifact.id);
  }
  await registerDataset({ dataset: table, layer: 'gold', title: `Report mart: ${spec.title}`, description: `Aggregated at ${[...spec.dimensions, spec.breakdown_dimension].filter((d) => d !== 'none').join(' x ')} for ${spec.date_from}..${spec.date_to}.`, owner: reviewer, sourceSystem: 'derived', columns: await cols(table), rowCount: (await one(`SELECT count(*) AS n FROM ${table}`)).n, tags: ['report mart'], artifactId: artifact.id, dqStatus: result.checks.every((c) => c.passed) ? 'passed' : 'passed with warnings' });
  for (const f of factsFor(spec.measures)) await addLineage(f, table, 'aggregate', artifact.id);
  for (const m of p.measures_new) await registerMeasure(m, artifact.id);

  const reportId = newId('DSH');
  await addLineage(table, `report:${reportId}`, 'dashboard + PDF', artifact.id);
  await saveReport({ id: reportId, title: spec.title, artifactId: artifact.id, dataset: table, spec, reconciliation: result.reconciliation });
  await saveDqResults(artifact.id, 'deploy', result.checks);
  await audit(reviewer, 'report.published', reportId, spec.title);
  return { reportId, table, reconciliation: result.reconciliation };
}

export { DERIVED_MEASURES };
