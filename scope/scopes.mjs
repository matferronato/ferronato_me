// scopes.mjs — the same signal put in front of five real instruments, one per
// price decade. Bandwidth, sample rate and resolution are catalogue figures;
// response shape, ENOB and jitter are modelled, and labelled as such.

import {
  source, frontEnd, evaluate, quantize, sincAt, alias, effectiveRate,
  edgeResponse, responseAt, traceError, noiseSource,
  fmtFreq, fmtRate, fmtSec, fmtPoints, dB, TAU,
} from './dsp.mjs';
import { state, patch, subscribe, toSlider, fromSlider } from './state.mjs';
import {
  $, colors, surface, mono, graticule, centreLine, label, logAxis, decadeTicks,
  observeResize,
} from './ui.mjs';

/* ------------------------------------------------------------------ *
 * The catalogue
 *
 * bw / fs / bits / mem are published specifications.
 * resp / enob / jitter are this page's model of the instrument, chosen to sit
 * in the right place for the class rather than to reproduce a datasheet.
 * ------------------------------------------------------------------ */

export const SCOPES = [
  {
    id: 'entry',
    tier: '$100',
    price: 'about $200',
    name: 'Hantek DSO2C10',
    klass: 'Entry bench scope',
    bw: 100e6, fs: 1e9, bits: 8, mem: 8e6,
    resp: 'onepole', enob: 6.3, jitter: 30e-12,
    note: 'Ten samples per period at full bandwidth, and a front end that starts rolling off long before its corner.',
  },
  {
    id: 'prosumer',
    tier: '$1k',
    price: 'about $900',
    name: 'Rigol DHO924S',
    klass: '12-bit bench scope',
    bw: 250e6, fs: 1.25e9, bits: 12, mem: 50e6,
    resp: 'gaussian', enob: 9.2, jitter: 10e-12,
    note: 'Sixteen times the vertical resolution of the tier below it, on only 2.5x oversampling at the top of its band.',
  },
  {
    id: 'mid',
    tier: '$10k',
    price: 'about $15k',
    name: 'Keysight DSOX3054T',
    klass: 'Mid-range bench scope',
    bw: 500e6, fs: 5e9, bits: 8, mem: 4e6,
    resp: 'gaussian', enob: 7.0, jitter: 3e-12,
    note: 'Back to 8 bits, but a far quieter front end and ten times the oversampling. Shallow memory for its speed.',
  },
  {
    id: 'high',
    tier: '$100k',
    price: 'about $100k',
    name: 'Keysight MXR608A',
    klass: 'High-end real-time scope',
    bw: 6e9, fs: 16e9, bits: 10, mem: 200e6,
    resp: 'maxflat', enob: 8.2, jitter: 300e-15,
    note: 'A flat passband right up to the corner, which is why fast edges come back with overshoot that was never in the signal.',
  },
  {
    id: 'flagship',
    tier: '$1M',
    price: 'seven figures',
    name: 'Keysight UXR1104B',
    klass: 'Flagship real-time scope',
    bw: 110e9, fs: 256e9, bits: 10, mem: 2e9,
    resp: 'maxflat', enob: 7.2, jitter: 30e-15,
    note: 'Only 2.3x oversampling. The most expensive scope on the list runs closest to its own Nyquist limit.',
  },
];

// Noise implied by the modelled ENOB, with the quantiser's own contribution
// taken back out so the two are not counted twice.
export function noiseFor(scope, fullScale) {
  const sineRms = fullScale / Math.SQRT2;
  const sinad = 6.02 * scope.enob + 1.76;
  const total = sineRms / 10 ** (sinad / 20);
  const lsb = (2 * fullScale) / 2 ** scope.bits;
  const q = lsb / Math.sqrt(12);
  return Math.sqrt(Math.max(0, total * total - q * q));
}

/* ------------------------------------------------------------------ *
 * Acquisition, including the parts the bench does not model
 * ------------------------------------------------------------------ */

