"use strict";
/*
 * scenarios.js — the experiment library.
 *
 * Each scenario builds a set of charges and picks sensible view defaults.
 * `chart` declares up to two traces for the strip recorder in the inspector.
 */
(function (global) {

  const ELECTRON = -1;
  const ION = 1;

  /** Let a single member of a wire emit light-cone markers, so the causal
   *  front is one clean ring instead of a thicket of overlapping ones. */
  function soleRingEmitter(E, group) {
    let best = null;
    for (const c of E.charges) {
      if (c.group !== group) continue;
      c.rings = false;
      if (!best || Math.abs(c.pos.x) < Math.abs(best.pos.x)) best = c;
    }
    if (best) best.rings = true;
  }

  /** Evenly spaced x positions covering [-half, half]. */
  function lattice(half, spacing) {
    const xs = [];
    const n = Math.floor((2 * half) / spacing);
    for (let i = 0; i < n; i++) xs.push(-half + (i + 0.5) * spacing);
    return xs;
  }

  const SCENARIOS = [
    {
      id: "manual",
      name: "Manual drag",
      blurb: "Nothing moves on its own. Drag a charge and watch the kink in its field crawl outward at c — the far field keeps pointing at where the charge used to be until the news arrives.",
      view: { mode: "disturbance", c: 2.4, exposure: 3.2, arrows: 34, lic: 0.85, gain: 1, running: false },
      build(E) {
        E.add({ q: 1.4, pos: { x: -2.0, y: 0 }, mode: "static", label: "drag me" });
        E.add({ q: -1.2, pos: { x: 2.0, y: 0 }, mode: "static" });
      }
    },

    {
      id: "dc-wire",
      name: "DC current in a wire",
      blurb: "Twenty electrons drift right at constant speed through a fixed lattice of positive ions. The wire is electrically neutral, so E cancels — what is left is a pure magnetic field, out of the page above the wire and into it below. The loose test charge drifting alongside is pulled in by v×B: parallel currents attract.",
      view: { mode: "magnetic", c: 3.0, exposure: 2.6, arrows: 0, lic: 0.5, gain: 1, running: true },
      chart: {
        title: "Current",
        series: [{ label: "wire I", color: "#ffb056", get: E => E.groupCurrent("driver") * 0.5 }]
      },
      build(E) {
        const half = 8.4, spacing = 0.8, drift = 1.15;
        for (const x of lattice(half, spacing)) {
          E.add({ q: ION, pos: { x, y: 0 }, mode: "static", group: "lattice", rings: false });
          E.add({
            q: ELECTRON, pos: { x, y: 0 }, mode: "uniform", group: "driver",
            vel: { x: drift, y: 0 }, recycle: { min: -half - 0.2, max: half + 0.2 }
          });
        }
        E.add({
          q: ELECTRON, pos: { x: -3.2, y: 3.2 }, mode: "dynamic", mass: 2.2,
          vel: { x: drift, y: 0 }, damping: 0.02, group: "probe",
          bounds: { x: 9, y: 4.6 }, label: "test charge"
        });
        soleRingEmitter(E, "driver");
      }
    },

    {
      id: "ac-wire",
      name: "AC current (antenna)",
      blurb: "The same wire, but now the whole electron population sloshes back and forth together. Every reversal is an acceleration, and acceleration is the only thing that radiates: the 1/R transverse field peels off the wire and leaves.",
      view: { mode: "radiation", c: 3.2, exposure: 5.0, arrows: 0, lic: 0.7, gain: 1, running: true },
      chart: {
        title: "Current",
        series: [{ label: "wire I", color: "#ffb056", get: E => E.groupCurrent("driver") * 0.5 }]
      },
      build(E) {
        for (const x of lattice(6.4, 0.8)) {
          E.add({ q: ION, pos: { x, y: 0 }, mode: "static", group: "lattice", rings: false });
          E.add({
            q: ELECTRON, pos: { x, y: 0 }, mode: "oscX", group: "driver",
            anchor: { x, y: 0 }, amplitude: { x: 0.5, y: 0 }, frequency: 0.34
          });
        }
        soleRingEmitter(E, "driver");
      }
    },

    {
      id: "induction",
      name: "Induction between two wires",
      blurb: "Top wire: a driven AC current. Bottom wire: electrons free to slide along the metal, nothing else. When the wave crosses the gap it pushes those electrons, and the induced current runs opposite to the change that caused it — Lenz's law falling out of a retarded field, not a rule. That induced current then radiates its own wave back.",
      view: { mode: "disturbance", c: 3.2, exposure: 3.6, arrows: 0, lic: 0.8, gain: 2.5, running: true },
      chart: {
        title: "Currents",
        series: [
          { label: "primary", color: "#ffb056", get: E => E.groupCurrent("driver") * 0.6 },
          { label: "induced", color: "#5fe3d0", get: E => E.groupCurrent("induced") * 3.0 }
        ]
      },
      build(E) {
        const yDrive = 2.9, yInduced = -2.9;
        for (const x of lattice(3.6, 0.8)) {
          E.add({ q: ION, pos: { x, y: yDrive }, mode: "static", group: "lattice", rings: false });
          E.add({
            q: ELECTRON, pos: { x, y: yDrive }, mode: "oscX", group: "driver",
            anchor: { x, y: yDrive }, amplitude: { x: 0.45, y: 0 }, frequency: 0.30
          });
        }
        for (const x of lattice(4.8, 0.75)) {
          const ion = E.add({ q: ION, pos: { x, y: yInduced }, mode: "static", group: "lattice", rings: false });
          E.add({
            q: ELECTRON, pos: { x, y: yInduced }, mode: "dynamic", group: "induced",
            anchor: { x, y: yInduced }, axis: { x: 1, y: 0 }, mass: 1.0,
            damping: 2.0, spring: 0.6,
            recycle: { min: -5.2, max: 5.2 }, ignoreId: ion ? ion.id : null
          });
        }
        soleRingEmitter(E, "driver");
        soleRingEmitter(E, "induced");
      }
    },

    {
      id: "receiver",
      name: "One wave, two charges",
      blurb: "A single driven charge on the left. On the right, one electron held by a weak spring. It sits perfectly still until the first wavefront reaches it, then starts to ring — and once it is accelerating it becomes a second source, with its own circular wave expanding from a different centre.",
      view: { mode: "radiation", c: 2.8, exposure: 7.0, arrows: 0, lic: 0.75, gain: 8, running: true },
      chart: {
        title: "Transverse velocity",
        series: [
          { label: "source", color: "#ff8a6b", get: E => (E.charges[0]?.vel.y ?? 0) * 0.8 },
          { label: "receiver", color: "#5fe3d0", get: E => (E.charges[1]?.vel.y ?? 0) * 6 }
        ]
      },
      build(E) {
        E.add({
          q: 1.5, pos: { x: -5.2, y: 0 }, mode: "oscY", group: "driver",
          anchor: { x: -5.2, y: 0 }, amplitude: { x: 0, y: 1.0 }, frequency: 0.26, label: "source"
        });
        E.add({
          q: -1.2, pos: { x: 4.4, y: 0 }, mode: "dynamic", group: "induced",
          anchor: { x: 4.4, y: 0 }, mass: 1.0, spring: 1.8, damping: 0.28,
          bounds: { x: 7.5, y: 4.5 }, label: "receiver"
        });
      }
    },

    {
      id: "dipole",
      name: "Oscillating dipole",
      blurb: "Equal and opposite charges beating against each other. The radiated power vanishes along the oscillation axis and peaks broadside — the classic doughnut pattern, seen edge-on.",
      view: { mode: "radiation", c: 3.0, exposure: 5.5, arrows: 0, lic: 0.7, gain: 1, running: true },
      build(E) {
        E.add({
          q: 1.3, pos: { x: 0, y: -0.6 }, mode: "oscY", anchor: { x: 0, y: -0.6 },
          amplitude: { x: 0, y: 0.9 }, frequency: 0.3, group: "driver"
        });
        E.add({
          q: -1.3, pos: { x: 0, y: 0.6 }, mode: "oscY", anchor: { x: 0, y: 0.6 },
          amplitude: { x: 0, y: 0.9 }, frequency: 0.3, phase: Math.PI, group: "driver"
        });
      }
    },

    {
      id: "cyclotron",
      name: "Charge on a circle",
      blurb: "Constant speed, constant turning: the acceleration vector sweeps around, and the radiation spirals out with it. Turn up the speed and the pattern beams forward along the motion.",
      view: { mode: "total", c: 3.4, exposure: 2.4, arrows: 0, lic: 0.85, gain: 1, running: true },
      build(E) {
        E.add({
          q: 1.6, pos: { x: 1.8, y: 0 }, mode: "circle", anchor: { x: 0, y: 0 },
          amplitude: { x: 1.8, y: 1.8 }, frequency: 0.24, group: "driver"
        });
      }
    },

    {
      id: "plasma",
      name: "Free charges",
      blurb: "Six charges, no script. Each one is pushed by the delayed field of the others, so momentum arrives late and the group never quite settles.",
      view: { mode: "total", c: 3.0, exposure: 2.2, arrows: 30, lic: 0.7, gain: 1.6, running: true },
      build(E) {
        const seed = [
          [-3.4, -1.2, 1.3], [3.1, 1.0, -1.3], [0.4, 2.4, 1.1],
          [-1.6, 1.9, -1.0], [2.2, -2.2, 1.2], [-3.0, 2.6, -1.1]
        ];
        for (const [x, y, q] of seed) {
          E.add({
            q, pos: { x, y }, mode: "dynamic", mass: 1.3, damping: 0.06,
            bounds: { x: 7.4, y: 4.4 }
          });
        }
      }
    },

    {
      id: "array",
      name: "Phased array",
      blurb: "Six elements in a vertical line, each oscillating along y, driven at the same frequency but with a fixed phase step from one element to the next. With no step the lobe points broadside. Walking the step steers it: sin(alpha) = -dphi/(k d). The dashed line is the predicted direction — the polar plot measures where the energy actually goes.",
      view: { mode: "radiation", c: 3.2, exposure: 3.4, arrows: 0, lic: 0.55, gain: 0, running: true },
      params: [
        { id: "dphi", label: "Phase step between elements", min: -2.4, max: 2.4, step: 0.05, value: 0, unit: "rad" }
      ],
      flux: { r: 7.2, radOnly: true },
      build(E) {
        const N = 6, d = 1.05, f = 1.2;
        E.arrayGeom = { N, d, f };
        for (let i = 0; i < N; i++) {
          const y = (i - (N - 1) / 2) * d;
          E.add({
            q: 1, pos: { x: 0, y }, mode: "oscY", group: "driver",
            anchor: { x: 0, y }, amplitude: { x: 0, y: 0.10 },
            frequency: f, phase: 0, rings: false
          });
        }
      },
      apply(E, p) {
        const el = E.charges.filter(c => c.group === "driver");
        el.forEach((c, i) => { c.phase = i * p.dphi; });
      },
      /** Predicted main-lobe direction, measured from +x. */
      beam(E, p) {
        const g = E.arrayGeom;
        if (!g) return null;
        const k = (Math.PI * 2 * g.f) / E.c;
        const s = -p.dphi / (k * g.d);
        if (Math.abs(s) > 1) return null;             // steered past endfire
        const a = Math.asin(s);
        return [a, Math.PI - a];                      // symmetric pair, +x and -x sides
      }
    },

    {
      id: "loading",
      name: "Radiation damping",
      blurb: "A resonant antenna driven by a fixed external force — not a prescribed motion, so it can be loaded. Its amplitude is set by how fast it loses energy. Raise the radiation-reaction slider and the swing collapses: the charge is now paying for the wave it emits. Nothing else in the scene changed.",
      view: { mode: "total", c: 3.0, exposure: 3.0, arrows: 0, lic: 0.6, gain: 2, running: true },
      flux: { r: 5.2, radOnly: true },
      chart: {
        title: "Antenna swing and radiated power",
        series: [
          { label: "swing", color: "#4fd8e8", get: E => (E.charges[1]?.swing ?? 0) * 1.6 },
          { label: "P radiated", color: "#ffb056", get: E => (E.lastPower ?? 0) * 6 }
        ]
      },
      build(E) {
        const k = 6, f = Math.sqrt(k) / (Math.PI * 2);   // driven exactly on resonance
        const core = E.add({ q: -1.5, pos: { x: 0, y: 0 }, mode: "static", rings: false });
        E.add({
          q: 1.5, pos: { x: 0, y: 0 }, mode: "dynamic", group: "driver",
          axis: { x: 0, y: 1 }, anchor: { x: 0, y: 0 }, ignoreId: core ? core.id : null,
          mass: 1, spring: k, damping: 0.18, drive: { x: 0, y: 0.16, freq: f }
        });
      }
    }
  ];

  global.EM = global.EM || {};
  global.EM.SCENARIOS = SCENARIOS;
  /** Default parameter values for a scenario, as a plain object. */
  global.EM.scenarioParams = s => {
    const p = {};
    for (const d of s.params || []) p[d.id] = d.value;
    return p;
  };
  global.EM.scenarioById = id => SCENARIOS.find(s => s.id === id) || SCENARIOS[0];

})(window);
