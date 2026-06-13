// Perspective viewport: Three.js scene, CSG mesh generation from orthographic
// sketches, and Rhino/Blender-style navigation (orbit / pan / zoom only —
// drawing tools are always rejected in this view).

import * as THREE from 'three';
import { Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { state, on, emit, kForLayer } from './state.js';
import { tessellatePath } from './interpret.js';
import { meshPart } from './sdf.js';

const INTERACTIVE_RES = 96; // SDF grid cells along the longest axis
const EXPORT_RES = 192;     // finer grid baked only at export time

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];

let renderer, scene, camera, container, gridHelper;
const layerGroups = new Map(); // layerId -> { mesh, outline, underlayMesh, group }
const textureLoader = new THREE.TextureLoader();

// ---------------- scene setup ----------------

export function initScene(containerEl) {
  container = containerEl;
  // preserveDrawingBuffer keeps the last frame readable for screenshots / canvas
  // capture (the continuous render loop is unaffected).
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x18181b);

  camera = new THREE.PerspectiveCamera(45, 1, 1, 50000);
  camera.position.set(420, 340, 520);
  camera.lookAt(0, 60, 0); // face the model from the start (matches the orbit target)

  const hemi = new THREE.HemisphereLight(0xe4e4e7, 0x27272a, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(300, 500, 200);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x93c5fd, 0.4);
  fill.position.set(-400, 200, -300);
  scene.add(fill);

  gridHelper = new THREE.GridHelper(2000, 40, 0x3f3f46, 0x27272a);
  gridHelper.position.y = 0;
  scene.add(gridHelper);

  setupNavigation();

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  renderer.setAnimationLoop(() => renderer.render(scene, camera));

  on('mesh', rebuildAffected);
  on('meshAll', rebuildAllMeshes);
  on('change', syncAllLayers);
}

// ---------------- navigation (orbit / pan / zoom) ----------------
// Orbit:  RMB drag  OR  Alt + LMB drag
// Pan:    MMB drag  OR  Shift + RMB drag
// Zoom:   scroll wheel  OR  Ctrl + RMB drag
// Any selected drawing tool is ignored here — navigation always wins.

const target = new THREE.Vector3(0, 60, 0);
const spherical = new THREE.Spherical();

function setupNavigation() {
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  let mode = null; // 'orbit' | 'pan' | 'dolly'
  let lastX = 0, lastY = 0;

  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      mode = e.shiftKey ? 'pan' : e.ctrlKey ? 'dolly' : 'orbit';
    } else if (e.button === 1) {
      mode = 'pan';
    } else if (e.button === 0) {
      // Tool override fallback: LMB only navigates with Alt held; drawing
      // tools never draw in the perspective view.
      mode = e.altKey ? 'orbit' : null;
    }
    if (mode) {
      lastX = e.clientX; lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;

    if (mode === 'orbit') {
      const offset = camera.position.clone().sub(target);
      spherical.setFromVector3(offset);
      spherical.theta -= dx * 0.005;
      spherical.phi -= dy * 0.005;
      spherical.phi = Math.max(0.02, Math.min(Math.PI - 0.02, spherical.phi));
      offset.setFromSpherical(spherical);
      camera.position.copy(target).add(offset);
      camera.lookAt(target);
    } else if (mode === 'pan') {
      const distFactor = camera.position.distanceTo(target) * 0.0012;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const move = right.multiplyScalar(-dx * distFactor).add(up.multiplyScalar(dy * distFactor));
      camera.position.add(move);
      target.add(move);
      camera.lookAt(target);
    } else if (mode === 'dolly') {
      dolly(Math.exp(dy * 0.004));
    }
  });

  const end = (e) => {
    mode = null;
    try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    dolly(Math.exp(e.deltaY * 0.001));
  }, { passive: false });
}

function dolly(factor) {
  const offset = camera.position.clone().sub(target);
  const len = Math.max(10, Math.min(20000, offset.length() * factor));
  offset.setLength(len);
  camera.position.copy(target).add(offset);
}

// ---------------- mesh generation ----------------
// Each layer mesh = boundingBox ∩ extrusion(top sketch) ∩ extrusion(front
// sketch) ∩ extrusion(side sketch). Views without sketches contribute no
// constraint (the bounding box stands in for their infinite extrusion).

// paths are stored normalized to [-1,1] of the box half-extents; denormalize
// into mm here so the silhouettes always track the current box dimensions.
const VIEW_HALF_DIMS = { top: ['w', 'd'], front: ['w', 'h'], side: ['d', 'h'] };

