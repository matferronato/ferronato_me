// chain.mjs — two views built on the same model: the stage-by-stage signal
// chain, and a closer look at what the analog front end alone does.

import {
  evaluate, reconstruct, responseAt, peakFrequency, edgeResponse,
  RESPONSES, RESPONSE_LABEL, RESPONSE_NOTE, dB,
  fmtFreq, fmtRate, fmtSec, fmtPoints, TAU,
} from './dsp.mjs';
import { build, analogTrace, FULL_SCALE } from './model.mjs';
import { state, patch, subscribe, toSlider, fromSlider } from './state.mjs';
import {
  $, $$, colors, surface, mono, graticule, centreLine, strokeTrace, label,
  logAxis, decadeTicks, observeResize,
} from './ui.mjs';

/* ------------------------------------------------------------------ *
 * Edge measurement on the received waveform
 * ------------------------------------------------------------------ */

// The steepest rising instant of the ideal waveform, which is where an edge
// measurement belongs.
export function steepestRise(comps, f, phaseSearch = 800) {
  const T = 1 / f;
  let best = 0;
  let bestSlope = -Infinity;
  for (let i = 0; i < phaseSearch; i++) {
    const t = (i / phaseSearch) * T;
    const dt = T / (phaseSearch * 8);
    const slope = (evaluate(comps, t + dt) - evaluate(comps, t - dt)) / (2 * dt);
    if (slope > bestSlope) { bestSlope = slope; best = t; }
  }
  return { t: best, slope: bestSlope };
}

function levelsOf(comps, f, n = 600) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = evaluate(comps, (i / n) / f);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

// 10-90% transition time of `comps` around `tc`, against reference levels taken
// from the waveform it is supposed to represent.
export function measureRise(comps, f, tc, ref, span) {
  const l10 = ref.lo + 0.1 * (ref.hi - ref.lo);
  const l90 = ref.lo + 0.9 * (ref.hi - ref.lo);
  const n = 2400;
  const t0 = tc - span;
  const dt = (2 * span) / n;
  let t10 = NaN;
  let t90 = NaN;
  let prev = evaluate(comps, t0);
  for (let i = 1; i <= n; i++) {
    const t = t0 + i * dt;
    const v = evaluate(comps, t);
    if (Number.isNaN(t10) && prev < l10 && v >= l10) t10 = t - dt + (dt * (l10 - prev)) / (v - prev);
    if (!Number.isNaN(t10) && Number.isNaN(t90) && prev < l90 && v >= l90) {
      t90 = t - dt + (dt * (l90 - prev)) / (v - prev);
    }
    prev = v;
  }
  return { t10, t90, rise: t90 - t10, l10, l90 };
}

/* ================================================================== *
 * View 1 — the signal chain
 * ================================================================== */

const WAVES = ['sine', 'square', 'triangle', 'sawtooth', 'twotone'];
const waveOptions = (sel) => WAVES
  .map((w) => `<option value="${w}"${w === sel ? ' selected' : ''}>${w === 'twotone' ? 'Two tone' : w[0].toUpperCase() + w.slice(1)}</option>`)
  .join('');
const respOptions = () => RESPONSES
  .map((r) => `<option value="${r}">${RESPONSE_LABEL[r]}</option>`).join('');

