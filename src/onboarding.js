// Use case 1 - source onboarding.
// profile source -> AI mapping proposal -> validate -> compile Bronze + Silver SQL (conventions)
// -> dry run in a rolled-back transaction (DQ checks, part-number exceptions, sample rows)
// -> reviewer approves -> same SQL runs for real -> catalog + lineage + DQ recorded.
import { all, one, run, q, lit, transaction, splitStatements, runScript } from './db.js';
import { profileTable } from './profiler.js';
import { structured, SYSTEM_PROMPT, engineInfo } from './llm.js';
import * as rules from './rules.js';
import { ROLES, TRANSFORMS } from './semantic.js';
import { registerDataset, addLineage, saveDqResults, saveLayerRules, audit } from './meta.js';
import { rebuildFactsFrom } from './reporting.js';

const MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entity_name', 'domain', 'business_key', 'columns', 'summary', 'assumptions'],
  properties: {
    entity_name: { type: 'string', description: 'snake_case silver table name, plural noun, e.g. warranty_claims' },
    domain: { type: 'string', enum: ['warranty', 'quality', 'sales', 'customer', 'dealer', 'product', 'other'] },
    business_key: { type: 'array', items: { type: 'string' }, description: 'target_column name(s) that uniquely identify a record' },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_column', 'target_column', 'role', 'transform', 'pii', 'description'],
        properties: {
          source_column: { type: 'string' },
          target_column: { type: 'string', description: 'snake_case business-friendly name' },
          role: { type: 'string', enum: ROLES },
          transform: { type: 'string', enum: Object.keys(TRANSFORMS) },
          pii: { type: 'boolean' },
          description: { type: 'string', description: 'one short sentence for the reviewer: what it is and why this transform' },
        },
      },
    },
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
};

function mappingPrompt(profile) {
  const cols = profile.columns.map((c) => ({
    name: c.name, null_pct: c.null_pct, distinct: c.distinct, unique_ratio: c.unique_ratio,
    patterns_pct: c.patterns, top_values: c.top_values.slice(0, 4), samples: c.samples.slice(0, 5),
  }));
  return `Propose the Silver-layer schema mapping for onboarding this source table.

Source table: ${profile.table} (${profile.row_count} rows, ${profile.exact_duplicate_rows} exact duplicate rows)
Column profile (JSON):
${JSON.stringify(cols, null, 1)}

Rules:
- Map every source column exactly once.
- Exactly one column must have role "record_id" (the business key); list its target_column in business_key.
- Use role "event_date" with parse_date_mdy / parse_date_iso, or "event_timestamp" with parse_timestamp, for the main event date of the record.
- Part-number columns: role "part_number", transform "std_part_no", target_column "part_number_raw". The pipeline then adds standardised part number and product hierarchy columns automatically.
- Monetary columns: transform "to_decimal" (values may contain thousands separators). Use roles labor_amount / parts_amount where those apply.
- Any personal data (emails, names, phone numbers) must have pii=true and transform "sha256_pii".
- Codes and statuses: "upper_trim". Free text: "trim".
- target_column names: snake_case, unique, readable (expand abbreviations such as DT, AMT, CD, NUM).

Allowed transforms: ${Object.entries(TRANSFORMS).map(([k, v]) => `${k} (${v.label})`).join('; ')}.`;
}

export function validateMapping(mapping, profile) {
  const errors = [];
  const srcCols = new Set(profile.columns.map((c) => c.name));
  const seenSrc = new Set();
  const seenTgt = new Set();
  if (!/^[a-z][a-z0-9_]*$/.test(mapping.entity_name || '')) errors.push(`entity_name "${mapping.entity_name}" is not snake_case`);
  for (const c of mapping.columns || []) {
    if (!srcCols.has(c.source_column)) errors.push(`unknown source column ${c.source_column}`);
    if (seenSrc.has(c.source_column)) errors.push(`source column ${c.source_column} mapped twice`);
    seenSrc.add(c.source_column);
    if (!/^[a-z][a-z0-9_]*$/.test(c.target_column)) errors.push(`target ${c.target_column} is not snake_case`);
    if (seenTgt.has(c.target_column)) errors.push(`duplicate target ${c.target_column}`);
    seenTgt.add(c.target_column);
    if (c.target_column.startsWith('_') || ['part_no_std', 'part_mapping_status', 'model_family', 'product_line', 'vertical'].includes(c.target_column)) errors.push(`target ${c.target_column} is reserved`);
    if (!ROLES.includes(c.role)) errors.push(`invalid role ${c.role}`);
    if (!TRANSFORMS[c.transform]) errors.push(`invalid transform ${c.transform}`);
    if (c.role === 'contact_email' && c.transform !== 'sha256_pii') errors.push(`${c.source_column} is personal data but not hashed`);
  }
  for (const s of srcCols) if (!seenSrc.has(s)) errors.push(`source column ${s} not mapped`);
  const keys = (mapping.columns || []).filter((c) => c.role === 'record_id');
  if (keys.length !== 1) errors.push(`expected exactly one record_id column, got ${keys.length}`);
  if ((mapping.columns || []).filter((c) => c.role === 'part_number').length > 1) errors.push('at most one part_number column is supported');
  if (keys.length === 1) mapping.business_key = [keys[0].target_column];
  return errors;
}

// ---- SQL compilation -----------------------------------------------------
function colExpr(c) {
  const s = q(c.source_column);
  const v = `nullif(trim(${s}), '')`;
  switch (c.transform) {
    case 'none': return s;
    case 'trim': return v;
    case 'upper_trim': return `upper(${v})`;
    case 'parse_date_mdy': return `try_strptime(${v}, '%m/%d/%Y')::DATE`;
    case 'parse_date_iso': return `try_cast(${v} AS DATE)`;
    case 'parse_timestamp': return `try_cast(${v} AS TIMESTAMP)`;
    case 'to_decimal': return `try_cast(replace(${v}, ',', '') AS DECIMAL(14,2))`;
    case 'to_decimal_precise': return `try_cast(replace(${v}, ',', '') AS DECIMAL(14,4))`;
    case 'to_integer': return `try_cast(replace(${v}, ',', '') AS INTEGER)`;
    case 'std_part_no': return v;
    case 'sha256_pii': return `CASE WHEN ${v} IS NULL THEN NULL ELSE sha256(lower(${v})) END`;
    default: throw new Error(`unknown transform ${c.transform}`);
  }
}

