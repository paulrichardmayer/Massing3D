// Menus, layer strip, side contextual panel, adaptive viewport layout,
// maximize/fullscreen mechanics.

import {
  state, on, emit, touch, createLayer, deleteLayer, getLayer, activeLayer,
  clearPaths, unitFactor,
} from './state.js';
import { redrawAll, getLastFocusedView } from './sketchview.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

export function showToast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, ms);
}

// ---------------- adaptive viewport layout ----------------
// Logical rows: [top, persp] / [front, side]. Visible members of a row share
// it; if a row is empty the other row fills the full height. Maximizing a
// view hides everything else plus the top & layer menus (Esc restores).

export function applyLayout() {
  const app = $('#app');
  const max = state.maximized;
  app.classList.toggle('maximized', !!max);

  const rows = { top: $('[data-row="top"]'), bottom: $('[data-row="bottom"]') };
  const rowViews = { top: ['top', 'persp'], bottom: ['front', 'side'] };

  for (const [rowName, views] of Object.entries(rowViews)) {
    let anyVisible = false;
    for (const name of views) {
      const el = $(`[data-view="${name}"]`);
      const visible = max ? name === max : state.visibleViews[name];
      el.style.display = visible ? '' : 'none';
      anyVisible = anyVisible || visible;
    }
    rows[rowName].style.display = anyVisible ? '' : 'none';
  }
  // canvases & renderer resize via ResizeObserver; force a redraw after reflow
  requestAnimationFrame(redrawAll);
}

export function setMaximized(view) {
  state.maximized = view;
  applyLayout();
}

// ---------------- tools ----------------

export function setTool(tool) {
  state.tool = tool;
  $$('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $$('canvas.sketch-canvas').forEach((c) => {
    c.classList.toggle('nav-cursor', tool === 'nav');
    c.classList.toggle('move-cursor', tool === 'select');
  });
}

export function toggleSymmetry() {
  state.symmetry = !state.symmetry;
  $('#toggle-symmetry').classList.toggle('active', state.symmetry);
  showToast(`Symmetry ${state.symmetry ? 'on' : 'off'}`);
  redrawAll();
}

// ---------------- layer strip ----------------

function renderLayerChips() {
  const wrap = $('#layer-chips');
  wrap.innerHTML = '';
  for (const layer of state.layers) {
    const chip = document.createElement('div');
    chip.className = 'layer-chip' + (layer.id === state.activeLayerId ? ' active' : '') + (layer.visible ? '' : ' hidden-layer');
    chip.dataset.tip = `${layer.name} — click to select & open settings`;

    const dot = document.createElement('span');
    dot.style.cssText = `width:8px;height:8px;border-radius:9999px;background:#${layer.color.toString(16).padStart(6, '0')}`;
    chip.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = layer.name;
    chip.appendChild(label);

    const eye = document.createElement('button');
    eye.className = 'chip-eye';
    eye.dataset.tip = layer.visible ? 'Hide layer' : 'Show layer';
    eye.innerHTML = layer.visible
      ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.5 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.7 3.6M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3"/></svg>';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      emit('change');
    });
    chip.appendChild(eye);

    chip.addEventListener('click', () => {
      state.activeLayerId = layer.id;
      openSidePanel();
      emit('change');
    });
    wrap.appendChild(chip);
  }
}

// ---------------- side contextual panel ----------------

export function openSidePanel() {
  const layer = activeLayer();
  if (!layer) return;
  $('#side-panel').classList.remove('hidden');
  syncSidePanel();
}

export function closeSidePanel() {
  $('#side-panel').classList.add('hidden');
}

function syncSidePanel() {
  const layer = activeLayer();
  if (!layer) { closeSidePanel(); return; }
  const f = unitFactor();
  $('#panel-layer-name').textContent = layer.name;
  $('#dim-w').value = +(layer.box.w / f).toFixed(3);
  $('#dim-h').value = +(layer.box.h / f).toFixed(3);
  $('#dim-d').value = +(layer.box.d / f).toFixed(3);
  $('#dim-units').value = state.units;
  $('#fillet-slider').value = Math.round(layer.fillet * 100);
  $('#fillet-val').textContent = Math.round(layer.fillet * 100) + '%';

  const hasUnderlay = !!layer.underlay;
  $('#underlay-controls').classList.toggle('hidden', !hasUnderlay);
  $('#underlay-controls').classList.toggle('flex', hasUnderlay);
  if (hasUnderlay) {
    $$('.underlay-plane').forEach((b) => b.classList.toggle('active', b.dataset.plane === layer.underlay.plane));
    $('#underlay-opacity').value = Math.round(layer.underlay.opacity * 100);
    $('#underlay-opacity-val').textContent = Math.round(layer.underlay.opacity * 100) + '%';
  }
}

