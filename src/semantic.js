// Semantic layer: the business vocabulary both the AI and the rule engine must choose from.
// Keeping the model inside this vocabulary is what makes its output reviewable and compilable.

// Canonical roles a source column can be mapped to during onboarding.
export const ROLES = [
  'record_id', 'event_date', 'event_timestamp', 'part_number', 'serial_number', 'dealer_id', 'customer_id', 'plant_code',
  'failure_code', 'failure_description', 'labor_amount', 'parts_amount', 'amount', 'quantity', 'status',
  'test_type', 'test_result', 'measured_value', 'spec_min', 'spec_max', 'person_id', 'contact_email', 'attribute',
];

// Allowed column transforms. Each compiles to a fixed SQL expression (see onboarding.js).
export const TRANSFORMS = {
  none: { type: 'VARCHAR', label: 'keep as text' },
  trim: { type: 'VARCHAR', label: 'trim whitespace' },
  upper_trim: { type: 'VARCHAR', label: 'trim + upper-case' },
  parse_date_mdy: { type: 'DATE', label: 'parse date MM/DD/YYYY' },
  parse_date_iso: { type: 'DATE', label: 'parse date YYYY-MM-DD' },
  parse_timestamp: { type: 'TIMESTAMP', label: 'parse timestamp' },
  to_decimal: { type: 'DECIMAL(14,2)', label: 'number (strip thousands separators)' },
  to_decimal_precise: { type: 'DECIMAL(14,4)', label: 'number, 4 decimals' },
  to_integer: { type: 'INTEGER', label: 'integer' },
  std_part_no: { type: 'VARCHAR', label: 'standardise part number' },
  sha256_pii: { type: 'VARCHAR', label: 'hash PII (sha256)' },
};

export const DIMENSIONS = {
  month: { label: 'Month', time: true },
  quarter: { label: 'Quarter', time: true },
  year: { label: 'Year', time: true },
  vertical: { label: 'Vertical' },
  product_line: { label: 'Product line' },
  model_family: { label: 'Model family' },
  region: { label: 'Region' },
  plant_code: { label: 'Plant' },
  customer_name: { label: 'Customer' },
  dealer_name: { label: 'Dealer' },
  failure_mode: { label: 'Failure mode' },
  check_type: { label: 'Inspection check type' },
};

// Gold facts. fct_sales exists on the platform; the others are built on demand from onboarded silver data.
export const FACTS = {
  'gold.fct_sales': {
    label: 'Sales fact', dateColumn: 'order_date', subject: 'sales',
    dimensions: ['month', 'quarter', 'year', 'vertical', 'product_line', 'model_family', 'region', 'plant_code', 'customer_name'],
  },
  'gold.fct_warranty_claims': {
    label: 'Warranty claims fact', dateColumn: 'claim_date', subject: 'warranty',
    dimensions: ['month', 'quarter', 'year', 'vertical', 'product_line', 'model_family', 'region', 'dealer_name', 'failure_mode'],
    requiresRoles: ['record_id', 'event_date', 'labor_amount', 'parts_amount'],
    sourceTag: 'warranty',
  },
  'gold.fct_quality_inspections': {
    label: 'Quality inspections fact', dateColumn: 'inspection_date', subject: 'inspection',
    dimensions: ['month', 'quarter', 'year', 'vertical', 'product_line', 'model_family', 'plant_code', 'check_type'],
    requiresRoles: ['record_id', 'event_timestamp', 'test_result'],
    sourceTag: 'quality',
  },
};

const rng = (col) => `${col} BETWEEN {{date_from}} AND {{date_to}}`;
const num = (c) => `coalesce(try_cast(replace(trim(${c}), ',', '') AS DECIMAL(14,2)), 0)`;
// The warranty source check follows the layer rules the claims were onboarded with
// (which statuses reach Gold, whether negative amounts are quarantined), so reconciliation
// always compares like with like. Without rules it uses the platform default (exclude REJECTED).
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;
const WARRANTY_SRC = (r = {}) => {
  const st = r.statuses;
  const statusCond = Array.isArray(st)
    ? (st.length ? `upper(trim(coalesce(CLAIM_STATUS, ''))) IN (${st.map(sqlStr).join(', ')})` : 'false')
    : `upper(trim(coalesce(CLAIM_STATUS, ''))) <> 'REJECTED'`;
  const neg = r.excludeNegative ? ` AND ${num('LABOR_AMT')} >= 0 AND ${num('PARTS_AMT')} >= 0` : '';
  return `(SELECT DISTINCT ON (CLAIM_NO) *, try_strptime(trim(CLAIM_DT), '%m/%d/%Y')::DATE AS _d FROM src_dealer.warranty_claims
  WHERE nullif(trim(CLAIM_NO), '') IS NOT NULL AND try_strptime(trim(CLAIM_DT), '%m/%d/%Y') IS NOT NULL) w
  WHERE ${statusCond}${neg} AND ${rng('_d')}`;
};
const INSPECTION_SRC = `(SELECT DISTINCT ON (INSP_ID) *, try_cast(INSP_TS AS TIMESTAMP)::DATE AS _d FROM src_mes.quality_inspections
  WHERE nullif(trim(INSP_ID), '') IS NOT NULL AND try_cast(INSP_TS AS TIMESTAMP) IS NOT NULL) i WHERE ${rng('_d')}`;