export function acquire(comps, scope, { fs, duration, fullScale, seed = 7 }) {
  const Ts = 1 / fs;
  const n = Math.min(20001, Math.floor(duration / Ts) + 1);
  const t = new Float64Array(n);
  const v = new Float64Array(n);
  const rand = noiseSource(seed);
  const noise = noiseFor(scope, fullScale);
  for (let i = 0; i < n; i++) {
    const ti = i * Ts;
    t[i] = ti;
    const sampled = evaluate(comps, ti + rand() * scope.jitter);
    v[i] = quantize(sampled + rand() * noise, scope.bits, fullScale);
  }
  return { t, v, Ts, t0: 0, noise };
}

export function measure(scope, s) {
  const duration = s.instCycles / s.instFreq;
  const fullScale = 1.25;
  const ideal = source(s.instWave, s.instFreq, 1, 0, s.instEdge / 100);
  const afe = frontEnd(ideal, scope.bw, scope.resp);
  const fs = effectiveRate(scope.fs, scope.mem, duration);
  const rec = acquire(afe, scope, { fs, duration, fullScale });
  const err = traceError(ideal, afe, duration);
  const edge = edgeResponse(scope.resp, scope.bw);
  const nyq = fs / 2;
  let peak = 0;
  for (const c of ideal) peak = Math.max(peak, Math.abs(c.a));
  const folding = afe.filter((c) => c.f > nyq && Math.abs(c.a) > 0.02 * peak);
  const fundamental = responseAt(scope.resp, s.instFreq, scope.bw).m;
  return {
    scope, ideal, afe, rec, err, edge, fs, nyq, folding, fundamental, duration, fullScale,
    spc: fs / s.instFreq,
    aliasF: alias(s.instFreq, fs),
    sourceEdge: (s.instEdge / 100) / s.instFreq,
  };
}

function healthOf(m) {
  if (m.folding.length || m.aliasF.folded) return 'bad';
  if (m.fundamental < 0.72 || m.spc < 4) return 'warn';
  if (m.err.rmsRel > 0.12) return 'warn';
  return 'ok';
}

/* ------------------------------------------------------------------ *
 * Markup
 * ------------------------------------------------------------------ */

const WAVE_OPTIONS = ['sine', 'square', 'triangle', 'sawtooth']
  .map((w) => `<option value="${w}">${w[0].toUpperCase()}${w.slice(1)}</option>`).join('');

