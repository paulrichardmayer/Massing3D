// Central app state, the Part model (internally still "layers"), undo/redo,
// serialization. A Part is an independent silhouette-box; parts compose a
// product side-by-side rather than stacking. Each part has a role:
//   'solid' (default) — contributes volume
//   'cut'             — subtracted from solids it overlaps (CSG SUBTRACTION)

import { tessellatePath } from './interpret.js';

const UNIT_FACTORS = { mm: 1, cm: 10, m: 1000 }; // internal unit is mm

const LAYER_COLORS = [0x60a5fa, 0xf472b6, 0x4ade80, 0xfbbf24, 0xa78bfa, 0x2dd4bf, 0xfb923c, 0xe879f9];

const NEW_BOX = { w: 160, h: 160, d: 240 };
export const SNAP_STEP = 20; // mm — duplicate offset / one nudge

let nextLayerId = 1;

export const state = {
  layers: [],
  activeLayerId: null,
  tool: 'freehand', // nav | select | bezier | freehand | rect | ellipse
  symmetry: false,
  // Auto-interpret freehand strokes on finish. Default differs by input: ON for
  // mouse, OFF for stylus (a deliberate organic line). Until the user flips the
  // toggle (autoInterpretUserSet), that pointerType-based default applies.
  autoInterpret: true,
  autoInterpretUserSet: false,
  units: 'mm',
  visibleViews: { top: true, front: true, side: true, persp: true },
  maximized: null, // view name or null
};

// 'mesh' rebuilds the CSG for one part (+ its dependents); 'meshAll' rebuilds
// every part (used after structural ops that can reshuffle cut/solid relations).
const listeners = { change: [], layers: [], mesh: [], meshAll: [], projection: [] };

export function on(event, fn) { listeners[event].push(fn); }

export function emit(event, payload) {
  for (const fn of listeners[event]) fn(payload);
}

// Notify: 'change' redraws 2D views & UI; 'mesh' additionally rebuilds CSG meshes.
export function touch(layer) { emit('change'); if (layer) emit('mesh', layer); }

export function createLayer() {
  const id = nextLayerId++;
  const active = getLayer(state.activeLayerId);
  const box = { ...NEW_BOX };
  // Free placement: a new part spawns BESIDE the active part on +X (not stacked
  // on top). The first part rests on the ground plane.
  const position = active
    ? { x: active.position.x + active.box.w / 2 + box.w / 2 + SNAP_STEP, y: active.position.y, z: active.position.z }
    : { x: 0, y: box.h / 2, z: 0 };
  const layer = {
    id,
    name: `Part ${id}`,
    visible: true,
    role: 'solid', // 'solid' | 'cut'
    sharp: false,  // true => crisp CSG intersection; false => smooth SDF blend
    revolve: false, // true => lathe the side profile around the vertical axis
    color: LAYER_COLORS[(id - 1) % LAYER_COLORS.length],
    box,
    position,
    fillet: 0, // 0..1 -> SDF blend radius k (see kForLayer)
    // Closed sketch paths per orthographic view, stored NORMALIZED to the
    // box: each coordinate is in [-1, 1] relative to the box half-extents
    // for that view's plane (top => {x: x/(w/2), y: z/(d/2)}, front =>
    // {x: x/(w/2), y: y/(h/2)}, side => {x: z/(d/2), y: y/(h/2)}).
    // Resizing the box therefore stretches the silhouettes with it.
    paths: { top: [], front: [], side: [] },
    underlay: null, // { src, plane: 'xy'|'xz'|'yz', opacity, flipH, flipV }
  };
  state.layers.push(layer);
  state.activeLayerId = id;
  return layer;
}

export function getLayer(id) {
  return state.layers.find((l) => l.id === id) ?? null;
}

export function activeLayer() {
  return getLayer(state.activeLayerId);
}

export function deleteLayer(id) {
  const i = state.layers.findIndex((l) => l.id === id);
  if (i === -1) return;
  state.layers.splice(i, 1);
  if (state.activeLayerId === id) {
    state.activeLayerId = state.layers.length ? state.layers[Math.max(0, i - 1)].id : null;
  }
}

export function unitFactor() { return UNIT_FACTORS[state.units]; }

