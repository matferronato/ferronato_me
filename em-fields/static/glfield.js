"use strict";
/*
 * glfield.js — WebGL2 field renderer.
 *
 * Charge worldlines live in two RGBA32F textures (row = charge, column = time
 * sample). Only the columns written since the last frame are re-uploaded, so
 * per-frame bandwidth is a few kilobytes regardless of history depth.
 */
(function (global) {

  const HIST_LEN = global.EM.HIST_LEN;
  const MAX_CHARGES = global.EM.MAX_CHARGES;

  const MODES = { total: 0, near: 1, radiation: 2, disturbance: 3, magnetic: 4, potential: 5 };
  const GRID_N = 256;    // 65k vertices, 390k indices

  function compile(gl, type, src, name) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`${name}: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  }

  function link(gl, vsSrc, fsSrc, name) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, name + ".vs"));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, name + ".fs"));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.bindAttribLocation(p, 1, "aInst");
    gl.bindAttribLocation(p, 2, "aFlags");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, u };
  }

  /* ---------------------------------------------------------- small mat4 */

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                   + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    const o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf;
    o[11] = -1; o[14] = 2 * far * near * nf;
    return o;
  }

  function lookAt(eye, target, up) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const o = new Float32Array(16);
    o[0] = xx; o[1] = yx; o[2] = zx;
    o[4] = xy; o[5] = yy; o[6] = zy;
    o[8] = xz; o[9] = yz; o[10] = zz;
    o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    o[15] = 1;
    return o;
  }

  /**
   * Camera for the height-field view. The plate is centred on the origin and
   * spans the same world rectangle the flat view shows, so a point at world
   * (x, y) sits at plate (x - cx, y - cy).
   */
  function cameraFor(view, cam, aspect) {
    const span = Math.max(view.w, view.h);
    const d = span * cam.dist;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const eye = [d * cp * Math.cos(cam.yaw), d * cp * Math.sin(cam.yaw), d * sp];
    const proj = perspective(0.74, aspect, span * 0.04, span * 14);
    return { mvp: mul(proj, lookAt(eye, [0, 0, 0], [0, 0, 1])), eye };
  }

  function invert(m) {
    const o = new Float32Array(16);
    const a00=m[0],a01=m[1],a02=m[2],a03=m[3], a10=m[4],a11=m[5],a12=m[6],a13=m[7],
          a20=m[8],a21=m[9],a22=m[10],a23=m[11], a30=m[12],a31=m[13],a32=m[14],a33=m[15];
    const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10,
          b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12,
          b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30,
          b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
    let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if (!det) return null;
    det = 1 / det;
    o[0]=(a11*b11-a12*b10+a13*b09)*det;  o[1]=(a02*b10-a01*b11-a03*b09)*det;
    o[2]=(a31*b05-a32*b04+a33*b03)*det;  o[3]=(a22*b04-a21*b05-a23*b03)*det;
    o[4]=(a12*b08-a10*b11-a13*b07)*det;  o[5]=(a00*b11-a02*b08+a03*b07)*det;
    o[6]=(a32*b02-a30*b05-a33*b01)*det;  o[7]=(a20*b05-a22*b02+a23*b01)*det;
    o[8]=(a10*b10-a11*b08+a13*b06)*det;  o[9]=(a01*b08-a00*b10-a03*b06)*det;
    o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
    o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det;
    o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
    return o;
  }

  /**
   * Where the ray through a screen pixel crosses a horizontal plane in plate
   * space. This is what lets a charge be dragged in the surface view: the
   * pointer picks out a point on the plane the charge is currently sitting at.
   */
  function rayPlane(mvp, sx, sy, cssW, cssH, planeZ) {
    const inv = invert(mvp);
    if (!inv) return null;
    const nx = (sx / cssW) * 2 - 1, ny = 1 - (sy / cssH) * 2;
    const un = (z) => {
      const x = inv[0]*nx + inv[4]*ny + inv[8]*z + inv[12];
      const y = inv[1]*nx + inv[5]*ny + inv[9]*z + inv[13];
      const w = inv[2]*nx + inv[6]*ny + inv[10]*z + inv[14];
      const q = inv[3]*nx + inv[7]*ny + inv[11]*z + inv[15];
      return q ? { x: x/q, y: y/q, z: w/q } : null;
    };
    const a = un(-1), b = un(1);
    if (!a || !b) return null;
    const dz = b.z - a.z;
    if (Math.abs(dz) < 1e-9) return null;
    const t = (planeZ - a.z) / dz;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /** Project a plate-space point to CSS pixels; null when behind the camera. */
  function project(mvp, x, y, z, cssW, cssH) {
    const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (cw <= 1e-6) return null;
    return { x: (cx / cw * 0.5 + 0.5) * cssW, y: (0.5 - cy / cw * 0.5) * cssH };
  }

  class FieldRenderer {
    static create(canvas) {
      const gl = canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: true, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false,
        powerPreference: "high-performance"
      });
      if (!gl) return { error: "WebGL 2 is not available in this browser." };
      if (!gl.getExtension("EXT_color_buffer_float")) {
        return { error: "This GPU/driver does not expose floating-point render targets (EXT_color_buffer_float)." };
      }
      try {
        return { renderer: new FieldRenderer(gl, canvas) };
      } catch (err) {
        return { error: String(err.message || err) };
      }
    }

    constructor(gl, canvas) {
      this.gl = gl;
      this.canvas = canvas;
      this.lost = false;
      this.scale = 0.7;
      this.fw = 1; this.fh = 1;
      this.cw = 1; this.ch = 1;

      const S = global.EM.shaders;
      this.field = link(gl, S.QUAD_VS, S.FIELD_FS, "field");
      this.shade = link(gl, S.QUAD_VS, S.SHADE_FS, "shade");
      try {
        this.surf = link(gl, S.SURF_VS, S.SURF_FS, "surface");
        this.sphere = link(gl, S.SPHERE_VS, S.SPHERE_FS, "spheres");
      } catch (err) {
        this.surf = null;
        this.sphere = null;
        this.surfError = String(err.message || err);
      }
      this.lastMVP = null;

      // fullscreen triangle
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      if (this.surf) { this.buildGrid(GRID_N); this.buildSpheres(); }

      this.histA = this.makeDataTexture(HIST_LEN, MAX_CHARGES);
      this.histB = this.makeDataTexture(HIST_LEN, MAX_CHARGES);
      this.metaTex = this.makeDataTexture(MAX_CHARGES, 1);

      this.fbo = gl.createFramebuffer();
      this.target0 = null;
      this.target1 = null;
      this.allocTargets(320, 200);

      canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); this.lost = true; });
      canvas.addEventListener("webglcontextrestored", () => { this.lost = true; });
    }

    /** Static [0,1]^2 lattice; the vertex shader lifts it out of the plane. */
    buildGrid(n) {
      const gl = this.gl;
      const pos = new Float32Array(n * n * 2);
      for (let j = 0, k = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          pos[k++] = i / (n - 1);
          pos[k++] = j / (n - 1);
        }
      }
      const idx = new Uint32Array((n - 1) * (n - 1) * 6);
      for (let j = 0, k = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
          idx[k++] = a; idx[k++] = c; idx[k++] = b;
          idx[k++] = b; idx[k++] = c; idx[k++] = d;
        }
      }
      this.gridCount = idx.length;
      this.gridVao = gl.createVertexArray();
      gl.bindVertexArray(this.gridVao);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }

    /** Unit UV sphere, drawn once per charge by instancing. */
    buildSpheres() {
      const gl = this.gl;
      const NU = 22, NV = 14;
      const pos = [];
      for (let j = 0; j <= NV; j++) {
        const phi = (j / NV) * Math.PI;
        for (let i = 0; i <= NU; i++) {
          const th = (i / NU) * Math.PI * 2;
          pos.push(Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi));
        }
      }
      const idx = [];
      for (let j = 0; j < NV; j++) {
        for (let i = 0; i < NU; i++) {
          const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      this.sphereCount = idx.length;
      this.sphereVao = gl.createVertexArray();
      gl.bindVertexArray(this.sphereVao);

      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      // per-instance: plate x, plate y, radius, charge, selected, dragged
      this.instStride = 6;
      this.instData = new Float32Array(MAX_CHARGES * this.instStride);
      this.instBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.instData.byteLength, gl.DYNAMIC_DRAW);
      const stride = this.instStride * 4;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
      gl.vertexAttribDivisor(2, 1);

      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }

    /** Spheres share the surface's depth buffer, so ridges occlude them. */
    drawSpheres(engine, view, opts, cam) {
      const gl = this.gl;
      if (!this.sphere || !engine.charges.length) return;
      const span = Math.max(view.w, view.h);
      const data = this.instData, k = this.instStride;
      let n = 0;
      const hx = view.w * 0.5, hy = view.h * 0.5;
      for (const ch of engine.charges) {
        const px = ch.pos.x - view.cx, py = ch.pos.y - view.cy;
        // off the plate entirely: skip, rather than let the shader clamp it
        // to the border and stack charges along the edge
        if (Math.abs(px) > hx * 1.04 || Math.abs(py) > hy * 1.04) continue;
        const q = Math.abs(ch.q);
        const o = n * k;
        data[o]     = px;
        data[o + 1] = py;
        data[o + 2] = span * 0.011 * (0.72 + 0.42 * Math.min(q, 2.2)) * opts.particleScale;
        data[o + 3] = ch.q;
        data[o + 4] = ch.id === opts.selectedId ? 1 : 0;
        data[o + 5] = ch.id === engine.draggingId ? 1 : 0;
        n++;
      }
      const p = this.sphere;
      gl.useProgram(p.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.target0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.target1);
      gl.uniform1i(p.u.uF0, 0);
      gl.uniform1i(p.u.uF1, 1);
      gl.uniform1i(p.u.uMode, MODES[opts.mode] ?? 0);
      gl.uniform1f(p.u.uExposure, opts.exposure);
      gl.uniform1f(p.u.uHeight, opts.height);
      gl.uniform2f(p.u.uView, view.w, view.h);
      gl.uniform2f(p.u.uTexel, 1 / this.fw, 1 / this.fh);
      gl.uniformMatrix4fv(p.u.uMVP, false, cam.mvp);
      gl.uniform3f(p.u.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);

      gl.bindVertexArray(this.sphereVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * k);
      gl.drawElementsInstanced(gl.TRIANGLES, this.sphereCount, gl.UNSIGNED_INT, 0, n);
    }

    makeDataTexture(w, h) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    allocTargets(w, h) {
      const gl = this.gl;
      w = Math.max(8, w | 0);
      h = Math.max(8, h | 0);
      if (w === this.fw && h === this.fh && this.target0) return;
      this.fw = w; this.fh = h;
      for (const old of [this.target0, this.target1]) if (old) gl.deleteTexture(old);
      const make = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.target0 = make();
      this.target1 = make();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target0, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.target1, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Could not create a float render target (status 0x" + status.toString(16) + ").");
      }
    }

    resize(cssWidth, cssHeight, dpr) {
      const gl = this.gl;
      this.cw = Math.max(1, Math.round(cssWidth * dpr));
      this.ch = Math.max(1, Math.round(cssHeight * dpr));
      if (this.canvas.width !== this.cw) this.canvas.width = this.cw;
      if (this.canvas.height !== this.ch) this.canvas.height = this.ch;
      this.canvas.style.width = cssWidth + "px";
      this.canvas.style.height = cssHeight + "px";
      this.applyScale();
      void gl;
    }

    setScale(s) {
      const next = Math.max(0.25, Math.min(1, s));
      if (Math.abs(next - this.scale) < 0.005) return;
      this.scale = next;
      this.applyScale();
    }

    applyScale() {
      this.allocTargets(Math.round(this.cw * this.scale), Math.round(this.ch * this.scale));
    }

    uploadStrip(tex, data, x, w) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, HIST_LEN);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, 0, w, MAX_CHARGES, gl.RGBA, gl.FLOAT, data);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    }

    uploadHistory(engine) {
      const gl = this.gl;
      if (engine.fullUpload) {
        gl.bindTexture(gl.TEXTURE_2D, this.histA);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, HIST_LEN, MAX_CHARGES, gl.RGBA, gl.FLOAT, engine.texA);
        gl.bindTexture(gl.TEXTURE_2D, this.histB);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, HIST_LEN, MAX_CHARGES, gl.RGBA, gl.FLOAT, engine.texB);
        engine.fullUpload = false;
      } else if (engine.dirtyCount > 0) {
        const from = engine.dirtyFrom;
        const first = Math.min(engine.dirtyCount, HIST_LEN - from);
        this.uploadStrip(this.histA, engine.texA, from, first);
        this.uploadStrip(this.histB, engine.texB, from, first);
        const rest = engine.dirtyCount - first;
        if (rest > 0) {
          this.uploadStrip(this.histA, engine.texA, 0, rest);
          this.uploadStrip(this.histB, engine.texB, 0, rest);
        }
      }
      engine.dirtyCount = 0;

      gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_CHARGES, 1, gl.RGBA, gl.FLOAT, engine.meta);
    }

    render(engine, view, opts) {
      if (this.lost) return;
      const gl = this.gl;
      this.uploadHistory(engine);
      gl.bindVertexArray(this.vao);

      // ---------- pass 1: physics ----------
      const f = this.field;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.fw, this.fh);
      gl.useProgram(f.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.histA);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.histB);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
      gl.uniform1i(f.u.uHistA, 0);
      gl.uniform1i(f.u.uHistB, 1);
      gl.uniform1i(f.u.uMeta, 2);
      gl.uniform1i(f.u.uCount, engine.charges.length);
      gl.uniform1i(f.u.uHead, engine.histHead);
      gl.uniform1i(f.u.uHistLen, HIST_LEN);
      gl.uniform1i(f.u.uHistCount, Math.max(engine.histCount, 2));
      gl.uniform1f(f.u.uHistDt, global.EM.HIST_DT);
      gl.uniform1f(f.u.uHistTime, engine.histTime);
      gl.uniform1f(f.u.uTime, engine.time);
      gl.uniform1f(f.u.uC, engine.c);
      gl.uniform1i(f.u.uIter, opts.iterations);
      gl.uniform2f(f.u.uCam, view.cx, view.cy);
      gl.uniform2f(f.u.uView, view.w, view.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // ---------- pass 2: shading ----------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.cw, this.ch);

      if (opts.threeD && this.surf) {
        this.renderSurface(engine, view, opts);
        gl.bindVertexArray(null);
        return;
      }

      gl.disable(gl.DEPTH_TEST);
      const s = this.shade;
      gl.useProgram(s.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.target0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.target1);
      gl.uniform1i(s.u.uF0, 0);
      gl.uniform1i(s.u.uF1, 1);
      gl.uniform2f(s.u.uRes, this.cw, this.ch);
      gl.uniform1i(s.u.uMode, MODES[opts.mode] ?? 0);
      gl.uniform1f(s.u.uExposure, opts.exposure);
      gl.uniform1f(s.u.uLic, opts.lic);
      gl.uniform1f(s.u.uFlow, opts.flow);
      gl.uniform1f(s.u.uArrowCell, opts.arrowCell);
      gl.uniform1f(s.u.uArrowScale, opts.arrowScale);
      gl.uniform1f(s.u.uGridPx, opts.gridPx);
      gl.uniform1f(s.u.uSurface, opts.surface);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindVertexArray(null);
    }

    /** Height-field pass: the same textures, read in the vertex shader. */
    renderSurface(engine, view, opts) {
      const gl = this.gl;
      const cam = cameraFor(view, opts.cam, this.cw / Math.max(this.ch, 1));
      this.lastMVP = cam.mvp;

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.clearColor(0.023, 0.035, 0.055, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const p = this.surf;
      gl.useProgram(p.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.target0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.target1);
      gl.uniform1i(p.u.uF0, 0);
      gl.uniform1i(p.u.uF1, 1);
      gl.uniform1i(p.u.uMode, MODES[opts.mode] ?? 0);
      gl.uniform1f(p.u.uExposure, opts.exposure);
      gl.uniform1f(p.u.uHeight, opts.height);
      gl.uniform2f(p.u.uView, view.w, view.h);
      gl.uniform2f(p.u.uTexel, 1 / this.fw, 1 / this.fh);
      gl.uniformMatrix4fv(p.u.uMVP, false, cam.mvp);
      gl.uniform3f(p.u.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
      gl.uniform1f(p.u.uContour, opts.contour ? 1 : 0);
      gl.uniform1f(p.u.uWire, opts.gridPx > 1 ? 1 : 0);

      gl.bindVertexArray(this.gridVao);
      gl.drawElements(gl.TRIANGLES, this.gridCount, gl.UNSIGNED_INT, 0);

      if (opts.particles) this.drawSpheres(engine, view, opts, cam);
      gl.disable(gl.DEPTH_TEST);
    }
  }

  global.EM = global.EM || {};
  global.EM.FieldRenderer = FieldRenderer;
  global.EM.MODES = MODES;
  global.EM.cameraFor = cameraFor;
  global.EM.project = project;
  global.EM.rayPlane = rayPlane;

})(window);
