// Export (OBJ / STL), project save/open, and share-link encoding.

import * as THREE from 'three';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { getExportMeshes } from './scene3d.js';
import { serialize, deserialize } from './state.js';

function download(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportScene() {
  const meshes = getExportMeshes();
  if (!meshes.length) return null;
  const group = new THREE.Group();
  meshes.forEach((m) => group.add(m));
  group.updateMatrixWorld(true);
  return group;
}

export function exportOBJ() {
  const group = exportScene();
  if (!group) return false;
  const text = new OBJExporter().parse(group);
  download('massing3d.obj', text, 'text/plain');
  return true;
}

export function exportSTL() {
  const group = exportScene();
  if (!group) return false;
  const buffer = new STLExporter().parse(group, { binary: true });
  download('massing3d.stl', new Blob([buffer], { type: 'application/octet-stream' }));
  return true;
}

export function saveProject() {
  const data = JSON.stringify(serialize({ includeUnderlays: true }), null, 1);
  download('massing3d-project.json', data, 'application/json');
}

export function openProject(file) {
  return file.text().then((text) => deserialize(JSON.parse(text)));
}

// Share link: project state (minus underlay images, which are too large for a
// URL) packed into the hash fragment.
export function buildShareLink() {
  const data = JSON.stringify(serialize({ includeUnderlays: false }));
  const encoded = btoa(unescape(encodeURIComponent(data)));
  return `${location.origin}${location.pathname}#p=${encoded}`;
}

export function loadFromHash() {
  const m = location.hash.match(/^#p=(.+)$/);
  if (!m) return false;
  try {
    const json = decodeURIComponent(escape(atob(m[1])));
    deserialize(JSON.parse(json));
    return true;
  } catch (err) {
    console.warn('Failed to load shared project from URL', err);
    return false;
  }
}
