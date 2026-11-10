// Deterministic rule engine: the offline fallback for every AI step, and a baseline the
// Claude output can be compared against.
import { ALL_MEASURES, BASE_MEASURES, DIMENSIONS, FACTS } from './semantic.js';

// ---- intent --------------------------------------------------------------
const SOURCE_HINTS = [
  [/warrant|claim/i, 'src_dealer.warranty_claims'],
  [/inspect|end[- ]of[- ]line|\bmes\b|test result|eol/i, 'src_mes.quality_inspections'],
  [/dealer/i, 'src_dealer.dealers'],
  [/sales order|order line/i, 'src_erp.sales_orders'],
  [/customer/i, 'src_erp.customers'],
  [/material|part master|product hierarch/i, 'src_erp.material_master'],
];

export function classifyIntent(text, sources) {
  const t = text.toLowerCase();
  let intent = 'report';
  if (/\b(onboard|ingest|bring in|land|connect|load|add (a |the )?(new )?source|pipeline for|register .* source)\b/.test(t)) intent = 'onboarding';
  else if (/\b(alert|notify|warn me|let me know|monitor|flag when|tell me when|email me when)\b/.test(t)) intent = 'alert';
  else if (!/\b(report|dashboard|show|trend|by|per|compare|what|how|chart|kpi|view|analysis|analyse|analyze)\b/.test(t)) intent = 'unknown';
  let source_table = 'none';
  if (intent === 'onboarding') {
    const explicit = sources.find((s) => t.includes(s.dataset.toLowerCase()) || t.includes(s.dataset.split('.')[1].replace(/_/g, ' ')));
    if (explicit) source_table = explicit.dataset;
    else for (const [re, ds] of SOURCE_HINTS) if (re.test(text) && sources.some((s) => s.dataset === ds)) { source_table = ds; break; }
  }
  return { intent, source_table, restated_request: text.trim() };
}

// ---- onboarding mapping --------------------------------------------------
const ABBREV = { dt: 'date', ts: 'timestamp', amt: 'amount', cd: 'code', num: 'number', desc: 'description', qty: 'quantity', val: 'value', insp: 'inspection', cust: 'customer', no: 'no', id: 'id' };

function snake(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    .split('_').map((p) => ABBREV[p] ?? p).join('_');
}

export function proposeMapping(profile) {
  const entity = profile.source_table.toLowerCase();
  const domain = /warrant|claim/.test(entity) ? 'warranty' : /inspect|quality/.test(entity) ? 'quality' : entity.split('_')[0];
  let keyTaken = false;
  const cols = profile.columns.map((c, idx) => {
    const n = c.name.toLowerCase();
    const p = c.patterns;
    let role = 'attribute', transform = 'trim', pii = false, target = snake(c.name), why = 'Descriptive attribute';
    const looksId = !keyTaken && c.unique_ratio > 0.95 && !/serial|vin|part|email/.test(n) && (idx === 0 || /(^|_)(id|no|number|key)$/.test(n));
    if (looksId) keyTaken = true;
    if (p.email || /email|e_mail/.test(n)) { role = 'contact_email'; transform = 'sha256_pii'; pii = true; target = target.replace(/email.*/, 'email_hash'); why = 'Email address - personal data, hashed'; }
    else if (looksId) { role = 'record_id'; transform = 'trim'; why = `Unique per row (${Math.round(c.unique_ratio * 100)}% distinct) - business key`; }
    else if (p.timestamp) { role = 'event_timestamp'; transform = 'parse_timestamp'; why = `Timestamp pattern in ${p.timestamp}% of values`; }
    else if (p.date_mdy) { role = 'event_date'; transform = 'parse_date_mdy'; target = target.replace(/_date$|$/, '_date').replace(/_date_date$/, '_date'); why = `MM/DD/YYYY dates in ${p.date_mdy}% of values`; }
    else if (p.date_iso) { role = 'event_date'; transform = 'parse_date_iso'; why = `ISO dates in ${p.date_iso}% of values`; }
    else if (/labou?r/.test(n) && (p.decimal || p.integer)) { role = 'labor_amount'; transform = 'to_decimal'; target = 'labor_amount'; why = 'Labor amount (numeric, some thousands separators)'; }
    else if (/part/.test(n) && /amt|amount|cost/.test(n)) { role = 'parts_amount'; transform = 'to_decimal'; target = 'parts_amount'; why = 'Parts amount (numeric)'; }
    else if (/serial|vin/.test(n)) { role = 'serial_number'; transform = 'upper_trim'; target = 'serial_number'; why = 'Unit serial number'; }
    else if (/part/.test(n) || p.part_number) { role = 'part_number'; transform = 'std_part_no'; target = 'part_number_raw'; why = `Part number (${p.part_number ?? 0}% match the part pattern; prefixes and suffixes vary)`; }
    else if (/dealer/.test(n)) { role = 'dealer_id'; transform = 'upper_trim'; target = 'dealer_code'; why = 'Dealer code - joins to silver.dealers'; }
    else if (/plant/.test(n)) { role = 'plant_code'; transform = 'upper_trim'; target = 'plant_code'; why = 'Plant code'; }
    else if (/fail.*(code|cd)|defect.*code/.test(n)) { role = 'failure_code'; transform = 'upper_trim'; target = 'failure_code'; why = 'Failure code'; }
    else if (/fail|defect|symptom/.test(n)) { role = 'failure_description'; transform = 'trim'; target = 'failure_description'; why = 'Failure description'; }
    else if (/status|state/.test(n)) { role = 'status'; transform = 'upper_trim'; why = `Status with ${c.distinct} values`; }
    else if (/result|outcome|pass/.test(n)) { role = 'test_result'; transform = 'upper_trim'; target = 'test_result'; why = 'Pass/fail result'; }
    else if (/check|test_type|type/.test(n)) { role = 'test_type'; transform = 'upper_trim'; why = 'Test / check type'; }
    else if (/spec.*min|lsl|lower/.test(n)) { role = 'spec_min'; transform = 'to_decimal_precise'; why = 'Lower spec limit'; }
    else if (/spec.*max|usl|upper/.test(n)) { role = 'spec_max'; transform = 'to_decimal_precise'; why = 'Upper spec limit'; }
    else if (/measur|reading|value/.test(n) && (p.decimal || p.integer)) { role = 'measured_value'; transform = 'to_decimal_precise'; why = 'Measured value'; }
    else if (/qty|quantity|units/.test(n)) { role = 'quantity'; transform = 'to_integer'; why = 'Quantity'; }
    else if (/amt|amount|cost|price|value/.test(n)) { role = 'amount'; transform = 'to_decimal'; why = 'Monetary amount'; }
    else if (/inspector|employee|operator|user/.test(n)) { role = 'person_id'; transform = 'upper_trim'; why = 'Person identifier (internal id, not personal data)'; }
    return { source_column: c.name, target_column: target, role, transform, pii, description: why };
  });
  // make target names unique
  const seen = {};
  for (const c of cols) { if (seen[c.target_column]) c.target_column = `${c.target_column}_${++seen[c.target_column]}`; else seen[c.target_column] = 1; }
  const key = cols.find((c) => c.role === 'record_id');
  return {
    entity_name: entity,
    domain,
    business_key: key ? [key.target_column] : [],
    columns: cols,
    summary: `Mapped ${cols.length} columns of ${profile.table}. Business key ${key?.target_column ?? '(none found)'}; ${cols.filter((c) => c.pii).length} PII column(s) hashed; ${cols.some((c) => c.role === 'part_number') ? 'part numbers standardised and mapped to the product hierarchy.' : 'no part numbers detected.'}`,
    assumptions: ['Rule-based mapping from column names and profiled value patterns.'],
  };
}

