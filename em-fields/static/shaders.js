"use strict";
/*
 * shaders.js — GLSL ES 3.00 sources.
 *
 * PASS 1 (field): one fragment = one point in space. For every charge it solves
 *   t_r = t - |x - p(t_r)| / c
 * by fixed-point iteration against the charge's worldline (stored in a float
 * texture) and evaluates the Lienard-Wiechert field there. Renders to two
 * float attachments at a reduced resolution.
 *
 * PASS 2 (shade): reads those attachments at full resolution and does line
 * integral convolution, tone mapping, grid and vector glyphs. Everything here
 * is cheap texture work, so field lines and arrows are essentially free.
 */
(function (global) {

  const QUAD_VS = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FIELD_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUv;
layout(location = 0) out vec4 oField;   // Ex, Ey, Bz, |E_rad|
layout(location = 1) out vec4 oExtra;   // E_rad.xy, dE.xy

uniform sampler2D uHistA;   // x, y, vx, vy
uniform sampler2D uHistB;   // ax, ay, q, -
uniform sampler2D uMeta;    // baseX, baseY, baseQ, stationaryFlag

uniform int   uCount;
uniform int   uHead;
uniform int   uHistLen;
uniform int   uHistCount;
uniform float uHistDt;
uniform float uHistTime;
uniform float uTime;
uniform float uC;
uniform int   uIter;
uniform vec2  uCam;
uniform vec2  uView;

const float SOFT = 0.14;
const float BETA_MAX = 0.9;

void ringIndex(float tr, out int i0, out int i1, out float f) {
  float maxK = float(uHistCount - 1);
  float k = clamp((uHistTime - tr) / uHistDt, 0.0, maxK);
  float kf = floor(k);
  f = k - kf;
  int k0 = int(kf);
  int k1 = min(k0 + 1, uHistCount - 1);
  i0 = (uHead - k0 + uHistLen * 2) % uHistLen;
  i1 = (uHead - k1 + uHistLen * 2) % uHistLen;
}

vec2 worldlineAt(int row, float tr) {
  int i0, i1; float f;
  ringIndex(tr, i0, i1, f);
  return mix(texelFetch(uHistA, ivec2(i0, row), 0).xy,
             texelFetch(uHistA, ivec2(i1, row), 0).xy, f);
}

void stateAt(int row, float tr, out vec2 p, out vec2 v, out vec2 a, out float q) {
  int i0, i1; float f;
  ringIndex(tr, i0, i1, f);
  vec4 A = mix(texelFetch(uHistA, ivec2(i0, row), 0), texelFetch(uHistA, ivec2(i1, row), 0), f);
  vec4 B = mix(texelFetch(uHistB, ivec2(i0, row), 0), texelFetch(uHistB, ivec2(i1, row), 0), f);
  p = A.xy; v = A.zw; a = B.xy; q = B.z;
}

void main() {
  vec2 P = uCam + (vUv - 0.5) * uView;

  vec2 Etot = vec2(0.0);
  vec2 Erad = vec2(0.0);
  vec2 Ebase = vec2(0.0);
  float Btot = 0.0;
  float Phi = 0.0;

  for (int i = 0; i < uCount; i++) {
    vec4 meta = texelFetch(uMeta, ivec2(i, 0), 0);

    // --- retarded time ---
    float tr = uHistTime;
    if (meta.w < 0.5) {
      vec2 pn = worldlineAt(i, uHistTime);
      tr = uTime - max(length(P - pn), 1e-4) / uC;
      for (int k = 0; k < uIter; k++) {
        vec2 pr = worldlineAt(i, tr);
        tr = uTime - max(length(P - pr), 1e-4) / uC;
      }
    }

    vec2 p, v, a; float q;
    stateAt(i, tr, p, v, a, q);

    // --- Lienard-Wiechert ---
    vec2 r = P - p;
    float R = max(length(r), SOFT);
    vec2 n = r / R;

    vec2 beta = v / uC;
    float bm = length(beta);
    if (bm > BETA_MAX) beta *= BETA_MAX / bm;
    float b2 = dot(beta, beta);
    float kap = max(1.0 - dot(n, beta), 0.12);
    float k3 = kap * kap * kap;

    vec2 nmb = n - beta;
    vec2 Ev = nmb * (q * (1.0 - b2) / (k3 * (R * R + SOFT * SOFT)));

    vec2 bdot = a / uC;
    float crossZ = nmb.x * bdot.y - nmb.y * bdot.x;
    vec2 Ea = vec2(n.y * crossZ, -n.x * crossZ) * (q / (uC * k3 * R));

    // Lienard-Wiechert scalar potential, softened the same way as the near
    // field. Unlike |E| this carries the sign of the charge, so a positive
    // charge is a hill and a negative one a hollow.
    Phi += q / (kap * sqrt(R * R + SOFT * SOFT));

    vec2 E = Ev + Ea;
    Etot += E;
    Erad += Ea;
    Btot += (n.x * E.y - n.y * E.x) / uC;

    // static reference field (charge frozen at its scenario-load position)
    vec2 rb = P - meta.xy;
    float Rb = max(length(rb), SOFT);
    Ebase += (rb / Rb) * (meta.z / (Rb * Rb + SOFT * SOFT));
  }

  oField = vec4(Etot, Btot, Phi);
  oExtra = vec4(Erad, Etot - Ebase);
}`;

  const SHADE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uF0;
uniform sampler2D uF1;
uniform vec2  uRes;
uniform int   uMode;         // 0 total, 1 near, 2 radiation, 3 disturbance, 4 magnetic, 5 potential
uniform float uExposure;
uniform float uLic;          // 0..1 field-line strength
uniform float uFlow;         // animated advection offset, px
uniform float uArrowCell;    // px; 0 disables glyphs
uniform float uArrowScale;
uniform float uGridPx;       // px; 0 disables grid
uniform float uSurface;      // 0..1 colour-field opacity

/* ---- direction only: one texture fetch in the common cases ---- */
vec2 dirAt(vec2 uv) {
  if (uMode == 2) return texture(uF1, uv).xy;
  if (uMode == 3) return texture(uF1, uv).zw;
  if (uMode == 1) return texture(uF0, uv).xy - texture(uF1, uv).xy;
  return texture(uF0, uv).xy;   // potential shares E's direction: E = -grad phi
}

/* ---- direction + display scalar ---- */
vec3 fieldAt(vec2 uv) {
  vec4 f0 = texture(uF0, uv);
  if (uMode == 4) return vec3(f0.xy, f0.z);
  if (uMode == 5) return vec3(f0.xy, f0.w);
  vec4 f1 = texture(uF1, uv);
  vec2 v = (uMode == 2) ? f1.xy : (uMode == 3) ? f1.zw : (uMode == 1) ? f0.xy - f1.xy : f0.xy;
  return vec3(v, length(v));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/* Line integral convolution along the field, advected for a sense of flow. */
float lic(vec2 px) {
  const int N = 9;
  const float STEP = 2.3;
  float acc = 0.0;
  float wsum = 0.0;
  for (int s = 0; s < 2; s++) {
    float sgn = (s == 0) ? 1.0 : -1.0;
    vec2 p = px;
    for (int i = 0; i < N; i++) {
      vec2 d = dirAt(p / uRes);
      float m = length(d);
      if (m < 1e-9) break;
      d /= m;
      p += d * STEP * sgn;
      float w = 1.0 - float(i) / float(N);
      acc += vnoise((p - d * uFlow) * 0.075) * w;
      wsum += w;
    }
  }
  return wsum > 0.0 ? acc / wsum : 0.5;
}

/* Custom ramps — deep ink to hot filament, and a signed cool/warm pair. */
vec3 palE(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.016, 0.031, 0.063);
  vec3 c1 = vec3(0.098, 0.157, 0.420);
  vec3 c2 = vec3(0.420, 0.169, 0.616);
  vec3 c3 = vec3(0.898, 0.263, 0.373);
  vec3 c4 = vec3(1.000, 0.702, 0.290);
  vec3 c5 = vec3(1.000, 0.973, 0.886);
  if (t < 0.24) return mix(c0, c1, t / 0.24);
  if (t < 0.50) return mix(c1, c2, (t - 0.24) / 0.26);
  if (t < 0.73) return mix(c2, c3, (t - 0.50) / 0.23);
  if (t < 0.91) return mix(c3, c4, (t - 0.73) / 0.18);
  return mix(c4, c5, (t - 0.91) / 0.09);
}

vec3 palB(float s) {
  float t = pow(abs(clamp(s, -1.0, 1.0)), 0.72);
  vec3 ink = vec3(0.016, 0.035, 0.055);
  vec3 cool = mix(ink, vec3(0.180, 0.855, 0.906), t);
  vec3 warm = mix(ink, vec3(1.000, 0.588, 0.220), t);
  vec3 c = s < 0.0 ? cool : warm;
  return mix(c, vec3(1.0), pow(t, 7.0) * 0.65);
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 px = vUv * uRes;
  vec3 fv = fieldAt(vUv);
  float S = fv.z;

  vec3 col;
  if (uMode == 4 || uMode == 5) {
    col = palB(tanh(S * uExposure));
  } else {
    col = palE(pow(1.0 - exp(-S * uExposure), 0.85));
  }
  col *= uSurface;

  if (uLic > 0.001) {
    float stripe = smoothstep(0.33, 0.67, lic(px));
    col *= mix(1.0, mix(0.42, 1.75, stripe), uLic * 0.85);
    // keep lines readable where the magnitude alone would be black
    col += uLic * stripe * 0.075 * vec3(0.36, 0.66, 1.0)
         * smoothstep(0.0, 0.10, (uMode >= 4 ? abs(S) : S) * uExposure);
  }

  if (uGridPx > 1.0) {
    vec2 g = abs(fract(px / uGridPx - 0.5) - 0.5) * uGridPx;
    col += (1.0 - smoothstep(0.0, 1.15, min(g.x, g.y))) * 0.030 * vec3(0.62, 0.83, 1.0);
  }

  if (uArrowCell > 1.0) {
    vec2 cell = floor(px / uArrowCell);
    vec2 ctr = (cell + 0.5) * uArrowCell;
    vec2 v = fieldAt(ctr / uRes).xy;
    float m = length(v);
    if (m > 1e-7) {
      vec2 u = v / m;
      float L = uArrowCell * (0.22 + 0.52 * tanh(m * uArrowScale));
      float d = sdSeg(px, ctr - u * L * 0.5, ctr + u * L * 0.5) - 0.75;
      float hh = max(2.6, L * 0.30);
      vec2 rel = px - (ctr + u * L * 0.5);
      float along = -dot(rel, u);
      float side = abs(dot(rel, vec2(-u.y, u.x)));
      float dh = max(max(-along, along - hh), side - hh * 0.46 * clamp(along / hh, 0.0, 1.0));
      float aa = 1.0 - smoothstep(-0.6, 0.85, min(d, dh));
      col = mix(col, vec3(0.90, 0.96, 1.0), aa * 0.86);
    }
  }

  fragColor = vec4(col, 1.0);
}`;


  /* ------------------------------------------------------------ 3-D surface
   * The same field textures pass 1 already wrote, read in the *vertex* shader
   * to displace a grid. Height and colour come from one number — the tone
   * mapping the flat view uses — so the surface is the flat image lifted, not
   * a second quantity on a different scale.
   */
  const SURF_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aPos;   // grid position in [0,1]^2

uniform sampler2D uF0;
uniform sampler2D uF1;
uniform int   uMode;
uniform float uExposure;
uniform float uHeight;    // world units at full scale
uniform vec2  uView;      // world extent of the plate
uniform vec2  uTexel;     // 1 / field-texture size
uniform mat4  uMVP;

out vec2  vUv;
out float vH;
out vec3  vN;
out vec3  vWorld;

float scalarAt(vec2 uv) {
  vec4 f0 = texture(uF0, uv);
  if (uMode == 4) return f0.z;
  if (uMode == 5) return f0.w;          // signed: hills and hollows
  vec4 f1 = texture(uF1, uv);
  vec2 v = (uMode == 2) ? f1.xy : (uMode == 3) ? f1.zw : (uMode == 1) ? f0.xy - f1.xy : f0.xy;
  return length(v);
}

float heightAt(vec2 uv) {
  float S = scalarAt(uv);
  return (uMode >= 4) ? tanh(S * uExposure)
                      : pow(1.0 - exp(-S * uExposure), 0.85);
}

void main() {
  vUv = aPos;
  float h = heightAt(aPos);
  vH = h;

  // normal from a central difference on the height field, converted to the
  // world slope so lighting does not change when the plate is resized
  vec2 d = uTexel * 1.5;
  float hx = heightAt(aPos + vec2(d.x, 0.0)) - heightAt(aPos - vec2(d.x, 0.0));
  float hy = heightAt(aPos + vec2(0.0, d.y)) - heightAt(aPos - vec2(0.0, d.y));
  float sx = hx * uHeight / max(2.0 * d.x * uView.x, 1e-6);
  float sy = hy * uHeight / max(2.0 * d.y * uView.y, 1e-6);
  vN = normalize(vec3(-sx, -sy, 1.0));

  vec3 p = vec3((aPos.x - 0.5) * uView.x, (aPos.y - 0.5) * uView.y, h * uHeight);
  vWorld = p;
  gl_Position = uMVP * vec4(p, 1.0);
}`;

  const SURF_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2  vUv;
in float vH;
in vec3  vN;
in vec3  vWorld;
out vec4 fragColor;

uniform int   uMode;
uniform vec3  uEye;
uniform float uContour;
uniform float uWire;

vec3 palE(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.016, 0.031, 0.063);
  vec3 c1 = vec3(0.098, 0.157, 0.420);
  vec3 c2 = vec3(0.420, 0.169, 0.616);
  vec3 c3 = vec3(0.898, 0.263, 0.373);
  vec3 c4 = vec3(1.000, 0.702, 0.290);
  vec3 c5 = vec3(1.000, 0.973, 0.886);
  if (t < 0.24) return mix(c0, c1, t / 0.24);
  if (t < 0.50) return mix(c1, c2, (t - 0.24) / 0.26);
  if (t < 0.73) return mix(c2, c3, (t - 0.50) / 0.23);
  if (t < 0.91) return mix(c3, c4, (t - 0.73) / 0.18);
  return mix(c4, c5, (t - 0.91) / 0.09);
}

vec3 palB(float s) {
  float t = pow(abs(clamp(s, -1.0, 1.0)), 0.72);
  vec3 ink = vec3(0.016, 0.035, 0.055);
  vec3 cool = mix(ink, vec3(0.180, 0.855, 0.906), t);
  vec3 warm = mix(ink, vec3(1.000, 0.588, 0.220), t);
  vec3 c = s < 0.0 ? cool : warm;
  return mix(c, vec3(1.0), pow(t, 7.0) * 0.65);
}

void main() {
  vec3 base = (uMode >= 4) ? palB(vH) : palE(vH);
  vec3 N = normalize(vN);
  vec3 L = normalize(vec3(-0.34, -0.52, 0.78));
  vec3 V = normalize(uEye - vWorld);
  vec3 H = normalize(L + V);

  float diff = 0.42 + 0.58 * max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 44.0) * 0.30;
  float rim  = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.16;

  vec3 col = base * diff + spec * vec3(0.85, 0.93, 1.0) + rim * vec3(0.32, 0.58, 1.0);

  if (uContour > 0.5) {
    float f = vH * 14.0;
    float t = abs(fract(f - 0.5) - 0.5);
    float w = max(fwidth(f), 1e-5);
    col += (1.0 - smoothstep(0.0, w * 1.5, t)) * 0.11 * vec3(0.70, 0.85, 1.0);
  }

  if (uWire > 0.5) {
    vec2 g = abs(fract(vUv * 26.0 - 0.5) - 0.5);
    vec2 w = fwidth(vUv * 26.0);
    float line = 1.0 - smoothstep(0.0, 1.0, min(g.x / max(w.x, 1e-5), g.y / max(w.y, 1e-5)));
    col += line * 0.055 * vec3(0.62, 0.83, 1.0);
  }

  fragColor = vec4(col, 1.0);
}`;


  /* ------------------------------------------------------------- particles
   * Charges as lit spheres resting on the height field. The vertex shader
   * reads the same textures the surface does, finds the terrain height and
   * normal under each charge, and sets the sphere centre one radius along that
   * normal — so a particle sits *on* the relief and rides it as it deforms,
   * rather than floating at a fixed height.
   */
  const SPHERE_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 aPos;    // unit sphere
layout(location = 1) in vec4 aInst;   // plate x, plate y, radius, charge
layout(location = 2) in vec2 aFlags;  // selected, dragged

uniform sampler2D uF0;
uniform sampler2D uF1;
uniform int   uMode;
uniform float uExposure;
uniform float uHeight;
uniform vec2  uView;
uniform vec2  uTexel;
uniform mat4  uMVP;

out vec3 vN;
out vec3 vWorld;
out vec4 vTint;
out float vSel;

float scalarAt(vec2 uv) {
  vec4 f0 = texture(uF0, uv);
  if (uMode == 4) return f0.z;
  if (uMode == 5) return f0.w;          // signed: hills and hollows
  vec4 f1 = texture(uF1, uv);
  vec2 v = (uMode == 2) ? f1.xy : (uMode == 3) ? f1.zw : (uMode == 1) ? f0.xy - f1.xy : f0.xy;
  return length(v);
}

float heightAt(vec2 uv) {
  float S = scalarAt(uv);
  return (uMode >= 4) ? tanh(S * uExposure)
                      : pow(1.0 - exp(-S * uExposure), 0.85);
}

void main() {
  vec2 plate = aInst.xy;
  float r = aInst.z;
  vec2 uv = clamp(plate / uView + 0.5, vec2(0.0), vec2(1.0));

  float h = heightAt(uv);
  vec2 d = uTexel * 1.5;
  float hx = heightAt(uv + vec2(d.x, 0.0)) - heightAt(uv - vec2(d.x, 0.0));
  float hy = heightAt(uv + vec2(0.0, d.y)) - heightAt(uv - vec2(0.0, d.y));
  float sx = hx * uHeight / max(2.0 * d.x * uView.x, 1e-6);
  float sy = hy * uHeight / max(2.0 * d.y * uView.y, 1e-6);
  vec3 nrm = normalize(vec3(-sx, -sy, 1.0));

  // rest on the surface: centre one radius up the local normal
  vec3 centre = vec3(plate, h * uHeight) + nrm * r;
  vec3 world = centre + aPos * r;

  vN = aPos;
  vWorld = world;
  vSel = aFlags.x;

  vec3 warm = vec3(1.00, 0.44, 0.34);
  vec3 cool = vec3(0.35, 0.66, 1.00);
  vTint = vec4(aInst.w >= 0.0 ? warm : cool, aFlags.y);
  gl_Position = uMVP * vec4(world, 1.0);
}`;

  const SPHERE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vN;
in vec3 vWorld;
in vec4 vTint;
in float vSel;
out vec4 fragColor;

uniform vec3 uEye;

void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(vec3(-0.34, -0.52, 0.78));   // same light as the surface
  vec3 V = normalize(uEye - vWorld);
  vec3 H = normalize(L + V);

  float diff = 0.30 + 0.70 * max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 60.0) * 0.55;
  float rim  = pow(1.0 - max(dot(N, V), 0.0), 2.4);

  vec3 col = vTint.rgb * diff
           + vec3(1.0) * spec
           + vTint.rgb * rim * 0.55;

  // a dragged charge glows; the selected one gets a bright outline
  col += vTint.rgb * vTint.a * 0.35;
  col = mix(col, vec3(0.92, 0.97, 1.0), vSel * smoothstep(0.45, 0.95, rim));

  fragColor = vec4(col, 1.0);
}`;

  global.EM = global.EM || {};
  global.EM.shaders = { QUAD_VS, FIELD_FS, SHADE_FS, SURF_VS, SURF_FS, SPHERE_VS, SPHERE_FS };

})(window);
