// state.mjs — one store for every view, so a signal set up on the bench is the
// same signal the chain, the front end page and the five instruments see.

export const DEFAULTS = {
  // source
  waveform: 'sine', freq: 1000, amp: 1, phase: 0, edge: 1.0,

  // front end
  afeOn: true, bw: 50000, resp: 'onepole',

  // anti-alias filter
  aaOn: false, aaResp: 'brick', aaCut: 1.0,

  // sampler
  adcOn: true, fs: 8000, bits: 0, offset: 0, mem: 1e6,

  // reconstruction
  reconOn: true, recon: 'sinc',

  // display
  window: 5e-3,
  showAnalog: true, showSamples: true, showRecon: true,
  showInstants: false, showIdeal: false,

  // alias field
  fieldFin: 9000, fieldFs: 8000,

  // instruments
  instFreq: 100e6, instWave: 'square', instEdge: 1.0, instCycles: 3,
  instScope: 'all',
};

export const NUMERIC = [
  'freq', 'amp', 'phase', 'edge', 'bw', 'aaCut', 'fs', 'bits', 'offset',
  'mem', 'window', 'fieldFin', 'fieldFs', 'instFreq', 'instEdge', 'instCycles',
];
export const BOOLEAN = [
  'afeOn', 'aaOn', 'adcOn', 'reconOn',
  'showAnalog', 'showSamples', 'showRecon', 'showInstants', 'showIdeal',
];
export const CHOICE = {
  waveform: ['sine', 'square', 'triangle', 'sawtooth', 'twotone'],
  resp: ['onepole', 'gaussian', 'maxflat', 'brick'],
  aaResp: ['onepole', 'gaussian', 'maxflat', 'brick'],
  recon: ['hold', 'linear', 'sinc'],
  instWave: ['sine', 'square', 'triangle', 'sawtooth', 'twotone'],
  instScope: ['all'],
};

export const state = { ...DEFAULTS };

/* ------------------------------------------------------------------ *
 * Log sliders
 *
 * The bench has to work at 1 kHz and at 100 GHz, so every frequency-like
 * control is a decade slider: the widget carries 0..1000, the state carries
 * the real number.
 * ------------------------------------------------------------------ */

export const LOG_RANGE = {
  freq:     [1, 1e11],
  fs:       [10, 5e11],
  bw:       [100, 5e11],
  window:   [1e-11, 1],
  mem:      [100, 4e9],
  instFreq: [1e3, 2e11],
};

export function toSlider(key, value) {
  const [lo, hi] = LOG_RANGE[key];
  const v = Math.min(hi, Math.max(lo, value));
  return Math.round((1000 * Math.log(v / lo)) / Math.log(hi / lo));
}

export function fromSlider(key, pos) {
  const [lo, hi] = LOG_RANGE[key];
  const v = lo * (hi / lo) ** (Number(pos) / 1000);
  // three significant figures keeps the readout honest and the URL short
  const d = 10 ** (Math.floor(Math.log10(v)) - 2);
  return Math.round(v / d) * d;
}

export const isLog = (key) => key in LOG_RANGE;

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

