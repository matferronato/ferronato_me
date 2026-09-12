// model.mjs — turns the control state into the signal at every node of the
// acquisition chain. No DOM, so `node tests.mjs` exercises the same path the
// browser draws.

import {
  source, frontEnd, brickwall, evaluate, sampleRecord, reconstruct,
  spectrumRecord, alias, samplesPerCycle, effectiveRate, edgeResponse,
  traceError, passedPower, foldingComponents, responseAt, prune, groupShift,
} from './dsp.mjs';

export const FULL_SCALE = 2.5;   // volts, +/- full scale of the modelled ADC
export const MAX_POINTS = 24001; // drawing limit, not a physical one

// The five nodes, in order. `id` is what the bypass switches address.
export const STAGES = [
  { id: 'src',   name: 'Source',            short: 'source' },
  { id: 'afe',   name: 'Analog front end',  short: 'front end' },
  { id: 'aa',    name: 'Anti-alias filter', short: 'anti-alias' },
  { id: 'adc',   name: 'Sample and hold',   short: 'ADC' },
  { id: 'recon', name: 'Reconstruction',    short: 'reconstruction' },
];

/* ------------------------------------------------------------------ *
 * The chain
 * ------------------------------------------------------------------ */

export function build(s) {
  const duration = s.window;

  // 1. what the generator actually puts out, edges and all
  const ideal = source(s.waveform, s.freq, s.amp, s.phase, s.edge / 100);

  // 2. the analog front end
  const afe = s.afeOn ? frontEnd(ideal, s.bw, s.resp) : ideal;

  // 3. sample rate first, because the anti-alias cutoff is tied to it, and
  //    because deep zoom-outs make the scope drop its rate to fit memory
  const fsSet = s.fs;
  const fs = s.adcOn ? effectiveRate(fsSet, s.mem, duration) : fsSet;
  const memLimited = fs < fsSet - 1e-6;
  const nyq = fs / 2;

  // 4. anti-alias filter, referenced to the rate the sampler is really running
  const aaCutoff = s.aaCut * nyq;
  let aa = afe;
  if (s.aaOn) {
    aa = s.aaResp === 'brick'
      ? brickwall(afe, aaCutoff)
      : prune(frontEnd(afe, aaCutoff, s.aaResp), 1e-3);
  }

  // 5. sampling and quantisation
  const wanted = Math.floor(duration * fs) + 1;
  const capped = s.adcOn && wanted > MAX_POINTS;
  // The model draws at most MAX_POINTS. Rather than show a record covering a
  // sliver of the window, shorten the window to what those points cover and say
  // so; the alternative would be to fake a lower sample rate, which would change
  // the physics being demonstrated.
  const shown = capped ? MAX_POINTS / fs : duration;
  const rec = s.adcOn
    ? sampleRecord(aa, {
      fs,
      duration: shown,
      offsetFrac: s.offset / 100,
      bits: s.bits,
      fullScale: FULL_SCALE,
    })
    : { t: new Float64Array(0), v: new Float64Array(0), Ts: 1 / fs, t0: 0 };

  const spec = rec.v.length ? spectrumRecord(rec) : null;

  // 6. what comes out the far side
  const outMode = !s.adcOn ? 'analog' : s.reconOn ? s.recon : 'none';

  const folding = foldingComponents(aa, fs);
  const errorWindow = Math.min(shown, 8 / Math.max(s.freq, 1e-12));
  const delay = s.afeOn ? groupShift(s.resp, s.freq, s.bw) : 0;
  const predicted = alias(s.freq, fs);
  const spc = samplesPerCycle(s.freq, fs);

  return {
    s,
    duration: shown,
    requested: duration,
    nodes: { ideal, afe, aa },
    rec,
    spec,
    fs,
    fsSet,
    memLimited,
    nyq,
    aaCutoff,
    outMode,
    folding,
    predicted,
    spc,
    capped,
    wanted,
    edge: s.afeOn ? edgeResponse(s.resp, s.bw) : { rise: 0, riseBw: 0, overshoot: 0 },
    delay,
    // how much of the signal's own fundamental survived the analog path
    fundKept: (() => {
      if (!s.afeOn || !ideal.length) return 1;
      const at = (list) => list.reduce((b, c) => (Math.abs(c.f - s.freq) < Math.abs(b.f - s.freq) ? c : b), list[0]);
      const a = at(ideal); const b = at(afe);
      return Math.abs(a.a) > 1e-12 ? Math.abs(b.a) / Math.abs(a.a) : 1;
    })(),
    afeError: s.afeOn ? traceError(ideal, afe, errorWindow, { shift: delay }) : null,
    afePower: s.afeOn ? passedPower(ideal, afe) : 1,
    aaPower: s.aaOn ? passedPower(afe, aa) : 1,
  };
}

/* ------------------------------------------------------------------ *
 * Traces
 *
 * When the waveform is faster than the pixel grid the trace is drawn as a
 * per-column min/max envelope, the way peak detect works, so the picture on
 * screen never aliases while it is busy demonstrating aliasing.
 * ------------------------------------------------------------------ */

export function topFrequency(comps, floor = 0.08) {
  let peak = 0;
  for (const c of comps) peak = Math.max(peak, Math.abs(c.a));
  let top = 0;
  for (const c of comps) if (Math.abs(c.a) > floor * peak) top = Math.max(top, c.f);
  return top;
}

// Returns either {kind:'line', y:Float64Array} sampled at 2x pixel pitch, or
// {kind:'band', lo, hi} with one min/max pair per pixel column.
export function analogTrace(comps, duration, width) {
  const top = topFrequency(comps);
  const cyclesPerPixel = (top * duration) / Math.max(1, width);
  if (cyclesPerPixel < 0.35) {
    const n = width * 2 + 1;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = evaluate(comps, (i / (n - 1)) * duration);
    return { kind: 'line', y, n };
  }
  const sub = Math.min(28, Math.max(8, Math.ceil(cyclesPerPixel * 6)));
  const lo = new Float64Array(width + 1);
  const hi = new Float64Array(width + 1);
  for (let px = 0; px <= width; px++) {
    let a = Infinity;
    let b = -Infinity;
    for (let k = 0; k < sub; k++) {
      const v = evaluate(comps, ((px + k / sub) / width) * duration);
      if (v < a) a = v;
      if (v > b) b = v;
    }
    lo[px] = a;
    hi[px] = b;
  }
  return { kind: 'band', lo, hi, n: width + 1 };
}

export function reconTrace(rec, duration, width, mode) {
  const step = mode === 'sinc' ? 1 : 0.5;
  const n = Math.floor(width / step) + 1;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = reconstruct(rec, ((i * step) / width) * duration, mode);
  return { y, n, step };
}

/* ------------------------------------------------------------------ *
 * Front-end response curve, for the magnitude plot
 * ------------------------------------------------------------------ */

export function responseCurve(kind, bw, fLo, fHi, n = 400) {
  const mag = new Float64Array(n);
  const freq = new Float64Array(n);
  const k = Math.log(fHi / fLo);
  for (let i = 0; i < n; i++) {
    const f = fLo * Math.exp((k * i) / (n - 1));
    freq[i] = f;
    mag[i] = responseAt(kind, f, bw).m;
  }
  return { freq, mag, n };
}
