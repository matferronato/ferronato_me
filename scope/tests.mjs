// node tests.mjs
// Checks the claims the interface makes, rather than trusting them.

import {
  alias, components, lowpass1, brickwall, evaluate, sampleRecord,
  sincAt, linearAt, holdAt, fft, spectrumOf, peakFrequency, quantize,
  verdict, samplesPerCycle, TAU,
  responseAt, frontEnd, edgeResponse, groupShift, RESPONSES,
  source, edgeLimit, prune, snap125, effectiveRate, traceError,
  passedPower, foldingComponents, fmtSI, fmtPoints, dB,
} from './dsp.mjs';
import { build } from './model.mjs';
import { DEFAULTS, PRESETS } from './state.mjs';
import { SCOPES, measure, noiseFor } from './scopes.mjs';

let pass = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (name, got, want, tol) =>
  ok(name, Math.abs(got - want) <= tol, `got ${got.toPrecision(6)}, want ${want.toPrecision(6)} (tol ${tol})`);

/* -------------------------------------------------- folding -------- */

near('9 kHz at 8 kS/s folds to 1 kHz', alias(9000, 8000).f, 1000, 1e-9);
near('5 kHz at 8 kS/s folds to 3 kHz', alias(5000, 8000).f, 3000, 1e-9);
near('input at the sample rate folds to DC', alias(8000, 8000).f, 0, 1e-9);
near('input at Nyquist stays at Nyquist', alias(4000, 8000).f, 4000, 1e-9);
near('below Nyquist is untouched', alias(1000, 8000).f, 1000, 1e-9);
near('17 kHz at 8 kS/s folds to 1 kHz', alias(17000, 8000).f, 1000, 1e-9);

ok('zone 1 is not a fold', !alias(1000, 8000).folded);
ok('zone 2 is flagged reversed', alias(5000, 8000).zone === 2 && alias(5000, 8000).reversed);
ok('zone 3 is not reversed', alias(9000, 8000).zone === 3 && !alias(9000, 8000).reversed);

let inRange = true;
for (let f = 0; f <= 200000; f += 137) {
  for (const fs of [1000, 8000, 44100, 30000]) {
    const a = alias(f, fs).f;
    if (a < -1e-9 || a > fs / 2 + 1e-9) inRange = false;
  }
}
ok('every fold lands inside the first Nyquist zone', inRange);

// A folded input and its alias must produce identical samples. That is the
// whole problem, so assert it directly.
{
  const fs = 8000;
  const hi = components('sine', 9000, 1, 30);
  const lo = components('sine', 1000, 1, 30);
  let worst = 0;
  for (let n = 0; n < 400; n++) worst = Math.max(worst, Math.abs(evaluate(hi, n / fs) - evaluate(lo, n / fs)));
  near('9 kHz and 1 kHz give identical samples at 8 kS/s', worst, 0, 1e-9);
}

/* -------------------------------------------------- waveforms ------ */

{
  const sq = components('square', 1000, 1, 0);
  near('square fundamental is 4/pi', sq[0].a, 4 / Math.PI, 1e-9);
  near('square third harmonic is 4/3pi', sq[1].a, 4 / (3 * Math.PI), 1e-9);
  ok('square has odd harmonics only', sq.every((c) => Math.round(c.f / 1000) % 2 === 1));

  const tri = components('triangle', 1000, 1, 0);
  near('triangle fundamental is 8/pi^2', tri[0].a, 8 / Math.PI ** 2, 1e-9);
  near('triangle third harmonic is inverted', tri[1].a, -8 / (9 * Math.PI ** 2), 1e-9);

  const saw = components('sawtooth', 1000, 1, 0);
  ok('sawtooth keeps even harmonics', saw.some((c) => Math.round(c.f / 1000) % 2 === 0));

  // Peak of the synthesised square should approach the requested amplitude.
  let peak = 0;
  for (let i = 0; i < 2000; i++) peak = Math.max(peak, evaluate(sq, i / 2e6));
  ok('square wave reaches roughly full amplitude', peak > 1.0 && peak < 1.25, `peak ${peak.toFixed(3)}`);
}