function markup() {
  return `
  <div class="stage-head">
    <h2>One signal, five instruments</h2>
    <p>The same generator output, put in front of a scope from each price decade. Nothing here is a different
       measurement &mdash; it is one waveform, five front ends and five samplers, drawn to the same time base.
       Take the frequency up and watch the cheap end of the list stop telling the truth.</p>
  </div>

  <form class="inst-source" id="instSource" autocomplete="off">
    <div class="select-row">
      <label for="instWave">Waveform</label>
      <select id="instWave">${WAVE_OPTIONS}</select>
    </div>
    <div class="knob is-primary">
      <label for="instFreq">Frequency</label><output id="instFreqOut" for="instFreq"></output>
      <input id="instFreq" type="range" min="0" max="1000" step="1">
    </div>
    <div class="knob">
      <label for="instEdge">Generator edge rate</label><output id="instEdgeOut" for="instEdge"></output>
      <input id="instEdge" type="range" min="0.3" max="25" step="0.1">
    </div>
    <div class="knob">
      <label for="instCycles">Periods on screen</label><output id="instCyclesOut" for="instCycles"></output>
      <input id="instCycles" type="range" min="1" max="12" step="1">
    </div>
    <div class="inst-jump">
      <button type="button" class="chip" data-jump="1e6">1 MHz</button>
      <button type="button" class="chip" data-jump="50e6">50 MHz</button>
      <button type="button" class="chip" data-jump="500e6">500 MHz</button>
      <button type="button" class="chip" data-jump="5e9">5 GHz</button>
      <button type="button" class="chip" data-jump="40e9">40 GHz</button>
    </div>
  </form>

  <div class="lanes" id="instLanes"></div>

  <section class="band-block">
    <div class="block-head">
      <h2>What each instrument can still see</h2>
      <p>Frequency runs left to right on a log scale. Brightness is how much of a sine at that frequency survives the
         front end. The red edge on each row is that instrument&rsquo;s own Nyquist limit &mdash; past it, whatever the
         front end let through comes back at the wrong frequency. Vertical ticks are the harmonics of the signal above.</p>
    </div>
    <figure class="screen screen-band">
      <canvas id="bandChart" aria-label="Bandwidth and Nyquist limit of each instrument against frequency"></canvas>
    </figure>

    <div class="block-head">
      <h2>The same thing as numbers</h2>
      <p>Front-end magnitude response. The &minus;3 dB point is the number on the datasheet; what matters for a
         waveform is how far down the roll-off its harmonics land.</p>
    </div>
    <figure class="screen screen-wide">
      <canvas id="respChart" aria-label="Front end magnitude response of each instrument"></canvas>
    </figure>
    <p class="figure-note" id="respNote"></p>
  </section>

  <div class="stage-head">
    <h2>What actually separates them</h2>
  </div>
  <dl class="notes notes-tight">
    <div>
      <dt>Oversampling ratio falls as you go up the list</dt>
      <dd>The $200 scope samples at ten times its own bandwidth. The flagship samples at 2.3 times its bandwidth,
        which is barely above Nyquist. Cheap instruments can afford to be generous with sample rate because their
        bandwidth is low; at 110 GHz the converter is the hard part, and the front end is deliberately matched to it.</dd>
    </div>
    <div>
      <dt>More bandwidth is more noise</dt>
      <dd>Noise adds up over whatever band the front end passes, so a 110 GHz channel collects far more of it than a
        100 MHz one at the same volts per division. That is why every high-bandwidth scope has switchable bandwidth
        limits, and why buying more bandwidth than the signal needs makes a measurement worse rather than better.</dd>
    </div>
    <div>
      <dt>Bits and effective bits are different specifications</dt>
      <dd>Twelve bits in front of a noisy amplifier is still an eight-bit measurement. The modelled ENOB here folds
        the converter and the front end together, which is why the 12-bit bench scope beats the 8-bit one above it on
        vertical detail but loses on everything to do with speed.</dd>
    </div>
    <div>
      <dt>The response shape changes with price, and it is not always an improvement</dt>
      <dd>Sub-gigahertz scopes are usually Gaussian: an edge only ever comes back slower than it went in. Multi-GHz
        scopes are maximally flat, which keeps the passband honest and then overshoots on a fast edge. Some of the
        ringing you see on an expensive instrument belongs to the instrument.</dd>
    </div>
    <div>
      <dt>Memory depth is what you spend to zoom out</dt>
      <dd>Record length divided by sample rate is the longest window you can hold at full rate. The mid-range scope
        here has the shallowest memory of the five, so it drops its sample rate sooner than the bench scope below it
        when the time base gets long.</dd>
    </div>
    <div>
      <dt>Where these numbers come from</dt>
      <dd>Bandwidth, sample rate, resolution and memory depth are published figures. Response shape, effective bits
        and jitter are modelled per class, at each instrument&rsquo;s full bandwidth and with the vertical scale set so
        the signal fills the screen. Treat them as the right order of magnitude, not as a datasheet.</dd>
    </div>
  </dl>`;
}

/* ------------------------------------------------------------------ *
 * Lanes
 * ------------------------------------------------------------------ */

function laneMarkup(scope) {
  return `
  <article class="lane" data-scope="${scope.id}">
    <div class="lane-id">
      <p class="lane-tier">${scope.tier}</p>
      <h3>${scope.name}</h3>
      <p class="lane-class">${scope.klass} &middot; ${scope.price}</p>
      <p class="lane-spec">
        <span>${fmtFreq(scope.bw)}</span><span>${fmtRate(scope.fs)}</span>
        <span>${scope.bits} bit</span><span>${fmtPoints(scope.mem)}</span>
      </p>
      <p class="lane-note">${scope.note}</p>
    </div>
    <figure class="lane-screen">
      <canvas id="lane-${scope.id}" aria-label="${scope.name} rendering of the source waveform"></canvas>
    </figure>
    <p class="lane-verdict" id="verdict-${scope.id}"></p>
  </article>`;
}

