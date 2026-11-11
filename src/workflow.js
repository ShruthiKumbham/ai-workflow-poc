// Natural-language intake and the single-reviewer approval gate.
// intake(): classify the request, run the matching use-case generator, park the output for review.
// decide(): approve (deploy exactly what was reviewed) or reject.
import { exclusive } from './db.js';
import { structured, SYSTEM_PROMPT, engineInfo } from './llm.js';
import * as rules from './rules.js';
import { listSources } from './profiler.js';
import { proposeOnboarding, deployOnboarding, reviseOnboarding } from './onboarding.js';
import { proposeReport, deployReport, reviseReport } from './reporting.js';
import { proposeAlert, deployAlert, reviseAlert } from './alerts.js';
import { createRequest, updateRequest, createArtifact, getArtifact, setArtifactStatus, audit } from './meta.js';

const ENGINE_LABEL = (e) => (e === 'claude' ? engineInfo().label : 'Rule-based engine');

async function classify(text, sources) {
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['intent', 'source_table', 'restated_request'],
    properties: {
      intent: { type: 'string', enum: ['onboarding', 'report', 'alert', 'unknown'], description: 'onboarding = bring a new source onto the platform; report = a business question, dashboard or KPI; alert = notify when a condition happens' },
      source_table: { type: 'string', enum: ['none', ...sources.map((s) => s.dataset)], description: 'For onboarding only: which source table' },
      restated_request: { type: 'string' },
    },
  };
  const prompt = `Classify this portal request: "${text}"\n\nSource tables on the platform:\n${sources.map((s) => `- ${s.dataset}: ${s.title}. ${s.description}${s.onboarded ? ' (already onboarded)' : ''}`).join('\n')}`;
  const ai = await structured({ system: SYSTEM_PROMPT, prompt, schema, effort: 'low' });
  if (ai.ok) return { ...ai.data, engine: 'claude' };
  return { ...rules.classifyIntent(text, sources), engine: 'rules', aiError: ai.error };
}

export async function intake({ text, requester = 'Demo user', persona = 'engineer' }) {
  return exclusive(async () => {
    const requestId = await createRequest({ requester, persona, text });
    try {
      const sources = await listSources();
      const c = await classify(text, sources);
      await updateRequest(requestId, { intent: c.intent, status: 'processing', engine: ENGINE_LABEL(c.engine) });

      let proposal;
      if (c.intent === 'onboarding') {
        if (c.source_table === 'none') {
          const msg = `Which source should be onboarded? Available: ${sources.filter((s) => !s.onboarded).map((s) => s.dataset).join(', ') || 'none'}.`;
          await updateRequest(requestId, { status: 'needs_input', message: msg });
          return { requestId, status: 'needs_input', intent: c.intent, message: msg };
        }
        proposal = await proposeOnboarding({ sourceTable: c.source_table, requestText: text });
      } else if (c.intent === 'report') {
        proposal = await proposeReport({ requestText: text });
      } else if (c.intent === 'alert') {
        proposal = await proposeAlert({ requestText: text });
      } else {
        const msg = 'I could not tell what you need. Try "Onboard warranty claims from the dealer portal", "Show monthly warranty cost by product line for 2025", or "Alert me when warranty cost for any product line rises more than 50% month over month".';
        await updateRequest(requestId, { status: 'needs_input', message: msg });
        return { requestId, status: 'needs_input', intent: c.intent, message: msg };
      }

      if (proposal.blocked) {
        await updateRequest(requestId, { status: 'blocked', message: proposal.message });
        return { requestId, status: 'blocked', intent: c.intent, message: proposal.message };
      }
      proposal.payload.notes.unshift({ step: 'Intake', engine: c.engine, note: `Classified as "${c.intent}"${c.source_table !== 'none' ? ` for ${c.source_table}` : ''}${c.aiError && engineInfo().mode === 'claude' ? ` (Claude unavailable: ${c.aiError})` : ''}.` });
      const kind = c.intent;
      const artifactId = await createArtifact({ requestId, kind, title: proposal.title, engine: ENGINE_LABEL(proposal.engine), summary: proposal.summary, payload: proposal.payload });
      const msg = `Generated "${proposal.title}". It is waiting for review before anything goes live.`;
      await updateRequest(requestId, { status: 'pending_review', artifact_id: artifactId, message: msg });
      return { requestId, status: 'pending_review', intent: kind, artifactId, message: msg, summary: proposal.summary };
    } catch (err) {
      await updateRequest(requestId, { status: 'failed', message: String(err.message || err) });
      await audit('system', 'request.failed', requestId, String(err.message || err));
      return { requestId, status: 'failed', message: String(err.message || err) };
    }
  });
}

