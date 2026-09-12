// main.mjs — boot and navigation.

import { state, patch, readHash, onHashChange, emit, PRESETS, DEFAULTS, clamp } from './state.mjs';
import { $, $$, dropPalette } from './ui.mjs';
import { initBench, renderBench } from './bench.mjs';
import { initChain, renderChain, initFront, renderFront } from './chain.mjs';
import { initInstruments, render as renderInstruments } from './scopes.mjs';
import { initField, drawField } from './field.mjs';

const RENDER = {
  bench: renderBench,
  chain: renderChain,
  front: renderFront,
  instruments: renderInstruments,
  field: drawField,
  notes: () => {},
};

function showView(name) {
  $$('.viewtab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('is-on', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  $$('.view').forEach((v) => v.classList.remove('is-on'));
  $(`#view-${name}`)?.classList.add('is-on');
  RENDER[name]?.(state);
}

function boot() {
  try {
    const saved = localStorage.getItem('scopelab-theme');
    if (saved === 'day' || saved === 'night') {
      document.documentElement.dataset.theme = saved;
      $('#themeBtn').textContent = saved === 'night' ? 'Day panel' : 'Night panel';
      $('#themeBtn').setAttribute('aria-pressed', String(saved === 'night'));
    }
  } catch { /* private mode */ }

  readHash();
  clamp();

  initBench();
  initChain();
  initFront();
  initInstruments();
  initField();

  $$('.viewtab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

  $('#themeBtn').addEventListener('click', (e) => {
    const night = document.documentElement.dataset.theme === 'night';
    const next = night ? 'day' : 'night';
    document.documentElement.dataset.theme = next;
    e.currentTarget.textContent = night ? 'Night panel' : 'Day panel';
    e.currentTarget.setAttribute('aria-pressed', String(!night));
    try { localStorage.setItem('scopelab-theme', next); } catch { /* private mode */ }
    dropPalette();
    emit();
  });

  $('#linkBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = 'Link copied';
    } catch {
      btn.textContent = 'Copy from the address bar';
    }
    setTimeout(() => { btn.textContent = original; }, 1800);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const n = Number(e.key);
    if (n >= 1 && n <= PRESETS.length) { patch(PRESETS[n - 1].set); e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if (k === 'a') patch({ aaOn: !state.aaOn });
    if (k === 'f') patch({ afeOn: !state.afeOn });
    if (k === 's') patch({ adcOn: !state.adcOn });
    if (k === 'r') patch({ ...DEFAULTS });
  });

  onHashChange(() => emit());

  showView('bench');
  emit();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
