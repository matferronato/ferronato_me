"use strict";
/*
 * app.js — glue: main loop, camera, pointer interaction, overlay canvas, UI.
 *
 * The GPU owns the field. The CPU owns eight charges' worth of arithmetic and
 * whatever the pointer is doing, so the loop stays responsive even when the
 * scene has forty sources in it.
 */
(function (global) {

  const EM = global.EM;
  const clamp = EM.clamp;
  const TAU = Math.PI * 2;

  const glCanvas = document.getElementById("glCanvas");
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");
  const wrap = document.getElementById("stage");
  const chartCanvas = document.getElementById("chart");
  const cctx = chartCanvas.getContext("2d");

  const $ = id => document.getElementById(id);
  const ui = {};
  for (const id of [
    "playBtn", "stepBtn", "resetBtn", "scenarioSelect", "scenarioBlurb", "addPos", "addNeg",
    "exposure", "exposureOut", "arrowDensity", "arrowOut", "licStrength", "licOut",
    "gridToggle", "trailToggle", "ringToggle",
    "timeScale", "timeScaleOut", "cSpeed", "cOut", "gain", "gainOut",
    "accuracy", "resScale", "resOut", "autoRes",
    "simClock", "fpsChip", "resChip", "modeLegend", "statusText", "tooltip",
    "probePos", "probeE", "probeRad", "probeB",
    "emptyInspector", "chargeInspector", "deleteBtn", "chargeBadge", "chargeId",
    "chargeValue", "motionMode", "velX", "velY", "ampX", "ampY", "freq", "phase",
    "mass", "spring", "damping", "axisLock", "selPos", "selVel", "selAcc",
    "zoomIn", "zoomOut", "zoomReset", "zoomLabel", "chartTitle", "chartLegend",
    "glError",
    "radReact", "radReactOut", "paramStrip",
    "fluxToggle", "fluxRadius", "fluxOut", "fluxPower", "fluxLine", "fluxLobe", "polar",
    "probeAdd", "probeClear", "probeHint",
    "cSource", "cPath", "cDelay", "cMeasured",
    "view3d", "contourToggle", "surfHeight", "heightOut", "heightRow",
    "particleToggle", "particleSize", "particleOut", "particleRow"
  ]) ui[id] = $(id);
  const polarCtx = ui.polar.getContext("2d");

  const engine = new EM.Engine();
  let renderer = null;

  const view = {
    worldHeight: 10, zoom: 1, cx: 0, cy: 0,
    cssW: 1, cssH: 1, dpr: 1
  };

  const state = {
    running: false,
    mode: "total",
    scenario: "manual",
    freeRunUntil: 0,
    stepPending: 0,
    selectedId: null,
    hoverId: null,
    draggingId: null,
    dragOffset: { x: 0, y: 0 },
    dragLastT: 0,
    dragLastPos: null,
    dragLastVel: { x: 0, y: 0 },
    panning: false,
    panLast: null,
    pointer: null,
    lastMs: performance.now(),
    frameEma: 16,
    flow: 0,
    chart: null,
    chartData: [],
    chartHead: 0,
    params: {},
    armProbe: false,
    fluxN: 180,
    fluxSamples: new Float32Array(180),
    polarAvg: new Float64Array(180),
    polarSeen: 0,
    frameTick: 0,
    powerAvg: 0,
    lineAvg: 0,
    // height-field camera: yaw/pitch in radians, distance in plate spans
    cam: { yaw: -Math.PI / 2 + 0.35, pitch: 0.62, dist: 1.35 },
    orbiting: false,
    orbitLast: null,
    dragPlaneZ: 0
  };

  const is3D = () => ui.view3d.checked;

  const PROBE_COLORS = ["#7cf0b4", "#ffd166", "#c39bff", "#ff8f6b"];

  const CHART_N = 260;

  /* ------------------------------------------------------------- geometry */

  const viewH = () => view.worldHeight / view.zoom;
  const viewW = () => viewH() * view.cssW / Math.max(view.cssH, 1);

  function surfaceScale() {
    return Number(ui.surfHeight.value) * Math.max(viewW(), viewH()) * 0.55;
  }

  /**
   * The height the surface shader would give at this world point. Same tone
   * mapping, same scalar per mode — kept in step with SURF_VS by hand, and
   * only used to sit overlay marks on the relief.
   */
  function surfaceHeightAt(x, y) {
    const f = engine.fieldAt(x, y, null);
    const e = Number(ui.exposure.value);
    if (state.mode === "magnetic") return Math.tanh(f[2] * e);
    if (state.mode === "potential") return Math.tanh(f[11] * e);
    let vx, vy;
    if (state.mode === "radiation") { vx = f[3]; vy = f[4]; }
    else if (state.mode === "disturbance") { vx = f[5]; vy = f[6]; }
    else if (state.mode === "near") { vx = f[0] - f[3]; vy = f[1] - f[4]; }
    else { vx = f[0]; vy = f[1]; }
    const S = Math.hypot(vx, vy);
    return Math.pow(1 - Math.exp(-S * e), 0.85);
  }

  /** Radius the sphere shader gives this charge, in world units. */
  function particleRadius(ch) {
    const span = Math.max(viewW(), viewH());
    return span * 0.011 * (0.72 + 0.42 * Math.min(Math.abs(ch.q), 2.2))
         * Number(ui.particleSize.value);
  }

  /** Height of a charge's sphere centre above the plate. */
  function particleZ(ch) {
    return surfaceHeightAt(ch.pos.x, ch.pos.y) * surfaceScale() + particleRadius(ch);
  }

  /** Nearest charge to a screen point in the surface view, or null. */
  function chargeAt3D(sx, sy) {
    let best = null, bestD = 18;
    for (const ch of engine.charges) {
      const p = project3(ch.pos.x, ch.pos.y, particleZ(ch));
      if (!p) continue;
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestD) { bestD = d; best = ch; }
    }
    return best;
  }

  /** Screen position of a world point, flat or projected onto the plate. */
  function project3(x, y, z) {
    if (!renderer || !renderer.lastMVP) return null;
    return EM.project(renderer.lastMVP, x - view.cx, y - view.cy, z || 0,
                      view.cssW, view.cssH);
  }

  /**
   * In the surface view a screen pixel does not map to one world point — it
   * maps to a ray. We resolve it against the horizontal plane the dragged
   * charge is currently sitting on, so it slides across the terrain under the
   * cursor instead of jumping.
   */
  function screenToWorld3(sx, sy) {
    if (!renderer || !renderer.lastMVP) return { x: 0, y: 0 };
    const hit = EM.rayPlane(renderer.lastMVP, sx, sy, view.cssW, view.cssH, state.dragPlaneZ || 0);
    if (!hit) return { x: view.cx, y: view.cy };
    return { x: hit.x + view.cx, y: hit.y + view.cy };
  }

  function worldToScreen(x, y) {
    return {
      x: ((x - view.cx) / viewW() + 0.5) * view.cssW,
      y: (0.5 - (y - view.cy) / viewH()) * view.cssH
    };
  }
  function screenToWorld(sx, sy) {
    return {
      x: view.cx + (sx / view.cssW - 0.5) * viewW(),
      y: view.cy + (0.5 - sy / view.cssH) * viewH()
    };
  }
  const pxPerWorld = () => view.cssH / viewH();
  const viewDiagonal = () => Math.hypot(viewW(), viewH());

  /* ------------------------------------------------------------- scenarios */

  function buildScenarioMenu() {
    ui.scenarioSelect.innerHTML = "";
    for (const s of EM.SCENARIOS) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      ui.scenarioSelect.appendChild(opt);
    }
  }

  function loadScenario(id) {
    const s = EM.scenarioById(id);
    state.scenario = s.id;
    ui.scenarioSelect.value = s.id;
    ui.scenarioBlurb.textContent = s.blurb;

    engine.clear();
    view.zoom = 1; view.cx = 0; view.cy = 0;
    ui.zoomLabel.textContent = "100%";

    const v = s.view || {};
    engine.c = v.c ?? 2.8;
    ui.cSpeed.value = String(engine.c);
    setMode(v.mode ?? "total");
    ui.exposure.value = String(v.exposure ?? 3);
    ui.arrowDensity.value = String(v.arrows ?? 0);
    ui.licStrength.value = String(v.lic ?? 0.8);
    ui.gain.value = String(v.gain ?? 1);

    s.build(engine);
    buildParamStrip(s);
    engine.refreshStationary();
    engine.record();

    if (s.flux) {
      ui.fluxRadius.value = String(s.flux.r ?? 6);
      ui.fluxToggle.checked = true;
    } else {
      ui.fluxToggle.checked = false;
    }
    resetFlux();
    state.armProbe = false;
    ui.probeAdd.classList.remove("armed");

    state.chart = s.chart ?? null;
    state.chartData = (s.chart?.series ?? []).map(() => new Float32Array(CHART_N));
    state.chartHead = 0;
    loadChartLegend(s);

    state.running = !!v.running;
    state.freeRunUntil = 0;
    state.stepPending = 0;
    select(engine.charges[0]?.id ?? null);
    syncOutputs();
    updateTransport();
  }

  /* ------------------------------------------------------------ view modes */

  const MODE_TEXT = {
    total: "Total E — near field plus radiation, evaluated at the retarded time.",
    near: "Near field only — the 1/R² Coulomb term, carried along with the charge.",
    radiation: "Radiation only — the 1/R acceleration term. This is the wave.",
    disturbance: "Disturbance ΔE — total field minus the field of the charges at rest.",
    magnetic: "Magnetic B — out of the page in warm, into the page in cool. Arrows are off; B has no in-plane direction here.",
    potential: "Potential \u03c6 — signed, so a positive charge is a hill and a negative one a hollow. |E| cannot show this: a magnitude has no sign. Arrows still point along E = \u2212\u2207\u03c6, downhill."
  };

  function setMode(mode) {
    state.mode = mode;
    for (const btn of document.querySelectorAll("[data-mode]")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    ui.modeLegend.textContent = MODE_TEXT[mode];
    ui.arrowDensity.disabled = mode === "magnetic" || is3D();
  }

  /* --------------------------------------------------------------- overlay */

  function drawTrails() {
    if (!ui.trailToggle.checked) return;
    for (const ch of engine.charges) {
      if (ch.stationary) continue;
      const dense = engine.charges.length > 8;
      const pts = engine.trail(ch, dense ? 26 : 70, 5);
      if (pts.length < 6) continue;
      const color = ch.q >= 0 ? "255,122,98" : "90,169,255";
      octx.save();
      octx.lineWidth = 1.4;
      octx.lineJoin = "round";
      if (dense) {
        // one stroke per charge: constant alpha, no per-segment state changes
        octx.strokeStyle = `rgba(${color},0.34)`;
        octx.beginPath();
        let moved = false;
        for (let i = 0; i < pts.length; i += 2) {
          const p = worldToScreen(pts[i], pts[i + 1]);
          if (!moved) { octx.moveTo(p.x, p.y); moved = true; } else octx.lineTo(p.x, p.y);
        }
        octx.stroke();
      } else {
        for (let i = 2; i < pts.length; i += 2) {
          const a = worldToScreen(pts[i - 2], pts[i - 1]);
          const b = worldToScreen(pts[i], pts[i + 1]);
          if (Math.hypot(b.x - a.x, b.y - a.y) > view.cssW * 0.4) continue; // wire wrap
          octx.strokeStyle = `rgba(${color},${0.42 * (1 - i / pts.length)})`;
          octx.beginPath();
          octx.moveTo(a.x, a.y);
          octx.lineTo(b.x, b.y);
          octx.stroke();
        }
      }
      octx.restore();
    }
  }

  function drawRings() {
    if (!ui.ringToggle.checked) return;
    const scale = pxPerWorld();
    const maxR = Math.hypot(view.cssW, view.cssH) * 0.75;
    octx.save();
    octx.setLineDash([6, 7]);
    octx.lineWidth = 1;
    for (const ev of engine.events) {
      const r = engine.c * (engine.time - ev.t) * scale;
      if (r < 4 || r > maxR) continue;
      const c = worldToScreen(ev.x, ev.y);
      const fade = 0.30 * (1 - r / maxR);
      octx.strokeStyle = `rgba(226,242,255,${fade})`;
      octx.beginPath();
      octx.arc(c.x, c.y, r, 0, TAU);
      octx.stroke();
    }
    octx.restore();
  }

  function drawVector(p, vx, vy, scale, color, label) {
    const m = Math.hypot(vx, vy);
    if (m < 0.02) return;
    let ex = vx * pxPerWorld() * scale;
    let ey = vy * pxPerWorld() * scale;
    const len = Math.hypot(ex, ey);
    if (len > 90) { ex *= 90 / len; ey *= 90 / len; }
    const end = { x: p.x + ex, y: p.y - ey };
    const ang = Math.atan2(end.y - p.y, end.x - p.x);
    octx.save();
    octx.strokeStyle = color; octx.fillStyle = color; octx.lineWidth = 2;
    octx.beginPath(); octx.moveTo(p.x, p.y); octx.lineTo(end.x, end.y); octx.stroke();
    octx.beginPath();
    octx.moveTo(end.x, end.y);
    octx.lineTo(end.x - 8 * Math.cos(ang - 0.5), end.y - 8 * Math.sin(ang - 0.5));
    octx.lineTo(end.x - 8 * Math.cos(ang + 0.5), end.y - 8 * Math.sin(ang + 0.5));
    octx.closePath(); octx.fill();
    octx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    octx.fillText(label, end.x + 6, end.y - 6);
    octx.restore();
  }

  function drawCharges() {
    const scale = pxPerWorld();
    const small = engine.charges.length > 12;
    for (const ch of engine.charges) {
      const p = worldToScreen(ch.pos.x, ch.pos.y);
      if (p.x < -40 || p.x > view.cssW + 40 || p.y < -40 || p.y > view.cssH + 40) continue;
      const selected = ch.id === state.selectedId;
      const hovered = ch.id === state.hoverId;
      const base = small ? 6.5 : 11;
      const r = clamp(base * Math.max(0.55, Math.min(1.6, scale / 46)), 4.5, 15) + (selected ? 2 : 0);

      octx.save();
      if (selected || hovered) {
        octx.strokeStyle = selected ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.42)";
        octx.lineWidth = selected ? 1.8 : 1;
        octx.beginPath(); octx.arc(p.x, p.y, r + 5, 0, TAU); octx.stroke();
      }
      const g = octx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.35, r * 0.1, p.x, p.y, r * 1.25);
      if (ch.q >= 0) {
        g.addColorStop(0, "#fff1ea"); g.addColorStop(0.3, "#ff9d7f"); g.addColorStop(1, "#b32a3a");
      } else {
        g.addColorStop(0, "#eef6ff"); g.addColorStop(0.3, "#8ac4ff"); g.addColorStop(1, "#1f5bb8");
      }
      octx.shadowColor = ch.q >= 0 ? "rgba(255,110,90,0.75)" : "rgba(90,169,255,0.75)";
      octx.shadowBlur = small ? 8 : 15;
      octx.fillStyle = g;
      octx.beginPath(); octx.arc(p.x, p.y, r, 0, TAU); octx.fill();
      octx.shadowBlur = 0;
      if (r > 7) {
        octx.fillStyle = "#050b12";
        octx.font = `800 ${Math.round(r * 1.35)}px system-ui, sans-serif`;
        octx.textAlign = "center"; octx.textBaseline = "middle";
        octx.fillText(ch.q >= 0 ? "+" : "\u2212", p.x, p.y);
      }
      if (ch.label && !small) {
        octx.fillStyle = "rgba(214,232,246,0.72)";
        octx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        octx.textAlign = "center"; octx.textBaseline = "alphabetic";
        octx.fillText(ch.label, p.x, p.y - r - 8);
      }
      octx.restore();

      if (selected) {
        drawVector(p, ch.vel.x, ch.vel.y, 0.30, "rgba(79,216,232,0.95)", "v");
        drawVector(p, ch.acc.x, ch.acc.y, 0.07, "rgba(255,176,86,0.95)", "a");
      }
    }
  }

  function drawProbe() {
    if (!state.pointer || state.draggingId != null) return;
    const { x, y } = state.pointer;
    octx.save();
    octx.strokeStyle = "rgba(226,242,255,0.30)";
    octx.lineWidth = 1;
    octx.beginPath();
    octx.moveTo(x - 9, y); octx.lineTo(x - 3, y);
    octx.moveTo(x + 3, y); octx.lineTo(x + 9, y);
    octx.moveTo(x, y - 9); octx.lineTo(x, y - 3);
    octx.moveTo(x, y + 3); octx.lineTo(x, y + 9);
    octx.stroke();
    octx.restore();
  }

  /* ------------------------------------------------- energy flux + probes */

  /** Centre of the flux ring: the selected charge, else the scene origin. */
  function fluxCentre() {
    const ch = selected();
    return ch ? { x: ch.pos.x, y: ch.pos.y } : { x: 0, y: 0 };
  }

  function updateFlux() {
    if (!ui.fluxToggle.checked) { engine.lastPower = 0; return; }
    const s = EM.scenarioById(state.scenario);
    const radOnly = s.flux?.radOnly !== false;
    const c = fluxCentre();
    const R = Number(ui.fluxRadius.value);
    const n = state.fluxN;
    const f = engine.poynting(c.x, c.y, R, n, state.fluxSamples, radOnly);
    // A cycle of near-field flux swings either way and averages to nothing, so
    // the useful number is the running mean, not the instantaneous one.
    const k = state.polarSeen < 30 ? 0.2 : 0.03;
    state.powerAvg += (f.power - state.powerAvg) * k;
    state.lineAvg += (f.line - state.lineAvg) * k;
    for (let i = 0; i < n; i++) {
      state.polarAvg[i] += (state.fluxSamples[i] - state.polarAvg[i]) * k;
    }
    state.polarSeen++;
    engine.lastPower = state.powerAvg;
  }

  function resetFlux() {
    state.polarAvg.fill(0);
    state.polarSeen = 0;
    state.powerAvg = 0;
    state.lineAvg = 0;
    engine.lastPower = 0;
  }

  function drawFluxRing() {
    if (!ui.fluxToggle.checked || state.polarSeen < 2) return;
    const c = fluxCentre();
    const R = Number(ui.fluxRadius.value);
    const n = state.fluxN;
    let peak = 1e-12;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(state.polarAvg[i]));

    octx.save();
    octx.lineWidth = 3;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p0 = worldToScreen(c.x + R * Math.cos(a0), c.y + R * Math.sin(a0));
      const p1 = worldToScreen(c.x + R * Math.cos(a1), c.y + R * Math.sin(a1));
      const v = state.polarAvg[i] / peak;
      const m = Math.min(Math.abs(v), 1);
      octx.strokeStyle = v >= 0
        ? `rgba(255,176,86,${0.18 + 0.72 * m})`      // energy leaving
        : `rgba(79,216,232,${0.18 + 0.72 * m})`;     // energy returning
      octx.beginPath();
      octx.moveTo(p0.x, p0.y);
      octx.lineTo(p1.x, p1.y);
      octx.stroke();
    }
    octx.restore();
  }

  function drawPolar() {
    const size = 108, dpr = view.dpr;
    if (ui.polar.width !== Math.round(size * dpr)) {
      ui.polar.width = Math.round(size * dpr);
      ui.polar.height = Math.round(size * dpr);
    }
    const g = polarCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, rad = size / 2 - 7;

    g.strokeStyle = "rgba(160,200,230,0.22)";
    g.setLineDash([2, 3]);
    g.beginPath(); g.arc(cx, cy, rad * 0.42, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = "rgba(160,200,230,0.14)";
    g.beginPath();
    g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy);
    g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad);
    g.stroke();

    if (!ui.fluxToggle.checked || state.polarSeen < 4) return;
    const n = state.fluxN;
    let peak = 1e-12;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(state.polarAvg[i]));

    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const j = i % n;
      const a = (j / n) * Math.PI * 2;
      // screen y is flipped relative to world y
      const r = rad * (0.42 + 0.58 * (state.polarAvg[j] / peak));
      const x = cx + Math.cos(a) * Math.max(r, 2);
      const y = cy - Math.sin(a) * Math.max(r, 2);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.strokeStyle = "#ffb056";
    g.lineWidth = 1.6;
    g.stroke();

    // predicted main lobe, when the scenario knows one
    const sc = EM.scenarioById(state.scenario);
    const beams = sc.beam ? sc.beam(engine, state.params) : null;
    if (beams) {
      g.strokeStyle = "rgba(124,240,180,0.85)";
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      for (const a of beams) {
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(a) * rad, cy - Math.sin(a) * rad);
        g.stroke();
      }
      g.setLineDash([]);
    }
  }

  /** Predicted main-lobe direction, drawn where the energy should be going. */
  function drawBeam() {
    const sc = EM.scenarioById(state.scenario);
    if (!sc.beam) return;
    const beams = sc.beam(engine, state.params);
    if (!beams) return;
    const c = fluxCentre();
    const L = Math.max(viewW(), viewH());
    octx.save();
    octx.strokeStyle = "rgba(124,240,180,0.55)";
    octx.setLineDash([7, 6]);
    octx.lineWidth = 1.3;
    for (const a of beams) {
      const p0 = worldToScreen(c.x, c.y);
      const p1 = worldToScreen(c.x + Math.cos(a) * L, c.y + Math.sin(a) * L);
      octx.beginPath();
      octx.moveTo(p0.x, p0.y);
      octx.lineTo(p1.x, p1.y);
      octx.stroke();
    }
    octx.restore();
  }

  function drawProbes() {
    for (let i = 0; i < engine.probes.length; i++) {
      const p = engine.probes[i];
      const s = worldToScreen(p.x, p.y);
      const col = PROBE_COLORS[i % PROBE_COLORS.length];
      octx.save();
      octx.strokeStyle = col;
      octx.fillStyle = "rgba(8,16,26,0.7)";
      octx.lineWidth = 1.6;
      octx.beginPath(); octx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      octx.fill(); octx.stroke();
      octx.beginPath(); octx.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
      octx.fillStyle = col; octx.fill();
      octx.fillStyle = col;
      octx.font = "10px ui-monospace, monospace";
      octx.fillText(`P${i + 1}`, s.x + 9, s.y - 7);
      octx.restore();
    }
  }

  /** The charge whose wave the probes are timing. */
  function probeSource() {
    const sel = selected();
    if (sel && sel.mode !== "static") return sel;
    let best = null, bestA = 0;
    for (const ch of engine.charges) {
      if (ch.mode === "static") continue;
      const a = Math.hypot(ch.acc.x, ch.acc.y) + Math.hypot(ch.vel.x, ch.vel.y);
      if (a > bestA) { bestA = a; best = ch; }
    }
    return best;
  }

  /**
   * Two probes see the same wave at different times. The delay between their
   * records, against the difference in their distances from the source, is a
   * measurement of c that never consults the c slider.
   */
  function measureC() {
    const ps = engine.probes;
    if (ps.length < 2) {
      ui.cSource.textContent = ui.cPath.textContent = "—";
      ui.cDelay.textContent = ui.cMeasured.textContent = "—";
      return;
    }
    const src = probeSource();
    const a = ps[ps.length - 2], b = ps[ps.length - 1];
    ui.cSource.textContent = src ? `Q${src.id}${selected() === src ? " (selected)" : ""}` : "none moving";
    if (!src) { ui.cPath.textContent = ui.cDelay.textContent = ui.cMeasured.textContent = "—"; return; }

    // distances from where the source sits, not where it happens to be this
    // instant: the measurement assumes one compact, roughly stationary emitter
    const da = Math.hypot(a.x - src.anchor.x, a.y - src.anchor.y);
    const db = Math.hypot(b.x - src.anchor.x, b.y - src.anchor.y);
    const dd = db - da;
    ui.cPath.textContent = `${dd >= 0 ? "+" : ""}${dd.toFixed(2)} u`;

    const fd = engine.frontDelay(a, b);
    if (!fd) {
      ui.cDelay.textContent = "press R to time the front";
      ui.cMeasured.textContent = "\u2014";
      return;
    }
    const dt = fd.dt;
    ui.cDelay.textContent = `${dt.toFixed(3)} s`;
    if (Math.abs(dt) < 1e-4 || Math.abs(dd) < 0.2) {
      ui.cMeasured.textContent = "probes too close together";
      return;
    }
    const cm = Math.abs(dd / dt);
    const err = 100 * (cm - engine.c) / engine.c;
    ui.cMeasured.textContent = `${cm.toFixed(2)} u/s  (${err >= 0 ? "+" : ""}${err.toFixed(1)}%)`;
  }

  /* -------------------------------------------------- scenario parameters */

  function buildParamStrip(s) {
    ui.paramStrip.innerHTML = "";
    state.params = EM.scenarioParams(s);
    for (const d of s.params || []) {
      const label = document.createElement("label");
      label.className = d.kind === "toggle" ? "check" : "slider";
      if (d.kind === "toggle") {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = d.value > 0.5;
        box.addEventListener("change", () => {
          state.params[d.id] = box.checked ? 1 : 0;
          s.apply?.(engine, state.params);
          resetFlux();
        });
        const span = document.createElement("span");
        span.textContent = d.label;
        label.append(box, span);
      } else {
        const span = document.createElement("span");
        const em = document.createElement("em");
        em.className = "mono";
        em.textContent = `${d.value.toFixed(2)}${d.unit ? " " + d.unit : ""}`;
        span.textContent = d.label + " ";
        span.appendChild(em);
        const range = document.createElement("input");
        range.type = "range";
        range.min = d.min; range.max = d.max; range.step = d.step;
        range.value = d.value;
        range.addEventListener("input", () => {
          const v = Number(range.value);
          state.params[d.id] = v;
          em.textContent = `${v.toFixed(2)}${d.unit ? " " + d.unit : ""}`;
          s.apply?.(engine, state.params);
          resetFlux();
        });
        label.append(span, range);
      }
      ui.paramStrip.appendChild(label);
    }
    s.apply?.(engine, state.params);
  }

  /**
   * In the surface view the flat overlay would be drawn in the wrong place, so
   * only the charges are shown, projected through the same camera the shader
   * used and pinned to the base plane with a stem up to the relief.
   */
  function drawOverlay3D() {
    octx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    octx.clearRect(0, 0, view.cssW, view.cssH);
    // charges are drawn as lit geometry by the GPU; only the probes are left,
    // stood on the relief so they do not float above or sink through it
    const H = surfaceScale();
    for (let i = 0; i < engine.probes.length; i++) {
      const p = engine.probes[i];
      const h = surfaceHeightAt(p.x, p.y) * H;
      const foot = project3(p.x, p.y, 0);
      const top = project3(p.x, p.y, h);
      if (!top) continue;
      const col = PROBE_COLORS[i % PROBE_COLORS.length];
      if (foot) {
        octx.strokeStyle = col + "55";
        octx.lineWidth = 1;
        octx.setLineDash([2, 3]);
        octx.beginPath(); octx.moveTo(foot.x, foot.y); octx.lineTo(top.x, top.y); octx.stroke();
        octx.setLineDash([]);
      }
      octx.strokeStyle = col;
      octx.lineWidth = 1.5;
      octx.beginPath(); octx.arc(top.x, top.y, 5, 0, Math.PI * 2); octx.stroke();
      octx.fillStyle = col;
      octx.font = "10px ui-monospace, monospace";
      octx.fillText(`P${i + 1}`, top.x + 8, top.y - 6);
    }
  }

  function drawOverlay() {
    if (is3D()) { drawOverlay3D(); return; }
    octx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    octx.clearRect(0, 0, view.cssW, view.cssH);
    drawRings();
    drawBeam();
    drawFluxRing();
    drawTrails();
    drawCharges();
    drawProbes();
    drawProbe();
  }

  /* ----------------------------------------------------------- strip chart */

  function pushChart() {
    if (!state.chart) return;
    const series = state.chart.series;
    for (let i = 0; i < series.length; i++) {
      state.chartData[i][state.chartHead] = series[i].get(engine);
    }
    state.chartHead = (state.chartHead + 1) % CHART_N;
  }

  function loadChartLegend(s) {
    ui.chartTitle.textContent = s.chart ? s.chart.title : "No trace for this experiment";
    ui.chartLegend.innerHTML = "";
    ui.chartLegend.dataset.mode = "";
    for (const ser of s.chart?.series ?? []) {
      const el = document.createElement("span");
      el.className = "legend-item";
      el.innerHTML = `<i style="background:${ser.color}"></i>${ser.label}`;
      ui.chartLegend.appendChild(el);
    }
  }

  function drawChart() {
    const w = chartCanvas.clientWidth || 240;
    const h = chartCanvas.clientHeight || 92;
    const dpr = view.dpr;
    if (chartCanvas.width !== Math.round(w * dpr)) {
      chartCanvas.width = Math.round(w * dpr);
      chartCanvas.height = Math.round(h * dpr);
    }
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, w, h);
    cctx.strokeStyle = "rgba(160,200,230,0.16)";
    cctx.lineWidth = 1;
    cctx.beginPath(); cctx.moveTo(0, h / 2); cctx.lineTo(w, h / 2); cctx.stroke();

    // Probes take over the recorder when present: these are sampled at the
    // physics rate rather than once per frame, so the delay between two traces
    // is a real measurement rather than an artefact of the frame timing.
    if (engine.probes.length) {
      const want = 720;
      const series = engine.probes.map(p => engine.probeSeries(p, "y", want));
      let peak = 1e-4;
      for (const arr of series) for (let i = 0; i < arr.length; i++) peak = Math.max(peak, Math.abs(arr[i]));
      const gain = (h / 2 - 4) / peak;
      series.forEach((arr, si) => {
        if (arr.length < 4) return;
        cctx.strokeStyle = PROBE_COLORS[si % PROBE_COLORS.length];
        cctx.lineWidth = 1.4;
        cctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
          const x = (i / (arr.length - 1)) * w;
          const y = h / 2 - arr[i] * gain;
          if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
        }
        cctx.stroke();
      });
      return;
    }

    if (!state.chart) return;

    let peak = 0.15;
    for (const arr of state.chartData) for (let i = 0; i < CHART_N; i++) peak = Math.max(peak, Math.abs(arr[i]));
    const gain = (h / 2 - 4) / peak;

    state.chart.series.forEach((ser, si) => {
      const arr = state.chartData[si];
      cctx.strokeStyle = ser.color;
      cctx.lineWidth = 1.5;
      cctx.beginPath();
      for (let i = 0; i < CHART_N; i++) {
        const idx = (state.chartHead + i) % CHART_N;
        const x = (i / (CHART_N - 1)) * w;
        const y = h / 2 - arr[idx] * gain;
        if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
      }
      cctx.stroke();
    });
  }

  /* ----------------------------------------------------------- main loop */

  function resize() {
    const rect = wrap.getBoundingClientRect();
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.cssW = Math.max(1, rect.width);
    view.cssH = Math.max(1, rect.height);
    overlay.width = Math.round(view.cssW * view.dpr);
    overlay.height = Math.round(view.cssH * view.dpr);
    overlay.style.width = view.cssW + "px";
    overlay.style.height = view.cssH + "px";
    if (renderer) renderer.resize(view.cssW, view.cssH, view.dpr);
  }

  function autoQuality(frameMs) {
    if (!renderer || !ui.autoRes.checked) return;
    let s = renderer.scale;
    if (frameMs > 24) s *= 0.93;
    else if (frameMs < 13) s *= 1.03;
    renderer.setScale(clamp(s, 0.3, 1));
    ui.resScale.value = String(Math.round(renderer.scale * 100));
    ui.resOut.textContent = `${Math.round(renderer.scale * 100)}%`;
  }

  function frame(now) {
    const raw = Math.min((now - state.lastMs) / 1000, 0.1);
    state.lastMs = now;
    state.frameEma = state.frameEma * 0.9 + raw * 1000 * 0.1;

    engine.settleTime = viewDiagonal() / engine.c + 1;
    engine.c = Number(ui.cSpeed.value);
    engine.gain = Number(ui.gain.value);
    engine.radReact = Number(ui.radReact.value);
    engine.retIter = Number(ui.accuracy.value);

    const scaled = raw * Number(ui.timeScale.value);
    if (state.stepPending > 0) {
      engine.advance(1 / 24, true);
      state.stepPending = 0;
      state.freeRunUntil = engine.time + viewDiagonal() / engine.c + 1.5;
    } else if (state.running) {
      engine.advance(scaled, true);
    } else if (state.draggingId != null || engine.time < state.freeRunUntil) {
      engine.advance(scaled, false);
    }

    state.flow = (state.flow + raw * 26) % 100000;

    if (renderer) {
      renderer.render(engine, {
        cx: view.cx, cy: view.cy, w: viewW(), h: viewH()
      }, {
        mode: state.mode,
        exposure: Number(ui.exposure.value),
        lic: Number(ui.licStrength.value),
        flow: state.flow,
        arrowCell: arrowCellPx(),
        arrowScale: 1.0,
        gridPx: ui.gridToggle.checked ? (view.cssW * view.dpr) / 18 : 0,
        surface: 1.0,
        iterations: Number(ui.accuracy.value),
        threeD: is3D(),
        cam: state.cam,
        height: surfaceScale(),
        contour: ui.contourToggle.checked,
        particles: ui.particleToggle.checked,
        particleScale: Number(ui.particleSize.value),
        selectedId: state.selectedId
      });
    }

    updateFlux();
    drawOverlay();
    drawPolar();
    pushChart();
    drawChart();
    readouts();
    if (state.frameTick % 12 === 0) measureC();
    state.frameTick++;
    autoQuality(state.frameEma);

    requestAnimationFrame(frame);
  }

  function arrowCellPx() {
    if (state.mode === "magnetic") return 0;
    const n = Number(ui.arrowDensity.value);
    if (n < 8) return 0;
    return (view.cssW * view.dpr) / n;
  }

  /* --------------------------------------------------------------- readout */

  function readouts() {
    if (engine.probes.length) {
      ui.chartTitle.textContent = `Probe E\u1d67 (t)  \u00b7  ${engine.probes.length} probe${engine.probes.length > 1 ? "s" : ""}`;
      if (ui.chartLegend.dataset.mode !== "probes") {
        ui.chartLegend.dataset.mode = "probes";
        ui.chartLegend.innerHTML = "";
        engine.probes.forEach((p, i) => {
          const el = document.createElement("span");
          el.className = "legend-item";
          el.innerHTML = `<i style="background:${PROBE_COLORS[i % PROBE_COLORS.length]}"></i>P${i + 1}`;
          ui.chartLegend.appendChild(el);
        });
      } else if (ui.chartLegend.childElementCount !== engine.probes.length) {
        ui.chartLegend.dataset.mode = "";
      }
    } else if (ui.chartLegend.dataset.mode === "probes") {
      ui.chartLegend.dataset.mode = "";
      loadChartLegend(EM.scenarioById(state.scenario));
    }

    ui.simClock.textContent = `t ${engine.time.toFixed(2)} s`;
    ui.fpsChip.textContent = `${Math.round(1000 / Math.max(state.frameEma, 1))} fps`;
    if (renderer) ui.resChip.textContent = `field ${Math.round(renderer.scale * 100)}%`;

    const ch = selected();
    if (ch) {
      ui.selPos.textContent = `${ch.pos.x.toFixed(2)}, ${ch.pos.y.toFixed(2)}`;
      ui.selVel.textContent = `${ch.vel.x.toFixed(2)}, ${ch.vel.y.toFixed(2)}`;
      ui.selAcc.textContent = `${ch.acc.x.toFixed(2)}, ${ch.acc.y.toFixed(2)}`;
      ui.chargeBadge.textContent = `${ch.q >= 0 ? "+" : ""}${ch.q.toFixed(1)} q`;
      if (document.activeElement !== ui.velX) ui.velX.value = ch.vel.x.toFixed(2);
      if (document.activeElement !== ui.velY) ui.velY.value = ch.vel.y.toFixed(2);
    }

    if (ui.fluxToggle.checked && state.polarSeen > 3) {
      ui.fluxPower.textContent = fmt(state.powerAvg);
      ui.fluxLine.textContent = fmt(state.lineAvg);
      let peak = -1e9, pj = 0;
      for (let i = 0; i < state.fluxN; i++) {
        if (state.polarAvg[i] > peak) { peak = state.polarAvg[i]; pj = i; }
      }
      const deg = ((pj + 0.5) / state.fluxN) * 360;
      ui.fluxLobe.textContent = `${(deg > 180 ? deg - 360 : deg).toFixed(0)}\u00b0`;
    } else {
      ui.fluxPower.textContent = ui.fluxLine.textContent = ui.fluxLobe.textContent = "\u2014";
    }

    if (state.pointer) {
      const w = screenToWorld(state.pointer.x, state.pointer.y);
      const f = engine.fieldAt(w.x, w.y, null);
      const tot = Math.hypot(f[0], f[1]);
      const rad = f[7];
      ui.probePos.textContent = `${w.x.toFixed(2)}, ${w.y.toFixed(2)}`;
      ui.probeE.textContent = fmt(tot);
      ui.probeRad.textContent = `${fmt(rad)}  (${(100 * rad / Math.max(tot, 1e-9)).toFixed(0)}%)`;
      ui.probeB.textContent = fmt(f[2]);
    }
  }

  function fmt(v) {
    const a = Math.abs(v);
    if (a === 0) return "0";
    if (a >= 1000 || a < 0.001) return v.toExponential(2);
    return v.toFixed(a < 0.1 ? 4 : a < 10 ? 3 : 2);
  }

  /* ----------------------------------------------------------- selection */

  const selected = () => engine.charges.find(c => c.id === state.selectedId) || null;

  function select(id) {
    state.selectedId = id;
    const ch = selected();
    ui.emptyInspector.classList.toggle("hidden", !!ch);
    ui.chargeInspector.classList.toggle("hidden", !ch);
    ui.deleteBtn.disabled = !ch;
    if (ch) syncInspector(ch);
  }

  function syncInspector(ch) {
    ui.chargeId.textContent = `Q${ch.id}`;
    ui.chargeBadge.textContent = `${ch.q >= 0 ? "+" : ""}${ch.q.toFixed(1)} q`;
    ui.chargeBadge.style.color = ch.q >= 0 ? "#ff9d8a" : "#8ac4ff";
    ui.chargeValue.value = ch.q.toFixed(2);
    ui.motionMode.value = ch.mode;
    ui.velX.value = ch.vel.x.toFixed(2);
    ui.velY.value = ch.vel.y.toFixed(2);
    ui.ampX.value = ch.amplitude.x.toFixed(2);
    ui.ampY.value = ch.amplitude.y.toFixed(2);
    ui.freq.value = ch.frequency.toFixed(2);
    ui.phase.value = ch.phase.toFixed(2);
    ui.mass.value = ch.mass.toFixed(2);
    ui.spring.value = ch.spring.toFixed(2);
    ui.damping.value = ch.damping.toFixed(2);
    ui.axisLock.checked = !!ch.axis;
  }

  function chargeAt(sx, sy) {
    let best = 22, found = null;
    for (const ch of engine.charges) {
      const p = worldToScreen(ch.pos.x, ch.pos.y);
      const d = Math.hypot(sx - p.x, sy - p.y);
      if (d < best) { best = d; found = ch; }
    }
    return found;
  }

  function addCharge(q, pos) {
    const ch = engine.add({ q, pos, mode: "static" });
    if (!ch) { flash("Charge limit reached."); return; }
    engine.refreshStationary();
    select(ch.id);
    flash(`Added ${q >= 0 ? "positive" : "negative"} charge.`);
  }

  function deleteSelected() {
    if (state.selectedId == null) return;
    engine.remove(state.selectedId);
    select(engine.charges[0]?.id ?? null);
    flash("Charge removed.");
  }

  let flashTimer = 0;
  function flash(msg) {
    ui.statusText.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      ui.statusText.textContent = is3D()
        ? "Drag a charge to move it \u00b7 drag the background (or shift-drag) to orbit"
        : "Wheel zooms \u00b7 shift-drag pans \u00b7 double-click adds a charge";
    }, 2600);
  }

  /* --------------------------------------------------------------- pointer */

  const localPoint = e => {
    const r = overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const probeAt = (sx, sy) => {
    for (let i = engine.probes.length - 1; i >= 0; i--) {
      const q = engine.probes[i];
      const s = worldToScreen(q.x, q.y);
      if (Math.hypot(s.x - sx, s.y - sy) < 10) return q;
    }
    return null;
  };

  overlay.addEventListener("pointerdown", e => {
    const p = localPoint(e);
    if (is3D() && !state.armProbe) {
      const hit = e.shiftKey ? null : chargeAt3D(p.x, p.y);
      if (hit) {
        select(hit.id);
        state.draggingId = hit.id;
        engine.draggingId = hit.id;
        state.dragPlaneZ = particleZ(hit);
        const w = screenToWorld3(p.x, p.y);
        state.dragOffset = { x: hit.pos.x - w.x, y: hit.pos.y - w.y };
        state.dragLastT = engine.time;
        state.dragLastPos = { x: hit.pos.x, y: hit.pos.y };
        state.dragLastVel = { x: hit.vel.x, y: hit.vel.y };
        overlay.setPointerCapture(e.pointerId);
        return;
      }
      state.orbiting = true;
      state.orbitLast = p;
      overlay.setPointerCapture(e.pointerId);
      return;
    }
    if (state.armProbe && e.button === 0) {
      const w = screenToWorld(p.x, p.y);
      engine.addProbe(w.x, w.y, 1024);
      state.armProbe = false;
      ui.probeAdd.classList.remove("armed");
      ui.probeHint.textContent = engine.probes.length >= 2
        ? "Reading the delay between the last two probes."
        : "Place a second probe further away to measure c.";
      flash(`Probe ${engine.probes.length} placed`);
      return;
    }
    const ch = chargeAt(p.x, p.y);
    if (!ch && (e.shiftKey || e.button === 1)) {
      state.panning = true;
      state.panLast = p;
      overlay.setPointerCapture(e.pointerId);
      return;
    }
    if (!ch) { select(null); return; }
    select(ch.id);
    state.draggingId = ch.id;
    engine.draggingId = ch.id;
    const w = screenToWorld(p.x, p.y);
    state.dragOffset = { x: ch.pos.x - w.x, y: ch.pos.y - w.y };
    state.dragLastT = engine.time;
    state.dragLastPos = { x: ch.pos.x, y: ch.pos.y };
    state.dragLastVel = { x: ch.vel.x, y: ch.vel.y };
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener("pointermove", e => {
    const p = localPoint(e);
    if (state.orbiting && state.orbitLast) {
      state.cam.yaw -= (p.x - state.orbitLast.x) * 0.008;
      state.cam.pitch = clamp(state.cam.pitch + (p.y - state.orbitLast.y) * 0.006, 0.10, 1.48);
      state.orbitLast = p;
      return;
    }
    state.pointer = p;
    const hov = is3D() ? chargeAt3D(p.x, p.y) : chargeAt(p.x, p.y);
    state.hoverId = hov?.id ?? null;
    overlay.style.cursor =
      state.draggingId != null ? "grabbing"
      : is3D() ? (hov ? "grab" : "move")
      : state.panning ? "grabbing" : hov ? "grab" : "crosshair";

    if (state.panning && state.panLast) {
      view.cx -= (p.x - state.panLast.x) / view.cssW * viewW();
      view.cy += (p.y - state.panLast.y) / view.cssH * viewH();
      state.panLast = p;
      return;
    }

    if (state.draggingId != null) {
      const ch = engine.charges.find(c => c.id === state.draggingId);
      if (ch) {
        const w = is3D() ? screenToWorld3(p.x, p.y) : screenToWorld(p.x, p.y);
        const target = { x: w.x + state.dragOffset.x, y: w.y + state.dragOffset.y };
        const dt = Math.max(engine.time - state.dragLastT, 1 / 120);
        let vx = (target.x - state.dragLastPos.x) / dt;
        let vy = (target.y - state.dragLastPos.y) / dt;
        const lim = engine.c * 0.8;
        const vm = Math.hypot(vx, vy);
        if (vm > lim) { vx *= lim / vm; vy *= lim / vm; }
        ch.acc.x = (vx - state.dragLastVel.x) / dt;
        ch.acc.y = (vy - state.dragLastVel.y) / dt;
        ch.vel.x = vx; ch.vel.y = vy;
        const dx = target.x - ch.pos.x, dy = target.y - ch.pos.y;
        ch.pos.x = target.x; ch.pos.y = target.y;
        ch.anchor.x += dx; ch.anchor.y += dy;
        ch.lastMoveTime = engine.time;
        ch.stationary = false;
        engine.markEvent(ch);
        state.dragLastT = engine.time;
        state.dragLastPos = { ...target };
        state.dragLastVel = { x: vx, y: vy };
      }
    }

    ui.tooltip.classList.toggle("hidden", !hov);
    if (hov) {
      ui.tooltip.style.left = `${p.x}px`;
      ui.tooltip.style.top = `${p.y}px`;
      ui.tooltip.textContent = `Q${hov.id}  ${hov.q >= 0 ? "+" : ""}${hov.q.toFixed(2)}q  ${hov.mode}`;
    }
  });

  function endPointer(e) {
    state.panning = false;
    state.panLast = null;
    if (state.orbiting) {
      state.orbiting = false;
      state.orbitLast = null;
      if (e && overlay.hasPointerCapture?.(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
      return;
    }
    if (state.draggingId != null) {
      const ch = engine.charges.find(c => c.id === state.draggingId);
      if (ch) {
        const stop = 1 / 24;
        ch.acc.x = -ch.vel.x / stop;
        ch.acc.y = -ch.vel.y / stop;
        engine.markEvent(ch);
        ch.vel.x = 0; ch.vel.y = 0;
        ch.lastMoveTime = engine.time;
      }
      state.freeRunUntil = engine.time + viewDiagonal() / engine.c + 1.5;
    }
    state.draggingId = null;
    engine.draggingId = null;
    if (e && overlay.hasPointerCapture?.(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
  }
  overlay.addEventListener("pointerup", endPointer);
  overlay.addEventListener("pointercancel", endPointer);
  overlay.addEventListener("pointerleave", () => {
    if (state.draggingId == null && !state.panning) {
      state.pointer = null;
      state.hoverId = null;
      ui.tooltip.classList.add("hidden");
    }
  });

  overlay.addEventListener("dblclick", e => {
    const p = localPoint(e);
    if (chargeAt(p.x, p.y)) return;
    const w = screenToWorld(p.x, p.y);
    addCharge(e.altKey ? -1 : 1, w);
  });

  overlay.addEventListener("contextmenu", e => {
    e.preventDefault();
    const p = localPoint(e);
    const pr = probeAt(p.x, p.y);
    if (pr) { engine.removeProbe(pr.id); return; }
    const ch = chargeAt(p.x, p.y);
    if (ch) { select(ch.id); deleteSelected(); }
  });

  overlay.addEventListener("wheel", e => {
    e.preventDefault();
    if (is3D()) {
      state.cam.dist = clamp(state.cam.dist * Math.exp(e.deltaY * 0.0012), 0.55, 4.5);
      return;
    }
    const p = localPoint(e);
    zoomAt(view.zoom * Math.exp(-e.deltaY * 0.0016), p);
  }, { passive: false });

  function zoomAt(next, anchor) {
    const before = screenToWorld(anchor.x, anchor.y);
    view.zoom = clamp(next, 0.25, 14);
    const after = screenToWorld(anchor.x, anchor.y);
    view.cx += before.x - after.x;
    view.cy += before.y - after.y;
    ui.zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
  }

  /* ------------------------------------------------------------------- UI */

  function updateTransport() {
    ui.playBtn.textContent = state.running ? "Pause" : "Play";
    ui.playBtn.classList.toggle("running", state.running);
  }

  function syncOutputs() {
    ui.exposureOut.textContent = Number(ui.exposure.value).toFixed(1);
    ui.arrowOut.textContent = Number(ui.arrowDensity.value) < 8 ? "off" : ui.arrowDensity.value;
    ui.licOut.textContent = Number(ui.licStrength.value).toFixed(2);
    ui.timeScaleOut.textContent = `${Number(ui.timeScale.value).toFixed(2)}\u00d7`;
    ui.cOut.textContent = `${Number(ui.cSpeed.value).toFixed(1)} u/s`;
    ui.gainOut.textContent = `${Number(ui.gain.value).toFixed(2)}\u00d7`;
    ui.resOut.textContent = `${ui.resScale.value}%`;
    const rr = Number(ui.radReact.value);
    ui.radReactOut.textContent = rr < 1e-6 ? "off" : rr.toFixed(3);
    ui.fluxOut.textContent = Number(ui.fluxRadius.value).toFixed(1);
    ui.heightOut.textContent = Number(ui.surfHeight.value).toFixed(2);
    ui.particleOut.textContent = Number(ui.particleSize.value).toFixed(2);
  }

  for (const el of [ui.exposure, ui.arrowDensity, ui.licStrength, ui.timeScale, ui.cSpeed,
                    ui.gain, ui.radReact, ui.fluxRadius]) {
    el.addEventListener("input", syncOutputs);
  }
  function sync3D() {
    const on = is3D();
    ui.heightRow.hidden = !on;
    ui.particleRow.hidden = !on;
    ui.licStrength.disabled = on;
    ui.arrowDensity.disabled = on || state.mode === "magnetic";
    ui.trailToggle.disabled = on;
    ui.ringToggle.disabled = on;
    ui.statusText.textContent = on
      ? "Drag to orbit \u00b7 wheel moves the camera \u00b7 height is the field, tone-mapped"
      : "Wheel zooms \u00b7 shift-drag pans \u00b7 double-click adds a charge";
    overlay.style.cursor = on ? "move" : "crosshair";
  }
  ui.view3d.addEventListener("change", sync3D);
  ui.surfHeight.addEventListener("input", () => {
    ui.heightOut.textContent = Number(ui.surfHeight.value).toFixed(2);
    ui.particleOut.textContent = Number(ui.particleSize.value).toFixed(2);
  });
  ui.particleSize.addEventListener("input", () => {
    ui.particleOut.textContent = Number(ui.particleSize.value).toFixed(2);
  });

  ui.fluxRadius.addEventListener("input", resetFlux);
  ui.fluxToggle.addEventListener("change", resetFlux);

  ui.probeAdd.addEventListener("click", () => {
    state.armProbe = !state.armProbe;
    ui.probeAdd.classList.toggle("armed", state.armProbe);
    ui.probeHint.textContent = state.armProbe
      ? "Click anywhere on the field to drop the probe."
      : "Two probes at different distances let you measure c from the delay between them.";
  });
  ui.probeClear.addEventListener("click", () => {
    engine.probes.length = 0;
    state.armProbe = false;
    ui.probeAdd.classList.remove("armed");
  });

  ui.resScale.addEventListener("input", () => {
    ui.autoRes.checked = false;
    if (renderer) renderer.setScale(Number(ui.resScale.value) / 100);
    syncOutputs();
  });

  for (const btn of document.querySelectorAll("[data-mode]")) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }

  ui.playBtn.addEventListener("click", () => {
    state.running = !state.running;
    state.lastMs = performance.now();
    updateTransport();
  });
  ui.stepBtn.addEventListener("click", () => {
    state.running = false;
    state.stepPending = 1;
    updateTransport();
  });
  ui.resetBtn.addEventListener("click", () => loadScenario(state.scenario));
  ui.scenarioSelect.addEventListener("change", () => loadScenario(ui.scenarioSelect.value));
  ui.addPos.addEventListener("click", () => addCharge(1, { x: view.cx - 1.2, y: view.cy }));
  ui.addNeg.addEventListener("click", () => addCharge(-1, { x: view.cx + 1.2, y: view.cy }));
  ui.deleteBtn.addEventListener("click", deleteSelected);

  ui.zoomIn.addEventListener("click", () => zoomAt(view.zoom * 1.3, { x: view.cssW / 2, y: view.cssH / 2 }));
  ui.zoomOut.addEventListener("click", () => zoomAt(view.zoom / 1.3, { x: view.cssW / 2, y: view.cssH / 2 }));
  ui.zoomReset.addEventListener("click", () => {
    view.zoom = 1; view.cx = 0; view.cy = 0;
    ui.zoomLabel.textContent = "100%";
  });

  function bindNumber(el, apply) {
    el.addEventListener("change", () => {
      const ch = selected();
      const v = Number(el.value);
      if (!ch || !Number.isFinite(v)) return;
      apply(ch, v);
      syncInspector(ch);
    });
  }
  bindNumber(ui.chargeValue, (c, v) => { c.q = clamp(v, -6, 6); c.base.q = c.q; });
  bindNumber(ui.velX, (c, v) => { c.vel.x = v; c.lastMoveTime = engine.time; });
  bindNumber(ui.velY, (c, v) => { c.vel.y = v; c.lastMoveTime = engine.time; });
  bindNumber(ui.ampX, (c, v) => c.amplitude.x = Math.max(0, v));
  bindNumber(ui.ampY, (c, v) => c.amplitude.y = Math.max(0, v));
  bindNumber(ui.freq, (c, v) => c.frequency = clamp(v, 0, 3));
  bindNumber(ui.phase, (c, v) => c.phase = v);
  bindNumber(ui.mass, (c, v) => c.mass = clamp(v, 0.1, 30));
  bindNumber(ui.spring, (c, v) => c.spring = clamp(v, 0, 20));
  bindNumber(ui.damping, (c, v) => c.damping = clamp(v, 0, 10));

  ui.motionMode.addEventListener("change", () => {
    const ch = selected();
    if (!ch) return;
    ch.mode = ui.motionMode.value;
    ch.anchor = { x: ch.pos.x, y: ch.pos.y };
    ch.lastMoveTime = engine.time;
    if (ch.mode === "static") { ch.vel.x = 0; ch.vel.y = 0; ch.acc.x = 0; ch.acc.y = 0; }
    syncInspector(ch);
  });
  ui.axisLock.addEventListener("change", () => {
    const ch = selected();
    if (!ch) return;
    ch.axis = ui.axisLock.checked ? { x: 1, y: 0 } : null;
    if (ch.axis) ch.anchor = { x: ch.pos.x, y: ch.pos.y };
  });

  window.addEventListener("keydown", e => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); ui.playBtn.click(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
    else if (e.key === "s" || e.key === "S") ui.stepBtn.click();
    else if (e.key === "r" || e.key === "R") ui.resetBtn.click();
    else if (e.key >= "1" && e.key <= "5") {
      const modes = ["total", "near", "radiation", "disturbance", "magnetic"];
      setMode(modes[Number(e.key) - 1]);
    }
  });

  /* ------------------------------------------------------------------ boot */

  const created = EM.FieldRenderer.create(glCanvas);
  if (created.error) {
    ui.glError.textContent = created.error +
      " The field view could not start; charges, probes and readouts still work.";
    ui.glError.classList.remove("hidden");
  } else {
    renderer = created.renderer;
  }

  new ResizeObserver(resize).observe(wrap);
  buildScenarioMenu();
  resize();
  loadScenario("manual");
  if (renderer && !renderer.surf) {
    ui.view3d.checked = false;
    ui.view3d.disabled = true;
    ui.view3d.closest("label").title =
      "3D surface unavailable on this GPU: " + (renderer.surfError || "shader link failed");
  }
  syncOutputs();
  sync3D();
  updateTransport();
  requestAnimationFrame(frame);

})(window);
