// Central app state, the Part model (internally still "layers"), undo/redo,
// serialization. A Part is an independent silhouette-box; parts compose a
// product side-by-side rather than stacking. Each part has a role:
//   'solid' (default) — contributes volume
//   'cut'             — subtracted from solids it overlaps (CSG SUBTRACTION)

import { tessellatePath } from './interpret.js';
import { ellipsePath } from './geometry.js';

const UNIT_FACTORS = { mm: 1, cm: 10, m: 1000 }; // internal unit is mm

const LAYER_COLORS = [0x60a5fa, 0xf472b6, 0x4ade80, 0xfbbf24, 0xa78bfa, 0x2dd4bf, 0xfb923c, 0xe879f9];

const NEW_BOX = { w: 160, h: 160, d: 240 };

export const PROCESSES = ['massing', 'extrude', 'turn', 'stamp'];
// Extrusion parameters: the profile is drawn in `profileView` and swept along
// that view's normal axis (front => Z, top => Y, side => X). `draft` tapers the
// section from the negative-axis end toward the positive end (degrees; the
// molding/pattern draft designers expect). `twist` rotates the section linearly
// along the sweep (total degrees end-to-end).
// Stamping parameters: the sketched form acts as the DIE; the part becomes a
// constant-`thickness` skin formed over it (deep-draw / thermoform), with one
// `openFace` of the box left open so the shell is a tray/enclosure rather than
// a sealed hollow ('none' keeps it closed).
// Extrusions additionally carry an EDGE treatment for the cap perimeter —
// round-over or 45° chamfer of `edgeSize` mm (the furniture edge break).
const DEFAULT_PROCESS_PARAMS = {
  profileView: 'front', draft: 0, twist: 0, thickness: 3, openFace: 'ny',
  edgeStyle: 'none', edgeSize: 4,
};
export const OPEN_FACES = ['none', 'py', 'ny', 'px', 'nx', 'pz', 'nz'];
export const EDGE_STYLES = ['none', 'round', 'chamfer'];
export const SNAP_STEP = 20; // mm — duplicate offset / one nudge

let nextLayerId = 1;

export const state = {
  layers: [],
  activeLayerId: null,
  tool: 'select', // select is home base in the 3D-first shell
  symmetry: false,
  // Auto-interpret freehand strokes on finish. Default differs by input: ON for
  // mouse, OFF for stylus (a deliberate organic line). Until the user flips the
  // toggle (autoInterpretUserSet), that pointerType-based default applies.
  autoInterpret: true,
  autoInterpretUserSet: false,
  units: 'mm',
  // Furniture Studio (Part III / R1): the 3D viewport IS the app on launch;
  // ortho drawing boards are opt-in (nav cube faces or the Sketch toggle).
  visibleViews: { top: false, front: false, side: false, persp: true },
  maximized: null, // view name or null
  // 3D-print preview (analyzer) — a render-layer mode, so like solo/maximize it
  // is view state: not serialized, not undoable.
  //   layerH   — FDM layer height in mm (drives the banding shader)
  //   overhang — max printable overhang angle in degrees from vertical; steeper
  //              downward-facing surfaces are flagged "needs support"
  //   progress — build-height scrub, 0..1 of the model's world Y span
  print: { on: false, layerH: 1, overhang: 45, progress: 1 },
  // Injection-molding preview (analyzer) — same kind of view state.
  //   mode     — 'draft' (draft heat-map + undercuts + parting line) or
  //              'thickness' (wall-thickness heat-map)
  //   axis     — mold pull direction: 'x' | 'y' | 'z' (two-part mold, ± axis)
  //   minDraft — minimum release draft in degrees; flatter walls flag orange
  //   tMin/tMax— healthy wall-thickness band in mm (thin = short-shot risk,
  //              thick = sink marks)
  mold: { on: false, mode: 'draft', axis: 'y', minDraft: 1, tMin: 1, tMax: 5 },
  // Draft mode (Part II): ortho views become 2D drawing boards. Strokes land
  // in `drawings` (below) instead of driving a part's process. Sticky per
  // project (serialized, v7); Quick Massing (false) is the fresh-file default.
  draftMode: false,
  // Per-view 2D drawing entities, world-planar mm — the technical-drawing
  // layer. Independent of parts; open paths are first-class citizens here.
  //   { kind: 'poly',   pts: [{x,y}...], closed }   lines & polylines
  //   { kind: 'curve',  pts: [{x,y}...], closed }   smooth through-points
  //   { kind: 'arc',    pts: [start, through, end] }
  //   { kind: 'circle', pts: [center, rim] }
  drawings: { top: [], front: [], side: [] },
};

