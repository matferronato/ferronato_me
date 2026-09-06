# SI Studio 6.2

A signal-integrity learning workspace with seven connected labs, redesigned navigation, readable controls, and dark instrument plots.

## Run

Extract the ZIP, enter the high_speed_board_visualizer folder, and run:

```bash
python3 server.py
```

Open http://127.0.0.1:8421. To choose another port:

```bash
PORT=9000 python3 server.py
```

No packages or external assets are needed. You may also open index.html directly; the Python API is optional.

## Signal generator

Transmission line, matching, differential pair, and crosstalk share Step, Sine, Square, Triangle, and Random NRZ excitation. Frequency ranges from 50 to 2000 MHz; for NRZ this denotes 50 to 2000 Mbit/s. The step has no frequency, so that control is disabled. Random bits are deterministic to support repeatable comparisons.

Amplitude is 0.2 to 1.8 V peak (step: 0 to A; other signals: -A to +A). Differential amplitude is specified separately as differential Vpp; each leg has Vpp/4 peak. All controls update while paused too. Reset restores the source and all channel parameters.

Edge time is the 10–90% rise time of the linear step/square/NRZ transition. Square and NRZ transitions are slew-limited continuously across symbol boundaries; high rates with slow edges may never reach the requested levels. Sine and triangle slopes follow frequency. Eight animation seconds cover the selected physical time window. Choose a fixed 4, 12, 24, or 80 ns span. Changing amplitude, frequency, or geometry preserves the current cursor position. Scrub time to pause at an exact instant, or use Replay. The voltage scale is selectable in V/div and stays fixed when amplitude changes.

## Models and verification

The lossless transmission-line spatial and receiver views use the same causal delayed-wave superposition, including source/load reflections and series/parallel termination. Contributions smaller than 1e-8 V are dropped; all causally relevant round trips in the selected time window are evaluated. The matching lattice displays path coefficients, not a periodic-wave envelope.

Crosstalk is a derivative-based educational coupling estimate, not a broadband coupled-line solver. Via containment and field drawings remain qualitative geometry models with a separate equivalent-frequency control. These models omit conductor/dielectric loss and frequency-dependent impedance.

Validated JavaScript syntax, 210 mocked-canvas lab renders, a known 0.500 + 0.250 = 0.750 V reflection fixture, 300 source/load boundary checks across five waveforms and three termination modes, differential receiver time alignment, continuous high-rate slew, short-load behavior, and timebase preservation. These are numerical and execution checks, not browser visual QA. No browser visual QA was performed.


## Dark mode and voltage addition

Dark mode is the default. The header toggle selects light mode and saves your preference when browser storage is available.

Transmission line has a movable voltage probe. Dashed cyan is the forward-traveling voltage (including source re-reflections), dashed red is the backward-traveling voltage, and solid green is their sum. The readout reports all three at exactly the same position and time. At the load, the green spatial value is the same quantity as the receiver plot. Driver Vs in the receiver plot is the generator's open-circuit voltage, not the forward-wave amplitude.

The fixed vertical scale may clip large excursions. The transmission-line readout reports when the total spatial trace exceeds its scale; increase V/div to inspect it.

See AUDIT.md for the assessment of v6 regressions and inherited issues.


## Desktop screen layout

At viewport sizes of 1100 × 680 CSS pixels and above, each experiment fits the browser window: a shared time toolbar above, animation and result plots stacked in the main area, and excitation/geometry controls at the right. Differential and common-mode plots remain side by side. Canvases fit the available panel dimensions without stretching the physical geometry.

Lab notes opens the supporting explanations. System opens the shared channel diagram. Both panels close with Close or Escape. Dark/light mode and all simulation controls are retained. On smaller windows or enlarged browser text, the layout allows scrolling rather than clipping controls. Extremely constrained control columns can scroll independently while the animation and plots remain visible. Design review retains its own scrollable text view.

Validation for this release: JavaScript syntax, local asset references, and canvas allocation in desktop/fallback modes at three panel sizes. Real-browser layout verification was not performed.
