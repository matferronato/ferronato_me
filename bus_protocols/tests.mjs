// node tests.mjs
// The timing diagrams are only worth drawing if the models behind them are
// right, so the rules each protocol promises are asserted here directly.

import { PROTOCOLS, build, cellAt, burstAddress, hex } from './protocols.mjs';
import { toVCD } from './vcd.mjs';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const sig = (doc, name) => doc.signals.find((s) => s.name === name);
const track = (doc, name) => {
  const s = sig(doc, name);
  if (!s) return [];
  return doc.frames.map((_, i) => cellAt(doc, s, i).v);
};
const drivers = (doc, name) => {
  const s = sig(doc, name);
  return doc.frames.map((_, i) => cellAt(doc, s, i).by);
};
const count = (arr, v) => arr.filter((x) => x === v).length;
const transfers = (doc) => doc.markers.filter((m) => m.kind === 'transfer');

/* ------------------------------------------------------------ APB -- */

{
  const doc = build('apb', { transaction: 'write', wait: 2 });
  const psel = track(doc, 'PSEL');
  const pen = track(doc, 'PENABLE');
  const prdy = track(doc, 'PREADY');

  eq('apb: idle, setup, three access cycles, idle', doc.frames.length, 6);
  const setup = doc.frames.findIndex((f) => f.phase === 'SETUP');
  ok('apb: setup asserts PSEL with PENABLE low', psel[setup] === 1 && pen[setup] === 0);
  ok('apb: setup lasts exactly one cycle', pen[setup + 1] === 1);
  eq('apb: PREADY low for each wait state', count(prdy.slice(setup), 0), 2);
  ok('apb: PREADY is a don\'t care outside the access phase', prdy[setup] === 'x' && prdy[0] === 'x');
  ok('apb: PSEL stays high for the whole transfer', psel.slice(setup, doc.frames.length - 1).every((v) => v === 1));

  const addr = track(doc, 'PADDR');
  ok('apb: address is stable from setup to the end of access',
    new Set(addr.slice(setup, doc.frames.length - 1)).size === 1);
  eq('apb: exactly one transfer', transfers(doc).length, 1);
  eq('apb: the transfer is the last access cycle', transfers(doc)[0].frame, doc.frames.length - 2);

  const read = build('apb', { transaction: 'read', wait: 0 });
  ok('apb: a read presents PRDATA and drops PWDATA', !!sig(read, 'PRDATA') && !sig(read, 'PWDATA'));
  eq('apb: read data comes from the subordinate', sig(read, 'PRDATA').by, 'S');
  eq('apb: PWRITE is low for a read', track(read, 'PWRITE')[1], 0);
}

/* ------------------------------------------------------ AHB-Lite -- */

{
  const doc = build('ahb', { transaction: 'write', wait: 0, beats: 4 });
  const trans = track(doc, 'HTRANS');
  const addr = track(doc, 'HADDR');
  const data = track(doc, 'HWDATA');

  eq('ahb: first beat is NONSEQ', trans.find((v) => v && v !== 'IDLE'), 'NONSEQ');
  eq('ahb: later beats are SEQ', count(trans, 'SEQ'), 3);
  eq('ahb: one transfer per beat', transfers(doc).length, 4);

  // The point of the protocol: address of beat n+1 shares a cycle with data of beat n.
  const overlap = doc.frames.findIndex((_, i) => addr[i] === hex(0x1004) && data[i] === hex(0xd0, 2));
  ok('ahb: address phase overlaps the previous data phase', overlap > 0, `no overlapping cycle found`);

  const addrs = addr.filter((v) => v).filter((v, i, a) => v !== a[i - 1]);
  eq('ahb: addresses increment by the transfer size', addrs.join(','),
    [hex(0x1000), hex(0x1004), hex(0x1008), hex(0x100c)].join(','));

  const stalled = build('ahb', { transaction: 'write', wait: 2, beats: 2 });
  eq('ahb: HREADY is low once per wait state', count(track(stalled, 'HREADY'), 0), 2);
  const hr = track(stalled, 'HREADY');
  const ha = track(stalled, 'HADDR');
  // The rule is forward looking: a low HREADY means the address you are
  // presenting has to still be there next cycle.
  const held = hr.every((v, i) => v !== 0 || i === hr.length - 1 || ha[i + 1] === ha[i]);
  ok('ahb: the address is held while HREADY is low', held);
}

