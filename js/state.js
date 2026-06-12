// Central app state, layer model, undo/redo, serialization.

const UNIT_FACTORS = { mm: 1, cm: 10, m: 1000 }; // internal unit is mm

const LAYER_COLORS = [0x60a5fa, 0xf472b6, 0x4ade80, 0xfbbf24, 0xa78bfa, 0x2dd4bf, 0xfb923c, 0xe879f9];

let nextLayerId = 1;

export const state = {
  layers: [],
  activeLayerId: null,
  tool: 'freehand', // nav | select | bezier | freehand
  symmetry: false,
  units: 'mm',
  visibleViews: { top: true, front: true, side: true, persp: true },
  maximized: null, // view name or null
};

const listeners = { change: [], layers: [], mesh: [], projection: [] };

export function on(event, fn) { listeners[event].push(fn); }

export function emit(event, payload) {
  for (const fn of listeners[event]) fn(payload);
}

// Notify: 'change' redraws 2D views & UI; 'mesh' additionally rebuilds CSG meshes.
export function touch(layer) { emit('change'); if (layer) emit('mesh', layer); }

export function createLayer() {
  const id = nextLayerId++;
  const prev = state.layers[state.layers.length - 1];
  const box = { w: 160, h: 160, d: 240 };
  // New boxes stack on top of the previous one by default.
  const position = prev
    ? { x: prev.position.x, y: prev.position.y + prev.box.h / 2 + box.h / 2, z: prev.position.z }
    : { x: 0, y: box.h / 2, z: 0 };
  const layer = {
    id,
    name: `Layer ${id}`,
    visible: true,
    color: LAYER_COLORS[(id - 1) % LAYER_COLORS.length],
    box,
    position,
    fillet: 0, // 0..1 of max possible radius
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

export function clearPaths(layer) {
  const before = JSON.parse(JSON.stringify(layer.paths));
  layer.paths = { top: [], front: [], side: [] };
  pushAction({ type: 'setPaths', layerId: layer.id, before, after: JSON.parse(JSON.stringify(layer.paths)) });
  touch(layer);
}

export function undo() {
  const a = undoStack.pop();
  if (!a) return;
  const layer = getLayer(a.layerId);
  if (!layer) return;
  if (a.type === 'setViewPaths') {
    layer.paths[a.view] = JSON.parse(JSON.stringify(a.before));
  } else if (a.type === 'setPaths') {
    layer.paths = JSON.parse(JSON.stringify(a.before));
  }
  redoStack.push(a);
  touch(layer);
}

export function redo() {
  const a = redoStack.pop();
  if (!a) return;
  const layer = getLayer(a.layerId);
  if (!layer) return;
  if (a.type === 'setViewPaths') {
    layer.paths[a.view] = JSON.parse(JSON.stringify(a.after));
  } else if (a.type === 'setPaths') {
    layer.paths = JSON.parse(JSON.stringify(a.after));
  }
  undoStack.push(a);
  touch(layer);
}

// ---------------- serialization ----------------

export function serialize({ includeUnderlays = true } = {}) {
  return {
    v: 2,
    units: state.units,
    activeLayerId: state.activeLayerId,
    layers: state.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
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
const VIEW_HALF_DIMS = { top: ['w', 'd'], front: ['w', 'h'], side: ['d', 'h'] };

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
  if (!data || ![1, 2].includes(data.v) || !Array.isArray(data.layers)) throw new Error('Unrecognized project file');
  state.layers = data.layers.map((l) => ({
    id: l.id,
    name: l.name ?? `Layer ${l.id}`,
    visible: l.visible !== false,
    color: l.color ?? LAYER_COLORS[0],
    box: { w: +l.box.w || 100, h: +l.box.h || 100, d: +l.box.d || 100 },
    position: { x: +l.position.x || 0, y: +l.position.y || 0, z: +l.position.z || 0 },
    fillet: +l.fillet || 0,
    paths: data.v === 1 ? migratePathsV1(l) : (l.paths ?? { top: [], front: [], side: [] }),
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
