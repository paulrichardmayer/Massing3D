// Signed-distance-field geometry pipeline (Phase 4).
//
// A part is meshed in its own LOCAL space (box centred at the origin, mm units)
// as a signed distance field, then triangulated with Surface Nets. This is what
// lets edges and intersection seams melt uniformly with one blend radius `k`,
// and what makes the surfaces look liquid-smooth (vertex normals come straight
// from the SDF gradient).
//
// This module is intentionally free of any Three.js / DOM dependency so the
// exact same code runs inside the meshing Web Worker. Callers hand in a plain
// "part descriptor" (see meshPart) and get back typed arrays.

// ---------------- smooth min / max (quadratic polynomial) ----------------
// k is the blend radius in the same units as the field (mm). k -> 0 collapses to
// the hard min/max, so blend = 0 yields crisp intersections (the Steinmetz solid).

export function smin(a, b, k) {
  if (k <= 1e-6) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}

export function smax(a, b, k) {
  if (k <= 1e-6) return a > b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a > b ? a : b) + h * h * k * 0.25;
}

// ---------------- 2D signed distance to a profile (union of regions) ----------------

// Signed distance to one closed polygon (negative inside). Crossing-number test
// for inside/out + nearest-segment distance.
function sdRegion(px, py, poly) {
  const n = poly.length;
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[i].x, ay = poly[i].y, bx = poly[j].x, by = poly[j].y;
    const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay;
    const len = ex * ex + ey * ey;
    let t = len > 1e-12 ? (wx * ex + wy * ey) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - ex * t, dy = wy - ey * t;
    const dd = dx * dx + dy * dy;
    if (dd < d) d = dd;
    if (((ay > py) !== (by > py)) && (px < (bx - ax) * (py - ay) / (by - ay) + ax)) inside = !inside;
  }
  return (inside ? -1 : 1) * Math.sqrt(d);
}

// Union of regions = min of signed distances.
function sdRegions(px, py, regions) {
  let d = 1e9;
  for (let r = 0; r < regions.length; r++) {
    const s = sdRegion(px, py, regions[r]);
    if (s < d) d = s;
  }
  return d;
}

// ---------------- coarse 2D acceleration grid ----------------
// Sampling the polygon distance directly for every 3D grid corner is far too
// slow, so each profile is baked once into a coarse scalar grid and sampled
// bilinearly while meshing. Bilinear interpolation of a distance field is smooth
// and plenty accurate at the blend scale.

function buildGrid(regions, hHalf, vHalf, margin, res) {
  const minx = -hHalf - margin, miny = -vHalf - margin;
  const maxx = hHalf + margin, maxy = vHalf + margin;
  const nx = res, ny = res;
  const dx = (maxx - minx) / (nx - 1), dy = (maxy - miny) / (ny - 1);
  const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = miny + j * dy;
    const row = j * nx;
    for (let i = 0; i < nx; i++) data[row + i] = sdRegions(minx + i * dx, y, regions);
  }
  return { minx, miny, dx, dy, nx, ny, data };
}

