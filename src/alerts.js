// Use case 3 - quality and warranty monitoring (thin slice): one plain-English alert rule,
// compiled to SQL over a Gold fact, dry-run against history, approved, then evaluated on demand.
import { all, tableExists } from './db.js';
import { structured, SYSTEM_PROMPT, engineInfo } from './llm.js';
import * as rules from './rules.js';
import { ALL_MEASURES, BASE_MEASURES, DIMENSIONS, FACTS, measureSql } from './semantic.js';
import { saveAlert, setAlertResult, audit, newId } from './meta.js';

const singleFactMeasures = () => Object.values(ALL_MEASURES)
  .filter((m) => m.kind === 'base' || BASE_MEASURES[m.numerator].fact === BASE_MEASURES[m.denominator].fact)
  .map((m) => m.name);
const factOf = (measure) => BASE_MEASURES[ALL_MEASURES[measure].kind === 'base' ? measure : ALL_MEASURES[measure].numerator].fact;

const ALERT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'measure', 'dimension', 'grain', 'condition', 'threshold', 'lookback_months', 'assumptions'],
  properties: {
    name: { type: 'string', description: 'Short alert name' },
    measure: { type: 'string', enum: singleFactMeasures() },
    dimension: { type: 'string', enum: ['none', ...Object.keys(DIMENSIONS).filter((d) => !DIMENSIONS[d].time)] },
    grain: { type: 'string', enum: ['month'] },
    condition: { type: 'string', enum: ['pct_increase_gt', 'value_gt'], description: 'pct_increase_gt: month-over-month % increase above threshold; value_gt: monthly value above threshold' },
    threshold: { type: 'number' },
    lookback_months: { type: 'integer', description: 'How many recent months to evaluate (default 18)' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
};

export function validateAlert(spec) {
  const errors = [];
  if (!singleFactMeasures().includes(spec.measure)) errors.push(`measure ${spec.measure} not allowed for alerts`);
  const fact = factOf(spec.measure);
  if (spec.dimension !== 'none' && !FACTS[fact]?.dimensions.includes(spec.dimension)) spec.dimension = 'none';
  if (!['pct_increase_gt', 'value_gt'].includes(spec.condition)) errors.push('invalid condition');
  if (!(Number(spec.threshold) > 0)) errors.push('threshold must be positive');
  spec.lookback_months = Math.min(Math.max(Number(spec.lookback_months) || 18, 1), 24);
  spec.grain = 'month';
  return errors;
}

export function compileAlert(spec) {
  const fact = factOf(spec.measure);
  const member = spec.dimension === 'none' ? `'All'` : spec.dimension;
  const cond = spec.condition === 'pct_increase_gt'
    ? `previous > 0 AND (value - previous) / previous * 100 > ${Number(spec.threshold)}`
    : `value > ${Number(spec.threshold)}`;
  return `-- Alert: ${spec.name}
WITH monthly AS (
  SELECT month, ${member} AS member, (${measureSql(spec.measure, { overFact: true })})::DOUBLE AS value
  FROM ${fact}
  GROUP BY ALL
),
compared AS (
  SELECT *, lag(value) OVER (PARTITION BY member ORDER BY month) AS previous
  FROM monthly
)
SELECT month, member, round(value, 2) AS value, round(previous, 2) AS previous,
       round((value - previous) / nullif(previous, 0) * 100, 1) AS pct_change,
       (${cond}) AS triggered
FROM compared
WHERE month >= strftime(strptime((SELECT max(month) FROM monthly), '%Y-%m') - INTERVAL ${spec.lookback_months - 1} MONTH, '%Y-%m')
ORDER BY month DESC, member`;
}

async function evaluateSql(sql) {
  const rows = await all(sql);
  const triggered = rows.filter((r) => r.triggered);
  return { evaluated_at: new Date().toISOString(), status: triggered.length ? 'TRIGGERED' : 'OK', triggered_count: triggered.length, rows };
}

export async function proposeAlert({ requestText }) {
  const notes = [];
  let spec = null;
  let engine = 'rules';
  const ai = await structured({
    system: SYSTEM_PROMPT,
    prompt: `Turn this monitoring request into an alert rule: "${requestText}"\n\nMeasures:\n${singleFactMeasures().map((m) => `- ${m}: ${ALL_MEASURES[m].label}. ${ALL_MEASURES[m].definition}`).join('\n')}\n\nThe alert is evaluated per calendar month${''}; use dimension "none" for a single overall series.`,
    schema: ALERT_SCHEMA,
  });
  if (ai.ok && !validateAlert(ai.data).length) { spec = ai.data; engine = 'claude'; notes.push({ step: 'Alert rule', engine: 'claude', note: `Interpreted by ${engineInfo().label}; passed validation.` }); }
  else if (engineInfo().mode === 'claude') notes.push({ step: 'Alert rule', engine: 'claude', note: `Claude result not usable (${ai.error || 'failed validation'}); used rule engine.` });
  if (!spec) {
    spec = rules.parseAlert(requestText);
    const errs = validateAlert(spec);
    if (errs.length) throw new Error(errs.join('; '));
    notes.push({ step: 'Alert rule', engine: 'rules', note: 'Interpreted by rule-based alert parser.' });
  }
  const fact = factOf(spec.measure);
  if (!(await tableExists(fact))) {
    return { blocked: true, spec, message: `This alert needs ${FACTS[fact].label} (${fact}), which has not been built yet. Onboard the source and publish a report that uses it first.`, notes };
  }
  const sql = compileAlert(spec);
  const preview = await evaluateSql(sql);
  notes.push({ step: 'Dry run', engine: 'deterministic', note: `Evaluated against the last ${spec.lookback_months} months: ${preview.triggered_count} trigger(s).` });
  return {
    blocked: false,
    title: `Alert: ${spec.name}`,
    summary: `Checks ${ALL_MEASURES[spec.measure].label.toLowerCase()}${spec.dimension !== 'none' ? ` per ${DIMENSIONS[spec.dimension].label.toLowerCase()}` : ''} monthly; ${spec.condition === 'pct_increase_gt' ? `fires on a month-over-month rise above ${spec.threshold}%` : `fires when the monthly value exceeds ${spec.threshold}`}. Back-test over the last ${spec.lookback_months} months: ${preview.triggered_count} trigger(s).`,
    engine,
    payload: { request_text: requestText, spec, fact, sql, preview, notes },
  };
}

export async function deployAlert(artifact, { reviewer }) {
  const id = newId('AL');
  await saveAlert({ id, name: artifact.payload.spec.name, artifactId: artifact.id, spec: artifact.payload.spec, sql: artifact.payload.sql });
  const result = await evaluateSql(artifact.payload.sql);
  await setAlertResult(id, result);
  await audit(reviewer, 'alert.activated', id, artifact.payload.spec.name);
  return { alertId: id, result };
}

export async function evaluateAlert(alert) {
  const result = await evaluateSql(alert.sql);
  await setAlertResult(alert.id, result);
  return result;
}
