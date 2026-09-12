import { PROTOCOLS, FAMILIES, build, cellAt, markersAt } from './protocols.mjs';
import { draw, heightOf, columnWidth } from './waveform.mjs';
import { toVCD } from './vcd.mjs';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const DEFAULTS = {
  id: 'apb', transaction: 'write', wait: 0, beats: 4, burst: 'INCR',
  spiMode: 0, stretch: false, cursor: 1,
};
const state = { ...DEFAULTS };
let doc = null;
let metrics = null;
let playing = false;
let lastTick = 0;

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

function buildDoc() {
  const o = PROTOCOLS[state.id].options;
  state.wait = Math.max(0, Math.min(o.wait ?? 0, Math.round(state.wait)));
  state.beats = Math.max(o.beats?.[0] ?? 1, Math.min(o.beats?.[1] ?? 1, Math.round(state.beats)));
  if (!['INCR','WRAP','FIXED'].includes(state.burst)) state.burst = 'INCR';
  if (state.id === 'axi4' && state.burst === 'WRAP') state.beats = [2,4,8].find(n => n >= state.beats) ?? 8;
  state.spiMode = Math.max(0,Math.min(3,Math.round(state.spiMode)));
  state.cursor = Math.max(0, Math.floor(state.cursor));

  const opts = {
    transaction: state.transaction,
    wait: state.wait,
    beats: state.beats,
    burst: state.burst,
    stretch: state.stretch,
    cpol: state.spiMode >> 1,
    cpha: state.spiMode & 1,
  };
  doc = build(state.id, opts);
  state.cursor = Math.min(state.cursor, doc.frames.length - 1);
  return doc;
}

