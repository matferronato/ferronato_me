// dsp.mjs — pure signal-processing model for ScopeLab.
// No DOM access here so the same code runs in the browser and under `node tests.mjs`.

export const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Alias arithmetic
 * ------------------------------------------------------------------ */

// Frequency a sampler at fs reports for an input at f (first Nyquist zone).
// zone 1 = 0..fs/2, zone 2 = fs/2..fs (spectrum reversed), and so on.
export function alias(f, fs) {
  if (!(fs > 0)) return { f: 0, k: 0, zone: 1, folded: false, reversed: false };
  const k = Math.round(f / fs);
  const a = Math.abs(f - k * fs);
  const zone = Math.floor(f / (fs / 2) + 1e-12) + 1;
  return {
    f: a,
    k,
    zone,
    folded: Math.abs(a - f) > 1e-9,
    reversed: zone % 2 === 0,
  };
}

// Samples per cycle. Infinite for DC.
export const samplesPerCycle = (f, fs) => (f > 0 ? fs / f : Infinity);

/* ------------------------------------------------------------------ *
 * Signal definition: every waveform is a list of sinusoids.
 * A component is { f, a, p } with p in radians.
 * ------------------------------------------------------------------ */

export const WAVEFORMS = ['sine', 'square', 'triangle', 'sawtooth', 'twotone'];
export const TWOTONE_RATIO = 2.7;

// Harmonic content of the ideal (pre-filter) waveform.
// `maxHarmonic` bounds the series; the default resolves edges without
// generating thousands of terms.
export function components(waveform, f, amp, phaseDeg, maxHarmonic = 199) {
  const p = (phaseDeg * Math.PI) / 180;
  const out = [];
  switch (waveform) {
    case 'square':
      for (let n = 1; n <= maxHarmonic; n += 2)
        out.push({ f: n * f, a: ((4 / Math.PI) * amp) / n, p: n * p });
      break;
    case 'triangle':
      for (let n = 1; n <= maxHarmonic; n += 2)
        out.push({
          f: n * f,
          a: ((8 / Math.PI ** 2) * amp * (((n - 1) / 2) % 2 === 0 ? 1 : -1)) / (n * n),
          p: n * p,
        });
      break;
    case 'sawtooth':
      for (let n = 1; n <= maxHarmonic; n++)
        out.push({
          f: n * f,
          a: ((2 / Math.PI) * amp * (n % 2 === 1 ? 1 : -1)) / n,
          p: n * p,
        });
      break;
    case 'twotone':
      out.push({ f, a: 0.7 * amp, p });
      out.push({ f: f * TWOTONE_RATIO, a: 0.45 * amp, p: p * 0.3 });
      break;
    default:
      out.push({ f, a: amp, p });
  }
  return out.filter((c) => c.f > 0 && Math.abs(c.a) > 1e-6);
}

/* ------------------------------------------------------------------ *
 * Analog front end
 * ------------------------------------------------------------------ */

// Single-pole low-pass, -3 dB at `bw`. Applies magnitude AND phase, which is
// what rounds the corners of a square wave rather than just shrinking it.
export function lowpass1(comps, bw) {
  if (!(bw > 0) || !isFinite(bw)) return comps;
  return comps.map((c) => {
    const r = c.f / bw;
    return { f: c.f, a: c.a / Math.sqrt(1 + r * r), p: c.p - Math.atan(r) };
  });
}

// Ideal brick-wall anti-alias filter. Not physically realisable; it is here to
// show what a good front end buys you.
export function brickwall(comps, cutoff) {
  return comps.filter((c) => c.f < cutoff - 1e-9);
}

export function evaluate(comps, t) {
  let v = 0;
  for (const c of comps) v += c.a * Math.sin(TAU * c.f * t + c.p);
  return v;
}

/* ------------------------------------------------------------------ *
 * Sampling
 * ------------------------------------------------------------------ */

export function quantize(v, bits, fullScale) {
  if (!bits || bits >= 24) return v;
  const steps = 2 ** bits;
  const lsb = (2 * fullScale) / steps;
  const clamped = Math.max(-fullScale, Math.min(fullScale - lsb, v));
  return Math.round(clamped / lsb) * lsb;
}