// ---- layer rules ---------------------------------------------------------
// The rules that decide which rows land in each layer. They are part of the proposal, shown in
// plain English, and the reviewer can change them before approving (Request changes).
export const LOAD_MODES = {
  append: 'Keep full history: every load is appended to Bronze with its batch id',
  replace: 'Replace on each load: Bronze holds only the latest extract',
  incremental: 'Incremental: append only records newer than the last loaded date (watermark)',
};
const INACTIVE_STATUS = /^(REJECTED|CANCELL?ED|VOID(ED)?|DELETED|INACTIVE|DUPLICATE|OBSOLETE)$/;

const statusColumnOf = (mapping) => mapping.columns.find((c) => c.role === 'status') || null;
const dateColumnOf = (mapping) => mapping.columns.find((c) => c.role === 'event_date' || c.role === 'event_timestamp') || null;
const amountColumnsOf = (mapping) => mapping.columns.filter((c) => ['labor_amount', 'parts_amount', 'amount'].includes(c.role) && ['to_decimal', 'to_decimal_precise', 'to_integer'].includes(c.transform));

export function defaultLayerRules(profile, mapping) {
  const st = statusColumnOf(mapping);
  const values = st ? [...new Set((profile.columns.find((c) => c.name === st.source_column)?.top_values || [])
    .map((t) => (t.value == null ? '' : String(t.value).trim().toUpperCase())).filter(Boolean))].sort() : [];
  return {
    status_column: st ? st.target_column : null,
    status_values: values,
    bronze: { load_mode: 'append' },
    silver: { keep_statuses: values, quarantine_bad_date: Boolean(dateColumnOf(mapping)), quarantine_negative_amounts: false },
    gold: { include_statuses: values.filter((v) => !INACTIVE_STATUS.test(v)) },
  };
}

// Normalises the rules in place; returns errors (blocking) and warnings (auto-corrected).
export function validateLayerRules(rules, mapping) {
  const errors = [];
  const warnings = [];
  const st = statusColumnOf(mapping);
  rules.status_column = st ? st.target_column : null;
  rules.status_values = (rules.status_values || []).map((v) => String(v).trim().toUpperCase());
  rules.bronze ||= { load_mode: 'append' };
  rules.silver ||= {};
  rules.gold ||= {};
  if (!LOAD_MODES[rules.bronze.load_mode]) errors.push(`unknown Bronze load mode "${rules.bronze.load_mode}"`);
  if (rules.bronze.load_mode === 'incremental' && !dateColumnOf(mapping)) errors.push('incremental loading needs a date column to use as the watermark');
  const known = new Set(rules.status_values);
  const clean = (list, label) => {
    const out = [...new Set((list || []).map((v) => String(v).trim().toUpperCase()))];
    const bad = out.filter((v) => !known.has(v));
    if (bad.length) warnings.push(`${label}: ignored unknown status value(s) ${bad.join(', ')}`);
    return out.filter((v) => known.has(v)).sort();
  };
  if (rules.status_column) {
    rules.silver.keep_statuses = clean(rules.silver.keep_statuses ?? rules.status_values, 'Silver');
    rules.gold.include_statuses = clean(rules.gold.include_statuses ?? rules.status_values, 'Gold');
    if (!rules.silver.keep_statuses.length) errors.push('Silver would keep no records: select at least one status');
    const dropped = rules.gold.include_statuses.filter((v) => !rules.silver.keep_statuses.includes(v));
    if (dropped.length) {
      warnings.push(`Gold cannot include ${dropped.join(', ')} because Silver does not keep ${dropped.length > 1 ? 'them' : 'it'}; removed from Gold.`);
      rules.gold.include_statuses = rules.gold.include_statuses.filter((v) => rules.silver.keep_statuses.includes(v));
    }
    if (!rules.gold.include_statuses.length) errors.push('Gold would include no records: select at least one status');
  } else {
    rules.silver.keep_statuses = [];
    rules.gold.include_statuses = [];
  }
  rules.silver.quarantine_bad_date = Boolean(rules.silver.quarantine_bad_date) && Boolean(dateColumnOf(mapping));
  rules.silver.quarantine_negative_amounts = Boolean(rules.silver.quarantine_negative_amounts) && amountColumnsOf(mapping).length > 0;
  return { errors, warnings };
}

const statusFilterActive = (rules) => Boolean(rules.status_column) && rules.silver.keep_statuses.length < rules.status_values.length;
const inList = (vals) => vals.map((v) => lit(v)).join(', ');

// Plain-English list of the rules (shown to the reviewer next to the controls that change them).
export function describeLayerRules(rules, mapping) {
  const key = mapping.columns.find((c) => c.role === 'record_id');
  const date = dateColumnOf(mapping);
  const amounts = amountColumnsOf(mapping);
  const out = [];
  out.push({ layer: 'bronze', id: 'bronze.load_mode', rule: LOAD_MODES[rules.bronze.load_mode] });
  out.push({ layer: 'bronze', rule: 'Every row gets audit columns: source system, batch id, load time and a record hash' });
  out.push({ layer: 'silver', rule: 'Columns are typed, renamed and personal data hashed as per the schema mapping' });
  out.push({ layer: 'silver', rule: `Rows with a missing ${key.source_column} go to quarantine` });
  if (date) out.push({ layer: 'silver', id: 'silver.quarantine_bad_date', rule: rules.silver.quarantine_bad_date ? `Rows with a missing or unparseable ${date.source_column} go to quarantine` : `Rows with a missing or unparseable ${date.source_column} are kept in Silver (they cannot appear in date-based Gold reports)` });
  if (amounts.length) out.push({ layer: 'silver', id: 'silver.quarantine_negative_amounts', rule: rules.silver.quarantine_negative_amounts ? `Rows with a negative ${amounts.map((a) => a.source_column).join(' or ')} go to quarantine` : `Negative ${amounts.map((a) => a.source_column).join(' / ')} values are kept and flagged as a DQ warning (e.g. credit adjustments)` });
  out.push({ layer: 'silver', rule: `One row per ${key.target_column}: duplicates and older versions are removed, keeping the most recent load` });
  if (rules.status_column) {
    out.push({ layer: 'silver', id: 'silver.keep_statuses', rule: statusFilterActive(rules) ? `Keep only ${rules.status_column} ${rules.silver.keep_statuses.join(', ')}; other statuses stay in Bronze history only` : `Keep all ${rules.status_column} values (${rules.status_values.join(', ')})` });
    const excl = rules.silver.keep_statuses.filter((v) => !rules.gold.include_statuses.includes(v));
    out.push({ layer: 'gold', id: 'gold.include_statuses', rule: `Gold facts and reports include ${rules.status_column} ${rules.gold.include_statuses.join(', ')}${excl.length ? `; ${excl.join(', ')} excluded` : ''}` });
  }
  out.push({ layer: 'gold', rule: 'Gold facts are built when a report first needs them, conformed to the date dimension and product hierarchy' });
  return out;
}

