// Reference data platform: a single DuckDB database with one schema per layer.
//   src_*   source systems already present on the platform (what we onboard from)
//   bronze  raw copies with audit columns
//   silver  typed, de-duplicated, conformed
//   gold    facts, dimensions, report marts
//   meta    portal state: requests, artifacts, catalog, lineage, DQ, measures, reports, alerts, audit
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DB_PATH = process.env.POC_DB_PATH || path.join(DATA_DIR, 'platform.duckdb');

let instance = null;
let conn = null;
let chain = Promise.resolve();

export async function connect(dbPath = DB_PATH) {
  if (conn) return conn;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  instance = await DuckDBInstance.create(dbPath);
  conn = await instance.connect();
  return conn;
}

export async function close() {
  if (conn) { conn.closeSync?.(); conn = null; }
  if (instance) { instance.closeSync?.(); instance = null; }
}

// All database work is serialised: preview runs open a transaction and roll it back,
// so nothing else may interleave with them.
export function exclusive(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL)/;

function toRows(reader) {
  const names = reader.columnNames();
  const types = reader.columnTypes().map((t) => String(t));
  const rows = reader.getRowObjectsJson();
  const numericCols = names.filter((_, i) => NUMERIC.test(types[i]));
  if (numericCols.length) {
    for (const r of rows) for (const c of numericCols) if (r[c] !== null && r[c] !== undefined) r[c] = Number(r[c]);
  }
  return rows;
}

// Raw helpers - callers must already hold the lock (or be inside exclusive()).
export async function run(sql, params) {
  const c = await connect();
  if (params && params.length) await c.run(sql, params);
  else await c.run(sql);
}

export async function all(sql, params) {
  const c = await connect();
  const reader = params && params.length ? await c.runAndReadAll(sql, params) : await c.runAndReadAll(sql);
  return toRows(reader);
}

export async function one(sql, params) {
  const rows = await all(sql, params);
  return rows[0] ?? null;
}

export async function columns(sql) {
  const c = await connect();
  const reader = await c.runAndReadAll(sql);
  return reader.columnNames().map((n, i) => ({ name: n, type: String(reader.columnTypes()[i]) }));
}

// Split a script into statements on semicolons that end a line (our generated SQL follows this form).
export function splitStatements(script) {
  return script
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

export async function runScript(script) {
  for (const stmt of splitStatements(script)) await run(stmt);
}

// Run fn inside a transaction. commit=false gives a dry run whose effects are rolled back.
export async function transaction(fn, { commit }) {
  await run('BEGIN TRANSACTION');
  try {
    const result = await fn();
    await run(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try { await run('ROLLBACK'); } catch { /* already aborted */ }
    throw err;
  }
}

export function q(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export async function tableExists(fullName) {
  const [schema, table] = fullName.split('.');
  const r = await one(
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
    [schema, table]
  );
  return r.n > 0;
}