// World-space AABB overlap of two part boxes (used to decide which cuts bite
// which solids without meshing every pair).
function boxesOverlap(a, b) {
  for (const [ax, dim] of [['x', 'w'], ['y', 'h'], ['z', 'd']]) {
    if (Math.abs(a.position[ax] - b.position[ax]) > (a.box[dim] + b.box[dim]) / 2) return false;
  }
  return true;
}

function makeMaterial(layer, isCut, failed) {
  return isCut
    ? new THREE.MeshStandardMaterial({
      color: 0xef4444, roughness: 0.5, metalness: 0,
      transparent: true, opacity: 0.32, depthWrite: false,
    })
    : new THREE.MeshStandardMaterial({
      color: layer.color, roughness: 0.5, metalness: 0.05,
      transparent: !!failed, opacity: failed ? 0.5 : 1,
    });
}

// ---------------- SDF descriptors ----------------
// Tessellate a part's stored profiles into mm polygons planar to each view, then
// package box + blend + cuts into the plain descriptor the SDF module consumes.

function mmViews(layer) {
  const out = { top: null, front: null, side: null };
  for (const view of ['top', 'front', 'side']) {
    const stored = layer.paths[view];
    if (!stored || !stored.length) continue;
    const [hDim, vDim] = VIEW_HALF_DIMS[view];
    const hw = layer.box[hDim] / 2, hh = layer.box[vDim] / 2;
    const regions = stored
      .map((p) => tessellatePath(p))
      .filter((pts) => pts.length >= 3)
      .map((pts) => pts.map((p) => ({ x: p.x * hw, y: p.y * hh })));
    if (regions.length) out[view] = regions;
  }
  return out;
}

function partDescriptor(layer, res) {
  const { w, h, d } = layer.box;
  return {
    box: { hw: w / 2, hh: h / 2, hd: d / 2 },
    k: kForLayer(layer),
    revolve: !!layer.revolve,
    views: mmViews(layer),
    res,
  };
}

// A solid's descriptor, plus the descriptors of cut parts overlapping it (each
// with the offset that maps this part's local space into the cut's).
function solidDescriptorWithCuts(layer, res) {
  const desc = partDescriptor(layer, res);
  desc.cuts = [];
  for (const cut of state.layers) {
    if (cut === layer || cut.role !== 'cut' || !cut.visible) continue;
    if (!boxesOverlap(layer, cut)) continue;
    const cd = partDescriptor(cut, res);
    cd.offset = {
      x: layer.position.x - cut.position.x,
      y: layer.position.y - cut.position.y,
      z: layer.position.z - cut.position.z,
    };
    desc.cuts.push(cd);
  }
  return desc;
}

// ---------------- async SDF meshing (Web Worker) ----------------
// One worker meshes parts off the main thread; jobs coalesce per part so the
// blend slider can fire freely. The previous mesh stays on screen until the new
// one arrives.

let meshWorker = null;
let jobSeq = 0;
let busyJob = null;
const jobQueue = [];

function ensureWorker() {
  if (meshWorker) return meshWorker;
  meshWorker = new Worker(new URL('./sdfworker.js', import.meta.url), { type: 'module' });
  meshWorker.onmessage = (e) => {
    const { id, positions, normals, indices, error } = e.data;
    const job = busyJob;
    busyJob = null;
    if (job && job.id === id) {
      if (error) console.warn('SDF worker error:', error);
      else applySmoothResult(job.layerId, positions, normals, indices);
    }
    pumpJobs();
  };
  meshWorker.onerror = (e) => { console.warn('SDF worker crashed:', e.message); busyJob = null; };
  return meshWorker;
}

function enqueueSmooth(layer) {
  const id = ++jobSeq;
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    if (jobQueue[i].layerId === layer.id) jobQueue.splice(i, 1); // keep newest only
  }
  jobQueue.push({ id, layerId: layer.id, desc: solidDescriptorWithCuts(layer, INTERACTIVE_RES) });
  pumpJobs();
}

function pumpJobs() {
  if (busyJob || !jobQueue.length) return;
  ensureWorker();
  busyJob = jobQueue.shift();
  meshWorker.postMessage({ id: busyJob.id, desc: busyJob.desc });
}

function geometryFromArrays(positions, normals, indices) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

