// Use case 3 - quality and warranty monitoring (thin slice): a plain-English alert made of one or
// more conditions (combined with AND / OR), compiled to SQL over a Gold fact, back-tested against
// history, approved, then evaluated on demand.
import { all, tableExists } from './db.js';
import { structured, SYSTEM_PROMPT, engineInfo } from './llm.js';
import * as rules from './rules.js';
import { ALL_MEASURES, BASE_MEASURES, DIMENSIONS, FACTS, measureSql } from './semantic.js';
import { saveAlert, setAlertResult, audit, newId } from './meta.js';

const singleFactMeasures = () => Object.values(ALL_MEASURES)
  .filter((m) => m.kind === 'base' || BASE_MEASURES[m.numerator].fact === BASE_MEASURES[m.denominator].fact)
  .map((m) => m.name);
const factOf = (measure) => BASE_MEASURES[ALL_MEASURES[measure].kind === 'base' ? measure : ALL_MEASURES[measure].numerator].fact;
export const MAX_CONDITIONS = 4;

const CONDITION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['measure', 'condition', 'threshold'],
  properties: {
    measure: { type: 'string', enum: singleFactMeasures() },
    condition: { type: 'string', enum: ['pct_increase_gt', 'value_gt'], description: 'pct_increase_gt: month-over-month % increase above threshold; value_gt: monthly value above threshold' },
    threshold: { type: 'number' },
  },
};

