// Builds the reference data platform with synthetic data.
//
// Already on the platform (simulating the customer's current state):
//   src_erp     sales orders, customers, material master (product hierarchy), part supersession
//   src_dealer  warranty claims (messy, NOT yet onboarded), dealers
//   src_mes     quality inspections (NOT yet onboarded)
//   ERP sales domain already onboarded end-to-end: bronze -> silver -> gold.fct_sales + dims
//
// Not on the platform yet: anything for warranty or inspections. Use case 1 onboards them;
// use case 2 then needs a warranty Gold fact that does not exist and has to be built.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, close, run, runScript, all, one, DATA_DIR, DB_PATH, exclusive } from './db.js';
import { META_DDL, registerDataset, addLineage, registerMeasure, audit } from './meta.js';
import { BASE_MEASURES } from './semantic.js';

// ---- deterministic randomness ---------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261106);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
};
const pad = (n, w) => String(n).padStart(w, '0');
const iso = (d) => d.toISOString().slice(0, 10);
const mdy = (d) => `${pad(d.getUTCMonth() + 1, 2)}/${pad(d.getUTCDate(), 2)}/${d.getUTCFullYear()}`;

// ---- reference master data ------------------------------------------------
export const HIERARCHY = [
  { vertical: 'On-Highway', line: 'LD Series', families: ['LD1100', 'LD2200'], price: 3800 },
  { vertical: 'On-Highway', line: 'MD Series', families: ['MD3000', 'MD3200'], price: 6900 },
  { vertical: 'On-Highway', line: 'HD Series', families: ['HD4000', 'HD4500'], price: 11800 },
  { vertical: 'Off-Highway', line: 'XHD Series', families: ['XHD8600', 'XHD9800'], price: 24500 },
  { vertical: 'Defense', line: 'Tracked Defense', families: ['TD1000', 'TD3000'], price: 41000 },
  { vertical: 'Electrified Propulsion', line: 'eDrive', families: ['ED100', 'ED200'], price: 15200 },
];
const COMPONENTS = ['Transmission assy', 'Torque converter assy', 'Control module (TCM)', 'Clutch pack', 'Valve body', 'Output shaft', 'Pump assy', 'Wiring harness'];
const REGIONS = ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East & Africa'];
const REGION_WEIGHT = [['North America', 46], ['Europe', 20], ['Asia Pacific', 18], ['Latin America', 10], ['Middle East & Africa', 6]];
const FAILS = [
  ['TC-114', 'Torque converter clutch slip'], ['CM-201', 'TCM software fault'], ['VB-310', 'Valve body solenoid failure'],
  ['CL-402', 'Clutch pack wear'], ['SE-505', 'Seal leak'], ['PU-610', 'Pump pressure low'], ['HN-720', 'Harness connector corrosion'],
  ['SH-830', 'Output shaft spline wear'],
];

function buildParts() {
  const parts = [];
  let fi = 0;
  for (const h of HIERARCHY) {
    for (const fam of h.families) {
      fi += 1;
      COMPONENTS.forEach((comp, ci) => {
        parts.push({
          part_no: `29${pad(fi, 2)}${pad(1000 + ci * 7 + fi, 4)}`,
          description: `${fam} ${comp}`,
          model_family: fam, product_line: h.line, vertical: h.vertical,
          status: 'ACTIVE', price: Math.round(h.price * (ci === 0 ? 1 : 0.08 + ci * 0.03)),
          weight: ci === 0 ? 10 : 2,
        });
      });
    }
  }
  return parts;
}

