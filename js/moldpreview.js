// Injection-molding preview (Manufacturing Methods, Phase 3 — an ANALYZER).
//
// Two readouts over the finished solids, driven by a chosen mold pull axis:
//
// DRAFT mode (shader-only where possible):
// - draft heat-map: a wall's draft angle is asin(|n·pull|) — walls flatter
//   than the minimum release draft tint orange, scaled by severity
// - parting line: an anti-aliased cyan band where n·pull changes sign (the
//   natural cavity/core split of a two-part mold)
// - undercuts: magenta. This one can't be read off a normal — a surface is an
//   undercut when the geometry SHADOWS it along its own release direction
//   (side holes, hooks, dimples). A CPU pass marches the part's SDF from each
//   vertex along ±pull and bakes the result into a vertex attribute.
//
// THICKNESS mode:
// - wall-thickness heat-map from the same CPU pass (march inward along the
//   vertex normal until the field goes positive again): blue = thinner than
//   tMin (short-shot risk), green = healthy, red = thicker than tMax (sink
//   marks / long cycle times).
//
// Like the print preview, this is a render layer + a bake — the geometry
// pipeline is never touched, and each part is analyzed as its own molded
// component in its local space (which is what a multi-part product means).

import { state } from './state.js';

const DEG = Math.PI / 180;
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

export const moldUniforms = {
  uPullDir: { value: [0, 1, 0] },
  uMinDraftSin: { value: Math.sin(1 * DEG) },
  uMoldMode: { value: 0 }, // 0 = draft, 1 = thickness
  uTMin: { value: 1 },
  uTMax: { value: 5 },
};

export function syncMoldUniforms() {
  const m = state.mold;
  const dir = [0, 0, 0];
  dir[AXIS_INDEX[m.axis] ?? 1] = 1;
  moldUniforms.uPullDir.value = dir;
  moldUniforms.uMinDraftSin.value = Math.sin(m.minDraft * DEG);
  moldUniforms.uMoldMode.value = m.mode === 'thickness' ? 1 : 0;
  moldUniforms.uTMin.value = m.tMin;
  moldUniforms.uTMax.value = m.tMax;
}

const UNDERCUT_COLOR = 'vec3(0.85, 0.20, 0.55)';
const LOW_DRAFT_COLOR = 'vec3(0.98, 0.62, 0.15)';
const PARTING_COLOR = 'vec3(0.13, 0.83, 0.93)';

export function patchMoldMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, moldUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('void main() {',
        'attribute float aUndercut;\nattribute float aThickness;\n' +
        'varying float vUc;\nvarying float vTh;\nvarying vec3 vMNrm;\nvoid main() {')
      .replace('#include <fog_vertex>',
        '#include <fog_vertex>\n' +
        'vMNrm = normalize(mat3(modelMatrix) * objectNormal);\n' +
        'vUc = aUndercut;\nvTh = aThickness;');

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        'uniform vec3 uPullDir;\nuniform float uMinDraftSin;\nuniform float uMoldMode;\n' +
        'uniform float uTMin;\nuniform float uTMax;\n' +
        'varying float vUc;\nvarying float vTh;\nvarying vec3 vMNrm;\nvoid main() {')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n' +
        'if (uMoldMode > 0.5) {\n' +
        '  vec3 cThin = vec3(0.23, 0.51, 0.96), cGood = vec3(0.26, 0.79, 0.44), cThick = vec3(0.94, 0.27, 0.27);\n' +
        '  vec3 ramp = mix(cThin, cGood, smoothstep(uTMin * 0.7, uTMin * 1.1, vTh));\n' +
        '  diffuseColor.rgb = mix(ramp, cThick, smoothstep(uTMax * 0.9, uTMax * 1.3, vTh));\n' +
        '} else {\n' +
        '  float c = dot(normalize(vMNrm), uPullDir);\n' +
        '  float bad = 1.0 - smoothstep(uMinDraftSin * 0.75, uMinDraftSin, abs(c));\n' +
        '  diffuseColor.rgb = mix(diffuseColor.rgb, ' + LOW_DRAFT_COLOR + ', bad * 0.9);\n' +
        '  diffuseColor.rgb = mix(diffuseColor.rgb, ' + UNDERCUT_COLOR + ', clamp(vUc, 0.0, 1.0) * 0.95);\n' +
        '}')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\n' +
        'if (uMoldMode < 0.5) {\n' +
        '  float c = dot(normalize(vMNrm), uPullDir);\n' +
        '  float w = fwidth(c);\n' +
        // a parting LINE exists only where the normal is turning through the
        // crossing; on a flat vertical wall c==0 everywhere (w ~ 0), and that
        // is a draft problem (orange), not a line — suppress the band there
        '  float band = (1.0 - smoothstep(0.0, max(w * 1.8, 0.001), abs(c))) * smoothstep(0.0015, 0.005, w);\n' +
        '  gl_FragColor.rgb = mix(gl_FragColor.rgb, ' + PARTING_COLOR + ', band * 0.85);\n' +
        '}');
  };
  return mat;
}

