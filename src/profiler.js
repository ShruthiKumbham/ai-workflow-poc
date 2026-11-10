// Source profiling: what a data engineer would look at before writing a mapping.
import { all, one, q } from './db.js';

const PATTERNS = [
  ['date_mdy', `^\\d{1,2}/\\d{1,2}/\\d{4}$`],
  ['date_iso', `^\\d{4}-\\d{2}-\\d{2}$`],
  ['timestamp', `^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(:\\d{2})?`],
  ['integer', `^-?\\d+$`],
  ['decimal', `^-?[\\d,]*\\.?\\d+$`],
  ['email', `^[^@\\s]+@[^@\\s]+\\.[a-zA-Z]{2,}$`],
  ['part_number', `^(?i)(AT[- ]?|ATI[- ]?)?\\d{4}[ -]?\\d{4}([- ]?[A-Z]{1,2})?$`],
  ['code', `^[A-Z]{1,4}[-_]?\\d{1,6}$`],
];

export async function profileTable(fullName) {
  const [schema, table] = fullName.split('.');
  const cols = await all(
    `SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
    [schema, table]
  );
  if (!cols.length) throw new Error(`Source table ${fullName} not found on the platform`);
  const { n: rowCount } = await one(`SELECT count(*) AS n FROM ${schema}.${q(table)}`);
  const exactDupes = (await one(`SELECT count(*) - (SELECT count(*) FROM (SELECT DISTINCT * FROM ${schema}.${q(table)})) AS n FROM ${schema}.${q(table)}`)).n;

  const columns = [];
  for (const c of cols) {
    const v = `nullif(trim(${q(c.name)}::VARCHAR), '')`;
    const patternSql = PATTERNS.map(([k, re]) => `count(*) FILTER (WHERE regexp_full_match(${v}, '${re}')) AS "p_${k}"`).join(', ');
    const stats = await one(`
      SELECT count(${v}) AS non_null, count(DISTINCT ${v}) AS distinct_count,
             min(length(${v})) AS min_len, max(length(${v})) AS max_len, ${patternSql}
      FROM ${schema}.${q(table)}`);
    const top = await all(`SELECT ${v} AS value, count(*) AS n FROM ${schema}.${q(table)} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 5`);
    const samples = await all(`SELECT DISTINCT ${v} AS value FROM ${schema}.${q(table)} WHERE ${v} IS NOT NULL LIMIT 6`);
    const patterns = {};
    for (const [k] of PATTERNS) {
      const share = stats.non_null ? stats[`p_${k}`] / stats.non_null : 0;
      if (share >= 0.5) patterns[k] = Math.round(share * 1000) / 10;
    }
    columns.push({
      name: c.name,
      physical_type: c.type,
      non_null: stats.non_null,
      null_pct: rowCount ? Math.round((1 - stats.non_null / rowCount) * 1000) / 10 : 0,
      distinct: stats.distinct_count,
      unique_ratio: stats.non_null ? Math.round((stats.distinct_count / stats.non_null) * 1000) / 1000 : 0,
      min_len: stats.min_len,
      max_len: stats.max_len,
      patterns,
      top_values: top.map((t) => ({ value: t.value, n: t.n })),
      samples: samples.map((s) => s.value),
    });
  }
  return { table: fullName, system: schema.replace(/^src_/, ''), source_table: table, row_count: rowCount, exact_duplicate_rows: exactDupes, columns, profiled_at: new Date().toISOString() };
}

export async function listSources() {
  const rows = await all(`
    SELECT c.dataset, c.title, c.description, c.row_count, c.tags,
      EXISTS (SELECT 1 FROM meta.lineage l WHERE l.from_node = c.dataset) AS onboarded
    FROM meta.catalog c WHERE c.layer = 'source' ORDER BY c.dataset`);
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
}
