// ui.mjs — canvas plumbing shared by every screen on the page.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let palette = null;

export function colors() {
  if (palette) return palette;
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  palette = {
    screen: g('--screen'), grat: g('--grat'), axis: g('--grat-axis'), text: g('--screen-ink'),
    a: g('--ch-a'), b: g('--ch-b'), c: g('--ch-c'), ghost: g('--ghost'),
    fold: g('--fold'), nyq: g('--nyq'),
    ok: g('--ok'), warn: g('--warn'), bad: g('--bad'), mono: g('--mono'),
  };
  return palette;
}

export function dropPalette() { palette = null; }

export function surface(canvas) {
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = colors().screen;
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

export function mono(ctx, size = 10) {
  ctx.font = `${size}px ${colors().mono || 'monospace'}`;
}

export function graticule(ctx, box, cols = 10, rows = 8) {
  const c = colors();
  ctx.strokeStyle = c.grat;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    const x = Math.round(box.x + (i * box.w) / cols) + 0.5;
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
  }
  for (let i = 0; i <= rows; i++) {
    const y = Math.round(box.y + (i * box.h) / rows) + 0.5;
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
  }
  ctx.stroke();
}

export function centreLine(ctx, box) {
  const c = colors();
  ctx.strokeStyle = c.axis;
  ctx.lineWidth = 1;
  const y = Math.round(box.y + box.h / 2) + 0.5;
  ctx.beginPath();
  ctx.moveTo(box.x, y);
  ctx.lineTo(box.x + box.w, y);
  ctx.stroke();
}

// Draw either kind of trace produced by model.analogTrace.
export function strokeTrace(ctx, trace, box, yOf, colour, width = 1.6) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (trace.kind === 'band') {
    for (let px = 0; px < trace.n; px++) {
      const x = box.x + px + 0.5;
      ctx.moveTo(x, yOf(trace.hi[px]));
      ctx.lineTo(x, yOf(trace.lo[px]));
    }
  } else {
    for (let i = 0; i < trace.n; i++) {
      const x = box.x + (i / (trace.n - 1)) * box.w;
      const y = yOf(trace.y[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

export function strokeSeries(ctx, y, count, box, yOf, colour, width = 1.6) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = box.x + (i / (count - 1)) * box.w;
    const yy = yOf(y[i]);
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  }
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 * Log frequency axis
 * ------------------------------------------------------------------ */

export function logAxis(lo, hi, x0, width) {
  const k = Math.log(hi / lo);
  return {
    lo,
    hi,
    of: (f) => x0 + (Math.log(Math.max(f, lo) / lo) / k) * width,
    inv: (x) => lo * Math.exp(((x - x0) / width) * k),
  };
}

const DECADE_LABEL = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'],
];

export function decadeTicks(ctx, ax, box, unit = 'Hz', minor = true) {
  const c = colors();
  mono(ctx, 9.5);
  ctx.textAlign = 'center';
  const first = Math.floor(Math.log10(ax.lo));
  const last = Math.ceil(Math.log10(ax.hi));
  for (let e = first; e <= last; e++) {
    const f = 10 ** e;
    if (f < ax.lo * 0.999 || f > ax.hi * 1.001) continue;
    const x = Math.round(ax.of(f)) + 0.5;
    ctx.strokeStyle = c.grat;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
    ctx.stroke();
    const [scale, prefix] = DECADE_LABEL.find(([s]) => f >= s * 0.999) || [1e-3, 'm'];
    const n = f / scale;
    const shown = n >= 1 ? String(Math.round(n)) : String(Number(n.toPrecision(2)));
    ctx.fillStyle = c.text;
    ctx.fillText(`${shown} ${prefix}${unit}`, x, box.y + box.h + 13);
    if (!minor) continue;
    ctx.strokeStyle = c.grat;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    for (let m = 2; m <= 9; m++) {
      const fm = f * m;
      if (fm > ax.hi) break;
      const xm = Math.round(ax.of(fm)) + 0.5;
      ctx.moveTo(xm, box.y + box.h - 5);
      ctx.lineTo(xm, box.y + box.h);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'left';
}

/* ------------------------------------------------------------------ *
 * Small text furniture
 * ------------------------------------------------------------------ */

export function label(ctx, text, x, y, colour, size = 10.5, align = 'left') {
  mono(ctx, size);
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

export function keyLine(ctx, entries, x, y) {
  const c = colors();
  mono(ctx, 9.5);
  let kx = x;
  for (const [colour, text, dashed] of entries) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    if (dashed) ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(kx, y + 4);
    ctx.lineTo(kx + 11, y + 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.text;
    ctx.textBaseline = 'top';
    ctx.fillText(text, kx + 15, y);
    kx += 26 + ctx.measureText(text).width;
  }
  ctx.textBaseline = 'alphabetic';
}

export function observeResize(el, fn) {
  if (!el) return;
  new ResizeObserver(fn).observe(el);
}