// Sample `comps` over [0, duration] at fs, starting at offsetFrac * Ts.
export function sampleRecord(comps, { fs, duration, offsetFrac = 0, bits = 0, fullScale = 2.5 }) {
  const Ts = 1 / fs;
  const t0 = offsetFrac * Ts;
  const n = Math.floor((duration - t0) / Ts) + 1;
  const t = new Float64Array(Math.max(n, 0));
  const v = new Float64Array(Math.max(n, 0));
  for (let i = 0; i < n; i++) {
    const ti = t0 + i * Ts;
    t[i] = ti;
    v[i] = quantize(evaluate(comps, ti), bits, fullScale);
  }
  return { t, v, Ts, t0 };
}

/* ------------------------------------------------------------------ *
 * Reconstruction
 * ------------------------------------------------------------------ */

const sinc = (x) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

// Whittaker–Shannon interpolation truncated to +/- span samples and tapered
// with a Blackman window so the truncation does not ring.
export function sincAt(rec, time, span = 32) {
  const { t, v, Ts, t0 } = rec;
  if (!v.length) return 0;
  const centre = (time - t0) / Ts;
  const lo = Math.max(0, Math.ceil(centre - span));
  const hi = Math.min(v.length - 1, Math.floor(centre + span));
  let acc = 0;
  for (let i = lo; i <= hi; i++) {
    const d = centre - i;
    const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / span) + 0.08 * Math.cos((TAU * d) / span);
    acc += v[i] * sinc(d) * w;
  }
  return acc;
}

export function holdAt(rec, time) {
  const i = Math.floor((time - rec.t0) / rec.Ts);
  if (i < 0) return rec.v.length ? rec.v[0] : 0;
  return rec.v[Math.min(i, rec.v.length - 1)] ?? 0;
}

export function linearAt(rec, time) {
  const x = (time - rec.t0) / rec.Ts;
  const i = Math.floor(x);
  if (i < 0) return rec.v[0] ?? 0;
  if (i >= rec.v.length - 1) return rec.v[rec.v.length - 1] ?? 0;
  return rec.v[i] + (rec.v[i + 1] - rec.v[i]) * (x - i);
}

export function reconstruct(rec, time, mode) {
  if (mode === 'hold') return holdAt(rec, time);
  if (mode === 'linear') return linearAt(rec, time);
  return sincAt(rec, time);
}

/* ------------------------------------------------------------------ *
 * Spectra
 * ------------------------------------------------------------------ */

// In-place iterative radix-2 FFT. re/im are Float64Array of equal power-of-two length.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  return { re, im };
}

// Magnitude spectrum of a freshly taken record of N samples, Hann windowed.
// Returns bins 0..N/2 scaled so a full-amplitude sinusoid reads its amplitude.
export function spectrumOf(comps, { fs, n = 2048, offsetFrac = 0, bits = 0, fullScale = 2.5 }) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const Ts = 1 / fs;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((TAU * i) / n);
    wsum += w;
    re[i] = quantize(evaluate(comps, (i + offsetFrac) * Ts), bits, fullScale) * w;
  }
  fft(re, im);
  const half = n / 2;
  const mag = new Float64Array(half + 1);
  for (let i = 0; i <= half; i++) mag[i] = ((i === 0 || i === half ? 1 : 2) * Math.hypot(re[i], im[i])) / wsum;
  return { mag, df: fs / n, n };
}

// Peak bin with parabolic interpolation — the frequency a measuring instrument
// would actually report from this record.
export function peakFrequency(spec, floor = 1e-4) {
  const { mag, df } = spec;
  if (spec.constant !== undefined) return {f:0,amp:Math.abs(spec.constant)};
  if (mag.length < 3) return { f: 0, amp: mag[0] ?? 0 };
  let best = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > mag[best]) best = i;
  if (mag[best] < floor) return { f: 0, amp: mag[best] };
  if (best === 0 || best === mag.length - 1) return { f: best * df, amp: mag[best] };
  const a = mag[best - 1] ?? 0;
  const b = mag[best];
  const c = mag[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  const shift = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0;
  return { f: (best + shift) * df, amp: b };
}

/* ------------------------------------------------------------------ *
 * Verdict — how the sampled record should be read
 * ------------------------------------------------------------------ */