// ---- requirement decomposition -------------------------------------------
const DIM_PATTERNS = [
  ['month', /\b(monthly|month|by month|per month|month[- ]over[- ]month|trend|over time|each month)\b/i],
  ['quarter', /\b(quarterly|quarters?|by quarter|per quarter|each quarter)\b/i],
  ['year', /\b(yearly|annual|by year|per year|year[- ]over[- ]year|each year)\b/i],
  ['product_line', /\bproduct[- ]lines?\b|\bseries\b|\bby line\b/i],
  ['model_family', /\bmodel(s| famil(y|ies))?\b|\bfamil(y|ies)\b/i],
  ['vertical', /\bverticals?\b|\bsegments?\b|\bmarkets?\b/i],
  ['region', /\bregions?\b|\bgeograph(y|ies)\b|\bregional\b/i],
  ['plant_code', /\bplants?\b|\bfactor(y|ies)\b/i],
  ['customer_name', /\bcustomers?\b|\boems?\b|\baccounts?\b/i],
  ['dealer_name', /\bdealers?\b|\bservice points?\b/i],
  ['failure_mode', /\bfailure (modes?|codes?|types?|reasons?)\b|\bdefect types?\b|\bby failure\b|\broot cause\b/i],
  ['check_type', /\bcheck types?\b|\btest types?\b/i],
];

