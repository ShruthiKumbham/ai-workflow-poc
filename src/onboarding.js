// Use case 1 - source onboarding.
// profile source -> AI mapping proposal -> validate -> compile Bronze + Silver SQL (conventions)
// -> dry run in a rolled-back transaction (DQ checks, part-number exceptions, sample rows)
// -> reviewer approves -> same SQL runs for real -> catalog + lineage + DQ recorded.
import { all, one, run, q, lit, transaction, splitStatements, runScript } from './db.js';
import { profileTable } from './profiler.js';
import { structured, SYSTEM_PROMPT, engineInfo } from './llm.js';
import * as rules from './rules.js';
import { ROLES, TRANSFORMS } from './semantic.js';
import { registerDataset, addLineage, saveDqResults, audit } from './meta.js';

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

export function compileOnboarding(profile, mapping, batchId) {
  const system = profile.system;
  const bronze = `bronze.${system}__${profile.source_table}`;
  const silver = `silver.${mapping.entity_name}`;
  const quarantine = `silver.${mapping.entity_name}__quarantine`;
  const key = mapping.columns.find((c) => c.role === 'record_id');
  const dateCol = mapping.columns.find((c) => c.role === 'event_date' || c.role === 'event_timestamp');
  const partCol = mapping.columns.find((c) => c.role === 'part_number');
  const srcCols = profile.columns.map((c) => q(c.name));

  const bronzeSql = `-- Bronze: raw copy of ${profile.table} with audit columns (convention: bronze.{system}__{table})
CREATE OR REPLACE TABLE ${bronze} AS
SELECT
  ${srcCols.join(',\n  ')},
  '${system}' AS _source_system,
  '${profile.source_table}' AS _source_table,
  '${batchId}' AS _batch_id,
  now() AS _ingested_at,
  md5(concat_ws('|', ${srcCols.join(', ')})) AS _record_hash
FROM ${profile.table};`;

  const typedCols = mapping.columns.map((c) => `    ${colExpr(c)} AS ${q(c.target_column)}`);
  if (partCol) typedCols.push(`    silver.std_part_no(${q(partCol.source_column)}) AS _part_std`);
  const typed = `  typed AS (
  SELECT
${typedCols.join(',\n')},
    _source_system, _batch_id, _ingested_at, _record_hash
  FROM ${bronze}
  )`;
  const validity = [`${q(key.target_column)} IS NOT NULL`];
  if (dateCol) validity.push(`${q(dateCol.target_column)} IS NOT NULL`);

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

  const silverSql = `-- Silver: typed, de-duplicated on ${key.target_column}, PII hashed${partCol ? ', part numbers mapped to product hierarchy' : ''}
CREATE OR REPLACE TABLE ${silver} AS
WITH
${typed},
  valid AS (
  SELECT * FROM typed
  WHERE ${validity.join(' AND ')}
  QUALIFY row_number() OVER (PARTITION BY ${q(key.target_column)} ORDER BY _ingested_at DESC, _record_hash) = 1
  )
SELECT
${outCols.join(',\n')}${partSelect},
  v._source_system,
  v._batch_id,
  v._record_hash
FROM valid v${partJoins};`;

  const reasons = [`WHEN ${q(key.target_column)} IS NULL THEN 'missing business key (${key.source_column})'`];
  if (dateCol) reasons.push(`WHEN ${q(dateCol.target_column)} IS NULL THEN 'missing or unparseable ${dateCol.source_column}'`);
  const quarantineSql = `-- Quarantine: rows that fail key/type rules are kept with a reason, never dropped silently
CREATE OR REPLACE TABLE ${quarantine} AS
WITH
${typed}
SELECT typed.* EXCLUDE (${partCol ? '_part_std, ' : ''}_ingested_at),
  CASE ${reasons.join(' ')} END AS reject_reason
FROM typed
WHERE NOT (${validity.join(' AND ')});`;

  return { bronze, silver, quarantine, sql: { bronze: bronzeSql, silver: silverSql, quarantine: quarantineSql } };
}