/* ----------------------------------------------------------- AXI -- */

{
  eq('axi: INCR advances by the beat size', burstAddress(0x1000, 3, 2, 'INCR', 4), 0x100c);
  eq('axi: FIXED stays put', burstAddress(0x1000, 3, 2, 'FIXED', 4), 0x1000);
  eq('axi: WRAP rolls back inside its block', burstAddress(0x1008, 3, 2, 'WRAP', 4), 0x1004);
  eq('axi: WRAP first beat is the requested address', burstAddress(0x1008, 0, 2, 'WRAP', 4), 0x1008);
  ok('axi: a WRAP burst never leaves its aligned block',
    [0, 1, 2, 3].every((i) => {
      const a = burstAddress(0x1008, i, 2, 'WRAP', 4);
      return a >= 0x1000 && a < 0x1010;
    }));
  eq('axi: an 8 byte size doubles the stride', burstAddress(0x2000, 2, 3, 'INCR', 4), 0x2010);

  const w = build('axi4', { transaction: 'write', wait: 0, beats: 4, burst: 'INCR' });
  eq('axi write: one transfer per beat plus address plus response', transfers(w).length, 6);
  eq('axi write: AWLEN is beats minus one', track(w, 'AWLEN').find((v) => v !== null), '3');
  eq('axi write: WLAST is asserted once', count(track(w, 'WLAST'), 1), 1);
  const wlast = track(w, 'WLAST');
  const wvalid = track(w, 'WVALID');
  ok('axi write: WLAST lands on the final data beat',
    wlast.lastIndexOf(1) === wvalid.lastIndexOf(1));

  // VALID may not be withdrawn before READY answers.
  const stalled = build('axi4', { transaction: 'write', wait: 3, beats: 4 });
  const av = track(stalled, 'AWVALID');
  const ar = track(stalled, 'AWREADY');
  let heldUntilReady = true;
  for (let i = 0; i < stalled.frames.length - 1; i++) {
    if (av[i] === 1 && ar[i] !== 1 && av[i + 1] !== 1) heldUntilReady = false;
  }
  ok('axi write: AWVALID is held until AWREADY answers', heldUntilReady);
  ok('axi write: AWREADY is low for every stall cycle', count(ar.slice(0, 4), 0) >= 3);

  const sv = track(stalled, 'WVALID');
  const sr = track(stalled, 'WREADY');
  const sd = track(stalled, 'WDATA');
  let dataHeld = true;
  for (let i = 0; i < stalled.frames.length - 1; i++) {
    if (sv[i] === 1 && sr[i] === 0 && sd[i + 1] !== sd[i]) dataHeld = false;
  }
  ok('axi write: stalled write data is held on the bus', dataHeld);

  const r = build('axi4', { transaction: 'read', wait: 1, beats: 4, burst: 'WRAP' });
  eq('axi read: RLAST is asserted once', count(track(r, 'RLAST'), 1), 1);
  eq('axi read: one data beat per burst beat', count(track(r, 'RVALID'), 1), 4);
  eq('axi read: the caption lists the wrapped addresses',
    r.addresses.map((a) => hex(a)).join(','),
    [hex(0x1004), hex(0x1008), hex(0x100c), hex(0x1000)].join(','));
  ok('axi read: read data is driven by the subordinate', sig(r, 'RDATA').by === 'S');

  const lite = build('axil', { transaction: 'write', wait: 0 });
  ok('axi-lite: no burst length signal', !sig(lite, 'AWLEN'));
  ok('axi-lite: no WLAST', !sig(lite, 'WLAST'));
  eq('axi-lite: a write moves exactly one beat', count(track(lite, 'WVALID'), 1), 1);
  ok('axi-lite: address and data channels can run in the same cycle',
    lite.frames.some((_, i) => track(lite, 'AWVALID')[i] === 1 && track(lite, 'WVALID')[i] === 1));
}

