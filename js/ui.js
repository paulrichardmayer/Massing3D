// Menus, layer strip, side contextual panel, adaptive viewport layout,
// maximize/fullscreen mechanics.

import {
  state, on, emit, touch, getLayer, activeLayer, clearPaths, unitFactor,
  addPart, addPrimitive, deletePart, duplicatePart, setPartRole, renamePart,
  reorderPart, setPartSharp, setPartProcess, setProcessParam,
} from './state.js';
import { redrawAll, getLastFocusedView, commitAllPendingShapes, interpretFocusedView, promoteFocusedSelection } from './sketchview.js';
import {
  refreshPrintUniforms, getPrintStats, refreshMoldUniforms, getMoldStats,
  onCameraMove, orbitCameraBy, snapCameraTo,
} from './scene3d.js';
import { makeDockable, layoutDocked } from './dock.js';
import { showToast } from './toast.js';
import { buildCutList } from './cutlist.js';
import { exportCutListCSV } from './export.js';

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
  // sketch tools only exist when a drawing board is on screen
  const anyOrtho = state.visibleViews.top || state.visibleViews.front || state.visibleViews.side;
  document.body.classList.toggle('ortho-visible', !!anyOrtho);
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

// Draft mode toggle (Tab). Entering picks the Line tool; leaving returns to
// freehand. Sticky per project (serialized), synced on load via syncDraftUI.
let viewsBeforeDraft = null; // drawer semantics: closing restores the layout
export function setDraftMode(on) {
  if (state.draftMode === !!on) return;
  commitAllPendingShapes();
  state.draftMode = !!on;
  if (on) {
    // drafting needs drawing boards: open the ortho panes
    viewsBeforeDraft = { ...state.visibleViews };
    for (const v of ['top', 'front', 'side']) state.visibleViews[v] = true;
  } else if (viewsBeforeDraft) {
    Object.assign(state.visibleViews, viewsBeforeDraft);
    viewsBeforeDraft = null;
  }
  syncViewToggles();
  applyLayout();
  syncDraftUI();
  setTool(on ? 'line' : 'select');
  showToast(on
    ? 'Draft mode — 2D drawing board: strokes stay drawings (Tab to leave)'
    : 'Quick Massing — closed profiles drive the active part again');
  redrawAll();
}

export function toggleDraftMode() { setDraftMode(!state.draftMode); }

function syncDraftUI() {
  document.body.classList.toggle('draft-mode', state.draftMode);
  $('#toggle-draft').classList.toggle('active', state.draftMode);
}