// ---- SQL compilation -----------------------------------------------------
export function compileOnboarding(profile, mapping, batchId, rules) {
  const system = profile.system;
  const bronze = `bronze.${system}__${profile.source_table}`;
  const silver = `silver.${mapping.entity_name}`;
  const quarantine = `silver.${mapping.entity_name}__quarantine`;
  const key = mapping.columns.find((c) => c.role === 'record_id');
  const dateCol = dateColumnOf(mapping);
  const partCol = mapping.columns.find((c) => c.role === 'part_number');
  const statusCol = statusColumnOf(mapping);
  const amounts = amountColumnsOf(mapping);
  const srcCols = profile.columns.map((c) => q(c.name));
  const mode = rules.bronze.load_mode;

  const bronzeSelect = `SELECT
  ${srcCols.join(',\n  ')},
  '${system}' AS _source_system,
  '${profile.source_table}' AS _source_table,
  '${batchId}' AS _batch_id,
  now() AS _ingested_at,
  md5(concat_ws('|', ${srcCols.join(', ')})) AS _record_hash
FROM ${profile.table}`;
  const wm = dateCol ? colExpr(dateCol) : null;
  let bronzeSql;
  if (mode === 'replace') {
    bronzeSql = `-- Bronze: raw copy of ${profile.table} with audit columns (convention: bronze.{system}__{table})
-- Load rule: replace on each load (no history kept)
CREATE OR REPLACE TABLE ${bronze} AS
${bronzeSelect};`;
  } else {
    const where = mode === 'incremental'
      ? `\nWHERE coalesce(${wm} > (SELECT max(${wm}) FROM ${bronze}), (SELECT count(*) FROM ${bronze}) = 0)` : '';
    const ruleText = mode === 'incremental'
      ? `incremental - only rows with ${dateCol.source_column} after the latest date already in Bronze (watermark)`
      : 'keep full history - each load is appended with its batch id';
    bronzeSql = `-- Bronze: raw copy of ${profile.table} with audit columns (convention: bronze.{system}__{table})
-- Load rule: ${ruleText}
CREATE TABLE IF NOT EXISTS ${bronze} AS
${bronzeSelect}
WHERE false;
INSERT INTO ${bronze} BY NAME
${bronzeSelect}${where};`;
  }
  // Rows expected in this batch (for the completeness check).
  const expectedSql = mode === 'incremental'
    ? `SELECT count(*) AS n FROM ${profile.table} WHERE coalesce(${wm} > (SELECT max(${wm}) FROM ${bronze} WHERE _batch_id <> '${batchId}'), (SELECT count(*) FROM ${bronze} WHERE _batch_id <> '${batchId}') = 0)`
    : `SELECT count(*) AS n FROM ${profile.table}`;

  const typedCols = mapping.columns.map((c) => `    ${colExpr(c)} AS ${q(c.target_column)}`);
  if (partCol) typedCols.push(`    silver.std_part_no(${q(partCol.source_column)}) AS _part_std`);
  const typed = `  typed AS (
  SELECT
${typedCols.join(',\n')},
    _source_system, _batch_id, _ingested_at, _record_hash
  FROM ${bronze}
  )`;
  const validity = [`${q(key.target_column)} IS NOT NULL`];
  const reasons = [`WHEN ${q(key.target_column)} IS NULL THEN 'missing business key (${key.source_column})'`];
  if (dateCol && rules.silver.quarantine_bad_date) {
    validity.push(`${q(dateCol.target_column)} IS NOT NULL`);
    reasons.push(`WHEN ${q(dateCol.target_column)} IS NULL THEN 'missing or unparseable ${dateCol.source_column}'`);
  }
  if (rules.silver.quarantine_negative_amounts) {
    for (const a of amounts) {
      validity.push(`coalesce(${q(a.target_column)} >= 0, true)`);
      reasons.push(`WHEN ${q(a.target_column)} < 0 THEN 'negative ${a.source_column}'`);
    }
  }
  const filterOn = statusFilterActive(rules);
  const statusCond = filterOn ? `coalesce(upper(trim(${q(statusCol.target_column)})), '') IN (${inList(rules.silver.keep_statuses)})` : null;
  const validCte = `  valid AS (
  SELECT * FROM typed
  WHERE ${validity.join(' AND ')}
  QUALIFY row_number() OVER (PARTITION BY ${q(key.target_column)} ORDER BY _ingested_at DESC, _record_hash) = 1
  )`;
  const keptCte = filterOn ? `,
  kept AS (
  -- Layer rule: keep only ${statusCol.target_column} ${rules.silver.keep_statuses.join(', ')}
  SELECT * FROM valid WHERE ${statusCond}
  )` : '';

  const outCols = mapping.columns.map((c) => `  v.${q(c.target_column)}`);
  let partSelect = '';
  let partJoins = '';
  if (partCol) {
    partSelect = `,
  coalesce(o.part_no, ss.new_part_no, v._part_std) AS part_no_std,
  CASE
    WHEN h.part_no IS NULL THEN 'unmapped'
    WHEN o.part_no IS NOT NULL THEN 'steward_override'
    WHEN ss.new_part_no IS NOT NULL THEN 'superseded'
    WHEN v.${q(partCol.target_column)} = h.part_no THEN 'exact'
    ELSE 'standardised'
  END AS part_mapping_status,
  h.model_family,
  h.product_line,
  h.vertical`;
    partJoins = `
LEFT JOIN silver.part_mapping_overrides o ON o.raw_part_no = v._part_std
LEFT JOIN silver.part_supersession ss ON ss.old_part_no = v._part_std
LEFT JOIN silver.product_hierarchy h ON h.part_no = coalesce(o.part_no, ss.new_part_no, v._part_std)`;
  }

  const silverSql = `-- Silver: typed, de-duplicated on ${key.target_column} (latest load wins), PII hashed${partCol ? ', part numbers mapped to product hierarchy' : ''}${filterOn ? `, only ${statusCol.target_column} ${rules.silver.keep_statuses.join('/')}` : ''}
CREATE OR REPLACE TABLE ${silver} AS
WITH
${typed},
${validCte}${keptCte}
SELECT
${outCols.join(',\n')}${partSelect},
  v._source_system,
  v._batch_id,
  v._record_hash
FROM ${filterOn ? 'kept' : 'valid'} v${partJoins};`;

  const quarantineSql = `-- Quarantine: rows that fail the Silver rules are kept with a reason, never dropped silently
CREATE OR REPLACE TABLE ${quarantine} AS
WITH
${typed}
SELECT typed.* EXCLUDE (${partCol ? '_part_std, ' : ''}_ingested_at),
  CASE ${reasons.join(' ')} END AS reject_reason
FROM typed
WHERE NOT (${validity.join(' AND ')});`;

  // Measurement-only queries (never deployed): rows removed by the status rule, and statuses reaching Silver.
  const filteredSql = filterOn ? `WITH\n${typed},\n${validCte}\nSELECT count(*) AS n FROM valid WHERE NOT (${statusCond})` : null;
  const statusFlowSql = statusCol ? `WITH\n${typed},\n${validCte}\nSELECT coalesce(upper(trim(${q(statusCol.target_column)})), '<blank>') AS status, count(*) AS n FROM valid GROUP BY 1 ORDER BY n DESC` : null;

  return {
    bronze, silver, quarantine, batchId,
    sql: { bronze: bronzeSql, silver: silverSql, quarantine: quarantineSql },
    measure: { expected: expectedSql, filtered: filteredSql, statusFlow: statusFlowSql },
  };
}