function applySmoothResult(layerId, positions, normals, indices) {
  const layer = state.layers.find((l) => l.id === layerId);
  const entry = layerGroups.get(layerId);
  if (!layer || !entry || layer.sharp) return; // deleted or flipped to sharp meanwhile
  const isCut = layer.role === 'cut';
  if (entry.mesh) {
    entry.group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
  }
  const mesh = new THREE.Mesh(geometryFromArrays(positions, normals, indices), makeMaterial(layer, isCut, false));
  mesh.position.set(layer.position.x, layer.position.y, layer.position.z);
  mesh.frustumCulled = false;
  mesh.renderOrder = isCut ? 1 : 0;
  entry.mesh = mesh;
  entry.isCut = isCut;
  entry.group.add(mesh);
  syncLayerVisibility(layer, entry);
  projDirty = true;
  emit('projection');
}

// ---------------- CSG meshing (per-part "Sharp mode") ----------------
// Crisp boolean path retained behind the per-part Sharp toggle: box ∩ extrusions,
// minus overlapping cuts. No blend — every edge stays hard.

function extrusionBrush(view, layer) {
  const stored = layer.paths[view];
  if (!stored.length) return null;
  const { w, h, d } = layer.box;
  const [hDim, vDim] = VIEW_HALF_DIMS[view];
  const hw = layer.box[hDim] / 2, hh = layer.box[vDim] / 2;
  const paths = stored.map((p) => tessellatePath(p)).filter((pts) => pts.length >= 3);
  if (!paths.length) return null;
  const shapes = paths.map((pts) => {
    const shape = new THREE.Shape();
    pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x * hw, p.y * hh) : shape.lineTo(p.x * hw, p.y * hh)));
    shape.closePath();
    return shape;
  });
  let depth, geo;
  if (view === 'front') {
    depth = d * 1.04;
    geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
  } else if (view === 'top') {
    depth = h * 1.04;
    geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    geo.translate(0, depth / 2, 0);
  } else {
    depth = w * 1.04;
    geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.rotateY(-Math.PI / 2);
    geo.translate(depth / 2, 0, 0);
  }
  const brush = new Brush(geo);
  brush.updateMatrixWorld();
  return brush;
}

function resolveSolidBrush(layer) {
  const { w, h, d } = layer.box;
  const boxBrush = new Brush(new THREE.BoxGeometry(w, h, d));
  boxBrush.updateMatrixWorld();
  let result = boxBrush;
  let failed = false;
  for (const view of ['top', 'front', 'side']) {
    const brush = extrusionBrush(view, layer);
    if (!brush) continue;
    try {
      result = evaluator.evaluate(result, brush, INTERSECTION);
    } catch (err) {
      console.warn('CSG intersection failed for', view, err);
      failed = true;
    }
  }
  return { brush: result, failed };
}

function rebuildLayerCSG(layer, entry) {
  const isCut = layer.role === 'cut';
  let { brush: result, failed } = resolveSolidBrush(layer);
  if (!isCut) {
    for (const cut of state.layers) {
      if (cut === layer || cut.role !== 'cut' || !cut.visible) continue;
      if (!boxesOverlap(layer, cut)) continue;
      const { brush: cutBrush } = resolveSolidBrush(cut);
      cutBrush.position.set(
        cut.position.x - layer.position.x,
        cut.position.y - layer.position.y,
        cut.position.z - layer.position.z,
      );
      cutBrush.updateMatrixWorld();
      try {
        result = evaluator.evaluate(result, cutBrush, SUBTRACTION);
      } catch (err) {
        console.warn('CSG subtraction failed', err);
        failed = true;
      }
    }
  }
  if (entry.mesh) {
    entry.group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
  }
  const mesh = new THREE.Mesh(result.geometry.clone(), makeMaterial(layer, isCut, failed));
  mesh.position.set(layer.position.x, layer.position.y, layer.position.z);
  mesh.frustumCulled = false;
  mesh.renderOrder = isCut ? 1 : 0;
  entry.mesh = mesh;
  entry.isCut = isCut;
  entry.group.add(mesh);
  projDirty = true;
  emit('projection');
}

// ---------------- per-part rebuild dispatch ----------------