const STAGE_UI = [
  {
    id: 'src', n: 1, name: 'Source', always: true,
    blurb: 'A waveform is a sum of sinusoids. Everything downstream acts on them one at a time.',
    controls: `
      <div class="select-row"><label for="cWave">Waveform</label>
        <select id="cWave">${waveOptions()}</select></div>
      <div class="knob"><label for="cFreq">Frequency</label><output id="cFreqOut"></output>
        <input id="cFreq" type="range" min="0" max="1000" step="1"></div>
      <div class="knob"><label for="cAmp">Amplitude</label><output id="cAmpOut"></output>
        <input id="cAmp" type="range" min="0.05" max="2.4" step="0.05"></div>
      <div class="knob"><label for="cEdge">Edge rate</label><output id="cEdgeOut"></output>
        <input id="cEdge" type="range" min="0.3" max="25" step="0.1"></div>`,
  },
  {
    id: 'afe', n: 2, name: 'Analog front end', flag: 'afeOn',
    blurb: 'Amplitude and phase per harmonic. This is where edges lose their corners.',
    controls: `
      <div class="knob"><label for="cBw">Bandwidth</label><output id="cBwOut"></output>
        <input id="cBw" type="range" min="0" max="1000" step="1"></div>
      <div class="select-row"><label for="cResp">Response</label>
        <select id="cResp">${respOptions()}</select></div>`,
  },
  {
    id: 'aa', n: 3, name: 'Anti-alias filter', flag: 'aaOn',
    blurb: 'The only thing on this page that can stop a fold. It works by throwing information away first.',
    controls: `
      <div class="knob"><label for="cAaCut">Cutoff</label><output id="cAaCutOut"></output>
        <input id="cAaCut" type="range" min="0.25" max="2" step="0.05"></div>
      <div class="select-row"><label for="cAaResp">Response</label>
        <select id="cAaResp">${respOptions()}</select></div>`,
  },
  {
    id: 'adc', n: 4, name: 'Sample and hold', flag: 'adcOn',
    blurb: 'Time becomes discrete, then voltage does. Nothing between two points is recorded.',
    controls: `
      <div class="knob is-primary"><label for="cFs">Sample rate</label><output id="cFsOut"></output>
        <input id="cFs" type="range" min="0" max="1000" step="1"></div>
      <div class="knob"><label for="cBits">Resolution</label><output id="cBitsOut"></output>
        <input id="cBits" type="range" min="0" max="16" step="1"></div>
      <div class="knob"><label for="cOffset">Clock offset</label><output id="cOffsetOut"></output>
        <input id="cOffset" type="range" min="0" max="99" step="1"></div>
      <div class="knob"><label for="cMem">Record length</label><output id="cMemOut"></output>
        <input id="cMem" type="range" min="0" max="1000" step="1"></div>`,
  },
  {
    id: 'recon', n: 5, name: 'Reconstruction', flag: 'reconOn',
    blurb: 'Filling the gaps. The choice made here decides what the record appears to say.',
    controls: `
      <div class="segmented" role="radiogroup" aria-label="Reconstruction">
        <label><input type="radio" name="crecon" value="hold"><span>Hold</span></label>
        <label><input type="radio" name="crecon" value="linear"><span>Linear</span></label>
        <label><input type="radio" name="crecon" value="sinc"><span>Band&#8209;limited</span></label>
      </div>`,
  },
];

function chainMarkup() {
  return `
  <div class="stage-head">
    <h2>Follow one waveform through the chain</h2>
    <p>Five stages, in the order a real acquisition performs them. Switch any of them out and the lane below it
       shows what changes. The pale trace in each lane is what arrived from the stage above; the last lane compares
       against the source itself, so it is the whole error, end to end.</p>
  </div>

  <div class="chain-bar">
    <div class="knob"><label for="cWindow">Time on screen</label><output id="cWindowOut"></output>
      <input id="cWindow" type="range" min="0" max="1000" step="1"></div>
    <button type="button" class="chip" id="cFit">Fit the reported waveform</button>
    <p class="chain-flag" id="chainFlag"></p>
  </div>

  <div class="chain">
    ${STAGE_UI.map((st) => `
      <article class="stage" data-stage="${st.id}" id="stage-${st.id}">
        <div class="stage-rail">
          <h3><span class="stage-n">${st.n}</span>${st.name}</h3>
          ${st.always
            ? '<p class="stage-fixed">always in circuit</p>'
            : `<label class="switch stage-switch"><input type="checkbox" id="sw-${st.id}"><span>In circuit</span></label>`}
          <p class="stage-blurb">${st.blurb}</p>
          <div class="stage-controls">${st.controls}</div>
          <p class="stage-metric" id="metric-${st.id}"></p>
        </div>
        <figure class="stage-screen">
          <canvas id="chain-${st.id}" aria-label="${st.name} output"></canvas>
        </figure>
      </article>`).join('')}
  </div>

  <p class="figure-note">
    <span class="key key-ghost"></span>what arrived from the stage above
    <span class="key key-a"></span>analog
    <span class="key key-c"></span>after the front end
    <span class="key key-b"></span>digital
  </p>`;
}

/* ------------------------------------------------------------------ *
 * Lane drawing
 * ------------------------------------------------------------------ */

function laneBox(w, h) { return { x: 6, y: 6, w: w - 12, h: h - 12 }; }

