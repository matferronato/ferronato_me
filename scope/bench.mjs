// bench.mjs — the main instrument: one screen, one spectrum, and every stage of
// the chain switchable from the panel beside it.

import {
  alias, evaluate, reconstruct, peakFrequency, verdict, samplesPerCycle,
  RESPONSE_LABEL, TWOTONE_RATIO,
  fmtFreq, fmtRate, fmtSec, fmtVolt, fmtPoints,
} from './dsp.mjs';
import { build, analogTrace, FULL_SCALE } from './model.mjs';
import { state, patch, subscribe, toSlider, fromSlider, PRESETS, DEFAULTS } from './state.mjs';
import {
  $, $$, colors, surface, mono, graticule, centreLine, strokeTrace, label,
  observeResize,
} from './ui.mjs';
import { fitWindow } from './chain.mjs';

const V_DIVS = 8;
const H_DIVS = 10;

const RECON_NOTE = {
  hold: 'Zero-order hold, what a plain DAC output looks like.',
  linear: 'Straight lines between points. Convenient, and it invents corners the signal never had.',
  sinc: 'Windowed sinc, the reconstruction the sampling theorem is written about.',
};

/* ------------------------------------------------------------------ *
 * Scope trace
 * ------------------------------------------------------------------ */

function drawScope(m) {
  const s = surface($('#scope'));
  if (!s) return;
  const { ctx, w, h } = s;
  const c = colors();
  const pad = { l: 8, r: 8, t: 8, b: 20 };
  const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
  const vPerDiv = (2 * FULL_SCALE) / V_DIVS;
  const yOf = (v) => box.y + box.h / 2 - (v / FULL_SCALE) * (box.h / 2);
  const xOf = (t) => box.x + (t / m.duration) * box.w;

  graticule(ctx, box, H_DIVS, V_DIVS);
  centreLine(ctx, box);

  // the ideal generator output, for comparison
  if (state.showIdeal) {
    strokeTrace(ctx, analogTrace(m.nodes.ideal, m.duration, box.w), box, yOf, c.ghost, 1.2);
  }

  // what reaches the sampler
  if (state.showAnalog) {
    const tint = state.afeOn || state.aaOn ? c.c : c.a;
    strokeTrace(ctx, analogTrace(m.nodes.aa, m.duration, box.w), box, yOf, tint, 1.6);
  }

  const { t, v } = m.rec;

  if (state.showInstants && t.length && t.length < 900) {
    ctx.strokeStyle = c.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < t.length; i++) {
      const x = Math.round(xOf(t[i])) + 0.5;
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + box.h);
    }
    ctx.stroke();
  }

  if (state.showRecon && state.reconOn && t.length > 1) {
    ctx.strokeStyle = c.b;
    ctx.lineWidth = 1.9;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const step = m.outMode === 'sinc' ? 1 : 0.5;
    for (let px = 0; px <= box.w; px += step) {
      const y = yOf(reconstruct(m.rec, (px / box.w) * m.duration, m.outMode));
      if (px === 0) ctx.moveTo(box.x + px, y); else ctx.lineTo(box.x + px, y);
    }
    ctx.stroke();
  }

  if (state.showSamples && t.length) {
    const dense = t.length > 380;
    ctx.fillStyle = dense ? c.b : '#e8fffd';
    ctx.strokeStyle = c.b;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < t.length; i++) {
      if (t[i] > m.duration) break;
      const x = xOf(t[i]);
      const y = yOf(v[i]);
      if (dense) { ctx.fillRect(x - 0.6, y - 0.6, 1.6, 1.6); continue; }
      ctx.beginPath();
      ctx.arc(x, y, 2.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // on-screen readouts
  const chain = [
    state.afeOn ? `${fmtFreq(state.bw)} ${RESPONSE_LABEL[state.resp].toLowerCase()}` : 'no bandwidth limit',
    state.aaOn ? `anti-alias at ${fmtFreq(m.aaCutoff)}` : 'no anti-alias filter',
  ].join('  \u2502  ');

  label(ctx, `CH1  ${state.afeOn || state.aaOn ? 'at the sampler' : 'analog input'}`, box.x + 6, box.y + 5, state.afeOn || state.aaOn ? c.c : c.a);
  label(ctx, state.adcOn
    ? `CH2  ${state.reconOn ? (m.outMode === 'sinc' ? 'band-limited' : m.outMode) + ' reconstruction' : 'sample points only'}`
    : 'CH2  sampler switched out', box.x + 6, box.y + 19, c.b);
  label(ctx, `${vPerDiv.toFixed(3)} V/div`, box.x + box.w - 6, box.y + 5, c.text, 10.5, 'right');
  label(ctx, `${fmtSec(m.duration / H_DIVS)}/div`, box.x + box.w - 6, box.y + 19, c.text, 10.5, 'right');

  mono(ctx, 10.5);
  ctx.fillStyle = c.text;
  ctx.fillText(state.adcOn ? `${fmtRate(m.fs)}   ${t.length} points` : 'analog only', box.x + 6, h - 6);
  ctx.textAlign = 'right';
  ctx.fillStyle = m.memLimited ? c.warn : c.text;
  ctx.fillText(m.memLimited ? `memory limited from ${fmtRate(m.fsSet)}` : chain, box.x + box.w - 6, h - 6);
  ctx.textAlign = 'left';
}

/* ------------------------------------------------------------------ *
 * Spectrum
 * ------------------------------------------------------------------ */

function drawSpectrum(m) {
  const s = surface($('#spectrum'));
  if (!s) return;
  const { ctx, w, h } = s;
  const c = colors();
  const pad = { l: 30, r: 16, t: 16, b: 28 };
  const gw = w - pad.l - pad.r;
  const gh = h - pad.t - pad.b;
  const base = pad.t + gh;
  const fs = m.fs;

  const fmax = Math.max(fs * 2.35, state.freq * 1.15);
  const xOf = (f) => pad.l + (f / fmax) * gw;
  const comps = m.nodes.aa;
  const peakAmp = Math.max(0.05, ...comps.map((k) => Math.abs(k.a)));
  const hOf = (a) => (Math.abs(a) / peakAmp) * (gh - 26);
  const visible = comps.filter((k) => k.f <= fmax && Math.abs(k.a) > 0.015 * peakAmp);
  const hidden = comps.filter((k) => k.f > fmax && Math.abs(k.a) > 0.05 * peakAmp).length;

  ctx.fillStyle = 'rgba(226,87,74,0.05)';
  ctx.fillRect(xOf(fs / 2), pad.t, w - pad.r - xOf(fs / 2), gh);

  ctx.strokeStyle = c.grat;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, base + 0.5);
  ctx.lineTo(pad.l + gw, base + 0.5);
  ctx.stroke();

  mono(ctx, 9.5);
  ctx.textAlign = 'center';
  const spacing = (fs / fmax) * gw;
  for (let k = 1; k * fs <= fmax; k++) {
    if (spacing < 42 && k % 2) continue;
    const x = xOf(k * fs);
    ctx.strokeStyle = c.axis;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, base);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.text;
    ctx.fillText(k === 1 ? 'fs' : `${k}fs`, x, base + 14);
  }
  ctx.textAlign = 'left';

  const folding = visible.filter((k) => k.f > fs / 2)
    .sort((a, b) => Math.abs(b.a) - Math.abs(a.a))
    .slice(0, 4);
  for (const k of visible) {
    const x = xOf(k.f);
    const y = base - hOf(k.a);
    const folds = k.f > fs / 2;
    ctx.strokeStyle = c.a;
    ctx.lineWidth = folds ? 1.1 : 3.2;
    if (folds) ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!folding.includes(k)) continue;

    const to = xOf(alias(k.f, fs).f);
    const arch = pad.t + 14 + folding.indexOf(k) * 7;
    ctx.strokeStyle = c.fold;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo((x + to) / 2, arch, to, base - hOf(k.a));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(to, base);
    ctx.lineTo(to, base - hOf(k.a));
    ctx.stroke();
  }

  if (m.spec) {
    const { mag, df } = m.spec;
    ctx.beginPath();
    ctx.moveTo(pad.l, base);
    for (let i = 0; i < mag.length; i++) {
      const f = i * df;
      if (f > fs / 2) break;
      ctx.lineTo(xOf(f), base - hOf(mag[i]));
    }
    ctx.lineTo(xOf(fs / 2), base);
    ctx.closePath();
    ctx.fillStyle = 'rgba(46,211,198,0.16)';
    ctx.fill();
    ctx.strokeStyle = c.b;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const pk = peakFrequency(m.spec);
    if (pk.amp > 0.02 * peakAmp) {
      ctx.fillStyle = c.b;
      ctx.beginPath();
      ctx.arc(xOf(pk.f), base - hOf(pk.amp), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const xn = xOf(fs / 2);
  ctx.strokeStyle = c.nyq;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(xn, pad.t - 6);
  ctx.lineTo(xn, base);
  ctx.stroke();
  ctx.setLineDash([]);
  label(ctx, `fs/2 = ${fmtFreq(fs / 2)}`, xn + 5, pad.t + 4, c.nyq);

  mono(ctx, 9.5);
  ctx.fillStyle = c.text;
  ctx.textAlign = 'center';
  ctx.fillText('0', pad.l, base + 14);
  ctx.textAlign = 'left';

  if (hidden) {
    label(ctx, `+ ${hidden} above ${fmtFreq(fmax)}`, w - pad.r - 4, pad.t + 4, c.text, 9.5, 'right');
  }
}

/* ------------------------------------------------------------------ *
 * Readouts
 * ------------------------------------------------------------------ */

function updateReadouts(m) {
  const s = state;
  const predicted = alias(s.freq, m.fs);
  const measured = m.spec ? peakFrequency(m.spec) : null;
  const spc = samplesPerCycle(s.freq, m.fs);

  // slider positions
  $('#freq').value = toSlider('freq', s.freq);
  $('#fs').value = toSlider('fs', s.fs);
  $('#bw').value = toSlider('bw', s.bw);
  $('#window').value = toSlider('window', s.window);
  $('#mem').value = toSlider('mem', s.mem);
  $('#amp').value = s.amp;
  $('#phase').value = s.phase;
  $('#edge').value = s.edge;
  $('#offset').value = s.offset;
  $('#bits').value = s.bits;
  $('#aaCut').value = s.aaCut;
  $('#waveform').value = s.waveform;
  $('#resp').value = s.resp;
  $('#aaResp').value = s.aaResp;
  const r = $(`input[name=recon][value="${s.recon}"]`);
  if (r) r.checked = true;
  for (const [id, key] of [['afeOn', 'afeOn'], ['aaOn', 'aaOn'], ['adcOn', 'adcOn'], ['reconOn', 'reconOn'],
    ['showAnalog', 'showAnalog'], ['showSamples', 'showSamples'], ['showRecon', 'showRecon'],
    ['showInstants', 'showInstants'], ['showIdeal', 'showIdeal']]) {
    const el = $(`#${id}`);
    if (el) el.checked = s[key];
  }

  $('#freqOut').value = fmtFreq(s.freq);
  $('#fsOut').value = fmtRate(s.fs);
  $('#ampOut').value = `${s.amp.toFixed(2)} V`;
  $('#phaseOut').value = `${s.phase}\u00b0`;
  $('#edgeOut').value = `${s.edge}% \u00b7 ${fmtSec((s.edge / 100) / s.freq)}`;
  $('#windowOut').value = fmtSec(s.window);
  $('#offsetOut').value = `${s.offset}% of Ts`;
  $('#bitsOut').value = s.bits ? `${s.bits} bit` : 'off';
  $('#bwOut').value = `${fmtFreq(s.bw)} \u00b7 ${(s.bw / s.freq).toFixed(1)}\u00d7 f`;
  $('#memOut').value = fmtPoints(s.mem);
  $('#aaCutOut').value = fmtFreq(m.aaCutoff);
  $('#reconNote').textContent = RECON_NOTE[s.recon];

  $('#mIn').textContent = s.waveform === 'twotone'
    ? `${fmtFreq(s.freq)} + ${fmtFreq(s.freq * TWOTONE_RATIO)}`
    : fmtFreq(s.freq);
  $('#mNyq').textContent = fmtFreq(m.nyq);
  $('#mAlias').textContent = fmtFreq(predicted.f);
  $('#mMeas').textContent = !m.spec ? 'not sampled'
    : measured.f > 0 ? fmtFreq(measured.f)
      : measured.amp > 1e-4 ? 'DC' : 'no tone';
  $('#mSpc').textContent = isFinite(spc) ? spc.toFixed(2) : '\u221e';
  $('#measure .is-key').classList.toggle('is-clean', !predicted.folded);

  const v = state.adcOn
    ? verdict({
      comps: m.nodes.aa, f: s.freq, fs: m.fs, waveform: s.waveform, antiAlias: s.aaOn,
      bw: s.afeOn ? s.bw : Infinity,
      fundKept: m.fundKept,
      shapeErr: m.afeError ? m.afeError.rmsRel : 0,
    })
    : {
      level: 'ok',
      headline: 'The sampler is switched out.',
      body: 'This is the signal as the front end delivers it, with no discretisation of any kind. Switch the '
        + 'sampler back in to see what survives being turned into numbers.',
    };

  $('#verdict').dataset.level = v.level;
  $('#verdictHead').textContent = v.headline;
  $('#verdictBody').textContent = v.body;

  const notes = [];
  if (m.spec) {
    notes.push(`${m.rec.v.length} acquired points \u00b7 FFT bin spacing ${fmtFreq(m.spec.df)} \u00b7 1/T \u2248 ${fmtFreq(m.spec.resolution)}.`);
  }
  if (m.memLimited) notes.push(`Record length ${fmtPoints(s.mem)} cannot hold ${fmtSec(s.window)} at ${fmtRate(m.fsSet)}, so the sampler is running at ${fmtRate(m.fs)}.`);
  if (m.capped) {
    notes.push(`${fmtSec(m.requested)} at ${fmtRate(m.fs)} would be ${m.wanted.toLocaleString()} points. `
      + `This model draws at most ${m.rec.v.length.toLocaleString()}, so the screen is showing ${fmtSec(m.duration)}.`);
  }
  if (s.afeOn && m.afeError && m.afeError.ampRatio < 0.97) {
    notes.push(`Front end is already taking ${(100 * (1 - m.afeError.ampRatio)).toFixed(0)}% off the waveform before the sampler sees it.`);
  }
  $('#benchNote').textContent = notes.join(' ');

  const lamp = v.level === 'ok' ? 'var(--ok)' : v.level === 'warn' ? 'var(--warn)' : 'var(--bad)';
  $('#lamp').style.background = lamp;
  $('#railText').textContent = predicted.folded
    ? `${fmtFreq(s.freq)} in, ${fmtFreq(predicted.f)} out \u2014 zone ${predicted.zone}`
    : `${fmtFreq(s.freq)} in, ${fmtFreq(predicted.f)} out`;

  $$('.softkey').forEach((b) => {
    const p = PRESETS.find((x) => x.key === b.dataset.key);
    const on = p && Object.entries(p.set).every(([k, val]) => state[k] === val);
    b.classList.toggle('is-on', !!on);
  });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const LOG_CONTROLS = { freq: 'freq', fs: 'fs', bw: 'bw', window: 'window', mem: 'mem' };
const LINEAR_CONTROLS = ['amp', 'phase', 'edge', 'offset', 'bits', 'aaCut'];
const SWITCHES = ['afeOn', 'aaOn', 'adcOn', 'reconOn',
  'showAnalog', 'showSamples', 'showRecon', 'showInstants', 'showIdeal'];

export function initBench() {
  for (const [id, key] of Object.entries(LOG_CONTROLS)) {
    $(`#${id}`).addEventListener('input', (e) => patch({ [key]: fromSlider(key, e.target.value) }));
  }
  for (const key of LINEAR_CONTROLS) {
    $(`#${key}`).addEventListener('input', (e) => patch({ [key]: Number(e.target.value) }));
  }
  for (const key of SWITCHES) {
    $(`#${key}`).addEventListener('change', (e) => patch({ [key]: e.target.checked }));
  }
  $('#waveform').addEventListener('change', (e) => patch({ waveform: e.target.value }));
  $('#resp').addEventListener('change', (e) => patch({ resp: e.target.value }));
  $('#aaResp').addEventListener('change', (e) => patch({ aaResp: e.target.value }));
  $$('input[name=recon]').forEach((r) => r.addEventListener('change', () => r.checked && patch({ recon: r.value })));
  $('#resetBtn').addEventListener('click', () => patch({ ...DEFAULTS }));
  $('#fitBtn').addEventListener('click', () => patch({ window: fitWindow() }));

  const rail = $('#softkeys');
  PRESETS.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'softkey';
    b.dataset.key = p.key;
    b.innerHTML = `<b>${i + 1}. ${p.label}</b><span>${p.hint}</span>`;
    b.addEventListener('click', () => patch(p.set));
    rail.appendChild(b);
  });

  $('#scope').addEventListener('pointermove', (e) => {
    const m = build(state);
    const r = e.currentTarget.getBoundingClientRect();
    if (!m.rec.v.length) { $('#cursorInfo').textContent = 'No samples in this window.'; return; }
    const t = Math.max(0, Math.min(m.duration, ((e.clientX - r.left - 8) / (r.width - 16)) * m.duration));
    const i = Math.max(0, Math.min(m.rec.v.length - 1, Math.round((t - m.rec.t0) / m.rec.Ts)));
    $('#cursorInfo').textContent = `Sample ${i} \u00b7 t = ${fmtSec(m.rec.t[i])} \u00b7 recorded ${fmtVolt(m.rec.v[i])} \u00b7 `
      + `at the sampler ${fmtVolt(evaluate(m.nodes.aa, m.rec.t[i]))} \u00b7 source ${fmtVolt(evaluate(m.nodes.ideal, m.rec.t[i]))}`;
  });

  $('#csvBtn').addEventListener('click', () => {
    const m = build(state);
    const rows = ['time_s,recorded_V,at_sampler_V,source_V'];
    for (let i = 0; i < m.rec.t.length; i++) {
      rows.push(`${m.rec.t[i]},${m.rec.v[i]},${evaluate(m.nodes.aa, m.rec.t[i])},${evaluate(m.nodes.ideal, m.rec.t[i])}`);
    }
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scopelab-acquisition.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  ['#scope', '#spectrum'].forEach((sel) => observeResize($(sel), () => benchVisible() && renderBench(state)));
  subscribe((s) => { if (benchVisible()) renderBench(s); });
}

const benchVisible = () => $('#view-bench')?.classList.contains('is-on');

export function renderBench() {
  const m = build(state);
  updateReadouts(m);
  drawScope(m);
  drawSpectrum(m);
}