function sampleGrid(g, h, v) {
  let fx = (h - g.minx) / g.dx, fy = (v - g.miny) / g.dy;
  if (fx < 0) fx = 0; else if (fx > g.nx - 1) fx = g.nx - 1;
  if (fy < 0) fy = 0; else if (fy > g.ny - 1) fy = g.ny - 1;
  const i0 = fx | 0, j0 = fy | 0;
  const i1 = i0 + 1 < g.nx ? i0 + 1 : i0;
  const j1 = j0 + 1 < g.ny ? j0 + 1 : j0;
  const tx = fx - i0, ty = fy - j0;
  const d = g.data, nx = g.nx;
  const a = d[j0 * nx + i0], b = d[j0 * nx + i1], c = d[j1 * nx + i0], e = d[j1 * nx + i1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + e * tx * ty;
}

// ---------------- analytic box SDF ----------------

function sdBox(x, y, z, hx, hy, hz) {
  const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside;
}

// ---------------- part SDF compilation ----------------
// Builds a fast closure sdf(x,y,z) for a part descriptor:
//   { box:{hw,hh,hd}, k, revolve, views:{front,top,side}, cuts:[...] }
// Each `views.*` is an array of regions (each region an array of {x,y} in mm,
// planar to that view). `cuts[i]` carries its own descriptor plus an offset that
// maps this part's local point into the cut's local space.

const GRID_RES_2D = 160;

function gridMargin(k) { return k * 0.5 + 4; }

export function compilePart(desc) {
  const box = desc.box;
  const k = desc.k || 0;
  const revolve = !!desc.revolve;
  const margin = gridMargin(k);
  const v = desc.views || {};
  // half extents per view's planar axes (front: x,y · top: x,z · side: z,y)
  const gFront = v.front && v.front.length ? buildGrid(v.front, box.hw, box.hh, margin, GRID_RES_2D) : null;
  const gTop = v.top && v.top.length ? buildGrid(v.top, box.hw, box.hd, margin, GRID_RES_2D) : null;
  const gSide = v.side && v.side.length ? buildGrid(v.side, box.hd, box.hh, margin, GRID_RES_2D) : null;

  const cuts = (desc.cuts || []).map((c) => ({ sdf: compilePart(c), off: c.offset }));
  const hw = box.hw, hh = box.hh, hd = box.hd;

  function solidSDF(x, y, z) {
    let s = sdBox(x, y, z, hw, hh, hd);
    if (revolve) {
      // lathe the side profile around the vertical (Y) axis; radius = |xz|
      if (gSide) {
        const r = Math.sqrt(x * x + z * z);
        s = smax(s, sampleGrid(gSide, r, y), k);
      }
    } else {
      if (gFront) {
        const d2 = sampleGrid(gFront, x, y);
        s = smax(s, d2 > Math.abs(z) - hd ? d2 : Math.abs(z) - hd, k);
      }
      if (gTop) {
        const d2 = sampleGrid(gTop, x, z);
        s = smax(s, d2 > Math.abs(y) - hh ? d2 : Math.abs(y) - hh, k);
      }
      if (gSide) {
        const d2 = sampleGrid(gSide, z, y);
        s = smax(s, d2 > Math.abs(x) - hw ? d2 : Math.abs(x) - hw, k);
      }
    }
    return s;
  }

  if (!cuts.length) return solidSDF;

  return function partSDF(x, y, z) {
    let s = solidSDF(x, y, z);
    for (let i = 0; i < cuts.length; i++) {
      const c = cuts[i];
      const cs = c.sdf(x + c.off.x, y + c.off.y, z + c.off.z);
      s = smax(s, -cs, k); // subtract the cut, blended with the same k
    }
    return s;
  };
}

// ---------------- Surface Nets meshing ----------------
// Naive (dual) Surface Nets: one vertex per surface-straddling cell placed at the
// average of its edge crossings, quads stitched across every sign-changing grid
// edge. Produces a watertight, evenly-tessellated mesh ideal for blobby SDFs.

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6],
  [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
];