function drawStageLane(id, m) {
  const s = surface($(`#chain-${id}`));
  if (!s) return;
  const { ctx, w, h } = s;
  const c = colors();
  const box = laneBox(w, h);
  const yOf = (v) => box.y + box.h / 2 - (v / FULL_SCALE) * (box.h / 2);
  const xOf = (t) => box.x + (t / m.duration) * box.w;

  graticule(ctx, box, 10, 4);
  centreLine(ctx, box);

  const { ideal, afe, aa } = m.nodes;
  const bypassed = (id === 'afe' && !m.s.afeOn)
    || (id === 'aa' && !m.s.aaOn)
    || (id === 'adc' && !m.s.adcOn)
    || (id === 'recon' && (!m.s.reconOn || !m.s.adcOn));

  const ghostOf = { src: null, afe: ideal, aa: afe, adc: aa, recon: ideal };
  const nodeOf = { src: ideal, afe, aa, adc: aa, recon: null };
  const tintOf = { src: c.a, afe: c.c, aa: c.c, adc: c.b, recon: c.b };

  if (ghostOf[id]) {
    strokeTrace(ctx, analogTrace(ghostOf[id], m.duration, box.w), box, yOf, c.ghost, 1.2);
  }

  if (id === 'adc') {
    if (m.rec.v.length) drawSamples(ctx, m, box, xOf, yOf, c);
  } else if (id === 'recon') {
    if (!bypassed && m.rec.v.length > 1) {
      const mode = m.outMode;
      ctx.strokeStyle = c.b;
      ctx.lineWidth = 1.9;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const step = mode === 'sinc' ? 1 : 0.5;
      for (let px = 0; px <= box.w; px += step) {
        const y = yOf(reconstruct(m.rec, (px / box.w) * m.duration, mode));
        if (px === 0) ctx.moveTo(box.x + px, y); else ctx.lineTo(box.x + px, y);
      }
      ctx.stroke();
    } else if (!m.s.adcOn) {
      strokeTrace(ctx, analogTrace(aa, m.duration, box.w), box, yOf, c.b, 1.8);
    } else if (m.rec.v.length) {
      drawSamples(ctx, m, box, xOf, yOf, c);
    }
  } else if (nodeOf[id]) {
    // A bypassed stage draws its input in the ghost tint, so a lane that changed
    // nothing looks like one that changed nothing.
    strokeTrace(ctx, analogTrace(nodeOf[id], m.duration, box.w), box, yOf,
      bypassed ? c.ghost : tintOf[id], bypassed ? 1.4 : 1.7);
  }

  if (bypassed) {
    label(ctx, 'bypassed \u2014 signal passes through unchanged', box.x + 8, box.y + box.h - 18, c.text, 10);
  }
}