export function verdict({ comps, f, fs, waveform, antiAlias, bw = Infinity, fundKept = 1, shapeErr = 0 }) {
  const nyq = fs / 2;
  const spc = samplesPerCycle(f, fs);
  const above = comps.filter((c) => c.f >= nyq - 1e-9 && Math.abs(c.a) > 0.02);
  const fundamental = alias(f, fs);

  if (antiAlias && above.length === 0)
    return {
      level: 'ok',
      badge: 'filtered',
      headline: 'The anti-alias filter is doing its job.',
      body:
        'Everything at or above the Nyquist frequency was removed before the sampler, so nothing can fold back. ' +
        'The record is missing the filtered harmonics, but the frequencies it does contain are true.',
    };

  if (Math.abs(f - fs) < fs * 1e-6)
    return {
      level: 'bad',
      badge: 'f = fs',
      headline: 'One sample per cycle. The trace can flatline.',
      body:
        'The sampler visits the same point of every cycle, so the record can be a constant even though the input is ' +
        'swinging full scale. Shift the sample clock offset and watch the flat line move to a different level.',
    };

  if (f > nyq + 1e-9)
    return {
      level: 'bad',
      badge: 'f > fs/2',
      headline: `A ${fmtHz(f)} input reads as ${fmtHz(fundamental.f)}.`,
      body:
        `The fundamental sits in Nyquist zone ${fundamental.zone}, so it folds to ${fmtHz(fundamental.f)} and the ` +
        'record cannot tell the two apart. A longer record does not help. Raise the sample rate or filter the input.',
    };

  if (Math.abs(f - nyq) < fs * 0.002)
    return {
      level: 'warn',
      badge: 'f = fs/2',
      headline: 'Exactly two samples per cycle is a boundary, not a margin.',
      body:
        'Amplitude now depends entirely on where the samples land. Sweep the sample clock offset: the same input ' +
        'goes from full scale to nothing without the frequency changing.',
    };

  if (above.length)
    return {
      level: 'warn',
      badge: `${above.length} harmonic${above.length > 1 ? 's' : ''} folding`,
      headline: 'The fundamental is safe. Its harmonics are not.',
      body:
        `A ${waveform} wave is not one frequency. ${above.length} harmonics land above ${fmtHz(nyq)} and fold back ` +
        'into the record as tones that were never in the input. Edges and overshoot are the first things to lie.',
    };

  // Sampling is clean at this point, so anything still wrong with the record was
  // already wrong before the converter. Say so, rather than calling it faithful.
  if (fundKept < 0.97 || shapeErr > 0.08) {
    const lost = fundKept < 0.97;
    return {
      level: 'warn',
      badge: 'band limited',
      headline: lost
        ? `The front end alone takes the fundamental to ${(100 * fundKept).toFixed(0)}%.`
        : 'Nothing folds. The shape is still wrong.',
      body: lost
        ? `Sampling is clean, but a ${fmtHz(bw)} front end reaches this signal before the converter does and hands `
          + `over ${dB(fundKept).toFixed(1)} dB at the fundamental. No sample rate recovers that: it is gone before `
          + 'anything is sampled.'
        : `The fundamental passes intact, but a ${fmtHz(bw)} front end has already shortened the harmonics that `
          + `carry the edges, leaving ${(100 * shapeErr).toFixed(0)}% rms difference against the source. A faster `
          + 'converter behind a slow front end buys points, not bandwidth.',
    };
  }

  if (spc < 4)
    return {
      level: 'warn',
      badge: 'sparse',
      headline: 'Legal, but thinly described.',
      body:
        `At ${spc.toFixed(2)} samples per cycle the frequency survives, but peak amplitude and timing depend on ` +
        'how the samples happen to land and on the interpolator you trust to fill the gaps.',
    };

  return {
    level: 'ok',
    badge: 'f < fs/2',
    headline: 'The record represents the input.',
    body:
      `At ${spc.toFixed(1)} samples per cycle the sampled data carries the waveform, and band-limited ` +
      'interpolation reproduces it between the sample points.',
  };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function fmtHz(v) {
  if (!isFinite(v)) return '\u221e';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} MHz`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v >= 1e4 ? 1 : 2)} kHz`;
  return `${v.toFixed(v < 10 ? 1 : 0)} Hz`;
}

export function fmtSps(v) {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} MS/s`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v >= 1e4 ? 1 : 2)} kS/s`;
  return `${v.toFixed(0)} S/s`;
}