export function rebuildLayer(layer) {
  if (!layer || !scene) return;
  let entry = layerGroups.get(layer.id);
  if (!entry) {
    const group = new THREE.Group();
    scene.add(group);
    entry = { group, mesh: null, outline: null, underlayMesh: null, underlaySrc: null };
    layerGroups.set(layer.id, entry);
  }
  // chrome that doesn't depend on the solved surface updates immediately
  rebuildOutline(layer, entry);
  rebuildUnderlay(layer, entry);
  syncLayerVisibility(layer, entry);
  // the solved surface: crisp CSG now, or smooth SDF on the worker. Revolve is
  // an SDF-only operation, so a revolve part always meshes through the worker
  // even when Sharp is set (a low blend still gives crisp lathe edges).
  if (layer.sharp && !layer.revolve) rebuildLayerCSG(layer, entry);
  else enqueueSmooth(layer);
}

// Rebuild one part plus its dependents. A changed cut affects every solid (it may
// have just moved AWAY from a solid it used to bite), so all solids re-mesh.
function rebuildAffected(layer) {
  if (!layer) { rebuildAllMeshes(); return; }
  rebuildLayer(layer);
  if (layer.role === 'cut') {
    for (const o of state.layers) if (o !== layer && o.role !== 'cut') rebuildLayer(o);
  }
}

// Full rebuild (after structural ops / undo / load). Drops groups for parts that
// no longer exist, then rebuilds every remaining part.
export function rebuildAllMeshes() {
  if (!scene) return;
  for (const [id, entry] of layerGroups) {
    if (!state.layers.some((l) => l.id === id)) {
      scene.remove(entry.group);
      entry.mesh?.geometry.dispose();
      entry.mesh?.material.dispose();
      layerGroups.delete(id);
    }
  }
  for (const l of state.layers) rebuildLayer(l);
}

function rebuildOutline(layer, entry) {
  if (entry.outline) {
    entry.group.remove(entry.outline);
    entry.outline.geometry.dispose();
  }
  const { w, h, d } = layer.box;
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
  const isActive = state.activeLayerId === layer.id;
  const line = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: isActive ? 0x38bdf8 : 0x52525b, transparent: true, opacity: isActive ? 0.9 : 0.35 })
  );
  line.position.set(layer.position.x, layer.position.y, layer.position.z);
  entry.outline = line;
  entry.group.add(line);
}

function rebuildUnderlay(layer, entry) {
  const u = layer.underlay;
  if (entry.underlayMesh && (!u || entry.underlaySrc !== u.src)) {
    entry.group.remove(entry.underlayMesh);
    entry.underlayMesh.geometry.dispose();
    entry.underlayMesh.material.map?.dispose();
    entry.underlayMesh.material.dispose();
    entry.underlayMesh = null;
    entry.underlaySrc = null;
  }
  if (!u) return;

  if (!entry.underlayMesh) {
    const tex = textureLoader.load(u.src);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    });
    entry.underlayMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    entry.underlaySrc = u.src;
    entry.group.add(entry.underlayMesh);
  }

  const m = entry.underlayMesh;
  const { w, h, d } = layer.box;
  m.rotation.set(0, 0, 0);
  if (u.plane === 'xy') m.scale.set(w, h, 1);
  else if (u.plane === 'xz') { m.rotation.x = -Math.PI / 2; m.scale.set(w, d, 1); }
  else { m.rotation.y = Math.PI / 2; m.scale.set(d, h, 1); }
  if (u.flipH) m.scale.x *= -1;
  if (u.flipV) m.scale.y *= -1;
  m.position.set(layer.position.x, layer.position.y, layer.position.z);
  m.material.opacity = u.opacity;
}

function syncLayerVisibility(layer, entry) {
  entry.group.visible = layer.visible;
}

// Keep outlines/visibility/positions in sync with light state changes
// (selection highlight, layer drag) without a full CSG rebuild.
function syncAllLayers() {
  if (!scene) return;
  // remove groups for deleted layers
  for (const [id, entry] of layerGroups) {
    if (!state.layers.some((l) => l.id === id)) {
      scene.remove(entry.group);
      layerGroups.delete(id);
    }
  }
  for (const layer of state.layers) {
    const entry = layerGroups.get(layer.id);
    if (!entry) { rebuildLayer(layer); continue; }
    syncLayerVisibility(layer, entry);
    rebuildOutline(layer, entry);
    if (entry.mesh) entry.mesh.position.set(layer.position.x, layer.position.y, layer.position.z);
    if (entry.underlayMesh) rebuildUnderlay(layer, entry);
  }
  projDirty = true;
}