// nav-cube faces + 3D pill reflect state.visibleViews (paired faces together)
function syncViewToggles() {
  $$('.view-toggle').forEach((b) => b.classList.toggle('active', !!state.visibleViews[b.dataset.viewtoggle]));
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

    // structure at a glance: process badge (when not plain massing) + CUT
    const process = layer.process ?? 'massing';
    if (process !== 'massing') {
      const badge = document.createElement('span');
      badge.className = 'chip-badge';
      badge.textContent = { extrude: 'EXT', turn: 'TRN', stamp: 'STM' }[process] ?? '';
      chip.appendChild(badge);
    }
    if (isCut) {
      const badge = document.createElement('span');
      badge.className = 'chip-badge chip-badge-cut';
      badge.textContent = 'CUT';
      chip.appendChild(badge);
    }

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

// The inspector is a SECTION of the Parts panel now (one object, one place —
// see docs/ux-review-parts-panel.md). Open/close expand/collapse it; the
// parts list itself is always visible.
export function openSidePanel() {
  const layer = activeLayer();
  if (!layer) return;
  $('#part-settings').classList.remove('hidden');
  syncSidePanel();
  layoutDocked();
}

export function closeSidePanel() {
  $('#part-settings').classList.add('hidden');
  layoutDocked();
}

function syncSidePanel() {
  const layer = activeLayer();
  if (!layer) { closeSidePanel(); return; }
  const f = unitFactor();
  $('#panel-layer-name').textContent = layer.name;
  $$('.role-btn').forEach((b) => b.classList.toggle('active', b.dataset.role === (layer.role ?? 'solid')));
  $('#toggle-sharp').classList.toggle('active', !!layer.sharp);

  const process = layer.process ?? 'massing';
  const pp = layer.processParams ?? {};
  $$('.process-btn').forEach((b) => b.classList.toggle('active', b.dataset.process === process));
  const isExtrude = process === 'extrude';
  $('#extrude-controls').classList.toggle('hidden', !isExtrude);
  $('#extrude-controls').classList.toggle('flex', isExtrude);
  if (isExtrude) {
    $$('.profile-view-btn').forEach((b) => b.classList.toggle('active', b.dataset.profileview === (pp.profileView ?? 'front')));
    $('#draft-slider').value = pp.draft ?? 0;
    $('#draft-val').textContent = `${pp.draft ?? 0}°`;
    $('#twist-slider').value = pp.twist ?? 0;
    $('#twist-val').textContent = `${pp.twist ?? 0}°`;
    $$('.edge-style-btn').forEach((b) => b.classList.toggle('active', b.dataset.edge === (pp.edgeStyle ?? 'none')));
    $('#edge-size').value = pp.edgeSize ?? 4;
    $('#edge-size-val').textContent = `${pp.edgeSize ?? 4} mm`;
  }
  const isStamp = process === 'stamp';
  $('#stamp-controls').classList.toggle('hidden', !isStamp);
  $('#stamp-controls').classList.toggle('flex', isStamp);
  if (isStamp) {
    $('#stamp-thickness').value = pp.thickness ?? 3;
    $('#stamp-t-val').textContent = `${pp.thickness ?? 3} mm`;
    $('#stamp-openface').value = pp.openFace ?? 'ny';
  }
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

  // ---- surface mode (sharp) ----
  $('#toggle-sharp').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer) return;
    setPartSharp(layer.id, !layer.sharp);
    showToast(layer.sharp ? 'Sharp mode — crisp boolean edges' : 'Smooth mode — SDF blend');
  });

  // ---- manufacturing process ----
  const PROCESS_HINTS = {
    massing: 'Massing — sketch silhouettes in any view',
    extrude: 'Extrusion — draw ONE cross-section in the highlighted profile view',
    turn: 'Turning — sketch the profile in the Side view',
    stamp: 'Stamping — your sketched form is the die; the part becomes its formed skin',
  };
  $$('.process-btn').forEach((b) => b.addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer || layer.process === b.dataset.process) return;
    setPartProcess(layer.id, b.dataset.process);
    showToast(PROCESS_HINTS[b.dataset.process]);
  }));

  $$('.profile-view-btn').forEach((b) => b.addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer || layer.process !== 'extrude') return;
    setProcessParam(layer, 'profileView', b.dataset.profileview);
    touch(layer);
    syncSidePanel();
  }));

  // Draft & twist behave like the Blend slider: live re-mesh while dragging
  // (debounced so the worker isn't flooded), settled with touch() on release.
  const bindProcessSlider = (sliderId, valId, key, fmt) => {
    let timer = null;
    $(sliderId).addEventListener('input', (e) => {
      const layer = activeLayer();
      if (!layer) return;
      setProcessParam(layer, key, +e.target.value);
      $(valId).textContent = fmt(+e.target.value);
      clearTimeout(timer);
      timer = setTimeout(() => emit('mesh', layer), 40);
    });
    $(sliderId).addEventListener('change', () => {
      const layer = activeLayer();
      if (layer) touch(layer);
    });
  };
  bindProcessSlider('#draft-slider', '#draft-val', 'draft', (v) => `${v}°`);
  bindProcessSlider('#twist-slider', '#twist-val', 'twist', (v) => `${v}°`);
  bindProcessSlider('#stamp-thickness', '#stamp-t-val', 'thickness', (v) => `${v} mm`);
  bindProcessSlider('#edge-size', '#edge-size-val', 'edgeSize', (v) => `${v} mm`);

  $$('.edge-style-btn').forEach((b) => b.addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer || layer.process !== 'extrude') return;
    setProcessParam(layer, 'edgeStyle', b.dataset.edge);
    touch(layer);
    syncSidePanel();
  }));

  // ---- drafting -> parts bridge ----
  // no material dropdown (review: concepts stay separate) — regions promote
  // at 18 mm and thickness is just a dimension in the inspector afterwards
  $('#btn-make-part').addEventListener('click', () => {
    if (!state.draftMode) return;
    promoteFocusedSelection(18);
  });

  $('#stamp-openface').addEventListener('change', (e) => {
    const layer = activeLayer();
    if (!layer || layer.process !== 'stamp') return;
    setProcessParam(layer, 'openFace', e.target.value);
    touch(layer);
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

// ---------------- 3D-print preview panel ----------------
// The analyzer is global view state (all visible solids), so it lives in its
// own dockable panel, not the per-part settings.

function updatePrintStats() {
  if (!state.print.on) return;
  const { pct } = getPrintStats();
  $('#print-support-pct').textContent = pct >= 0.05 ? `${pct.toFixed(1)}% of surface` : 'none';
}

function setPrintPreview(on) {
  if (state.print.on === on) return;
  if (on) setMoldPreview(false); // one analyzer at a time
  state.print.on = on;
  $('#btn-print-preview').classList.toggle('active', on);
  $('#print-panel').classList.toggle('hidden', !on);
  $('#print-panel').classList.toggle('flex', on);
  emit('print'); // scene3d swaps solid materials + refreshes uniforms
  layoutDocked();
  if (on) updatePrintStats();
  showToast(on ? '3D-print preview — red = needs support' : 'Print preview off');
}

function bindPrintPanel() {
  $('#btn-print-preview').addEventListener('click', () => setPrintPreview(!state.print.on));
  $('#print-close').addEventListener('click', () => setPrintPreview(false));

  // Sliders touch only the shared shader uniforms — the render loop shows the
  // change next frame; no re-mesh, no material swap.
  let statsTimer = null;
  const bind = (sliderId, valId, key, fmt, affectsStats) => {
    $(sliderId).addEventListener('input', (e) => {
      const v = +e.target.value;
      state.print[key] = key === 'progress' ? v / 100 : v;
      $(valId).textContent = fmt(v);
      refreshPrintUniforms();
      if (affectsStats) {
        clearTimeout(statsTimer);
        statsTimer = setTimeout(updatePrintStats, 120);
      }
    });
  };
  bind('#print-layerh', '#print-layerh-val', 'layerH', (v) => `${v} mm`, true);
  bind('#print-overhang', '#print-overhang-val', 'overhang', (v) => `${v}°`, true);
  bind('#print-progress', '#print-progress-val', 'progress', (v) => `${v}%`, false);

  // re-run the readout whenever a mesh lands while the preview is up
  on('projection', () => {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(updatePrintStats, 120);
  });
}

// ---------------- injection-molding preview panel ----------------

function updateMoldStats() {
  if (!state.mold.on) return;
  const s = getMoldStats();
  $('#mold-stats').textContent = state.mold.mode === 'thickness'
    ? `wall ${s.t05.toFixed(1)}–${s.t95.toFixed(1)} mm (5–95%)`
    : `${s.lowDraftPct.toFixed(1)}% under-drafted · ${s.undercutPct.toFixed(1)}% undercut`;
}

function syncMoldPanelMode() {
  const thick = state.mold.mode === 'thickness';
  $$('.mold-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mold.mode));
  $('#mold-draft-controls').classList.toggle('hidden', thick);
  $('#mold-thickness-controls').classList.toggle('hidden', !thick);
  $('#mold-legend-draft').classList.toggle('hidden', thick);
  $('#mold-legend-draft').classList.toggle('flex', !thick);
  $('#mold-legend-thickness').classList.toggle('hidden', !thick);
  $('#mold-legend-thickness').classList.toggle('flex', thick);
  updateMoldStats();
}

function setMoldPreview(on) {
  if (state.mold.on === on) return;
  if (on) setPrintPreview(false); // one analyzer at a time
  state.mold.on = on;
  $('#btn-mold-preview').classList.toggle('active', on);
  $('#mold-panel').classList.toggle('hidden', !on);
  $('#mold-panel').classList.toggle('flex', on);
  emit('mold'); // scene3d swaps materials + bakes undercut/thickness
  layoutDocked();
  if (on) syncMoldPanelMode();
  showToast(on
    ? 'Molding preview — orange = needs draft, magenta = undercut, cyan = parting line'
    : 'Molding preview off');
}

function bindMoldPanel() {
  $('#btn-mold-preview').addEventListener('click', () => setMoldPreview(!state.mold.on));
  $('#mold-close').addEventListener('click', () => setMoldPreview(false));

  $$('.mold-axis-btn').forEach((b) => b.addEventListener('click', () => {
    if (!state.mold.on || state.mold.axis === b.dataset.axis) return;
    state.mold.axis = b.dataset.axis;
    $$('.mold-axis-btn').forEach((x) => x.classList.toggle('active', x.dataset.axis === state.mold.axis));
    emit('mold'); // the undercut bake depends on the pull direction
    showToast(`Pull direction: ${state.mold.axis.toUpperCase()}`);
  }));

  $$('.mold-mode-btn').forEach((b) => b.addEventListener('click', () => {
    if (state.mold.mode === b.dataset.mode) return;
    state.mold.mode = b.dataset.mode;
    refreshMoldUniforms(); // uniform-only — the bake covers both modes
    syncMoldPanelMode();
  }));

  let moldStatsTimer = null;
  const queueStats = () => { clearTimeout(moldStatsTimer); moldStatsTimer = setTimeout(updateMoldStats, 120); };

  $('#mold-draft').addEventListener('input', (e) => {
    state.mold.minDraft = +e.target.value;
    $('#mold-draft-val').textContent = `${state.mold.minDraft}°`;
    refreshMoldUniforms();
    queueStats();
  });
  const syncTLabel = () => { $('#mold-t-val').textContent = `${state.mold.tMin}–${state.mold.tMax} mm`; };
  $('#mold-tmin').addEventListener('input', (e) => {
    state.mold.tMin = Math.min(+e.target.value, state.mold.tMax);
    e.target.value = state.mold.tMin;
    syncTLabel();
    refreshMoldUniforms();
  });
  $('#mold-tmax').addEventListener('input', (e) => {
    state.mold.tMax = Math.max(+e.target.value, state.mold.tMin);
    e.target.value = state.mold.tMax;
    syncTLabel();
    refreshMoldUniforms();
  });

  // stats refresh when a bake lands (scene3d emits 'projection' afterwards)
  on('projection', queueStats);

  // defaults
  $$('.mold-axis-btn').forEach((x) => x.classList.toggle('active', x.dataset.axis === state.mold.axis));
  syncMoldPanelMode();
}

// ---------------- cut list modal ----------------

function showCutList() {
  const rows = buildCutList(state.layers);
  const wrap = $('#cutlist-rows');
  if (!rows.length) {
    wrap.innerHTML = '<div class="text-zinc-500 py-2">No visible solid parts yet.</div>';
  } else {
    const cell = 'padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums';
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse">
      <tr class="text-zinc-500" style="text-align:right">
        <th style="${cell}">Qty</th><th style="${cell}">L</th><th style="${cell}">W</th><th style="${cell}">T</th>
        <th style="padding:3px 8px;text-align:left">Parts</th></tr>
      ${rows.map((r) => `<tr style="border-top:1px solid #27272a">
        <td style="${cell}">${r.qty}</td><td style="${cell}">${r.length}</td>
        <td style="${cell}">${r.width}</td><td style="${cell}">${r.thickness}</td>
        <td style="padding:3px 8px;color:#a1a1aa">${r.parts.join(', ')}</td></tr>`).join('')}
    </table>
    <div class="text-zinc-600 mt-2">mm · L ≥ W ≥ T per part's bounding box · cuts excluded</div>`;
  }
  const modal = $('#cutlist-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function bindCutList() {
  const modal = $('#cutlist-modal');
  const hide = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
  $('#btn-cutlist').addEventListener('click', showCutList);
  $('#cutlist-close').addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
  $('#cutlist-csv').addEventListener('click', () => {
    showToast(exportCutListCSV() ? 'Cut list CSV downloaded' : 'No visible solid parts yet');
  });
}

// ---------------- nav cube ----------------
// Three jobs: MIRROR the perspective camera (the cube always shows how the
// model is oriented), ORBIT it (drag the cube), and FLY to a face's view
// (double-click T / F / S). Single click still toggles the pane — a dblclick
// toggles twice on the way, which nets out to no visibility change.

function bindNavCube() {
  const cube = $('.nav-cube');
  const scene = $('.nav-cube-scene');
  if (!cube || !scene) return;

  const RAD = 180 / Math.PI;
  onCameraMove((theta, phi) => {
    const elev = 90 - phi * RAD;
    cube.style.transform = `rotateX(${(-elev).toFixed(2)}deg) rotateY(${(-theta * RAD).toFixed(2)}deg)`;
  });

  // drag anywhere on the cube = orbit the perspective camera. The pointer is
  // captured only AFTER the drag threshold — capturing on pointerdown would
  // retarget click/dblclick to the wrapper and kill the face buttons.
  let drag = null;
  scene.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0, captured: false };
  });
  scene.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 4) {
      if (!drag.captured) {
        drag.captured = true;
        try { scene.setPointerCapture(e.pointerId); } catch { /* fine */ }
      }
      orbitCameraBy(dx * 1.6, dy * 1.6);
    }
  });
  const dragEnd = (e) => {
    if (!drag) return;
    const wasDrag = drag.moved > 4;
    drag = null;
    try { scene.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    if (wasDrag) suppressNextClick = true;
  };
  scene.addEventListener('pointerup', dragEnd);
  scene.addEventListener('pointercancel', dragEnd);

  let suppressNextClick = false;
  scene.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  scene.addEventListener('dblclick', (e) => {
    const face = e.target.closest('.cube-face');
    if (face) snapCameraTo(face.dataset.snap);
  });
}