export function fmtTime(s) {
  if (s >= 1e-3) return `${(s * 1e3).toFixed(2)} ms`;
  if (s >= 1e-6) return `${(s * 1e6).toFixed(2)} \u00b5s`;
  return `${(s * 1e9).toFixed(0)} ns`;
}

// Spectrum of the actual displayed record; zero padding changes bin spacing,
// not the physical resolving power of the acquisition.
export function spectrumRecord(rec) {
  const count = rec.v.length;
  const n = 2 ** Math.ceil(Math.log2(Math.max(4, count)));
  const re = new Float64Array(n), im = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const w = count < 4 ? 1 : 0.5 - 0.5 * Math.cos(TAU * i / count);
    sum += w; re[i] = rec.v[i] * w;
  }
  fft(re, im);
  const mag = Float64Array.from({length:n / 2 + 1}, (_, i) =>
    (i === 0 || i === n / 2 ? 1 : 2) * Math.hypot(re[i], im[i]) / (sum || 1));
  const constant=count && rec.v.every(v=>Math.abs(v-rec.v[0])<1e-10)?rec.v[0]:undefined;
  return {mag, df:1 / (rec.Ts * n), n, count, constant, resolution:1 / (rec.Ts * Math.max(1,count))};
}

/* ================================================================== *
 * Front end response models
 *
 * Everything below is a function of f/bw only, so a response measured
 * once at bw = 1 scales to any bandwidth.
 * ================================================================== */

export const RESPONSES = ['onepole', 'gaussian', 'maxflat', 'brick'];

export const RESPONSE_LABEL = {
  onepole:  'Single pole',
  gaussian: 'Gaussian',
  maxflat:  'Maximally flat',
  brick:    'Brick wall',
};

export const RESPONSE_NOTE = {
  onepole:  'One RC pole. Gentle 20 dB/decade roll-off that starts early, so harmonics well below the -3 dB point are already shrinking. No overshoot, but a lot of phase shift.',
  gaussian: 'Gaussian magnitude with linear phase. The classic sub-GHz scope front end: nothing rings, nothing overshoots, and an edge is only ever slower than the real one.',
  maxflat:  'Four-pole maximally flat. Passband is honest right up to the corner, then falls fast — at the price of overshoot and ringing on a fast edge. What most multi-GHz front ends do.',
  brick:    'An ideal filter, not a buildable one. Perfect in band, nothing out of band, and Gibbs ringing on every edge as the price.',
};

// Butterworth of order n, normalised so the -3 dB point is at r = 1.
// Magnitude is the textbook form; phase comes from the pole product, which
// is what puts real group delay and overshoot into the step response.
function butterworth(r, n) {
  let ph = 0;
  for (let k = 1; k <= n; k++) {
    const th = (Math.PI * (2 * k + n - 1)) / (2 * n);
    const pr = Math.cos(th);
    const pi = Math.sin(th);
    ph += Math.atan2(-pi, -pr) - Math.atan2(r - pi, -pr);
  }
  return { m: 1 / Math.sqrt(1 + r ** (2 * n)), ph };
}

// Complex response of the modelled front end at one frequency.
export function responseAt(kind, f, bw) {
  if (!(bw > 0) || !isFinite(bw)) return { m: 1, ph: 0 };
  const r = Math.abs(f) / bw;
  switch (kind) {
    case 'gaussian':
      // exp(-ln2/2 * r^2) is -3.01 dB at r = 1. Linear phase, so no shape error.
      return { m: Math.exp((-Math.LN2 / 2) * r * r), ph: 0 };
    case 'maxflat':
      return butterworth(r, 4);
    case 'brick':
      return { m: r < 1 ? 1 : 0, ph: 0 };
    default: {
      const m = 1 / Math.sqrt(1 + r * r);
      return { m, ph: -Math.atan(r) };
    }
  }
}

// Apply the front end to a component list. Magnitude AND phase, which is what
// changes the shape of an edge rather than only its height.
export function frontEnd(comps, bw, kind = 'onepole') {
  if (!(bw > 0) || !isFinite(bw)) return comps;
  const out = [];
  for (const c of comps) {
    const { m, ph } = responseAt(kind, c.f, bw);
    if (m < 1e-7) continue;
    out.push({ f: c.f, a: c.a * m, p: c.p + ph });
  }
  return out;
}

