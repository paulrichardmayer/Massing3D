// Meshing Web Worker: compiles a part's SDF and runs Surface Nets off the main
// thread, so dragging the blend slider never blocks the UI. Geometry buffers are
// transferred (zero-copy) back to the scene.

import { meshPart } from './sdf.js';

self.onmessage = (e) => {
  const { id, desc } = e.data;
  try {
    const m = meshPart(desc);
    self.postMessage(
      { id, positions: m.positions, normals: m.normals, indices: m.indices },
      [m.positions.buffer, m.normals.buffer, m.indices.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