// Base measures live as columns in report marts; sourceCheck recomputes the same number straight
// from the source system so every report can be reconciled to source.
export const BASE_MEASURES = {
  units_sold: {
    name: 'units_sold', label: 'Units sold', kind: 'base', fact: 'gold.fct_sales', expression: 'sum(quantity)', format: 'int',
    definition: 'Sum of ordered quantity on sales order lines.',
    synonyms: ['units', 'units sold', 'volume', 'shipments', 'quantity', 'sold'],
    sourceCheck: `SELECT sum(quantity) AS v FROM src_erp.sales_orders WHERE ${rng('order_date')}`,
  },
  net_revenue: {
    name: 'net_revenue', label: 'Net revenue', kind: 'base', fact: 'gold.fct_sales', expression: 'sum(net_amount)', format: 'usd',
    definition: 'Sum of net order line amount (USD).',
    synonyms: ['revenue', 'sales', 'net sales', 'turnover', 'sales value'],
    sourceCheck: `SELECT sum(net_amount) AS v FROM src_erp.sales_orders WHERE ${rng('order_date')}`,
  },
  order_lines: {
    name: 'order_lines', label: 'Order lines', kind: 'base', fact: 'gold.fct_sales', expression: 'count(*)', format: 'int',
    definition: 'Number of sales order lines.',
    synonyms: ['order lines', 'orders'],
    sourceCheck: `SELECT count(*) AS v FROM src_erp.sales_orders WHERE ${rng('order_date')}`,
  },
  warranty_cost: {
    name: 'warranty_cost', label: 'Warranty cost', kind: 'base', fact: 'gold.fct_warranty_claims', expression: 'sum(total_claim_amount)', format: 'usd',
    definition: 'Labor + parts amount on warranty claims, de-duplicated by claim number, for the claim statuses included in Gold (default: all except REJECTED).',
    synonyms: ['warranty cost', 'warranty spend', 'claim cost', 'warranty expense', 'claims cost', 'warranty'],
    sourceCheck: (ctx = {}) => `SELECT sum(${num('LABOR_AMT')} + ${num('PARTS_AMT')}) AS v FROM ${WARRANTY_SRC(ctx.warranty)}`,
  },
  claim_count: {
    name: 'claim_count', label: 'Warranty claims', kind: 'base', fact: 'gold.fct_warranty_claims', expression: 'count(*)', format: 'int',
    definition: 'Number of warranty claims, de-duplicated, for the claim statuses included in Gold (default: all except REJECTED).',
    synonyms: ['claims', 'claim count', 'number of claims', 'warranty claims'],
    sourceCheck: (ctx = {}) => `SELECT count(*) AS v FROM ${WARRANTY_SRC(ctx.warranty)}`,
  },
  labor_cost: {
    name: 'labor_cost', label: 'Warranty labor cost', kind: 'base', fact: 'gold.fct_warranty_claims', expression: 'sum(labor_amount)', format: 'usd',
    definition: 'Labor amount on warranty claims (same claim rules as warranty cost).',
    synonyms: ['labor cost', 'labour cost'],
    sourceCheck: (ctx = {}) => `SELECT sum(${num('LABOR_AMT')}) AS v FROM ${WARRANTY_SRC(ctx.warranty)}`,
  },
  parts_cost: {
    name: 'parts_cost', label: 'Warranty parts cost', kind: 'base', fact: 'gold.fct_warranty_claims', expression: 'sum(parts_amount)', format: 'usd',
    definition: 'Parts amount on warranty claims (same claim rules as warranty cost).',
    synonyms: ['parts cost'],
    sourceCheck: (ctx = {}) => `SELECT sum(${num('PARTS_AMT')}) AS v FROM ${WARRANTY_SRC(ctx.warranty)}`,
  },
  inspections: {
    name: 'inspections', label: 'Inspections', kind: 'base', fact: 'gold.fct_quality_inspections', expression: 'count(*)', format: 'int',
    definition: 'Number of end-of-line inspections.',
    synonyms: ['inspections', 'tests', 'inspection count'],
    sourceCheck: `SELECT count(*) AS v FROM ${INSPECTION_SRC}`,
  },
  inspection_failures: {
    name: 'inspection_failures', label: 'Failed inspections', kind: 'base', fact: 'gold.fct_quality_inspections', expression: "count(*) FILTER (WHERE test_result = 'FAIL')", format: 'int',
    definition: 'Number of inspections with result FAIL.',
    synonyms: ['failed inspections', 'failures', 'inspection failures', 'rejects'],
    sourceCheck: `SELECT count(*) FILTER (WHERE upper(trim(RESULT)) = 'FAIL') AS v FROM ${INSPECTION_SRC}`,
  },
};