// ---------------- ortho ghost projections ----------------
// Offscreen orthographic renders of the layer meshes from each sketch
// direction, drawn as a translucent underlay in the 2D views — so any change
// to the model (sketch, dimensions, fillet, layer move) is immediately
// visible in every view.

let projRenderer = null;
let projDirty = true;
const projCache = {}; // view -> { canvas, rect: {hMin,hMax,vMin,vMax} }
const PROJ_SIZE = 512;
const PROJ_AXES = {
  top:   { h: 'x', v: 'z' },
  front: { h: 'x', v: 'y' },
  side:  { h: 'z', v: 'y' },
};

export function getProjection(view) {
  if (!renderer) return null;
  if (projDirty) renderProjections();
  return projCache[view] ?? null;
}

function renderProjections() {
  projDirty = false;
  const visibleLayers = state.layers.filter((l) => l.visible);
  if (!visibleLayers.length) {
    projCache.top = projCache.front = projCache.side = null;
    return;
  }
  if (!projRenderer) {
    projRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    projRenderer.setSize(PROJ_SIZE, PROJ_SIZE);
  }

  // world bounds of all visible layer boxes
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const l of visibleLayers) {
    const half = { x: l.box.w / 2, y: l.box.h / 2, z: l.box.d / 2 };
    for (const ax of ['x', 'y', 'z']) {
      min[ax] = Math.min(min[ax], l.position[ax] - half[ax]);
      max[ax] = Math.max(max[ax], l.position[ax] + half[ax]);
    }
  }
  const center = new THREE.Vector3(
    (min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2,
  );

  // render only the result meshes: hide chrome
  const restore = [];
  const hide = (obj) => { if (obj && obj.visible) { restore.push(obj); obj.visible = false; } };
  hide(gridHelper);
  for (const entry of layerGroups.values()) {
    hide(entry.outline);
    hide(entry.underlayMesh);
    // cut ghosts would fill the holes they carved — show only the solid result
    if (entry.isCut) hide(entry.mesh);
  }
  const prevBg = scene.background;
  scene.background = null;

  const D = 50000;
  for (const view of ['top', 'front', 'side']) {
    const ax = PROJ_AXES[view];
    const hw = Math.max(1, (max[ax.h] - min[ax.h]) / 2) * 1.03;
    const hh = Math.max(1, (max[ax.v] - min[ax.v]) / 2) * 1.03;
    const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 1, D * 2);
    if (view === 'top') {
      cam.position.set(center.x, center.y + D, center.z);
      cam.up.set(0, 0, -1);
    } else if (view === 'front') {
      cam.position.set(center.x, center.y, center.z + D);
      cam.up.set(0, 1, 0);
    } else {
      cam.position.set(center.x - D, center.y, center.z);
      cam.up.set(0, 1, 0);
    }
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    projRenderer.render(scene, cam);

    let entry = projCache[view];
    if (!entry) entry = projCache[view] = { canvas: document.createElement('canvas'), rect: null };
    entry.canvas.width = entry.canvas.height = PROJ_SIZE;
    const ctx = entry.canvas.getContext('2d');
    ctx.clearRect(0, 0, PROJ_SIZE, PROJ_SIZE);
    ctx.drawImage(projRenderer.domElement, 0, 0);
    const ch = (min[ax.h] + max[ax.h]) / 2, cv = (min[ax.v] + max[ax.v]) / 2;
    entry.rect = { hMin: ch - hw, hMax: ch + hw, vMin: cv - hh, vMax: cv + hh };
  }

  scene.background = prevBg;
  for (const obj of restore) obj.visible = true;
}

// Export-ready meshes (world transforms baked). Smooth parts are re-meshed at
// the finer export resolution here; sharp parts reuse their CSG geometry. Cuts
// are tools, not output.
export function getExportMeshes() {
  const meshes = [];
  for (const layer of state.layers) {
    if (!layer.visible || layer.role === 'cut') continue;
    let geo;
    if (layer.sharp && !layer.revolve) {
      const entry = layerGroups.get(layer.id);
      if (!entry?.mesh) continue;
      geo = entry.mesh.geometry.clone();
    } else {
      const m = meshPart(solidDescriptorWithCuts(layer, EXPORT_RES));
      if (!m.indices.length) continue;
      geo = geometryFromArrays(m.positions, m.normals, m.indices);
    }
    geo.translate(layer.position.x, layer.position.y, layer.position.z);
    meshes.push(new THREE.Mesh(geo));
  }
  return meshes;
}
