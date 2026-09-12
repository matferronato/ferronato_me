# ScopeLab — the whole acquisition path, not just the sampler

A bench-instrument style page for showing what actually happens between a signal
and the numbers an oscilloscope records: the analog front end, the anti-alias
filter, the sampler, the interpolator, and what each one takes away.

The point it exists to make is that "two samples per period" is a statement about
band-limited signals only. A square wave is not band-limited, so the theorem does
not apply to it, and no sample rate saves a signal the front end already
destroyed.

## Run

```bash
python3 server.py            # http://127.0.0.1:8781
python3 server.py --open     # and open a browser
python3 server.py --port 9000
```

Standard library only. No build step, no dependencies, no CDN — plain ES modules
loaded by the browser, so any static file server works.

## Test

```bash
node tests.mjs               # 140 checks
```

The tests check the claims the interface makes rather than trusting them: folding
arithmetic, interpolator behaviour, front-end magnitude and phase, measured rise
times against their closed forms, memory-depth arithmetic, and that every preset
actually demonstrates the thing it is named after.

## Views

**Bench** — the main screen. Waveform, spectrum, per-stage switches, and a verdict
that names what is wrong. It distinguishes folding from bandwidth loss, because
they need opposite fixes.

**Signal chain** — five lanes in acquisition order, each with its own bypass
switch, its own controls and its own metrics. Every lane draws what arrived from
the stage above as a ghost trace, so what a stage did is visible rather than
inferred. The last lane compares against the source, so it reads as end-to-end
error.

**Front end** — the generator's output against what reaches the sampler, with the
difference shaded, an edge zoom carrying 10%/90% markers, and the magnitude
response with the waveform's own harmonics drawn as stems.

**Instruments** — one waveform in front of five real oscilloscopes, one per price
decade, on the same time base.

**Alias field** — alias frequency over the whole (f_in, f_s) plane.

**Notes** — the arithmetic behind everything above.

## Modules

| file | holds |
|---|---|
| `dsp.mjs` | the model: components, folding, front-end responses, step responses, interpolators, FFT, formatting |
| `state.mjs` | the shared store, log-slider mapping, presets, URL hash |
| `model.mjs` | `build(state)` — runs the chain once and returns every node in it |
| `ui.mjs` | canvas primitives: surfaces, graticules, traces, log axes |
| `bench.mjs` | the bench view |
| `chain.mjs` | the signal chain and front end views |
| `scopes.mjs` | the instrument catalogue and the instruments view |
| `field.mjs` | the alias field |
| `main.mjs` | boot, tabs, theme, keyboard |
| `tests.mjs` | the checks |

## What is modelled, and how honestly

**Front-end responses.** Single pole, Gaussian, four-pole maximally flat
(Butterworth, pole-product phase) and an ideal brick wall. All four are defined as
-3.01 dB at their own corner, so the bandwidth number means the same thing across
all of them.

**Rise time is measured, not asserted.** Each response's 10-90% time comes off its
own step response rather than from a 0.35/BW rule. The results:

| response | t_r x BW | overshoot |
|---|---|---|
| single pole | 0.349 | none |
| Gaussian | 0.340 | none |
| four-pole maximally flat | 0.387 | 10.8% |
| brick wall | 0.446 | 8.9% (Gibbs) |

Which is where the vendor rule of thumb "0.35 to 0.45 depending on response
shape" comes from.

**Propagation delay is separated from shape error.** A filter with real group
delay moves the whole waveform later. An instrument triggers on the signal, so
that shift is not a measurement error and is not charged as one — it is removed
before the traces are compared, and reported on its own. Gaussian and brick-wall
responses are linear/zero phase and show zero delay, which is a useful internal
check.

**Source waveforms have a finite edge rate.** Harmonic n is scaled by
sinc(f_n * t_r), so a square wave is band-limited by its own edges and the series
can be truncated honestly instead of at an arbitrary harmonic count. Edge rate is
expressed as a percentage of the period, so it stays meaningful across the whole
frequency range.

**Memory depth is real.** If the record length cannot hold the time window at the
set sample rate, the rate drops to what fits, snapped to a 1-2-5 grid. This is the
actual reason a safe-looking setup starts aliasing when you zoom out.

**Frequency controls are logarithmic**, so one bench spans 1 Hz to 100 GHz.

## The instrument catalogue

| tier | model | bandwidth | sample rate | bits | memory |
|---|---|---|---|---|---|
| $100 | Hantek DSO2C10 | 100 MHz | 1 GS/s | 8 | 8 Mpts |
| $1k | Rigol DHO924S | 250 MHz | 1.25 GS/s | 12 | 50 Mpts |
| $10k | Keysight DSOX3054T | 500 MHz | 5 GS/s | 8 | 4 Mpts |
| $100k | Keysight MXR608A | 6 GHz | 16 GS/s | 10 | 200 Mpts |
| $1M | Keysight UXR1104B | 110 GHz | 256 GS/s | 10 | 2 Gpts |

Bandwidth, sample rate, resolution and memory depth are published specifications.
**Response shape, ENOB and jitter are modelled per class, not quoted** — they are
plausible figures for that kind of instrument and are labelled as such on the
page. Treat them as the right order of magnitude, not as a datasheet.

Noise is derived from ENOB with the quantiser's own contribution subtracted, so it
is not counted twice.

The thing the view exists to show: oversampling ratio *falls* as you go up the
list, from 10x down to 2.3x. Cheap instruments can afford to be generous with
sample rate because their bandwidth is low. On expensive ones the converter is the
hard part, and the front end is deliberately matched to it.

## Keyboard

| key | does |
|---|---|
| `1`-`7` | presets |
| `F` | analog front end in/out |
| `A` | anti-alias filter in/out |
| `S` | sampler in/out |
| `R` | reset |

## Sharing a setup

**Copy setup link** puts the entire state in the URL hash. A link is a complete
description — anything the hash omits returns to its default rather than merging
onto whatever happened to be on screen.

**Export CSV** writes four columns: time, what was recorded, what arrived at the
sampler, and what the source actually did.