export async function decide(artifactId, { decision, reviewer, comment, acceptSuggestions = false }) {
  return exclusive(async () => {
    const a = await getArtifact(artifactId);
    if (!a) throw Object.assign(new Error('Artifact not found'), { status: 404 });
    if (a.status !== 'pending_review') throw Object.assign(new Error(`Artifact is ${a.status}, not pending review`), { status: 409 });
    if (!reviewer) throw Object.assign(new Error('Reviewer name is required'), { status: 400 });
    if (decision === 'reject') {
      await setArtifactStatus(artifactId, 'rejected', { reviewer, comment });
      await updateRequest(a.request_id, { status: 'rejected', message: `Rejected by ${reviewer}${comment ? `: ${comment}` : ''}` });
      await audit(reviewer, 'artifact.rejected', artifactId, comment || '');
      return { status: 'rejected' };
    }
    if (decision !== 'approve') throw Object.assign(new Error('decision must be approve or reject'), { status: 400 });
    await audit(reviewer, 'artifact.approved', artifactId, comment || '');
    try {
      let result;
      if (a.kind === 'onboarding') result = await deployOnboarding(a, { reviewer, acceptSuggestions });
      else if (a.kind === 'report') result = await deployReport(a, { reviewer });
      else if (a.kind === 'alert') result = await deployAlert(a, { reviewer });
      a.payload.deployment = { at: new Date().toISOString(), result };
      await setArtifactStatus(artifactId, 'deployed', { reviewer, comment, payload: a.payload });
      const msg = a.kind === 'report' ? `Approved by ${reviewer}; dashboard ${result.reportId} published.` : a.kind === 'alert' ? `Approved by ${reviewer}; alert ${result.alertId} active.` : `Approved by ${reviewer}; ${result.datasets.join(', ')} live and registered in the catalog.`;
      await updateRequest(a.request_id, { status: 'completed', message: msg });
      return { status: 'deployed', result, message: msg };
    } catch (err) {
      await setArtifactStatus(artifactId, 'failed', { reviewer, comment: `${comment || ''} | deploy failed: ${err.message}` });
      await updateRequest(a.request_id, { status: 'failed', message: `Deployment failed: ${err.message}` });
      await audit(reviewer, 'artifact.deploy_failed', artifactId, err.message);
      throw Object.assign(new Error(`Deployment failed and was rolled back: ${err.message}`), { status: 500 });
    }
  });
}

// Request changes: the reviewer's edits and comment produce a new version of the proposal,
// regenerated and dry-run again. The previous version is kept as "superseded" for the audit trail.
export async function revise(artifactId, { reviewer, comment = '', edits = {} }) {
  return exclusive(async () => {
    const a = await getArtifact(artifactId);
    if (!a) throw Object.assign(new Error('Artifact not found'), { status: 404 });
    if (a.status !== 'pending_review') throw Object.assign(new Error(`Artifact is ${a.status}, not pending review`), { status: 409 });
    if (!reviewer) throw Object.assign(new Error('Reviewer name is required'), { status: 400 });
    const hasEdits = edits && Object.keys(edits).length > 0;
    if (!comment.trim() && !hasEdits) throw Object.assign(new Error('Describe the change in the comment box, or edit the proposal on the review screen'), { status: 400 });

    const reviser = { onboarding: reviseOnboarding, report: reviseReport, alert: reviseAlert }[a.kind];
    const proposal = await reviser(a.payload, { edits, comment });
    const prev = a.payload.revision || { version: 1, history: [] };
    const version = prev.version + 1;
    const history = [...(prev.history || []), { version: prev.version, artifact_id: a.id, requested_by: reviewer, comment, changes: proposal.changes, at: new Date().toISOString() }];
    proposal.payload.revision = { version, parent_id: a.id, requested_by: reviewer, comment, changes: proposal.changes, not_applied: proposal.notApplied || [], history };
    proposal.payload.notes.unshift({ step: 'Request changes', engine: 'deterministic', note: `Version ${version}, requested by ${reviewer}${comment ? `: "${comment}"` : ''}` });

    const newId = await createArtifact({ requestId: a.request_id, kind: a.kind, title: proposal.title, engine: ENGINE_LABEL(proposal.engine), summary: proposal.summary, payload: proposal.payload });
    await setArtifactStatus(artifactId, 'superseded', { reviewer, comment: `Changes requested → ${newId}${comment ? `: ${comment}` : ''}` });
    const msg = `Changes requested by ${reviewer}; version ${version} (${newId}) is waiting for review.`;
    await updateRequest(a.request_id, { status: 'pending_review', artifact_id: newId, message: msg });
    await audit(reviewer, 'artifact.changes_requested', artifactId, `${comment || 'edited on review screen'} → ${newId}`);
    return { status: 'revised', artifactId: newId, version, changes: proposal.changes, notApplied: proposal.notApplied || [], message: msg };
  });
}