/* -------------------------------------------------------- streams -- */

for (const id of ['axis', 'avst']) {
  const doc = build(id, { beats: 4, wait: 2 });
  const V = id === 'axis' ? 'TVALID' : 'valid';
  const R = id === 'axis' ? 'TREADY' : 'ready';
  const D = id === 'axis' ? 'TDATA' : 'data';
  const L = id === 'axis' ? 'TLAST' : 'endofpacket';
  const v = track(doc, V);
  const rdy = track(doc, R);
  const d = track(doc, D);

  eq(`${id}: one transfer per beat`, transfers(doc).length, 4);
  eq(`${id}: end of packet is asserted once`, count(track(doc, L), 1), 1);

  let stable = true;
  for (let i = 0; i < doc.frames.length - 1; i++) {
    if (v[i] === 1 && rdy[i] !== 1 && (v[i + 1] !== 1 || d[i + 1] !== d[i])) stable = false;
  }
  ok(`${id}: a stalled beat is held, not withdrawn`, stable);
  ok(`${id}: the source can insert a bubble`, doc.frames.some((f) => f.phase === 'bubble'));
  ok(`${id}: nothing transfers unless both sides agree`,
    doc.markers.every((m) => v[m.frame] === 1 && rdy[m.frame] === 1));
}

/* ----------------------------------------------------- Avalon-MM -- */

{
  const doc = build('avmm', { transaction: 'read', wait: 2 });
  eq('avalon-mm: waitrequest is high for each stall', count(track(doc, 'waitrequest'), 1), 2);
  eq('avalon-mm: read data is announced once', count(track(doc, 'readdatavalid'), 1), 1);
  const rdv = track(doc, 'readdatavalid').indexOf(1);
  const acc = doc.markers.find((m) => m.text === 'command accepted').frame;
  ok('avalon-mm: read data comes back after acceptance', rdv > acc);

  const w = build('avmm', { transaction: 'write', wait: 0 });
  const addr = track(w, 'address');
  ok('avalon-mm: a write holds address and data together',
    addr.some((v, i) => v !== null && track(w, 'writedata')[i] !== null));
}

/* ------------------------------------------------------ Wishbone -- */

{
  const doc = build('wb', { transaction: 'read', wait: 2 });
  eq('wishbone: ACK arrives once', count(track(doc, 'ACK_I'), 1), 1);
  const cyc = track(doc, 'CYC_O');
  const stb = track(doc, 'STB_O');
  ok('wishbone: CYC and STB rise together', cyc.every((v, i) => v === stb[i]));
  eq('wishbone: the cycle extends by one frame per wait', doc.frames.length, 5);
}

/* ----------------------------------------------------------- I2C -- */