function bindSidePanel() {
  $('#panel-close').addEventListener('click', closeSidePanel);

  for (const dim of ['w', 'h', 'd']) {
    $(`#dim-${dim}`).addEventListener('change', (e) => {
      const layer = activeLayer();
      if (!layer) return;
      const val = parseFloat(e.target.value);
      if (!isFinite(val) || val <= 0) { syncSidePanel(); return; }
      const old = layer.box[dim];
      layer.box[dim] = val * unitFactor();
      // keep boxes resting in place: growing height lifts the center
      if (dim === 'h') layer.position.y += (layer.box.h - old) / 2;
      touch(layer);
    });
  }

  $('#dim-units').addEventListener('change', (e) => {
    state.units = e.target.value;
    syncSidePanel();
  });

  $('#fillet-slider').addEventListener('input', (e) => {
    const layer = activeLayer();
    if (!layer) return;
    layer.fillet = (+e.target.value) / 100;
    $('#fillet-val').textContent = e.target.value + '%';
  });
  $('#fillet-slider').addEventListener('change', () => {
    const layer = activeLayer();
    if (layer) touch(layer);
  });

  // ---- underlay ----
  $('#btn-underlay').addEventListener('click', () => $('#underlay-file').click());
  $('#underlay-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    const layer = activeLayer();
    if (!file || !layer) return;
    const reader = new FileReader();
    reader.onload = () => {
      // default to the median plane of the most recently focused ortho view
      const planeByView = { top: 'xz', front: 'xy', side: 'yz' };
      layer.underlay = {
        src: reader.result,
        plane: planeByView[getLastFocusedView()] ?? 'xy',
        opacity: 0.4,
        flipH: false,
        flipV: false,
      };
      touch(layer);
      syncSidePanel();
      showToast('Underlay placed on the median cross-section plane');
    };
    reader.readAsDataURL(file);
  });

  $$('.underlay-plane').forEach((b) => b.addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer?.underlay) return;
    layer.underlay.plane = b.dataset.plane;
    touch(layer);
    syncSidePanel();
  }));

  $('#underlay-fliph').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer?.underlay) return;
    layer.underlay.flipH = !layer.underlay.flipH;
    touch(layer);
  });
  $('#underlay-flipv').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer?.underlay) return;
    layer.underlay.flipV = !layer.underlay.flipV;
    touch(layer);
  });
  $('#underlay-opacity').addEventListener('input', (e) => {
    const layer = activeLayer();
    if (!layer?.underlay) return;
    layer.underlay.opacity = (+e.target.value) / 100;
    $('#underlay-opacity-val').textContent = e.target.value + '%';
    touch(layer);
  });
  $('#underlay-remove').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer) return;
    layer.underlay = null;
    touch(layer);
    syncSidePanel();
  });

  // ---- layer actions ----
  $('#btn-clear-sketches').addEventListener('click', () => {
    const layer = activeLayer();
    if (layer) clearPaths(layer);
  });
  $('#btn-delete-layer').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer) return;
    deleteLayer(layer.id);
    closeSidePanel();
    emit('change');
  });
}

// ---------------- init ----------------

export function initUI() {
  bindSidePanel();

  $('#btn-add-layer').addEventListener('click', () => {
    const layer = createLayer();
    openSidePanel();
    touch(layer);
    showToast(`${layer.name} added — stacked on top`);
  });

  // viewport visibility toggles
  $$('.view-toggle').forEach((b) => b.addEventListener('click', () => {
    const view = b.dataset.viewtoggle;
    // never allow hiding every view
    const visibleCount = Object.values(state.visibleViews).filter(Boolean).length;
    if (state.visibleViews[view] && visibleCount === 1) return;
    state.visibleViews[view] = !state.visibleViews[view];
    b.classList.toggle('active', state.visibleViews[view]);
    applyLayout();
  }));

  // double-click headers to maximize
  $$('.vp-header').forEach((h) => h.addEventListener('dblclick', () => {
    const view = h.parentElement.dataset.view;
    setMaximized(state.maximized === view ? null : view);
  }));

  // tools
  $$('.tool-btn').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#toggle-symmetry').addEventListener('click', toggleSymmetry);

  on('change', () => {
    renderLayerChips();
    syncSidePanel();
    redrawAll();
  });

  setTool(state.tool);
  applyLayout();
}