function drawLane(m) {
  const s = surface($(`#lane-${m.scope.id}`));
  if (!s) return;
  const { ctx, w, h } = s;
  const c = colors();
  const box = { x: 6, y: 6, w: w - 12, h: h - 12 };
  const span = 1.32;
  const yOf = (v) => box.y + box.h / 2 - (v / span) * (box.h / 2);
  const xOf = (t) => box.x + (t / m.duration) * box.w;

  graticule(ctx, box, 10, 4);
  centreLine(ctx, box);

  // the signal that went in
  ctx.strokeStyle = c.ghost;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let px = 0; px <= box.w; px++) {
    const y = yOf(evaluate(m.ideal, (px / box.w) * m.duration));
    if (px === 0) ctx.moveTo(box.x + px, y); else ctx.lineTo(box.x + px, y);
  }
  ctx.stroke();

  // what the instrument reconstructs from its own samples
  if (m.rec.v.length > 1) {
    ctx.strokeStyle = c.b;
    ctx.lineWidth = 1.9;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let px = 0; px <= box.w; px++) {
      const y = yOf(sincAt(m.rec, (px / box.w) * m.duration));
      if (px === 0) ctx.moveTo(box.x + px, y); else ctx.lineTo(box.x + px, y);
    }
    ctx.stroke();
  }

  // the samples themselves
  const { t, v } = m.rec;
  if (t.length && t.length < 700) {
    ctx.fillStyle = '#e8fffd';
    ctx.strokeStyle = c.b;
    ctx.lineWidth = 1.1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] > m.duration) break;
      ctx.beginPath();
      ctx.arc(xOf(t[i]), yOf(v[i]), 2.5, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
  } else if (t.length) {
    ctx.fillStyle = c.b;
    for (let i = 0; i < t.length; i++) {
      if (t[i] > m.duration) break;
      ctx.fillRect(xOf(t[i]) - 0.5, yOf(v[i]) - 0.5, 1.4, 1.4);
    }
  }

  // readouts
  const health = healthOf(m);
  const tone = health === 'ok' ? c.ok : health === 'warn' ? c.warn : c.bad;
  label(ctx, `${(100 * m.fundamental).toFixed(0)}% of the fundamental`, box.x + 8, box.y + 6, tone);
  label(ctx, `${m.spc < 100 ? m.spc.toFixed(1) : Math.round(m.spc)} samples/period`, box.x + 8, box.y + 20, c.text);
  label(ctx, `t_r ${fmtSec(m.edge.rise)}`, box.x + box.w - 8, box.y + 6, c.text, 10.5, 'right');
  const folds = m.aliasF.folded ? 'fundamental folds'
    : m.folding.length ? `${m.folding.length} harmonic${m.folding.length > 1 ? 's' : ''} folding`
      : 'nothing folding';
  label(ctx, folds, box.x + box.w - 8, box.y + 20,
    m.aliasF.folded || m.folding.length ? c.bad : c.text, 10.5, 'right');
}

function verdictFor(m, s) {
  const bits = [];
  const loss = 100 * (1 - m.fundamental);
  if (m.aliasF.folded) {
    bits.push(`The fundamental itself folds: ${fmtFreq(s.instFreq)} in, ${fmtFreq(m.aliasF.f)} out.`);
  } else if (m.folding.length) {
    bits.push(`${m.folding.length} harmonic${m.folding.length > 1 ? 's land' : ' lands'} above ${fmtFreq(m.nyq)} and fold back.`);
  }
  if (loss > 3) bits.push(`Front end takes ${loss.toFixed(0)}% off the fundamental (${dB(m.fundamental).toFixed(1)} dB).`);
  if (m.edge.rise > m.sourceEdge * 1.15 && s.instWave !== 'sine') {
    bits.push(`Edges arrive at ${fmtSec(m.edge.rise)} against ${fmtSec(m.sourceEdge)} going in.`);
  }
  if (!bits.length) bits.push('Amplitude, edges and frequency all survive. This instrument is not the limit here.');
  return bits.join(' ');
}

