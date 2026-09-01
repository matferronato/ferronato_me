# Retarded Field Bench

An interactive 2-D visualisation of the Liénard–Wiechert field of moving charges,
solved **per pixel on the GPU**. No dependencies beyond a browser with WebGL 2.

```bash
python3 app.py --port 8001        # add --open to launch a browser
```

Then open `http://127.0.0.1:8001`.

---

## The GPU pipeline

The field is computed, not suggested. Every pixel solves

```
t_r = t − |x − p(t_r)| / c
```

by fixed-point iteration against each charge's stored worldline, then evaluates
the full Liénard–Wiechert field there.

| Pass | Runs at | Does |
|---|---|---|
| 1 — field | adjustable fraction of canvas resolution | retarded-time solve + Liénard–Wiechert, into two float render targets |
| 2 — shade | full resolution | line-integral convolution, tone mapping, grid, vector glyphs |

Pass 2 only reads textures, so field lines and arrows are nearly free and stay
crisp when the physics pass runs at 40%. Resolution auto-adjusts to hold 60 fps.

Worldlines live in float textures on a uniform time grid, so a retarded lookup is
an index computation rather than a binary search, and only the columns written
since the last frame are uploaded. Charges still long enough for the news to
reach every visible point skip the retarded solve entirely. Physics is fixed-step
120 Hz, decoupled from rendering: the heaviest scene costs 0.09 ms/step.

`physics.js` and the fragment shader implement the same equations twice, in JS
and GLSL. They agree to **1e-14**, so the numbers under the cursor are the
numbers on screen.

---

## Radiated power

Turn on the flux ring and the bench integrates `S = E×B` around a circle. Two
numbers come back. The line integral `∮S·n dl` is the honest 2-D one, and it
falls as 1/R, because the field carries the 3-D 1/R radiation falloff while the
perimeter only grows as R. Weighting by an extra factor of R gives what a
spherical shell would have contributed, and that number is radius-independent —
it is a 2-D proxy for radiated power, not a closed surface integral.

Measured, with prescribed motion so the field code is isolated:

| | |
|---|---|
| radius independence, R = 4 → 10 | **0.5%** |
| `P ∝ amplitude²`, 16× range, β < 0.13 | **0.25%** |
| `P ∝ ω⁴`, β < 0.15 | **1%** |

Above β ≈ 0.2 both drift upward by several percent — that is relativistic
beaming, which the formula contains and the scaling law does not.

The polar plot is outward flux against angle, time-averaged. Near-field terms
contribute a large reactive flux that changes sign twice per cycle and averages
to nothing, which is why the average is what gets displayed.

## Radiation reaction

Abraham–Lorentz (`F = mτȧ`) has runaway solutions. The bench uses the
Landau–Lifshitz reduced-order substitution `ȧ → (1/m) dF_ext/dt`, which is
purely dissipative. For a bound charge `F_ext = −kx`, so `F_rr = −τkv` — the
classical radiation damping of an oscillator, `γ = τω₀²`.

Ring-down tests, releasing a displaced charge and fitting the decay:

| | |
|---|---|
| decay rate vs theoretical `τω₀²/2` | **2.3%** |
| radiation damping added to explicit damping | exactly additive (0.03927 either way) |
| τ = 0 and no damping: numerical decay | **−1e-5** — the integrator conserves |

Energy balance: the work done against the reaction force tracks the Poynting
flux, with `P_rr/(τ·P_poynting)` constant to **0.6%** as τ → 0. It is not exactly
constant at finite τ — the spread runs 4.6% → 1.6% → 0.6% as τ shrinks — because
the reduced-order form is accurate to O(τω). That residual is the approximation,
not a bug.

Drive a resonant antenna and raise the slider: the swing collapses **4.5×**. The
radiated power peaks at intermediate τ, since too little damping couples weakly
and too much collapses the amplitude. Impedance matching, unasked for.

## Probes and measuring c

Drop two probes and the strip recorder becomes an oscilloscope, sampled at the
physics rate rather than once per frame.