// Blend radius `k` (mm) for the SDF pipeline. The fillet slider (0..1) scales it
// against the smallest box dimension, so the same setting feels consistent on
// parts of any size. k = 0 keeps every edge crisp (the Steinmetz case).
export function kForLayer(layer) {
  return (layer.fillet || 0) * 0.5 * Math.min(layer.box.w, layer.box.h, layer.box.d);
}

// ---------------- part operations (all undoable) ----------------
// Structural edits (create / delete / duplicate / reorder / role / rename)
// snapshot the whole part list before & after into one undo action — simple and
// bulletproof, since these ops can add, remove, or reshuffle parts at once.

function cloneLayers() { return JSON.parse(JSON.stringify(state.layers)); }

function commitStructural(before, beforeActive) {
  pushAction({
    type: 'layers', before, beforeActive,
    after: cloneLayers(), afterActive: state.activeLayerId,
  });
  emit('change');
  emit('meshAll');
}

export function addPart() {
  const before = cloneLayers(), ba = state.activeLayerId;
  const layer = createLayer();
  commitStructural(before, ba);
  return layer;
}

export function deletePart(id) {
  if (!getLayer(id)) return;
  const before = cloneLayers(), ba = state.activeLayerId;
  deleteLayer(id);
  commitStructural(before, ba);
}

// Mirror the top & front silhouettes about the box vertical centerline (the
// world X axis is horizontal in those two views; the side view is unaffected by
// an X reflection). Interpreted seg-paths flatten to point arrays here.
function mirrorRegionX(region) {
  return tessellatePath(region).map((p) => ({ x: +(-p.x).toFixed(5), y: p.y })).reverse();
}
function mirrorPathsX(paths) {
  return {
    top: (paths.top ?? []).map(mirrorRegionX),
    front: (paths.front ?? []).map(mirrorRegionX),
    side: JSON.parse(JSON.stringify(paths.side ?? [])),
  };
}

export function duplicatePart(id, { mirror = false } = {}) {
  const src = getLayer(id);
  if (!src) return null;
  const before = cloneLayers(), ba = state.activeLayerId;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = nextLayerId++;
  copy.underlay = null; // a duplicate shouldn't carry the reference image
  if (mirror) {
    copy.name = `${src.name} (mirror)`;
    copy.position = { x: -src.position.x, y: src.position.y, z: src.position.z };
    copy.paths = mirrorPathsX(src.paths);
  } else {
    copy.name = `${src.name} copy`;
    copy.position = { x: src.position.x + SNAP_STEP, y: src.position.y, z: src.position.z + SNAP_STEP };
  }
  const idx = state.layers.findIndex((l) => l.id === id);
  state.layers.splice(idx + 1, 0, copy);
  state.activeLayerId = copy.id;
  commitStructural(before, ba);
  return copy;
}

export function setPartRole(id, role) {
  const l = getLayer(id);
  if (!l || l.role === role) return;
  const before = cloneLayers(), ba = state.activeLayerId;
  l.role = role;
  commitStructural(before, ba);
}

export function setPartSharp(id, sharp) {
  const l = getLayer(id);
  if (!l || !!l.sharp === !!sharp) return;
  const before = cloneLayers(), ba = state.activeLayerId;
  l.sharp = !!sharp;
  commitStructural(before, ba);
}

export function setPartRevolve(id, revolve) {
  const l = getLayer(id);
  if (!l || !!l.revolve === !!revolve) return;
  const before = cloneLayers(), ba = state.activeLayerId;
  l.revolve = !!revolve;
  commitStructural(before, ba);
}

export function renamePart(id, name) {
  const l = getLayer(id);
  if (!l) return;
  name = String(name).trim().slice(0, 40);
  if (!name || name === l.name) return;
  const before = cloneLayers(), ba = state.activeLayerId;
  l.name = name;
  commitStructural(before, ba);
}

export function reorderPart(id, toIndex) {
  const from = state.layers.findIndex((l) => l.id === id);
  if (from === -1) return;
  toIndex = Math.max(0, Math.min(state.layers.length - 1, toIndex));
  if (from === toIndex) return;
  const before = cloneLayers(), ba = state.activeLayerId;
  const [moved] = state.layers.splice(from, 1);
  state.layers.splice(toIndex, 0, moved);
  commitStructural(before, ba);
}

