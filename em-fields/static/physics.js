"use strict";
/*
 * physics.js — charge kinematics, retarded (Lienard-Wiechert) field evaluation
 * and a fixed-step integrator.
 *
 * Design notes
 * ------------
 * History is stored on a UNIFORM time grid (HIST_DT) in a ring buffer, so a
 * retarded-time lookup is an O(1) index computation instead of a binary search.
 * The same buffers are laid out in texture order (row = charge, column = time
 * sample) so they can be handed to the GPU with zero repacking.
 */
(function (global) {

  const HIST_LEN = 1024;          // ring buffer depth (samples)
  const HIST_DT = 1 / 120;        // physics + history step (s)  -> 8.53 s of history
  const MAX_CHARGES = 96;         // hard cap, matches texture height
  const SOFT = 0.14;              // near-field softening (world units)
  const BETA_MAX = 0.9;           // clamp on v/c inside the field formula
  const SPEED_LIMIT = 0.86;       // clamp on |v|/c for dynamic charges

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  let nextId = 1;
  let nextProbeId = 1;

  function makeCharge(o) {
    return {
      id: nextId++,
      row: -1,
      q: o.q ?? 1,
      mass: o.mass ?? 1,
      mode: o.mode ?? "static",           // static | uniform | oscX | oscY | circle | dynamic
      group: o.group ?? null,             // driver | induced | lattice | null
      label: o.label ?? null,
      pos: { x: o.pos?.x ?? 0, y: o.pos?.y ?? 0 },
      vel: { x: o.vel?.x ?? 0, y: o.vel?.y ?? 0 },
      acc: { x: 0, y: 0 },
      anchor: { x: o.anchor?.x ?? o.pos?.x ?? 0, y: o.anchor?.y ?? o.pos?.y ?? 0 },
      amplitude: { x: o.amplitude?.x ?? 0, y: o.amplitude?.y ?? 0 },
      frequency: o.frequency ?? 0.3,
      phase: o.phase ?? 0,
      // dynamic-charge properties
      spring: o.spring ?? 0,              // restoring force toward anchor
      damping: o.damping ?? 0,            // resistive drag (a "resistance")
      axis: o.axis ?? null,               // {x,y} unit vector: motion constrained to this line
      recycle: o.recycle ?? null,         // {min,max} periodic wrap along x (endless wire)
      bounds: o.bounds ?? null,           // {x,y} reflecting walls
      // externally applied sinusoidal force: F = (x,y) * sin(2 pi f t + phase).
      // A charge driven this way can be *loaded* — unlike a kinematic charge,
      // whose motion is prescribed and cannot respond to what it radiates into.
      drive: o.drive ?? null,
      radiates: o.radiates !== false,     // subject to radiation reaction
      prevF: { x: 0, y: 0 },              // last external force, for dF/dt
      rrPower: 0,                         // power currently drained by radiation reaction
      swing: 0,                           // running peak displacement from anchor
      swingPeak: 0,
      // baseline used by the "disturbance" view: the static field this charge
      // would produce if it had never moved
      base: { x: o.pos?.x ?? 0, y: o.pos?.y ?? 0, q: o.q ?? 1 },
      // A conduction electron should not be tethered to one particular ion.
      // The lattice is there to make the wire neutral and to carry the long-range
      // field; local binding, if any, is stated explicitly as `spring`. So a
      // charge may ignore one partner when computing the force ON itself. The
      // rendered field always includes every charge.
      ignoreId: o.ignoreId ?? null,
      rings: o.rings !== false,           // emit a light-cone marker when accelerating
      lastRing: -1e9,
      lastMoveTime: -1e9,
      stationary: true,
      pinned: !!o.pinned
    };
  }

  class Engine {
    constructor() {
      this.time = 0;
      this.charges = [];
      this.c = 2.4;
      this.gain = 1.0;                    // global coupling strength for dynamic charges
      this.forceSoft = 0.55;              // softening used only for forces on charges,
                                          // so a charge sitting on its lattice site feels a
                                          // smooth linear restoring force instead of a
                                          // constant-magnitude one
      this.retIter = 2;                   // retarded-time refinement iterations (CPU)
      this.accum = 0;
      this.histHead = 0;
      this.histTime = 0;
      this.histCount = 0;
      this.rowsUsed = 0;
      this.fullUpload = true;
      this.dirtyFrom = 0;
      this.dirtyCount = 0;
      // texture-order storage: [row][sample] -> vec4
      this.texA = new Float32Array(MAX_CHARGES * HIST_LEN * 4); // x, y, vx, vy
      this.texB = new Float32Array(MAX_CHARGES * HIST_LEN * 4); // ax, ay, q, 0
      this.meta = new Float32Array(MAX_CHARGES * 4);            // baseX, baseY, baseQ, staticFlag
      this._s = new Float32Array(8);
      this._f = new Float32Array(12);
      this.events = [];                   // causal-front markers for the overlay
      this.draggingId = null;
      this.radReact = 0;                  // Landau-Lifshitz coefficient (tau at c = 2.8)
      this.probes = [];                   // fixed field pickups, sampled every step
      this._fluxN = 0;
      this._flux = null;
    }

    /* ---------------------------------------------------------------- setup */

    clear() {
      this.charges.length = 0;
      this.rowsUsed = 0;
      this.time = 0;
      this.accum = 0;
      this.histHead = 0;
      this.histTime = 0;
      // A freshly seeded row holds the charge's initial state in every slot, so
      // lookups arbitrarily far back are valid from t = 0 onwards.
      this.histCount = HIST_LEN;
      this.events.length = 0;
      for (const p of this.probes) { p.head = 0; p.count = 0; p.ex.fill(0); p.ey.fill(0); }
      this.texA.fill(0);
      this.texB.fill(0);
      this.fullUpload = true;
      nextId = 1;
    }

    add(options) {
      if (this.charges.length >= MAX_CHARGES) return null;
      const charge = makeCharge(options);
      charge.row = this.rowsUsed++;
      this.charges.push(charge);
      this.seedRow(charge);
      this.fullUpload = true;
      return charge;
    }

    remove(id) {
      const index = this.charges.findIndex(c => c.id === id);
      if (index < 0) return;
      const victim = this.charges[index];
      const last = this.charges[this.charges.length - 1];
      if (last !== victim) {
        // move the last charge's history into the freed row so rows stay dense
        const from = last.row * HIST_LEN * 4;
        const to = victim.row * HIST_LEN * 4;
        this.texA.copyWithin(to, from, from + HIST_LEN * 4);
        this.texB.copyWithin(to, from, from + HIST_LEN * 4);
        last.row = victim.row;
      }
      this.charges.splice(index, 1);
      this.rowsUsed--;
      this.fullUpload = true;
    }

    /** Fill an entire row with the charge's current state (no false history). */
    seedRow(charge) {
      const base = charge.row * HIST_LEN * 4;
      for (let i = 0; i < HIST_LEN; i++) {
        const o = base + i * 4;
        this.texA[o] = charge.pos.x;
        this.texA[o + 1] = charge.pos.y;
        this.texA[o + 2] = 0;
        this.texA[o + 3] = 0;
        this.texB[o] = 0;
        this.texB[o + 1] = 0;
        this.texB[o + 2] = charge.q;
        this.texB[o + 3] = 0;
      }
    }

    /* ------------------------------------------------------------- history */

    record() {
      this.histHead = (this.histHead + 1) % HIST_LEN;
      this.histTime = this.time;
      if (this.histCount < HIST_LEN) this.histCount++;
      const h = this.histHead;
      for (let i = 0; i < this.charges.length; i++) {
        const ch = this.charges[i];
        const o = ch.row * HIST_LEN * 4 + h * 4;
        this.texA[o] = ch.pos.x;
        this.texA[o + 1] = ch.pos.y;
        this.texA[o + 2] = ch.vel.x;
        this.texA[o + 3] = ch.vel.y;
        this.texB[o] = ch.acc.x;
        this.texB[o + 1] = ch.acc.y;
        this.texB[o + 2] = ch.q;
        this.texB[o + 3] = 0;
      }
      if (this.dirtyCount === 0) this.dirtyFrom = h;
      this.dirtyCount = Math.min(this.dirtyCount + 1, HIST_LEN);
    }

    /** Interpolated charge state at absolute time `tr`, written into `out`. */
    sample(row, tr, out) {
      const maxK = this.histCount - 1;
      let k = (this.histTime - tr) / HIST_DT;
      if (!(k > 0)) k = 0;
      if (k > maxK) k = maxK;
      const k0 = Math.floor(k);
      const f = k - k0;
      const k1 = k0 + 1 > maxK ? maxK : k0 + 1;
      const base = row * HIST_LEN * 4;
      const o0 = base + ((this.histHead - k0 + HIST_LEN * 2) % HIST_LEN) * 4;
      const o1 = base + ((this.histHead - k1 + HIST_LEN * 2) % HIST_LEN) * 4;
      const A = this.texA, B = this.texB;
      out[0] = A[o0] + (A[o1] - A[o0]) * f;
      out[1] = A[o0 + 1] + (A[o1 + 1] - A[o0 + 1]) * f;
      out[2] = A[o0 + 2] + (A[o1 + 2] - A[o0 + 2]) * f;
      out[3] = A[o0 + 3] + (A[o1 + 3] - A[o0 + 3]) * f;
      out[4] = B[o0] + (B[o1] - B[o0]) * f;
      out[5] = B[o0 + 1] + (B[o1 + 1] - B[o0 + 1]) * f;
      out[6] = B[o0 + 2] + (B[o1 + 2] - B[o0 + 2]) * f;
    }

    /**
     * Total field at (px, py). Optionally skips one charge (self-field).
     * Returns the shared scratch vector:
     *   [Ex, Ey, Bz, Rx, Ry, Dx, Dy, |Erad|, Vx, Vy]
     * Mirrors the GLSL implementation in shaders.js exactly.
     */
    fieldAt(px, py, skipId, soft, plummer, skipId2) {
      const c = this.c;
      const SF = soft || SOFT;
      const SF2 = SF * SF;   // near-field regulariser, matches SOFT*SOFT in the shader
      const s = this._s;
      const out = this._f;
      let ex = 0, ey = 0, bz = 0, rx = 0, ry = 0, dx = 0, dy = 0, vx = 0, vy = 0, bzr = 0, phi = 0;

      for (let i = 0; i < this.charges.length; i++) {
        const ch = this.charges[i];
        if (ch.id === skipId || ch.id === skipId2) continue;

        // Seed and iterate exactly as the fragment shader does, reading the same
        // float32 worldline, so the probe readout matches the rendered pixel.
        let tr = this.histTime;
        if (!ch.stationary) {
          const head = ch.row * HIST_LEN * 4 + this.histHead * 4;
          let ax = px - this.texA[head], ay = py - this.texA[head + 1];
          let R = Math.max(Math.sqrt(ax * ax + ay * ay), 1e-4);
          tr = this.time - R / c;
          for (let k = 0; k < this.retIter; k++) {
            this.sample(ch.row, tr, s);
            ax = px - s[0]; ay = py - s[1];
            R = Math.max(Math.sqrt(ax * ax + ay * ay), 1e-4);
            tr = this.time - R / c;
          }
        }
        this.sample(ch.row, tr, s);
        const sx = s[0], sy = s[1], svx = s[2], svy = s[3], sax = s[4], say = s[5], sq = s[6];

        // --- Lienard-Wiechert (2D visualisation form) ---
        let rxx = px - sx, ryy = py - sy;
        let R = Math.sqrt(rxx * rxx + ryy * ryy);
        if (R < SF) R = SF;
        const nx = rxx / R, ny = ryy / R;

        let bxx = svx / c, byy = svy / c;
        const bm = Math.sqrt(bxx * bxx + byy * byy);
        if (bm > BETA_MAX) { const k = BETA_MAX / bm; bxx *= k; byy *= k; }
        const b2 = bxx * bxx + byy * byy;
        let kap = 1 - (nx * bxx + ny * byy);
        if (kap < 0.12) kap = 0.12;
        const k3 = kap * kap * kap;

        const nbx = nx - bxx, nby = ny - byy;
        // Rendering uses q*n_hat/(R^2+s^2): correct far away, and finite at the
        // centre — but its magnitude tends to a *constant* as R -> 0, so a charge
        // sitting near its neighbour feels a bang-bang force with no restoring
        // gradient. For forces we use Plummer softening q*R_vec/(R^2+s^2)^{3/2}
        // instead, which is the same at large R and genuinely linear near zero,
        // so a lattice site is a real spring and chains do not come apart.
        const nearK = plummer
          ? sq * (1 - b2) * R / (k3 * Math.pow(R * R + SF2, 1.5))
          : sq * (1 - b2) / (k3 * (R * R + SF2));
        const evx = nbx * nearK, evy = nby * nearK;

        // Lienard-Wiechert scalar potential. Softened like the near field, and
        // signed — this is the quantity that makes a positive charge a hill and
        // a negative one a hollow. |E| cannot: a magnitude has no sign.
        phi += sq / (kap * Math.sqrt(R * R + SF2));

        const bdx = sax / c, bdy = say / c;
        const crossZ = nbx * bdy - nby * bdx;
        const radK = sq / (c * k3 * R);
        const eax = ny * crossZ * radK, eay = -nx * crossZ * radK;

        const tex = evx + eax, tey = evy + eay;
        ex += tex; ey += tey;
        vx += evx; vy += evy;
        rx += eax; ry += eay;
        bz += (nx * tey - ny * tex) / c;
        bzr += (nx * eay - ny * eax) / c;   // radiation-only B, for clean flux

        // Static baseline (position at scenario load) for the disturbance view.
        // Read from the same float32 buffer the GPU gets, so the numbers under
        // the cursor are exactly the numbers on screen.
        const mo = ch.row * 4;
        let brx = px - this.meta[mo], bry = py - this.meta[mo + 1];
        let bR = Math.sqrt(brx * brx + bry * bry);
        if (bR < SF) bR = SF;
        const bk = this.meta[mo + 2] / (bR * bR + SF2);
        dx += tex - (brx / bR) * bk;
        dy += tey - (bry / bR) * bk;
      }

      out[0] = ex; out[1] = ey; out[2] = bz;
      out[3] = rx; out[4] = ry;
      out[5] = dx; out[6] = dy;
      out[7] = Math.sqrt(rx * rx + ry * ry);
      out[8] = vx; out[9] = vy;
      out[10] = bzr;
      out[11] = phi;
      return out;
    }

    /* ------------------------------------------------------------ stepping */

    /** Advance by `dt` seconds of wall time. `move` gates automatic motion. */
    advance(dt, move) {
      this.accum += dt;
      let steps = 0;
      while (this.accum >= HIST_DT && steps < 8) {
        this.step(HIST_DT, move);
        this.accum -= HIST_DT;
        steps++;
      }
      if (steps === 8) this.accum = 0;   // give up catching up; stay responsive
      return steps;
    }

    step(dt, move) {
      this.time += dt;
      if (move) {
        for (let i = 0; i < this.charges.length; i++) {
          const ch = this.charges[i];
          if (ch.id === this.draggingId) continue;
          if (ch.mode === "dynamic") continue;
          this.stepKinematic(ch, dt);
        }
        this.stepDynamic(dt);
        for (let i = 0; i < this.charges.length; i++) this.markEvent(this.charges[i]);
      }
      this.recordProbes();
      this.refreshStationary();
      this.record();
    }

    stepKinematic(ch, dt) {
      const w = Math.PI * 2 * ch.frequency;
      const th = w * this.time + ch.phase;
      switch (ch.mode) {
        case "uniform":
          ch.acc.x = 0; ch.acc.y = 0;
          ch.pos.x += ch.vel.x * dt;
          ch.pos.y += ch.vel.y * dt;
          this.applyRecycle(ch);
          if (ch.vel.x || ch.vel.y) ch.lastMoveTime = this.time;
          break;
        case "oscX":
          ch.pos.x = ch.anchor.x + ch.amplitude.x * Math.sin(th);
          ch.pos.y = ch.anchor.y;
          ch.vel.x = ch.amplitude.x * w * Math.cos(th); ch.vel.y = 0;
          ch.acc.x = -ch.amplitude.x * w * w * Math.sin(th); ch.acc.y = 0;
          ch.lastMoveTime = this.time;
          break;
        case "oscY":
          ch.pos.x = ch.anchor.x;
          ch.pos.y = ch.anchor.y + ch.amplitude.y * Math.sin(th);
          ch.vel.x = 0; ch.vel.y = ch.amplitude.y * w * Math.cos(th);
          ch.acc.x = 0; ch.acc.y = -ch.amplitude.y * w * w * Math.sin(th);
          ch.lastMoveTime = this.time;
          break;
        case "circle":
          ch.pos.x = ch.anchor.x + ch.amplitude.x * Math.cos(th);
          ch.pos.y = ch.anchor.y + ch.amplitude.y * Math.sin(th);
          ch.vel.x = -ch.amplitude.x * w * Math.sin(th);
          ch.vel.y = ch.amplitude.y * w * Math.cos(th);
          ch.acc.x = -ch.amplitude.x * w * w * Math.cos(th);
          ch.acc.y = -ch.amplitude.y * w * w * Math.sin(th);
          ch.lastMoveTime = this.time;
          break;
        default:
          ch.vel.x = 0; ch.vel.y = 0; ch.acc.x = 0; ch.acc.y = 0;
      }
    }

    /**
     * Dynamic charges are pushed by the RETARDED field of every other charge:
     *   F = q (E + v x B),   B = Bz z-hat  ->  v x B = (vy*Bz, -vx*Bz)
     * This is what makes a wave arriving from one charge start moving another.
     */
    stepDynamic(dt) {
      const cLimit = this.c * SPEED_LIMIT;
      for (let i = 0; i < this.charges.length; i++) {
        const ch = this.charges[i];
        if (ch.mode !== "dynamic" || ch.id === this.draggingId) continue;

        const f = this.fieldAt(ch.pos.x, ch.pos.y, ch.id, this.forceSoft, true, ch.ignoreId);
        let fx = ch.q * (f[0] + ch.vel.y * f[2]) * this.gain;
        let fy = ch.q * (f[1] - ch.vel.x * f[2]) * this.gain;

        if (ch.drive) {
          const s = Math.sin(Math.PI * 2 * ch.drive.freq * this.time + (ch.drive.phase || 0));
          fx += ch.drive.x * s;
          fy += ch.drive.y * s;
        }
        if (ch.spring > 0) {
          fx -= ch.spring * (ch.pos.x - ch.anchor.x);
          fy -= ch.spring * (ch.pos.y - ch.anchor.y);
        }
        // Resistive drag is folded in here rather than after the mass division.
        // The trajectory is unchanged, but the radiation-reaction difference
        // below then sees the whole force, which is what makes the
        // Landau-Lifshitz substitution da/dt -> (1/m) dF/dt consistent.
        fx -= ch.mass * ch.damping * ch.vel.x;
        fy -= ch.mass * ch.damping * ch.vel.y;

        // ---- radiation reaction, Landau-Lifshitz reduced order ----
        // Abraham-Lorentz is F_rr = m tau da/dt, which has runaway solutions.
        // Substituting da/dt ~ (1/m) dF_ext/dt removes them and leaves a purely
        // dissipative force. For a bound charge F_ext = -k x, so F_rr = -tau k v:
        // the classical radiation damping of an oscillator, gamma = tau * w0^2.
        ch.rrPower = 0;
        if (this.radReact > 0 && ch.radiates) {
          const cs = 2.8 / this.c;
          const tau = this.radReact * cs * cs * cs * (ch.q * ch.q) / ch.mass;
          let rx = tau * (fx - ch.prevF.x) / dt;
          let ry = tau * (fy - ch.prevF.y) / dt;
          // A finite difference across a discontinuity (a charge appearing, a
          // wire wrapping) would spike; never let the reaction exceed the force
          // that caused it.
          const rm = Math.hypot(rx, ry), cap = 0.9 * Math.hypot(fx, fy);
          if (rm > cap && rm > 0) { rx *= cap / rm; ry *= cap / rm; }
          ch.prevF.x = fx; ch.prevF.y = fy;
          ch.rrPower = -(rx * ch.vel.x + ry * ch.vel.y);
          fx += rx; fy += ry;
        } else {
          ch.prevF.x = fx; ch.prevF.y = fy;
        }

        let ax = fx / ch.mass, ay = fy / ch.mass;

        if (ch.axis) {                      // conductor: motion locked to one line
          const p = ax * ch.axis.x + ay * ch.axis.y;
          ax = p * ch.axis.x; ay = p * ch.axis.y;
        }
        const am = Math.hypot(ax, ay);
        if (am > 40) { ax *= 40 / am; ay *= 40 / am; }

        ch.acc.x = ax; ch.acc.y = ay;
        ch.vel.x += ax * dt;
        ch.vel.y += ay * dt;
        if (ch.axis) {
          const p = ch.vel.x * ch.axis.x + ch.vel.y * ch.axis.y;
          ch.vel.x = p * ch.axis.x; ch.vel.y = p * ch.axis.y;
        }
        const vm = Math.hypot(ch.vel.x, ch.vel.y);
        if (vm > cLimit) { ch.vel.x *= cLimit / vm; ch.vel.y *= cLimit / vm; }

        ch.pos.x += ch.vel.x * dt;
        ch.pos.y += ch.vel.y * dt;
        if (ch.axis) {                      // stay exactly on the wire
          const px = ch.pos.x - ch.anchor.x, py = ch.pos.y - ch.anchor.y;
          const p = px * ch.axis.x + py * ch.axis.y;
          ch.pos.x = ch.anchor.x + p * ch.axis.x;
          ch.pos.y = ch.anchor.y + p * ch.axis.y;
        }
        if (ch.bounds) {
          if (Math.abs(ch.pos.x) > ch.bounds.x) {
            ch.pos.x = clamp(ch.pos.x, -ch.bounds.x, ch.bounds.x);
            ch.vel.x = -ch.vel.x * 0.86;
          }
          if (Math.abs(ch.pos.y) > ch.bounds.y) {
            ch.pos.y = clamp(ch.pos.y, -ch.bounds.y, ch.bounds.y);
            ch.vel.y = -ch.vel.y * 0.86;
          }
        }
        this.applyRecycle(ch);
        if (vm > 1e-4) ch.lastMoveTime = this.time;

        // running amplitude: peak displacement from the anchor, decaying slowly
        // so a change in loading shows up within a couple of cycles
        const d = Math.hypot(ch.pos.x - ch.anchor.x, ch.pos.y - ch.anchor.y);
        ch.swingPeak = Math.max(ch.swingPeak * (1 - dt * 0.9), d);
        ch.swing = ch.swing + (ch.swingPeak - ch.swing) * dt * 4;
      }
    }

    /**
     * Endless-wire wrap. The charge's whole stored history is translated with
     * it, so the retarded field sees a continuous worldline instead of a
     * teleport (which would radiate a huge spurious pulse).
     */
    applyRecycle(ch) {
      const r = ch.recycle;
      if (!r) return;
      const span = r.max - r.min;
      let shift = 0;
      if (ch.pos.x > r.max) shift = -span;
      else if (ch.pos.x < r.min) shift = span;
      if (!shift) return;
      ch.pos.x += shift;
      ch.anchor.x += shift;
      ch.base.x += shift;
      const base = ch.row * HIST_LEN * 4;
      for (let i = 0; i < HIST_LEN; i++) this.texA[base + i * 4] += shift;
      this.fullUpload = true;
    }

    /**
     * A charge counts as stationary only once every point in view could have
     * received the news that it stopped; then the shader can skip the retarded
     * solve entirely. This is the main GPU cost saver for lattice ions.
     */
    refreshStationary() {
      const settle = this.settleTime ?? 8;
      for (let i = 0; i < this.charges.length; i++) {
        const ch = this.charges[i];
        const still = ch.mode === "static" && ch.id !== this.draggingId;
        ch.stationary = still && (this.time - ch.lastMoveTime > settle);
        const o = ch.row * 4;
        this.meta[o] = ch.base.x;
        this.meta[o + 1] = ch.base.y;
        this.meta[o + 2] = ch.base.q;
        this.meta[o + 3] = ch.stationary ? 1 : 0;
      }
    }

    /** Net conventional current of a group: sum q*v along x. */
    groupCurrent(group) {
      let ix = 0;
      for (let i = 0; i < this.charges.length; i++) {
        const ch = this.charges[i];
        if (ch.group === group) ix += ch.q * ch.vel.x;
      }
      return ix;
    }

    /* ------------------------------------------------------- energy flux */

    /**
     * Poynting flux around a circle. With E in the plane and B along z,
     *   S = E x B = (Ey*Bz, -Ex*Bz),
     * so S is in-plane and the outward component S.n is what leaves the ring.
     *
     * Two numbers come back:
     *   `line`  = the honest 2-D line integral, closed(S.n) dl.
     *   `power` = the same integrand weighted by an extra R, i.e. closed(S.n) R^2 dtheta.
     *
     * `line` is not radius-independent here: the field carries the 3-D 1/R
     * radiation falloff, so S ~ 1/R^2 while the perimeter only grows as R, and
     * the line integral decays as 1/R. The extra factor of R in `power` is what
     * a spherical shell would have contributed, and it makes the number
     * radius-independent — that is the quantity worth reading. It is a
     * 2-D proxy for radiated power, not a closed surface integral.
     *
     * The 1/R^2 near-field terms contribute a large reactive flux that changes
     * sign twice per cycle and averages to nothing, so read the time average.
     */
    poynting(cx, cy, R, n, out, radOnly) {
      const dth = (Math.PI * 2) / n;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const th = (i + 0.5) * dth;
        const nx = Math.cos(th), ny = Math.sin(th);
        const f = this.fieldAt(cx + R * nx, cy + R * ny, null);
        const Ex = radOnly ? f[3] : f[0];
        const Ey = radOnly ? f[4] : f[1];
        const Bz = radOnly ? f[10] : f[2];
        const sn = (Ey * Bz) * nx + (-Ex * Bz) * ny;
        if (out) out[i] = sn;
        sum += sn;
      }
      return { line: sum * dth * R, power: sum * dth * R * R };
    }

    /* ------------------------------------------------------------ probes */

    addProbe(x, y, len) {
      const p = {
        id: nextProbeId++, x, y,
        n: len || 1024, head: 0, count: 0,
        ex: new Float32Array(len || 1024),
        ey: new Float32Array(len || 1024)
      };
      this.probes.push(p);
      return p;
    }

    removeProbe(id) {
      const i = this.probes.findIndex(p => p.id === id);
      if (i >= 0) this.probes.splice(i, 1);
    }

    /** Sampled at exactly HIST_DT, so lags between probes are exact multiples. */
    recordProbes() {
      for (let i = 0; i < this.probes.length; i++) {
        const p = this.probes[i];
        const f = this.fieldAt(p.x, p.y, null);
        p.ex[p.head] = f[0];
        p.ey[p.head] = f[1];
        p.head = (p.head + 1) % p.n;
        if (p.count < p.n) p.count++;
      }
    }

    /** Chronological copy of the last `want` samples of a probe channel. */
    probeSeries(p, channel, want) {
      const src = channel === "x" ? p.ex : p.ey;
      const n = Math.min(want, p.count);
      const out = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        out[n - 1 - k] = src[(p.head - 1 - k + p.n * 2) % p.n];
      }
      return out;
    }

    /**
     * When did the disturbance first reach this probe?
     *
     * Correlating two steady sinusoids only fixes the delay modulo a period,
     * and the near field's phase does not travel at c anyway. The causal edge
     * has neither problem: the probe reads a constant static field, then at one
     * definite moment it does not. Returns the sample index of that moment, or
     * null if the record no longer contains it.
     */
    probeOnset(p, absTh) {
      const n = Math.min(p.count, p.n);
      if (n < 120) return null;
      const arr = this.probeSeries(p, "y", n);
      const base = arr[0];
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(arr[i] - base));
      if (peak < 1e-6) return null;
      const th = absTh != null ? absTh : 0.06 * peak;
      if (th >= peak) return null;
      let i = 0;
      while (i < n && Math.abs(arr[i] - base) <= th) i++;
      // i === 0 means the record began after the front had already passed
      return (i > 3 && i < n) ? i : null;
    }

    /** Peak excursion of a probe's record from where it started. */
    probeSwing(p) {
      const n = Math.min(p.count, p.n);
      if (n < 120) return 0;
      const arr = this.probeSeries(p, "y", n);
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(arr[i] - arr[0]));
      return peak;
    }

    /**
     * Delay of the wavefront between two probes, in seconds.
     *
     * Each probe triggers at 6% of its own peak excursion. That crossing is a
     * little later than the true front, and later for a far probe than a near
     * one because the edge it sees is shallower, so the delay reads a few
     * percent long and c a few percent low. Measured bias is under about 7%.
     */
    frontDelay(a, b) {
      const ia = this.probeOnset(a), ib = this.probeOnset(b);
      if (ia == null || ib == null) return null;
      return { dt: (ib - ia) * HIST_DT, ia, ib };
    }

    markEvent(charge) {
      if (!charge.rings) return;
      if (Math.hypot(charge.acc.x, charge.acc.y) < 0.3) return;
      if (this.time - charge.lastRing < 0.5) return;
      charge.lastRing = this.time;
      this.events.push({ id: charge.id, t: this.time, x: charge.pos.x, y: charge.pos.y });
      while (this.events.length > 24) this.events.shift();
    }

    /** Positions every `stride` samples, newest first — used for motion trails. */
    trail(charge, count, stride) {
      const pts = [];
      const base = charge.row * HIST_LEN * 4;
      const n = Math.min(count, Math.floor((this.histCount - 1) / stride));
      for (let k = 0; k <= n; k++) {
        const idx = (this.histHead - k * stride + HIST_LEN * 2) % HIST_LEN;
        pts.push(this.texA[base + idx * 4], this.texA[base + idx * 4 + 1]);
      }
      return pts;
    }
  }

  global.EM = global.EM || {};
  global.EM.Engine = Engine;
  global.EM.HIST_LEN = HIST_LEN;
  global.EM.HIST_DT = HIST_DT;
  global.EM.MAX_CHARGES = MAX_CHARGES;
  global.EM.SOFT = SOFT;
  global.EM.clamp = clamp;

  /**
   * Normalised cross-correlation of two equal-length, uniformly sampled series.
   * Returns the lag (in samples, fractional via parabolic peak interpolation)
   * at which `b` best matches `a`, plus the correlation there. A positive lag
   * means b is delayed relative to a.
   */
  global.EM.bestLag = function bestLag(a, b, maxLag) {
    const n = Math.min(a.length, b.length);
    if (n < maxLag + 32) return null;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    const score = lag => {
      let num = 0, da = 0, db = 0;
      for (let i = lag; i < n; i++) {
        const x = a[i - lag] - ma, y = b[i] - mb;
        num += x * y; da += x * x; db += y * y;
      }
      const den = Math.sqrt(da * db);
      return den > 1e-12 ? num / den : 0;
    };
    let best = -2, bi = 0;
    const s = new Float64Array(maxLag + 1);
    for (let L = 0; L <= maxLag; L++) {
      s[L] = score(L);
      if (s[L] > best) { best = s[L]; bi = L; }
    }
    let lag = bi;
    if (bi > 0 && bi < maxLag) {            // parabolic refinement of the peak
      const y0 = s[bi - 1], y1 = s[bi], y2 = s[bi + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-12) lag = bi + 0.5 * (y0 - y2) / den;
    }
    return { lag, corr: best };
  };

})(window);