function allSql(compiled) {
  return [compiled.sql.bronze, compiled.sql.silver, compiled.sql.quarantine].join('\n\n');
}

// ---- data quality ----------------------------------------------------------
async function runChecks(profile, mapping, compiled, rules) {
  const { bronze, silver, quarantine } = compiled;
  const key = q(mapping.business_key[0]);
  const dateCol = dateColumnOf(mapping);
  const partCol = mapping.columns.find((c) => c.role === 'part_number');
  const amounts = mapping.columns.filter((c) => ['to_decimal', 'to_integer'].includes(c.transform) && ['labor_amount', 'parts_amount', 'amount', 'quantity'].includes(c.role));
  const piiCols = mapping.columns.filter((c) => c.pii);
  const n = async (sql) => (await one(sql)).n;

  const src = await n(`SELECT count(*) AS n FROM ${profile.table}`);
  const br = await n(`SELECT count(*) AS n FROM ${bronze}`);
  const batchRows = await n(`SELECT count(*) AS n FROM ${bronze} WHERE _batch_id = '${compiled.batchId}'`);
  const expected = await n(compiled.measure.expected);
  const sv = await n(`SELECT count(*) AS n FROM ${silver}`);
  const qu = await n(`SELECT count(*) AS n FROM ${quarantine}`);
  const filtered = compiled.measure.filtered ? await n(compiled.measure.filtered) : 0;
  const dupes = br - sv - qu - filtered;
  const history = br - batchRows;
  const out = [];
  const add = (dataset, name, severity, failed, total, threshold, passed, detail) => out.push({ dataset, name, severity, failed, total, threshold, passed, detail });

  const mode = rules.bronze.load_mode;
  add(bronze, 'Bronze completeness (rows loaded in this batch = rows expected)', 'error', Math.abs(expected - batchRows), expected, '0', expected === batchRows,
    `${batchRows} of ${expected} ${mode === 'incremental' ? 'new ' : ''}source rows landed in ${compiled.batchId}${history > 0 ? `; ${history} rows kept from earlier loads (history)` : ''}`);
  add(silver, 'Row accounting (bronze = silver + quarantine + excluded by rule + duplicates)', 'info', 0, br, 'n/a', true,
    `${br} bronze = ${sv} silver + ${qu} quarantined + ${filtered} excluded by status rule + ${dupes} duplicates / older versions removed`);
  if (filtered) add(silver, 'Rows excluded by the Silver status rule', 'info', filtered, br, 'n/a', true, `Only ${rules.status_column} ${rules.silver.keep_statuses.join(', ')} kept; the rest remain in Bronze history`);
  const nullKeys = await n(`SELECT count(*) AS n FROM ${silver} WHERE ${key} IS NULL`);
  add(silver, `Business key ${mapping.business_key[0]} not null`, 'error', nullKeys, sv, '0', nullKeys === 0, '');
  const dupKeys = await n(`SELECT count(*) - count(DISTINCT ${key}) AS n FROM ${silver}`);
  add(silver, `Business key ${mapping.business_key[0]} unique`, 'error', dupKeys, sv, '0', dupKeys === 0, '');
  if (dateCol) {
    const bad = await n(`SELECT count(*) AS n FROM ${silver} WHERE ${q(dateCol.target_column)} < DATE '2000-01-01' OR ${q(dateCol.target_column)} > current_date + 1`);
    add(silver, `${dateCol.target_column} within plausible range`, 'error', bad, sv, '0', bad === 0, '2000-01-01 .. today');
    if (!rules.silver.quarantine_bad_date) {
      const missing = await n(`SELECT count(*) AS n FROM ${silver} WHERE ${q(dateCol.target_column)} IS NULL`);
      add(silver, `${dateCol.target_column} missing (kept by layer rule)`, 'warning', missing, sv, '<= 1%', missing <= Math.floor(sv * 0.01), missing ? `${missing} row(s) without a usable date are kept in Silver but cannot reach date-based Gold reports` : '');
    }
  }
  for (const a of amounts) {
    const neg = await n(`SELECT count(*) AS n FROM ${silver} WHERE ${q(a.target_column)} < 0`);
    const lim = Math.floor(sv * 0.01);
    add(silver, `${a.target_column} non-negative`, 'warning', neg, sv, '<= 1%', neg <= lim, neg ? `${neg} negative value(s) - likely credit adjustments, review with finance` : '');
    const unparsed = await n(`SELECT count(*) AS n FROM ${bronze} WHERE nullif(trim(${q(a.source_column)}), '') IS NOT NULL AND try_cast(replace(trim(${q(a.source_column)}), ',', '') AS DECIMAL(14,2)) IS NULL`);
    add(silver, `${a.target_column} parses as number`, 'error', unparsed, br, '0', unparsed === 0, '');
  }
  if (partCol) {
    const unm = await n(`SELECT count(*) AS n FROM ${silver} WHERE part_mapping_status = 'unmapped'`);
    const rate = sv ? (1 - unm / sv) * 100 : 0;
    add(silver, 'Part numbers mapped to product hierarchy', 'error', unm, sv, '>= 95% mapped', rate >= 95, `${rate.toFixed(1)}% mapped; ${unm} rows flagged as exceptions`);
  }
  for (const p of piiCols) {
    const clear = await n(`SELECT count(*) AS n FROM ${silver} WHERE ${q(p.target_column)} LIKE '%@%'`);
    add(silver, `${p.target_column} contains no clear-text personal data`, 'error', clear, sv, '0', clear === 0, '');
  }
  const qRate = br ? (qu / br) * 100 : 0;
  add(quarantine, 'Quarantine rate', 'warning', qu, br, '<= 5%', qRate <= 5, `${qRate.toFixed(2)}% of rows quarantined`);
  return { checks: out, counts: { source: src, bronze: br, bronze_batch: batchRows, silver: sv, quarantine: qu, excluded_by_rule: filtered, duplicates_removed: dupes } };
}