// 'mesh' rebuilds the CSG for one part (+ its dependents); 'meshAll' rebuilds
// every part (used after structural ops that can reshuffle cut/solid relations).
// 'print' / 'mold' re-apply the respective analyzer (material swap + uniforms;
// 'mold' additionally re-runs the SDF undercut/thickness pass).
const listeners = { change: [], layers: [], mesh: [], meshAll: [], projection: [], print: [], mold: [] };

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
    // Manufacturing process — HOW this part's 3D form is generated:
    //   'massing' — intersection of up to three orthographic silhouettes (classic)
    //   'extrude' — ONE cross-section profile swept along that view's axis,
    //               with optional draft (taper) and twist (see processParams)
    //   'turn'    — lathe the Side profile around the vertical centerline
    //               (formerly the `revolve` flag)
    process: 'massing',
    processParams: { ...DEFAULT_PROCESS_PARAMS },
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

// ---------------- furniture primitives (Part III / R1) ----------------
// One click = one part, resting on the ground, sensible furniture defaults.
// Round parts get a full-box circle profile in the Top view — the massing
// engine quietly doing cylinder duty (massing is a feature now, not the app).
const PRIMITIVES = {
  board: { name: 'Board', box: { w: 400, h: 300, d: 18 } },
  slab: { name: 'Slab', box: { w: 600, h: 25, d: 400 } },
  leg: { name: 'Leg', box: { w: 40, h: 450, d: 40 } },
  roundleg: { name: 'Leg', box: { w: 40, h: 450, d: 40 }, round: true },
  cylinder: { name: 'Cylinder', box: { w: 150, h: 300, d: 150 }, round: true },
};

// Nearest free ground spot around the origin — primitives must land IN VIEW,
// never march off-screen in a row. Free = the XZ footprint clears every
// existing part's footprint by a small gap.
function findFreeSpot(box, skipId) {
  const clear = (x, z) => state.layers.every((l) => {
    if (l.id === skipId) return true;
    return Math.abs(x - l.position.x) >= (box.w + l.box.w) / 2 + 10
      || Math.abs(z - l.position.z) >= (box.d + l.box.d) / 2 + 10;
  });
  if (clear(0, 0)) return { x: 0, z: 0 };
  const step = Math.max(box.w, box.d) / 2 + SNAP_STEP;
  for (let r = 1; r <= 40; r++) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = dx * r * step, z = dz * r * step;
      if (clear(x, z)) return { x, z };
    }
  }
  return { x: 0, z: 0 };
}