/* -------------------------------------------------- front end ------ */

{
  const one = [{ f: 1000, a: 1, p: 0 }];
  near('single pole is -3 dB at the corner', lowpass1(one, 1000)[0].a, 1 / Math.SQRT2, 1e-9);
  near('single pole shifts phase 45 degrees at the corner', lowpass1(one, 1000)[0].p, -Math.PI / 4, 1e-9);
  near('a decade above the corner attenuates ~20 dB', lowpass1([{ f: 10000, a: 1, p: 0 }], 1000)[0].a, 0.0995, 1e-3);

  const filtered = brickwall(components('square', 1000, 1, 0), 4000);
  ok('brick wall keeps only what is below the cutoff', filtered.every((c) => c.f < 4000));
  ok('brick wall keeps the fundamental and third harmonic', filtered.length === 2);
}

/* -------------------------------------------------- sampling ------- */

{
  const rec = sampleRecord(components('sine', 1000, 1, 0), { fs: 8000, duration: 0.005 });
  ok('record length matches duration times rate', rec.t.length === 41, `got ${rec.t.length}`);
  near('sample interval is 1/fs', rec.Ts, 1 / 8000, 1e-12);

  const offset = sampleRecord(components('sine', 1000, 1, 0), { fs: 8000, duration: 0.005, offsetFrac: 0.5 });
  near('offset moves the first sample by half a period', offset.t[0], 0.5 / 8000, 1e-12);

  near('quantiser snaps to the nearest code', quantize(0.31, 4, 2.5), 0.3125, 1e-9);
  near('quantiser is transparent when disabled', quantize(0.31459, 0, 2.5), 0.31459, 1e-12);
  const lsb = 5 / 2 ** 8;
  let worst = 0;
  for (let v = -2; v <= 2; v += 0.001) worst = Math.max(worst, Math.abs(quantize(v, 8, 2.5) - v));
  ok('8 bit error stays within half an LSB', worst <= lsb / 2 + 1e-9, `worst ${worst.toExponential(2)}`);
}

/* -------------------------------------------------- interpolation -- */

{
  const fs = 8000;
  const comps = components('sine', 1000, 1, 40);
  const rec = sampleRecord(comps, { fs, duration: 0.04 });
  let worst = 0;
  for (let t = 0.012; t < 0.028; t += 0.00013) worst = Math.max(worst, Math.abs(sincAt(rec, t) - evaluate(comps, t)));
  ok('band-limited interpolation reproduces a well sampled sine', worst < 0.02, `worst error ${worst.toFixed(4)}`);

  // The headline claim: reconstruct a 9 kHz input sampled at 8 kS/s and it is a 1 kHz sine.
  const hi = components('sine', 9000, 1, 40);
  const recHi = sampleRecord(hi, { fs, duration: 0.04 });
  const aliasSine = components('sine', 1000, 1, 40);
  worst = 0;
  for (let t = 0.012; t < 0.028; t += 0.00013) worst = Math.max(worst, Math.abs(sincAt(recHi, t) - evaluate(aliasSine, t)));
  ok('a 9 kHz input reconstructs as a clean 1 kHz sine', worst < 0.02, `worst error ${worst.toFixed(4)}`);

  // Zone 2 comes back mirrored, so the reconstruction runs backwards in phase.
  const z2 = sampleRecord(components('sine', 5000, 1, 40), { fs, duration: 0.04 });
  const mirrored = (t) => Math.sin(-TAU * 3000 * t + (40 * Math.PI) / 180);
  worst = 0;
  for (let t = 0.012; t < 0.028; t += 0.00013) worst = Math.max(worst, Math.abs(sincAt(z2, t) - mirrored(t)));
  ok('an even Nyquist zone reconstructs mirrored', worst < 0.02, `worst error ${worst.toFixed(4)}`);

  // Hold and linear must pass exactly through the sample points.
  const rec2 = sampleRecord(comps, { fs, duration: 0.01 });
  let holdOk = true; let linOk = true;
  for (let i = 1; i < rec2.t.length - 1; i++) {
    if (Math.abs(holdAt(rec2, rec2.t[i]) - rec2.v[i]) > 1e-9) holdOk = false;
    if (Math.abs(linearAt(rec2, rec2.t[i]) - rec2.v[i]) > 1e-9) linOk = false;
  }
  ok('hold passes through every sample', holdOk);
  ok('linear passes through every sample', linOk);
  near('linear splits the difference between two samples',
    linearAt(rec2, rec2.t[3] + rec2.Ts / 2), (rec2.v[3] + rec2.v[4]) / 2, 1e-9);
}