async function partExceptions(mapping, compiled) {
  const partCol = mapping.columns.find((c) => c.role === 'part_number');
  if (!partCol) return [];
  const rows = await all(`
    WITH u AS (
      SELECT part_no_std AS normalized, string_agg(DISTINCT coalesce(${q(partCol.target_column)}, '<blank>'), ' | ') AS raw_values, count(*) AS row_count
      FROM ${compiled.silver} WHERE part_mapping_status = 'unmapped' GROUP BY 1
    )
    SELECT u.normalized, u.raw_values, u.row_count,
           min_by(h.part_no, levenshtein(h.part_no, coalesce(u.normalized, ''))) AS best,
           min(levenshtein(h.part_no, coalesce(u.normalized, ''))) AS dist
    FROM u CROSS JOIN silver.product_hierarchy h
    GROUP BY ALL ORDER BY row_count DESC`);
  return rows.map((r) => {
    const placeholder = !r.normalized || /^(UNKNOWN|NA|N\/A|TBD|NONE|NULL|0+)$/.test(r.normalized);
    const near = !placeholder && r.dist === 1;
    return {
      normalized: r.normalized,
      raw_values: r.raw_values.length > 80 ? r.raw_values.slice(0, 77) + '...' : r.raw_values,
      row_count: r.row_count,
      reason: placeholder ? 'Blank or placeholder value' : near ? 'Near match - possible keying error' : 'Not found in product hierarchy',
      suggestion: near ? r.best : null,
    };
  });
}

// What each layer looks like after the dry run: sample rows, and which statuses reach Silver and Gold.
async function layerPreview(mapping, compiled, rules) {
  const dateCol = dateColumnOf(mapping);
  const bronzeSample = await all(`SELECT * EXCLUDE (_record_hash) FROM ${compiled.bronze} WHERE _batch_id = '${compiled.batchId}' LIMIT 5`);
  const quarantineSample = await all(`SELECT * FROM ${compiled.quarantine} LIMIT 5`);
  let statusFlow = [];
  if (compiled.measure.statusFlow) {
    statusFlow = (await all(compiled.measure.statusFlow)).map((r) => ({
      status: r.status, rows: r.n,
      in_silver: rules.silver.keep_statuses.includes(r.status),
      in_gold: rules.silver.keep_statuses.includes(r.status) && rules.gold.include_statuses.includes(r.status),
    }));
  }
  const goldWhere = [rules.status_column ? `coalesce(upper(trim(${q(rules.status_column)})), '') IN (${inList(rules.gold.include_statuses)})` : 'true'];
  if (dateCol) goldWhere.push(`${q(dateCol.target_column)} IS NOT NULL`);
  const goldRows = (await one(`SELECT count(*) AS n FROM ${compiled.silver} WHERE ${goldWhere.join(' AND ')}`)).n;
  const goldSample = await all(`SELECT * EXCLUDE (_record_hash, _source_system, _batch_id) FROM ${compiled.silver} WHERE ${goldWhere.join(' AND ')} USING SAMPLE 5 ROWS (reservoir, 11)`);
  return { bronzeSample, quarantineSample, statusFlow, goldRows, goldSample };
}

// ---- propose ---------------------------------------------------------------
export async function proposeOnboarding({ sourceTable, requestText }) {
  const notes = [];
  const profile = await profileTable(sourceTable);
  notes.push({ step: 'Profile source', engine: 'deterministic', note: `${profile.row_count} rows, ${profile.columns.length} columns, ${profile.exact_duplicate_rows} exact duplicates` });

  let mapping = null;
  let engine = 'rules';
  const ai = await structured({ system: SYSTEM_PROMPT, prompt: `Request from data engineer: "${requestText}"\n\n${mappingPrompt(profile)}`, schema: MAPPING_SCHEMA });
  if (ai.ok) {
    const errs = validateMapping(ai.data, profile);
    if (errs.length) notes.push({ step: 'Schema mapping', engine: 'claude', note: `Claude proposal rejected by validator: ${errs.slice(0, 3).join('; ')}. Fell back to rule engine.` });
    else { mapping = ai.data; engine = 'claude'; notes.push({ step: 'Schema mapping', engine: 'claude', note: `Proposed by ${engineInfo().label}; passed validation.` }); }
  } else if (engineInfo().mode === 'claude') {
    notes.push({ step: 'Schema mapping', engine: 'claude', note: `Claude unavailable (${ai.error}); used rule engine.` });
  }
  if (!mapping) {
    mapping = rules.proposeMapping(profile);
    const errs = validateMapping(mapping, profile);
    if (errs.length) throw new Error(`Could not produce a valid mapping: ${errs.join('; ')}`);
    notes.push({ step: 'Schema mapping', engine: 'rules', note: 'Proposed by rule engine from column names and value patterns.' });
  }
  const layerRules = defaultLayerRules(profile, mapping);
  notes.push({ step: 'Layer rules', engine: 'deterministic', note: 'Default Bronze / Silver / Gold rules applied from platform conventions; the reviewer can change them with Request changes.' });
  return buildOnboarding({ sourceTable, requestText, profile, mapping, layerRules, notes, engine });
}

