// waveform.mjs — draws a protocol document as a timing figure.
// It knows nothing about any particular protocol: everything comes from the
// document shape produced by protocols.mjs.

import { cellAt } from './protocols.mjs';

export const LAYOUT = {
  gutter: 122,
  group: 22,
  rowH: 30,
  headerH: 38,
  padTop: 6,
  padBottom: 12,
  minCol: 36,
  maxCol: 104,
  slant: 5,
};

export function rowsOf(doc) {
  return doc.signals.length;
}

export function heightOf(doc) {
  return LAYOUT.headerH + rowsOf(doc) * LAYOUT.rowH + LAYOUT.padTop + LAYOUT.padBottom;
}

export function columnWidth(doc, available) {
  const groups = doc.signals.some((s) => s.group) ? LAYOUT.group : 0;
  const usable = available - LAYOUT.gutter - groups - 14;
  const fit = usable / Math.max(1, doc.frames.length);
  return Math.max(LAYOUT.minCol, Math.min(LAYOUT.maxCol, Math.floor(fit)));
}

export function widthOf(doc, colW) {
  const groups = doc.signals.some((s) => s.group) ? LAYOUT.group : 0;
  return LAYOUT.gutter + groups + doc.frames.length * colW + 14;
}

const isNum = (v) => v === 0 || v === 1;

/**
 * @returns {{x0:number, colW:number, frameAt:(x:number)=>number}}
 */