The bench then measures c from them — without ever reading the c slider. It does
this by timing the **causal onset**, not by cross-correlating the waveforms.
Correlation only fixes the delay modulo a period, and near-field phase does not
travel at c anyway; both were tried and both were wrong by tens of percent. The
causal edge has neither problem: a probe reads a constant static field, and then
at one definite moment it does not.

Place two probes, press `R`, and watch the front arrive. Measured against the set
value across scenarios and c from 2.0 to 6.0: **0.0% to 7% low**, biased low
because a 6%-of-peak threshold crossing is slightly later than the true front,
and later for a far probe than a near one because the edge is shallower.

This assumes one compact, roughly stationary emitter. It is meaningless for a
distributed source like a wire, and for a charge in circular motion it reads 69%
low, because the emission point moves between the two arrivals.

---

## Scenarios

### DC current in a wire
Twenty electrons drift at constant velocity through a fixed ion lattice. Neutral
wire, so E cancels and pure B is left, sign-flipped across the wire. A test
charge alongside is pulled in by `v×B` — parallel currents attract. No light
cones ever appear, and the flux ring reads **−1e-5**: uniform motion does not
radiate, confirmed two independent ways.

### Induction between two wires
Top wire driven AC. Bottom wire is just metal — mobile electrons plus ions.

| | |
|---|---|
| wave transit across the gap | 1.81 s |
| induced current first non-zero | **1.82 s** (exactly zero before) |
| induced / primary | 44% |
| peak corr(`I_induced`, `−dI_primary/dt`) | **0.995** |
| extra phase lag beyond transit | **31°** |

Lenz's law is not coded anywhere. The 31° is the receiving loop's own inertia and
resistance — push the damping up and it goes to zero with the correlation going
to 1, which is the resistive limit.

### Phased array
Six elements in a line, each oscillating along y, with a phase step between
neighbours. Steer it with the slider: `sin α = −Δφ/(kd)`. The dashed line is the
prediction, the polar plot is the measurement. **They agree to within 1.5°**
across the full steering range. Both lobes are equal — a line array with no
reflector is symmetric.

### Radiation damping
A resonant antenna driven by a fixed external force rather than a prescribed
motion, so it can be loaded. See above.

Also: manual drag, AC antenna, one-wave-two-charges, oscillating dipole,
circular motion, six mutually-interacting free charges.

## The 3-D surface

Tick **3D surface** and the field becomes a landscape. Drag to orbit, wheel to
move the camera, and the relief slider sets the vertical scale.

This costs almost nothing, because pass 1 is unchanged — the field is already
sitting in a texture. Only pass 2 differs: instead of shading a fullscreen
triangle, a 256×256 grid is drawn and the *vertex* shader reads the same
textures to displace it, taking normals from a central difference on the height.

Height and colour come from one number: the tone-mapped scalar the flat view
already uses for colour. So the surface is the flat image lifted, not a second
quantity on its own scale. **Why both charges are hills in the E views.** Height there is `|E|`, the
magnitude of a vector, and a magnitude has no sign — a positive and a negative
charge produce equally large fields, so both push the surface up. That is
correct for what is being plotted, but it is not the picture most people have in
mind.

The quantity that gives a peak and a valley is the **potential**, φ, which is a
scalar and carries the charge's sign. It is now its own view. Across a
positive/negative pair it reads +6.35 at one charge, −6.35 at the other and
exactly 0 midway, where `|E|` is a hill at both ends and non-zero in between.
It is the retarded Liénard–Wiechert potential `q/(κR)`, so it lags like
everything else here. Vector glyphs stay switched on in this view and point
along `E = −∇φ` — downhill, which is worth watching as a consistency check.

That matters for the signed views — in `B` the
mapping is `tanh`, so the surface has genuine hills and valleys where the field
comes out of and into the page, and the zero plane is the neutral line. In the
E views the scalar is a magnitude, so the plate only ever rises.

Charges are drawn as lit spheres, one instanced draw call for all of them. The
vertex shader reads the same field textures, finds the terrain height and normal
under each charge, and puts the sphere centre one radius along that normal — so
a particle rests *on* the relief and rides it as the field deforms, rather than
floating at a fixed height. They share the surface's depth buffer, so a ridge in
front will occlude them.

