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
    ...presentationFor(text, timeDim, others[0]),
    assumptions: assumptions.length ? assumptions : ['Interpreted with the rule-based glossary matcher.'],
  };
}

function presentationFor(text, timeDim, catDim) {
  const p = detectPresentation(text, { hasTime: Boolean(timeDim), hasSeries: Boolean(catDim) });
  return { chart: p.chart || (timeDim ? 'line' : 'bar'), layout: p.layout || 'standard' };
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
// One alert can hold several conditions, combined with AND (all must hold) or OR (any holds),
// e.g. "warranty cost rises more than 50% month over month and claims exceed 20".
const ALERT_MEASURE_SYNS = () => Object.values(ALL_MEASURES)
  .filter((m) => m.kind === 'base' || BASE_MEASURES[m.numerator].fact === BASE_MEASURES[m.denominator].fact)
  .flatMap((m) => m.synonyms.map((s) => [s, m.name])).sort((a, b) => b[0].length - a[0].length);

function measureIn(text) {
  for (const [s, n] of ALERT_MEASURE_SYNS()) if (new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}\\b`).test(text)) return n;
  return null;
}

export function parseAlertClause(clause, fallbackMeasure = 'warranty_cost') {
  const t = clause.toLowerCase();
  const measure = measureIn(t) || fallbackMeasure;
  let condition = 'pct_increase_gt';
  let threshold = 20;
  const pct = t.match(/(\d+(?:\.\d+)?)\s*(%|percent)/);
  const money = t.match(/\$\s?([\d,.]+)\s*(k|m|thousand|million)?\b/);
  if (pct) threshold = Number(pct[1]);
  if (!pct && money) {
    condition = 'value_gt';
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[money[2]] || 1;
    threshold = Number(money[1].replace(/,/g, '')) * mult;
  } else if (!pct && /\b(exceeds?|exceeding|above|over|more than|greater than|reach(es)?|hits?)\s+([\d,.]+)/.test(t)) {
    condition = 'value_gt';
    threshold = Number(t.match(/\b(?:exceeds?|exceeding|above|over|more than|greater than|reach(?:es)?|hits?)\s+([\d,.]+)/)[1].replace(/,/g, ''));
  }
  return { measure, condition, threshold };
}

export function conditionText(c) {
  const label = ALL_MEASURES[c.measure]?.label || c.measure;
  return c.condition === 'pct_increase_gt'
    ? `${label} up more than ${c.threshold}% month over month`
    : `${label} above ${Number(c.threshold).toLocaleString('en-US')} in a month`;
}

export function alertName(spec) {
  const per = spec.dimension && spec.dimension !== 'none' ? ` (per ${DIMENSIONS[spec.dimension].label.toLowerCase()})` : '';
  return spec.conditions.map(conditionText).join(spec.combine === 'any' ? ' OR ' : ' AND ') + per;
}

const hasThreshold = (s) => /\d/.test(s);

export function parseAlert(text) {
  const t = text.toLowerCase();
  const lb = t.match(/(?:last|past)\s+(\d{1,2})\s+months?/);
  const lookback = lb ? Number(lb[1]) : 18;
  // Only the condition part ("... when X and Y"), without the look-back phrase.
  const body = t.replace(/\b(?:over|in|for)?\s*(?:the\s+)?(?:last|past)\s+\d{1,2}\s+months?\b/g, ' ').replace(/^.*?\b(when|whenever|if)\b/, '');
  const parts = body.split(/\s+(and|or)\s+/);
  const clauses = [];
  const ops = [];
  let cur = '';
  let startOp = null;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { if (!cur) startOp = parts[i]; else cur += ` ${parts[i]} `; continue; }
    cur += parts[i];
    if (hasThreshold(parts[i])) { clauses.push(cur.trim()); ops.push(startOp); cur = ''; startOp = null; }
  }
  if (cur.trim() && clauses.length) clauses[clauses.length - 1] += ' ' + cur.trim();
  if (!clauses.length) clauses.push(body.trim() || t);

  const conditions = [];
  for (const c of clauses) conditions.push(parseAlertClause(c, conditions.at(-1)?.measure));
  const combine = ops.slice(1).includes('or') ? 'any' : 'all';

  let dimension = 'none';
  for (const [d, re] of DIM_PATTERNS) if (!DIMENSIONS[d].time && re.test(text)) { dimension = d; break; }
  const first = conditions[0].measure;
  const fact = BASE_MEASURES[ALL_MEASURES[first].kind === 'base' ? first : ALL_MEASURES[first].numerator].fact;
  if (dimension !== 'none' && !FACTS[fact].dimensions.includes(dimension)) dimension = 'none';

  const spec = { dimension, grain: 'month', combine, conditions, lookback_months: lookback, assumptions: ['Interpreted with the rule-based alert parser.'] };
  spec.name = alertName(spec);
  return spec;
}

// ---- reviewer comments ("request changes") ---------------------------------
// The rule engine understands a set of common phrasings. Anything it does not understand is
// reported back to the reviewer instead of being guessed.
const sentencesOf = (text) => text.split(/[.;\n]+|,\s*(?=(?:and\s+)?(?:rename|hash|mask|keep|exclude|include|quarantine|load|use|append|replace|add|remove|drop|show|make|change|set|break|also|only|don't|do not)\b)/i).map((s) => s.trim()).filter(Boolean);
const toSnake = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function reviseOnboardingFromComment(comment, mapping, layerRules) {
  const unrecognised = [];
  const findCol = (name) => mapping.columns.find((c) => [c.source_column, c.target_column].some((n) => n.toLowerCase() === name.toLowerCase()));
  for (const s of sentencesOf(comment)) {
    const t = s.toLowerCase();
    let hit = false;
    for (const m of s.matchAll(/rename\s+(?:the\s+)?(?:column\s+)?["'`]?([\w]+)["'`]?\s+(?:to|as|into)\s+["'`]?([\w ]+?)["'`]?(?=$|\s+and\b|,)/gi)) {
      const c = findCol(m[1]);
      if (c) { c.target_column = toSnake(m[2]); hit = true; }
    }
    const piiM = s.match(/\b(?:hash|mask|encrypt|pseudonymi[sz]e|anonymi[sz]e)\s+(?:the\s+)?(?:column\s+)?["'`]?(\w+)/i) || s.match(/["'`]?(\w+)["'`]?\s+(?:is|as)\s+(?:pii|personal data|sensitive)/i);
    if (piiM && findCol(piiM[1])) { const c = findCol(piiM[1]); c.pii = true; c.transform = 'sha256_pii'; hit = true; }

    if (/\bbronze\b|\bhistory\b|\bload(s|ing)?\b|\bwatermark|\bincremental|\bdelta\b|\bfull refresh\b/.test(t)) {
      if (/incremental|watermark|\bdelta\b|only new (records|rows)|new records only/.test(t)) { layerRules.bronze.load_mode = 'incremental'; hit = true; }
      else if (/\b(replace|overwrite|truncate|full refresh|no history|don'?t keep history|do not keep history)\b/.test(t)) { layerRules.bronze.load_mode = 'replace'; hit = true; }
      else if (/\b(keep|retain|preserve|maintain|store)\b.*\bhistory\b|\bappend\b|\ball (the )?(old )?history\b/.test(t)) { layerRules.bronze.load_mode = 'append'; hit = true; }
    }

    // Quarantine rules: look only at the words next to the instruction, not the whole sentence.
    const NEG = "(?:don'?t|do not|stop|no longer|never)\\s+";
    const negAmt = new RegExp(`(?:${NEG})(?:quarantine|reject|discard)[^.;]{0,40}negative|(?:keep|allow|accept)\\s+(?:the\\s+)?(?:rows with\\s+)?negative`);
    const posAmt = /(?:quarantine|reject|discard)[^.;]{0,40}negative|negative[^.;]{0,30}(?:to|into|in)\s+quarantine/;
    if (negAmt.test(t)) { layerRules.silver.quarantine_negative_amounts = false; hit = true; }
    else if (posAmt.test(t)) { layerRules.silver.quarantine_negative_amounts = true; hit = true; }
    const DATE = '(?:missing|bad|invalid|unparseable|blank|empty)\\s+(?:claim\\s+)?dates?';
    const negDate = new RegExp(`(?:${NEG})(?:quarantine|reject)[^.;]{0,40}${DATE}|(?:keep|allow|accept)\\s+(?:the\\s+)?(?:rows with\\s+)?${DATE}`);
    const posDate = new RegExp(`(?:quarantine|reject)[^.;]{0,40}${DATE}`);
    if (negDate.test(t)) { layerRules.silver.quarantine_bad_date = false; hit = true; }
    else if (posDate.test(t)) { layerRules.silver.quarantine_bad_date = true; hit = true; }

    // Status rules: "keep only APPROVED and PAID in silver", "exclude PENDING from gold", "only active records in gold".
    const values = layerRules.status_values || [];
    let named = values.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(s));
    if (!named.length && /\bactive\b/.test(t)) named = values.filter((v) => !/^(REJECTED|CANCELL?ED|VOID(ED)?|DELETED|INACTIVE|DUPLICATE|OBSOLETE)$/.test(v));
    if (named.length && layerRules.status_column) {
      const layer = /\b(gold|reports?|dashboards?|facts?)\b/.test(t) ? 'gold' : 'silver';
      const key = layer === 'gold' ? 'include_statuses' : 'keep_statuses';
      const cur = layerRules[layer][key];
      if (/\b(exclude|remove|drop|without|except|filter out|not include|don'?t include|do not include|leave out)\b/.test(t)) layerRules[layer][key] = cur.filter((v) => !named.includes(v));
      else if (/\b(only|just|exclusively)\b/.test(t) || /\bactive\b/.test(t)) layerRules[layer][key] = named;
      else if (/\b(include|add|also|keep|allow)\b/.test(t)) layerRules[layer][key] = [...new Set([...cur, ...named])];
      else layerRules[layer][key] = named;
      if (layer === 'silver') layerRules.gold.include_statuses = layerRules.gold.include_statuses.filter((v) => layerRules.silver.keep_statuses.includes(v));
      hit = true;
    }
    if (!hit) unrecognised.push(s);
  }
  return { unrecognised };
}

export function detectPresentation(text, { hasTime, hasSeries }) {
  const t = text.toLowerCase();
  let chart = null;
  if (/\bstacked\b/.test(t)) chart = hasTime ? 'stacked_column' : 'bar';
  else if (/\b(column|vertical bar)s?\b/.test(t)) chart = 'column';
  else if (/\b(bar chart|bar graph|bars|horizontal bar)\b/.test(t)) chart = hasTime ? 'column' : 'bar';
  else if (/\b(line chart|line graph|trend line|as a line)\b/.test(t)) chart = 'line';
  else if (/\b(as a table|in a table|table only|tabular|just a table|table view)\b/.test(t)) chart = 'table';
  if (chart === 'stacked_column' && !hasSeries) chart = 'column';
  let layout = null;
  if (/\b(executive|summary|at a glance|one[- ]pager|headline)\b/.test(t)) layout = 'executive';
  else if (/\b(scorecard|score card|detailed|detail view|kpis? and (a )?table)\b/.test(t)) layout = 'scorecard';
  else if (/\b(standard|full) (layout|view|dashboard)\b/.test(t)) layout = 'standard';
  return { chart, layout };
}

export function reviseReportFromComment(comment, spec) {
  const unrecognised = [];
  for (const s of sentencesOf(comment)) {
    const t = s.toLowerCase();
    let hit = false;
    const hasTime = spec.dimensions.some((d) => DIMENSIONS[d].time);
    const pres = detectPresentation(s, { hasTime, hasSeries: spec.dimensions.some((d) => !DIMENSIONS[d].time) });
    if (pres.chart) { spec.chart = pres.chart; hit = true; }
    if (pres.layout) { spec.layout = pres.layout; hit = true; }
    const ms = Object.values(ALL_MEASURES).flatMap((m) => m.synonyms.map((x) => [x, m.name])).sort((a, b) => b[0].length - a[0].length)
      .filter(([x]) => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}\\b`).test(t)).map(([, n]) => n);
    const named = [...new Set(ms)];
    if (named.length && /\b(remove|drop|without|hide|exclude|take out)\b/.test(t)) { spec.measures = spec.measures.filter((m) => !named.includes(m)); hit = true; }
    else if (named.length && /\b(add|include|also show|show also|plus)\b/.test(t)) { spec.measures = [...new Set([...spec.measures, ...named])]; hit = true; }
    const dimHits = DIM_PATTERNS.filter(([d, re]) => re.test(s) && !(d === 'month' && /month[- ]over[- ]month/.test(t))).map(([d]) => d);
    if (dimHits.length && /\b(by|per|split|break ?down|group|instead|each)\b/.test(t)) {
      for (const d of dimHits) {
        if (DIMENSIONS[d].time) spec.dimensions = [d, ...spec.dimensions.filter((x) => !DIMENSIONS[x].time)];
        else if (/\bbreak ?down|split\b/.test(t)) spec.breakdown_dimension = d;
        else spec.dimensions = [...spec.dimensions.filter((x) => DIMENSIONS[x].time), d];
      }
      hit = true;
    }
    const yrs = t.match(/\b(20\d{2})\b/g);
    if (yrs && /\b(for|in|period|year|only|from|to|between)\b/.test(t)) {
      spec.date_from = `${Math.min(...yrs)}-01-01`; spec.date_to = `${Math.max(...yrs)}-12-31`; hit = true;
    }
    const title = s.match(/\b(?:title|call it|name it|rename (?:the )?report)\s*(?:to|as|:)?\s*["'“]?(.+?)["'”]?$/i);
    if (title) { spec.title = title[1].trim(); hit = true; }
    if (!hit) unrecognised.push(s);
  }
  return { unrecognised };
}

export function reviseAlertFromComment(comment, spec) {
  const unrecognised = [];
  for (const s of sentencesOf(comment)) {
    const t = s.toLowerCase();
    let hit = false;
    const change = t.match(/\b(?:change|move|lower|raise|set)\b.*?(\d[\d,.]*)\s*(%|percent)?\s+to\s+\$?(\d[\d,.]*)/);
    const thr = t.match(/\bthreshold\b\s*(?:to|of|=|at)?\s*\$?(\d[\d,.]*)\s*(%|percent|k|m)?/);
    if (/\b(add|also|plus|another condition|second condition)\b/.test(t) && /\d/.test(t)) {
      const clause = t.replace(/^.*?\b(when|if|that)\b/, '');
      spec.conditions.push(parseAlertClause(clause, spec.conditions[0]?.measure));
      hit = true;
    } else if (change) {
      const from = Number(change[1].replace(/,/g, ''));
      const to = Number(change[3].replace(/,/g, ''));
      const c = spec.conditions.find((x) => Number(x.threshold) === from) || spec.conditions[0];
      c.threshold = to; hit = true;
    } else if (thr) {
      const named = measureIn(t);
      const c = spec.conditions.find((x) => x.measure === named) || spec.conditions[0];
      const mult = { k: 1e3, m: 1e6 }[thr[2]] || 1;
      c.threshold = Number(thr[1].replace(/,/g, '')) * mult; hit = true;
    }
    if (/\b(remove|drop|delete)\b/.test(t) && spec.conditions.length > 1) {
      const named = measureIn(t);
      const before = spec.conditions.length;
      spec.conditions = spec.conditions.filter((c, i) => (named ? c.measure !== named : i !== spec.conditions.length - 1));
      if (!spec.conditions.length) spec.conditions = [{ measure: 'warranty_cost', condition: 'pct_increase_gt', threshold: 20 }];
      hit = hit || spec.conditions.length !== before;
    }
    if (/\b(any|either|any one|or)\b/.test(t) && /\b(condition|rule|fire|trigger|combine)/.test(t)) { spec.combine = 'any'; hit = true; }
    else if (/\b(both|all)\b/.test(t) && /\b(condition|rule|fire|trigger|combine|together)/.test(t)) { spec.combine = 'all'; hit = true; }
    const dims = DIM_PATTERNS.filter(([d, re]) => !DIMENSIONS[d].time && re.test(s)).map(([d]) => d);
    if (dims.length && /\b(per|by|for each|each|for any|instead)\b/.test(t)) { spec.dimension = dims[0]; hit = true; }
    else if (/\b(overall|in total|total only|no breakdown)\b/.test(t)) { spec.dimension = 'none'; hit = true; }
    const lb = t.match(/(?:last|past)\s+(\d{1,2})\s+months?/);
    if (lb) { spec.lookback_months = Number(lb[1]); hit = true; }
    if (!hit) unrecognised.push(s);
  }
  spec.name = alertName(spec);
  return { unrecognised };
}
