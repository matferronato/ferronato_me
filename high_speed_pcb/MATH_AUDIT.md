# Mathematical audit — v6.5

The prior version contained valid lossless transmission-line equations alongside unsupported quantitative illustrations. This audit checks the implemented models, corrects inconsistencies, and narrows claims where the available parameters do not support a physical prediction. Passing equations and tests does not validate a real PCB or its material parameters.

## Findings by feature

| Feature | Prior issue | Current status |
| --- | --- | --- |
| Signal generator | Rise-time-based indicators remained tied to a disabled slider for sine/triangle; random rate displayed MHz | Waveform-specific transition times; random rate in Mbit/s; causal bounded sources retained |
| Transmission line | Core delayed-wave sum was correct; near-perfect finite return loss was displayed as infinity | Retained superposition; exact matched-load infinity handling; boundary, energy and settling tests |
| Impedance matching | Effective load duplicated in different calculations; zero-ohm shunt approximated in metrics | One effective resistance calculation used throughout |
| Phase | Sine transfer function was correct for the assumed lossless resistive line | Verified against independently accumulated sinusoidal components of the time-domain solution |
| Differential pair | Alleged coupling percentage was an arbitrary drawing weight; magnitude meters looked like signed voltages | Removed coupling percentage; labels show magnitudes; ideal delayed-leg arithmetic verified |
| Crosstalk | Arbitrary geometry-to-coupling formula; NEXT and FEXT wrongly summed; finite difference could anticipate a transition | Replaced by explicit symmetric coupled-line modal model; distinct near/far voltages |
| Via fencing | Unsupported containment/leakage percentages; wavelength silently assumed relative permittivity 4 | Removed percentage predictions; bulk-dielectric wavelength and geometric ratios only |
| Stackup | Hybrid thickness correction and different effective-permittivity calculations for impedance and velocity | Consistent Hammerstad–Jensen calculation in JavaScript and Python |
| Shared propagation | Stackup changed its displayed velocity without changing the simulated velocity | Geometry-derived propagation by default; explicit manual override |
| Plots | Time sampling could miss narrow transitions; V/div range had four rather than eight divisions | Adaptive sample count and eight vertical divisions |
| Design review | Qualitative thresholds appeared to be pass/fail judgments | Model checks; intentional source-termination reflections explicitly noted |
| Python API | Infinity emitted as nonstandard JSON; invalid impedance inputs not consistently rejected | Strict JSON using null plus explicit infinity flags; input-domain checks |

## 1. Sources and units

Time in the physics functions is ns; geometry is mm; frequency controls are MHz, with the via reference in GHz. `td = length / velocity` therefore returns ns. Skew is converted to ps by multiplying by 1000.

Step: 0 to A, linear ramp duration tr/0.8, so its 10–90% interval is exactly tr. Bipolar square and NRZ use a maximum normalized slew of 1.6/tr, retaining continuity across symbol boundaries. A slow edge may not reach the requested rail before the next symbol. Sine and triangle slopes are determined by frequency. Their bipolar 10–90% transition durations are asin(0.8)·T/π and 0.4T respectively. A single phase angle is not assigned to a step or random data.

The 0.5/tr edge-frequency indicator remains a heuristic, not a spectrum measurement or a universal bandwidth. Sine displays its actual tone frequency.

## 2. Transmission line, matching and phase

The model is a uniform lossless line with resistive source and load. Effective source resistance is Rs + Rt in series mode and Rs otherwise. Parallel mode uses RL·Rt/(RL + Rt), with an exact zero-ohm branch. Other modes use RL directly.

The launch factor is Z0/(Z0 + Rs_eff). Reflection coefficients are (R − Z0)/(R + Z0). Forward and backward components use causal delays (2n + x)td and (2n + 2 − x)td, weighted by successive products of the source and load coefficients. Total voltage is their sum. Current is (forward − backward)/Z0.

Tests enforce the source and load voltage/current boundary equations, power balance, and the settled resistive divider. At the load, reflected = ΓL·forward and Sum = Load. The source waveform is not added to the local sum a second time.

The sine transfer is H = launch·(1 + ΓL)·exp(−jωtd) / [1 − ΓLΓS·exp(−j2ωtd)]. The displayed phase is its steady-state phase, not the startup transient's phase. Zero load voltage has undefined phase.

