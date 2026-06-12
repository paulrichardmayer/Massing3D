// Massing3D bootstrap: viewports, scene, menus, hotkeys.

import { state, createLayer, resetProject, undo, redo, emit, activeLayer } from './state.js';
import { SketchView, cancelAllSketches, sketchViews } from './sketchview.js';
import { initScene } from './scene3d.js';
import { initUI, setTool, toggleSymmetry, setMaximized, applyLayout, showToast, closeSidePanel } from './ui.js';
import { exportOBJ, exportSTL, saveProject, openProject, buildShareLink, loadFromHash } from './export.js';

// ---------------- viewports ----------------

new SketchView(document.querySelector('[data-view="top"]'), 'top');
new SketchView(document.querySelector('[data-view="front"]'), 'front');
new SketchView(document.querySelector('[data-view="side"]'), 'side');
initScene(document.getElementById('persp-container'));
initUI();

// ---------------- project boot ----------------

if (!loadFromHash()) {
  createLayer();
  emit('change');
  emit('mesh', activeLayer());
} else {
  showToast('Shared project loaded');
}

// frame the default box in each ortho view once layout has settled
requestAnimationFrame(() => {
  Object.values(sketchViews).forEach((v) => v.zoomExtents());
});

// ---------------- top menu ----------------

document.getElementById('btn-new').addEventListener('click', () => {
  resetProject();
  closeSidePanel();
  history.replaceState(null, '', location.pathname);
  showToast('New file');
});

document.getElementById('btn-save').addEventListener('click', () => {
  saveProject();
  showToast('Project saved as .json');
});

const openInput = document.createElement('input');
openInput.type = 'file';
openInput.accept = 'application/json,.json';
openInput.addEventListener('change', () => {
  const file = openInput.files[0];
  openInput.value = '';
  if (!file) return;
  openProject(file)
    .then(() => showToast('Project loaded'))
    .catch(() => showToast('Could not read that project file'));
});
document.getElementById('btn-open').addEventListener('click', () => openInput.click());

document.getElementById('btn-export-obj').addEventListener('click', () => {
  showToast(exportOBJ() ? 'OBJ exported' : 'Nothing to export yet — sketch something first');
});
document.getElementById('btn-export-stl').addEventListener('click', () => {
  showToast(exportSTL() ? 'STL exported' : 'Nothing to export yet — sketch something first');
});

document.getElementById('btn-share').addEventListener('click', async () => {
  const link = buildShareLink();
  try {
    await navigator.clipboard.writeText(link);
    showToast('Share link copied to clipboard');
  } catch {
    prompt('Copy this share link:', link);
  }
});

// ---------------- industry-standard hotkeys ----------------
// W select/move · L bezier · F freehand · S symmetry
// Ctrl+Z / Ctrl+Y undo/redo · Esc exit fullscreen / cancel / deselect

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    }
    return;
  }

  switch (e.key.toLowerCase()) {
    case 'w': setTool('select'); break;
    case 'l': setTool('bezier'); break;
    case 'f': setTool('freehand'); break;
    case 's': toggleSymmetry(); break;
    case 'escape': {
      // priority: cancel in-progress sketch -> exit fullscreen -> deselect tool
      if (cancelAllSketches()) break;
      if (state.maximized) { setMaximized(null); break; }
      setTool('nav');
      break;
    }
  }
});

// keep layout in sync on window resize
window.addEventListener('resize', applyLayout);
