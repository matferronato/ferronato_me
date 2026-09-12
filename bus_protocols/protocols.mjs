// protocols.mjs — cycle-accurate waveform models.
//
// Every protocol returns the same document shape, so the renderer, the cycle
// inspector and the VCD writer all read one structure and none of them has to
// know anything about the protocol:
//
//   { signals, frames, markers, caption }
//
//   signals  [{ name, kind, by, group, def }]
//              kind  'clock' | 'bit' | 'bus'
//              by    'M' driven by the manager/controller/source
//                    'S' driven by the subordinate/target/sink
//                    'shared' driver changes cycle by cycle
//   frames   one entry per clock cycle:
//              { phase, note, v: { SIGNAL: value } }
//            a value is 0 | 1 | 'z' | 'x' | '0x20' | { v, by, mid }
//            signals absent from a frame fall back to their default
//   markers  [{ frame, signal, kind, text }]  kind 'transfer' | 'sample'
//
// No DOM here, so `node tests.mjs` exercises exactly what the page draws.

export const hex = (n, digits = 4) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;

/* ------------------------------------------------------------------ *
 * AXI burst addressing
 * ------------------------------------------------------------------ */

// size is log2(bytes per beat); len is the number of beats (AxLEN + 1).
export function burstAddress(base, beat, size, type, len) {
  const bytes = 1 << size;
  if (type === 'FIXED') return base;
  if (type === 'INCR') return beat === 0 ? base : Math.floor(base / bytes) * bytes + beat * bytes;
  const total = bytes * len;                       // WRAP
  const lower = Math.floor(base / total) * total;
  return lower + ((base - lower + beat * bytes) % total);
}

/* ------------------------------------------------------------------ *
 * APB
 * ------------------------------------------------------------------ */

function apb({ transaction = 'write', wait = 0 }) {
  const write = transaction === 'write';
  const signals = [
    { name: 'PCLK', kind: 'clock' },
    { name: 'PSEL', kind: 'bit', by: 'M' },
    { name: 'PENABLE', kind: 'bit', by: 'M' },
    { name: 'PWRITE', kind: 'bit', by: 'M' },
    { name: 'PADDR', kind: 'bus', by: 'M' },
    ...(write ? [{ name: 'PWDATA', kind: 'bus', by: 'M' }] : [{ name: 'PRDATA', kind: 'bus', by: 'S' }]),
    { name: 'PREADY', kind: 'bit', by: 'S' },
  ];
  const hold = { PSEL: 1, PWRITE: write ? 1 : 0, PADDR: hex(0x20) };
  const frames = [
    { phase: 'IDLE', note: 'Nothing selected. PSEL is low, so the peripheral ignores the bus and PREADY means nothing.', v: { PREADY: 'x' } },
    {
      phase: 'SETUP',
      note: 'PSEL goes high with address and control valid. PENABLE stays low for exactly this one cycle, which is what makes a transfer recognisable without decoding anything else.',
      v: { ...hold, PENABLE: 0, PREADY: 'x', ...(write ? { PWDATA: hex(0xa5, 2) } : {}) },
    },
  ];
  for (let i = 0; i < wait; i++) {
    frames.push({
      phase: 'ACCESS',
      note: `Wait state ${i + 1}. PENABLE is high and everything is held stable, but PREADY is low so the transfer has not happened yet. The manager cannot withdraw the request.`,
      v: { ...hold, PENABLE: 1, PREADY: 0, ...(write ? { PWDATA: hex(0xa5, 2) } : {}) },
    });
  }
  frames.push({
    phase: 'ACCESS',
    note: write
      ? 'PREADY is high, so the write completes on this clock edge. Address, control and write data were stable for the whole access phase.'
      : 'PREADY is high and PRDATA is valid, so the manager captures read data on this clock edge.',
    v: {
      ...hold, PENABLE: 1, PREADY: 1,
      ...(write ? { PWDATA: hex(0xa5, 2) } : { PRDATA: hex(0x5a, 2) }),
    },
  });
  frames.push({ phase: 'IDLE', note: 'Bus returns to idle. A back-to-back access would skip this cycle and go straight to the next SETUP.', v: { PREADY: 'x' } });

  return {
    signals,
    frames,
    markers: [{ frame: frames.length - 2, signal: 'PREADY', kind: 'transfer', text: 'transfer' }],
    caption: `APB ${transaction} with ${wait} wait state${wait === 1 ? '' : 's'}. Two phases per transfer, no pipelining, no overlap.`,
  };
}

/* ------------------------------------------------------------------ *
 * AHB-Lite — the pipelined middle ground
 * ------------------------------------------------------------------ */