// ---------------- init ----------------

export function initUI() {
  bindSidePanel();
  bindPrintPanel();
  bindMoldPanel();
  bindNavCube();
  bindCutList();

  $('#btn-add-layer').addEventListener('click', () => {
    const layer = addPart();
    openSidePanel();
    showToast(`${layer.name} added`);
  });

  // furniture primitives: one click = one part on the ground
  $$('.primitive-btn').forEach((b) => b.addEventListener('click', () => {
    const layer = addPrimitive(b.dataset.primitive);
    if (!layer) return;
    openSidePanel();
    showToast(`${layer.name} — drag in 3D to place · Shift-drag to lift · type dims in the panel`);
  }));

  $('#btn-clay').addEventListener('click', () => {
    showToast('Clay tools (melt / fillet / carve) land in R3 — the Blend slider previews the feel');
  });

  // collapse the whole Parts panel down to its title bar
  $('#parts-collapse').addEventListener('click', () => {
    $('#parts-panel').classList.toggle('panel-collapsed');
    layoutDocked();
  });

  // File menu under the logo: New / Open / Save + exports
  const fileMenu = $('#file-menu');
  const setFileMenu = (open) => {
    fileMenu.classList.toggle('hidden', !open);
    fileMenu.classList.toggle('flex', open);
  };
  $('#logo-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    setFileMenu(fileMenu.classList.contains('hidden'));
  });
  fileMenu.addEventListener('click', () => setFileMenu(false)); // any item closes it
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#file-menu') && !e.target.closest('#logo-menu-btn')) setFileMenu(false);
  });

  // viewport visibility toggles — opposite cube faces share a pane, so sync
  // the lit state across every control bound to that view
  $$('.view-toggle').forEach((b) => b.addEventListener('click', () => {
    const view = b.dataset.viewtoggle;
    // never allow hiding every view
    const visibleCount = Object.values(state.visibleViews).filter(Boolean).length;
    if (state.visibleViews[view] && visibleCount === 1) return;
    state.visibleViews[view] = !state.visibleViews[view];
    $$(`.view-toggle[data-viewtoggle="${view}"]`)
      .forEach((x) => x.classList.toggle('active', state.visibleViews[view]));
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

  $('#toggle-draft').addEventListener('click', toggleDraftMode);

  on('change', () => {
    renderLayerChips();
    syncSidePanel();
    syncDraftUI(); // project load / New can flip the sticky mode
    redrawAll();
    layoutDocked();
  });

  // Layer strip docks bottom-right by default; the settings panel shares the
  // corner and stacks directly above it. Both drag by their grips and dock
  // to whichever corner they're dropped near.
  makeDockable($('#parts-panel'), 'top-right', '.drag-grip');
  makeDockable($('#print-panel'), 'bottom-left', '.drag-grip');
  makeDockable($('#mold-panel'), 'bottom-left', '.drag-grip');

  setTool(state.tool);
  syncViewToggles(); // persp-only boot: cube faces start unlit
  applyLayout();
}