async function buildOnboarding({ sourceTable, requestText, profile, mapping, layerRules, notes, engine, warnings = [] }) {
  const v = validateLayerRules(layerRules, mapping);
  if (v.errors.length) throw Object.assign(new Error(`Layer rules are not valid: ${v.errors.join('; ')}`), { status: 400 });
  warnings = [...warnings, ...v.warnings];

  const batchId = `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const compiled = compileOnboarding(profile, mapping, batchId, layerRules);
  notes.push({ step: 'Generate pipelines', engine: 'deterministic', note: 'Bronze, Silver and quarantine SQL compiled from the mapping and layer rules using platform conventions.' });

  // Dry run: execute everything, measure, then roll back.
  const preview = await transaction(async () => {
    await runScript(allSql(compiled));
    const dq = await runChecks(profile, mapping, compiled, layerRules);
    const exceptions = await partExceptions(mapping, compiled);
    const sample = await all(`SELECT * EXCLUDE (_record_hash) FROM ${compiled.silver} USING SAMPLE 8 ROWS (reservoir, 7)`);
    const mappingStats = mapping.columns.some((c) => c.role === 'part_number')
      ? await all(`SELECT part_mapping_status AS status, count(*) AS n FROM ${compiled.silver} GROUP BY 1 ORDER BY n DESC`) : [];
    const quarantineReasons = await all(`SELECT reject_reason, count(*) AS n FROM ${compiled.quarantine} GROUP BY 1 ORDER BY n DESC`);
    const layers = await layerPreview(mapping, compiled, layerRules);
    return { ...dq, exceptions, sample, mappingStats, quarantineReasons, layers };
  }, { commit: false });
  notes.push({ step: 'Dry run', engine: 'deterministic', note: `Executed in a rolled-back transaction: ${preview.checks.filter((c) => !c.passed).length} check(s) need attention.` });

  const blocking = preview.checks.filter((c) => c.severity === 'error' && !c.passed);
  const title = `Onboard ${profile.table} → ${compiled.silver}`;
  const summary = `${profile.row_count} rows profiled; ${mapping.columns.length} columns mapped; ${preview.counts.silver} silver rows, ${preview.counts.quarantine} quarantined${preview.counts.excluded_by_rule ? `, ${preview.counts.excluded_by_rule} excluded by status rule` : ''}, ${preview.counts.duplicates_removed} duplicates removed; ${preview.exceptions.reduce((s, e) => s + e.row_count, 0)} rows with part-number exceptions; ${blocking.length ? blocking.length + ' blocking DQ issue(s)' : 'all blocking DQ checks pass'}.`;
  return {
    title, summary, engine,
    payload: {
      source_table: sourceTable, request_text: requestText, batch_id: batchId, profile, mapping,
      layer_rules: layerRules, rule_descriptions: describeLayerRules(layerRules, mapping), warnings,
      targets: { bronze: compiled.bronze, silver: compiled.silver, quarantine: compiled.quarantine },
      sql: compiled.sql, measure_sql: compiled.measure, preview, notes,
    },
  };
}

// ---- revise (reviewer asked for changes) ------------------------------------
const flatRules = (r) => ({
  bronze_load_mode: r.bronze.load_mode, silver_keep_statuses: r.silver.keep_statuses, gold_include_statuses: r.gold.include_statuses,
  quarantine_bad_date: r.silver.quarantine_bad_date, quarantine_negative_amounts: r.silver.quarantine_negative_amounts,
});
const unflatRules = (f, base) => ({
  ...base,
  bronze: { load_mode: f.bronze_load_mode },
  silver: { keep_statuses: f.silver_keep_statuses, quarantine_bad_date: f.quarantine_bad_date, quarantine_negative_amounts: f.quarantine_negative_amounts },
  gold: { include_statuses: f.gold_include_statuses },
});

export function describeOnboardingChanges(oldM, newM, oldR, newR) {
  const out = [];
  if (oldM.entity_name !== newM.entity_name) out.push(`Silver table renamed silver.${oldM.entity_name} → silver.${newM.entity_name}`);
  const before = Object.fromEntries(oldM.columns.map((c) => [c.source_column, c]));
  for (const c of newM.columns) {
    const o = before[c.source_column];
    if (!o) continue;
    if (o.target_column !== c.target_column) out.push(`${c.source_column}: renamed ${o.target_column} → ${c.target_column}`);
    if (o.role !== c.role) out.push(`${c.source_column}: role ${o.role} → ${c.role}`);
    if (o.transform !== c.transform) out.push(`${c.source_column}: transform ${o.transform} → ${c.transform}`);
    if (Boolean(o.pii) !== Boolean(c.pii)) out.push(`${c.source_column}: ${c.pii ? 'marked' : 'unmarked'} as personal data`);
  }
  const fo = flatRules(oldR), fn = flatRules(newR);
  if (fo.bronze_load_mode !== fn.bronze_load_mode) out.push(`Bronze load rule: ${fo.bronze_load_mode} → ${fn.bronze_load_mode}`);
  const listDiff = (a, b, label) => { if (a.join() !== b.join()) out.push(`${label}: ${a.join(', ') || 'none'} → ${b.join(', ') || 'none'}`); };
  listDiff(fo.silver_keep_statuses, fn.silver_keep_statuses, 'Silver keeps statuses');
  listDiff(fo.gold_include_statuses, fn.gold_include_statuses, 'Gold includes statuses');
  if (fo.quarantine_bad_date !== fn.quarantine_bad_date) out.push(`Missing/unparseable dates: ${fn.quarantine_bad_date ? 'quarantined' : 'kept in Silver'}`);
  if (fo.quarantine_negative_amounts !== fn.quarantine_negative_amounts) out.push(`Negative amounts: ${fn.quarantine_negative_amounts ? 'quarantined' : 'kept (DQ warning)'}`);
  return out;
}

function revisionSchema(statusValues) {
  const statusItems = statusValues.length ? { type: 'string', enum: statusValues } : { type: 'string' };
  return {
    type: 'object', additionalProperties: false, required: ['mapping', 'layer_rules', 'not_applied'],
    properties: {
      mapping: MAPPING_SCHEMA,
      layer_rules: {
        type: 'object', additionalProperties: false,
        required: ['bronze_load_mode', 'silver_keep_statuses', 'gold_include_statuses', 'quarantine_bad_date', 'quarantine_negative_amounts'],
        properties: {
          bronze_load_mode: { type: 'string', enum: Object.keys(LOAD_MODES) },
          silver_keep_statuses: { type: 'array', items: statusItems },
          gold_include_statuses: { type: 'array', items: statusItems },
          quarantine_bad_date: { type: 'boolean' },
          quarantine_negative_amounts: { type: 'boolean' },
        },
      },
      not_applied: { type: 'array', items: { type: 'string' }, description: 'Parts of the comment that cannot be expressed with these fields' },
    },
  };
}

export async function reviseOnboarding(payload, { edits = {}, comment = '' }) {
  const profile = payload.profile;
  const oldMapping = payload.mapping;
  const oldRules = payload.layer_rules || defaultLayerRules(profile, oldMapping);
  let mapping = structuredClone(oldMapping);
  let layerRules = structuredClone(oldRules);
  const notes = [];
  let engine = 'rules';
  let notApplied = [];

  // 1. Edits made directly in the review screen.
  for (const e of edits.columns || []) {
    const c = mapping.columns.find((x) => x.source_column === e.source_column);
    if (!c) continue;
    for (const k of ['target_column', 'role', 'transform']) if (e[k] !== undefined && e[k] !== '') c[k] = String(e[k]).trim();
    if (e.pii !== undefined) c.pii = Boolean(e.pii);
    if (c.pii && c.transform !== 'sha256_pii') c.transform = 'sha256_pii';
  }
  if (edits.layer_rules) {
    const f = { ...flatRules(layerRules), ...edits.layer_rules };
    layerRules = unflatRules(f, layerRules);
  }
  const editChanges = describeOnboardingChanges(oldMapping, mapping, oldRules, layerRules);
  if (editChanges.length) notes.push({ step: 'Reviewer edits', engine: 'deterministic', note: editChanges.join('; ') });

  // 2. The reviewer's comment, interpreted by Claude (or the rule engine) on top of those edits.
  if (comment.trim()) {
    const before = { m: structuredClone(mapping), r: structuredClone(layerRules) };
    const ai = await structured({
      system: SYSTEM_PROMPT,
      prompt: `A reviewer asked for changes to this source onboarding proposal for ${profile.table}.

Reviewer comment: "${comment}"

Current schema mapping (JSON):
${JSON.stringify(mapping, null, 1)}

Current layer rules (JSON):
${JSON.stringify(flatRules(layerRules), null, 1)}
Status values seen in ${layerRules.status_column || 'the source'}: ${layerRules.status_values.join(', ') || 'none (no status column)'}.

Return the complete revised mapping and layer rules. Change only what the comment asks for and keep everything else exactly as it is. Mapping rules still apply: every source column mapped once, exactly one record_id, personal data hashed with sha256_pii, snake_case names. List any part of the comment you could not express in not_applied.`,
      schema: revisionSchema(layerRules.status_values),
    });
    let used = false;
    if (ai.ok) {
      const candM = ai.data.mapping;
      const candR = unflatRules(ai.data.layer_rules, layerRules);
      const errs = validateMapping(candM, profile);
      const rv = validateLayerRules(structuredClone(candR), candM);
      if (errs.length || rv.errors.length) notes.push({ step: 'Revision', engine: 'claude', note: `Claude revision rejected by validator: ${[...errs, ...rv.errors].slice(0, 3).join('; ')}. Used rule engine.` });
      else { mapping = candM; layerRules = candR; notApplied = ai.data.not_applied || []; engine = 'claude'; used = true; }
    } else if (engineInfo().mode === 'claude') {
      notes.push({ step: 'Revision', engine: 'claude', note: `Claude unavailable (${ai.error}); used rule engine.` });
    }
    if (!used) {
      const r = rules.reviseOnboardingFromComment(comment, mapping, layerRules);
      notApplied = r.unrecognised;
    }
    const fromComment = describeOnboardingChanges(before.m, mapping, before.r, layerRules);
    notes.push({ step: 'Revision', engine, note: `${fromComment.length ? `From the comment: ${fromComment.join('; ')}` : 'No change could be derived from the comment'}${notApplied.length ? `. Not applied: ${notApplied.join(' | ')}` : ''}.` });
  }

  const changes = describeOnboardingChanges(oldMapping, mapping, oldRules, layerRules);
  if (!changes.length) {
    throw Object.assign(new Error(`No change could be applied${notApplied.length ? ` (not understood: ${notApplied.join(' | ')})` : ''}. Edit the fields on the review screen, or phrase the comment like "rename CLAIM_NO to claim_id", "keep only APPROVED and PAID in silver", "exclude PENDING from gold", "quarantine negative amounts" or "replace bronze on each load".`), { status: 400 });
  }
  const errs = validateMapping(mapping, profile);
  if (errs.length) throw Object.assign(new Error(`The requested change makes the mapping invalid: ${errs.join('; ')}`), { status: 400 });

  notes.push({ step: 'Profile source', engine: 'deterministic', note: 'Reused the profile from the previous version.' });
  const proposal = await buildOnboarding({ sourceTable: payload.source_table, requestText: payload.request_text, profile, mapping, layerRules, notes, engine });
  return { ...proposal, changes, notApplied };
}

// ---- deploy (after approval) ---------------------------------------------
export async function deployOnboarding(artifact, { reviewer, acceptSuggestions = false }) {
  const p = artifact.payload;
  const { profile, mapping } = p;
  const layerRules = p.layer_rules || defaultLayerRules(profile, mapping);
  validateLayerRules(layerRules, mapping);
  const compiled = { bronze: p.targets.bronze, silver: p.targets.silver, quarantine: p.targets.quarantine, batchId: p.batch_id, sql: p.sql, measure: p.measure_sql || compileOnboarding(profile, mapping, p.batch_id, layerRules).measure };
  const result = await transaction(async () => {
    if (acceptSuggestions) {
      for (const e of p.preview.exceptions.filter((x) => x.suggestion)) {
        await run(`DELETE FROM silver.part_mapping_overrides WHERE raw_part_no = ?`, [e.normalized]);
        await run(`INSERT INTO silver.part_mapping_overrides VALUES (?, ?, ?, now(), ?)`, [e.normalized, e.suggestion, reviewer, artifact.id]);
      }
    }
    for (const stmt of splitStatements(allSql(compiled))) await run(stmt);
    const dq = await runChecks(profile, mapping, compiled, layerRules);
    const blocking = dq.checks.filter((c) => c.severity === 'error' && !c.passed);
    if (blocking.length) throw new Error(`Blocking DQ checks failed at deploy: ${blocking.map((b) => b.name).join('; ')}`);
    const exceptions = await partExceptions(mapping, compiled);
    return { ...dq, exceptions };
  }, { commit: true });

  // Catalog, lineage, DQ history
  const colMeta = async (t) => {
    const [s, n] = t.split('.');
    const phys = await all(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [s, n]);
    const byTarget = Object.fromEntries(mapping.columns.map((c) => [c.target_column, c]));
    const fixed = {
      part_no_std: { role: 'part_number_std', description: 'Standardised part number after prefix/suffix cleanup, supersession and steward overrides' },
      part_mapping_status: { role: 'attribute', description: 'exact | standardised | superseded | steward_override | unmapped' },
      model_family: { role: 'hierarchy', description: 'From silver.product_hierarchy' }, product_line: { role: 'hierarchy', description: 'From silver.product_hierarchy' }, vertical: { role: 'hierarchy', description: 'From silver.product_hierarchy' },
      reject_reason: { role: 'attribute', description: 'Why the row was quarantined' },
    };
    return phys.map((c) => {
      const m = byTarget[c.name];
      return m ? { name: c.name, type: c.type, role: m.role, pii: m.pii, source_column: m.source_column, transform: m.transform, description: m.description }
        : { name: c.name, type: c.type, ...(fixed[c.name] || { role: c.name.startsWith('_') ? 'audit' : 'source', description: c.name.startsWith('_') ? 'Audit / lineage column' : '' }) };
    });
  };
  const silverStatus = result.checks.filter((c) => c.dataset === compiled.silver).every((c) => c.passed) ? 'passed' : 'passed with warnings';
  const tags = [mapping.domain, 'onboarded by portal'];
  const bronzeDesc = `Raw copy of ${profile.table} with audit columns. ${LOAD_MODES[layerRules.bronze.load_mode]}.`;
  await registerDataset({ dataset: compiled.bronze, layer: 'bronze', title: `${profile.source_table.replace(/_/g, ' ')} (raw)`, description: bronzeDesc, owner: reviewer, sourceSystem: profile.system, columns: await colMeta(compiled.bronze), rowCount: result.counts.bronze, tags, artifactId: artifact.id, dqStatus: 'passed' });
  await registerDataset({ dataset: compiled.silver, layer: 'silver', title: mapping.entity_name.replace(/_/g, ' '), description: mapping.summary, owner: reviewer, sourceSystem: profile.system, columns: await colMeta(compiled.silver), rowCount: result.counts.silver, tags, artifactId: artifact.id, dqStatus: silverStatus });
  await registerDataset({ dataset: compiled.quarantine, layer: 'silver', title: `${mapping.entity_name.replace(/_/g, ' ')} - quarantine`, description: `Rows from ${profile.table} that failed the Silver rules, with reject_reason.`, owner: reviewer, sourceSystem: profile.system, columns: await colMeta(compiled.quarantine), rowCount: result.counts.quarantine, tags: [...tags, 'quarantine'], artifactId: artifact.id, dqStatus: 'n/a' });
  await run(`UPDATE meta.catalog SET tags = ?, description = replace(description, ' Not yet onboarded.', ' Onboarded via the portal (' || ? || ').') WHERE dataset = ?`, [JSON.stringify([mapping.domain, 'onboarded']), artifact.id, profile.table]);
  await saveLayerRules(compiled.silver, layerRules, artifact.id);

  await addLineage(profile.table, compiled.bronze, `raw copy + audit columns (${layerRules.bronze.load_mode})`, artifact.id);
  await addLineage(compiled.bronze, compiled.silver, 'type, dedupe, hash PII, layer rules', artifact.id);
  await addLineage(compiled.bronze, compiled.quarantine, 'reject rows failing rules', artifact.id);
  if (mapping.columns.some((c) => c.role === 'part_number')) {
    await addLineage('silver.product_hierarchy', compiled.silver, 'part -> hierarchy mapping', artifact.id);
    await addLineage('silver.part_supersession', compiled.silver, 'legacy part numbers', artifact.id);
    await addLineage('silver.part_mapping_overrides', compiled.silver, 'steward overrides', artifact.id);
  }
  await saveDqResults(artifact.id, 'deploy', result.checks);
  await run(`DELETE FROM meta.part_exceptions WHERE dataset = ?`, [compiled.silver]);
  for (const e of result.exceptions) {
    await run(`INSERT INTO meta.part_exceptions VALUES (?, ?, ?, ?, ?, ?, ?)`, [artifact.id, compiled.silver, e.raw_values, e.normalized, e.reason, e.suggestion, e.row_count]);
  }
  // Gold facts already built from this Silver table are rebuilt so they follow the new rules.
  const rebuilt = await rebuildFactsFrom(compiled.silver, artifact.id);
  await audit(reviewer, 'onboarding.deployed', compiled.silver, `${result.counts.silver} rows; overrides accepted: ${acceptSuggestions}${rebuilt.length ? `; rebuilt ${rebuilt.join(', ')}` : ''}`);
  return { counts: result.counts, checks: result.checks, exceptions: result.exceptions, datasets: [compiled.bronze, compiled.silver, compiled.quarantine], rebuilt };
}

export { lit };