export const PRESETS = [
  {
    key: 'clean', label: 'Well sampled',
    hint: 'Eight points per cycle, nothing to argue with.',
    set: { waveform: 'sine', freq: 1000, fs: 8000, phase: 0, aaOn: false, bits: 0, window: 5e-3, bw: 50000 },
  },
  {
    key: 'edge', label: 'Exactly at Nyquist',
    hint: 'Two points per cycle. Sweep the clock offset and watch it vanish.',
    set: { waveform: 'sine', freq: 4000, fs: 8000, phase: 0, aaOn: false, window: 3e-3 },
  },
  {
    key: 'lie', label: 'A convincing lie',
    hint: '9 kHz sampled at 8 kS/s draws a clean 1 kHz sine.',
    set: { waveform: 'sine', freq: 9000, fs: 8000, phase: 20, aaOn: false, window: 5e-3 },
  },
  {
    key: 'dc', label: 'Flatline',
    hint: 'Input frequency equals sample rate, so every point is identical.',
    set: { waveform: 'sine', freq: 8000, fs: 8000, phase: 65, aaOn: false, window: 3e-3 },
  },
  {
    key: 'harm', label: 'Square wave trap',
    hint: 'Fundamental is legal, harmonics fold on top of it.',
    set: { waveform: 'square', freq: 1000, fs: 3000, phase: 0, aaOn: false, bw: 40000, window: 5e-3, edge: 1 },
  },
  {
    key: 'bwlimit', label: 'Bandwidth bottleneck',
    hint: 'Plenty of samples, not enough front end. The edges never arrive.',
    set: { waveform: 'square', freq: 1000, fs: 200000, phase: 0, aaOn: false, bw: 2000, resp: 'onepole', window: 3e-3, edge: 0.5 },
  },
  {
    key: 'memory', label: 'Memory runs out',
    hint: 'Zoom out far enough and the scope quietly drops its sample rate.',
    set: { waveform: 'sine', freq: 9000, fs: 500000, mem: 100, window: 0.01, aaOn: false, phase: 0, bw: 50000 },
  },
];

/* ------------------------------------------------------------------ *
 * Subscription
 * ------------------------------------------------------------------ */

const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

let frame = false;
export function emit() {
  if (frame) return;
  frame = true;
  requestAnimationFrame(() => {
    frame = false;
    for (const fn of subscribers) fn(state);
  });
}

export function patch(changes) {
  Object.assign(state, changes);
  writeHash();
  emit();
}

/* ------------------------------------------------------------------ *
 * URL hash — every control lives in the address bar
 * ------------------------------------------------------------------ */

let hashLock = false;

export function writeHash() {
  const p = new URLSearchParams();
  for (const [k, dv] of Object.entries(DEFAULTS)) {
    if (state[k] === dv) continue;
    p.set(k, typeof dv === 'boolean' ? (state[k] ? '1' : '0') : String(state[k]));
  }
  const q = p.toString();
  hashLock = true;
  history.replaceState(null, '', q ? `#${q}` : location.pathname + location.search);
  hashLock = false;
}

export function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  // A shared link is a complete description, so anything the hash omits goes
  // back to its default rather than keeping whatever was on screen.
  Object.assign(state, DEFAULTS);
  for (const [k, dv] of Object.entries(DEFAULTS)) {
    if (!p.has(k)) continue;
    const raw = p.get(k);
    if (typeof dv === 'boolean') state[k] = raw === '1';
    else if (typeof dv === 'number') { const n = Number(raw); if (Number.isFinite(n)) state[k] = n; }
    else state[k] = raw;
  }
  clamp();
}

export function onHashChange(fn) {
  window.addEventListener('hashchange', () => {
    if (hashLock) return;
    readHash();
    fn();
  });
}

export function clamp() {
  for (const [k, list] of Object.entries(CHOICE)) {
    if (!list.includes(state[k])) state[k] = DEFAULTS[k];
  }
  for (const k of NUMERIC) {
    if (!Number.isFinite(state[k])) { state[k] = DEFAULTS[k]; continue; }
    if (isLog(k)) {
      const [lo, hi] = LOG_RANGE[k];
      state[k] = Math.min(hi, Math.max(lo, state[k]));
    }
  }
  state.bits = Math.max(0, Math.min(16, Math.round(state.bits)));
  state.offset = Math.max(0, Math.min(99, Math.round(state.offset)));
  state.phase = Math.max(0, Math.min(360, Math.round(state.phase)));
  state.amp = Math.max(0.05, Math.min(2.4, state.amp));
  state.edge = Math.max(0.3, Math.min(25, state.edge));
  state.instEdge = Math.max(0.3, Math.min(25, state.instEdge));
  state.aaCut = Math.max(0.25, Math.min(2, state.aaCut));
  state.instCycles = Math.max(1, Math.min(12, Math.round(state.instCycles)));
}
