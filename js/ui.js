// Menus, layer strip, side contextual panel, adaptive viewport layout,
// maximize/fullscreen mechanics.

import {
  state, on, emit, touch, getLayer, activeLayer, clearPaths, unitFactor,
  addPart, deletePart, duplicatePart, setPartRole, renamePart, reorderPart,
  setPartSharp, setPartRevolve,
} from './state.js';
import { redrawAll, getLastFocusedView, commitAllPendingShapes, interpretFocusedView } from './sketchview.js';
import { makeDockable, layoutDocked } from './dock.js';
import { showToast } from './toast.js';

export { showToast };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

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
  commitAllPendingShapes(); // don't drop a rect mid-radius-tweak
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

// Master switch for auto clean-up on stroke finish. Flipping it marks the
// preference as user-set, which overrides the pointerType default (mouse on /
// stylus off) used until then.
export function toggleAutoInterpret() {
  state.autoInterpretUserSet = true;
  state.autoInterpret = !state.autoInterpret;
  $('#toggle-auto-interpret').classList.toggle('active', state.autoInterpret);
  showToast(`Auto clean-up ${state.autoInterpret ? 'on' : 'off'}`);
}

// ---------------- part strip ----------------

// Solo/isolate (Alt-click): hide every other part, remembering the prior
// visibility so a second Alt-click restores it. View state only — not undoable.
let soloSnapshot = null;

function toggleSolo(id) {
  if (soloSnapshot) {
    for (const l of state.layers) {
      if (l.id in soloSnapshot) l.visible = soloSnapshot[l.id];
    }
    soloSnapshot = null;
    showToast('Solo off');
  } else {
    soloSnapshot = {};
    for (const l of state.layers) { soloSnapshot[l.id] = l.visible; l.visible = (l.id === id); }
    showToast('Isolated — Alt-click again to restore');
  }
  emit('change');
  emit('meshAll'); // a cut must be visible to bite, so visibility affects CSG
}

let dragChipId = null;

function renderLayerChips() {
  const wrap = $('#layer-chips');
  wrap.innerHTML = '';
  for (const layer of state.layers) {
    const isCut = layer.role === 'cut';
    const chip = document.createElement('div');
    chip.className = 'layer-chip'
      + (layer.id === state.activeLayerId ? ' active' : '')
      + (layer.visible ? '' : ' hidden-layer')
      + (isCut ? ' cut-part' : '');
    chip.draggable = true;
    chip.dataset.tip = `${layer.name}${isCut ? ' (cut)' : ''} — click to select · double-click to rename · Alt-click to isolate · ⋯ for more`;

    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.style.background = isCut ? '#ef4444' : `#${layer.color.toString(16).padStart(6, '0')}`;
    chip.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = layer.name;
    chip.appendChild(label);

    const eye = document.createElement('button');
    eye.className = 'chip-eye';
    eye.dataset.tip = layer.visible ? 'Hide part' : 'Show part';
    eye.innerHTML = layer.visible
      ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.5 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.7 3.6M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3"/></svg>';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      emit('change');
      emit('meshAll');
    });
    chip.appendChild(eye);

    const more = document.createElement('button');
    more.className = 'chip-more';
    more.dataset.tip = 'Part actions';
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openPartMenu(layer.id, r.left, r.top);
    });
    chip.appendChild(more);

    chip.addEventListener('click', (e) => {
      if (e.altKey) { toggleSolo(layer.id); return; }
      state.activeLayerId = layer.id;
      openSidePanel();
      emit('change');
    });
    chip.addEventListener('dblclick', (e) => { e.preventDefault(); startRename(chip, label, layer); });
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); openPartMenu(layer.id, e.clientX, e.clientY); });

    // drag to reorder
    chip.addEventListener('dragstart', (e) => {
      dragChipId = layer.id;
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => {
      dragChipId = null;
      chip.classList.remove('dragging');
      $$('.layer-chip').forEach((c) => c.classList.remove('drag-over'));
    });
    chip.addEventListener('dragover', (e) => {
      if (dragChipId === null || dragChipId === layer.id) return;
      e.preventDefault();
      chip.classList.add('drag-over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      chip.classList.remove('drag-over');
      if (dragChipId === null || dragChipId === layer.id) return;
      reorderPart(dragChipId, state.layers.findIndex((l) => l.id === layer.id));
    });

    wrap.appendChild(chip);
  }
}

// Swap a chip's label for an inline text field to rename the part.
function startRename(chip, label, layer) {
  const input = document.createElement('input');
  input.className = 'chip-rename';
  input.value = layer.name;
  chip.replaceChild(input, label);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) renamePart(layer.id, input.value);
    emit('change'); // re-render either way
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ---------------- part context menu ----------------

function closePartMenu() {
  $('#part-menu')?.remove();
  document.removeEventListener('pointerdown', onMenuOutside, true);
  window.removeEventListener('keydown', onMenuEsc, true);
}
function onMenuOutside(e) { if (!e.target.closest('#part-menu')) closePartMenu(); }
function onMenuEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); closePartMenu(); } }

