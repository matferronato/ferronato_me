# v6 assessment and v6.1 corrections

## Main finding: misleading superposition presentation

The v6 wavesAt function explicitly returned total = inc + ref. The sampled receiver voltage also used that sum. Therefore the inspected code does not support saying that addition was missing from the numerical calculation.

However, the visualization was unreliable as a teaching tool: the total was painted before component traces, there was no numerical probe or calibrated spatial axis, the traveling marker represented only the old first step reflection, and every input reset the animation to t=0. A component could obscure the total, and parameter comparisons were made at different times.

Corrected: calibrated spatial voltage axes, dashed component curves, solid total drawn last, a movable probe showing forward + reflected = total, fixed selectable scales, replay and a shared time scrubber, and time preservation on parameter changes. The underlying delayed-wave superposition is retained.

## Confirmed regressions and inconsistencies

| Issue | Consequence | Correction |
| --- | --- | --- |
| Light-only CSS overrides | Removed the original dark experience | Dark default, light/dark toggle, saved preference |
| Legacy particles used independent loops | Animation could contradict waveform frequency and receiver timing | Removed those particles from differential and system overview; crosstalk field activity follows local signal slope |
| Differential plot omitted one-way flight delay | Plot and receiver meter disagreed at the same displayed time | Both use the same one-way delay and skew |
| Automatic time and voltage scales | Changes in frequency/amplitude could look almost unchanged | Fixed selectable time and V/div scales |
| Square/NRZ edges forced to finish within each symbol | Slow requested edges accelerated artificially at high symbol rates | Continuous slew limiting across boundaries |
| Crosstalk metrics used nominal gains, not actual selected-waveform peaks | Displayed mV numbers could disagree with waveform | Metrics and plots sample the same derivative-based estimate |
| Review used raw load while parallel mode used effective load | Audit could report a different reflection coefficient | Shared effective termination |
| Multiple amplitude controls and no local sum readout | Confusing controls without measurable addition | Removed duplicate amplitude sliders; added probe readout |
| Invalid resistor helper calls and series-looking load drawing (inherited) | Schematic did not faithfully depict its boundary model | Corrected helper arguments and load-to-ground symbol |
| Very short channels capped at 256 round trips | Late-time contributions could be omitted in the longest time window | Evaluate causally relevant bounces, retaining small-contribution tolerance |

## Validation and limits

Passed: JavaScript syntax; 210 mocked-canvas lab renders; explicit 0.500 V forward + 0.250 V reflected = 0.750 V total fixture; 300 source/load boundary checks spanning step, sine, square, triangle, random and all three termination modes; matched-load and short-load cases; differential plot/receiver alignment; high-rate slew continuity; fixed timebase under excitation changes.

No real browser visual or interaction QA was performed. The previous render-count claim only established that drawing functions executed with a mock canvas; it did not establish visual correctness. CSS retains layered legacy rules, so responsive appearance needs real-browser review. The field/containment and crosstalk models remain educational approximations, not signoff solvers. The reflection lattice shows only the first eight flight paths and its labels are normalized gains, not instantaneous summed voltage.