// ---- CSV helpers ----------------------------------------------------------
function writeCsv(file, rows, cols) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function generate(seedDir) {
  const parts = buildParts();
  const familySales = {}; // `${family}|${yyyy-mm}` -> units

  // Superseded (legacy) part numbers that still turn up in dealer data
  const supersession = parts.filter((_, i) => i % 9 === 0).map((p, i) => ({
    OLD_PART_NO: `28${p.part_no.slice(2, 4)}${pad(5000 + i * 13, 4)}`, NEW_PART_NO: p.part_no, EFFECTIVE_DATE: '2023-07-01',
  }));

  const customers = Array.from({ length: 42 }, (_, i) => ({
    customer_id: `C${pad(10001 + i, 5)}`,
    customer_name: `${pick(['Northline', 'Summit', 'Atlas', 'Keystone', 'Meridian', 'Pioneer', 'Ironwood', 'Bluewater', 'Redrock', 'Granite'])} ${pick(['Truck', 'Fleet', 'Coach', 'Mining', 'Motors', 'Equipment', 'Transit', 'Defense Systems'])} ${pick(['Co', 'Inc', 'Group', 'Ltd', 'GmbH', 'SA'])}`,
    region: weighted(REGION_WEIGHT), country: '',
  }));
  const countryFor = { 'North America': ['US', 'CA', 'MX'], Europe: ['DE', 'FR', 'GB', 'NL'], 'Asia Pacific': ['JP', 'IN', 'AU', 'CN'], 'Latin America': ['BR', 'AR', 'CL'], 'Middle East & Africa': ['AE', 'ZA', 'SA'] };
  customers.forEach((c) => { c.country = pick(countryFor[c.region]); });

  const dealers = Array.from({ length: 64 }, (_, i) => {
    const region = weighted(REGION_WEIGHT);
    return { DEALER_CD: `D${pad(301 + i, 4)}`, DEALER_NAME: `${pick(['Central', 'Coastal', 'Metro', 'Valley', 'Highland', 'Prairie', 'Harbor', 'Capital'])} Powertrain Service ${i + 1}`, REGION: region, COUNTRY: pick(countryFor[region]) };
  });

  // Sales orders 2024-01 .. 2026-09
  const sales = [];
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2026, 8, 30);
  const days = Math.round((end - start) / 86400000);
  const partWeights = parts.map((p) => [p, p.weight * (p.product_line === 'eDrive' ? 0.6 : 1) * (p.product_line === 'Tracked Defense' ? 0.35 : 1)]);
  let orderSeq = 4500000;
  for (let n = 0; n < 9200; n++) {
    const d = new Date(start + Math.floor(rnd() * days) * 86400000);
    const cust = pick(customers);
    const lines = between(1, 4);
    orderSeq += 1;
    for (let l = 1; l <= lines; l++) {
      const p = weighted(partWeights);
      // eDrive grows over time
      if (p.product_line === 'eDrive' && d.getUTCFullYear() === 2024 && rnd() < 0.5) continue;
      const qty = weighted([[1, 25], [2, 20], [4, 15], [6, 12], [10, 10], [12, 8], [20, 6], [40, 4]]);
      const price = p.price * (0.92 + rnd() * 0.16);
      sales.push({
        order_id: `SO${orderSeq}`, order_line: l, order_date: iso(d), customer_id: cust.customer_id, part_no: p.part_no,
        quantity: qty, net_amount: (qty * price).toFixed(2), currency: 'USD', plant_code: pick(['PLT-A', 'PLT-A', 'PLT-B', 'PLT-C']),
      });
      const key = `${p.model_family}|${iso(d).slice(0, 7)}`;
      familySales[key] = (familySales[key] || 0) + qty;
    }
  }

  // Warranty claims: proportional to units sold in recent months, with a deliberate quality issue
  // (HD Series torque converter, Jun-Oct 2025) and realistic data-entry mess.
  const claims = [];
  let claimSeq = 1200000;
  const byFamily = {};
  parts.forEach((p) => { (byFamily[p.model_family] ||= []).push(p); });
  const famLine = Object.fromEntries(parts.map((p) => [p.model_family, p.product_line]));
  const months = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 9) break; months.push([y, m]); }
  for (const [y, m] of months) {
    const ym = `${y}-${pad(m, 2)}`;
    for (const fam of Object.keys(byFamily)) {
      // claims lag sales by ~3 months; use trailing exposure
      let exposure = 0;
      for (let k = 1; k <= 6; k++) {
        const dt = new Date(Date.UTC(y, m - 1 - k, 1));
        exposure += familySales[`${fam}|${iso(dt).slice(0, 7)}`] || 0;
      }
      if (!exposure) continue;
      let rate = 0.0095;
      const issue = famLine[fam] === 'HD Series' && ym >= '2025-06' && ym <= '2025-10';
      if (issue) rate *= 2.6;
      const count = Math.round(exposure * rate * (0.8 + rnd() * 0.4));
      for (let i = 0; i < count; i++) {
        const day = between(1, 28);
        const d = new Date(Date.UTC(y, m - 1, day));
        const fail = issue && rnd() < 0.62 ? FAILS[0] : pick(FAILS);
        const part = fail[0] === 'TC-114' ? byFamily[fam][1] : pick(byFamily[fam]);
        const labor = 180 + rnd() * 1400;
        const partsAmt = part.price * (0.4 + rnd() * 0.8);
        claimSeq += 1;
        claims.push({
          CLAIM_NO: `WC${claimSeq}`, CLAIM_DT: mdy(d), DEALER_CD: pick(dealers).DEALER_CD,
          SERIAL_NO: `${fam.replace(/\D/g, '').slice(0, 2)}${pad(between(100000, 999999), 6)}`,
          PART_NUM: part.part_no, FAIL_CODE: fail[0], FAIL_DESC: fail[1],
          LABOR_AMT: labor.toFixed(2), PARTS_AMT: partsAmt.toFixed(2),
          CLAIM_STATUS: weighted([['APPROVED', 70], ['PAID', 20], ['REJECTED', 7], ['PENDING', 3]]),
          CUST_EMAIL: `fleet.ops${between(1, 900)}@example-fleet.com`,
          _family: fam,
        });
      }
    }
  }
  // Inject data-entry mess
  const superByNew = Object.fromEntries(supersession.map((s) => [s.NEW_PART_NO, s.OLD_PART_NO]));
  for (const c of claims) {
    const r = rnd();
    const p = c.PART_NUM;
    if (r < 0.09) c.PART_NUM = `${p}-${pick(['A', 'B', 'C'])}`;
    else if (r < 0.15) c.PART_NUM = `AT-${p}`;
    else if (r < 0.2) c.PART_NUM = `${p.slice(0, 4)} ${p.slice(4)}`;
    else if (r < 0.235) c.PART_NUM = `at-${p}`;
    else if (r < 0.265 && superByNew[p]) c.PART_NUM = superByNew[p];
    else if (r < 0.28) { const i = between(4, 7); c.PART_NUM = p.slice(0, i) + String((Number(p[i]) + 1) % 10) + p.slice(i + 1); }
    else if (r < 0.285) c.PART_NUM = pick(['UNKNOWN', 'N/A', '', 'TBD']);
    const r2 = rnd();
    if (r2 < 0.004) c.CLAIM_DT = pick(['13/45/2025', '', '00/00/0000']);
    else if (r2 < 0.006) c.CLAIM_NO = '';
    if (rnd() < 0.02) c.LABOR_AMT = Number(c.LABOR_AMT).toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (rnd() < 0.003) c.PARTS_AMT = (-Number(c.PARTS_AMT)).toFixed(2);
  }
  // Re-sent records (exact duplicates)
  const dupes = claims.filter(() => rnd() < 0.012).map((c) => ({ ...c }));
  claims.push(...dupes);
  claims.sort((a, b) => (a.CLAIM_NO > b.CLAIM_NO ? 1 : -1));

  // MES quality inspections (second un-onboarded source)
  const inspections = [];
  for (let i = 0; i < 4200; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 630) * 86400000 + Math.floor(rnd() * 86400000));
    const p = pick(parts);
    const val = 50 + (rnd() - 0.5) * 12;
    inspections.push({
      INSP_ID: `IN${pad(700000 + i, 7)}`, INSP_TS: d.toISOString().replace('T', ' ').slice(0, 19), PLANT: pick(['PLT-A', 'PLT-B', 'PLT-C']),
      SERIAL_NO: `${pad(between(10, 99), 2)}${pad(between(100000, 999999), 6)}`, PART_NO: p.part_no,
      CHECK_TYPE: pick(['LINE_PRESSURE', 'SHIFT_TIME', 'NOISE_DB', 'LEAK_TEST']), MEASURED_VAL: val.toFixed(3), SPEC_MIN: '45.000', SPEC_MAX: '55.000',
      RESULT: val < 45 || val > 55 ? 'FAIL' : 'PASS', INSPECTOR_ID: `E${between(1000, 1099)}`,
    });
  }

  fs.mkdirSync(seedDir, { recursive: true });
  writeCsv(path.join(seedDir, 'erp_material_master.csv'), parts.map((p) => ({ PART_NO: p.part_no, DESCRIPTION: p.description, MODEL_FAMILY: p.model_family, PRODUCT_LINE: p.product_line, VERTICAL: p.vertical, STATUS: p.status, LIST_PRICE: p.price })), ['PART_NO', 'DESCRIPTION', 'MODEL_FAMILY', 'PRODUCT_LINE', 'VERTICAL', 'STATUS', 'LIST_PRICE']);
  writeCsv(path.join(seedDir, 'erp_part_supersession.csv'), supersession, ['OLD_PART_NO', 'NEW_PART_NO', 'EFFECTIVE_DATE']);
  writeCsv(path.join(seedDir, 'erp_customers.csv'), customers, ['customer_id', 'customer_name', 'region', 'country']);
  writeCsv(path.join(seedDir, 'erp_sales_orders.csv'), sales, ['order_id', 'order_line', 'order_date', 'customer_id', 'part_no', 'quantity', 'net_amount', 'currency', 'plant_code']);
  writeCsv(path.join(seedDir, 'dealer_dealers.csv'), dealers, ['DEALER_CD', 'DEALER_NAME', 'REGION', 'COUNTRY']);
  writeCsv(path.join(seedDir, 'dealer_warranty_claims.csv'), claims, ['CLAIM_NO', 'CLAIM_DT', 'DEALER_CD', 'SERIAL_NO', 'PART_NUM', 'FAIL_CODE', 'FAIL_DESC', 'LABOR_AMT', 'PARTS_AMT', 'CLAIM_STATUS', 'CUST_EMAIL']);
  writeCsv(path.join(seedDir, 'mes_quality_inspections.csv'), inspections, ['INSP_ID', 'INSP_TS', 'PLANT', 'SERIAL_NO', 'PART_NO', 'CHECK_TYPE', 'MEASURED_VAL', 'SPEC_MIN', 'SPEC_MAX', 'RESULT', 'INSPECTOR_ID']);
  return { parts: parts.length, sales: sales.length, claims: claims.length, inspections: inspections.length };
}