// Drag-move undo: the caller captures the start position, we record the delta as
// one lightweight action on release (no full snapshot needed for a translate).
export function recordPartMove(id, beforePos) {
  const l = getLayer(id);
  if (!l) return;
  const after = { ...l.position };
  if (beforePos.x === after.x && beforePos.y === after.y && beforePos.z === after.z) return;
  pushAction({ type: 'move', layerId: id, before: { ...beforePos }, after });
}

// ---------------- undo / redo ----------------
// Actions cover sketch path mutations (add / clear) per the drawing workflow.

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 100;

export function pushAction(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

// Design-director drawing logic: a new closed sketch in a view REPLACES that
// view's profile for the layer. Designers iterate on silhouettes — the last
// stroke is the current intent; Ctrl+Z brings the previous profile back.
// (With symmetry on, the profile is the mirrored pair.)
export function setViewPaths(layer, view, paths) {
  const before = JSON.parse(JSON.stringify(layer.paths[view]));
  layer.paths[view] = paths;
  pushAction({
    type: 'setViewPaths', layerId: layer.id, view,
    before, after: JSON.parse(JSON.stringify(paths)),
  });
  touch(layer);
}

// Record an undo entry for a path mutation that already happened in place
// (e.g. live corner-radius tweaks on an interpreted profile, coalesced into a
// single undo step). `before`/`after` are snapshots taken by the caller.
export function recordPathsChange(layer, view, before, after) {
  pushAction({
    type: 'setViewPaths', layerId: layer.id, view,
    before: JSON.parse(JSON.stringify(before)),
    after: JSON.parse(JSON.stringify(after)),
  });
}

export function clearPaths(layer) {
  const before = JSON.parse(JSON.stringify(layer.paths));
  layer.paths = { top: [], front: [], side: [] };
  pushAction({ type: 'setPaths', layerId: layer.id, before, after: JSON.parse(JSON.stringify(layer.paths)) });
  touch(layer);
}

// Restore the full part list from a structural snapshot.
function restoreLayers(snapshot, activeId) {
  state.layers = JSON.parse(JSON.stringify(snapshot));
  state.activeLayerId = activeId;
  nextLayerId = Math.max(0, ...state.layers.map((l) => l.id)) + 1;
  emit('change');
  emit('meshAll');
}

export function undo() {
  const a = undoStack.pop();
  if (!a) return;
  redoStack.push(a);
  if (a.type === 'layers') { restoreLayers(a.before, a.beforeActive); return; }
  const layer = getLayer(a.layerId);
  if (!layer) return;
  if (a.type === 'setViewPaths') {
    layer.paths[a.view] = JSON.parse(JSON.stringify(a.before));
  } else if (a.type === 'setPaths') {
    layer.paths = JSON.parse(JSON.stringify(a.before));
  } else if (a.type === 'move') {
    layer.position = { ...a.before };
  }
  touch(layer);
}

export function redo() {
  const a = redoStack.pop();
  if (!a) return;
  undoStack.push(a);
  if (a.type === 'layers') { restoreLayers(a.after, a.afterActive); return; }
  const layer = getLayer(a.layerId);
  if (!layer) return;
  if (a.type === 'setViewPaths') {
    layer.paths[a.view] = JSON.parse(JSON.stringify(a.after));
  } else if (a.type === 'setPaths') {
    layer.paths = JSON.parse(JSON.stringify(a.after));
  } else if (a.type === 'move') {
    layer.position = { ...a.after };
  }
  touch(layer);
}

// ---------------- serialization ----------------

export function serialize({ includeUnderlays = true } = {}) {
  return {
    v: 5,
    units: state.units,
    activeLayerId: state.activeLayerId,
    layers: state.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      role: l.role ?? 'solid',
      sharp: !!l.sharp,
      revolve: !!l.revolve,
      color: l.color,
      box: { ...l.box },
      position: { ...l.position },
      fillet: l.fillet,
      paths: JSON.parse(JSON.stringify(l.paths)),
      underlay: l.underlay && includeUnderlays ? { ...l.underlay } : null,
    })),
  };
}