// ---------------- CPU pass: undercut shadowing + wall thickness ----------------
// geo:  { positions, normals, indices } (part-local typed arrays)
// sdf:  compiled part SDF (local space, mm)
// opts: { axis: 'x'|'y'|'z', cell: march step (≈ mesh cell size, mm),
//         bound: max |coordinate| that still counts as "inside the domain" }
// Returns per-vertex Float32Arrays: undercut (0|1) and thickness (mm).

export function analyzeMoldGeometry(geo, sdf, opts) {
  const pos = geo.positions, nrm = geo.normals;
  const n = pos.length / 3;
  const ax = AXIS_INDEX[opts.axis] ?? 1;
  const cell = opts.cell, bound = opts.bound;
  const undercut = new Float32Array(n);
  const thickness = new Float32Array(n);
  const q = [0, 0, 0];

  for (let v = 0; v < n; v++) {
    const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
    const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];

    // --- undercut: march along this vertex's release direction (the mold
    // half it belongs to) and see if the part re-appears in the way
    const nAxis = v * 3 + ax;
    const dir = nrm[nAxis] >= 0 ? 1 : -1;
    q[0] = px; q[1] = py; q[2] = pz;
    q[ax] += dir * cell * 1.5;
    while (Math.abs(q[ax]) < bound) {
      if (sdf(q[0], q[1], q[2]) < -cell * 0.4) { undercut[v] = 1; break; }
      q[ax] += dir * cell;
    }

    // --- thickness: march inward along -normal until we exit the far side
    let t = cell * 0.5;
    let prev = -cell * 0.5; // roughly the field just inside the surface
    const tCap = bound * 2;
    let th = tCap;
    while (t < tCap) {
      const s = sdf(px - nx * t, py - ny * t, pz - nz * t);
      if (s > 0) {
        // linear back-interpolation between the last inside and this outside sample
        const f = prev < 0 ? prev / (prev - s) : 0;
        th = t - cell + f * cell;
        break;
      }
      prev = s;
      t += cell;
    }
    thickness[v] = th;
  }
  return { undercut, thickness };
}

// Area-weighted stats against the CURRENT thresholds (cheap enough to re-run
// when a slider moves — no SDF marching, just the cached bake).
export function computeMoldStats(parts) {
  const m = state.mold;
  const minSin = Math.sin(m.minDraft * DEG);
  const ax = AXIS_INDEX[m.axis] ?? 1;
  let total = 0, lowDraft = 0, ucArea = 0;
  const thSamples = [];

  for (const p of parts) {
    const pos = p.positions, idx = p.indices, uc = p.undercut, th = p.thickness;
    const triCount = idx ? idx.length / 3 : pos.length / 9;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ia = a * 3, ib = b * 3, ic = c * 3;
      const ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2];
      const vx = pos[ic] - pos[ia], vy = pos[ic + 1] - pos[ia + 1], vz = pos[ic + 2] - pos[ia + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      if (len < 1e-12) continue;
      const area = len * 0.5;
      total += area;
      const nComp = [cx, cy, cz][ax] / len;
      if (Math.abs(nComp) < minSin) lowDraft += area;
      ucArea += area * (uc[a] + uc[b] + uc[c]) / 3;
      thSamples.push(th[a]);
    }
  }
  thSamples.sort((x, y) => x - y);
  const pick = (f) => thSamples.length ? thSamples[Math.min(thSamples.length - 1, Math.floor(f * thSamples.length))] : 0;
  return {
    lowDraftPct: total ? (100 * lowDraft) / total : 0,
    undercutPct: total ? (100 * ucArea) / total : 0,
    t05: pick(0.05),
    t95: pick(0.95),
  };
}
