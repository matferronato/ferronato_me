// vcd.mjs — writes a document out as Value Change Dump, so a waveform you set
// up here can be opened in GTKWave next to a real simulation.
//
// Time base: cycle i occupies [i*T, (i+1)*T). The clock rises at the start of
// each cycle, which puts the values of cycle i in the same place a simulator
// would put them: set up during the cycle, sampled by the edge that ends it.

import { cellAt } from './protocols.mjs';

const ID_CHARS = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const numeric = (v) => typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v.trim());
const asNumber = (v) => (v.trim().toLowerCase().startsWith('0x') ? parseInt(v.trim().slice(2), 16) : parseInt(v.trim(), 10));

function bits(value, width) {
  if (value === null || value === undefined) return 'z'.repeat(width);
  if (value === 'x') return 'x'.repeat(width);
  if (numeric(String(value))) return (asNumber(String(value)) >>> 0).toString(2).padStart(width, '0').slice(-width);
  // fall back to ASCII so labels like NONSEQ or OKAY stay readable in GTKWave
  const text = String(value);
  let out = '';
  for (let i = 0; i < width / 8; i++) {
    const ch = text.charCodeAt(i);
    out += Number.isNaN(ch) ? '00100000' : ch.toString(2).padStart(8, '0');
  }
  return out;
}

function busWidth(doc, sig) {
  let allNumeric = true;
  let longest = 1;
  for (let i = 0; i < doc.frames.length; i++) {
    const { v } = cellAt(doc, sig, i);
    if (v === null || v === undefined || v === 'x') continue;
    if (!numeric(String(v))) { allNumeric = false; longest = Math.max(longest, String(v).length); }
  }
  return allNumeric ? 32 : Math.min(16, longest) * 8;
}

export function toVCD(doc, { periodNs = 10, module = 'busscope', date = new Date() } = {}) {
  const wires = doc.signals.map((sig, i) => ({
    sig,
    id: ID_CHARS[i % ID_CHARS.length],
    width: sig.kind === 'bus' ? busWidth(doc, sig) : 1,
  }));

  const out = [];
  out.push(`$date ${date.toISOString()} $end`);
  out.push('$version BusScope $end');
  out.push(`$comment ${doc.caption.replace(/\$end/g, '')} $end`);
  out.push('$timescale 1ns $end');
  out.push(`$scope module ${module} $end`);
  for (const w of wires) out.push(`$var wire ${w.width} ${w.id} ${w.sig.name}${w.width > 1 ? ` [${w.width - 1}:0]` : ''} $end`);
  out.push('$upscope $end');
  out.push('$enddefinitions $end');

  const last = new Map();
  const emit = (w, text) => {
    if (last.get(w.id) === text) return;
    last.set(w.id, text);
    out.push(w.width > 1 ? `b${text} ${w.id}` : `${text}${w.id}`);
  };

  const half = Math.max(1, Math.round(periodNs / 2));
  for (let c = 0; c < doc.frames.length; c++) {
    out.push(`#${c * periodNs}`);
    for (const w of wires) {
      const cell = cellAt(doc, w.sig, c);
      if (w.sig.kind === 'clock') {
        const idle = w.sig.polarity ? 1 : 0;
        const level = cell.v === 'high' ? 1 : cell.v === 'low' ? 0 : (idle ? 0 : 1);
        emit(w, String(level));
      } else if (w.width > 1) {
        emit(w, bits(cell.v, w.width));
      } else {
        emit(w, cell.v === 'z' || cell.v === null ? 'z' : cell.v === 'x' ? 'x' : String(cell.v ? 1 : 0));
      }
    }
    // second half of the cycle: only the clock moves
    const clockMoves = wires.filter((w) => w.sig.kind === 'clock' && cellAt(doc, w.sig, c).v !== 'high' && cellAt(doc, w.sig, c).v !== 'low');
    if (clockMoves.length) {
      out.push(`#${c * periodNs + half}`);
      for (const w of clockMoves) emit(w, w.sig.polarity ? '1' : '0');
    }
  }
  out.push(`#${doc.frames.length * periodNs}`);
  return `${out.join('\n')}\n`;
}