// v1 -> v2: paths moved from absolute mm (box-relative) to coordinates
// normalized by the box half-extents for each view's plane.
// v2 -> v3: a stored profile may now be either a plain point array (as before)
// OR an interpreted "seg path" object ({ fmt:'segs', ... } from interpret.js).
// v2 files contain only point arrays, which remain valid v3 entries, so the
// migration is a pure pass-through — no coordinate transform required.
// v3 -> v4: "layers" became "Parts" — each gains a `role` ('solid' default), and
// auto-named "Layer N" parts are relabelled "Part N". Geometry is untouched.
// v4 -> v5: SDF pipeline. Each part gains `sharp` (false => smooth blend) and
// `revolve` (false). `fillet` now drives the blend radius k instead of a CSG
// rounded box, but its stored 0..1 value carries over unchanged.
const VIEW_HALF_DIMS = { top: ['w', 'd'], front: ['w', 'h'], side: ['d', 'h'] };

// Rename only the auto-generated "Layer N" labels; user-chosen names are kept.
function migrateName(name, id) {
  if (!name) return `Part ${id}`;
  const m = /^Layer (\d+)$/.exec(name);
  return m ? `Part ${m[1]}` : name;
}

// Defensive load: keep valid point-array regions and seg-path objects, drop
// anything malformed so a corrupt file can never crash drawing / meshing.
function normalizeViewPaths(paths) {
  const out = { top: [], front: [], side: [] };
  for (const view of ['top', 'front', 'side']) {
    const regions = Array.isArray(paths?.[view]) ? paths[view] : [];
    for (const r of regions) {
      if (Array.isArray(r)) {
        if (r.length >= 3 && r.every((p) => isFinite(p?.x) && isFinite(p?.y))) out[view].push(r);
      } else if (r && r.fmt === 'segs' && r.start && Array.isArray(r.segs)) {
        out[view].push(r);
      }
    }
  }
  return out;
}

function migratePathsV1(layer) {
  const box = layer.box ?? {};
  const paths = layer.paths ?? { top: [], front: [], side: [] };
  const out = { top: [], front: [], side: [] };
  for (const view of ['top', 'front', 'side']) {
    const [hDim, vDim] = VIEW_HALF_DIMS[view];
    const hw = (+box[hDim] || 100) / 2;
    const hh = (+box[vDim] || 100) / 2;
    out[view] = (paths[view] ?? []).map((path) =>
      path.map((p) => ({ x: +(p.x / hw).toFixed(5), y: +(p.y / hh).toFixed(5) }))
    );
  }
  return out;
}

export function deserialize(data) {
  if (!data || ![1, 2, 3, 4, 5].includes(data.v) || !Array.isArray(data.layers)) throw new Error('Unrecognized project file');
  state.layers = data.layers.map((l) => ({
    id: l.id,
    name: migrateName(l.name, l.id),
    visible: l.visible !== false,
    role: l.role === 'cut' ? 'cut' : 'solid',
    sharp: !!l.sharp,
    revolve: !!l.revolve,
    color: l.color ?? LAYER_COLORS[0],
    box: { w: +l.box.w || 100, h: +l.box.h || 100, d: +l.box.d || 100 },
    position: { x: +l.position.x || 0, y: +l.position.y || 0, z: +l.position.z || 0 },
    fillet: +l.fillet || 0,
    paths: data.v === 1 ? migratePathsV1(l) : normalizeViewPaths(l.paths),
    underlay: l.underlay ?? null,
  }));
  state.units = data.units ?? 'mm';
  state.activeLayerId = data.activeLayerId ?? (state.layers[0]?.id ?? null);
  nextLayerId = Math.max(0, ...state.layers.map((l) => l.id)) + 1;
  undoStack.length = 0;
  redoStack.length = 0;
  emit('change');
  for (const l of state.layers) emit('mesh', l);
}

export function resetProject() {
  state.layers = [];
  state.activeLayerId = null;
  nextLayerId = 1;
  undoStack.length = 0;
  redoStack.length = 0;
  createLayer();
  emit('change');
  emit('mesh', activeLayer());
}