// Time shift the response applies at one frequency. A filter with real group
// delay moves the whole waveform later; an instrument triggers on the signal, so
// that bulk shift is not an error and should not be counted as one.
export function groupShift(kind, f, bw) {
  if (!(f > 0) || !(bw > 0) || !isFinite(bw)) return 0;
  return -responseAt(kind, f, bw).ph / (TAU * f);
}

/* ------------------------------------------------------------------ *
 * Step response, measured rather than asserted
 * ------------------------------------------------------------------ */

// A square wave whose period is long compared with the transition, used as a
// stand-in for a step. Truncated at 20x the cutoff, which is far past anything
// these responses still pass.
function stepComponents() {
  const f0 = 0.005;
  const out = [];
  for (let n = 1; n * f0 <= 20; n += 2) out.push({ f: n * f0, a: 4 / (Math.PI * n), p: 0 });
  return out;
}

let stepSource = null;
const stepCache = new Map();

// Normalised step response of `kind` at bw = 1, sampled over t in [-2, 12].
function stepCurve(kind) {
  if (stepCache.has(kind)) return stepCache.get(kind);
  if (!stepSource) stepSource = stepComponents();
  const filtered = frontEnd(stepSource, 1, kind);
  const n = 3000;
  const t0 = -2;
  const t1 = 12;
  const t = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = t0 + ((t1 - t0) * i) / (n - 1);
    v[i] = evaluate(filtered, t[i]);
  }
  const curve = { t, v };
  stepCache.set(kind, curve);
  return curve;
}

function crossing(t, v, level) {
  for (let i = 1; i < v.length; i++) {
    if (v[i - 1] < level && v[i] >= level) {
      const k = (level - v[i - 1]) / (v[i] - v[i - 1] || 1);
      return t[i - 1] + k * (t[i] - t[i - 1]);
    }
  }
  return NaN;
}

// 10-90% rise time and overshoot of the modelled front end, measured off its
// own step response. Scale-invariant, so this is computed once per response
// shape and divided by the bandwidth.
export function edgeResponse(kind, bw) {
  const { t, v } = stepCurve(kind);
  const t10 = crossing(t, v, -0.8);
  const t90 = crossing(t, v, 0.8);
  let peak = -Infinity;
  for (let i = 0; i < v.length; i++) if (t[i] > 0 && v[i] > peak) peak = v[i];
  const norm = t90 - t10;
  return {
    rise: bw > 0 && isFinite(bw) ? norm / bw : 0,
    riseBw: norm,                       // the t_r x BW product for this shape
    overshoot: Math.max(0, (peak - 1) / 2),
  };
}

/* ------------------------------------------------------------------ *
 * Source with a finite edge rate
 * ------------------------------------------------------------------ */

const sincN = (x) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

// Drop components too small to matter, relative to the largest one. Keeps the
// series short enough to evaluate thousands of times per frame.
export function prune(comps, rel = 2e-3) {
  let peak = 0;
  for (const c of comps) peak = Math.max(peak, Math.abs(c.a));
  if (!peak) return [];
  const floor = peak * rel;
  return comps.filter((c) => Math.abs(c.a) >= floor);
}

// An ideal square wave is not band-limited; a real one is, by its edge rate.
// A trapezoid with transition time tr multiplies harmonic n by sinc(f_n * tr),
// which is the honest way to bound the series.
export function edgeLimit(comps, tr) {
  if (!(tr > 0)) return comps;
  return comps.map((c) => ({ f: c.f, a: c.a * sincN(c.f * tr), p: c.p }));
}

// The source as it leaves the generator: harmonics, then the edge-rate window,
// then pruning. `edgeFrac` is transition time as a fraction of the period, so
// the model behaves the same at 1 kHz and at 1 GHz.
export function source(waveform, f, amp, phaseDeg, edgeFrac = 0) {
  const tr = edgeFrac > 0 ? edgeFrac / f : 0;
  const nMax = edgeFrac > 0 ? Math.min(1499, Math.max(9, Math.ceil(3 / edgeFrac)) | 1) : 199;
  let comps = components(waveform, f, amp, phaseDeg, nMax);
  if (tr > 0) comps = edgeLimit(comps, tr);
  return prune(comps, 1.5e-3);
}

/* ------------------------------------------------------------------ *
 * Acquisition arithmetic that depends on memory depth
 * ------------------------------------------------------------------ */