/* -------------------------------------------------- spectra -------- */

{
  // FFT against a direct DFT of the same random data.
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const src = [];
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    src.push(seed / 2147483648 - 0.5);
    re[i] = src[i];
  }
  fft(re, im);
  let worst = 0;
  for (const k of [0, 1, 5, 17, 32]) {
    let dr = 0; let di = 0;
    for (let i = 0; i < n; i++) { dr += src[i] * Math.cos((-TAU * k * i) / n); di += src[i] * Math.sin((-TAU * k * i) / n); }
    worst = Math.max(worst, Math.hypot(re[k] - dr, im[k] - di));
  }
  ok('fft agrees with a direct dft', worst < 1e-9, `worst ${worst.toExponential(2)}`);

  // Amplitude calibration.
  const spec = spectrumOf(components('sine', 1000, 0.8, 0), { fs: 8000 });
  const peak = peakFrequency(spec);
  near('measured amplitude matches the source', peak.amp, 0.8, 0.02);

  // The measured peak must agree with the folding arithmetic for every case.
  const cases = [[1000, 8000, 1000], [9000, 8000, 1000], [5000, 8000, 3000],
    [17000, 8000, 1000], [3000, 44100, 3000], [23000, 44100, 21100]];
  for (const [f, fs, want] of cases) {
    const got = peakFrequency(spectrumOf(components('sine', f, 1, 0), { fs, n: 4096 })).f;
    near(`${f} Hz at ${fs} S/s measures ${want} Hz`, got, want, fs * 0.003);
  }
}

/* -------------------------------------------------- verdict -------- */

{
  // Same pipeline the bench uses: the verdict sees what reaches the sampler.
  const v = (o) => {
    const raw = components(o.waveform ?? 'sine', o.f, 1, 0);
    const comps = o.antiAlias ? brickwall(raw, o.fs / 2) : raw;
    return verdict({
      comps, f: o.f, fs: o.fs, waveform: o.waveform ?? 'sine', antiAlias: o.antiAlias ?? false,
    }).level;
  };
  ok('a comfortably sampled sine reads ok', v({ f: 1000, fs: 8000 }) === 'ok');
  ok('an input above Nyquist reads bad', v({ f: 9000, fs: 8000 }) === 'bad');
  ok('an input at the sample rate reads bad', v({ f: 8000, fs: 8000 }) === 'bad');
  ok('sitting on Nyquist reads as a warning', v({ f: 4000, fs: 8000 }) === 'warn');
  ok('a square wave with folding harmonics warns', v({ f: 1000, fs: 3000, waveform: 'square' }) === 'warn');
  ok('the ideal filter clears the square wave warning',
    v({ f: 1000, fs: 3000, waveform: 'square', antiAlias: true }) === 'ok');
  near('samples per cycle is fs over f', samplesPerCycle(1000, 8000), 8, 1e-12);
  ok('dc has infinite samples per cycle', samplesPerCycle(0, 8000) === Infinity);
}