export function addPrimitive(kind) {
  const spec = PRIMITIVES[kind];
  if (!spec) return null;
  const before = cloneLayers(), ba = state.activeLayerId;
  const layer = createLayer();
  layer.name = `${spec.name} ${layer.id}`;
  layer.box = { ...spec.box };
  const spot = findFreeSpot(layer.box, layer.id);
  layer.position = { x: spot.x, y: layer.box.h / 2, z: spot.z };
  if (spec.round) {
    layer.paths.top = [ellipsePath(0, 0, 1, 1, 48).map((p) => ({ x: +p.x.toFixed(5), y: +p.y.toFixed(5) }))];
  }
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

export function setPartProcess(id, process) {
  const l = getLayer(id);
  if (!l || !PROCESSES.includes(process) || l.process === process) return;
  const before = cloneLayers(), ba = state.activeLayerId;
  l.process = process;
  commitStructural(before, ba);
}

// Continuous process parameters (draft / twist sliders, profile-view pick).
// Like the Blend slider, live drags mutate in place without an undo entry;
// the caller re-meshes via touch()/emit('mesh').
export function setProcessParam(layer, key, value) {
  if (!layer.processParams) layer.processParams = { ...DEFAULT_PROCESS_PARAMS };
  layer.processParams[key] = value;
}

// The single ortho view that defines a process part's geometry, or null when
// every view contributes (massing). Sketching is rejected in the other views.
export function drivingView(layer) {
  if (layer.process === 'turn') return 'side';
  if (layer.process === 'extrude') return layer.processParams?.profileView ?? 'front';
  return null;
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

// ---------------- drafting -> parts bridge (Phase 7) ----------------
// Promote a closed drafted region into a real part: the region becomes the
// extrusion profile, the part's box wraps its bbox in-plane, and the box's
// dimension along the view normal is the panel THICKNESS. Furniture flow:
// draw the side panel in an elevation, give it 18 mm, it's a board.
const REGION_AXES = {
  // view -> [planar-h dim, planar-v dim, thickness dim, h axis, v axis, normal axis]
  front: ['w', 'h', 'd', 'x', 'y', 'z'],
  top: ['w', 'd', 'h', 'x', 'z', 'y'],
  side: ['d', 'h', 'w', 'z', 'y', 'x'],
};

export function addPartFromRegion(view, polyPts, { thickness = 18 } = {}) {
  if (!REGION_AXES[view] || !Array.isArray(polyPts) || polyPts.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polyPts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const hw = Math.max(1, (maxX - minX) / 2), hh = Math.max(1, (maxY - minY) / 2);
  const cx = (minX + maxX) / 2, cv = (minY + maxY) / 2;

  const before = cloneLayers(), ba = state.activeLayerId;
  // a pristine default part (nothing sketched, plain massing) is noise once
  // the user drafts first — the first promotion BECOMES it instead of
  // spawning a second box beside it
  const only = state.layers.length === 1 ? state.layers[0] : null;
  const pristine = only && only.process === 'massing'
    && !only.paths.top.length && !only.paths.front.length && !only.paths.side.length;
  const layer = pristine ? only : createLayer();
  if (pristine) state.activeLayerId = layer.id;
  const [hDim, vDim, tDim, hAxis, vAxis, nAxis] = REGION_AXES[view];
  layer.name = `Panel ${layer.id}`;
  layer.box = { w: 0, h: 0, d: 0 };
  layer.box[hDim] = hw * 2;
  layer.box[vDim] = hh * 2;
  layer.box[tDim] = Math.max(0.5, thickness);
  layer.position = { x: 0, y: 0, z: 0 };
  layer.position[hAxis] = +cx.toFixed(4);
  layer.position[vAxis] = +cv.toFixed(4);
  // plan-view panels rest on the ground; elevation panels center on the axis
  layer.position[nAxis] = nAxis === 'y' ? layer.box.h / 2 : 0;
  layer.process = 'extrude';
  layer.processParams.profileView = view;
  layer.paths[view] = [polyPts.map((p) => ({
    x: +((p.x - cx) / hw).toFixed(5),
    y: +((p.y - cv) / hh).toFixed(5),
  }))];
  commitStructural(before, ba);
  return layer;
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

// ---------------- draft drawings (undoable) ----------------

export function addDrawing(view, entity) {
  const before = JSON.parse(JSON.stringify(state.drawings[view]));
  state.drawings[view].push(entity);
  pushAction({
    type: 'drawings', view, before,
    after: JSON.parse(JSON.stringify(state.drawings[view])),
  });
  emit('change');
}

// Record an undo entry for a drawings mutation that already happened in place
// (entity move / fillet tweak / delete). `before` is the caller's snapshot.
export function recordDrawingsChange(view, before) {
  pushAction({
    type: 'drawings', view,
    before: JSON.parse(JSON.stringify(before)),
    after: JSON.parse(JSON.stringify(state.drawings[view])),
  });
}

export function clearDrawings(view) {
  if (!state.drawings[view].length) return;
  const before = JSON.parse(JSON.stringify(state.drawings[view]));
  state.drawings[view] = [];
  pushAction({ type: 'drawings', view, before, after: [] });
  emit('change');
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
  if (a.type === 'drawings') {
    state.drawings[a.view] = JSON.parse(JSON.stringify(a.before));
    emit('change');
    return;
  }
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
  if (a.type === 'drawings') {
    state.drawings[a.view] = JSON.parse(JSON.stringify(a.after));
    emit('change');
    return;
  }
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
    v: 7,
    units: state.units,
    draftMode: !!state.draftMode,
    drawings: JSON.parse(JSON.stringify(state.drawings)),
    activeLayerId: state.activeLayerId,
    layers: state.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      role: l.role ?? 'solid',
      sharp: !!l.sharp,
      process: l.process ?? 'massing',
      processParams: { ...DEFAULT_PROCESS_PARAMS, ...(l.processParams ?? {}) },
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
// v5 -> v6: manufacturing processes. The `revolve` flag generalizes into
// `process` ('massing' | 'extrude' | 'turn') + `processParams` (profileView,
// draft, twist). Old files: revolve:true => 'turn', otherwise 'massing'.
// v6 -> v7: draft mode. Adds `draftMode` (sticky per project) and per-view
// `drawings` (the 2D technical-drawing layer). Purely additive: older files
// load with empty drawings and Quick Massing.
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

// v<=5 stored a `revolve` flag; v6 stores `process` + `processParams`.
function migrateProcess(l) {
  const p = l.process;
  if (PROCESSES.includes(p)) return p;
  return l.revolve ? 'turn' : 'massing';
}

function normalizeProcessParams(pp) {
  const out = { ...DEFAULT_PROCESS_PARAMS };
  if (['top', 'front', 'side'].includes(pp?.profileView)) out.profileView = pp.profileView;
  if (isFinite(pp?.draft)) out.draft = Math.max(-30, Math.min(30, +pp.draft));
  if (isFinite(pp?.twist)) out.twist = Math.max(-360, Math.min(360, +pp.twist));
  if (isFinite(pp?.thickness)) out.thickness = Math.max(0.5, Math.min(20, +pp.thickness));
  if (OPEN_FACES.includes(pp?.openFace)) out.openFace = pp.openFace;
  if (EDGE_STYLES.includes(pp?.edgeStyle)) out.edgeStyle = pp.edgeStyle;
  if (isFinite(pp?.edgeSize)) out.edgeSize = Math.max(0, Math.min(30, +pp.edgeSize));
  return out;
}

// Defensive load of the drawings layer: keep only well-formed entities.
const DRAWING_KINDS = { poly: 2, curve: 2, arc: 3, circle: 2 }; // kind -> min pts
function normalizeDrawings(drawings) {
  const out = { top: [], front: [], side: [] };
  for (const view of ['top', 'front', 'side']) {
    const ents = Array.isArray(drawings?.[view]) ? drawings[view] : [];
    for (const e of ents) {
      const min = DRAWING_KINDS[e?.kind];
      if (!min || !Array.isArray(e.pts) || e.pts.length < min) continue;
      if (!e.pts.every((p) => isFinite(p?.x) && isFinite(p?.y))) continue;
      const ent = { kind: e.kind, pts: e.pts.map((p) => ({ x: +p.x, y: +p.y })), closed: !!e.closed };
      if (isFinite(e.fillet) && e.fillet > 0) ent.fillet = +e.fillet;
      if (e.chamfer) ent.chamfer = true;
      out[view].push(ent);
    }
  }
  return out;
}

export function deserialize(data) {
  if (!data || ![1, 2, 3, 4, 5, 6, 7].includes(data.v) || !Array.isArray(data.layers)) throw new Error('Unrecognized project file');
  state.layers = data.layers.map((l) => ({
    id: l.id,
    name: migrateName(l.name, l.id),
    visible: l.visible !== false,
    role: l.role === 'cut' ? 'cut' : 'solid',
    sharp: !!l.sharp,
    process: migrateProcess(l),
    processParams: normalizeProcessParams(l.processParams),
    color: l.color ?? LAYER_COLORS[0],
    box: { w: +l.box.w || 100, h: +l.box.h || 100, d: +l.box.d || 100 },
    position: { x: +l.position.x || 0, y: +l.position.y || 0, z: +l.position.z || 0 },
    fillet: +l.fillet || 0,
    paths: data.v === 1 ? migratePathsV1(l) : normalizeViewPaths(l.paths),
    underlay: l.underlay ?? null,
  }));
  state.units = data.units ?? 'mm';
  state.draftMode = !!data.draftMode;
  state.drawings = normalizeDrawings(data.drawings);
  state.activeLayerId = data.activeLayerId ?? (state.layers[0]?.id ?? null);
  nextLayerId = Math.max(0, ...state.layers.map((l) => l.id)) + 1;
  undoStack.length = 0;
  redoStack.length = 0;
  emit('change');
  for (const l of state.layers) emit('mesh', l);
}

// A fresh scene is EMPTY — the first primitive click starts the piece.
export function resetProject() {
  state.layers = [];
  state.activeLayerId = null;
  state.draftMode = false;
  state.drawings = { top: [], front: [], side: [] };
  nextLayerId = 1;
  undoStack.length = 0;
  redoStack.length = 0;
  emit('change');
  emit('meshAll');
}