Reference: [TI AN-807, Reflections: Computations and Waveforms](https://www.ti.com/lit/pdf/snla027).

Limitations: no conductor/dielectric loss, dispersion, nonlinear drivers, capacitive receivers or connectors. The adjustable resistive receiver is not a CMOS input model. The GUI does not provide an ideal open-circuit load. Coefficients below an absolute 1e-8 V contribution tolerance are dropped. The lattice shows only the first eight paths and labels normalized gain.

## 3. Stackup model

The corrected implementation uses normalized W/H and T/H, Hammerstad–Jensen finite-thickness width corrections, the same quasi-static impedance expression, and the corresponding thickness-corrected effective permittivity. Velocity is c/sqrt(epsilon_eff). Geometry mode feeds this velocity to the signal labs; manual mode is a deliberate override.

For W = 0.15 mm, H = 0.12 mm, T = 0.035 mm and er = 4.1:

- Z0 = 59.95146453 Ω
- Effective permittivity = 2.83769489
- Velocity = 177.96633377 mm/ns

These are model outputs, not measured PCB values. Solder mask, copper roughness, frequency dispersion and losses are excluded. Extreme metal thickness needs field-solver validation; finite numerical results alone do not prove model accuracy there.

References: [Qucs single-microstrip equations](https://qucs.sourceforge.net/tech/node75.html), [scikit-rf reference implementation](https://scikit-rf.readthedocs.io/en/latest/_modules/skrf/media/mline.html). The latter resolves the normalized-width ambiguity in the printed thickness equation. The implementation was checked against those equations; the scikit-rf package itself was not executed.

## 4. Differential pair

Vp(t) = differential_Vpp/4 · source(t − td), and Vn(t) is the negative of the same signal delayed by the extra skew. Vdiff = Vp − Vn; Vcm = (Vp + Vn)/2. Zero skew gives zero common mode. For bipolar periodic signals, Vdiff has the requested peak-to-peak amplitude. A unipolar step has half that excursion, as labeled.

This is an ideal skew demonstration. Pair spacing changes the geometry drawing, but does not extract even/odd impedance, insertion loss or a physical field-coupling percentage. The meter bars show absolute magnitudes; the plots retain sign.

## 5. Crosstalk replacement

The old quantitative model was not defensible as a PCB prediction. The replacement requires explicit normalized mutual coefficients kC = Cm/C and kL = Lm/L. C is the diagonal capacitance-matrix term; off-diagonal entries are −Cm. Inductance off-diagonal entries are +Lm. Geometry does not extract these values.

For symmetric uniform lines:

- Ze = Z0 sqrt[(1 + kL)/(1 − kC)]
- Zo = Z0 sqrt[(1 − kL)/(1 + kC)]
- te = tc sqrt[(1 + kL)(1 − kC)]
- to = tc sqrt[(1 − kL)(1 + kC)]

Here tc is parallel length divided by the uncoupled velocity. Each physical conductor is terminated in uncoupled Z0 at both ends. The existing lossless reflection solution is applied to each mode, including the resulting small modal termination mismatches. Physical voltages are Ve + Vo on the aggressor and Ve − Vo on the victim.

NEXT is the victim at x = 0; FEXT is the victim at x = 1. They are separate traces, never summed as one receiver voltage. The aggressor generator is 2A open circuit so A denotes its nominal incident voltage with uncoupled matched ports. At zero coupling, both crosstalk traces vanish. With kC = kL the equal-modal-velocity symmetric case cancels FEXT. The tests also enforce all physical source/load port boundary equations.

Reference for even/odd characterization: [Qucs coupled lines](https://qucs.sourceforge.net/tech/node77.html). The equations above follow directly from diagonalizing the stated symmetric L and C matrices. They do not constitute a geometry extractor or a lossy full-wave model.

## 6. Via transition and review

Bulk dielectric wavelength is lambda = 299.792458 / [f_GHz sqrt(er)] mm. The plot shows pitch/lambda. This is not a solved via propagation mode or resonance. Gap and return-via settings affect a schematic field illustration only. No insertion loss, field leakage, containment percentage or guaranteed safe fence pitch is calculated.

Review values are model checks. Spacing and edge-ratio thresholds are heuristics, not manufacturing or receiver specifications. A high positive load reflection can be intentional in a series-terminated high-impedance link.

## 7. Reproduce validation

From the extracted application folder:

```bash
node tests/verify_math.cjs
node tests/verify_render.cjs
```

Requires Node.js and Python 3, with no extra packages.

Results: 4,664 mathematical checks plus reference fixtures; 108 JavaScript/Python microstrip comparisons; strict-JSON/domain checks; 213 render executions and trace-checkbox checks for eight plots. Tests include waveform bounds, rise times, continuity, causality, impedance monotonicity, dielectric bounds, boundary currents, power balance, settling, phase, differential cancellation, modal cancellation, and wavelength scaling.

The render checks use a mocked DOM/canvas. They detect execution and nonfinite-coordinate errors, not real-browser layout defects. No real-browser visual QA, SPICE comparison, field-solver extraction or bench validation was performed. This audit supersedes historical model claims in older releases and AUDIT.md.