export function surfaceNets(sdf, half, res) {
  const maxExt = Math.max(half.x, half.y, half.z) * 2;
  const cell = maxExt / res;
  const nx = Math.max(2, Math.ceil((2 * half.x) / cell));
  const ny = Math.max(2, Math.ceil((2 * half.y) / cell));
  const nz = Math.max(2, Math.ceil((2 * half.z) / cell));
  const gx = nx + 1, gy = ny + 1, gz = nz + 1;
  const minx = -half.x, miny = -half.y, minz = -half.z;

  // sample the field on every grid corner
  const vals = new Float32Array(gx * gy * gz);
  let p = 0;
  for (let k = 0; k < gz; k++) {
    const z = minz + k * cell;
    for (let j = 0; j < gy; j++) {
      const y = miny + j * cell;
      for (let i = 0; i < gx; i++) vals[p++] = sdf(minx + i * cell, y, z);
    }
  }
  const cidx = (i, j, k) => i + gx * (j + gy * k);
  const cellId = (i, j, k) => i + nx * (j + ny * k);

  // one dual vertex per surface cell
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const positions = [];
  let vcount = 0;
  const cv = new Float64Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNERS[c];
          const val = vals[cidx(i + o[0], j + o[1], k + o[2])];
          cv[c] = val;
          if (val < 0) mask |= (1 << c);
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, e = 0;
        for (let ei = 0; ei < 12; ei++) {
          const a = EDGES[ei][0], b = EDGES[ei][1];
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const oa = CORNERS[a], ob = CORNERS[b];
          sx += oa[0] + (ob[0] - oa[0]) * t;
          sy += oa[1] + (ob[1] - oa[1]) * t;
          sz += oa[2] + (ob[2] - oa[2]) * t;
          e++;
        }
        const inv = 1 / e;
        positions.push(
          minx + (i + sx * inv) * cell,
          miny + (j + sy * inv) * cell,
          minz + (k + sz * inv) * cell,
        );
        cellVert[cellId(i, j, k)] = vcount++;
      }
    }
  }

  // stitch quads across sign-changing grid edges
  const indices = [];
  // winding chosen so faces wind counter-clockwise about the OUTWARD (SDF
  // gradient points outward) normal — i.e. a valid, consistently-oriented solid.
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { indices.push(a, b, c, a, c, d); }
    else { indices.push(a, c, b, a, d, c); }
  };
  // edges along X
  for (let k = 1; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v0 = vals[cidx(i, j, k)], v1 = vals[cidx(i + 1, j, k)];
        if ((v0 < 0) === (v1 < 0)) continue;
        quad(
          cellVert[cellId(i, j - 1, k - 1)], cellVert[cellId(i, j, k - 1)],
          cellVert[cellId(i, j, k)], cellVert[cellId(i, j - 1, k)],
          v0 < 0,
        );
      }
  // edges along Y
  for (let k = 1; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const v0 = vals[cidx(i, j, k)], v1 = vals[cidx(i, j + 1, k)];
        if ((v0 < 0) === (v1 < 0)) continue;
        quad(
          cellVert[cellId(i - 1, j, k - 1)], cellVert[cellId(i, j, k - 1)],
          cellVert[cellId(i, j, k)], cellVert[cellId(i - 1, j, k)],
          v0 >= 0,
        );
      }
  // edges along Z
  for (let k = 0; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const v0 = vals[cidx(i, j, k)], v1 = vals[cidx(i, j, k + 1)];
        if ((v0 < 0) === (v1 < 0)) continue;
        quad(
          cellVert[cellId(i - 1, j - 1, k)], cellVert[cellId(i, j - 1, k)],
          cellVert[cellId(i, j, k)], cellVert[cellId(i - 1, j, k)],
          v0 < 0,
        );
      }

  // per-vertex normals straight from the SDF gradient (central differences)
  const pos = new Float32Array(positions);
  const normals = new Float32Array(pos.length);
  const eps = cell * 0.5;
  for (let v = 0; v < pos.length; v += 3) {
    const x = pos[v], y = pos[v + 1], z = pos[v + 2];
    const gxv = sdf(x + eps, y, z) - sdf(x - eps, y, z);
    const gyv = sdf(x, y + eps, z) - sdf(x, y - eps, z);
    const gzv = sdf(x, y, z + eps) - sdf(x, y, z - eps);
    let l = Math.sqrt(gxv * gxv + gyv * gyv + gzv * gzv) || 1;
    normals[v] = gxv / l; normals[v + 1] = gyv / l; normals[v + 2] = gzv / l;
  }

  return { positions: pos, normals, indices: new Uint32Array(indices) };
}

// ---------------- top-level entry ----------------
// Compile + mesh a part descriptor. `res` is the cell count along the longest
// axis (96 interactive, 192 for export). Returns typed arrays ready for a
// BufferGeometry — and transferable across the worker boundary.

export function meshPart(desc) {
  const box = desc.box;
  const margin = gridMargin(desc.k || 0);
  const half = { x: box.hw + margin, y: box.hh + margin, z: box.hd + margin };
  const sdf = compilePart(desc);
  return surfaceNets(sdf, half, desc.res || 96);
}