What that shows depends on the view. In `Total E` a charge sits on top of its own
spike, since its own near field is singular there. In `ΔE` a charge at rest has
nothing to lift it and sits flat on the plate — until a wave arrives, and then
the ground rises under it. `Radiation` is the interesting one: a charge only
mounds up while it is accelerating.

Charges can be dragged in the surface view: grab one and it slides across the
terrain under the cursor, orbiting only when you drag the background or hold
shift. A screen pixel maps to a ray rather than a point here, so the drag is
resolved against the horizontal plane the charge is currently sitting on. The
projection and its inverse round-trip to 5e-5 over a wide range of camera
angles.

Probes stand on the relief too. The height they use is computed on the CPU from
the same tone mapping the shader applies, and the two agree exactly — checked
across five scenarios, all five views and three exposures, max disagreement 0.

If the surface program will not build on a given GPU, the checkbox disables
itself with the driver's message in its tooltip and the flat view carries on.
An optional garnish should not be able to take down the field view.

Field lines and vector glyphs are screen-space effects and are switched off
here; contour bands take their place. Charges are projected through the same
camera the shader used and pinned to the base plane with a stem, so you can see
which peak belongs to which charge.

Worth doing: put the dipole in `Radiation` mode and orbit until you are looking
along the oscillation axis — the `sin²θ` null becomes a valley you can sight
down. `dc-wire` in `B` shows the field reversing sign across the wire as a
ridge and a trench.

## Views

| View | Shows |
|---|---|
| Total E | near field + radiation |
| Near field | the 1/R² term only |
| Radiation | the 1/R acceleration term only — the wave |
| ΔE | total minus the field of the same charges at rest |
| B | signed `B_z`, warm out of the page, cool into it |
| φ | the retarded scalar potential — signed, so + is a hill and − a hollow |

## Controls

Space play/pause · `S` step · `R` reset · `1`–`5` switch view · `Del` delete.
Wheel zooms about the cursor, shift-drag pans, double-click adds a charge (alt
for negative), right-click deletes a charge or a probe. Drag any charge to
accelerate it by hand.

## Caveats

Two-dimensional and educational. Units are chosen so things move at watchable
speeds; β is clamped at 0.9 inside the field formula and κ has a floor, which
keeps near-singular geometry finite rather than faithful.

Forces use Plummer softening `q·R/(R²+s²)^{3/2}` while rendering uses
`q·n̂/(R²+s²)`. The two agree far away, but the rendering form tends to a
*constant magnitude* as R → 0 — a bang-bang force with no restoring gradient —
which is fine for a picture and wrong for a spring. Only the force path was
changed; rendering is untouched and still matches the shader to 1e-14.

A conduction electron ignores its own co-located ion when computing the force on
itself. The lattice is there for neutrality and long-range field; local binding
is stated explicitly as `spring`. Without this a "free" electron is tethered to
one ion and a wire behaves as a dielectric rather than a conductor.

**Two free charges left to fall together will gain energy.** Released from rest
with damping off they attract, accelerate, pass through each other and then
escape, instead of oscillating as an isolated conservative pair would. The gain
is real and measurable — around +2.1 against a starting energy of −0.42 in the
default two-charge setup — and it appears only during a very close approach. It
is not the integrator (the same two-body problem integrated directly at the same
timestep conserves to 3e-5) and it is not relativity or retardation (it persists
at beta = 0.006 with c raised a hundredfold). What remains is the retarded
lookup itself: forces are read from a worldline sampled at a fixed 120 Hz, and
during a violent close pass that sampled history no longer represents the motion
well enough for the force to stay conservative. Keep some damping on free
charges, or enough mass that they never plunge, and it does not arise.

There is no radiation reaction on kinematic charges — a prescribed motion is
prescribed. Only `dynamic` charges can be loaded.

**A conducting mirror was attempted and cut.** A sheet dense enough to shield is
unstable: the chain buckles with no wave present at all. Raising the charge does
not help, because the tether stiffness rises as `q²` while the drive rises as
`q`, leaving the induced dipole per site unchanged. The best stable configuration
transmitted 73% and reflected 2% — a slightly lossy window, not a mirror.