// Round down to the nearest 1-2-5 step, the way instrument front panels move.
export function snap125(v) {
  if (!(v > 0)) return 0;
  const d = 10 ** Math.floor(Math.log10(v));
  const m = v / d;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * d;
}

// A scope cannot sample faster than its memory allows for the window on screen.
// Zoom out far enough and the sample rate drops, which is when a signal that
// was fine at full rate starts to fold.
export function effectiveRate(fsMax, memory, duration) {
  if (!(duration > 0) || !(memory > 0)) return fsMax;
  if (duration * fsMax <= memory) return fsMax;
  return Math.max(1, Math.min(fsMax, snap125(memory / duration)));
}

/* ------------------------------------------------------------------ *
 * Comparing two versions of the same waveform
 * ------------------------------------------------------------------ */

// How far the received waveform is from the one that went in. Sampled over a
// whole number of periods so the numbers do not wander with window length.
export function traceError(ideal, actual, duration, { n = 1200, shift = 0 } = {}) {
  let se = 0;
  let peakErr = 0;
  let iLo = Infinity; let iHi = -Infinity;
  let aLo = Infinity; let aHi = -Infinity;
  let iSq = 0;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * duration;
    const a = evaluate(ideal, t);
    const b = evaluate(actual, t + shift);
    const e = b - a;
    se += e * e;
    iSq += a * a;
    peakErr = Math.max(peakErr, Math.abs(e));
    if (a < iLo) iLo = a; if (a > iHi) iHi = a;
    if (b < aLo) aLo = b; if (b > aHi) aHi = b;
  }
  const idealPp = iHi - iLo;
  const actualPp = aHi - aLo;
  return {
    rms: Math.sqrt(se / n),
    rmsRel: iSq > 0 ? Math.sqrt(se / iSq) : 0,
    peak: peakErr,
    idealPp,
    actualPp,
    ampRatio: idealPp > 1e-12 ? actualPp / idealPp : 1,
  };
}

// Fraction of the input's power that the front end passed, and how many
// harmonics survived at a useful level.
export function passedPower(before, after) {
  let pb = 0;
  let pa = 0;
  for (const c of before) pb += c.a * c.a;
  for (const c of after) pa += c.a * c.a;
  return pb > 0 ? pa / pb : 1;
}

export function foldingComponents(comps, fs, rel = 0.02) {
  const nyq = fs / 2;
  let peak = 0;
  for (const c of comps) peak = Math.max(peak, Math.abs(c.a));
  return comps.filter((c) => c.f > nyq + 1e-9 && Math.abs(c.a) > rel * peak);
}

/* ------------------------------------------------------------------ *
 * Deterministic noise
 *
 * A fixed seed so the trace does not shimmer while a slider moves; the point
 * is the noise floor, not the animation.
 * ------------------------------------------------------------------ */

export function noiseSource(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    const u1 = (s + 1) / 4294967297;
    s = (1664525 * s + 1013904223) >>> 0;
    const u2 = (s + 1) / 4294967297;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
  };
}

/* ------------------------------------------------------------------ *
 * More formatting
 * ------------------------------------------------------------------ */

const SI = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
  [1e-3, 'm'], [1e-6, '\u00b5'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
];

export function fmtSI(v, unit, digits = 3) {
  if (Number.isNaN(v)) return '\u2014';
  if (!isFinite(v)) return `\u221e ${unit}`;
  if (v === 0) return `0 ${unit}`;
  const a = Math.abs(v);
  for (const [scale, prefix] of SI) {
    if (a >= scale * 0.999) {
      const x = v / scale;
      const dp = Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(x))));
      return `${x.toFixed(Math.min(dp, 3))} ${prefix}${unit}`;
    }
  }
  return `${(v / 1e-15).toFixed(2)} f${unit}`;
}

export const fmtFreq = (v) => fmtSI(v, 'Hz');
export const fmtRate = (v) => fmtSI(v, 'S/s');
export const fmtSec = (v) => fmtSI(v, 's');
export const fmtVolt = (v) => fmtSI(v, 'V');

export function fmtPoints(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} Gpts`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} Mpts`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)} kpts`;
  return `${n} pts`;
}

export const dB = (x) => 20 * Math.log10(Math.max(x, 1e-12));