export function draw(canvas, doc, opts) {
  const {
    cursor = 0, colours: C, colW: forcedCol, dpr = Math.min(window.devicePixelRatio || 1, 2),
  } = opts;

  const groups = doc.signals.some((s) => s.group) ? LAYOUT.group : 0;
  const cssW = canvas.clientWidth || canvas.width;
  const colW = forcedCol || columnWidth(doc, cssW);
  const x0 = LAYOUT.gutter + groups;
  const height = heightOf(doc);
  const width = Math.max(cssW, widthOf(doc, colW));

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  canvas.style.width = `${width}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { x0, colW, frameAt: () => 0 };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  const colX = (i) => x0 + i * colW;
  const rowY = (i) => LAYOUT.headerH + LAYOUT.padTop + i * LAYOUT.rowH;
  const drive = (by) => (by === 'S' ? C.sub : by === 'M' ? C.man : C.idle);

  // ---- cursor column ------------------------------------------------
  if (cursor >= 0 && cursor < doc.frames.length) {
    ctx.fillStyle = C.cursor;
    ctx.fillRect(colX(cursor), LAYOUT.headerH - 14, colW, height - LAYOUT.headerH - LAYOUT.padBottom + 14);
  }

  // ---- cycle grid and numbers --------------------------------------
  ctx.font = `12px ${C.mono}`;
  ctx.textAlign = 'center';
  for (let i = 0; i < doc.frames.length; i++) {
    const x = colX(i);
    ctx.strokeStyle = C.grid;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, LAYOUT.headerH - 14);
    ctx.lineTo(Math.round(x) + 0.5, height - LAYOUT.padBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = i === cursor ? C.ink : C.faint;
    ctx.fillText(String(i + 1), x + colW / 2, 9);
  }

  // ---- phase band (merged spans) -----------------------------------
  ctx.font = `12px ${C.sans}`;
  let i = 0;
  while (i < doc.frames.length) {
    let j = i;
    while (j + 1 < doc.frames.length && doc.frames[j + 1].phase === doc.frames[i].phase) j++;
    const x = colX(i);
    const w = (j - i + 1) * colW;
    ctx.fillStyle = C.band;
    ctx.fillRect(x + 1, 19, w - 2, 15);
    ctx.fillStyle = C.faint;
    const label = doc.frames[i].phase;
    if (ctx.measureText(label).width < w - 6) ctx.fillText(label, x + w / 2, 27);
    i = j + 1;
  }

  // ---- signal names, group brackets --------------------------------
  ctx.textAlign = 'right';
  doc.signals.forEach((sig, r) => {
    const y = rowY(r) + LAYOUT.rowH / 2;
    ctx.font = `13px ${C.mono}`;
    ctx.fillStyle = sig.kind === 'clock' ? C.faint : drive(sig.by);
    ctx.fillText(sig.name, LAYOUT.gutter - 12, y);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(rowY(r) + LAYOUT.rowH) + 0.5);
    ctx.lineTo(width - 14, Math.round(rowY(r) + LAYOUT.rowH) + 0.5);
    ctx.stroke();
  });

  if (groups) {
    let r = 0;
    while (r < doc.signals.length) {
      const g = doc.signals[r].group;
      let e = r;
      while (e + 1 < doc.signals.length && doc.signals[e + 1].group === g) e++;
      if (g) {
        const top = rowY(r) + 4;
        const bot = rowY(e) + LAYOUT.rowH - 4;
        ctx.strokeStyle = C.faint;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LAYOUT.gutter + 6.5, top);
        ctx.lineTo(LAYOUT.gutter + 3.5, top + 4);
        ctx.lineTo(LAYOUT.gutter + 3.5, bot - 4);
        ctx.lineTo(LAYOUT.gutter + 6.5, bot);
        ctx.stroke();
        ctx.save();
        ctx.translate(LAYOUT.gutter + 14.5, (top + bot) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.font = `12px ${C.mono}`;
        ctx.fillStyle = C.faint;
        ctx.fillText(g, 0, 0);
        ctx.restore();
      }
      r = e + 1;
    }
  }

  // ---- traces -------------------------------------------------------
  doc.signals.forEach((sig, r) => {
    const top = rowY(r) + 7;
    const bot = rowY(r) + LAYOUT.rowH - 8;
    const mid = (top + bot) / 2;

    if (sig.kind === 'clock') {
      drawClock(ctx, doc, sig, { colX, colW, top, bot, C });
      return;
    }
    if (sig.kind === 'bus') {
      drawBus(ctx, doc, sig, { colX, colW, top, bot, mid, C, drive });
      return;
    }

    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    let prevY = null;
    for (let c = 0; c < doc.frames.length; c++) {
      const cell = cellAt(doc, sig, c);
      const x = colX(c);
      const colour = drive(cell.by);
      if (cell.v === 'z' || cell.v === null) {
        ctx.strokeStyle = C.idle;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, mid); ctx.lineTo(x + colW, mid); ctx.stroke();
        ctx.setLineDash([]);
        prevY = mid;
        continue;
      }
      if (cell.v === 'x') {
        hatch(ctx, x, top, colW, bot - top, C);
        prevY = mid;
        continue;
      }
      const y = cell.v ? top : bot;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      if (cell.mid) {
        // transition inside the cell, e.g. an I2C start or stop condition
        const prev = c > 0 ? cellAt(doc, sig, c - 1) : { v: cell.v };
        const fromY = isNum(prev.v) ? (prev.v ? top : bot) : mid;
        ctx.moveTo(x, fromY);
        ctx.lineTo(x + colW * 0.45, fromY);
        ctx.lineTo(x + colW * 0.55, y);
        ctx.lineTo(x + colW, y);
      } else {
        if (prevY !== null && prevY !== y) { ctx.moveTo(x, prevY); ctx.lineTo(x, y); }
        ctx.moveTo(x, y);
        ctx.lineTo(x + colW, y);
      }
      ctx.stroke();
      prevY = y;
    }
  });

  // ---- markers ------------------------------------------------------
  for (const m of doc.markers) {
    const r = doc.signals.findIndex((s) => s.name === m.signal);
    if (r < 0) continue;
    const x = colX(m.frame);
    const y = rowY(r) + LAYOUT.rowH / 2;
    if (m.kind === 'transfer') {
      // A clocked transfer is captured by the edge that ends the cycle; an
      // event that is defined mid-cell is marked where it actually occurs.
      const ex = cellAt(doc, doc.signals[r], m.frame).mid ? x + colW / 2 : x + colW;
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = C.event;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(ex, LAYOUT.headerH - 12);
      ctx.lineTo(ex, rowY(doc.signals.length - 1) + LAYOUT.rowH - 2);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = C.event;
      ctx.beginPath();
      ctx.arc(ex, y, 3.6, 0, Math.PI * 2);
      ctx.fill();
    } else if (m.kind === 'sample') {
      const ex = m.edge === 'trailing' ? x + colW / 2 : x;
      ctx.fillStyle = C.event;
      ctx.beginPath();
      ctx.moveTo(ex - 4, rowY(r) + 2);
      ctx.lineTo(ex + 4, rowY(r) + 2);
      ctx.lineTo(ex, rowY(r) + 9);
      ctx.closePath();
      ctx.fill();
    }
  }

  return {
    x0,
    colW,
    width,
    height,
    frameAt: (px) => Math.max(0, Math.min(doc.frames.length - 1, Math.floor((px - x0) / colW))),
  };
}

function drawClock(ctx, doc, sig, { colX, colW, top, bot, C }) {
  const idle = sig.polarity ? top : bot;
  const active = sig.polarity ? bot : top;
  ctx.strokeStyle = C.clock;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let c = 0; c < doc.frames.length; c++) {
    const cell = cellAt(doc, sig, c);
    const x = colX(c);
    if (cell.v === 'high') { ctx.moveTo(x, top); ctx.lineTo(x + colW, top); continue; }
    if (cell.v === 'low') { ctx.moveTo(x, bot); ctx.lineTo(x + colW, bot); continue; }
    ctx.moveTo(x, idle);
    ctx.lineTo(x, active);
    ctx.lineTo(x + colW / 2, active);
    ctx.lineTo(x + colW / 2, idle);
    ctx.lineTo(x + colW, idle);
  }
  ctx.stroke();
}

function drawBus(ctx, doc, sig, { colX, colW, top, bot, mid, C, drive }) {
  const s = LAYOUT.slant;
  let c = 0;
  while (c < doc.frames.length) {
    const cell = cellAt(doc, sig, c);
    let end = c;
    while (!sig.noMerge && end + 1 < doc.frames.length) {
      const next = cellAt(doc, sig, end + 1);
      if (String(next.v) !== String(cell.v) || next.by !== cell.by) break;
      end++;
    }
    const x = colX(c);
    const w = (end - c + 1) * colW;

    if (cell.v === null || cell.v === undefined) {
      ctx.strokeStyle = C.idle;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, mid); ctx.lineTo(x + w, mid); ctx.stroke();
      ctx.setLineDash([]);
    } else if (cell.v === 'x') {
      hatch(ctx, x, top, w, bot - top, C);
    } else {
      const colour = drive(cell.by);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x, mid);
      ctx.lineTo(x + s, top);
      ctx.lineTo(x + w - s, top);
      ctx.lineTo(x + w, mid);
      ctx.lineTo(x + w - s, bot);
      ctx.lineTo(x + s, bot);
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.globalAlpha = 1;

      const label = String(cell.v);
      ctx.font = `13px ${C.mono}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = colour;
      let text = label;
      while (text.length > 1 && ctx.measureText(text === label ? text : `${text}\u2026`).width > w - 10) {
        text = text.slice(0, -1);
      }
      if (ctx.measureText(text === label ? text : `${text}\u2026`).width <= w - 10) {
        ctx.fillText(text === label ? label : `${text}\u2026`, x + w / 2, mid);
      }
    }
    c = end + 1;
  }
}

function hatch(ctx, x, y, w, h, C) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = C.idle;
  ctx.lineWidth = 1;
  for (let d = -h; d < w + h; d += 6) {
    ctx.beginPath();
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = C.idle;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
