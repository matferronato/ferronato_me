// field.mjs — reported frequency over the whole (f_in, f_s) plane.

import { alias, fmtFreq, fmtRate } from './dsp.mjs';
import { state, patch, subscribe } from './state.mjs';
import { $, colors, surface, mono, observeResize } from './ui.mjs';

const MAX_F = 30000;
const MIN_FS = 1000;
const MAX_FS = 30000;
const PAD = { l: 52, r: 16, t: 16, b: 34 };

let buffer = null;

function ramp(u) {
  const stops = [
    [0.00, 22, 34, 62], [0.30, 24, 106, 118], [0.60, 46, 190, 168],
    [0.82, 196, 176, 82], [1.00, 240, 180, 41],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i][0] || i === stops.length - 1) {
      const [a0, ar, ag, ab] = stops[i - 1];
      const [b0, br, bg, bb] = stops[i];
      const k = Math.min(1, Math.max(0, (u - a0) / (b0 - a0)));
      return [ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k];
    }
  }
  return [0, 0, 0];
}

export function drawField() {
  const s = surface($('#field'));
  if (!s) return;
  const { ctx, w, h } = s;
  const c = colors();
  const gw = Math.max(1, w - PAD.l - PAD.r);
  const gh = Math.max(1, h - PAD.t - PAD.b);
  const xOf = (f) => PAD.l + (f / MAX_F) * gw;
  const yOf = (fs) => PAD.t + gh - ((fs - MIN_FS) / (MAX_FS - MIN_FS)) * gh;

  const rw = Math.max(2, Math.round(gw * 0.8));
  const rh = Math.max(2, Math.round(gh * 0.8));
  if (!buffer || buffer.width !== rw || buffer.height !== rh) {
    buffer = Object.assign(document.createElement('canvas'), { width: rw, height: rh });
  }
  const bctx = buffer.getContext('2d');
  if (bctx) {
    // 2x2 supersampled: the ridges get dense enough at the bottom right that one
    // sample per pixel would alias, which would be a poor look for this page.
    const img = bctx.createImageData(rw, rh);
    const dFs = (MAX_FS - MIN_FS) / (rh - 1);
    const dF = MAX_F / (rw - 1);
    for (let py = 0; py < rh; py++) {
      const fsA = MIN_FS + (1 - py / (rh - 1)) * (MAX_FS - MIN_FS);
      for (let px = 0; px < rw; px++) {
        const finA = (px / (rw - 1)) * MAX_F;
        let r = 0; let g = 0; let b = 0;
        for (let sy = 0; sy < 2; sy++) {
          const fs = fsA - sy * dFs * 0.5;
          for (let sx = 0; sx < 2; sx++) {
            const fin = finA + sx * dF * 0.5;
            const [cr, cg, cb] = ramp(alias(fin, fs).f / (fs / 2));
            const k = fin <= fs / 2 ? 0.42 : 1;
            r += cr * k; g += cg * k; b += cb * k;
          }
        }
        const o = (py * rw + px) * 4;
        img.data[o] = r / 4; img.data[o + 1] = g / 4; img.data[o + 2] = b / 4; img.data[o + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buffer, PAD.l, PAD.t, gw, gh);
  }

  ctx.strokeStyle = c.nyq;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(xOf(MIN_FS / 2), yOf(MIN_FS));
  ctx.lineTo(xOf(MAX_FS / 2), yOf(MAX_FS));
  ctx.stroke();
  mono(ctx, 10);
  ctx.fillStyle = c.nyq;
  ctx.save();
  ctx.translate(xOf(MAX_FS / 2) - 6, yOf(MAX_FS) + 46);
  ctx.rotate(-Math.atan2(gh, gw / 2));
  ctx.fillText('fs = 2 f', 0, -5);
  ctx.restore();

  const cx = xOf(state.fieldFin);
  const cy = yOf(state.fieldFs);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(PAD.l, cy); ctx.lineTo(PAD.l + gw, cy);
  ctx.moveTo(cx, PAD.t); ctx.lineTo(cx, PAD.t + gh);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.4; ctx.stroke();

  ctx.fillStyle = c.text;
  mono(ctx, 9.5);
  ctx.textAlign = 'center';
  for (let f = 0; f <= MAX_F; f += 5000) ctx.fillText(`${f / 1000}k`, xOf(f), PAD.t + gh + 15);
  ctx.textAlign = 'right';
  for (let fq = MIN_FS; fq <= MAX_FS; fq += 5000) ctx.fillText(`${(fq / 1000).toFixed(0)}k`, PAD.l - 7, yOf(fq) + 3);
  ctx.fillText('input frequency', PAD.l + gw, PAD.t + gh + 28);
  ctx.textAlign = 'left';
  ctx.save();
  ctx.translate(14, PAD.t + gh / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('sample rate', 0, 0);
  ctx.restore();

  $('#fieldFin').value = state.fieldFin;
  $('#fieldFs').value = state.fieldFs;
  $('#fieldFinOut').value = fmtFreq(state.fieldFin);
  $('#fieldFsOut').value = fmtRate(state.fieldFs);
  $('#fieldOut').textContent = fmtFreq(alias(state.fieldFin, state.fieldFs).f);
}

function pointer(ev) {
  const r = $('#field').getBoundingClientRect();
  const gw = r.width - PAD.l - PAD.r;
  const gh = r.height - PAD.t - PAD.b;
  const px = Math.min(1, Math.max(0, (ev.clientX - r.left - PAD.l) / gw));
  const py = Math.min(1, Math.max(0, (ev.clientY - r.top - PAD.t) / gh));
  patch({
    fieldFin: Math.round((px * MAX_F) / 100) * 100,
    fieldFs: Math.round((MIN_FS + (1 - py) * (MAX_FS - MIN_FS)) / 100) * 100,
  });
}

export function initField() {
  const canvas = $('#field');
  if (!canvas) return;
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); pointer(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) pointer(e); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  $('#fieldFin').addEventListener('input', (e) => patch({ fieldFin: Number(e.target.value) }));
  $('#fieldFs').addEventListener('input', (e) => patch({ fieldFs: Number(e.target.value) }));
  observeResize(canvas, () => { if ($('#view-field')?.classList.contains('is-on')) drawField(); });
  subscribe(() => { if ($('#view-field')?.classList.contains('is-on')) drawField(); });
}