{
  const doc = build('i2c', { transaction: 'write' });
  const scl = track(doc, 'SCL');
  const sda = doc.signals.find((s) => s.name === 'SDA');

  const start = doc.frames.findIndex((f) => f.phase === 'START');
  ok('i2c: start drops SDA while SCL is high', scl[start] === 'high' && cellAt(doc, sda, start).v === 0);
  ok('i2c: the start transition happens inside the cycle', cellAt(doc, sda, start).mid === true);

  const stop = doc.frames.findIndex((f) => f.phase === 'STOP');
  ok('i2c: stop releases SDA while SCL is high', scl[stop] === 'high' && cellAt(doc, sda, stop).v === 1);

  eq('i2c: seven address bits are clocked out', doc.frames.filter((f) => /^A\d$/.test(f.phase)).length, 7);
  eq('i2c: eight data bits are clocked out', doc.frames.filter((f) => /^D\d$/.test(f.phase)).length, 8);

  const addrBits = doc.frames.filter((f) => /^A\d$/.test(f.phase))
    .map((f) => f.v.SDA.v).join('');
  eq('i2c: the address on the wire is 0x50, msb first', addrBits, '1010000');

  const ackFrame = doc.frames.findIndex((f) => f.phase === 'ACK');
  eq('i2c: the target drives the acknowledge bit', cellAt(doc, sda, ackFrame).by, 'S');
  eq('i2c: the controller drives write data', cellAt(doc, sda, doc.frames.findIndex((f) => f.phase === 'D7')).by, 'M');

  const rd = build('i2c', { transaction: 'read' });
  eq('i2c read: the target drives the data bits',
    cellAt(rd, sig(rd, 'SDA'), rd.frames.findIndex((f) => f.phase === 'D7')).by, 'S');
  const nack = rd.frames.findIndex((f) => f.phase === 'NACK');
  ok('i2c read: the controller ends the read by not acknowledging',
    cellAt(rd, sig(rd, 'SDA'), nack).v === 1 && cellAt(rd, sig(rd, 'SDA'), nack).by === 'M');

  const stretched = build('i2c', { transaction: 'write', stretch: true });
  ok('i2c: clock stretching holds SCL low', track(stretched, 'SCL').includes('low'));
  eq('i2c: stretching adds exactly one cycle', stretched.frames.length, doc.frames.length + 1);
}

/* ----------------------------------------------------------- SPI -- */

for (const mode of [0, 1, 2, 3]) {
  const cpol = mode >> 1;
  const cpha = mode & 1;
  const doc = build('spi', { cpol, cpha });
  const bits = doc.frames.filter((f) => /^bit \d$/.test(f.phase));
  eq(`spi mode ${mode}: eight bit periods`, bits.length, 8);
  eq(`spi mode ${mode}: clock idles at CPOL`, sig(doc, 'SCLK').polarity, cpol);
  const cs = track(doc, 'CS_n');
  ok(`spi mode ${mode}: chip select is low for every bit`,
    doc.frames.every((f, i) => (/^bit \d$/.test(f.phase) ? cs[i] === 0 : true)));
  eq(`spi mode ${mode}: select is released at the end`, cs[cs.length - 1], 1);
  const edges = new Set(doc.markers.filter((m) => m.kind === 'sample').map((m) => m.edge));
  eq(`spi mode ${mode}: sampling edge follows CPHA`, [...edges].join(), cpha ? 'trailing' : 'leading');
  eq(`spi mode ${mode}: one sample marker per bit`, doc.markers.filter((m) => m.kind === 'sample').length, 8);
}

/* ------------------------------------------- invariants everywhere -- */

const COMBOS = [];
for (const id of Object.keys(PROTOCOLS)) {
  const o = PROTOCOLS[id].options;
  const txs = o.transactions ?? [undefined];
  const waits = o.wait !== undefined ? [0, 1, o.wait] : [0];
  const beats = o.beats ? [o.beats[0], 4, o.beats[1]] : [4];
  const bursts = o.burst ?? ['INCR'];
  const modes = o.spiMode ? [0, 1, 2, 3] : [0];
  for (const transaction of txs) {
    for (const wait of waits) {
      for (const b of beats) {
        for (const burst of bursts) {
          for (const m of modes) {
            if (id === 'axi4' && burst === 'WRAP' && ![2,4,8,16].includes(b)) continue;
            COMBOS.push({ id, transaction, wait, beats: b, burst, cpol: m >> 1, cpha: m & 1, stretch: !!o.stretch });
          }
        }
      }
    }
  }
}

