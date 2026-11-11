// One-page PDF version of a published report (vector chart, KPIs, breakdown, reconciliation, lineage).
import PDFDocument from 'pdfkit';
import { DIMENSIONS } from './semantic.js';

const NAVY = '#1F3A5F';
const INK = '#1d2433';
const MUTED = '#5b6474';
const RULE = '#d9dee7';
const SERIES = ['#2a6fdb', '#e07a1f', '#2f9e6e', '#b8418a', '#7a5af5', '#c9a227', '#3fa7c4', '#8c8c8c'];

export function fmt(v, format, compact = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const n = Number(v);
  if (format === 'usd') {
    if (compact && Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (compact && Math.abs(n) >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toLocaleString('en-US', { maximumFractionDigits: compact ? 0 : 2, minimumFractionDigits: compact ? 0 : 2 })}`;
  }
  if (format === 'pct') return `${n.toFixed(2)}%`;
  if (format === 'dec') return n.toFixed(2);
  return Math.round(n).toLocaleString('en-US');
}

export function renderReportPdf({ report, data, approval }) {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 32, info: { Title: report.title, Author: 'AI Engineering Workflow Portal (POC)' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width;
  const M = 32;
  const spec = report.spec;

  // Header band
  doc.rect(0, 0, W, 58).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(report.title.length > 70 ? 12 : report.title.length > 55 ? 14 : 16).text(report.title, M, 14, { width: W - 2 * M - 200, height: 22, ellipsis: true });
  doc.font('Helvetica').fontSize(9).fillColor('#c8d3e6')
    .text(`Period ${spec.date_from} to ${spec.date_to}   |   Report ${report.id}   |   Published ${String(report.published_at).slice(0, 16)}`, M, 36);
  doc.fillColor('#ffffff').fontSize(8).text('AI Engineering Workflow Portal', W - M - 200, 18, { width: 200, align: 'right' })
    .fillColor('#c8d3e6').text('Proof of concept - synthetic data', W - M - 200, 30, { width: 200, align: 'right' });

  // KPI tiles
  let y = 72;
  const kpis = data.kpis.slice(0, 4);
  const tileW = (W - 2 * M - (kpis.length - 1) * 10) / kpis.length;
  kpis.forEach((k, i) => {
    const x = M + i * (tileW + 10);
    doc.roundedRect(x, y, tileW, 52, 4).lineWidth(0.8).strokeColor(RULE).stroke();
    doc.rect(x, y, 3, 52).fill(SERIES[i % SERIES.length]);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(k.label.toUpperCase(), x + 12, y + 9, { width: tileW - 20 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(fmt(k.value, k.format, true), x + 12, y + 22, { width: tileW - 20 });
  });
  y += 66;

  // Main chart (left) + breakdown table (right)
  const chartW = (W - 2 * M) * 0.6;
  const chartH = 250;
  const head = data.measures[0];
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10);
  const chart = spec.chart || 'line';
  if (chart === 'table') {
    doc.text('Detail', M, y);
    drawDetailTable(doc, data, M, y + 16, chartW, chartH - 16);
  } else if (data.time) {
    const dimLabel = DIMENSIONS[data.time.dim].label.toLowerCase();
    doc.text(`${head.label} by ${dimLabel}${data.time.series_dim ? ` and ${DIMENSIONS[data.time.series_dim].label.toLowerCase()}` : ''}`, M, y);
    if (chart === 'column' || chart === 'stacked_column') drawColumnChart(doc, data.time.rows, head, M, y + 16, chartW, chartH - 16, chart === 'stacked_column' && head.kind !== 'derived');
    else drawLineChart(doc, data.time.rows, head, M, y + 16, chartW, chartH - 16);
  } else if (data.breakdown) {
    doc.text(`${head.label} by ${DIMENSIONS[data.breakdown.dim].label.toLowerCase()}`, M, y);
    drawBarChart(doc, data.breakdown.rows.slice(0, 12), head, M, y + 16, chartW, chartH - 16);
  }

  const tx = M + chartW + 18;
  const tw = W - M - tx;
  if (data.breakdown) {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(`By ${DIMENSIONS[data.breakdown.dim].label.toLowerCase()}`, tx, y);
    const cols = [{ key: 'k', label: DIMENSIONS[data.breakdown.dim].label, w: tw * 0.4 }];
    const mw = (tw * 0.6) / Math.min(data.measures.length, 3);
    data.measures.slice(0, 3).forEach((m) => cols.push({ key: m.name, label: m.label, w: mw, format: m.format }));
    let ty = y + 18;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
    let cx = tx;
    cols.forEach((c, i) => { doc.text(c.label, cx, ty, { width: c.w - 4, align: i ? 'right' : 'left', height: 20 }); cx += c.w; });
    ty += 20;
    doc.moveTo(tx, ty - 3).lineTo(tx + tw, ty - 3).lineWidth(0.6).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    for (const r of data.breakdown.rows.slice(0, 12)) {
      cx = tx;
      cols.forEach((c, i) => { doc.text(i ? fmt(r[c.key], c.format, true) : String(r[c.key] ?? '-'), cx, ty, { width: c.w - 4, align: i ? 'right' : 'left', height: 11, ellipsis: true }); cx += c.w; });
      ty += 15;
    }
  }
  y += chartH + 14;

  // Footer: reconciliation + lineage + approval
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 8;
  const rec = report.reconciliation;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(rec.passed ? '#2f7d4f' : '#b42318')
    .text(`Reconciliation to source: ${rec.passed ? 'PASSED' : 'VARIANCE'}`, M, y);
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  let ry = y + 13;
  for (const l of rec.lines) {
    doc.text(`${l.label}: source ${fmt(l.source, l.format)}  ->  gold ${fmt(l.gold, l.format)}  ->  report ${fmt(l.report, l.format)}   (diff ${fmt(l.difference, l.format === 'int' ? 'int' : 'dec')}) ${l.passed ? 'OK' : 'CHECK'}`, M, ry, { width: (W - 2 * M) * 0.62 });
    ry += 11;
  }
  const lx = M + (W - 2 * M) * 0.64;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Lineage', lx, y);
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(approval.lineage, lx, y + 13, { width: W - M - lx });
  doc.text(`Approved by ${approval.reviewer || '-'} on ${approval.decidedAt ? String(approval.decidedAt).slice(0, 16) : '-'}. Generated by ${approval.engine}.`, lx, doc.y + 4, { width: W - M - lx });

  doc.end();
  return done;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function axes(doc, x, y, w, h, max, format) {
  doc.font('Helvetica').fontSize(7).fillColor(MUTED);
  for (let i = 0; i <= 4; i++) {
    const yy = y + h - (h * i) / 4;
    doc.moveTo(x + 44, yy).lineTo(x + w, yy).lineWidth(0.4).strokeColor(i ? '#eef1f5' : RULE).stroke();
    doc.text(fmt((max * i) / 4, format, true), x, yy - 4, { width: 40, align: 'right' });
  }
}

function drawLineChart(doc, rows, measure, x, y, w, h) {
  const ts = [...new Set(rows.map((r) => r.t))].sort();
  const totals = {};
  rows.forEach((r) => { totals[r.s] = (totals[r.s] || 0) + (Number(r[measure.name]) || 0); });
  const series = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 7);
  const legendH = 14;
  const ph = h - 18 - legendH;
  const max = niceMax(Math.max(...rows.filter((r) => series.includes(r.s)).map((r) => Number(r[measure.name]) || 0)));
  axes(doc, x, y + legendH, w, ph, max, measure.format);
  const px = (i) => x + 50 + (ts.length > 1 ? (i * (w - 56)) / (ts.length - 1) : (w - 56) / 2);
  const py = (v) => y + legendH + ph - (ph * (Number(v) || 0)) / max;
  series.forEach((s, si) => {
    const pts = ts.map((t, i) => { const r = rows.find((rr) => rr.t === t && rr.s === s); return r ? [px(i), py(r[measure.name])] : null; }).filter(Boolean);
    if (!pts.length) return;
    doc.lineWidth(1.6).strokeColor(SERIES[si % SERIES.length]);
    doc.moveTo(pts[0][0], pts[0][1]);
    pts.slice(1).forEach((p) => doc.lineTo(p[0], p[1]));
    doc.stroke();
    pts.forEach((p) => doc.circle(p[0], p[1], 1.6).fill(SERIES[si % SERIES.length]));
  });
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED);
  const step = Math.ceil(ts.length / 12);
  ts.forEach((t, i) => { if (i % step === 0) doc.text(String(t), px(i) - 20, y + legendH + ph + 4, { width: 40, align: 'center' }); });
  let lx = x + 50;
  series.forEach((s, si) => {
    doc.rect(lx, y + 2, 8, 6).fill(SERIES[si % SERIES.length]);
    doc.fillColor(INK).fontSize(7).text(s, lx + 11, y + 1, { lineBreak: false });
    lx += 16 + doc.widthOfString(s);
  });
}

function drawBarChart(doc, rows, measure, x, y, w, h) {
  const max = niceMax(Math.max(...rows.map((r) => Number(r[measure.name]) || 0)));
  const labelW = 120;
  const bh = Math.min(18, (h - 10) / Math.max(rows.length, 1) - 4);
  rows.forEach((r, i) => {
    const yy = y + 6 + i * (bh + 4);
    const bw = ((w - labelW - 70) * (Number(r[measure.name]) || 0)) / max;
    doc.font('Helvetica').fontSize(7.5).fillColor(INK).text(String(r.k ?? '-'), x, yy + bh / 2 - 4, { width: labelW - 6, align: 'right', height: 10, ellipsis: true });
    doc.rect(x + labelW, yy, Math.max(bw, 1), bh).fill(SERIES[0]);
    doc.fillColor(MUTED).fontSize(7).text(fmt(r[measure.name], measure.format, true), x + labelW + bw + 4, yy + bh / 2 - 4, { lineBreak: false });
  });
}

function legend(doc, series, x, y) {
  let lx = x + 50;
  doc.font('Helvetica').fontSize(7);
  series.forEach((s, si) => {
    doc.rect(lx, y + 2, 8, 6).fill(SERIES[si % SERIES.length]);
    doc.fillColor(INK).text(s, lx + 11, y + 1, { lineBreak: false });
    lx += 16 + doc.widthOfString(s);
  });
}

// Grouped or stacked columns per time period (stacking only for additive measures).
function drawColumnChart(doc, rows, measure, x, y, w, h, stacked) {
  const ts = [...new Set(rows.map((r) => r.t))].sort();
  const totals = {};
  rows.forEach((r) => { totals[r.s] = (totals[r.s] || 0) + (Number(r[measure.name]) || 0); });
  const series = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 7);
  const val = (t, s) => Number(rows.find((r) => r.t === t && r.s === s)?.[measure.name]) || 0;
  const legendH = 14;
  const ph = h - 18 - legendH;
  const peak = stacked ? Math.max(...ts.map((t) => series.reduce((a, s) => a + Math.max(val(t, s), 0), 0))) : Math.max(...ts.flatMap((t) => series.map((s) => val(t, s))));
  const max = niceMax(peak);
  axes(doc, x, y + legendH, w, ph, max, measure.format);
  const slot = (w - 56) / Math.max(ts.length, 1);
  const base = y + legendH + ph;
  ts.forEach((t, i) => {
    const sx = x + 50 + i * slot + slot * 0.15;
    const bw = slot * 0.7;
    let acc = 0;
    series.forEach((s, si) => {
      const v = Math.max(val(t, s), 0);
      const hh = (ph * v) / max;
      doc.fillColor(SERIES[si % SERIES.length]);
      if (stacked) { doc.rect(sx, base - acc - hh, bw, hh).fill(); acc += hh; }
      else { const gw = bw / series.length; doc.rect(sx + si * gw, base - hh, Math.max(gw - 0.5, 0.5), hh).fill(); }
    });
  });
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED);
  const step = Math.ceil(ts.length / 12);
  ts.forEach((t, i) => { if (i % step === 0) doc.text(String(t), x + 50 + i * slot + slot / 2 - 20, base + 4, { width: 40, align: 'center' }); });
  legend(doc, series, x, y);
}

function drawDetailTable(doc, data, x, y, w, h) {
  const ms = data.measures;
  const cols = data.table.columns;
  const cw = w / cols.length;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
  cols.forEach((c, i) => {
    const m = ms.find((mm) => mm.name === c);
    doc.text(m ? m.label : (DIMENSIONS[c]?.label || c), x + i * cw, y, { width: cw - 4, align: m ? 'right' : 'left', height: 20 });
  });
  let ty = y + 20;
  doc.moveTo(x, ty - 3).lineTo(x + w, ty - 3).lineWidth(0.6).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor(INK);
  const maxRows = Math.floor((h - 24) / 11);
  for (const r of data.table.rows.slice(0, maxRows)) {
    cols.forEach((c, i) => {
      const m = ms.find((mm) => mm.name === c);
      doc.text(m ? fmt(r[c], m.format, true) : String(r[c] ?? '-'), x + i * cw, ty, { width: cw - 4, align: m ? 'right' : 'left', height: 10, ellipsis: true });
    });
    ty += 11;
  }
  if (data.table.rows.length > maxRows) doc.fillColor(MUTED).fontSize(7).text(`First ${maxRows} of ${data.table.rows.length} rows - full detail in the portal`, x, ty + 2);
}
