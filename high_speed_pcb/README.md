# SI Studio 6.6 — contextual lab explanations

This lab is fully client-side and is intended to be served as static files. No Python backend is required. For local development, serve this directory with any ordinary static HTTP server so browser module and asset loading behave the same way as on Cloudflare.

Seven connected labs demonstrate transmission lines, termination, differential skew, crosstalk, via return geometry, microstrip impedance and model checks. The desktop layout keeps controls, animation and plots together. Lab notes and System open supporting panels. Dark/light mode, source selection, time scrubbing and individual trace controls are retained.

## Changes in this release

- Every lab now has a keyboard-accessible **Understand this lab** drawer at the bottom, initially collapsed.
- Explains the scene, every control, trace interpretation, suggested experiments and model boundaries.
- Current-setting explanations update when parameters change, without refreshing while you read during animation.
- Desktop drawers keep the plots above them and scroll their own content; both themes are supported.

## Mathematical review retained from 6.5

- Consistent Hammerstad–Jensen microstrip impedance, permittivity and velocity in the browser model.
- Propagation comes from the stackup by default; select Manual override to control velocity independently.
- Crosstalk uses explicit kC/kL and even/odd modes, with separate near-end and far-end outputs. The geometry sketch does not extract coupling coefficients. Amplitude A denotes nominal incident voltage; the aggressor generator is 2A open circuit.
- Unsupported via containment/leakage and differential coupling percentages removed.
- Correct waveform-specific transition indicators, adaptive time sampling, V/div grid spacing, return-loss limits and strict JSON.
- Review judgments labeled as model checks rather than physical signoff.

For transmission-line time plots, Driver Vs is the open-circuit generator reference; Forward and Reflected are measured at the selected probe; Sum is their sum; Load is measured at the receiver. Sum and Load coincide with the probe at 100%. The spatial Load trace is a horizontal reference. The Phase example uses a matched source and manual velocity to show first arrivals at 0.5, 1 and 1.5 ns.

## Audit and tests

Read **MATH_AUDIT.md** for findings, equations, sources, model limits and verification results. It supersedes earlier model claims in AUDIT.md.

```bash
node tests/verify_math.cjs
node tests/verify_render.cjs
```

The tests use Node.js without extra packages. They verify mathematics and render execution, not browser appearance. These lossless/ideal models do not replace a field solver, IBIS/SPICE, S-parameters or measurement.