function drawSamples(ctx, m, box, xOf, yOf, c) {
  const { t, v } = m.rec;
  const dense = t.length > 320;
  ctx.fillStyle = dense ? c.b : '#e8fffd';
  ctx.strokeStyle = c.b;
  ctx.lineWidth = 1.1;
  if (!dense) {
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let i = 0; i < t.length; i++) {
      if (t[i] > m.duration) break;
      const x = xOf(t[i]);
      ctx.moveTo(x, yOf(0));
      ctx.lineTo(x, yOf(v[i]));
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (let i = 0; i < t.length; i++) {
    if (t[i] > m.duration) break;
    const x = xOf(t[i]);
    const y = yOf(v[i]);
    if (dense) { ctx.fillRect(x - 0.6, y - 0.6, 1.5, 1.5); continue; }
    ctx.beginPath();
    ctx.arc(x, y, 2.7, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ *
 * Stage readouts
 * ------------------------------------------------------------------ */

function stageMetrics(m) {
  const s = m.s;
  const { ideal, afe, aa } = m.nodes;
  const top = ideal.reduce((k, c) => (Math.abs(c.a) > 0.02 * Math.abs(ideal[0].a) ? Math.max(k, c.f) : k), 0);
  const out = {};

  out.src = `${ideal.length} component${ideal.length > 1 ? 's' : ''} \u00b7 highest ${fmtFreq(top)} \u00b7 edge ${fmtSec((s.edge / 100) / s.freq)}`;

  if (!s.afeOn) out.afe = 'switched out \u2014 infinite bandwidth, which no instrument has';
  else {
    const e = m.afeError;
    out.afe = `${(100 * e.ampRatio).toFixed(1)}% peak-to-peak \u00b7 ${(100 * e.rmsRel).toFixed(1)}% shape error \u00b7 t_r ${fmtSec(m.edge.rise)}${m.edge.overshoot > 0.005 ? ` \u00b7 ${(100 * m.edge.overshoot).toFixed(0)}% overshoot` : ''}`;
  }

  if (!s.aaOn) {
    out.aa = m.folding.length
      ? `switched out \u2014 ${m.folding.length} component${m.folding.length > 1 ? 's are' : ' is'} above ${fmtFreq(m.nyq)} and will fold`
      : 'switched out \u2014 nothing above Nyquist reaches the sampler anyway';
  } else {
    const removed = afe.length - aa.length;
    out.aa = `cutoff ${fmtFreq(m.aaCutoff)} (${s.aaCut.toFixed(2)} \u00d7 fs/2) \u00b7 ${(100 * m.aaPower).toFixed(1)}% of the power passed${removed > 0 ? ` \u00b7 ${removed} component${removed > 1 ? 's' : ''} gone` : ''}`;
  }

  if (!s.adcOn) out.adc = 'switched out \u2014 the chain stays analog all the way through';
  else {
    const lsb = s.bits ? (2 * FULL_SCALE) / 2 ** s.bits : 0;
    out.adc = `${fmtRate(m.fs)}${m.memLimited ? ` (memory limited from ${fmtRate(m.fsSet)})` : ''} \u00b7 ${m.rec.v.length} points \u00b7 ${isFinite(m.spc) ? m.spc.toFixed(2) : '\u221e'} per period${s.bits ? ` \u00b7 LSB ${fmtVolt(lsb)}` : ' \u00b7 no quantisation'}`;
  }

  if (!s.adcOn) out.recon = 'nothing to reconstruct \u2014 the signal never left the analog domain';
  else if (!s.reconOn) out.recon = 'switched out \u2014 the record is only the points, with nothing claimed in between';
  else {
    const err = endToEnd(m);
    const meas = m.spec ? peakFrequency(m.spec) : null;
    out.recon = `reports ${meas && meas.f > 0 ? fmtFreq(meas.f) : 'DC'} \u00b7 ${(100 * err).toFixed(1)}% rms error against the source`;
  }
  return out;
}

// End-to-end error between the source and whatever comes out of the chain.
function endToEnd(m, n = 900) {
  let se = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * m.duration;
    const a = evaluate(m.nodes.ideal, t);
    const b = m.s.adcOn && m.s.reconOn
      ? reconstruct(m.rec, t, m.outMode)
      : evaluate(m.nodes.aa, t);
    se += (b - a) ** 2;
    sq += a * a;
  }
  return sq > 0 ? Math.sqrt(se / sq) : 0;
}

/* ------------------------------------------------------------------ *
 * Chain wiring
 * ------------------------------------------------------------------ */

let chainBuilt = false;

export function initChain() {
  const host = $('#view-chain');
  if (!host || chainBuilt) return;
  chainBuilt = true;
  host.innerHTML = chainMarkup();

  const bindLog = (id, key) => $(id).addEventListener('input', (e) => patch({ [key]: fromSlider(key, e.target.value) }));
  const bindNum = (id, key) => $(id).addEventListener('input', (e) => patch({ [key]: Number(e.target.value) }));

  bindLog('#cFreq', 'freq');
  bindLog('#cBw', 'bw');
  bindLog('#cFs', 'fs');
  bindLog('#cMem', 'mem');
  bindLog('#cWindow', 'window');
  bindNum('#cAmp', 'amp');
  bindNum('#cEdge', 'edge');
  bindNum('#cAaCut', 'aaCut');
  bindNum('#cBits', 'bits');
  bindNum('#cOffset', 'offset');
  $('#cWave').addEventListener('change', (e) => patch({ waveform: e.target.value }));
  $('#cResp').addEventListener('change', (e) => patch({ resp: e.target.value }));
  $('#cAaResp').addEventListener('change', (e) => patch({ aaResp: e.target.value }));
  $$('input[name=crecon]').forEach((r) => r.addEventListener('change', () => r.checked && patch({ recon: r.value })));
  for (const st of STAGE_UI) {
    if (st.always) continue;
    $(`#sw-${st.id}`).addEventListener('change', (e) => patch({ [st.flag]: e.target.checked }));
  }
  $('#cFit').addEventListener('click', () => patch({ window: fitWindow() }));

  STAGE_UI.forEach((st) => observeResize($(`#chain-${st.id}`), () => chainVisible() && renderChain(state)));
  subscribe((s) => { if (chainVisible()) renderChain(s); });
}

export function fitWindow() {
  const m = build(state);
  const reported = m.predicted.f > state.freq / 40 ? m.predicted.f : state.freq;
  return Math.min(1, Math.max(1e-11, 5 / reported));
}

const chainVisible = () => $('#view-chain')?.classList.contains('is-on');

export function renderChain(s) {
  if (!chainBuilt) return;
  const m = build(s);

  $('#cWave').value = s.waveform;
  $('#cResp').value = s.resp;
  $('#cAaResp').value = s.aaResp;
  $('#cFreq').value = toSlider('freq', s.freq);
  $('#cBw').value = toSlider('bw', s.bw);
  $('#cFs').value = toSlider('fs', s.fs);
  $('#cMem').value = toSlider('mem', s.mem);
  $('#cWindow').value = toSlider('window', s.window);
  $('#cAmp').value = s.amp;
  $('#cEdge').value = s.edge;
  $('#cAaCut').value = s.aaCut;
  $('#cBits').value = s.bits;
  $('#cOffset').value = s.offset;
  const r = $(`input[name=crecon][value="${s.recon}"]`);
  if (r) r.checked = true;

  $('#cFreqOut').value = fmtFreq(s.freq);
  $('#cAmpOut').value = `${s.amp.toFixed(2)} V`;
  $('#cEdgeOut').value = `${s.edge}% of period \u00b7 ${fmtSec((s.edge / 100) / s.freq)}`;
  $('#cBwOut').value = fmtFreq(s.bw);
  $('#cAaCutOut').value = fmtFreq(m.aaCutoff);
  $('#cFsOut').value = fmtRate(s.fs);
  $('#cBitsOut').value = s.bits ? `${s.bits} bit` : 'not quantised';
  $('#cOffsetOut').value = `${s.offset}% of Ts`;
  $('#cMemOut').value = fmtPoints(s.mem);
  $('#cWindowOut').value = fmtSec(s.window);

  for (const st of STAGE_UI) {
    if (st.always) continue;
    const sw = $(`#sw-${st.id}`);
    if (sw) sw.checked = s[st.flag];
    $(`#stage-${st.id}`).classList.toggle('is-out', !s[st.flag]);
  }
  $('#stage-recon').classList.toggle('is-out', !s.reconOn || !s.adcOn);

  const metrics = stageMetrics(m);
  for (const st of STAGE_UI) {
    $(`#metric-${st.id}`).textContent = metrics[st.id];
    drawStageLane(st.id, m);
  }

  const flags = [];
  if (m.memLimited) flags.push(`Record length holds this window at ${fmtRate(m.fs)}, not the ${fmtRate(m.fsSet)} set on the sampler.`);
  if (m.capped) flags.push(`${fmtSec(m.requested)} at ${fmtRate(m.fs)} would be ${m.wanted.toLocaleString()} points; the screen is showing ${fmtSec(m.duration)}.`);
  if (!s.afeOn && !s.aaOn && m.folding.length) flags.push(`${m.folding.length} components are above ${fmtFreq(m.nyq)} with nothing in front of the sampler to stop them.`);
  $('#chainFlag').textContent = flags.join(' ');
}

/* ================================================================== *
 * View 2 — the front end on its own
 * ================================================================== */

function frontMarkup() {
  return `
  <div class="stage-head">
    <h2>What the front end does before anything is sampled</h2>
    <p>Amber is the waveform the generator produced. Violet is what reaches the sampler after the analog path.
       The shaded area between them is the part of the signal that never gets to the converter at all &mdash; no
       sample rate recovers it, because it is gone before sampling happens.</p>
  </div>

  <div class="front">
    <div class="front-main">
      <figure class="screen screen-front">
        <canvas id="feTrace" aria-label="Source waveform and the same waveform after the analog front end"></canvas>
      </figure>
      <div class="front-pair">
        <figure class="screen screen-edge">
          <canvas id="feEdge" aria-label="One edge, zoomed, with ten and ninety percent markers"></canvas>
        </figure>
        <figure class="screen screen-edge">
          <canvas id="feResp" aria-label="Front end magnitude response with the waveform's harmonics"></canvas>
        </figure>
      </div>
      <p class="figure-note">
        <span class="key key-a"></span>generator output
        <span class="key key-c"></span>at the sampler
        <span class="key key-nyq"></span>&minus;3 dB corner
      </p>
      <dl class="measure" id="feMeasure">
        <div><dt>Peak-to-peak vs source</dt><dd id="feAmp"></dd></div>
        <div><dt>Rise, front end alone</dt><dd id="feRiseF"></dd></div>
        <div class="is-key"><dt>Rise, measured on the edge</dt><dd id="feRiseM"></dd></div>
        <div><dt>Root-sum-square prediction</dt><dd id="feRiseP"></dd></div>
        <div><dt>Delay through the front end</dt><dd id="feDelay"></dd></div>
        <div><dt>Shape error, de-skewed</dt><dd id="feErr"></dd></div>
      </dl>
      <p class="fieldnote" id="feNote"></p>
    </div>

    <form class="controls front-controls" autocomplete="off">
      <fieldset>
        <legend>Signal</legend>
        <div class="select-row"><label for="feWave">Waveform</label>
          <select id="feWave">${waveOptions()}</select></div>
        <div class="knob"><label for="feFreq">Frequency</label><output id="feFreqOut"></output>
          <input id="feFreq" type="range" min="0" max="1000" step="1"></div>
        <div class="knob"><label for="feEdgeIn">Generator edge rate</label><output id="feEdgeOut"></output>
          <input id="feEdgeIn" type="range" min="0.3" max="25" step="0.1"></div>
      </fieldset>
      <fieldset>
        <legend>Front end</legend>
        <div class="knob is-primary"><label for="feBw">Bandwidth</label><output id="feBwOut"></output>
          <input id="feBw" type="range" min="0" max="1000" step="1"></div>
        <div class="select-row"><label for="feResponse">Response</label>
          <select id="feResponse">${respOptions()}</select></div>
        <p class="fieldnote" id="feRespNote"></p>
        <label class="switch"><input type="checkbox" id="feOn"><span>Front end in circuit</span></label>
      </fieldset>
      <fieldset>
        <legend>Bandwidth against this signal</legend>
        <div class="ratio-rail" id="feRatio"></div>
        <p class="fieldnote">Set the bandwidth as a multiple of the signal frequency. The rule of thumb for a
          square wave is five times the fundamental for a usable edge, ten for a trustworthy one.</p>
      </fieldset>
    </form>
  </div>

  <dl class="notes notes-tight">
    <div>
      <dt>Bandwidth is not a wall</dt>
      <dd>The &minus;3 dB point is where a sine comes back at 70.7% of its real amplitude, not where the instrument
        stops working. A harmonic at half the bandwidth is already being shortened; one at twice the bandwidth is
        not gone, just small and late.</dd>
    </div>
    <div>
      <dt>Rise times add in quadrature</dt>
      <dd>An edge measured through a band-limited path is roughly the root sum of squares of the signal&rsquo;s own edge
        and the instrument&rsquo;s. The readout above measures the edge on the actual waveform and shows the prediction
        beside it. They agree to a few percent for single-pole and Gaussian responses, and stop agreeing once the
        response overshoots or the front end is narrow enough to be removing harmonics rather than shaping them.</dd>
    </div>
    <div>
      <dt>Phase does the shape damage</dt>
      <dd>Attenuating every harmonic equally would only make the waveform smaller. It is the frequency-dependent
        delay that moves harmonics relative to each other and turns a corner into a curve. Switch between the
        response shapes with a square wave running and watch the flat top change while the amplitude barely moves.</dd>
    </div>
    <div>
      <dt>This is the loss you cannot sample your way out of</dt>
      <dd>Everything on this page happens before the converter. Sample rate, memory depth and interpolation all
        operate on whatever is left after the front end, which is why a fast ADC behind a slow front end buys
        nothing but points.</dd>
    </div>
  </dl>`;
}

const RATIOS = [1, 2, 3, 5, 10, 20, 50];
let frontBuilt = false;

export function initFront() {
  const host = $('#view-front');
  if (!host || frontBuilt) return;
  frontBuilt = true;
  host.innerHTML = frontMarkup();
  $('#feRatio').innerHTML = RATIOS
    .map((r) => `<button type="button" class="chip ratio" data-ratio="${r}">${r}\u00d7</button>`).join('');

  $('#feWave').addEventListener('change', (e) => patch({ waveform: e.target.value }));
  $('#feResponse').addEventListener('change', (e) => patch({ resp: e.target.value }));
  $('#feFreq').addEventListener('input', (e) => patch({ freq: fromSlider('freq', e.target.value) }));
  $('#feBw').addEventListener('input', (e) => patch({ bw: fromSlider('bw', e.target.value) }));
  $('#feEdgeIn').addEventListener('input', (e) => patch({ edge: Number(e.target.value) }));
  $('#feOn').addEventListener('change', (e) => patch({ afeOn: e.target.checked }));
  $$('#feRatio .ratio').forEach((b) => b.addEventListener('click', () => {
    patch({ bw: Number(b.dataset.ratio) * state.freq, afeOn: true });
  }));

  ['#feTrace', '#feEdge', '#feResp'].forEach((sel) => observeResize($(sel), () => frontVisible() && renderFront(state)));
  subscribe((s) => { if (frontVisible()) renderFront(s); });
}

const frontVisible = () => $('#view-front')?.classList.contains('is-on');

export function renderFront(s) {
  if (!frontBuilt) return;
  const m = build(s);
  const { ideal, afe } = m.nodes;

  $('#feWave').value = s.waveform;
  $('#feResponse').value = s.resp;
  $('#feFreq').value = toSlider('freq', s.freq);
  $('#feBw').value = toSlider('bw', s.bw);
  $('#feEdgeIn').value = s.edge;
  $('#feOn').checked = s.afeOn;
  $('#feFreqOut').value = fmtFreq(s.freq);
  $('#feBwOut').value = `${fmtFreq(s.bw)} \u00b7 ${(s.bw / s.freq).toFixed(1)}\u00d7 f`;
  $('#feEdgeOut').value = `${s.edge}% \u00b7 ${fmtSec((s.edge / 100) / s.freq)}`;
  $('#feRespNote').textContent = RESPONSE_NOTE[s.resp];
  $$('#feRatio .ratio').forEach((b) => {
    b.classList.toggle('is-on', Math.abs(Number(b.dataset.ratio) * s.freq - s.bw) < s.freq * 0.05);
  });

  drawFrontTrace(m);
  const edge = drawEdge(m);
  drawFrontResponse(m);

  const e = m.afeError || { ampRatio: 1, rmsRel: 0 };
  const srcRise = edge.src.rise;
  const predicted = Math.sqrt(srcRise ** 2 + m.edge.rise ** 2);
  $('#feAmp').textContent = `${(100 * e.ampRatio).toFixed(1)}%`;
  $('#feRiseF').textContent = s.afeOn ? fmtSec(m.edge.rise) : 'no limit';
  $('#feRiseM').textContent = Number.isFinite(edge.out.rise) ? fmtSec(edge.out.rise) : 'no edge';
  $('#feRiseP').textContent = s.afeOn ? fmtSec(predicted) : fmtSec(srcRise);
  $('#feDelay').textContent = s.afeOn ? fmtSec(m.delay) : 'none';
  $('#feErr').textContent = `${(100 * e.rmsRel).toFixed(1)}% rms`;
  $('#feMeasure .is-key').classList.toggle('is-clean', e.ampRatio > 0.97);

  const harmonics = ideal.filter((c) => Math.abs(c.a) > 0.02 * Math.abs(ideal[0].a));
  const kept = harmonics.filter((c) => responseAt(s.resp, c.f, s.bw).m > 0.707).length;
  $('#feNote').textContent = s.afeOn
    ? `${kept} of ${harmonics.length} significant components arrive within 3 dB of full size. `
      + `Everything above ${fmtFreq(s.bw)} is still present, only smaller and later.`
    : 'Front end switched out. Nothing between the generator and the sampler, which is a condition no instrument has.';
}

function drawFrontTrace(m) {
  const s = surface($('#feTrace'));
  if (!s) return;
  const { ctx, w, h } = s;
  const c = colors();
  const box = { x: 10, y: 10, w: w - 20, h: h - 20 };
  const span = Math.max(1.15 * m.s.amp * 1.35, 0.3);
  const yOf = (v) => box.y + box.h / 2 - (v / span) * (box.h / 2);
  const duration = 2 / m.s.freq;

  graticule(ctx, box, 10, 8);
  centreLine(ctx, box);

  const n = box.w;
  const a = new Float64Array(n + 1);
  const b = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * duration;
    a[i] = evaluate(m.nodes.ideal, t);
    b[i] = evaluate(m.nodes.afe, t + m.delay);
  }

  // the part that never reaches the sampler
  ctx.beginPath();
  for (let i = 0; i <= n; i++) { const x = box.x + i; const y = yOf(a[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  for (let i = n; i >= 0; i--) ctx.lineTo(box.x + i, yOf(b[i]));
  ctx.closePath();
  ctx.fillStyle = 'rgba(226,87,74,0.18)';
  ctx.fill();

  const line = (arr, colour, width) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const x = box.x + i; const y = yOf(arr[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  };
  line(a, c.a, 1.5);
  line(b, c.c, 2.1);

  label(ctx, 'generator', box.x + 8, box.y + 6, c.a);
  label(ctx, `at the sampler${Math.abs(m.delay) > duration * 5e-4 ? `, de-skewed ${fmtSec(m.delay)}` : ''}`,
    box.x + 8, box.y + 20, c.c);
  label(ctx, `${fmtSec(duration / 10)}/div`, box.x + box.w - 8, box.y + 6, c.text, 10.5, 'right');
}

function drawEdge(m) {
  const canvas = $('#feEdge');
  const s = surface(canvas);
  const { ideal, afe } = m.nodes;
  const ref = levelsOf(ideal, m.s.freq);
  const centre = steepestRise(ideal, m.s.freq);
  // Locate the transition over half a period first, because a sine takes about
  // 0.29 of a period to go 10% to 90% and a fast square takes a thousandth of
  // one. Then re-measure inside a window sized to what was found.
  const wide = 0.5 / m.s.freq;
  const rough = Math.max(
    measureRise(ideal, m.s.freq, centre.t, ref, wide).rise || 0,
    measureRise(afe, m.s.freq, centre.t + m.delay, ref, wide).rise || 0,
    1 / (m.s.freq * 500),
  );
  const span = rough * 1.9;
  const src = measureRise(ideal, m.s.freq, centre.t, ref, span);
  const outRaw = measureRise(afe, m.s.freq, centre.t + m.delay, ref, span);
  // reported on the source's time base, with the bulk delay taken out
  const out = { ...outRaw, t10: outRaw.t10 - m.delay, t90: outRaw.t90 - m.delay };
  if (!s) return { src, out };

  const { ctx, w, h } = s;
  const c = colors();
  const box = { x: 34, y: 10, w: w - 44, h: h - 30 };
  const vSpan = (ref.hi - ref.lo) * 0.78;
  const mid = (ref.hi + ref.lo) / 2;
  const yOf = (v) => box.y + box.h / 2 - ((v - mid) / vSpan) * (box.h / 2);
  const t0 = centre.t - span;
  const xOf = (t) => box.x + ((t - t0) / (2 * span)) * box.w;

  graticule(ctx, box, 8, 4);

  for (const [lvl, text] of [[src.l10, '10%'], [src.l90, '90%']]) {
    const y = Math.round(yOf(lvl)) + 0.5;
    ctx.strokeStyle = c.axis;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, text, 4, y - 6, c.text, 9.5);
  }

  const line = (comps, colour, width, skew) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let px = 0; px <= box.w; px++) {
      const t = t0 + (px / box.w) * 2 * span;
      const y = yOf(evaluate(comps, t + skew));
      px ? ctx.lineTo(box.x + px, y) : ctx.moveTo(box.x + px, y);
    }
    ctx.stroke();
  };
  line(ideal, c.a, 1.4, 0);
  line(afe, c.c, 2, m.delay);

  if (Number.isFinite(out.rise)) {
    ctx.strokeStyle = c.b;
    ctx.lineWidth = 1.2;
    for (const t of [out.t10, out.t90]) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + box.h);
      ctx.stroke();
    }
    label(ctx, `t_r ${fmtSec(out.rise)}`, box.x + box.w - 6, box.y + 4, c.b, 10.5, 'right');
  }
  label(ctx, 'one edge, zoomed', box.x + 6, box.y + 4, c.text, 10);
  label(ctx, `${fmtSec((2 * span) / 8)}/div`, box.x + 6, box.y + box.h + 6, c.text, 9.5);
  return { src, out };
}

function drawFrontResponse(m) {
  const s = surface($('#feResp'));
  if (!s) return;
  const { ctx, w, h } = s;
  const c = colors();
  const box = { x: 34, y: 10, w: w - 44, h: h - 32 };
  const lo = m.s.freq / 4;
  const hi = Math.max(m.s.bw * 12, m.s.freq * 200);
  const ax = logAxis(lo, hi, box.x, box.w);
  const dbLo = -48;
  const yOf = (d) => box.y + box.h * (1 - (Math.max(d, dbLo) - dbLo) / (6 - dbLo));

  ctx.strokeStyle = c.grat;
  ctx.lineWidth = 1;
  mono(ctx, 9);
  ctx.textAlign = 'right';
  for (let d = 0; d >= dbLo; d -= 12) {
    const y = Math.round(yOf(d)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.fillStyle = c.text;
    ctx.fillText(`${d}`, box.x - 6, y + 3);
  }
  ctx.textAlign = 'left';
  decadeTicks(ctx, ax, box, 'Hz', false);

  // harmonics, coloured by how much of each survives
  const { ideal } = m.nodes;
  let peak = 0;
  for (const k of ideal) peak = Math.max(peak, Math.abs(k.a));
  for (const k of ideal) {
    if (Math.abs(k.a) < 0.015 * peak || k.f > hi) continue;
    const x = Math.round(ax.of(k.f)) + 0.5;
    const mag = m.s.afeOn ? responseAt(m.s.resp, k.f, m.s.bw).m : 1;
    const top = yOf(dB(Math.abs(k.a) / peak));
    ctx.strokeStyle = mag > 0.707 ? c.a : c.fold;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, box.y + box.h);
    ctx.lineTo(x, top);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (m.s.afeOn) {
    ctx.strokeStyle = c.c;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px <= box.w; px++) {
      const f = ax.inv(box.x + px);
      const y = yOf(dB(responseAt(m.s.resp, f, m.s.bw).m));
      px ? ctx.lineTo(box.x + px, y) : ctx.moveTo(box.x + px, y);
    }
    ctx.stroke();

    const xb = Math.round(ax.of(m.s.bw)) + 0.5;
    ctx.strokeStyle = c.nyq;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(xb, box.y);
    ctx.lineTo(xb, box.y + box.h);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  label(ctx, 'front end response', box.x + 6, box.y + 4, c.text, 10);
  label(ctx, 'dB', 4, box.y, c.text, 9);
}