function openPartMenu(id, x, y) {
  closePartMenu();
  const layer = getLayer(id);
  if (!layer) return;
  const isCut = layer.role === 'cut';
  const items = [
    { label: 'Duplicate', act: () => { duplicatePart(id); showToast('Part duplicated'); } },
    { label: 'Mirror duplicate (X)', act: () => { duplicatePart(id, { mirror: true }); showToast('Mirrored part created'); } },
    { label: isCut ? 'Make Solid' : 'Make Cut', act: () => { setPartRole(id, isCut ? 'solid' : 'cut'); showToast(isCut ? 'Now a solid part' : 'Now a cut — subtracts overlapping solids'); } },
    { label: 'Rename', act: () => { const chip = [...$$('.layer-chip')].find((c) => c.querySelector('.chip-label')?.textContent === layer.name); if (chip) startRename(chip, chip.querySelector('.chip-label'), layer); } },
    { sep: true },
    { label: 'Delete', danger: true, act: () => { deletePart(id); closeSidePanel(); showToast('Part deleted — Ctrl+Z to restore'); } },
  ];
  const menu = document.createElement('div');
  menu.id = 'part-menu';
  menu.className = 'floating-menu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-divider'; menu.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'part-menu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { closePartMenu(); it.act(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // place above-left of the trigger, clamped to the viewport
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y - mh - 6, window.innerHeight - mh - 8)) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onMenuOutside, true);
    window.addEventListener('keydown', onMenuEsc, true);
  }, 0);
}

// ---------------- side contextual panel ----------------

export function openSidePanel() {
  const layer = activeLayer();
  if (!layer) return;
  $('#side-panel').classList.remove('hidden');
  syncSidePanel();
  layoutDocked();
}

export function closeSidePanel() {
  $('#side-panel').classList.add('hidden');
  layoutDocked();
}

function syncSidePanel() {
  const layer = activeLayer();
  if (!layer) { closeSidePanel(); return; }
  const f = unitFactor();
  $('#panel-layer-name').textContent = layer.name;
  $$('.role-btn').forEach((b) => b.classList.toggle('active', b.dataset.role === (layer.role ?? 'solid')));
  $('#toggle-sharp').classList.toggle('active', !!layer.sharp);
  $('#toggle-revolve').classList.toggle('active', !!layer.revolve);
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

  // Live blend: melt in real time while dragging (debounced so the worker isn't
  // flooded); a final touch() on release settles it.
  let blendTimer = null;
  $('#fillet-slider').addEventListener('input', (e) => {
    const layer = activeLayer();
    if (!layer) return;
    layer.fillet = (+e.target.value) / 100;
    $('#fillet-val').textContent = e.target.value + '%';
    clearTimeout(blendTimer);
    blendTimer = setTimeout(() => emit('mesh', layer), 40);
  });
  $('#fillet-slider').addEventListener('change', () => {
    const layer = activeLayer();
    if (layer) touch(layer);
  });

  // ---- surface mode (sharp / revolve) ----
  $('#toggle-sharp').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer) return;
    setPartSharp(layer.id, !layer.sharp);
    showToast(layer.sharp ? 'Sharp mode — crisp boolean edges' : 'Smooth mode — SDF blend');
  });
  $('#toggle-revolve').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer) return;
    setPartRevolve(layer.id, !layer.revolve);
    showToast(layer.revolve ? 'Revolve — sketch the profile in Side view' : 'Revolve off');
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

  // ---- role (solid / cut) ----
  $$('.role-btn').forEach((b) => b.addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer) return;
    setPartRole(layer.id, b.dataset.role);
    showToast(b.dataset.role === 'cut' ? 'Cut — subtracts overlapping solids' : 'Solid part');
  }));

  // ---- part actions ----
  $('#btn-clear-sketches').addEventListener('click', () => {
    const layer = activeLayer();
    if (layer) clearPaths(layer);
  });
  $('#btn-delete-layer').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer) return;
    deletePart(layer.id);
    closeSidePanel();
    showToast('Part deleted — Ctrl+Z to restore');
  });
}

// ---------------- init ----------------

export function initUI() {
  bindSidePanel();

  $('#btn-add-layer').addEventListener('click', () => {
    const layer = addPart();
    openSidePanel();
    showToast(`${layer.name} added`);
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

  // clean-up wand (an action, not a persistent tool) + its auto toggle
  $('#btn-interpret').addEventListener('click', () => interpretFocusedView());
  $('#toggle-auto-interpret').addEventListener('click', toggleAutoInterpret);
  $('#toggle-auto-interpret').classList.toggle('active', state.autoInterpret);

  on('change', () => {
    renderLayerChips();
    syncSidePanel();
    redrawAll();
    layoutDocked();
  });

  // Layer strip docks bottom-right by default; the settings panel shares the
  // corner and stacks directly above it. Both drag by their grips and dock
  // to whichever corner they're dropped near.
  makeDockable($('#menu-layers'), 'bottom-right', '.drag-grip');
  makeDockable($('#side-panel'), 'bottom-right', '.drag-grip');

  setTool(state.tool);
  applyLayout();
}