export const DERIVED_MEASURES = {
  claims_per_1000_units: {
    name: 'claims_per_1000_units', label: 'Claims per 1,000 units', kind: 'derived', numerator: 'claim_count', denominator: 'units_sold', multiplier: 1000, format: 'dec',
    definition: 'Warranty claims divided by units sold, per 1,000 units, for the same slice.',
    synonyms: ['claim rate', 'claims per 1000', 'claims per thousand', 'failure rate', 'warranty rate', 'incident rate'],
  },
  avg_claim_cost: {
    name: 'avg_claim_cost', label: 'Average claim cost', kind: 'derived', numerator: 'warranty_cost', denominator: 'claim_count', multiplier: 1, format: 'usd',
    definition: 'Warranty cost divided by number of claims.',
    synonyms: ['average claim cost', 'cost per claim', 'avg claim'],
  },
  warranty_pct_revenue: {
    name: 'warranty_pct_revenue', label: 'Warranty cost % of revenue', kind: 'derived', numerator: 'warranty_cost', denominator: 'net_revenue', multiplier: 100, format: 'pct',
    definition: 'Warranty cost as a percentage of net revenue for the same slice.',
    synonyms: ['warranty cost as % of revenue', 'as a percentage of revenue', 'percent of revenue', '% of revenue', '% of sales', 'warranty as % of revenue', 'warranty percent of sales', 'warranty % revenue', 'warranty to sales ratio'],
  },
  avg_selling_price: {
    name: 'avg_selling_price', label: 'Average selling price', kind: 'derived', numerator: 'net_revenue', denominator: 'units_sold', multiplier: 1, format: 'usd',
    definition: 'Net revenue divided by units sold.',
    synonyms: ['asp', 'average selling price', 'price per unit'],
  },
  first_pass_yield: {
    name: 'first_pass_yield', label: 'Inspection failure rate %', kind: 'derived', numerator: 'inspection_failures', denominator: 'inspections', multiplier: 100, format: 'pct',
    definition: 'Failed inspections as a percentage of all inspections.',
    synonyms: ['failure rate %', 'inspection failure rate', 'fail rate', 'yield'],
  },
};

export const ALL_MEASURES = { ...BASE_MEASURES, ...DERIVED_MEASURES };

export function baseComponents(name) {
  const m = ALL_MEASURES[name];
  if (!m) return [];
  return m.kind === 'base' ? [name] : [m.numerator, m.denominator];
}

export function factsFor(measures) {
  return [...new Set(measures.flatMap(baseComponents).map((b) => BASE_MEASURES[b].fact))];
}

// SQL for a measure over a table whose columns are base-measure names (report marts),
// or over a fact (useFactExpression = true).
export function measureSql(name, { overFact = false } = {}) {
  const m = ALL_MEASURES[name];
  if (m.kind === 'base') return overFact ? m.expression : `sum(${m.name})`;
  const n = measureSql(m.numerator, { overFact });
  const d = measureSql(m.denominator, { overFact });
  return `(${n})::DOUBLE / nullif((${d})::DOUBLE, 0) * ${m.multiplier}`;
}

export function fillDates(sql, from, to) {
  return sql.replaceAll('{{date_from}}', `DATE '${from}'`).replaceAll('{{date_to}}', `DATE '${to}'`);
}