/* ------------------------------------------- front end responses -------- */
{
  // Every modelled response is defined as -3.01 dB at its own corner. If this
  // ever drifts, every bandwidth number on the page becomes a different claim.
  for (const kind of RESPONSES) {
    if (kind === 'brick') continue;
    near(`${kind} is -3.01 dB at its corner`, dB(responseAt(kind, 1e6, 1e6).m), -3.0103, 0.02);
    near(`${kind} is flat at DC`, responseAt(kind, 0, 1e6).m, 1, 1e-9);
    near(`${kind} has no phase shift at DC`, responseAt(kind, 0, 1e6).ph, 0, 1e-9);
  }
  ok('brick wall passes in band', responseAt('brick', 0.99e6, 1e6).m === 1);
  ok('brick wall stops out of band', responseAt('brick', 1.01e6, 1e6).m === 0);

  // single pole against the closed form
  const r = 2.5;
  near('single pole magnitude', responseAt('onepole', r * 1e6, 1e6).m, 1 / Math.hypot(1, r), 1e-12);
  near('single pole phase', responseAt('onepole', r * 1e6, 1e6).ph, -Math.atan(r), 1e-12);

  // Gaussian and brick wall are linear/zero phase, so they cannot skew a waveform
  near('gaussian adds no phase', responseAt('gaussian', 3e6, 1e6).ph, 0, 1e-12);
  near('gaussian delay is zero', groupShift('gaussian', 3e6, 1e6), 0, 1e-15);
  ok('four-pole filter really does delay', groupShift('maxflat', 1e6, 1e6) > 0);

  // roll-off slopes: one pole is 20 dB/decade, four poles is 80
  const slope = (kind) => dB(responseAt(kind, 1e9, 1e6).m) - dB(responseAt(kind, 1e8, 1e6).m);
  near('single pole falls 20 dB per decade', slope('onepole'), -20, 0.1);
  near('four poles fall 80 dB per decade', slope('maxflat'), -80, 0.1);

  const comps = [{ f: 1e6, a: 1, p: 0 }, { f: 5e6, a: 1, p: 0 }];
  const out = frontEnd(comps, 1e6, 'onepole');
  near('front end scales each component', out[1].a, 1 / Math.hypot(1, 5), 1e-12);
  ok('front end leaves the list length alone', out.length === 2);
  ok('an infinite bandwidth front end is a no-op', frontEnd(comps, Infinity, 'onepole') === comps);
}

/* ------------------------------------------- rise time -------- */
{
  // The 10-90% figures are measured off each response's own step response, not
  // asserted, so these are the values the page has to keep producing.
  near('single pole gives the classic 0.35/BW', edgeResponse('onepole', 1).riseBw, 0.34959, 2e-3);
  near('gaussian gives 0.34/BW', edgeResponse('gaussian', 1).riseBw, 0.33969, 2e-3);
  near('four-pole maximally flat gives 0.39/BW', edgeResponse('maxflat', 1).riseBw, 0.387, 5e-3);
  near('brick wall gives 0.45/BW', edgeResponse('brick', 1).riseBw, 0.446, 5e-3);

  near('rise time scales inversely with bandwidth',
    edgeResponse('gaussian', 250e6).rise, 0.33969 / 250e6, 1e-12);

  ok('gaussian does not overshoot', edgeResponse('gaussian', 1).overshoot < 1e-3);
  ok('single pole does not overshoot', edgeResponse('onepole', 1).overshoot < 1e-3);
  near('four-pole overshoot is about 11%', edgeResponse('maxflat', 1).overshoot, 0.109, 0.01);
  near('brick wall overshoot is the Gibbs 9%', edgeResponse('brick', 1).overshoot, 0.0895, 0.01);
}

/* ------------------------------------------- finite edges -------- */
{
  // A trapezoid multiplies harmonic n by sinc(f_n * t_r), so the null lands
  // exactly at 1/t_r and the series stops being infinite.
  const tr = 1e-9;
  const c = edgeLimit([{ f: 1 / tr, a: 1, p: 0 }], tr);
  near('the edge-rate window nulls at 1/tr', c[0].a, 0, 1e-12);
  const half = edgeLimit([{ f: 0.5 / tr, a: 1, p: 0 }], tr);
  near('and is 2/pi at half of it', half[0].a, 2 / Math.PI, 1e-9);

  const ideal = source('square', 1e6, 1, 0, 0);
  const real = source('square', 1e6, 1, 0, 0.02);
  ok('a finite edge rate bounds the series', real.length < ideal.length && real.length > 4,
    `ideal ${ideal.length}, real ${real.length}`);
  near('and leaves the fundamental alone', real[0].a, ideal[0].a, 0.01);

  const fast = source('square', 1e6, 1, 0, 0.004);
  ok('faster edges carry more harmonics', fast.length > real.length);

  ok('pruning drops what cannot be seen',
    prune([{ f: 1, a: 1, p: 0 }, { f: 2, a: 1e-9, p: 0 }]).length === 1);
}

