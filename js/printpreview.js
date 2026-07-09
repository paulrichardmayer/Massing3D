// 3D-print preview (Manufacturing Methods, Phase 2 — an ANALYZER).
//
// A pure render-layer post-process: FDM layer banding, "needs support"
// overhang highlighting, and a build-height scrub, injected into the standard
// material via onBeforeCompile. No geometry is generated or modified — the
// analyzer reads the very meshes the SDF/CSG pipeline already produces, which
// is what makes it cheap and always in sync with the model.
//
// Conventions (matching desktop slicers):
// - The part prints bottom-up along world +Y from the lowest visible solid.
// - A surface "needs support" when it faces downward more steeply than the
//   overhang threshold: worldNormal.y < -sin(threshold). Vertical walls
//   (normal.y = 0) are safe; a flat ceiling (normal.y = -1) is flagged.
// - The first ~1.5 layers above the plate are bed adhesion, never flagged.
// - Scrubbing the build height discards fragments above the cut, shows the
//   exposed interior as flat "infill" orange, and glows the current layer.

import { state } from './state.js';

const DEG = Math.PI / 180;

// Shared uniform objects: every patched material references THESE, so slider
// changes propagate to all parts without recompiling or cloning materials.
export const printUniforms = {
  uLayerH: { value: 1 },
  uCutY: { value: 1e9 },   // world Y above which fragments are discarded
  uOvSin: { value: Math.sin(45 * DEG) },
  uPlateY: { value: 0 },   // world Y of the build plate (lowest solid point)
};

// Refresh the shared uniforms from state.print + the current world bounds of
// the printable (visible solid) parts.
export function syncPrintUniforms(minY, maxY) {
  const p = state.print;
  printUniforms.uLayerH.value = Math.max(0.05, p.layerH);
  printUniforms.uOvSin.value = Math.sin(p.overhang * DEG);
  printUniforms.uPlateY.value = minY;
  printUniforms.uCutY.value = p.progress >= 0.999 ? 1e9 : minY + (maxY - minY) * p.progress;
}

const SUPPORT_COLOR = 'vec3(0.945, 0.298, 0.298)'; // red-400 — needs support
const LAYER_GLOW = 'vec3(1.0, 0.72, 0.30)';        // amber — layer being "printed"
const INFILL_COLOR = 'vec3(0.85, 0.48, 0.14)';     // exposed interior at the cut

// Inject the analyzer into a MeshStandardMaterial. Call BEFORE first render.
export function patchPrintMaterial(mat) {
  mat.side = 2; // THREE.DoubleSide — the scrub cut exposes the interior
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, printUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vPPos;\nvarying vec3 vPNrm;\nvoid main() {')
      .replace('#include <fog_vertex>',
        '#include <fog_vertex>\n' +
        'vPPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n' +
        'vPNrm = normalize(mat3(modelMatrix) * objectNormal);');

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        'uniform float uLayerH;\nuniform float uCutY;\nuniform float uOvSin;\nuniform float uPlateY;\n' +
        'varying vec3 vPPos;\nvarying vec3 vPNrm;\nvoid main() {\n' +
        // build-height scrub: nothing exists above the cut yet
        'if (vPPos.y > uCutY) discard;')
      // tint "needs support" surfaces before lighting so the red reads as the
      // part's own material, not a sticker
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n' +
        '{\n' +
        '  float ov = step(vPNrm.y, -uOvSin) * step(uPlateY + uLayerH * 1.5, vPPos.y);\n' +
        '  diffuseColor.rgb = mix(diffuseColor.rgb, ' + SUPPORT_COLOR + ', ov * 0.85);\n' +
        '}')
      // after lighting: layer grooves, current-layer glow, interior at the cut
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\n' +
        '{\n' +
        '  float ly = vPPos.y / uLayerH;\n' +
        '  float f = fract(ly);\n' +
        '  float d = min(f, 1.0 - f);\n' +          // distance to layer seam, in layers
        '  float w = fwidth(ly);\n' +               // derivative-AA: seams fade out when
        '  float seam = smoothstep(0.0, w * 1.5, d);\n' + // thinner than a pixel (no moiré)
        '  gl_FragColor.rgb *= mix(0.78, 1.0, seam);\n' +
        '  if (uCutY < 1.0e8) {\n' +
        '    if (!gl_FrontFacing) gl_FragColor.rgb = ' + INFILL_COLOR + ';\n' + // exposed interior
        '    else if (vPPos.y > uCutY - uLayerH) gl_FragColor.rgb = mix(gl_FragColor.rgb, ' + LAYER_GLOW + ', 0.65);\n' +
        '  }\n' +
        '}');
  };
  return mat;
}

// ---------------- support-area statistics ----------------
// CPU-side twin of the shader's overhang test: what fraction of the surface
// area needs support at the current threshold. Geometries come in as plain
// typed arrays (+ the part's world Y offset), so this stays three-free.

export function computeSupportStats(geoms) {
  const p = state.print;
  const ovSin = Math.sin(p.overhang * DEG);
  let minY = Infinity;
  for (const g of geoms) {
    const pos = g.positions;
    for (let i = 1; i < pos.length; i += 3) {
      const y = pos[i] + g.offsetY;
      if (y < minY) minY = y;
    }
  }
  const bedTop = minY + p.layerH * 1.5;

  let total = 0, flagged = 0;
  for (const g of geoms) {
    const pos = g.positions, idx = g.indices;
    const triCount = idx ? idx.length / 3 : pos.length / 9;
    for (let t = 0; t < triCount; t++) {
      const ia = idx ? idx[t * 3] * 3 : t * 9;
      const ib = idx ? idx[t * 3 + 1] * 3 : t * 9 + 3;
      const ic = idx ? idx[t * 3 + 2] * 3 : t * 9 + 6;
      const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
      const ux = pos[ib] - ax, uy = pos[ib + 1] - ay, uz = pos[ib + 2] - az;
      const vx = pos[ic] - ax, vy = pos[ic + 1] - ay, vz = pos[ic + 2] - az;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (len < 1e-12) continue;
      const area = len * 0.5;
      total += area;
      const centerY = (ay + pos[ib + 1] + pos[ic + 1]) / 3 + g.offsetY;
      if (cy / len < -ovSin && centerY > bedTop) flagged += area;
    }
  }
  return { total, flagged, pct: total > 0 ? (100 * flagged) / total : 0 };
}