function colours() {
  const s = getComputedStyle(document.documentElement);
  const g = (n) => s.getPropertyValue(n).trim();
  return {
    paper: g('--figure') || '#fff', grid: g('--rule'), ink: g('--ink'), faint: g('--ink-3'),
    man: g('--man'), sub: g('--sub'), idle: g('--idle'), event: g('--event'),
    clock: g('--clock'), band: g('--band'), cursor: g('--cursor'),
    mono: g('--mono') || 'monospace', sans: g('--sans') || 'sans-serif',
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderIndex() {
  const nav = $('#protocolIndex');
  nav.innerHTML = '';
  for (const fam of FAMILIES) {
    const h = document.createElement('h4');
    h.textContent = fam.name;
    nav.appendChild(h);
    for (const id of fam.ids) {
      const p = PROTOCOLS[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = id;
      b.innerHTML = `${p.name}<small>${p.kind}</small>`;
      b.addEventListener('click', () => selectProtocol(id));
      nav.appendChild(b);
    }
  }
}

function renderToolbar() {
  const p = PROTOCOLS[state.id];
  const o = p.options;

  const show = (sel, on) => { $(sel).hidden = !on; };
  show('#toolTransaction', !!o.transactions);
  show('#toolWait', o.wait !== undefined);
  show('#toolBeats', !!o.beats);
  show('#toolBurst', !!o.burst);
  show('#toolMode', !!o.spiMode);
  show('#toolStretch', !!o.stretch);

  if (o.transactions) {
    const sel = $('#transaction');
    sel.innerHTML = o.transactions
      .map((t) => `<option value="${t}"${t === state.transaction ? ' selected' : ''}>${t[0].toUpperCase()}${t.slice(1)}</option>`)
      .join('');
  }
  if (o.wait !== undefined) {
    $('#wait').max = String(o.wait);
    $('#wait').value = String(Math.min(state.wait, o.wait));
    state.wait = Number($('#wait').value);
    $('#waitOut').value = state.wait;
  }
  if (o.beats) {
    $('#beats').min = String(o.beats[0]);
    $('#beats').max = String(o.beats[1]);
    $('#beats').value = String(state.beats);
    $('#beatsOut').value = state.beats;
  }
  if (o.burst) $('#burst').value = state.burst;
  if (o.spiMode) $('#spiMode').value = String(state.spiMode);
  if (o.stretch) $('#stretch').checked = state.stretch;
}

function renderStage() {
  const p = PROTOCOLS[state.id];
  $$('.index button').forEach((b) => b.classList.toggle('is-on', b.dataset.id === state.id));
  $('#protoName').textContent = p.name;
  $('#protoKind').textContent = `${p.family}, ${p.kind.toLowerCase()}. ${p.blurb}`;
  $('#protoSummary').textContent = p.summary;
  $('#caption').textContent = doc.caption;
  $('#fitList').innerHTML = p.fit
    .map(([role, title, body]) => `<div><dt>${title}<small>${role}</small></dt><dd>${body}</dd></div>`)
    .join('');
}

function renderDiagram() {
  const canvas = $('#wave');
  const scroller = $('#scroller');
  canvas.style.width = `${scroller.clientWidth}px`;
  metrics = draw(canvas, doc, { cursor: state.cursor, colours: colours() });
  canvas.setAttribute('aria-label',
    `${doc.name} timing diagram, ${doc.frames.length} cycles, currently showing cycle ${state.cursor + 1}`);
  // keep the cursor in view while stepping or playing
  const left = metrics.x0 + state.cursor * metrics.colW;
  if (left < scroller.scrollLeft + metrics.x0) scroller.scrollLeft = Math.max(0, left - metrics.x0 - metrics.colW);
  if (left + metrics.colW > scroller.scrollLeft + scroller.clientWidth) {
    scroller.scrollLeft = left + metrics.colW - scroller.clientWidth + 20;
  }
}

function renderInspector() {
  const f = doc.frames[state.cursor];
  if (!f) return;
  $('#cycleTitle').textContent = `Cycle ${state.cursor + 1} of ${doc.frames.length}`;
  $('#cyclePhase').textContent = f.phase;

  const marks = markersAt(doc, state.cursor);
  const suffix = marks.length
    ? ` The edge at the end of this cycle captures: ${marks.map((m) => m.text).join(', ')}.`
    : '';
  $('#cycleNote').textContent = f.note + suffix;

  const body = $('#values tbody');
  body.innerHTML = doc.signals
    .filter((s) => s.kind !== 'clock')
    .map((s) => {
      const cell = cellAt(doc, s, state.cursor);
      const driven = cell.v === null || cell.v === 'z' || cell.by === 'none';
      const cls = driven ? 'v-idle' : cell.by === 'S' ? 'v-sub' : 'v-man';
      const value = cell.v === null ? '\u2014' : String(cell.v);
      const who = driven ? 'nobody' : cell.by === 'S' ? subordinateWord() : managerWord();
      return `<tr><td>${s.name}</td><td class="${cls}">${value}</td><td>${who}</td></tr>`;
    })
    .join('');
}

const managerWord = () => (state.id === 'i2c' || state.id === 'spi' ? 'controller'
  : state.id === 'axis' || state.id === 'avst' ? 'source' : 'manager');
const subordinateWord = () => (state.id === 'i2c' || state.id === 'spi' ? 'target'
  : state.id === 'axis' || state.id === 'avst' ? 'sink' : 'subordinate');

function render() {
  buildDoc();
  renderToolbar();
  renderStage();
  renderDiagram();
  renderInspector();
  window.dispatchEvent(new CustomEvent("busdocument", {detail:{doc,state:{...state}}}));
  writeHash();
}

/* ------------------------------------------------------------------ *
 * Compare
 * ------------------------------------------------------------------ */

const ROWS = [
  ['Interface type', 'type'],
  ['How a transfer is accepted', 'accept'],
  ['Pipelining', 'pipelining'],
  ['Bursts', 'bursts'],
  ['Outstanding transactions', 'outstanding'],
  ['Ordering guarantee', 'ordering'],
  ['Signal count, roughly', 'signals'],
  ['Implementation cost', 'cost'],
];

const PAIR_NOTES = [
  ['apb', 'axil', 'APB or AXI4-Lite for registers',
    'Both do the same job. APB is two phases and about seven signals; AXI4-Lite is five channels and about twenty. Choose APB unless the rest of the design is already AXI and you would rather not maintain a bridge.'],
  ['apb', 'ahb', 'APB or AHB-Lite',
    'AHB-Lite pipelines address against data and reaches a word per cycle; APB never will. The classic arrangement is AHB-Lite for memory and an APB bridge hanging off it for the slow peripherals.'],
  ['axi4', 'axil', 'AXI4 or AXI4-Lite',
    'Same handshake, same channels. AXI4 adds bursts, IDs and outstanding transactions, and with them the ordering rules and buffering you now have to verify. AXI4-Lite is single beat on purpose.'],
  ['axis', 'avst', 'AXI4-Stream or Avalon-ST',
    'Structurally the same addressless valid/ready stream. The differences are the sideband names, TKEEP against empty, and Avalon-ST making ready latency a declared property rather than a fixed rule.'],
  ['i2c', 'spi', 'I2C or SPI',
    'I2C costs two pins for a whole addressed bus and gives you acknowledgement per byte. SPI costs three shared signals plus a select per device and gives you an order of magnitude more throughput with no framing standard at all.'],
  ['ahb', 'axi4', 'AHB-Lite or AXI4',
    'AHB-Lite keeps one transfer in flight, so a slow slave stalls everyone. AXI4 decouples the channels and lets several transactions run at once, which is worth the complexity only if something in the system is actually latency bound.'],
  ['wb', 'apb', 'Wishbone or APB',
    'Near enough the same shape and the same cost. The deciding factor is usually the ecosystem: Wishbone across open-source cores, APB anywhere ARM IP is already present.'],
];

function renderCompare() {
  const chosen = $$('.picker button.is-on').map((b) => b.dataset.id);
  const table = $('#matrix');
  if (!chosen.length) {
    table.innerHTML = '<tbody><tr><td>Pick at least one interface above.</td></tr></tbody>';
    $('#compareNotes').innerHTML = '';
    return;
  }
  table.innerHTML =
    `<thead><tr><th scope="col">Property</th>${chosen.map((id) => `<th scope="col">${PROTOCOLS[id].name}</th>`).join('')}</tr></thead>`
    + `<tbody>${ROWS.map(([label, key]) =>
      `<tr><th scope="row">${label}</th>${chosen.map((id) => `<td>${PROTOCOLS[id].attrs[key]}</td>`).join('')}</tr>`).join('')}</tbody>`;

  const notes = PAIR_NOTES.filter(([a, b]) => chosen.includes(a) && chosen.includes(b));
  $('#compareNotes').innerHTML = (notes.length ? notes : [[null, null, 'Start with the shape',
    'Decide first whether you need addressed access, an addressless stream, or a board-level serial link. Throughput and flow control only matter once that is settled, and they are much easier to change later than the shape is.']])
    .map(([, , title, body]) => `<article><h3>${title}</h3><p>${body}</p></article>`)
    .join('');
}

function initCompare() {
  const picker = $('#picker');
  Object.keys(PROTOCOLS).forEach((id, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = id;
    b.textContent = PROTOCOLS[id].name;
    b.className = i < 3 ? 'is-on' : '';
    b.setAttribute('aria-pressed', String(i < 3));
    b.addEventListener('click', () => {
      const on = b.classList.contains('is-on');
      if (!on && $$('.picker button.is-on').length >= 4) return;
      b.classList.toggle('is-on');
      b.setAttribute('aria-pressed', String(!on));
      renderCompare();
    });
    picker.appendChild(b);
  });
  renderCompare();
}

/* ------------------------------------------------------------------ *
 * Interaction
 * ------------------------------------------------------------------ */

function selectProtocol(id) {
  state.id = id;
  const o = PROTOCOLS[id].options;
  state.transaction = o.transactions ? o.transactions[0] : 'write';
  state.cursor = 1;
  render();
}

function step(delta) {
  state.cursor = Math.max(0, Math.min(doc.frames.length - 1, state.cursor + delta));
  renderDiagram();
  renderInspector();
  writeHash();
}

function setPlaying(on) {
  playing = on;
  $('#playBtn').textContent = on ? 'Pause' : 'Play';
  if (on) { if (state.cursor >= doc.frames.length - 1) state.cursor = 0; lastTick = performance.now(); requestAnimationFrame(tick); }
}

function tick(now) {
  if (!playing) return;
  if (now - lastTick > Number($('#speed')?.value ?? 620)) {
    lastTick = now;
    if (state.cursor >= doc.frames.length - 1) { setPlaying(false); return; }
    state.cursor++;
    renderDiagram();
    renderInspector();
  }
  requestAnimationFrame(tick);
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ *
 * URL state
 * ------------------------------------------------------------------ */

let hashLock = false;
function writeHash() {
  const p = new URLSearchParams();
  for (const [k, dv] of Object.entries(DEFAULTS)) {
    if (k === 'cursor' || state[k] === dv) continue;
    p.set(k, typeof dv === 'boolean' ? (state[k] ? '1' : '0') : String(state[k]));
  }
  const q = p.toString();
  hashLock = true;
  history.replaceState(null, '', q ? `#${q}` : location.pathname);
  hashLock = false;
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const [k, dv] of Object.entries(DEFAULTS)) {
    if (!p.has(k)) continue;
    const raw = p.get(k);
    if (typeof dv === 'boolean') state[k] = raw === '1';
    else if (typeof dv === 'number') { const n = Number(raw); if (Number.isFinite(n)) state[k] = n; }
    else state[k] = raw;
  }
  if (!PROTOCOLS[state.id]) state.id = DEFAULTS.id;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function bind() {
  $('#transaction').addEventListener('change', (e) => { state.transaction = e.target.value; state.cursor = 1; render(); });
  $('#burst').addEventListener('change', (e) => { state.burst = e.target.value; render(); });
  $('#spiMode').addEventListener('change', (e) => { state.spiMode = Number(e.target.value); render(); });
  $('#stretch').addEventListener('change', (e) => { state.stretch = e.target.checked; render(); });
  $('#wait').addEventListener('input', (e) => { state.wait = Number(e.target.value); $('#waitOut').value = state.wait; render(); });
  $('#beats').addEventListener('input', (e) => { state.beats = Number(e.target.value); $('#beatsOut').value = state.beats; render(); });

  $('#prevBtn').addEventListener('click', () => { setPlaying(false); step(-1); });
  $('#nextBtn').addEventListener('click', () => { setPlaying(false); step(1); });
  $('#playBtn').addEventListener('click', () => setPlaying(!playing));

  const canvas = $('#wave');
  canvas.addEventListener('click', (e) => {
    if (!metrics) return;
    const r = canvas.getBoundingClientRect();
    setPlaying(false);
    state.cursor = metrics.frameAt(e.clientX - r.left);
    renderDiagram();
    renderInspector();
  });
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
  });

  $('#pngBtn').addEventListener('click', () => {
    canvas.toBlob((blob) => {
      if (blob) download(`${state.id}-${state.transaction}.png`, blob);
    });
  });
  $('#vcdBtn').addEventListener('click', () => {
    download(`${state.id}-${state.transaction}.vcd`, new Blob([toVCD(doc)], { type: 'text/plain' }));
  });

  $$('.viewtab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.viewtab').forEach((t) => { t.classList.remove('is-on'); t.removeAttribute('aria-current'); });
    tab.classList.add('is-on');
    tab.setAttribute('aria-current', 'page');
    $$('.view').forEach((v) => v.classList.remove('is-on'));
    $(`#view-${tab.dataset.view}`).classList.add('is-on');
    if (tab.dataset.view === 'explore') renderDiagram();
  }));

  $('#themeBtn').addEventListener('click', (e) => {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'paper' : 'dark';
    e.currentTarget.textContent = dark ? 'Dark' : 'Light';
    e.currentTarget.setAttribute('aria-pressed', String(!dark));
    try { localStorage.setItem('busscope-theme', dark ? 'paper' : 'dark'); } catch { /* private mode */ }
    renderDiagram();
  });

  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return;
    if (e.key === ' ') { setPlaying(!playing); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setPlaying(false); step(-1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setPlaying(false); step(1); e.preventDefault(); }
    if (e.key === 'Home') { state.cursor = 0; renderDiagram(); renderInspector(); }
    if (e.key === 'End') { state.cursor = doc.frames.length - 1; renderDiagram(); renderInspector(); }
  });

  window.addEventListener('hashchange', () => { if (!hashLock) { readHash(); render(); } });
  new ResizeObserver(() => { if ($('#view-explore').classList.contains('is-on')) renderDiagram(); }).observe($('#scroller'));
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

try {
  if (localStorage.getItem('busscope-theme') === 'paper') { document.documentElement.dataset.theme='paper'; $('#themeBtn').textContent='Dark'; }
  if (localStorage.getItem('busscope-theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark';
    $('#themeBtn').textContent = 'Light';
    $('#themeBtn').setAttribute('aria-pressed', 'true');
  }
} catch { /* private mode */ }

readHash();
renderIndex();
initCompare();
bind();
render();