/* ------------------------------------------- memory depth -------- */
{
  ok('1-2-5 rounds down', snap125(3.7e9) === 2e9 && snap125(6e6) === 5e6 && snap125(1.4) === 1);
  ok('full rate when memory is enough', effectiveRate(5e9, 4e6, 1e-6) === 5e9);
  // 4 Mpts over 1 ms is 4 GS/s of demand against a 5 GS/s converter: it drops
  ok('memory forces the rate down', effectiveRate(5e9, 4e6, 1e-3) === 2e9,
    `got ${effectiveRate(5e9, 4e6, 1e-3)}`);
  ok('never faster than the converter', effectiveRate(1e9, 2e9, 1e-9) === 1e9);
}

/* ------------------------------------------- error metrics -------- */
{
  const a = [{ f: 1000, a: 1, p: 0 }];
  near('a signal matches itself', traceError(a, a, 5e-3).rmsRel, 0, 1e-12);
  near('and its peak-to-peak ratio is one', traceError(a, a, 5e-3).ampRatio, 1, 1e-6);

  // a pure delay is not a shape error once it is taken out
  const shifted = [{ f: 1000, a: 1, p: -0.7 }];
  const tau = 0.7 / (TAU * 1000);
  ok('an unaligned delay reads as error', traceError(a, shifted, 5e-3).rmsRel > 0.3);
  near('and vanishes when de-skewed', traceError(a, shifted, 5e-3, { shift: tau }).rmsRel, 0, 1e-6);

  near('half the amplitude passes a quarter of the power',
    passedPower(a, [{ f: 1000, a: 0.5, p: 0 }]), 0.25, 1e-12);
  ok('folding components are the ones above Nyquist',
    foldingComponents([{ f: 1000, a: 1, p: 0 }, { f: 5000, a: 1, p: 0 }], 8000).length === 1);
}

/* ------------------------------------------- formatting -------- */
{
  ok('GHz', fmtSI(110e9, 'Hz') === '110 GHz');
  ok('ps', fmtSI(3.4e-12, 's') === '3.40 ps');
  ok('NaN is not infinity', fmtSI(NaN, 's') === '\u2014');
  ok('Gpts', fmtPoints(2e9) === '2.0 Gpts');
  ok('kpts', fmtPoints(8000) === '8.0 kpts');
}

/* ------------------------------------------- the whole chain -------- */
{
  const m = build({ ...DEFAULTS });
  ok('defaults produce a record', m.rec.v.length === 41, `got ${m.rec.v.length}`);
  near('defaults are not folding', m.predicted.f, 1000, 1e-9);
  near('defaults sit at 8 samples per cycle', m.spc, 8, 1e-9);

  const bypassed = build({ ...DEFAULTS, afeOn: false });
  ok('switching the front end out is a true bypass', bypassed.nodes.afe === bypassed.nodes.ideal);
  ok('and removes the amplitude loss', bypassed.afeError === null);

  const noAdc = build({ ...DEFAULTS, adcOn: false });
  ok('switching the sampler out leaves no record', noAdc.rec.v.length === 0);
  ok('and no spectrum to measure', noAdc.spec === null);

  const filtered = build({ ...DEFAULTS, waveform: 'square', fs: 3000, aaOn: true, aaResp: 'brick' });
  ok('a brick wall anti-alias filter leaves nothing to fold', filtered.folding.length === 0);
  const unfiltered = build({ ...DEFAULTS, waveform: 'square', fs: 3000, aaOn: false });
  ok('without it, harmonics fold', unfiltered.folding.length > 0);

  // a realisable anti-alias filter has skirts, so some energy always gets past
  const leaky = build({ ...DEFAULTS, waveform: 'square', fs: 3000, aaOn: true, aaResp: 'onepole' });
  ok('a single-pole anti-alias filter leaks', leaky.folding.length > 0);

  const zoomed = build({ ...DEFAULTS, freq: 9000, fs: 500000, mem: 100, window: 0.01 });
  ok('zooming out past memory drops the sample rate', zoomed.memLimited && zoomed.fs < 200000,
    `fs ${zoomed.fs}`);
  ok('and that is what makes it fold', zoomed.predicted.folded);
}