function ahb({ transaction = 'write', wait = 0, beats = 4 }) {
  const write = transaction === 'write';
  const signals = [
    { name: 'HCLK', kind: 'clock' },
    { name: 'HTRANS', kind: 'bus', by: 'M' },
    { name: 'HADDR', kind: 'bus', by: 'M' },
    { name: 'HWRITE', kind: 'bit', by: 'M' },
    { name: 'HSIZE', kind: 'bus', by: 'M' },
    ...(write ? [{ name: 'HWDATA', kind: 'bus', by: 'M' }] : [{ name: 'HRDATA', kind: 'bus', by: 'S' }]),
    { name: 'HREADY', kind: 'bit', by: 'S' },
    { name: 'HRESP', kind: 'bit', by: 'S' },
  ];
  const base = 0x1000;
  const frames = [{ phase: 'IDLE', note: 'HTRANS is IDLE. HREADY high means the previous transfer, if any, has finished.', v: { HTRANS: 'IDLE', HREADY: 1 } }];
  const markers = [];

  // Address phase of beat n overlaps the data phase of beat n-1. Wait states
  // stretch both at once, which is the whole point of the design.
  for (let beat = 0; beat <= beats; beat++) {
    const addrBeat = beat < beats ? beat : null;
    const dataBeat = beat > 0 ? beat - 1 : null;
    const waits = beat === 1 ? wait : 0;
    for (let w = 0; w <= waits; w++) {
      const ready = w === waits ? 1 : 0;
      const v = { HREADY: ready, HRESP: 0 };
      if (addrBeat !== null) {
        v.HTRANS = addrBeat === 0 ? 'NONSEQ' : 'SEQ';
        v.HADDR = hex(base + addrBeat * 4);
        v.HWRITE = write ? 1 : 0;
        v.HSIZE = 'word';
      } else {
        v.HTRANS = 'IDLE';
      }
      if (dataBeat !== null) {
        if (write) v.HWDATA = hex(0xd0 + dataBeat, 2);
        else if (ready) v.HRDATA = hex(0xa0 + dataBeat, 2);
      }
      const parts = [];
      if (addrBeat !== null) parts.push(`address phase of beat ${addrBeat + 1}`);
      if (dataBeat !== null) parts.push(`data phase of beat ${dataBeat + 1}`);
      frames.push({
        phase: ready ? (addrBeat !== null ? (addrBeat === 0 ? 'NONSEQ' : 'SEQ') : 'DATA') : 'WAIT',
        note: ready
          ? `${parts.join(' and ')}. HREADY is high, so both complete together on this edge and the pipeline advances.`
          : `${parts.join(' and ')} are both stretched: HREADY is low, so the address the manager is presenting must be held as well as the data.`,
        v,
      });
      if (ready && dataBeat !== null) {
        markers.push({ frame: frames.length - 1, signal: 'HREADY', kind: 'transfer', text: `beat ${dataBeat + 1}` });
      }
    }
  }
  frames.push({ phase: 'IDLE', note: 'Burst complete.', v: { HTRANS: 'IDLE', HREADY: 1 } });

  return {
    signals,
    frames,
    markers,
    caption: `AHB-Lite ${beats}-beat incrementing ${transaction}${wait ? `, ${wait} wait state${wait === 1 ? '' : 's'} in the first data phase` : ''}. Address and data phases overlap by one cycle.`,
  };
}

/* ------------------------------------------------------------------ *
 * AXI4 and AXI4-Lite
 * ------------------------------------------------------------------ */