export function decomposeRequirement(text, { dataEnd }) {
  let rest = ' ' + text.toLowerCase() + ' ';
  const found = [];
  const candidates = Object.values(ALL_MEASURES).flatMap((m) => m.synonyms.map((s) => [s, m.name])).sort((a, b) => b[0].length - a[0].length);
  for (const [syn, name] of candidates) {
    const idx = rest.indexOf(syn);
    if (idx >= 0) {
      if (!found.some((f) => f.name === name)) found.push({ name, idx });
      rest = rest.slice(0, idx) + ' '.repeat(syn.length) + rest.slice(idx + syn.length);
    }
  }
  found.sort((a, b) => a.idx - b.idx);
  let measures = found.map((f) => f.name).slice(0, 4);
  const assumptions = [];
  if (!measures.length) { measures = ['warranty_cost']; assumptions.push('No measure recognised - defaulted to warranty cost.'); }

  const dimHits = DIM_PATTERNS.map(([d, re]) => { const m = rest.match(re); return m ? { d, idx: m.index } : null; }).filter(Boolean).sort((a, b) => a.idx - b.idx);
  let timeDim = dimHits.find((h) => DIMENSIONS[h.d].time)?.d;
  const others = dimHits.filter((h) => !DIMENSIONS[h.d].time).map((h) => h.d);
  const dims = [];
  if (timeDim) dims.push(timeDim);
  if (others[0]) dims.push(others[0]);
  const breakdown = others[1] ?? 'none';
  if (!dims.length) { dims.push('month'); assumptions.push('No grouping recognised - shown by month.'); timeDim = 'month'; }

  const end = new Date(dataEnd + 'T00:00:00Z');
  const endYear = end.getUTCFullYear();
  let from, to, period;
  const yr = text.match(/\b(20\d{2})\b/g);
  const t = text.toLowerCase();
  if (yr && yr.length >= 2) { from = `${Math.min(...yr)}-01-01`; to = `${Math.max(...yr)}-12-31`; period = `${Math.min(...yr)}-${Math.max(...yr)}`; }
  else if (yr) { from = `${yr[0]}-01-01`; to = `${yr[0]}-12-31`; period = yr[0]; }
  else if (/last year|previous year|prior year/.test(t)) { from = `${endYear - 1}-01-01`; to = `${endYear - 1}-12-31`; period = String(endYear - 1); }
  else if (/this year|ytd|year to date/.test(t)) { from = `${endYear}-01-01`; to = dataEnd; period = `${endYear} YTD`; }
  else if (/last (24|two years)/.test(t)) { from = shiftMonths(dataEnd, -24); to = dataEnd; period = 'last 24 months'; }
  else { from = shiftMonths(dataEnd, -12); to = dataEnd; period = 'last 12 months'; if (!/last 12|past 12|last twelve|past year/.test(t)) assumptions.push('No period given - used the last 12 months of available data.'); }

  const labels = measures.map((m) => ALL_MEASURES[m].label);
  const title = `${joinWords(labels)} by ${joinWords(dims.map((d) => DIMENSIONS[d].label.toLowerCase()))} (${period})`;
  return {
    title,
    measures,
    dimensions: dims,
    breakdown_dimension: breakdown,
    date_from: from,
    date_to: to,
    chart: timeDim ? 'line' : 'bar',
    assumptions: assumptions.length ? assumptions : ['Interpreted with the rule-based glossary matcher.'],
  };
}

function shiftMonths(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 1));
  return first.toISOString().slice(0, 10);
}

function joinWords(arr) {
  if (arr.length <= 1) return arr.join('');
  return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

// ---- alert rule ----------------------------------------------------------
export function parseAlert(text) {
  const t = text.toLowerCase();
  const lb = t.match(/(?:last|past)\s+(\d{1,2})\s+months?/);
  const lookback = lb ? Number(lb[1]) : 18;
  const singleFact = Object.values(ALL_MEASURES).filter((m) => m.kind === 'base' || BASE_MEASURES[m.numerator].fact === BASE_MEASURES[m.denominator].fact);
  let measure = 'warranty_cost';
  const syns = singleFact.flatMap((m) => m.synonyms.map((s) => [s, m.name])).sort((a, b) => b[0].length - a[0].length);
  for (const [s, n] of syns) if (t.includes(s)) { measure = n; break; }
  let dimension = 'none';
  for (const [d, re] of DIM_PATTERNS) if (!DIMENSIONS[d].time && re.test(text)) { dimension = d; break; }
  const fact = BASE_MEASURES[ALL_MEASURES[measure].kind === 'base' ? measure : ALL_MEASURES[measure].numerator].fact;
  if (dimension !== 'none' && !FACTS[fact].dimensions.includes(dimension)) dimension = 'none';
  let condition = 'pct_increase_gt', threshold = 20;
  const pct = t.match(/(\d+(?:\.\d+)?)\s*(%|percent)/);
  const money = t.match(/\$\s?([\d,.]+)\s*(k|m|thousand|million)?/);
  if (pct) threshold = Number(pct[1]);
  if (!pct && money) {
    condition = 'value_gt';
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[money[2]] || 1;
    threshold = Number(money[1].replace(/,/g, '')) * mult;
  } else if (!pct && /\b(exceeds?|above|over|more than|greater than)\s+([\d,.]+)/.test(t)) {
    condition = 'value_gt';
    threshold = Number(t.match(/\b(?:exceeds?|above|over|more than|greater than)\s+([\d,.]+)/)[1].replace(/,/g, ''));
  }
  const label = ALL_MEASURES[measure].label;
  const name = condition === 'pct_increase_gt'
    ? `${label}${dimension !== 'none' ? ` by ${DIMENSIONS[dimension].label.toLowerCase()}` : ''} up more than ${threshold}% month over month`
    : `${label}${dimension !== 'none' ? ` by ${DIMENSIONS[dimension].label.toLowerCase()}` : ''} above ${threshold.toLocaleString('en-US')} in a month`;
  return { name, measure, dimension, grain: 'month', condition, threshold, lookback_months: lookback, assumptions: ['Interpreted with the rule-based alert parser.'] };
}