const csv = (dir, f, varchar = false) => `read_csv('${path.join(dir, f).replace(/'/g, "''")}', header=true${varchar ? ', all_varchar=true' : ''})`;

async function buildPlatform(seedDir) {
  await runScript(`
DROP SCHEMA IF EXISTS src_erp CASCADE; DROP SCHEMA IF EXISTS src_dealer CASCADE; DROP SCHEMA IF EXISTS src_mes CASCADE;
DROP SCHEMA IF EXISTS bronze CASCADE; DROP SCHEMA IF EXISTS silver CASCADE; DROP SCHEMA IF EXISTS gold CASCADE; DROP SCHEMA IF EXISTS meta CASCADE;
CREATE SCHEMA src_erp; CREATE SCHEMA src_dealer; CREATE SCHEMA src_mes;
CREATE SCHEMA bronze; CREATE SCHEMA silver; CREATE SCHEMA gold;
`);
  await runScript(META_DDL);

  // Source systems (as they exist on the platform today)
  await runScript(`
CREATE TABLE src_erp.material_master AS SELECT PART_NO::VARCHAR AS PART_NO, DESCRIPTION, MODEL_FAMILY, PRODUCT_LINE, VERTICAL, STATUS, LIST_PRICE::DECIMAL(12,2) AS LIST_PRICE FROM ${csv(seedDir, 'erp_material_master.csv', true)};
CREATE TABLE src_erp.part_supersession AS SELECT OLD_PART_NO, NEW_PART_NO, EFFECTIVE_DATE::DATE AS EFFECTIVE_DATE FROM ${csv(seedDir, 'erp_part_supersession.csv', true)};
CREATE TABLE src_erp.customers AS SELECT * FROM ${csv(seedDir, 'erp_customers.csv', true)};
CREATE TABLE src_erp.sales_orders AS SELECT order_id, order_line::INTEGER AS order_line, order_date::DATE AS order_date, customer_id, part_no::VARCHAR AS part_no, quantity::INTEGER AS quantity, net_amount::DECIMAL(14,2) AS net_amount, currency, plant_code FROM ${csv(seedDir, 'erp_sales_orders.csv', true)};
CREATE TABLE src_dealer.dealers AS SELECT * FROM ${csv(seedDir, 'dealer_dealers.csv', true)};
CREATE TABLE src_dealer.warranty_claims AS SELECT * FROM ${csv(seedDir, 'dealer_warranty_claims.csv', true)};
CREATE TABLE src_mes.quality_inspections AS SELECT * FROM ${csv(seedDir, 'mes_quality_inspections.csv', true)};
`);

  // Shared standardisation macro used by every silver pipeline that carries part numbers
  await run(`CREATE OR REPLACE MACRO silver.std_part_no(p) AS nullif(regexp_replace(regexp_replace(regexp_replace(upper(trim(coalesce(p, ''))), '^(ATI|AT)[\\s\\-]*', ''), '[\\s\\-\\.]', '', 'g'), '^([0-9]{8})[A-Z]{1,2}$', '\\1'), '')`);

  // Existing onboarded ERP domain
  await runScript(`
CREATE TABLE bronze.erp__sales_orders AS SELECT *, 'erp' AS _source_system, 'sales_orders' AS _source_table, 'BATCH-INIT' AS _batch_id, now() AS _ingested_at, md5(concat_ws('|', order_id, order_line)) AS _record_hash FROM src_erp.sales_orders;
CREATE TABLE bronze.erp__customers AS SELECT *, 'erp' AS _source_system, 'customers' AS _source_table, 'BATCH-INIT' AS _batch_id, now() AS _ingested_at, md5(customer_id) AS _record_hash FROM src_erp.customers;
CREATE TABLE bronze.erp__material_master AS SELECT *, 'erp' AS _source_system, 'material_master' AS _source_table, 'BATCH-INIT' AS _batch_id, now() AS _ingested_at, md5(PART_NO) AS _record_hash FROM src_erp.material_master;
CREATE TABLE bronze.erp__part_supersession AS SELECT *, 'erp' AS _source_system, 'part_supersession' AS _source_table, 'BATCH-INIT' AS _batch_id, now() AS _ingested_at, md5(OLD_PART_NO) AS _record_hash FROM src_erp.part_supersession;
CREATE TABLE bronze.dealer__dealers AS SELECT *, 'dealer' AS _source_system, 'dealers' AS _source_table, 'BATCH-INIT' AS _batch_id, now() AS _ingested_at, md5(DEALER_CD) AS _record_hash FROM src_dealer.dealers;

CREATE TABLE silver.product_hierarchy AS SELECT PART_NO AS part_no, DESCRIPTION AS part_description, MODEL_FAMILY AS model_family, PRODUCT_LINE AS product_line, VERTICAL AS vertical, STATUS AS part_status, LIST_PRICE AS list_price, _source_system, _batch_id, _record_hash FROM bronze.erp__material_master;
CREATE TABLE silver.part_supersession AS SELECT OLD_PART_NO AS old_part_no, NEW_PART_NO AS new_part_no, EFFECTIVE_DATE AS effective_date, _source_system, _batch_id, _record_hash FROM bronze.erp__part_supersession;
CREATE TABLE silver.part_mapping_overrides (raw_part_no VARCHAR, part_no VARCHAR, approved_by VARCHAR, approved_at TIMESTAMP, artifact_id VARCHAR);
CREATE TABLE silver.customers AS SELECT customer_id, customer_name, region, country, _source_system, _batch_id, _record_hash FROM bronze.erp__customers;
CREATE TABLE silver.dealers AS SELECT DEALER_CD AS dealer_code, DEALER_NAME AS dealer_name, REGION AS region, COUNTRY AS country, _source_system, _batch_id, _record_hash FROM bronze.dealer__dealers;
CREATE TABLE silver.sales_orders AS SELECT order_id, order_line, order_date, customer_id, part_no, quantity, net_amount, currency, plant_code, _source_system, _batch_id, _record_hash FROM bronze.erp__sales_orders QUALIFY row_number() OVER (PARTITION BY order_id, order_line ORDER BY _ingested_at DESC) = 1;

CREATE TABLE gold.dim_date AS SELECT d::DATE AS date, (year(d) * 10000 + month(d) * 100 + day(d))::INTEGER AS date_key, year(d)::INTEGER AS year, year(d) || '-Q' || quarter(d) AS quarter, date_trunc('month', d)::DATE AS month_start, strftime(d, '%Y-%m') AS month FROM range(DATE '2023-01-01', DATE '2027-01-01', INTERVAL 1 DAY) t(d);
CREATE TABLE gold.dim_product AS SELECT part_no, part_description, model_family, product_line, vertical FROM silver.product_hierarchy;
CREATE TABLE gold.dim_customer AS SELECT customer_id, customer_name, region, country FROM silver.customers;
CREATE TABLE gold.fct_sales AS
SELECT s.order_id, s.order_line, s.order_date, dd.year, dd.quarter, dd.month, s.part_no,
       coalesce(p.model_family, 'Unmapped') AS model_family, coalesce(p.product_line, 'Unmapped') AS product_line, coalesce(p.vertical, 'Unmapped') AS vertical,
       s.customer_id, c.customer_name, coalesce(c.region, 'Unknown') AS region, s.plant_code, s.quantity, s.net_amount
FROM silver.sales_orders s
JOIN gold.dim_date dd ON dd.date = s.order_date
LEFT JOIN gold.dim_product p ON p.part_no = s.part_no
LEFT JOIN gold.dim_customer c ON c.customer_id = s.customer_id;
`);

  const rc = async (t) => (await one(`SELECT count(*) AS n FROM ${t}`)).n;
  const cols = async (t) => {
    const [s, n] = t.split('.');
    return all(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [s, n]);
  };
  const reg = async (dataset, layer, title, description, sourceSystem, tags, owner = 'Data Platform Team') =>
    registerDataset({ dataset, layer, title, description, owner, sourceSystem, columns: await cols(dataset), rowCount: await rc(dataset), tags, dqStatus: layer === 'source' ? 'n/a' : 'passed' });

  await reg('src_erp.sales_orders', 'source', 'ERP sales order lines', 'Sales order lines from the ERP system.', 'erp', ['sales']);
  await reg('src_erp.customers', 'source', 'ERP customers', 'Customer master from ERP.', 'erp', ['customer']);
  await reg('src_erp.material_master', 'source', 'ERP material master', 'Part numbers with model family, product line and vertical.', 'erp', ['product', 'master data']);
  await reg('src_erp.part_supersession', 'source', 'ERP part supersession', 'Legacy part numbers and their replacements.', 'erp', ['product', 'master data']);
  await reg('src_dealer.dealers', 'source', 'Dealer portal: dealers', 'Dealer and service-point master.', 'dealer', ['dealer']);
  await reg('src_dealer.warranty_claims', 'source', 'Dealer portal: warranty claims', 'Warranty claims submitted by dealers. Not yet onboarded.', 'dealer', ['warranty', 'not onboarded']);
  await reg('src_mes.quality_inspections', 'source', 'MES: end-of-line inspections', 'End-of-line test results from manufacturing execution. Not yet onboarded.', 'mes', ['quality', 'not onboarded']);

  await reg('bronze.erp__sales_orders', 'bronze', 'Sales orders (raw)', 'Raw ERP sales order lines with audit columns.', 'erp', ['sales']);
  await reg('bronze.erp__customers', 'bronze', 'Customers (raw)', 'Raw ERP customers.', 'erp', ['customer']);
  await reg('bronze.erp__material_master', 'bronze', 'Material master (raw)', 'Raw ERP material master.', 'erp', ['product']);
  await reg('bronze.erp__part_supersession', 'bronze', 'Part supersession (raw)', 'Raw ERP part supersession.', 'erp', ['product']);
  await reg('bronze.dealer__dealers', 'bronze', 'Dealers (raw)', 'Raw dealer master.', 'dealer', ['dealer']);
  await reg('silver.product_hierarchy', 'silver', 'Product hierarchy', 'Part -> model family -> product line -> vertical. Reference for part mapping.', 'erp', ['product', 'master data']);
  await reg('silver.part_supersession', 'silver', 'Part supersession', 'Legacy -> current part numbers.', 'erp', ['product']);
  await reg('silver.part_mapping_overrides', 'silver', 'Part mapping overrides', 'Steward-approved mappings for part numbers the rules could not resolve.', 'portal', ['product', 'stewardship']);
  await reg('silver.customers', 'silver', 'Customers', 'Conformed customers with region.', 'erp', ['customer']);
  await reg('silver.dealers', 'silver', 'Dealers', 'Conformed dealers with region.', 'dealer', ['dealer']);
  await reg('silver.sales_orders', 'silver', 'Sales order lines', 'Typed, de-duplicated sales order lines.', 'erp', ['sales']);
  await reg('gold.dim_date', 'gold', 'Date dimension', 'Calendar with year, quarter, month.', 'derived', ['dimension']);
  await reg('gold.dim_product', 'gold', 'Product dimension', 'Conformed product hierarchy.', 'erp', ['dimension', 'product']);
  await reg('gold.dim_customer', 'gold', 'Customer dimension', 'Conformed customers.', 'erp', ['dimension', 'customer']);
  await reg('gold.fct_sales', 'gold', 'Sales fact', 'Sales order lines with product hierarchy, customer region and calendar attributes.', 'erp', ['fact', 'sales']);

  const edges = [
    ['src_erp.sales_orders', 'bronze.erp__sales_orders', 'raw copy'], ['src_erp.customers', 'bronze.erp__customers', 'raw copy'],
    ['src_erp.material_master', 'bronze.erp__material_master', 'raw copy'], ['src_erp.part_supersession', 'bronze.erp__part_supersession', 'raw copy'],
    ['src_dealer.dealers', 'bronze.dealer__dealers', 'raw copy'],
    ['bronze.erp__sales_orders', 'silver.sales_orders', 'type + dedupe'], ['bronze.erp__customers', 'silver.customers', 'conform'],
    ['bronze.erp__material_master', 'silver.product_hierarchy', 'conform'], ['bronze.erp__part_supersession', 'silver.part_supersession', 'conform'],
    ['bronze.dealer__dealers', 'silver.dealers', 'conform'],
    ['silver.product_hierarchy', 'gold.dim_product', 'dimension'], ['silver.customers', 'gold.dim_customer', 'dimension'],
    ['silver.sales_orders', 'gold.fct_sales', 'fact build'], ['gold.dim_product', 'gold.fct_sales', 'join'], ['gold.dim_customer', 'gold.fct_sales', 'join'], ['gold.dim_date', 'gold.fct_sales', 'join'],
  ];
  for (const [a, b, t] of edges) await addLineage(a, b, t);

  for (const m of Object.values(BASE_MEASURES).filter((m) => m.fact === 'gold.fct_sales')) await registerMeasure(m);
  await audit('system', 'platform.seeded', 'reference platform', 'Synthetic reference platform created');
}

export async function seed({ quiet = false } = {}) {
  const seedDir = path.join(DATA_DIR, 'seed');
  const counts = generate(seedDir);
  await exclusive(async () => {
    await connect();
    await buildPlatform(seedDir);
  });
  if (!quiet) console.log(`Seeded ${DB_PATH}:`, counts);
  return counts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed().then(() => close()).catch((e) => { console.error(e); process.exit(1); });
}