function axi({ transaction = 'write', wait = 0, beats = 4, burst = 'INCR', lite = false }) {
  const write = transaction === 'write';
  const n = lite ? 1 : beats;
  const size = 2;                       // 4 bytes per beat
  const base = burst === 'WRAP' && !lite ? 0x1004 : 0x1000;
  const clock = { name: 'ACLK', kind: 'clock' };
  const signals = write
    ? [clock,
      { name: 'AWVALID', kind: 'bit', by: 'M', group: 'AW' },
      { name: 'AWREADY', kind: 'bit', by: 'S', group: 'AW' },
      { name: 'AWADDR', kind: 'bus', by: 'M', group: 'AW' },
      ...(lite ? [] : [
        { name: 'AWSIZE', kind: 'bus', by: 'M', group: 'AW' },
        { name: 'AWLEN', kind: 'bus', by: 'M', group: 'AW' },
        { name: 'AWBURST', kind: 'bus', by: 'M', group: 'AW' }]),
      { name: 'WVALID', kind: 'bit', by: 'M', group: 'W' },
      { name: 'WREADY', kind: 'bit', by: 'S', group: 'W' },
      { name: 'WDATA', kind: 'bus', by: 'M', group: 'W' },
      { name: 'WSTRB', kind: 'bus', by: 'M', group: 'W' },
      ...(lite ? [] : [{ name: 'WLAST', kind: 'bit', by: 'M', group: 'W' }]),
      { name: 'BVALID', kind: 'bit', by: 'S', group: 'B' },
      { name: 'BREADY', kind: 'bit', by: 'M', group: 'B' },
      { name: 'BRESP', kind: 'bus', by: 'S', group: 'B' }]
    : [clock,
      { name: 'ARVALID', kind: 'bit', by: 'M', group: 'AR' },
      { name: 'ARREADY', kind: 'bit', by: 'S', group: 'AR' },
      { name: 'ARADDR', kind: 'bus', by: 'M', group: 'AR' },
      ...(lite ? [] : [
        { name: 'ARSIZE', kind: 'bus', by: 'M', group: 'AR' },
        { name: 'ARLEN', kind: 'bus', by: 'M', group: 'AR' },
        { name: 'ARBURST', kind: 'bus', by: 'M', group: 'AR' }]),
      { name: 'RVALID', kind: 'bit', by: 'S', group: 'R' },
      { name: 'RREADY', kind: 'bit', by: 'M', group: 'R' },
      { name: 'RDATA', kind: 'bus', by: 'S', group: 'R' },
      { name: 'RRESP', kind: 'bus', by: 'S', group: 'R' },
      ...(lite ? [] : [{ name: 'RLAST', kind: 'bit', by: 'S', group: 'R' }])];

  const frames = [];
  const markers = [];
  const push = (phase, note, v) => { frames.push({ phase, note, v }); return frames.length - 1; };

  push('IDLE', 'All VALID signals low. Every channel is independent, so nothing here implies an order.', {});

  const addrPrefix = write ? 'AW' : 'AR';
  const addrText = {
    [`${addrPrefix}ADDR`]: hex(base),
    ...(lite ? {} : { [`${addrPrefix}SIZE`]: String(size), [`${addrPrefix}LEN`]: String(n - 1), [`${addrPrefix}BURST`]: burst }),
  };

  if (write) {
    // AW and W run concurrently: the manager does not wait for the address to
    // be accepted before offering data.
    let f = 0;
    let beat = 0;
    let awDone = false;
    const stallBeat = wait ? Math.min(1, n - 1) : -1;
    let guard = 0;
    while ((!awDone || beat < n) && guard++ < 60) {
      const awReady = f >= wait;
      const stalling = beat === stallBeat && f < wait + 2;
      const wReady = !stalling;
      const v = {};
      // Once the address has been accepted the AW channel is released; holding
      // the address across the whole burst is a common way to draw this and a
      // wrong one.
      if (!awDone) { v.AWVALID = 1; v.AWREADY = awReady ? 1 : 0; Object.assign(v, addrText); }
      if (beat < n) {
        v.WVALID = 1;
        v.WREADY = wReady ? 1 : 0;
        v.WDATA = hex(0xd0 + beat, 2);
        v.WSTRB = '0xF';
        if (!lite) v.WLAST = beat === n - 1 ? 1 : 0;
      }
      const notes = [];
      if (!awDone) notes.push(awReady
        ? 'AWVALID and AWREADY are both high, so the address is accepted on this edge.'
        : 'AWVALID is high but the subordinate has not raised AWREADY, so the manager must hold the address unchanged.');
      if (beat < n) notes.push(wReady
        ? `Write data beat ${beat + 1} of ${n} transfers on this edge.`
        : `Backpressure: WREADY is low, so beat ${beat + 1} stays on the bus until the subordinate can take it.`);
      const idx = push(awDone ? 'W' : 'AW + W', notes.join(' '), v);
      if (!awDone && awReady) { markers.push({ frame: idx, signal: 'AWREADY', kind: 'transfer', text: 'address' }); awDone = true; }
      if (beat < n && wReady) { markers.push({ frame: idx, signal: 'WREADY', kind: 'transfer', text: `beat ${beat + 1}` }); beat++; }
      f++;
    }
    const b = push('B', 'The subordinate answers on the write response channel. This is a separate channel, so it can arrive several cycles after the last data beat.',
      { BVALID: 1, BREADY: 1, BRESP: 'OKAY' });
    markers.push({ frame: b, signal: 'BVALID', kind: 'transfer', text: 'response' });
  } else {
    for (let w = 0; w < wait; w++) {
      push('AR', 'ARVALID is high, ARREADY is not. The manager holds the address and burst attributes unchanged.',
        { ARVALID: 1, ARREADY: 0, ...addrText });
    }
    const a = push('AR', 'Address handshake completes. From here the read data channel runs on its own.',
      { ARVALID: 1, ARREADY: 1, ...addrText });
    markers.push({ frame: a, signal: 'ARREADY', kind: 'transfer', text: 'address' });
    push('gap', 'Read latency. The subordinate is fetching; RVALID is still low and nothing is lost.', {});
    for (let i = 0; i < n; i++) {
      const addr = burstAddress(base, i, size, burst, n);
      const idx = push('R', `Read data beat ${i + 1} of ${n} for address ${hex(addr)}.${!lite && i === n - 1 ? ' RLAST marks the end of the burst.' : ''}`, {
        RVALID: 1, RREADY: 1, RDATA: hex(0xa0 + i, 2), RRESP: 'OKAY',
        ...(lite ? {} : { RLAST: i === n - 1 ? 1 : 0 }),
      });
      markers.push({ frame: idx, signal: 'RVALID', kind: 'transfer', text: `beat ${i + 1}` });
    }
  }
  push('IDLE', 'Channels idle.', {});

  const addresses = Array.from({ length: n }, (_, i) => burstAddress(base, i, size, burst, n));
  return {
    signals,
    frames,
    markers,
    addresses,
    caption: lite
      ? `AXI4-Lite ${transaction}: the five-channel handshake with single-beat transfers only.`
      : `AXI4 ${transaction}, ${n} beats, ${burst}, 4 bytes per beat. Addresses: ${addresses.map((a) => hex(a)).join(', ')}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Streaming — AXI-Stream and Avalon-ST
 * ------------------------------------------------------------------ */

function stream({ beats = 4, wait = 0, avalon = false }) {
  const nm = avalon
    ? { valid: 'valid', ready: 'ready', data: 'data', first: 'startofpacket', last: 'endofpacket' }
    : { valid: 'TVALID', ready: 'TREADY', data: 'TDATA', keep: 'TKEEP', last: 'TLAST' };
  const signals = [
    { name: avalon ? 'clk' : 'ACLK', kind: 'clock' },
    { name: nm.valid, kind: 'bit', by: 'M' },
    { name: nm.ready, kind: 'bit', by: 'S' },
    { name: nm.data, kind: 'bus', by: 'M' },
    ...(avalon ? [{ name: nm.first, kind: 'bit', by: 'M' }] : [{ name: nm.keep, kind: 'bus', by: 'M' }]),
    { name: nm.last, kind: 'bit', by: 'M' },
  ];
  const frames = [{ phase: 'idle', note: 'Source has nothing to send.', v: {} }];
  const markers = [];
  const sinkStall = wait ? 1 : -1;         // sink deasserts ready on this beat
  const sourceGap = beats > 2 ? 2 : -1;    // source has no data for one cycle

  for (let beat = 0; beat < beats; beat++) {
    if (beat === sourceGap) {
      frames.push({
        phase: 'bubble',
        note: 'The source has no data this cycle, so valid is low. The sink simply waits; nothing is lost and no beat is skipped.',
        v: { [nm.ready]: 1 },
      });
    }
    for (let w = 0; w <= (beat === sinkStall ? wait : 0); w++) {
      const ready = w === (beat === sinkStall ? wait : 0);
      const v = {
        [nm.valid]: 1, [nm.ready]: ready ? 1 : 0,
        [nm.data]: hex(0xd0 + beat, 2),
        [nm.last]: beat === beats - 1 ? 1 : 0,
      };
      if (avalon) v[nm.first] = beat === 0 ? 1 : 0; else v[nm.keep] = '0xF';
      frames.push({
        phase: ready ? `beat ${beat + 1}` : 'stalled',
        note: ready
          ? `Both ${nm.valid} and ${nm.ready} are high, so beat ${beat + 1} of ${beats} transfers on this edge.${beat === beats - 1 ? ` ${nm.last} marks the end of the packet.` : ''}`
          : `The sink has dropped ${nm.ready}. Once ${nm.valid} is high the source may not withdraw it, so the beat is held until the sink is ready.`,
        v,
      });
      if (ready) markers.push({ frame: frames.length - 1, signal: nm.ready, kind: 'transfer', text: `beat ${beat + 1}` });
    }
  }
  frames.push({ phase: 'idle', note: 'Packet complete.', v: {} });

  return {
    signals,
    frames,
    markers,
    caption: `${avalon ? 'Avalon-ST' : 'AXI4-Stream'} packet of ${beats} beats with a source bubble and ${wait ? 'sink backpressure' : 'no backpressure'}. Only the cycles where both handshake signals are high move data.`,
  };
}

/* ------------------------------------------------------------------ *
 * Avalon-MM
 * ------------------------------------------------------------------ */

function avmm({ transaction = 'write', wait = 0 }) {
  const write = transaction === 'write';
  const signals = [
    { name: 'clk', kind: 'clock' },
    { name: 'address', kind: 'bus', by: 'M' },
    { name: write ? 'write' : 'read', kind: 'bit', by: 'M' },
    ...(write ? [{ name: 'writedata', kind: 'bus', by: 'M' }] : []),
    { name: 'waitrequest', kind: 'bit', by: 'S' },
    ...(write ? [] : [
      { name: 'readdatavalid', kind: 'bit', by: 'S' },
      { name: 'readdata', kind: 'bus', by: 'S' }]),
  ];
  const frames = [{ phase: 'idle', note: 'No command asserted.', v: { waitrequest: 0 } }];
  const markers = [];
  const cmd = write ? 'write' : 'read';

  for (let w = 0; w < wait; w++) {
    frames.push({
      phase: 'stalled',
      note: 'waitrequest is high, so the command has not been accepted. Address, command and write data must all be held exactly as they are.',
      v: { address: hex(0x40), [cmd]: 1, waitrequest: 1, ...(write ? { writedata: hex(0xa5, 2) } : {}) },
    });
  }
  const accept = frames.length;
  frames.push({
    phase: 'accepted',
    note: 'waitrequest is low on the rising edge, so the command is accepted this cycle.',
    v: { address: hex(0x40), [cmd]: 1, waitrequest: 0, ...(write ? { writedata: hex(0xa5, 2) } : {}) },
  });
  markers.push({ frame: accept, signal: 'waitrequest', kind: 'transfer', text: 'command accepted' });

  if (!write) {
    frames.push({ phase: 'latency', note: 'Read latency. The command is gone from the bus and nothing marks the pending read except the subordinate\'s own bookkeeping.', v: { waitrequest: 0 } });
    frames.push({ phase: 'data', note: 'readdatavalid marks the cycle that actually carries read data. It is a separate signal precisely because the delay is not fixed.', v: { waitrequest: 0, readdatavalid: 1, readdata: hex(0x5a, 2) } });
    markers.push({ frame: frames.length - 1, signal: 'readdatavalid', kind: 'transfer', text: 'read data' });
  }
  frames.push({ phase: 'idle', note: 'Idle.', v: { waitrequest: 0 } });

  return {
    signals, frames, markers,
    caption: `Avalon-MM ${transaction} with ${wait} wait cycle${wait === 1 ? '' : 's'}. Acceptance is negotiated with waitrequest; read data returns later on its own signal.`,
  };
}

/* ------------------------------------------------------------------ *
 * Wishbone classic
 * ------------------------------------------------------------------ */

function wishbone({ transaction = 'write', wait = 0 }) {
  const write = transaction === 'write';
  const signals = [
    { name: 'CLK_I', kind: 'clock' },
    { name: 'CYC_O', kind: 'bit', by: 'M' },
    { name: 'STB_O', kind: 'bit', by: 'M' },
    { name: 'WE_O', kind: 'bit', by: 'M' },
    { name: 'ADR_O', kind: 'bus', by: 'M' },
    ...(write ? [{ name: 'DAT_O', kind: 'bus', by: 'M' }] : [{ name: 'DAT_I', kind: 'bus', by: 'S' }]),
    { name: 'ACK_I', kind: 'bit', by: 'S' },
  ];
  const hold = { CYC_O: 1, STB_O: 1, WE_O: write ? 1 : 0, ADR_O: hex(0x08), ...(write ? { DAT_O: hex(0xa5, 2) } : {}) };
  const frames = [{ phase: 'idle', note: 'Bus cycle not started.', v: {} }];
  const markers = [];
  for (let w = 0; w < wait; w++) {
    frames.push({ phase: 'wait', note: 'CYC and STB are asserted, ACK has not come back, so the cycle simply extends. Wishbone has no fixed timeout: the pair holds until the slave answers.', v: hold });
  }
  frames.push({
    phase: 'ack',
    note: write ? 'ACK_I is high, so the slave has taken the data and the cycle terminates on this edge.'
      : 'ACK_I is high and DAT_I is valid, so the master samples read data on this edge.',
    v: { ...hold, ACK_I: 1, ...(write ? {} : { DAT_I: hex(0x5a, 2) }) },
  });
  markers.push({ frame: frames.length - 1, signal: 'ACK_I', kind: 'transfer', text: 'terminated' });
  frames.push({ phase: 'idle', note: 'CYC and STB drop. A block cycle would hold CYC high and issue another STB.', v: {} });

  return {
    signals, frames, markers,
    caption: `Wishbone classic single ${transaction} with ${wait} wait cycle${wait === 1 ? '' : 's'}. One handshake pair, terminated by ACK.`,
  };
}

/* ------------------------------------------------------------------ *
 * I2C — sub-bit detail, open drain, driver changes hands
 * ------------------------------------------------------------------ */

function i2c({ transaction = 'write', stretch = false }) {
  const read = transaction === 'read';
  const signals = [
    { name: 'SCL', kind: 'clock', by: 'shared' },
    { name: 'SDA', kind: 'bit', by: 'shared' },
    { name: 'field', kind: 'bus', by: 'shared' },
  ];
  const frames = [];
  const markers = [];
  const bit = (name, v, by, field, note, clk = 'pulse') =>
    frames.push({ phase: name, note, v: { SCL: clk, SDA: { v, by }, field: { v: field, by } } });

  frames.push({ phase: 'idle', note: 'Both lines are released. The pull-up resistors hold them high, which is what idle means on an open-drain bus.', v: { SCL: 'high', SDA: { v: 1, by: 'none' }, field: 'idle' } });
  frames.push({
    phase: 'START',
    note: 'SDA falls while SCL is high. Data is only allowed to change while SCL is low, so this violation is unambiguous and every device on the bus recognises it as the start of a transaction.',
    v: { SCL: 'high', SDA: { v: 0, by: 'M', mid: true }, field: { v: 'START', by: 'M' } },
  });
  markers.push({ frame: frames.length - 1, signal: 'SDA', kind: 'transfer', text: 'start condition' });

  const addr = 0x50;
  for (let i = 6; i >= 0; i--) {
    bit(`A${i}`, (addr >> i) & 1, 'M', 'address 0x50',
      `Address bit ${i}, most significant first. The controller changes SDA while SCL is low and holds it steady for the whole high period.`);
  }
  bit('R/W', read ? 1 : 0, 'M', read ? 'read' : 'write',
    `The eighth bit is direction: ${read ? '1 asks the target to drive data' : '0 means the controller will send data'}.`);
  bit('ACK', 0, 'S', 'ACK',
    'The controller releases SDA and the addressed target pulls it low. A high here would mean nobody answered.');
  markers.push({ frame: frames.length - 1, signal: 'SDA', kind: 'transfer', text: 'target acknowledges' });

  if (stretch) {
    frames.push({
      phase: 'stretch',
      note: 'Clock stretching: the target holds SCL low after the acknowledge because it is not ready for the next bit. The controller must wait until the line goes high again.',
      v: { SCL: 'low', SDA: { v: 'z', by: 'none' }, field: { v: 'target stretching SCL', by: 'S' } },
    });
  }

  const data = 0xa5;
  for (let i = 7; i >= 0; i--) {
    bit(`D${i}`, (data >> i) & 1, read ? 'S' : 'M', 'data 0xA5',
      read ? `Data bit ${i}, driven by the target now that direction has been handed over.`
        : `Data bit ${i}, driven by the controller.`);
  }
  bit(read ? 'NACK' : 'ACK', read ? 1 : 0, read ? 'M' : 'S', read ? 'NACK' : 'ACK',
    read ? 'The controller leaves SDA high to say it wants no more bytes. On I2C, not acknowledging is how a read is ended politely.'
      : 'The target pulls SDA low to confirm it took the byte.');

  frames.push({
    phase: 'STOP',
    note: 'SCL is released high and then SDA rises. The second reserved violation, and the bus is free again.',
    v: { SCL: 'high', SDA: { v: 1, by: 'M', mid: true }, field: { v: 'STOP', by: 'M' } },
  });
  markers.push({ frame: frames.length - 1, signal: 'SDA', kind: 'transfer', text: 'stop condition' });

  return {
    signals, frames, markers,
    caption: `I2C ${transaction} of one byte at target address 0x50${stretch ? ', with the target stretching the clock' : ''}. Colour shows which device is pulling the line low.`,
  };
}

/* ------------------------------------------------------------------ *
 * SPI — all four clock modes
 * ------------------------------------------------------------------ */

function spi({ cpol = 0, cpha = 0 }) {
  const signals = [
    { name: 'SCLK', kind: 'clock', polarity: cpol },
    { name: 'CS_n', kind: 'bit', by: 'M' },
    { name: 'MOSI', kind: 'bus', by: 'M', noMerge: true },
    { name: 'MISO', kind: 'bus', by: 'S', noMerge: true },
  ];
  const tx = 0x9c;
  const rx = 0x3d;
  const frames = [
    { phase: 'idle', note: `Chip select is high and the clock idles ${cpol ? 'high' : 'low'} because CPOL is ${cpol}.`, v: { CS_n: 1, SCLK: cpol ? 'high' : 'low', MOSI: null, MISO: null } },
    {
      phase: 'select',
      note: cpha === 0
        ? 'CS falls. With CPHA 0 the first data bit must already be on the wire before the first clock edge, so both sides drive it here.'
        : 'CS falls. With CPHA 1 the first bit is launched by the leading clock edge, so the lines can stay idle for now.',
      v: { CS_n: 0, SCLK: cpol ? 'high' : 'low', ...(cpha === 0 ? { MOSI: 'bit 7', MISO: 'bit 7' } : {}) },
    },
  ];
  const markers = [];
  for (let i = 7; i >= 0; i--) {
    frames.push({
      phase: `bit ${i}`,
      note: `One clock period. The ${cpha === 0 ? 'leading' : 'trailing'} edge samples, the other edge shifts the next bit out. `
        + `MOSI carries ${(tx >> i) & 1}, MISO returns ${(rx >> i) & 1}; both directions move on the same clock, which is what full duplex means here.`,
      v: {
        CS_n: 0, SCLK: 'pulse',
        MOSI: `${(tx >> i) & 1}`,
        MISO: `${(rx >> i) & 1}`,
      },
    });
    markers.push({ frame: frames.length - 1, signal: 'SCLK', kind: 'sample', text: `sample bit ${i}`, edge: cpha === 0 ? 'leading' : 'trailing' });
  }
  frames.push({ phase: 'release', note: 'CS returns high, ending the frame. What those eight bits meant is defined by the peripheral, not by SPI.', v: { CS_n: 1, SCLK: cpol ? 'high' : 'low' } });

  return {
    signals, frames, markers,
    caption: `SPI mode ${cpol * 2 + cpha} (CPOL ${cpol}, CPHA ${cpha}), one byte each way. Triangles mark the sampling edge.`,
  };
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

export const PROTOCOLS = {
  apb: {
    id: 'apb', name: 'APB', family: 'AMBA', kind: 'Memory mapped',
    blurb: 'Two-phase register access with the smallest possible slave.',
    summary: 'APB exists to make peripheral registers cheap. One transfer is a setup cycle followed by an access cycle held open until PREADY, with no pipelining and nothing outstanding. If a peripheral only has a handful of registers, this is usually the right answer.',
    build: apb,
    options: { transactions: ['write', 'read'], wait: 4 },
    attrs: { type: 'Memory mapped', accept: 'PREADY', pipelining: 'None', bursts: 'No', outstanding: 'No', ordering: 'One at a time', signals: '~7', cost: 'Very low' },
    fit: [
      ['Reach for it', 'Control and status registers', 'UART, timers, GPIO, watchdogs, anything with a small register map.'],
      ['Strength', 'Almost no logic', 'A slave is a small state machine and an address decoder.'],
      ['Cost', 'Two cycles per access, minimum', 'Fine for configuration, hopeless as a data path.'],
      ['Watch for', 'PENABLE timing', 'The setup cycle is exactly one cycle. Registering PSEL without care breaks that.'],
    ],
  },
  ahb: {
    id: 'ahb', name: 'AHB-Lite', family: 'AMBA', kind: 'Memory mapped',
    blurb: 'Pipelined address and data phases, one transfer in flight.',
    summary: 'AHB-Lite overlaps the address phase of one beat with the data phase of the one before it, so a burst moves a word per cycle without needing separate channels. HREADY stretches both phases at once, which is the detail that catches people out.',
    build: ahb,
    options: { transactions: ['write', 'read'], wait: 3, beats: [1, 8] },
    attrs: { type: 'Memory mapped', accept: 'HREADY', pipelining: 'Address over data', bursts: 'Yes, HBURST', outstanding: 'No', ordering: 'Strict', signals: '~10', cost: 'Low' },
    fit: [
      ['Reach for it', 'Microcontroller main bus', 'Instruction and data fetch for small cores, on-chip SRAM and flash.'],
      ['Strength', 'Throughput without channels', 'One word per cycle in a burst, from far simpler logic than AXI.'],
      ['Cost', 'One transfer in flight', 'A slow slave stalls the whole bus, because HREADY is shared.'],
      ['Watch for', 'The held address', 'When HREADY is low, the address you are presenting must not move either.'],
    ],
  },
  axil: {
    id: 'axil', name: 'AXI4-Lite', family: 'AMBA', kind: 'Memory mapped',
    blurb: 'The AXI channel structure, single beats only.',
    summary: 'AXI4-Lite keeps the five independent channels and the VALID/READY rule but forbids bursts and IDs. It costs more logic than APB for the same register map, and it is worth it when everything else in the design already speaks AXI.',
    build: (o) => axi({ ...o, lite: true }),
    options: { transactions: ['write', 'read'], wait: 4 },
    attrs: { type: 'Memory mapped', accept: 'VALID/READY per channel', pipelining: 'Channels are independent', bursts: 'No', outstanding: 'Implementation defined', ordering: 'Responses in order', signals: '~20', cost: 'Moderate' },
    fit: [
      ['Reach for it', 'FPGA register maps', 'The control plane beside an AXI-Stream data path.'],
      ['Strength', 'It plugs in', 'Interconnect, address decoders and verification IP already exist for it.'],
      ['Cost', 'Five channels for one register', 'More logic and more state than APB does the same job with.'],
      ['Watch for', 'AW and W are independent', 'Write data can arrive before the address. A slave that assumes otherwise will deadlock.'],
    ],
  },
  axi4: {
    id: 'axi4', name: 'AXI4', family: 'AMBA', kind: 'Memory mapped',
    blurb: 'Five channels, bursts to 256 beats, multiple transactions in flight.',
    summary: 'AXI4 splits address, data and response into channels that progress independently, so reads and writes overlap and several transactions can be outstanding at once under different IDs. It is the interface to reach for when bandwidth matters and the one to avoid when it does not.',
    build: axi,
    options: { transactions: ['write', 'read'], wait: 4, beats: [1, 8], burst: ['INCR', 'WRAP', 'FIXED'] },
    attrs: { type: 'Memory mapped', accept: 'VALID/READY per channel', pipelining: 'Full, per channel', bursts: 'Yes, to 256 beats', outstanding: 'Yes, tagged by ID', ordering: 'Per ID', signals: '~40', cost: 'High' },
    fit: [
      ['Reach for it', 'Memory bandwidth', 'DRAM controllers, DMA engines, caches, accelerator data paths.'],
      ['Strength', 'Overlap', 'Independent channels and IDs keep the bus busy while memory is slow.'],
      ['Cost', 'Verification effort', 'Ordering rules, buffering and deadlock avoidance are all on you.'],
      ['Watch for', 'AxLEN is beats minus one', 'And WRAP allows 2, 4, 8 or 16 beats and requires beat-aligned starts.'],
    ],
  },
  axis: {
    id: 'axis', name: 'AXI4-Stream', family: 'AMBA', kind: 'Streaming',
    blurb: 'No addresses. Beats move when both sides agree.',
    summary: 'AXI4-Stream carries ordered beats rather than addressed words. A beat transfers on any edge where TVALID and TREADY are both high, TLAST marks a packet boundary, and once TVALID is high it cannot be withdrawn. That single rule is what makes register slices and FIFOs safe to drop in anywhere.',
    build: stream,
    options: { wait: 3, beats: [1, 8] },
    attrs: { type: 'Streaming', accept: 'TVALID/TREADY', pipelining: 'Inherent', bursts: 'Packets via TLAST', outstanding: 'Not applicable', ordering: 'In order, always', signals: '~5', cost: 'Very low' },
    fit: [
      ['Reach for it', 'Data paths', 'DSP chains, video, packet processing, DMA payload.'],
      ['Strength', 'Composability', 'Any two blocks that speak it can be joined, buffered or pipelined freely.'],
      ['Cost', 'No addressing', 'Configuration needs a separate memory-mapped path.'],
      ['Watch for', 'TVALID must not depend on TREADY', 'Deriving one from the other is the classic stream deadlock.'],
    ],
  },
  avmm: {
    id: 'avmm', name: 'Avalon-MM', family: 'Intel FPGA', kind: 'Memory mapped',
    blurb: 'Request and wait, with read data returning later.',
    summary: 'Avalon-MM is a configurable memory-mapped interface. The manager asserts read or write and holds it while waitrequest is high; read data comes back on readdatavalid, whose latency does not have to be fixed. Most of the protocol is decided by the properties you declare on the interface.',
    build: avmm,
    options: { transactions: ['write', 'read'], wait: 4 },
    attrs: { type: 'Memory mapped', accept: 'waitrequest', pipelining: 'Optional, via readdatavalid', bursts: 'Optional burstcount', outstanding: 'Optional', ordering: 'Typically in order', signals: '~8', cost: 'Low' },
    fit: [
      ['Reach for it', 'Intel FPGA systems', 'Platform Designer components and the IP built around them.'],
      ['Strength', 'Pay for what you use', 'A minimal slave declares few properties and stays simple.'],
      ['Cost', 'Variants', 'Behaviour depends on declared properties, so read the component, not just the signal names.'],
      ['Watch for', 'Held requests', 'While waitrequest is high, address, command and data must not move.'],
    ],
  },
  avst: {
    id: 'avst', name: 'Avalon-ST', family: 'Intel FPGA', kind: 'Streaming',
    blurb: 'Valid and ready streaming with explicit packet edges.',
    summary: 'Avalon-ST is the streaming counterpart to Avalon-MM: valid from the source, ready from the sink, and startofpacket and endofpacket to delimit packets. Ready latency is a declared property rather than a fixed rule, which is the main thing to check before connecting two blocks.',
    build: (o) => stream({ ...o, avalon: true }),
    options: { wait: 3, beats: [1, 8] },
    attrs: { type: 'Streaming', accept: 'valid/ready', pipelining: 'Inherent', bursts: 'Packets via SOP/EOP', outstanding: 'Not applicable', ordering: 'In order, always', signals: '~6', cost: 'Very low' },
    fit: [
      ['Reach for it', 'Intel FPGA data paths', 'Video, packet and DSP pipelines assembled in Platform Designer.'],
      ['Strength', 'Packet metadata', 'Empty, error and channel sidebands are standardised rather than invented per block.'],
      ['Cost', 'Ecosystem specific', 'Most natural inside the Intel tool flow.'],
      ['Watch for', 'Ready latency', 'A non-zero ready latency changes which cycle actually transfers.'],
    ],
  },
  wb: {
    id: 'wb', name: 'Wishbone', family: 'Open', kind: 'Memory mapped',
    blurb: 'One handshake pair, terminated by an acknowledge.',
    summary: 'Wishbone classic is about as small as a memory-mapped bus gets: assert CYC and STB with an address, hold everything until ACK comes back, drop them. It is common in open-source cores because it is public, unencumbered and easy to implement correctly.',
    build: wishbone,
    options: { transactions: ['write', 'read'], wait: 4 },
    attrs: { type: 'Memory mapped', accept: 'ACK_I', pipelining: 'None in classic mode', bursts: 'Block cycles', outstanding: 'No', ordering: 'Strict', signals: '~8', cost: 'Very low' },
    fit: [
      ['Reach for it', 'Open-source cores', 'RISC-V SoCs and IP assembled outside the vendor ecosystems.'],
      ['Strength', 'No licensing questions', 'Public specification, trivially small implementations.'],
      ['Cost', 'A cycle per transfer', 'Classic mode has no pipelining; the pipelined variant fixes that.'],
      ['Watch for', 'CYC versus STB', 'CYC frames the whole bus cycle, STB qualifies each transfer inside it.'],
    ],
  },
  i2c: {
    id: 'i2c', name: 'I2C', family: 'Board level', kind: 'Serial, addressed',
    blurb: 'Two shared wires, addresses in band, acknowledge per byte.',
    summary: 'I2C puts a whole addressed bus on two open-drain wires. START and STOP are reserved bus conditions, data may only change while the clock is low, and every byte is followed by an acknowledge bit driven by the receiver. Slow, but it costs two pins for dozens of devices.',
    build: i2c,
    options: { transactions: ['write', 'read'], stretch: true },
    attrs: { type: 'Serial, addressed', accept: 'ACK per byte', pipelining: 'None', bursts: 'Multi-byte, protocol defined', outstanding: 'No', ordering: 'Strictly serial', signals: '2 shared', cost: 'Very low pin count' },
    fit: [
      ['Reach for it', 'Slow peripherals', 'Sensors, EEPROMs, power management, board configuration.'],
      ['Strength', 'Two wires, many devices', 'Addressing is part of the protocol, so no extra select pins.'],
      ['Cost', 'Speed', 'Open-drain lines and bus capacitance limit the edge rate.'],
      ['Watch for', 'Clock stretching', 'A target may hold SCL low. A controller that cannot cope will corrupt the transfer.'],
    ],
  },
  spi: {
    id: 'spi', name: 'SPI', family: 'Board level', kind: 'Serial, selected',
    blurb: 'Shift register in each direction, framed by chip select.',
    summary: 'SPI is two shift registers clocked together, framed by a chip select. It is fast and electrically simple, with no acknowledge and no addressing. CPOL and CPHA decide which edge launches a bit and which edge samples it, and getting that pair wrong is the classic first-bring-up bug.',
    build: spi,
    options: { spiMode: true },
    attrs: { type: 'Serial, selected', accept: 'None', pipelining: 'Full duplex by nature', bursts: 'Frame defined by CS', outstanding: 'No', ordering: 'Strictly serial', signals: '3 shared + 1 CS per target', cost: 'Low' },
    fit: [
      ['Reach for it', 'Fast board peripherals', 'ADCs, DACs, flash, displays, radios.'],
      ['Strength', 'Throughput', 'Push-pull signalling, no per-byte overhead, tens of megahertz is routine.'],
      ['Cost', 'No standard above the wire', 'Command framing and word size are whatever the device says they are.'],
      ['Watch for', 'CPOL and CPHA', 'Four combinations, and only one of them works with a given peripheral.'],
    ],
  },
};

export const FAMILIES = [
  { name: 'AMBA', ids: ['apb', 'ahb', 'axil', 'axi4', 'axis'] },
  { name: 'Intel FPGA', ids: ['avmm', 'avst'] },
  { name: 'Open', ids: ['wb'] },
  { name: 'Board level', ids: ['i2c', 'spi'] },
];

/* ------------------------------------------------------------------ *
 * Reading a document
 * ------------------------------------------------------------------ */

// Normalised access to one cell. Anything the frame does not mention falls back
// to the signal default: buses go undriven, bits go low.
export function cellAt(doc, signal, frame) {
  const f = doc.frames[frame];
  const raw = f?.v?.[signal.name];
  const fallback = signal.kind === 'bus' ? null : (signal.kind === 'clock' ? 'pulse' : 0);
  const value = raw === undefined ? fallback : raw;
  if (value !== null && typeof value === 'object') {
    return { v: value.v, by: value.by ?? signal.by, mid: !!value.mid };
  }
  return { v: value, by: signal.by, mid: false };
}

export function markersAt(doc, frame) {
  return doc.markers.filter((m) => m.frame === frame);
}

export function build(id, opts = {}) {
  const p = PROTOCOLS[id];
  if (!p) throw new Error(`unknown protocol: ${id}`);
  opts = {...opts};
  if (id === 'axi4' && opts.burst === 'WRAP' && ![2,4,8,16].includes(opts.beats ?? 4)) throw new RangeError('WRAP requires 2, 4, 8 or 16 beats');
  const doc = p.build(opts);
  doc.id = id;
  doc.name = p.name;
  return doc;
}