let structural = 0;
for (const combo of COMBOS) {
  const doc = build(combo.id, combo);
  const names = doc.signals.map((s) => s.name);
  const label = `${combo.id}/${combo.transaction ?? '-'}/w${combo.wait}/b${combo.beats}`;

  if (new Set(names).size !== names.length) failures.push(`${label}: duplicate signal names`);
  else if (doc.frames.length < 3) failures.push(`${label}: only ${doc.frames.length} cycles`);
  else if (doc.frames.some((f) => !f.phase || !f.note)) failures.push(`${label}: a cycle has no phase or note`);
  else if (doc.markers.some((m) => !names.includes(m.signal))) failures.push(`${label}: marker on an unknown signal`);
  else if (doc.markers.some((m) => m.frame < 0 || m.frame >= doc.frames.length)) failures.push(`${label}: marker outside the diagram`);
  else if (doc.signals.some((s) => doc.frames.some((_, i) => cellAt(doc, s, i) === undefined))) failures.push(`${label}: undefined cell`);
  else if (!doc.caption) failures.push(`${label}: no caption`);
  else if (doc.signals[0].kind !== 'clock') failures.push(`${label}: first row is not the clock`);
  else structural++;
}
ok(`every option combination builds a sound document (${COMBOS.length} combinations)`, structural === COMBOS.length);

/* ----------------------------------------------------------- VCD -- */

{
  let allGood = true;
  let detail = '';
  for (const combo of COMBOS) {
    const doc = build(combo.id, combo);
    const text = toVCD(doc, { periodNs: 10 });
    const ids = [...text.matchAll(/\$var wire (\d+) (\S+) (\S+)/g)];
    if (ids.length !== doc.signals.length) { allGood = false; detail = `${combo.id}: declared ${ids.length} of ${doc.signals.length} signals`; break; }
    if (!text.includes('$enddefinitions $end') || !text.includes('$timescale 1ns $end')) { allGood = false; detail = `${combo.id}: header incomplete`; break; }
    const times = [...text.matchAll(/^#(\d+)$/gm)].map((m) => Number(m[1]));
    if (times.some((t, i) => i && t <= times[i - 1])) { allGood = false; detail = `${combo.id}: timestamps not monotonic`; break; }
    const known = new Set(ids.map((m) => m[2]));
    const widths = new Map(ids.map((m) => [m[2], Number(m[1])]));
    for (const line of text.split('\n')) {
      if (/^b[01xz]+ \S$/.test(line)) {
        const [bitsPart, id] = line.slice(1).split(' ');
        if (!known.has(id)) { allGood = false; detail = `${combo.id}: value for undeclared ${id}`; }
        if (bitsPart.length !== widths.get(id)) { allGood = false; detail = `${combo.id}: ${id} width ${bitsPart.length} vs ${widths.get(id)}`; }
      } else if (/^[01xz]\S$/.test(line)) {
        const id = line[1];
        if (!known.has(id)) { allGood = false; detail = `${combo.id}: scalar for undeclared ${id}`; }
        if (widths.get(id) !== 1) { allGood = false; detail = `${combo.id}: ${id} is a vector written as a scalar`; }
      }
    }
    if (!allGood) break;
  }
  ok('every waveform exports as valid VCD', allGood, detail);

  const doc = build('apb', { transaction: 'write', wait: 1 });
  const text = toVCD(doc, { periodNs: 10 });
  const clockLines = text.split('\n').filter((l) => /^[01]!$/.test(l));
  ok('vcd: the clock toggles twice per cycle', clockLines.length >= doc.frames.length * 2 - 2,
    `${clockLines.length} clock edges for ${doc.frames.length} cycles`);
  ok('vcd: hex bus values survive the trip', text.includes((0x20).toString(2).padStart(32, '0')));
}

/* --------------------------------------------------------- report -- */

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} checks failed:\n`);
  for (const f of failures) console.error(`  \u2717 ${f}`);
  process.exit(1);
}
console.log(`\u2713 ${total} checks passed (${COMBOS.length} protocol configurations)`);