function allSql(compiled) {
  return [compiled.sql.bronze, compiled.sql.silver, compiled.sql.quarantine].join('\n\n');
}

// ---- data quality ----------------------------------------------------------
async function runChecks(profile, mapping, compiled) {
  const { bronze, silver, quarantine } = compiled;
  const key = q(mapping.business_key[0]);
  const dateCol = mapping.columns.find((c) => c.role === 'event_date' || c.role === 'event_timestamp');
  const partCol = mapping.columns.find((c) => c.role === 'part_number');
  const amounts = mapping.columns.filter((c) => ['to_decimal', 'to_integer'].includes(c.transform) && ['labor_amount', 'parts_amount', 'amount', 'quantity'].includes(c.role));
  const piiCols = mapping.columns.filter((c) => c.pii);
  const n = async (sql) => (await one(sql)).n;

  const src = await n(`SELECT count(*) AS n FROM ${profile.table}`);
  const br = await n(`SELECT count(*) AS n FROM ${bronze}`);
  const sv = await n(`SELECT count(*) AS n FROM ${silver}`);
  const qu = await n(`SELECT count(*) AS n FROM ${quarantine}`);
  const dupes = br - sv - qu;
  const out = [];
  const add = (dataset, name, severity, failed, total, threshold, passed, detail) => out.push({ dataset, name, severity, failed, total, threshold, passed, detail });

  add(bronze, 'Bronze completeness (rows = source rows)', 'error', Math.abs(src - br), src, '0', src === br, `${br} of ${src} source rows landed`);
  add(silver, 'Row accounting (bronze = silver + quarantine + duplicates)', 'info', 0, br, 'n/a', true, `${br} bronze = ${sv} silver + ${qu} quarantined + ${dupes} duplicates removed`);
  const nullKeys = await n(`SELECT count(*) AS n FROM ${silver} WHERE ${key} IS NULL`);
  add(silver, `Business key ${mapping.business_key[0]} not null`, 'error', nullKeys, sv, '0', nullKeys === 0, '');
  const dupKeys = await n(`SELECT count(*) - count(DISTINCT ${key}) AS n FROM ${silver}`);
  add(silver, `Business key ${mapping.business_key[0]} unique`, 'error', dupKeys, sv, '0', dupKeys === 0, '');
  if (dateCol) {
    const bad = await n(`SELECT count(*) AS n FROM ${silver} WHERE ${q(dateCol.target_column)} < DATE '2000-01-01' OR ${q(dateCol.target_column)} > current_date + 1`);
    add(silver, `${dateCol.target_column} within plausible range`, 'error', bad, sv, '0', bad === 0, '2000-01-01 .. today');
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
  return { checks: out, counts: { source: src, bronze: br, silver: sv, quarantine: qu, duplicates_removed: dupes } };
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

  const batchId = `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const compiled = compileOnboarding(profile, mapping, batchId);
  notes.push({ step: 'Generate pipelines', engine: 'deterministic', note: 'Bronze, Silver and quarantine SQL compiled from the mapping using platform conventions.' });

  // Dry run: execute everything, measure, then roll back.
  const preview = await transaction(async () => {
    await runScript(allSql(compiled));
    const dq = await runChecks(profile, mapping, compiled);
    const exceptions = await partExceptions(mapping, compiled);
    const sample = await all(`SELECT * EXCLUDE (_record_hash) FROM ${compiled.silver} USING SAMPLE 8 ROWS (reservoir, 7)`);
    const mappingStats = mapping.columns.some((c) => c.role === 'part_number')
      ? await all(`SELECT part_mapping_status AS status, count(*) AS n FROM ${compiled.silver} GROUP BY 1 ORDER BY n DESC`) : [];
    const quarantineReasons = await all(`SELECT reject_reason, count(*) AS n FROM ${compiled.quarantine} GROUP BY 1 ORDER BY n DESC`);
    return { ...dq, exceptions, sample, mappingStats, quarantineReasons };
  }, { commit: false });
  notes.push({ step: 'Dry run', engine: 'deterministic', note: `Executed in a rolled-back transaction: ${preview.checks.filter((c) => !c.passed).length} check(s) need attention.` });

  const blocking = preview.checks.filter((c) => c.severity === 'error' && !c.passed);
  const title = `Onboard ${profile.table} → ${compiled.silver}`;
  const summary = `${profile.row_count} rows profiled; ${mapping.columns.length} columns mapped; ${preview.counts.silver} silver rows, ${preview.counts.quarantine} quarantined, ${preview.counts.duplicates_removed} duplicates removed; ${preview.exceptions.reduce((s, e) => s + e.row_count, 0)} rows with part-number exceptions; ${blocking.length ? blocking.length + ' blocking DQ issue(s)' : 'all blocking DQ checks pass'}.`;
  return {
    title, summary, engine,
    payload: { source_table: sourceTable, batch_id: batchId, profile, mapping, targets: { bronze: compiled.bronze, silver: compiled.silver, quarantine: compiled.quarantine }, sql: compiled.sql, preview, notes },
  };
}

// ---- deploy (after approval) ---------------------------------------------
export async function deployOnboarding(artifact, { reviewer, acceptSuggestions = false }) {
  const p = artifact.payload;
  const { profile, mapping } = p;
  const compiled = { bronze: p.targets.bronze, silver: p.targets.silver, quarantine: p.targets.quarantine, sql: p.sql };
  const result = await transaction(async () => {
    if (acceptSuggestions) {
      for (const e of p.preview.exceptions.filter((x) => x.suggestion)) {
        await run(`DELETE FROM silver.part_mapping_overrides WHERE raw_part_no = ?`, [e.normalized]);
        await run(`INSERT INTO silver.part_mapping_overrides VALUES (?, ?, ?, now(), ?)`, [e.normalized, e.suggestion, reviewer, artifact.id]);
      }
    }
    for (const stmt of splitStatements(allSql(compiled))) await run(stmt);
    const dq = await runChecks(profile, mapping, compiled);
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
  await registerDataset({ dataset: compiled.bronze, layer: 'bronze', title: `${profile.source_table.replace(/_/g, ' ')} (raw)`, description: `Raw copy of ${profile.table} with audit columns.`, owner: reviewer, sourceSystem: profile.system, columns: await colMeta(compiled.bronze), rowCount: result.counts.bronze, tags, artifactId: artifact.id, dqStatus: 'passed' });
  await registerDataset({ dataset: compiled.silver, layer: 'silver', title: mapping.entity_name.replace(/_/g, ' '), description: mapping.summary, owner: reviewer, sourceSystem: profile.system, columns: await colMeta(compiled.silver), rowCount: result.counts.silver, tags, artifactId: artifact.id, dqStatus: silverStatus });
  await registerDataset({ dataset: compiled.quarantine, layer: 'silver', title: `${mapping.entity_name.replace(/_/g, ' ')} - quarantine`, description: `Rows from ${profile.table} that failed key or type rules, with reject_reason.`, owner: reviewer, sourceSystem: profile.system, columns: await colMeta(compiled.quarantine), rowCount: result.counts.quarantine, tags: [...tags, 'quarantine'], artifactId: artifact.id, dqStatus: 'n/a' });
  await run(`UPDATE meta.catalog SET tags = ?, description = replace(description, ' Not yet onboarded.', ' Onboarded via the portal (' || ? || ').') WHERE dataset = ?`, [JSON.stringify([mapping.domain, 'onboarded']), artifact.id, profile.table]);

  await addLineage(profile.table, compiled.bronze, 'raw copy + audit columns', artifact.id);
  await addLineage(compiled.bronze, compiled.silver, 'type, dedupe, hash PII', artifact.id);
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
  await audit(reviewer, 'onboarding.deployed', compiled.silver, `${result.counts.silver} rows; overrides accepted: ${acceptSuggestions}`);
  return { counts: result.counts, checks: result.checks, exceptions: result.exceptions, datasets: [compiled.bronze, compiled.silver, compiled.quarantine] };
}

export { lit };
