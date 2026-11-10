// Portal UI - vanilla JS, hash routing, SVG charts. No build step.
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const SERIES = ['#2a6fdb', '#e07a1f', '#2f9e6e', '#b8418a', '#7a5af5', '#c9a227', '#3fa7c4', '#8c8c8c'];
const DIM_LABEL = { month: 'Month', quarter: 'Quarter', year: 'Year', vertical: 'Vertical', product_line: 'Product line', model_family: 'Model family', region: 'Region', plant_code: 'Plant', customer_name: 'Customer', dealer_name: 'Dealer', failure_mode: 'Failure mode', check_type: 'Check type' };
let STATUS = null;

// ---------- utilities ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(v, format, compact = false) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '-';
  const n = Number(v);
  if (format === 'usd') {
    if (compact && Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (compact && Math.abs(n) >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: compact ? 0 : 2, maximumFractionDigits: compact ? 0 : 2 })}`;
  }
  if (format === 'pct') return `${n.toFixed(2)}%`;
  if (format === 'dec') return n.toFixed(2);
  return Math.round(n).toLocaleString('en-US');
}
const when = (ts) => (ts ? String(ts).replace('T', ' ').slice(0, 16) : '-');
const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text ?? cls)}</span>`;
const statusText = { pending_review: 'Pending review', deployed: 'Live', rejected: 'Rejected', failed: 'Failed', completed: 'Completed', blocked: 'Blocked', needs_input: 'Needs input', processing: 'Processing', received: 'Received' };
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4200);
}
function highlightSql(sql) {
  return esc(sql)
    .replace(/(--[^\n]*)/g, '<span class="cm">$1</span>')
    .replace(/(&#39;[^&]*?&#39;)/g, '<span class="str">$1</span>')
    .replace(/\b(CREATE OR REPLACE TABLE|CREATE TABLE|SELECT|FROM|WHERE|WITH|AS|LEFT JOIN|FULL OUTER JOIN|JOIN|ON|GROUP BY ALL|GROUP BY|ORDER BY|QUALIFY|PARTITION BY|OVER|CASE|WHEN|THEN|ELSE|END|AND|OR|NOT|IS NOT DISTINCT FROM|IS NOT NULL|IS NULL|BETWEEN|DATE|EXCLUDE|DESC|INTERVAL|MONTH|NULL)\b/g, '<span class="kw">$1</span>');
}

async function refreshStatus() {
  try {
    STATUS = await api('/api/status');
    const b = $('#pendingBadge');
    b.hidden = !STATUS.counts.pending;
    b.textContent = STATUS.counts.pending;
    const e = STATUS.engine;
    $('#engineBox').innerHTML = `<span class="dot ${e.mode === 'claude' ? 'on' : ''}"></span>AI engine<b>${esc(e.label)}</b><div style="margin-top:6px">Data ${esc(STATUS.data_range.from)} to ${esc(STATUS.data_range.to)} (synthetic)</div>`;
  } catch { /* server starting */ }
}

// ---------- router ----------
const routes = {
  ask: renderAsk, review: renderReview, artifact: renderArtifact, catalog: renderCatalog, dataset: renderDataset,
  lineage: renderLineage, reports: renderReports, report: renderReport, alerts: renderAlerts, audit: renderAudit, about: renderAbout,
};
async function router() {
  const [, name = 'ask', ...rest] = (location.hash || '#/ask').split('/');
  const parent = { artifact: 'review', dataset: 'catalog', report: 'reports' }[name] || name;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === parent));
  view.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try { await (routes[name] || renderAsk)(...rest.map(decodeURIComponent)); }
  catch (err) { view.innerHTML = `<div class="card callout bad">${esc(err.message)}</div>`; }
  refreshStatus();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

// ---------- Ask ----------
const EXAMPLES = {
  engineer: [
    'Onboard warranty claims from the dealer portal',
    'Bring the MES end-of-line inspection results onto the platform',
  ],
  business: [
    'Show monthly warranty cost and claim rate per 1,000 units by product line for 2025, with a breakdown by region',
    'Warranty cost as % of revenue by vertical and quarter for 2025',
    'Which dealers had the most warranty claims this year, and what was the average claim cost?',
    'Revenue and units sold by quarter and region for 2024 and 2025',
  ],
  quality: [
    'Alert me when monthly warranty cost for any product line rises more than 50% month over month',
    'Notify me if warranty claims for any region exceed 160 in a month',
  ],
};
let persona = 'engineer';

async function renderAsk() {
  const reqs = await api('/api/requests');
  view.innerHTML = `
  <div class="page-head"><div><h1>What do you need?</h1><p>Describe it in plain English. The portal generates the pipelines, reports or alerts, and a reviewer approves them before anything goes live.</p></div></div>
  <div class="card ask-box">
    <div class="persona" id="persona">
      <button data-p="engineer">Data engineer</button><button data-p="business">Business user</button><button data-p="quality">Quality engineer</button>
    </div>
    <textarea id="askText" placeholder="e.g. Onboard warranty claims from the dealer portal"></textarea>
    <div class="row mt"><button class="btn primary" id="askBtn">Generate for review</button><span class="faint" id="askHint">Ctrl/Cmd + Enter to submit</span></div>
    <div class="chips" id="chips"></div>
    <div id="askOut"></div>
  </div>
  <div class="flow">
    <div><b>1. Intake</b>Your request is classified and routed: onboarding, report or alert.</div>
    <div><b>2. Generate</b>AI proposes mappings or a report spec within the platform's vocabulary; code is compiled to conventions.</div>
    <div><b>3. Dry run</b>Everything runs in a rolled-back transaction: data quality, reconciliation, previews.</div>
    <div><b>4. Approve</b>A single reviewer approves; only then is the exact reviewed SQL deployed, catalogued and traced.</div>
  </div>
  <div class="card mt">
    <h2>Recent requests</h2>
    ${reqs.length ? `<table class="t"><thead><tr><th>When</th><th>Request</th><th>Type</th><th>Status</th><th>Outcome</th></tr></thead><tbody>
      ${reqs.map((r) => `<tr class="${r.artifact_id ? 'click' : ''}" data-a="${esc(r.artifact_id || '')}"><td class="faint">${when(r.created_at)}</td><td>${esc(r.text)}</td><td>${r.intent ? pill(r.intent) : ''}</td><td>${pill(r.status, statusText[r.status] || r.status)}</td><td class="muted">${esc(r.message || '')}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No requests yet. Start with one of the examples above, onboarding first.</div>'}
  </div>`;
  const setPersona = (p) => {
    persona = p;
    document.querySelectorAll('#persona button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    $('#chips').innerHTML = EXAMPLES[p].map((e) => `<button class="chip">${esc(e)}</button>`).join('');
    document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('#askText').value = c.textContent; $('#askText').focus(); }));
  };
  document.querySelectorAll('#persona button').forEach((b) => b.addEventListener('click', () => setPersona(b.dataset.p)));
  setPersona(persona);
  document.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/artifact/${tr.dataset.a}`; }));
  $('#askText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAsk(); });
  $('#askBtn').addEventListener('click', submitAsk);
}

async function submitAsk() {
  const text = $('#askText').value.trim();
  if (!text) return;
  const btn = $('#askBtn');
  btn.disabled = true;
  const steps = ['Understanding the request', 'Profiling data and checking the catalog', 'Generating specification and code', 'Dry run: data quality, reconciliation, previews', 'Parking result for review'];
  const out = $('#askOut');
  out.innerHTML = `<div class="progress">${steps.map((s, i) => `<div class="step" data-i="${i}"><span class="s"></span>${s}</div>`).join('')}</div>`;
  let i = 0;
  const tick = () => { document.querySelectorAll('.step').forEach((el, j) => { el.classList.toggle('done', j < i); el.classList.toggle('on', j === i); }); };
  tick();
  const timer = setInterval(() => { if (i < steps.length - 1) { i++; tick(); } }, STATUS?.engine?.mode === 'claude' ? 2600 : 450);
  try {
    const r = await api('/api/intake', { method: 'POST', body: { text, persona, requester: { engineer: 'Data engineer', business: 'Business user', quality: 'Quality engineer' }[persona] } });
    clearInterval(timer);
    i = steps.length; tick();
    out.innerHTML = `<div class="result ${esc(r.status)}">
      <div class="row">${r.intent ? pill(r.intent) : ''}${pill(r.status, statusText[r.status] || r.status)}</div>
      <p style="margin:10px 0 6px">${esc(r.message)}</p>
      ${r.summary ? `<p class="muted" style="margin:0 0 10px">${esc(r.summary)}</p>` : ''}
      ${r.artifactId ? `<a class="btn primary" href="#/artifact/${esc(r.artifactId)}">Open for review &rarr;</a>` : ''}
    </div>`;
    refreshStatus();
  } catch (err) {
    clearInterval(timer);
    out.innerHTML = `<div class="result failed">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Review queue ----------
async function renderReview() {
  const arts = await api('/api/artifacts');
  const pending = arts.filter((a) => a.status === 'pending_review');
  const done = arts.filter((a) => a.status !== 'pending_review');
  const rows = (list) => list.map((a) => `<tr class="click" data-id="${esc(a.id)}"><td class="mono">${esc(a.id)}</td><td>${pill(a.kind)}</td><td><b>${esc(a.title)}</b><div class="faint">${esc(a.summary)}</div></td><td>${a.engine?.startsWith('Claude') ? pill('claude', a.engine) : pill('', a.engine)}</td><td>${pill(a.status, statusText[a.status])}</td><td class="faint">${when(a.created_at)}${a.reviewer ? `<br>by ${esc(a.reviewer)}` : ''}</td></tr>`).join('');
  view.innerHTML = `
  <div class="page-head"><div><h1>Review queue</h1><p>Every generated output waits here for a single reviewer. Nothing is deployed until it is approved.</p></div></div>
  <div class="card"><h2>Waiting for review (${pending.length})</h2>
    ${pending.length ? `<table class="t"><thead><tr><th>ID</th><th>Type</th><th>Item</th><th>Generated by</th><th>Status</th><th>Created</th></tr></thead><tbody>${rows(pending)}</tbody></table>` : '<div class="empty">Nothing waiting. Submit a request on the Ask page.</div>'}
  </div>
  <div class="card"><h2>Decided</h2>
    ${done.length ? `<table class="t"><thead><tr><th>ID</th><th>Type</th><th>Item</th><th>Generated by</th><th>Status</th><th>Decided</th></tr></thead><tbody>${rows(done)}</tbody></table>` : '<div class="empty">No decisions yet.</div>'}
  </div>`;
  document.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/artifact/${tr.dataset.id}`; }));
}

// ---------- Artifact detail ----------
async function renderArtifact(id) {
  const a = await api(`/api/artifacts/${encodeURIComponent(id)}`);
  const p = a.payload;
  const tabs = a.kind === 'onboarding' ? onboardingTabs(a) : a.kind === 'report' ? reportTabs(a) : alertTabs(a);
  view.innerHTML = `
  <div class="page-head"><div>
    <div class="row" style="margin-bottom:6px"><a href="#/review">&larr; Review queue</a><span class="faint">${esc(a.id)}</span>${pill(a.kind)}${pill(a.status, statusText[a.status])}</div>
    <h1>${esc(a.title)}</h1><p>${esc(a.summary)}</p>
  </div></div>
  <div class="detail-grid">
    <div>
      <div class="card">
        <div class="tabs" id="tabs">${tabs.map((t, i) => `<button data-i="${i}" class="${i ? '' : 'on'}">${esc(t.label)}</button>`).join('')}</div>
        <div id="tabBody"></div>
      </div>
      <div class="card">
        <h3>How this was produced</h3>
        <ul class="notes">${(p.notes || []).map((n) => `<li><span class="who">${esc(n.step)}</span><span>${n.engine === 'claude' ? pill('claude', 'Claude') : n.engine === 'rules' ? pill('', 'Rules') : pill('', 'Deterministic')} ${esc(n.note)}</span></li>`).join('')}</ul>
      </div>
    </div>
    <div class="decision">${decisionPanel(a)}</div>
  </div>`;
  const body = $('#tabBody');
  const show = (i) => { document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i)); body.innerHTML = tabs[i].html(); tabs[i].after?.(body); };
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.i))));
  show(0);
  wireDecision(a);
}

function decisionPanel(a) {
  const p = a.payload;
  if (a.status !== 'pending_review') {
    const d = p.deployment?.result;
    let links = '';
    if (a.kind === 'report' && d?.reportId) links = `<a class="btn primary" href="#/report/${esc(d.reportId)}">Open dashboard &rarr;</a>`;
    if (a.kind === 'onboarding' && d?.datasets) links = d.datasets.map((ds) => `<a class="btn sm" href="#/dataset/${esc(ds)}">${esc(ds)}</a>`).join(' ');
    if (a.kind === 'alert' && d?.alertId) links = `<a class="btn primary" href="#/alerts">View alert &rarr;</a>`;
    return `<div class="card"><h3>Decision</h3>
      <dl class="kv"><dt>Status</dt><dd>${pill(a.status, statusText[a.status])}</dd><dt>Reviewer</dt><dd>${esc(a.reviewer || '-')}</dd><dt>When</dt><dd>${when(a.decided_at)}</dd><dt>Comment</dt><dd>${esc(a.review_comment || '-')}</dd></dl>
      <div class="row mt">${links}</div></div>`;
  }
  const blocking = (a.kind === 'onboarding' ? p.preview.checks : a.kind === 'report' ? p.preview.checks : []).filter((c) => c.severity === 'error' && !c.passed);
  const recon = a.kind === 'report' ? p.preview.reconciliation.passed : true;
  const suggestions = a.kind === 'onboarding' ? (p.preview.exceptions || []).filter((e) => e.suggestion) : [];
  return `<div class="card"><h3>Approval gate</h3>
    <div class="callout ${blocking.length || !recon ? 'bad' : 'ok'}" style="margin-bottom:12px">${blocking.length ? `${blocking.length} blocking check(s) failed in the dry run. Approving will be refused at deploy unless fixed.` : !recon ? 'Report totals do not reconcile to source. Review before approving.' : 'Dry run passed all blocking checks.'}</div>
    <label>Reviewer</label><input type="text" id="reviewer" value="${esc(STATUS?.reviewer || 'Data Steward')}">
    <label class="mt">Comment</label><textarea id="comment" rows="3" placeholder="Optional note for the audit trail"></textarea>
    ${suggestions.length ? `<label class="mt" style="display:flex;gap:8px;align-items:flex-start;font-weight:500;color:var(--ink)"><input type="checkbox" id="acceptSug" checked style="margin-top:3px"> Accept ${suggestions.length} suggested part-number correction(s) (${suggestions.reduce((s, e) => s + e.row_count, 0)} rows) as steward overrides</label>` : ''}
    <div class="row mt"><button class="btn good" id="approveBtn">Approve &amp; deploy</button><button class="btn bad" id="rejectBtn">Reject</button></div>
    <p class="faint" style="margin-bottom:0">Approving runs exactly the SQL shown here, re-checks data quality, and records the result in the catalog, lineage and audit trail.</p>
  </div>`;
}

function wireDecision(a) {
  const go = async (decision) => {
    const reviewer = $('#reviewer').value.trim();
    if (!reviewer) return toast('Enter a reviewer name', true);
    const btns = [$('#approveBtn'), $('#rejectBtn')];
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api(`/api/artifacts/${a.id}/decision`, { method: 'POST', body: { decision, reviewer, comment: $('#comment').value, acceptSuggestions: $('#acceptSug')?.checked } });
      toast(r.message || (decision === 'reject' ? 'Rejected' : 'Deployed'));
      router();
    } catch (err) {
      toast(err.message, true);
      btns.forEach((b) => { b.disabled = false; });
      router();
    }
  };
  $('#approveBtn')?.addEventListener('click', () => go('approve'));
  $('#rejectBtn')?.addEventListener('click', () => go('reject'));
}

function checksHtml(checks) {
  return checks.map((c) => {
    const cls = c.passed ? (c.severity === 'info' ? 'info' : 'pass') : c.severity === 'error' ? 'fail' : 'warn';
    const sym = c.passed ? (c.severity === 'info' ? 'i' : '&#10003;') : c.severity === 'error' ? '&#10005;' : '!';
    return `<div class="check"><span class="ic ${cls}">${sym}</span><div><b>${esc(c.name)}</b> <span class="faint mono">${esc(c.dataset)}</span>${c.detail ? `<div class="muted">${esc(c.detail)}</div>` : ''}</div><div class="faint" style="text-align:right">${pill(c.severity === 'error' ? 'error' : c.severity === 'warning' ? 'warning' : '', c.severity)}<div>failed ${fmt(c.failed)} / ${fmt(c.total)}</div><div>threshold ${esc(c.threshold)}</div></div></div>`;
  }).join('');
}

function sampleTable(rows, max = 12) {
  if (!rows?.length) return '<div class="empty">No rows</div>';
  const cols = Object.keys(rows[0]);
  return `<div class="scroll"><table class="t"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, max).map((r) => `<tr>${cols.map((c) => `<td class="${typeof r[c] === 'number' ? 'num' : ''}">${esc(typeof r[c] === 'number' ? (Number.isInteger(r[c]) ? r[c] : r[c].toFixed(2)) : r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function onboardingTabs(a) {
  const p = a.payload;
  const prof = p.profile;
  const pv = p.preview;
  const profByCol = Object.fromEntries(prof.columns.map((c) => [c.name, c]));
  return [
    { label: 'Schema mapping', html: () => `
      <div class="callout mb">${esc(p.mapping.summary)}${p.mapping.assumptions?.length ? `<div class="faint mt" style="margin-top:6px">Assumptions: ${esc(p.mapping.assumptions.join(' '))}</div>` : ''}</div>
      <div class="row mb"><span class="muted">Target</span><b class="mono">${esc(p.targets.silver)}</b><span class="muted">Business key</span><b class="mono">${esc(p.mapping.business_key.join(', '))}</b><span class="muted">Domain</span>${pill('', p.mapping.domain)}</div>
      <div class="scroll" style="max-height:560px"><table class="t"><thead><tr><th>Source column</th><th>Profile</th><th></th><th>Silver column</th><th>Role</th><th>Transform</th><th>Rationale</th></tr></thead><tbody>
      ${p.mapping.columns.map((c) => { const pc = profByCol[c.source_column] || {}; return `<tr><td class="mono"><b>${esc(c.source_column)}</b></td><td class="faint">${esc((pc.samples || []).slice(0, 3).join(', '))}<br>${pc.null_pct ?? 0}% empty &middot; ${fmt(pc.distinct)} distinct</td><td class="arrow">&rarr;</td><td class="mono"><b>${esc(c.target_column)}</b>${c.pii ? ' ' + pill('error', 'PII') : ''}</td><td>${pill('', c.role)}</td><td class="mono">${esc(c.transform)}</td><td class="muted">${esc(c.description)}</td></tr>`; }).join('')}
      </tbody></table></div>` },
    { label: 'Source profile', html: () => `
      <div class="row mb"><span class="muted">Table</span><b class="mono">${esc(prof.table)}</b><span class="muted">Rows</span><b>${fmt(prof.row_count)}</b><span class="muted">Exact duplicate rows</span><b>${fmt(prof.exact_duplicate_rows)}</b></div>
      <div class="scroll" style="max-height:560px"><table class="t"><thead><tr><th>Column</th><th class="num">Empty %</th><th class="num">Distinct</th><th class="num">Unique ratio</th><th>Detected patterns</th><th>Top values</th></tr></thead><tbody>
      ${prof.columns.map((c) => `<tr><td class="mono"><b>${esc(c.name)}</b></td><td class="num">${c.null_pct}</td><td class="num">${fmt(c.distinct)}</td><td class="num">${c.unique_ratio}</td><td>${Object.entries(c.patterns).map(([k, v]) => pill('', `${k} ${v}%`)).join(' ') || '<span class="faint">free text</span>'}</td><td class="faint">${c.top_values.slice(0, 4).map((t) => `${esc(t.value ?? '<empty>')} (${t.n})`).join(', ')}</td></tr>`).join('')}
      </tbody></table></div>` },
    { label: 'Pipelines (SQL)', html: () => `
      <p class="muted" style="margin-top:0">Compiled from the mapping using the platform conventions. This exact SQL runs on approval.</p>
      <h3>Bronze &middot; ${esc(p.targets.bronze)}</h3><pre class="sql">${highlightSql(p.sql.bronze)}</pre>
      <h3 class="mt">Silver &middot; ${esc(p.targets.silver)}</h3><pre class="sql">${highlightSql(p.sql.silver)}</pre>
      <h3 class="mt">Quarantine &middot; ${esc(p.targets.quarantine)}</h3><pre class="sql">${highlightSql(p.sql.quarantine)}</pre>` },
    { label: `Data quality (${pv.checks.filter((c) => !c.passed).length} flagged)`, html: () => `
      <div class="grid g4 mb">${[['Source rows', pv.counts.source], ['Silver rows', pv.counts.silver], ['Quarantined', pv.counts.quarantine], ['Duplicates removed', pv.counts.duplicates_removed]].map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${fmt(v)}</div></div>`).join('')}</div>
      ${checksHtml(pv.checks)}
      ${pv.quarantineReasons?.length ? `<h3 class="mt">Quarantine reasons</h3>${sampleTable(pv.quarantineReasons)}` : ''}` },
    { label: `Part mapping (${pv.exceptions.length} exceptions)`, html: () => `
      ${pv.mappingStats?.length ? `<div class="grid g4 mb">${pv.mappingStats.map((s) => `<div class="card kpi" style="border-left-color:${s.status === 'unmapped' ? 'var(--red)' : 'var(--green)'}"><div class="l">${esc(s.status)}</div><div class="v">${fmt(s.n)}</div></div>`).join('')}</div>
      <p class="muted">Part numbers are cleaned (prefixes such as AT-, revision suffixes, spaces), resolved through supersession and matched to <span class="mono">silver.product_hierarchy</span>. Exceptions are flagged here rather than guessed.</p>
      ${pv.exceptions.length ? `<div class="scroll"><table class="t"><thead><tr><th>Standardised value</th><th>Raw values seen</th><th class="num">Rows</th><th>Reason</th><th>Suggested part</th></tr></thead><tbody>${pv.exceptions.map((e) => `<tr><td class="mono">${esc(e.normalized ?? '<blank>')}</td><td class="mono faint">${esc(e.raw_values)}</td><td class="num">${fmt(e.row_count)}</td><td>${esc(e.reason)}</td><td class="mono">${e.suggestion ? `<b>${esc(e.suggestion)}</b>` : '<span class="faint">-</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="callout ok">All part numbers mapped.</div>'}`
      : '<div class="empty">No part-number column in this source.</div>'}` },
    { label: 'Sample output', html: () => `<p class="muted" style="margin-top:0">Rows from the dry-run Silver table (rolled back - not yet live).</p>${sampleTable(pv.sample)}` },
  ];
}

function reportTabs(a) {
  const p = a.payload;
  const s = p.spec;
  const pv = p.preview;
  return [
    { label: 'Preview dashboard', html: () => `<p class="muted" style="margin-top:0">Built from a dry run. Publishes to the portal and as a one-page PDF on approval.</p><div id="dash"></div>`, after: (el) => drawDashboard($('#dash', el), pv.data, s) },
    { label: 'Requirement breakdown', html: () => `
      <div class="callout mb">&ldquo;${esc(p.request_text)}&rdquo;</div>
      <dl class="kv">
        <dt>Measures</dt><dd>${s.measures.map((m) => pill('report', m)).join(' ')}</dd>
        <dt>Dimensions</dt><dd>${s.dimensions.map((d) => pill('', DIM_LABEL[d] || d)).join(' ')}</dd>
        <dt>Breakdown</dt><dd>${s.breakdown_dimension !== 'none' ? pill('', DIM_LABEL[s.breakdown_dimension]) : '<span class="faint">none</span>'}</dd>
        <dt>Period</dt><dd>${esc(s.date_from)} to ${esc(s.date_to)}</dd>
        <dt>Chart</dt><dd>${esc(s.chart)}</dd>
        <dt>Assumptions</dt><dd>${(s.assumptions || []).map((x) => `<div>${esc(x)}</div>`).join('')}${(p.warnings || []).map((w) => `<div style="color:var(--amber)">${esc(w)}</div>`).join('')}</dd>
      </dl>` },
    { label: 'Gold plan', html: () => `
      <div class="grid g2">
        <div><h3>Reused Gold tables</h3>${p.plan.reuse.length ? p.plan.reuse.map((f) => `<div class="row" style="margin-bottom:6px">${pill('passed', 'reuse')}<span class="mono">${esc(f)}</span></div>`).join('') : '<span class="faint">none</span>'}
          <h3 class="mt">Reused measures</h3>${p.measures_reused.length ? p.measures_reused.map((m) => pill('', m)).join(' ') : '<span class="faint">none</span>'}</div>
        <div><h3>New Gold tables</h3>${p.plan.build.map((b) => `<div class="row" style="margin-bottom:6px">${pill('warning', 'build')}<span class="mono">${esc(b.fact)}</span><span class="faint">from ${esc(b.from)}</span></div>`).join('')}<div class="row">${pill('warning', 'build')}<span class="mono">${esc(p.table)}</span><span class="faint">report mart</span></div>
          <h3 class="mt">New measures</h3>${p.measures_new.length ? `<table class="t"><tbody>${p.measures_new.map((m) => `<tr><td class="mono">${esc(m.name)}</td><td class="muted">${esc(m.definition)}</td></tr>`).join('')}</tbody></table>` : '<span class="faint">none</span>'}</div>
      </div>` },
    { label: `Reconciliation ${pv.reconciliation.passed ? '✓' : '✗'}`, html: () => reconHtml(pv.reconciliation) },
    { label: 'SQL', html: () => `${Object.entries(p.sql.facts).map(([f, sql]) => `<h3>${esc(f)}</h3><pre class="sql">${highlightSql(sql)}</pre>`).join('<div class="mt"></div>')}<h3 class="mt">${esc(p.table)}</h3><pre class="sql">${highlightSql(p.sql.mart)}</pre>` },
    { label: 'Data quality', html: () => checksHtml(pv.checks) },
  ];
}

function reconHtml(rec) {
  return `<div class="callout ${rec.passed ? 'ok' : 'bad'} mb">${rec.passed ? 'Every report total matches the value recomputed directly from the source system.' : 'At least one total does not match source - see below.'} Tolerance: ${esc(rec.tolerance)}. Period ${esc(rec.period[0])} to ${esc(rec.period[1])}.</div>
  <table class="t recon"><thead><tr><th>Measure</th><th class="num">Source system</th><th class="num">Gold fact</th><th class="num">Report</th><th class="num">Difference</th><th></th></tr></thead><tbody>
  ${rec.lines.map((l) => `<tr><td><b>${esc(l.label)}</b><div class="faint">${esc(l.rule)}</div></td><td class="num">${fmt(l.source, l.format)}</td><td class="num">${fmt(l.gold, l.format)}</td><td class="num">${fmt(l.report, l.format)}</td><td class="num">${fmt(l.difference, l.format === 'int' ? 'int' : 'dec')}</td><td class="${l.passed ? 'ok' : 'bad'}">${l.passed ? '&#10003; match' : '&#10005; variance'}</td></tr>`).join('')}
  </tbody></table>`;
}

function alertTabs(a) {
  const p = a.payload;
  const s = p.spec;
  return [
    { label: 'Rule', html: () => `
      <div class="callout mb">&ldquo;${esc(p.request_text)}&rdquo;</div>
      <dl class="kv"><dt>Name</dt><dd>${esc(s.name)}</dd><dt>Measure</dt><dd>${pill('report', s.measure)}</dd><dt>Per</dt><dd>${s.dimension === 'none' ? 'overall' : esc(DIM_LABEL[s.dimension])}</dd><dt>Grain</dt><dd>${esc(s.grain)}</dd>
      <dt>Condition</dt><dd>${s.condition === 'pct_increase_gt' ? `month-over-month increase &gt; ${esc(s.threshold)}%` : `monthly value &gt; ${fmt(s.threshold)}`}</dd><dt>Back-test window</dt><dd>${esc(s.lookback_months)} months</dd><dt>Source fact</dt><dd class="mono">${esc(p.fact)}</dd>
      <dt>Assumptions</dt><dd>${(s.assumptions || []).map(esc).join('<br>')}</dd></dl>` },
    { label: `Back-test (${p.preview.triggered_count} triggers)`, html: () => alertRows(p.preview.rows) },
    { label: 'SQL', html: () => `<pre class="sql">${highlightSql(p.sql)}</pre>` },
  ];
}

function alertRows(allRows) {
  const rows = [...allRows.filter((r) => r.triggered), ...allRows.filter((r) => !r.triggered)];
  const trig = rows.filter((r) => r.triggered);
  return `${trig.length ? `<div class="callout warn mb">${trig.length} trigger(s) in the window.</div>` : '<div class="callout ok mb">No triggers in the window.</div>'}
  <div class="scroll"><table class="t"><thead><tr><th>Month</th><th>Member</th><th class="num">Value</th><th class="num">Previous</th><th class="num">Change %</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr style="${r.triggered ? 'background:#fff7ed' : ''}"><td>${esc(r.month)}</td><td>${esc(r.member)}</td><td class="num">${fmt(r.value, 'dec')}</td><td class="num">${fmt(r.previous, 'dec')}</td><td class="num">${r.pct_change === null ? '-' : esc(r.pct_change)}</td><td>${r.triggered ? pill('TRIGGERED', 'triggered') : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- Dashboards ----------
function drawDashboard(el, data, spec, opts = {}) {
  const ms = data.measures;
  let current = ms[0].name;
  el.innerHTML = `
    <div class="grid ${ms.length >= 4 ? 'g4' : ms.length === 3 ? 'g3' : 'g2'}">${data.kpis.map((k, i) => `<div class="card kpi" style="border-left-color:${SERIES[i]}"><div class="l">${esc(k.label)}</div><div class="v">${fmt(k.value, k.format, true)}</div></div>`).join('')}</div>
    ${ms.length > 1 ? `<div class="row mt"><span class="muted">Chart measure</span><select id="mSel" style="width:auto">${ms.map((m) => `<option value="${esc(m.name)}">${esc(m.label)}</option>`).join('')}</select></div>` : ''}
    <div class="grid mt">
      ${data.time ? `<div class="card"><h2 id="tTitle"></h2><div id="tChart"></div></div>` : ''}
      ${data.breakdown ? `<div class="card"><h2 id="bTitle"></h2><div id="bChart"></div></div>` : ''}
    </div>
    <div class="card mt"><h2>Detail</h2><div class="scroll" style="max-height:${opts.tableHeight || 320}px"><table class="t"><thead><tr>${data.table.columns.map((c) => `<th class="${ms.some((m) => m.name === c) ? 'num' : ''}">${esc(DIM_LABEL[c] || ms.find((m) => m.name === c)?.label || c)}</th>`).join('')}</tr></thead><tbody>
      ${data.table.rows.map((r) => `<tr>${data.table.columns.map((c) => { const m = ms.find((x) => x.name === c); return `<td class="${m ? 'num' : ''}">${m ? fmt(r[c], m.format) : esc(r[c])}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div></div>`;
  const redraw = () => {
    const m = ms.find((x) => x.name === current);
    if (data.time) {
      $('#tTitle', el).textContent = `${m.label} by ${DIM_LABEL[data.time.dim].toLowerCase()}${data.time.series_dim ? ` and ${DIM_LABEL[data.time.series_dim].toLowerCase()}` : ''}`;
      lineChart($('#tChart', el), data.time.rows, m);
    }
    if (data.breakdown) {
      $('#bTitle', el).textContent = `${m.label} by ${DIM_LABEL[data.breakdown.dim].toLowerCase()}`;
      barChart($('#bChart', el), data.breakdown.rows, m);
    }
  };
  $('#mSel', el)?.addEventListener('change', (e) => { current = e.target.value; redraw(); });
  redraw();
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function lineChart(el, rows, m) {
  const ts = [...new Set(rows.map((r) => r.t))].sort();
  const totals = {};
  rows.forEach((r) => { totals[r.s] = (totals[r.s] || 0) + Math.abs(Number(r[m.name]) || 0); });
  const series = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 8);
  const W = Math.max(el.clientWidth || 640, 360), H = Math.round(Math.min(Math.max(W * 0.36, 240), 340)), L = 62, R = 14, T = 10, B = 30;
  const vals = rows.filter((r) => series.includes(r.s)).map((r) => Number(r[m.name]) || 0);
  const max = niceMax(Math.max(...vals, 0));
  const x = (i) => L + (ts.length > 1 ? (i * (W - L - R)) / (ts.length - 1) : (W - L - R) / 2);
  const y = (v) => T + (H - T - B) - ((H - T - B) * (Number(v) || 0)) / max;
  let svg = '';
  for (let i = 0; i <= 4; i++) { const yy = y((max * i) / 4); svg += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${i ? '#eef1f5' : '#d9dee7'}"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end">${esc(fmt((max * i) / 4, m.format, true))}</text>`; }
  const step = Math.ceil(ts.length / 10);
  ts.forEach((t, i) => { if (i % step === 0) svg += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${esc(t)}</text>`; });
  series.forEach((s, si) => {
    const pts = ts.map((t, i) => { const r = rows.find((rr) => rr.t === t && rr.s === s); return r ? [x(i), y(r[m.name]), r[m.name], t] : null; }).filter(Boolean);
    svg += `<polyline fill="none" stroke="${SERIES[si]}" stroke-width="2.2" points="${pts.map((p) => `${p[0]},${p[1]}`).join(' ')}"/>`;
    pts.forEach((p) => { svg += `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${SERIES[si]}"><title>${esc(s)} ${esc(p[3])}: ${esc(fmt(p[2], m.format))}</title></circle>`; });
  });
  el.innerHTML = `<div class="legend">${series.map((s, i) => `<span style="--c:${SERIES[i]}">${esc(s)}</span>`).join('')}</div><svg class="chart" viewBox="0 0 ${W} ${H}">${svg}</svg>`;
}

function barChart(el, rows, m) {
  const data = rows.slice(0, 12);
  const W = Math.max(el.clientWidth || 640, 360), rowH = 26, L = Math.min(190, W * 0.32), R = 80;
  const H = data.length * rowH + 10;
  const max = niceMax(Math.max(...data.map((r) => Number(r[m.name]) || 0), 0));
  let svg = '';
  data.forEach((r, i) => {
    const yy = 5 + i * rowH;
    const w = ((W - L - R) * Math.max(Number(r[m.name]) || 0, 0)) / max;
    const label = String(r.k ?? '-');
    svg += `<text x="${L - 8}" y="${yy + 16}" text-anchor="end" style="fill:var(--ink)">${esc(label.length > 26 ? label.slice(0, 25) + '...' : label)}</text>
      <rect x="${L}" y="${yy + 4}" width="${Math.max(w, 1)}" height="${rowH - 9}" rx="3" fill="${SERIES[0]}"><title>${esc(label)}: ${esc(fmt(r[m.name], m.format))}</title></rect>
      <text x="${L + w + 6}" y="${yy + 16}">${esc(fmt(r[m.name], m.format, true))}</text>`;
  });
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}">${svg}</svg>${rows.length > 12 ? `<div class="faint">Top 12 of ${rows.length}</div>` : ''}`;
}

async function renderReports() {
  const reps = await api('/api/reports');
  view.innerHTML = `
  <div class="page-head"><div><h1>Reports</h1><p>Approved, published dashboards. Each one reconciles to source and has a one-page PDF.</p></div><a class="btn primary" href="#/ask">New report request</a></div>
  ${reps.length ? `<div class="grid g3">${reps.map((r) => `<div class="card report-card" data-id="${esc(r.id)}">
      <div class="row">${pill('report', r.id)}${pill(r.reconciliation.passed ? 'passed' : 'failed', r.reconciliation.passed ? 'reconciled' : 'variance')}</div>
      <h2 style="margin-top:10px">${esc(r.title)}</h2>
      <div class="faint">${esc(r.spec.date_from)} to ${esc(r.spec.date_to)} &middot; published ${when(r.published_at)}</div>
      <div class="faint mono" style="margin-top:6px">${esc(r.dataset)}</div></div>`).join('')}</div>`
    : '<div class="card empty">No reports yet. Ask a business question on the Ask page; once approved it appears here.</div>'}`;
  document.querySelectorAll('.report-card').forEach((c) => c.addEventListener('click', () => { location.hash = `#/report/${c.dataset.id}`; }));
}

async function renderReport(id) {
  const r = await api(`/api/reports/${encodeURIComponent(id)}`);
  view.innerHTML = `
  <div class="page-head"><div>
    <div class="row" style="margin-bottom:6px"><a href="#/reports">&larr; Reports</a><span class="faint">${esc(r.id)}</span>${pill(r.reconciliation.passed ? 'passed' : 'failed', r.reconciliation.passed ? 'Reconciled to source' : 'Variance')}</div>
    <h1>${esc(r.title)}</h1><p>${esc(r.spec.date_from)} to ${esc(r.spec.date_to)} &middot; approved by ${esc(r.approval.reviewer || '-')} on ${when(r.approval.decided_at)} &middot; ${esc(r.approval.engine || '')}</p>
  </div><div class="row"><a class="btn" href="/api/reports/${esc(r.id)}/pdf" target="_blank">View PDF</a><a class="btn primary" href="/api/reports/${esc(r.id)}/pdf?download=1">Download PDF</a></div></div>
  <div id="dash"></div>
  <div class="grid g2 mt">
    <div class="card"><h2>Reconciliation to source</h2>${reconHtml(r.reconciliation)}</div>
    <div class="card"><h2>Lineage</h2><p class="muted mono" style="line-height:1.8">${esc(r.lineage).replace(/ {2}-&gt; {2}/g, '<br>&darr;<br>')}</p><a class="btn sm" href="#/lineage/${encodeURIComponent('report:' + r.id)}">Open lineage graph</a> <a class="btn sm" href="#/dataset/${esc(r.dataset)}">Report mart in catalog</a></div>
  </div>`;
  drawDashboard($('#dash'), r.data, r.spec, { tableHeight: 380 });
}

// ---------- Catalog ----------
async function renderCatalog() {
  const cat = await api('/api/catalog');
  const layers = ['source', 'bronze', 'silver', 'gold'];
  view.innerHTML = `
  <div class="page-head"><div><h1>Catalog</h1><p>Every dataset on the reference platform: source systems, Bronze, Silver and Gold, with owner, data-quality status and lineage.</p></div>
  <input type="text" id="catQ" placeholder="Filter datasets..." style="max-width:280px"></div>
  ${layers.map((l) => { const items = cat.filter((d) => d.layer === l); return `<div class="card cat-layer"><h2>${pill('layer-' + l, l)} <span class="faint">${items.length} dataset(s)</span></h2>
    <table class="t"><thead><tr><th>Dataset</th><th>Description</th><th class="num">Rows</th><th>Owner</th><th>DQ</th><th>Tags</th></tr></thead><tbody>
    ${items.map((d) => `<tr class="click" data-ds="${esc(d.dataset)}" data-q="${esc((d.dataset + ' ' + d.title + ' ' + d.description + ' ' + d.tags.join(' ')).toLowerCase())}"><td class="mono"><b>${esc(d.dataset)}</b><div class="faint" style="font-family:inherit">${esc(d.title)}</div></td><td class="muted">${esc(d.description)}</td><td class="num">${fmt(d.row_count)}</td><td class="faint">${esc(d.owner)}</td><td>${pill(d.dq_status === 'passed' ? 'passed' : d.dq_status?.includes('warn') ? 'warning' : '', d.dq_status)}</td><td>${d.tags.map((t) => pill(t === 'not onboarded' ? 'needs_input' : t.includes('portal') ? 'onboarding' : '', t)).join(' ')}</td></tr>`).join('')}
    </tbody></table></div>`; }).join('')}`;
  document.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/dataset/${tr.dataset.ds}`; }));
  $('#catQ').addEventListener('input', (e) => { const v = e.target.value.toLowerCase(); document.querySelectorAll('tr[data-q]').forEach((tr) => { tr.style.display = tr.dataset.q.includes(v) ? '' : 'none'; }); });
}

async function renderDataset(name) {
  const d = await api(`/api/catalog/${encodeURIComponent(name)}`);
  view.innerHTML = `
  <div class="page-head"><div>
    <div class="row" style="margin-bottom:6px"><a href="#/catalog">&larr; Catalog</a>${pill('layer-' + d.layer, d.layer)}${d.artifact_id ? `<a class="pill onboarding" href="#/artifact/${esc(d.artifact_id)}">from ${esc(d.artifact_id)}</a>` : ''}</div>
    <h1 class="mono" style="font-size:20px">${esc(d.dataset)}</h1><p>${esc(d.description)}</p>
  </div></div>
  <div class="grid g4 mb">${[['Rows', fmt(d.row_count)], ['Owner', esc(d.owner)], ['Source system', esc(d.source_system)], ['Data quality', pill(d.dq_status === 'passed' ? 'passed' : d.dq_status?.includes('warn') ? 'warning' : '', d.dq_status)]].map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v" style="font-size:18px">${v}</div></div>`).join('')}</div>
  <div class="card"><h2>Lineage</h2><div id="lin"></div></div>
  <div class="card"><h2>Columns</h2><table class="t"><thead><tr><th>Column</th><th>Type</th><th>Role</th><th>From</th><th>Description</th></tr></thead><tbody>
    ${d.columns.map((c) => `<tr><td class="mono"><b>${esc(c.name)}</b>${c.pii ? ' ' + pill('error', 'PII hashed') : ''}</td><td class="mono faint">${esc(c.type)}</td><td>${c.role ? pill('', c.role) : ''}</td><td class="mono faint">${esc(c.source_column ? `${c.source_column} (${c.transform})` : '')}</td><td class="muted">${esc(c.description || '')}</td></tr>`).join('')}
  </tbody></table></div>
  ${d.dq.length ? `<div class="card"><h2>Latest data-quality run</h2>${checksHtml(d.dq.map((c) => ({ ...c, name: c.check_name })))}</div>` : ''}
  ${d.exceptions.length ? `<div class="card"><h2>Open part-number exceptions</h2><div class="scroll"><table class="t"><thead><tr><th>Standardised</th><th>Raw values</th><th class="num">Rows</th><th>Reason</th><th>Suggestion</th></tr></thead><tbody>${d.exceptions.map((e) => `<tr><td class="mono">${esc(e.normalized ?? '<blank>')}</td><td class="mono faint">${esc(e.raw_value)}</td><td class="num">${fmt(e.row_count)}</td><td>${esc(e.reason)}</td><td class="mono">${esc(e.suggestion || '-')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
  <div class="card"><h2>Sample rows</h2>${sampleTable(d.sample, 15)}</div>`;
  lineageSvg($('#lin'), d.lineage, d.dataset);
}

// ---------- Lineage ----------
const LAYERS = [['src_', 'Source'], ['bronze.', 'Bronze'], ['silver.', 'Silver'], ['gold.', 'Gold'], ['report:', 'Report']];
function lineageSvg(el, g, focus) {
  if (!g.nodes.length) { el.innerHTML = '<div class="empty">No lineage recorded.</div>'; return; }
  const cols = LAYERS.map(() => []);
  g.nodes.forEach((n) => { const i = LAYERS.findIndex(([p]) => n.startsWith(p)); cols[i < 0 ? 0 : i].push(n); });
  cols.forEach((c) => c.sort());
  const NW = 196, NH = 30, GX = 44, GY = 12, TOP = 30;
  const used = cols.map((c, i) => [c, i]).filter(([c]) => c.length);
  const pos = {};
  used.forEach(([c], ci) => c.forEach((n, ri) => { pos[n] = { x: 10 + ci * (NW + GX), y: TOP + ri * (NH + GY) }; }));
  const W = 20 + used.length * (NW + GX) - GX;
  const H = TOP + Math.max(...used.map(([c]) => c.length)) * (NH + GY) + 10;
  let svg = used.map(([, li], ci) => `<text class="col-title" x="${10 + ci * (NW + GX)}" y="16">${LAYERS[li][1]}</text>`).join('');
  g.edges.forEach((e) => {
    const a = pos[e.from_node], b = pos[e.to_node];
    if (!a || !b) return;
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    svg += `<path class="edge" d="M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}"><title>${esc(e.transform)}</title></path>`;
  });
  Object.entries(pos).forEach(([n, p]) => {
    const label = n.length > 29 ? n.slice(0, 28) + '...' : n;
    svg += `<g class="node ${n === focus ? 'focus' : ''}" data-n="${esc(n)}"><rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="6"/><text x="${p.x + 10}" y="${p.y + 19}">${esc(label)}</text><title>${esc(n)}</title></g>`;
  });
  el.innerHTML = `<div class="lineage-wrap"><svg class="lineage" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg></div>`;
  el.querySelectorAll('.node').forEach((nd) => nd.addEventListener('click', () => {
    const n = nd.dataset.n;
    location.hash = n.startsWith('report:') ? `#/report/${n.slice(7)}` : `#/dataset/${n}`;
  }));
}

async function renderLineage(node) {
  const g = await api(`/api/lineage${node ? `?node=${encodeURIComponent(node)}` : ''}`);
  view.innerHTML = `
  <div class="page-head"><div><h1>Lineage</h1><p>${node ? `Upstream and downstream of <span class="mono">${esc(node)}</span>.` : 'All recorded data flows on the platform, from source systems to published reports.'} Click a node to open it.</p></div>${node ? '<a class="btn" href="#/lineage">Show everything</a>' : ''}</div>
  <div class="card"><div id="lin"></div></div>`;
  lineageSvg($('#lin'), g, node);
}

// ---------- Alerts ----------
async function renderAlerts() {
  const alerts = await api('/api/alerts');
  view.innerHTML = `
  <div class="page-head"><div><h1>Alerts</h1><p>Thin slice of use case 3: plain-English alert rules over Gold facts, approved before activation, evaluated on demand.</p></div><a class="btn primary" href="#/ask">New alert request</a></div>
  ${alerts.length ? alerts.map((a) => `<div class="card" data-id="${esc(a.id)}">
    <div class="row">${pill('alert', a.id)}${pill(a.last_result?.status || '', a.last_result?.status || 'not evaluated')}<b>${esc(a.name)}</b><span class="spacer"></span><span class="faint">evaluated ${when(a.last_evaluated_at)}</span><button class="btn sm eval">Evaluate now</button></div>
    <div class="mt alert-rows">${a.last_result ? alertRows(a.last_result.rows) : ''}</div></div>`).join('')
    : '<div class="card empty">No alerts yet. Try: "Alert me when monthly warranty cost for any product line rises more than 50% month over month".</div>'}`;
  document.querySelectorAll('.eval').forEach((b) => b.addEventListener('click', async (e) => {
    const card = e.target.closest('.card');
    b.disabled = true;
    try { await api(`/api/alerts/${card.dataset.id}/evaluate`, { method: 'POST' }); toast('Alert evaluated'); renderAlerts(); }
    catch (err) { toast(err.message, true); b.disabled = false; }
  }));
}

// ---------- Audit ----------
async function renderAudit() {
  const rows = await api('/api/audit');
  view.innerHTML = `
  <div class="page-head"><div><h1>Audit trail</h1><p>Who asked for what, what was generated, who approved it, and what was deployed.</p></div></div>
  <div class="card"><table class="t"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Detail</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td class="faint">${when(r.ts)}</td><td>${esc(r.actor)}</td><td class="mono">${esc(r.action)}</td><td class="mono">${esc(r.object)}</td><td class="muted">${esc(r.detail)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- About ----------
async function renderAbout() {
  const [conv, measures] = await Promise.all([api('/api/conventions'), api('/api/measures')]);
  const e = STATUS?.engine || {};
  view.innerHTML = `
  <div class="page-head"><div><h1>Conventions &amp; setup</h1><p>The rules generated code must follow, the registered semantic layer, and demo controls.</p></div></div>
  <div class="grid g2">
    <div class="card"><h2>AI engine</h2>
      <p>${e.mode === 'claude' ? `Using <b>${esc(e.label)}</b> (<span class="mono">${esc(e.model)}</span>) with schema-constrained outputs. Every proposal is validated against the platform vocabulary before code is compiled; if a call fails, the rule-based engine takes over and the artifact says so.` : 'Running the <b>rule-based engine</b> (offline mode). Set <span class="mono">ANTHROPIC_API_KEY</span> and restart to use Claude for intake, schema mapping, requirement breakdown and alert rules.'}</p>
      <p class="muted">${esc(conv.note)}</p>
      <h2 class="mt">Demo controls</h2>
      <p class="muted">Rebuild the reference platform with fresh synthetic data. This clears all requests, approvals, reports and alerts.</p>
      <button class="btn bad" id="resetBtn">Reset demo data</button>
    </div>
    <div class="card"><h2>${esc(conv.name)}</h2>
      ${Object.entries(conv.layers).map(([k, l]) => `<h3 class="mt">${pill('layer-' + k, k)} <span class="mono" style="text-transform:none">${esc(l.schema)}.${esc(l.table_pattern)}</span></h3><ul style="margin:6px 0 0;padding-left:18px">${l.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`).join('')}
      <h3 class="mt">Data quality defaults</h3><div>${conv.data_quality.default_checks.map((c) => pill('', c)).join(' ')}</div>
    </div>
  </div>
  <div class="card mt"><h2>Registered measures (semantic layer)</h2><table class="t"><thead><tr><th>Measure</th><th>Kind</th><th>Definition</th><th>Source</th><th>Registered by</th></tr></thead><tbody>
    ${measures.map((m) => `<tr><td class="mono"><b>${esc(m.name)}</b><div class="faint" style="font-family:inherit">${esc(m.label)}</div></td><td>${pill('', m.kind)}</td><td class="muted">${esc(m.definition)}</td><td class="mono faint">${esc(m.kind === 'base' ? `${m.expression} on ${m.fact_table}` : `${m.numerator} / ${m.denominator} x ${m.multiplier}`)}</td><td>${m.artifact_id ? `<a href="#/artifact/${esc(m.artifact_id)}">${esc(m.artifact_id)}</a>` : '<span class="faint">platform</span>'}</td></tr>`).join('')}
  </tbody></table></div>`;
  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset all demo data? Requests, approvals, reports and alerts will be cleared.')) return;
    try { await api('/api/reset', { method: 'POST' }); toast('Demo data reset'); location.hash = '#/ask'; router(); }
    catch (err) { toast(err.message, true); }
  });
}

refreshStatus().then(router);