const ALERT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'dimension', 'grain', 'combine', 'conditions', 'lookback_months', 'assumptions'],
  properties: {
    name: { type: 'string', description: 'Short alert name' },
    dimension: { type: 'string', enum: ['none', ...Object.keys(DIMENSIONS).filter((d) => !DIMENSIONS[d].time)] },
    grain: { type: 'string', enum: ['month'] },
    combine: { type: 'string', enum: ['all', 'any'], description: 'all = every condition must hold in the same month (AND); any = one is enough (OR)' },
    conditions: { type: 'array', items: CONDITION_SCHEMA, description: `1-${MAX_CONDITIONS} conditions; all measures must come from the same fact` },
    lookback_months: { type: 'integer', description: 'How many recent months to evaluate (default 18)' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
};

// Accepts the older single-condition shape too ({ measure, condition, threshold }).
export function validateAlert(spec) {
  const errors = [];
  if (!Array.isArray(spec.conditions) || !spec.conditions.length) {
    spec.conditions = spec.measure ? [{ measure: spec.measure, condition: spec.condition, threshold: spec.threshold }] : [];
  }
  spec.conditions = spec.conditions.slice(0, MAX_CONDITIONS).map((c) => ({ measure: c.measure, condition: c.condition, threshold: Number(c.threshold) }));
  if (!spec.conditions.length) errors.push('at least one condition is required');
  for (const c of spec.conditions) {
    if (!singleFactMeasures().includes(c.measure)) errors.push(`measure ${c.measure} not allowed for alerts`);
    if (!['pct_increase_gt', 'value_gt'].includes(c.condition)) errors.push(`invalid condition ${c.condition}`);
    if (!(c.threshold > 0)) errors.push('thresholds must be positive');
  }
  if (errors.length) return errors;
  const facts = [...new Set(spec.conditions.map((c) => factOf(c.measure)))];
  if (facts.length > 1) return [`all conditions must use measures from the same fact (got ${facts.join(', ')})`];
  spec.combine = spec.combine === 'any' ? 'any' : 'all';
  if (!spec.dimension || (spec.dimension !== 'none' && !FACTS[facts[0]]?.dimensions.includes(spec.dimension))) spec.dimension = 'none';
  spec.lookback_months = Math.min(Math.max(Number(spec.lookback_months) || 18, 1), 24);
  spec.grain = 'month';
  // Keep the first condition at the top level for older readers.
  Object.assign(spec, spec.conditions[0]);
  spec.assumptions = (spec.assumptions || []).filter((x) => !/conditions combined with/.test(x));
  if (spec.conditions.length > 1) spec.assumptions.push(`${spec.conditions.length} conditions combined with ${spec.combine === 'any' ? 'OR (any one fires the alert)' : 'AND (all must hold in the same month)'}.`);
  if (!spec.name) spec.name = rules.alertName(spec);
  return [];
}

export function compileAlert(spec) {
  const fact = factOf(spec.conditions[0].measure);
  const member = spec.dimension === 'none' ? `'All'` : spec.dimension;
  const cs = spec.conditions;
  const values = cs.map((c, i) => `(${measureSql(c.measure, { overFact: true })})::DOUBLE AS v${i + 1}`).join(',\n         ');
  const lags = cs.map((_, i) => `lag(v${i + 1}) OVER w AS p${i + 1}`).join(', ');
  const cond = (c, i) => (c.condition === 'pct_increase_gt'
    ? `coalesce(p${i + 1} > 0 AND (v${i + 1} - p${i + 1}) / p${i + 1} * 100 > ${Number(c.threshold)}, false)`
    : `coalesce(v${i + 1} > ${Number(c.threshold)}, false)`);
  const perCond = cs.map((c, i) => `round(v${i + 1}, 2) AS value_${i + 1}, round(p${i + 1}, 2) AS previous_${i + 1}, round((v${i + 1} - p${i + 1}) / nullif(p${i + 1}, 0) * 100, 1) AS pct_change_${i + 1}, ${cond(c, i)} AS met_${i + 1}`).join(',\n       ');
  const triggered = cs.map(cond).join(spec.combine === 'any' ? ' OR ' : ' AND ');
  return `-- Alert: ${spec.name}
-- ${cs.length} condition(s), combined with ${spec.combine === 'any' ? 'OR (any condition fires)' : 'AND (all conditions in the same month)'}
${cs.map((c, i) => `--   ${i + 1}. ${rules.conditionText(c)}`).join('\n')}
WITH monthly AS (
  SELECT month, ${member} AS member,
         ${values}
  FROM ${fact}
  GROUP BY ALL
),
compared AS (
  SELECT *, ${lags}
  FROM monthly
  WINDOW w AS (PARTITION BY member ORDER BY month)
)
SELECT month, member,
       round(v1, 2) AS value, round(p1, 2) AS previous, round((v1 - p1) / nullif(p1, 0) * 100, 1) AS pct_change,
       ${perCond},
       (${triggered}) AS triggered
FROM compared
WHERE month >= strftime(strptime((SELECT max(month) FROM monthly), '%Y-%m') - INTERVAL ${spec.lookback_months - 1} MONTH, '%Y-%m')
ORDER BY month DESC, member`;
}

async function evaluateSql(sql) {
  const rows = await all(sql);
  const triggered = rows.filter((r) => r.triggered);
  return { evaluated_at: new Date().toISOString(), status: triggered.length ? 'TRIGGERED' : 'OK', triggered_count: triggered.length, rows };
}

function measureList() {
  return singleFactMeasures().map((m) => `- ${m}: ${ALL_MEASURES[m].label}. ${ALL_MEASURES[m].definition} (fact ${factOf(m)})`).join('\n');
}

export async function proposeAlert({ requestText }) {
  const notes = [];
  let spec = null;
  let engine = 'rules';
  const ai = await structured({
    system: SYSTEM_PROMPT,
    prompt: `Turn this monitoring request into an alert rule: "${requestText}"\n\nAn alert has 1-${MAX_CONDITIONS} conditions evaluated per calendar month, combined with "all" (AND) or "any" (OR). All conditions must use measures from the same fact. Use dimension "none" for a single overall series.\n\nMeasures:\n${measureList()}`,
    schema: ALERT_SCHEMA,
  });
  if (ai.ok && !validateAlert(ai.data).length) { spec = ai.data; engine = 'claude'; notes.push({ step: 'Alert rule', engine: 'claude', note: `Interpreted by ${engineInfo().label}; passed validation.` }); }
  else if (engineInfo().mode === 'claude') notes.push({ step: 'Alert rule', engine: 'claude', note: `Claude result not usable (${ai.error || 'failed validation'}); used rule engine.` });
  if (!spec) {
    spec = rules.parseAlert(requestText);
    const errs = validateAlert(spec);
    if (errs.length) throw new Error(errs.join('; '));
    notes.push({ step: 'Alert rule', engine: 'rules', note: `Interpreted by rule-based alert parser: ${spec.conditions.length} condition(s).` });
  }
  return buildAlert({ requestText, spec, notes, engine });
}

async function buildAlert({ requestText, spec, notes, engine }) {
  const fact = factOf(spec.conditions[0].measure);
  if (!(await tableExists(fact))) {
    return { blocked: true, spec, message: `This alert needs ${FACTS[fact].label} (${fact}), which has not been built yet. Onboard the source and publish a report that uses it first.`, notes };
  }
  const sql = compileAlert(spec);
  const preview = await evaluateSql(sql);
  notes.push({ step: 'Dry run', engine: 'deterministic', note: `Back-tested against the last ${spec.lookback_months} months: ${preview.triggered_count} trigger(s).` });
  const per = spec.dimension !== 'none' ? ` per ${DIMENSIONS[spec.dimension].label.toLowerCase()}` : '';
  const condText = spec.conditions.map((c) => rules.conditionText(c).toLowerCase()).join(spec.combine === 'any' ? ' OR ' : ' AND ');
  return {
    blocked: false,
    title: `Alert: ${spec.name}`,
    summary: `Checks monthly${per}: fires when ${condText}. Back-test over the last ${spec.lookback_months} months: ${preview.triggered_count} trigger(s).`,
    engine,
    payload: { request_text: requestText, spec, fact, sql, preview, notes },
  };
}

const specText = (s) => `${s.conditions.map(rules.conditionText).join(s.combine === 'any' ? ' OR ' : ' AND ')}; per ${s.dimension}; last ${s.lookback_months} months`;

export async function reviseAlert(payload, { edits = {}, comment = '' }) {
  const old = payload.spec;
  validateAlert(old);
  let spec = structuredClone(old);
  const notes = [];
  let engine = 'rules';
  let notApplied = [];
  if (edits.conditions) spec.conditions = edits.conditions.map((c) => ({ measure: c.measure, condition: c.condition, threshold: Number(c.threshold) }));
  for (const k of ['combine', 'dimension', 'lookback_months']) if (edits[k] !== undefined && edits[k] !== '') spec[k] = edits[k];
  spec.name = rules.alertName(spec);
  if (specText(spec) !== specText(old)) notes.push({ step: 'Reviewer edits', engine: 'deterministic', note: specText(spec) });

  if (comment.trim()) {
    const before = specText(spec);
    const ai = await structured({
      system: SYSTEM_PROMPT,
      prompt: `A reviewer asked for changes to this alert rule.\n\nReviewer comment: "${comment}"\n\nCurrent rule (JSON):\n${JSON.stringify(spec, null, 1)}\n\nReturn the complete revised rule. Change only what the comment asks for. All conditions must use measures from the same fact.\n\nMeasures:\n${measureList()}`,
      schema: ALERT_SCHEMA,
    });
    let used = false;
    if (ai.ok) {
      const cand = ai.data;
      const errs = validateAlert(cand);
      if (errs.length) notes.push({ step: 'Revision', engine: 'claude', note: `Claude revision rejected: ${errs.join('; ')}. Used rule engine.` });
      else { spec = cand; engine = 'claude'; used = true; }
    } else if (engineInfo().mode === 'claude') notes.push({ step: 'Revision', engine: 'claude', note: `Claude unavailable (${ai.error}); used rule engine.` });
    if (!used) notApplied = rules.reviseAlertFromComment(comment, spec).unrecognised;
    const after = specText(spec);
    notes.push({ step: 'Revision', engine, note: `${after !== before ? `From the comment: ${after}` : 'No change could be derived from the comment'}${notApplied.length ? `. Not applied: ${notApplied.join(' | ')}` : ''}.` });
  }
  spec.name = rules.alertName(spec);
  const errs = validateAlert(spec);
  if (errs.length) throw Object.assign(new Error(`The requested change makes the alert invalid: ${errs.join('; ')}`), { status: 400 });
  if (specText(spec) === specText(old)) {
    throw Object.assign(new Error(`No change could be applied${notApplied.length ? ` (not understood: ${notApplied.join(' | ')})` : ''}. Edit the conditions on the review screen, or phrase the comment like "add a condition: claims exceed 150", "change 50% to 30%", "fire when any condition holds" or "per region".`), { status: 400 });
  }
  const changes = [`Was: ${specText(old)}`, `Now: ${specText(spec)}`];
  const proposal = await buildAlert({ requestText: payload.request_text, spec, notes, engine });
  if (proposal.blocked) throw Object.assign(new Error(proposal.message), { status: 400 });
  return { ...proposal, changes, notApplied };
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