/* ------------------------------------------------------------------ *
 * Band chart
 * ------------------------------------------------------------------ */

function drawBand(models, s) {
  const surf = surface($('#bandChart'));
  if (!surf) return;
  const { ctx, w, h } = surf;
  const c = colors();
  const pad = { l: 128, r: 20, t: 14, b: 30 };
  const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
  const lo = Math.min(1e6, Math.max(1e3, s.instFreq / 6));
  const hi = 4e11;
  const ax = logAxis(lo, hi, box.x, box.w);

  const rowH = box.h / models.length;
  const gap = Math.min(8, rowH * 0.22);

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const y = box.y + i * rowH;
    const bh = rowH - gap;

    // magnitude as brightness: what a sine at this frequency is worth here
    for (let px = 0; px < box.w; px++) {
      const f = ax.inv(box.x + px);
      const mag = responseAt(m.scope.resp, f, m.scope.bw).m;
      if (mag < 0.02) continue;
      ctx.globalAlpha = Math.min(1, mag) ** 1.4;
      ctx.fillStyle = f > m.nyq ? c.fold : c.a;
      ctx.fillRect(box.x + px, y, 1.05, bh);
    }
    ctx.globalAlpha = 1;

    // Nyquist wall
    const xn = ax.of(m.nyq);
    if (xn > box.x && xn < box.x + box.w) {
      ctx.strokeStyle = c.nyq;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(Math.round(xn) + 0.5, y);
      ctx.lineTo(Math.round(xn) + 0.5, y + bh);
      ctx.stroke();
    }
    // -3 dB corner
    const xb = ax.of(m.scope.bw);
    ctx.strokeStyle = c.text;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(xb) + 0.5, y);
    ctx.lineTo(Math.round(xb) + 0.5, y + bh);
    ctx.stroke();
    ctx.setLineDash([]);

    // row identity
    label(ctx, m.scope.tier, 6, y + bh / 2 - 12, c.text, 11);
    label(ctx, m.scope.name, 6, y + bh / 2 + 1, colors().b, 10.5);
    label(ctx, `${fmtFreq(m.scope.bw)} \u00b7 ${fmtRate(m.fs)}`, 6, y + bh / 2 + 14, c.text, 9.5);
  }

  // harmonics of the current source, straight down the chart
  let peak = 0;
  for (const k of models[0].ideal) peak = Math.max(peak, Math.abs(k.a));
  ctx.strokeStyle = '#ffffff';
  for (const k of models[0].ideal) {
    if (Math.abs(k.a) < 0.03 * peak || k.f > hi) continue;
    const x = Math.round(ax.of(k.f)) + 0.5;
    ctx.globalAlpha = 0.14 + 0.5 * (Math.abs(k.a) / peak);
    ctx.lineWidth = k.f === s.instFreq ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  decadeTicks(ctx, ax, box, 'Hz');
  label(ctx, `signal ${fmtFreq(s.instFreq)}`, ax.of(s.instFreq) + 5, box.y + 2, '#ffffff', 10);
}

/* ------------------------------------------------------------------ *
 * Response curves
 * ------------------------------------------------------------------ */

const CURVE_TINT = ['#e2574a', '#f0b429', '#8fbf5a', '#2ed3c6', '#9b8cf5'];

