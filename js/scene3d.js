// Perspective viewport: Three.js scene, CSG mesh generation from orthographic
// sketches, and Rhino/Blender-style navigation (orbit / pan / zoom only —
// drawing tools are always rejected in this view).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Brush, Evaluator, INTERSECTION } from 'three-bvh-csg';
import { state, on, emit } from './state.js';
import { roundCorners } from './geometry.js';

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];

let renderer, scene, camera, container, gridHelper;
const layerGroups = new Map(); // layerId -> { mesh, outline, underlayMesh, group }
const textureLoader = new THREE.TextureLoader();

// ---------------- scene setup ----------------

export function initScene(containerEl) {
  container = containerEl;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x18181b);

  camera = new THREE.PerspectiveCamera(45, 1, 1, 50000);
  camera.position.set(420, 340, 520);

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

  on('mesh', rebuildLayer);
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

function pathsToShapes(paths, filletRadius) {
  return paths.map((pts) => {
    const rounded = filletRadius > 0 ? roundCorners(pts, filletRadius) : pts;
    const shape = new THREE.Shape();
    rounded.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
    shape.closePath();
    return shape;
  });
}

function extrusionBrush(view, layer, filletRadius) {
  const paths = layer.paths[view];
  if (!paths.length) return null;
  const { w, h, d } = layer.box;
  const shapes = pathsToShapes(paths, filletRadius);
  let depth, geo;
  if (view === 'front') {
    // shape (relX, relY), extrude along Z
    depth = d * 1.04;
    geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
  } else if (view === 'top') {
    // shape (relX, relZ), extrude along Y: rotateX(+90°) maps shape-Y -> world Z
    depth = h * 1.04;
    geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    geo.translate(0, depth / 2, 0);
  } else {
    // side: shape (relZ, relY), extrude along X: rotateY(-90°) maps shape-X -> world Z
    depth = w * 1.04;
    geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
    geo.rotateY(-Math.PI / 2);
    geo.translate(depth / 2, 0, 0);
  }
  // Brushes stay in layer-local space (box center at origin); only the final
  // mesh gets positioned in the world.
  const brush = new Brush(geo);
  brush.updateMatrixWorld();
  return brush;
}

export function rebuildLayer(layer) {
  if (!layer || !scene) return;
  let entry = layerGroups.get(layer.id);
  if (!entry) {
    const group = new THREE.Group();
    scene.add(group);
    entry = { group, mesh: null, outline: null, underlayMesh: null, underlaySrc: null };
    layerGroups.set(layer.id, entry);
  }

  const { w, h, d } = layer.box;
  const maxFillet = Math.min(w, h, d) * 0.45;
  const filletRadius = layer.fillet * maxFillet;

  // bounding box brush (rounded when fillet active)
  const boxGeo = filletRadius > 0.5
    ? new RoundedBoxGeometry(w, h, d, 3, filletRadius)
    : new THREE.BoxGeometry(w, h, d);
  const boxBrush = new Brush(boxGeo);
  boxBrush.updateMatrixWorld();

  let result = boxBrush;
  let failed = false;
  for (const view of ['top', 'front', 'side']) {
    const brush = extrusionBrush(view, layer, filletRadius);
    if (!brush) continue;
    try {
      result = evaluator.evaluate(result, brush, INTERSECTION);
    } catch (err) {
      console.warn('CSG intersection failed for', view, err);
      failed = true;
    }
  }

  if (entry.mesh) {
    entry.group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
  }
  const material = new THREE.MeshStandardMaterial({
    color: layer.color,
    roughness: 0.55,
    metalness: 0.05,
    transparent: failed,
    opacity: failed ? 0.5 : 1,
  });
  const mesh = new THREE.Mesh(result.geometry.clone(), material);
  mesh.position.set(layer.position.x, layer.position.y, layer.position.z);
  entry.mesh = mesh;
  entry.group.add(mesh);

  rebuildOutline(layer, entry);
  rebuildUnderlay(layer, entry);
  syncLayerVisibility(layer, entry);

  projDirty = true;
  emit('projection');
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

// Export-ready meshes (world transforms baked).
export function getExportMeshes() {
  const meshes = [];
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    const entry = layerGroups.get(layer.id);
    if (!entry?.mesh) continue;
    const clone = entry.mesh.clone();
    clone.geometry = entry.mesh.geometry.clone();
    clone.updateMatrixWorld(true);
    clone.geometry.applyMatrix4(clone.matrixWorld);
    clone.position.set(0, 0, 0);
    clone.rotation.set(0, 0, 0);
    clone.updateMatrixWorld(true);
    meshes.push(clone);
  }
  return meshes;
}