/* ------------------------------------------- instruments -------- */
{
  ok('five instruments, one per decade', SCOPES.length === 5);
  for (const sc of SCOPES) {
    ok(`${sc.name} has a plausible oversampling ratio`, sc.fs / sc.bw >= 2 && sc.fs / sc.bw <= 12,
      `${(sc.fs / sc.bw).toFixed(1)}x`);
    ok(`${sc.name} noise is positive`, noiseFor(sc, 1.25) > 0);
  }
  ok('bandwidth rises monotonically with price',
    SCOPES.every((s, i) => i === 0 || s.bw > SCOPES[i - 1].bw));

  // A sine at exactly the rated bandwidth comes back at 70.7%. That is what the
  // rating means, and it is the single most useful thing on the page.
  const atRated = measure(SCOPES[0], { ...DEFAULTS, instWave: 'sine', instFreq: SCOPES[0].bw });
  near('a signal at the rated bandwidth reads 70.7%', atRated.fundamental, Math.SQRT1_2, 1e-6);

  // 5 GHz is above the Nyquist limit of the first three instruments
  const blind = SCOPES.slice(0, 3)
    .map((sc) => measure(sc, { ...DEFAULTS, instWave: 'sine', instFreq: 5e9 }))
    .every((m) => m.aliasF.folded);
  ok('the first three instruments cannot see 5 GHz at all', blind);
  const sees = measure(SCOPES[4], { ...DEFAULTS, instWave: 'sine', instFreq: 5e9 });
  ok('the flagship can', !sees.aliasF.folded && sees.fundamental > 0.99);
}


/* ------------------------------------------- verdicts -------- */
{
  const v = (over) => verdict({
    comps: [{ f: 1000, a: 1, p: 0 }], f: 1000, fs: 8000, waveform: 'sine', antiAlias: false, ...over,
  });
  ok('a clean setup reads clean', v().level === 'ok');
  ok('a narrow front end is not a clean setup', v({ fundKept: 0.7, bw: 1000 }).level === 'warn');
  ok('and it says so before blaming the sampler', v({ fundKept: 0.7, bw: 1000 }).badge === 'band limited');
  ok('lost harmonics count even when the fundamental survives',
    v({ fundKept: 1, shapeErr: 0.3, bw: 4000 }).badge === 'band limited');
  ok('folding still outranks bandwidth loss',
    verdict({
      comps: [{ f: 9000, a: 1, p: 0 }], f: 9000, fs: 8000, waveform: 'sine',
      antiAlias: false, fundKept: 0.5,
    }).badge === 'f > fs/2');
}

/* ------------------------------------------- presets -------- */
{
  // every preset has to actually demonstrate the thing it is named after
  const of = (id) => build({ ...DEFAULTS, ...PRESETS.find((p) => p.key === id).set });
  ok('the clean preset is clean', !of('clean').predicted.folded && of('clean').spc >= 4);
  ok('the lie preset lies', of('lie').predicted.folded);
  ok('the dc preset flatlines', of('dc').predicted.f < 1e-6);
  ok('the harmonic preset folds harmonics, not the fundamental', (() => {
    const m = of('harm');
    return !m.predicted.folded && m.folding.length > 0;
  })());
  ok('the bandwidth preset loses the signal in the front end', of('bwlimit').fundKept < 0.9,
    `kept ${of('bwlimit').fundKept.toFixed(3)}`);
  ok('the memory preset runs out of memory', of('memory').memLimited && of('memory').predicted.folded);
}

/* -------------------------------------------------- report -------- */

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} checks failed:\n`);
  for (const f of failures) console.error(`  \u2717 ${f}`);
  process.exit(1);
}
console.log(`\u2713 ${total} checks passed`);
