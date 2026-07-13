// Smoke test for the injection-molding analyzer's CPU pass: undercut
// shadowing and wall thickness, on analytically-known shapes.
import { surfaceNets } from '../js/sdf.js';
import { analyzeMoldGeometry, computeMoldStats } from '../js/moldpreview.js';
import { state } from '../js/state.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const sdBox = (x, y, z, hx, hy, hz) => {
  const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0);
};

const analyze = (sdf, half, axis) => {
  const mesh = surfaceNets(sdf, { x: half + 2, y: half + 2, z: half + 2 }, 64);
  const cell = (2 * (half + 2)) / 64;
  const bake = analyzeMoldGeometry(
    { positions: mesh.positions, normals: mesh.normals }, sdf,
    { axis, cell, bound: half + 2 },
  );
  return { mesh, bake };
};

// ---- 1. plain box: nothing shadows anything — zero undercut ----
{
  const sdf = (x, y, z) => sdBox(x, y, z, 20, 20, 20);
  const { bake } = analyze(sdf, 20, 'y');
  const flagged = bake.undercut.reduce((a, b) => a + b, 0);
  check('box: no undercuts for Y pull', flagged === 0, `flagged ${flagged} verts`);
}

// ---- 2. box with a horizontal through-hole along X ----
// For a Y pull the hole interior is shadowed both ways -> undercut.
// For an X pull the hole walls release straight out the openings -> none.
{
  const hole = 8;
  const sdf = (x, y, z) => Math.max(sdBox(x, y, z, 20, 20, 20), -(Math.hypot(y, z) - hole));
  const { mesh, bake } = analyze(sdf, 20, 'y');
  const nVerts = bake.undercut.length;
  const flaggedY = bake.undercut.reduce((a, b) => a + b, 0);
  check('hole box: hole interior flagged for Y pull', flaggedY > nVerts * 0.02, `flagged ${flaggedY}/${nVerts}`);
  // every flagged vertex should actually be inside the hole (r < hole radius + slack)
  let misflag = 0;
  for (let v = 0; v < nVerts; v++) {
    if (!bake.undercut[v]) continue;
    const r = Math.hypot(mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    if (r > hole + 2) misflag++;
  }
  check('hole box: flags confined to the hole', misflag === 0, `${misflag} flags outside`);

  const { bake: bakeX } = analyze(sdf, 20, 'x');
  const flaggedX = bakeX.undercut.reduce((a, b) => a + b, 0);
  check('hole box: no undercut when pulling along the hole axis', flaggedX === 0, `flagged ${flaggedX}`);
}

// ---- 3. thickness: a 6 mm plate reads ~6 mm on its faces ----
{
  const sdf = (x, y, z) => sdBox(x, y, z, 20, 3, 20);
  const { mesh, bake } = analyze(sdf, 20, 'y');
  const faceT = [];
  for (let v = 0; v < bake.thickness.length; v++) {
    if (Math.abs(mesh.normals[v * 3 + 1]) > 0.95) faceT.push(bake.thickness[v]);
  }
  faceT.sort((a, b) => a - b);
  const median = faceT[Math.floor(faceT.length / 2)];
  check('plate: median face thickness ~6 mm', Math.abs(median - 6) < 1.2, `median ${median?.toFixed(2)}`);
}

// ---- 4. stats plumbing honors current thresholds ----
{
  const sdf = (x, y, z) => sdBox(x, y, z, 20, 20, 20);
  const { mesh, bake } = analyze(sdf, 20, 'y');
  state.mold.axis = 'y';
  state.mold.minDraft = 1;
  const stats = computeMoldStats([{
    positions: mesh.positions, indices: mesh.indices,
    undercut: bake.undercut, thickness: bake.thickness,
  }]);
  // a box pulled along Y: 4 of 6 faces are perfectly vertical -> ~2/3 under-drafted
  check('stats: box under-draft ~66%', Math.abs(stats.lowDraftPct - 66.7) < 8, `${stats.lowDraftPct.toFixed(1)}%`);
  check('stats: box undercut 0%', stats.undercutPct === 0, `${stats.undercutPct}%`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