function drawResponse(models, s) {
  const surf = surface($('#respChart'));
  if (!surf) return;
  const { ctx, w, h } = surf;
  const c = colors();
  const pad = { l: 42, r: 16, t: 14, b: 30 };
  const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
  const lo = Math.min(1e6, Math.max(1e3, s.instFreq / 6));
  const hi = 4e11;
  const ax = logAxis(lo, hi, box.x, box.w);
  const dbLo = -40;
  const yOf = (d) => box.y + box.h * (1 - (Math.max(d, dbLo) - dbLo) / (3 - dbLo));

  ctx.strokeStyle = c.grat;
  ctx.lineWidth = 1;
  mono(ctx, 9.5);
  ctx.textAlign = 'right';
  for (let d = 0; d >= dbLo; d -= 10) {
    const y = Math.round(yOf(d)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.fillStyle = c.text;
    ctx.fillText(`${d}`, box.x - 7, y + 3);
  }
  ctx.textAlign = 'left';
  label(ctx, 'dB', 6, box.y, c.text, 9.5);
  decadeTicks(ctx, ax, box, 'Hz', false);

  // -3 dB reference
  ctx.strokeStyle = c.nyq;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  const y3 = Math.round(yOf(-3.01)) + 0.5;
  ctx.beginPath();
  ctx.moveTo(box.x, y3);
  ctx.lineTo(box.x + box.w, y3);
  ctx.stroke();
  ctx.setLineDash([]);

  // harmonic stems
  let peak = 0;
  for (const k of models[0].ideal) peak = Math.max(peak, Math.abs(k.a));
  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const k of models[0].ideal) {
    if (Math.abs(k.a) < 0.03 * peak || k.f > hi) continue;
    const x = Math.round(ax.of(k.f)) + 0.5;
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  models.forEach((m, i) => {
    ctx.strokeStyle = CURVE_TINT[i];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let px = 0; px <= box.w; px++) {
      const f = ax.inv(box.x + px);
      const y = yOf(dB(responseAt(m.scope.resp, f, m.scope.bw).m));
      if (px === 0) ctx.moveTo(box.x + px, y); else ctx.lineTo(box.x + px, y);
    }
    ctx.stroke();
  });

  const xf = ax.of(s.instFreq);
  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(Math.round(xf) + 0.5, box.y);
  ctx.lineTo(Math.round(xf) + 0.5, box.y + box.h);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

let built = false;

export function initInstruments() {
  const host = $('#view-instruments');
  if (!host || built) return;
  built = true;
  host.innerHTML = markup();
  $('#instLanes').innerHTML = SCOPES.map(laneMarkup).join('');

  $('#instWave').addEventListener('change', (e) => patch({ instWave: e.target.value }));
  $('#instFreq').addEventListener('input', (e) => patch({ instFreq: fromSlider('instFreq', e.target.value) }));
  $('#instEdge').addEventListener('input', (e) => patch({ instEdge: Number(e.target.value) }));
  $('#instCycles').addEventListener('input', (e) => patch({ instCycles: Number(e.target.value) }));
  host.querySelectorAll('[data-jump]').forEach((b) => {
    b.addEventListener('click', () => patch({ instFreq: Number(b.dataset.jump) }));
  });

  SCOPES.forEach((sc) => observeResize($(`#lane-${sc.id}`), () => render(state)));
  observeResize($('#bandChart'), () => render(state));
  observeResize($('#respChart'), () => render(state));

  subscribe((s) => { if (isVisible()) render(s); });
  render(state);
}

const isVisible = () => $('#view-instruments')?.classList.contains('is-on');

export function render(s) {
  if (!built) return;
  $('#instWave').value = s.instWave;
  $('#instFreq').value = toSlider('instFreq', s.instFreq);
  $('#instEdge').value = s.instEdge;
  $('#instCycles').value = s.instCycles;
  $('#instFreqOut').value = fmtFreq(s.instFreq);
  $('#instEdgeOut').value = `${s.instEdge}% of period \u00b7 ${fmtSec((s.instEdge / 100) / s.instFreq)}`;
  $('#instCyclesOut').value = `${s.instCycles} \u00b7 ${fmtSec(s.instCycles / s.instFreq)}`;

  const models = SCOPES.map((sc) => measure(sc, s));
  models.forEach((m) => {
    drawLane(m);
    const el = $(`#verdict-${m.scope.id}`);
    if (el) {
      el.textContent = verdictFor(m, s);
      el.dataset.level = healthOf(m);
    }
  });
  drawBand(models, s);
  drawResponse(models, s);

  const parts = models.map((m, i) =>
    `<span class="key" style="background:${CURVE_TINT[i]}"></span>${m.scope.tier}`);
  $('#respNote').innerHTML = `${parts.join('')}<span class="key key-nyq"></span>&minus;3 dB`;
}
