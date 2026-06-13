// Sketch interpretation ("Clean up"): turns a wobbly closed freehand polygon
// into crisp straight lines, true circular arcs, and tangent corner fillets.
//
// Interpreted profiles are stored as a "seg path" object inside
// layer.paths[view] (where plain point arrays used to live):
//
//   {
//     fmt: 'segs',
//     aspect,                  // box hw/hh at interpretation time
//     start: {x,y},
//     segs: [ {t:'l', x,y} | {t:'a', x,y, cx,cy, ccw} ],
//     base: { verts: [...], segs: [...] },  // pre-fillet skeleton
//     cornerR: [...],          // fillet radius per base vertex (0 = sharp)
//     raw: [ {x,y}... ],       // the original normalized polygon (Q toggles back)
//   }
//
// Coordinates inside the seg path live in "u space": normalized box coords
// with x multiplied by `aspect`, so circles are truly circular regardless of
// the box proportions. tessellatePath() maps back to normalized coords, so
// the rest of the app (drawing, CSG meshing, export) keeps consuming plain
// point arrays — the interpreted result stays resolution-independent until
// that moment.

const TAU = Math.PI * 2;

export function isSegPath(p) {
  return !!p && !Array.isArray(p) && p.fmt === 'segs';
}

// ---------------- tessellation ----------------

const tessCache = new WeakMap();

export function invalidateTessellation(segPath) {
  tessCache.delete(segPath);
}

// Returns a plain normalized point array for any stored path entry.
export function tessellatePath(path, maxAngle = 0.14) {
  if (Array.isArray(path)) return path;
  if (!isSegPath(path)) return [];
  const hit = tessCache.get(path);
  if (hit) return hit;
  let pts;
  try {
    pts = tessellateSegs(path.start, path.segs, maxAngle)
      .map((p) => ({ x: p.x / (path.aspect || 1), y: p.y }));
  } catch {
    pts = path.raw ? path.raw.slice() : [];
  }
  tessCache.set(path, pts);
  return pts;
}

// Walk start -> segs in u space. The last seg lands back on start (closed);
// the duplicate closing point is dropped.
function tessellateSegs(start, segs, maxAngle) {
  const out = [{ x: start.x, y: start.y }];
  let cur = start;
  for (const s of segs) {
    const end = { x: s.x, y: s.y };
    if (s.t === 'a') {
      const c = { x: s.cx, y: s.cy };
      const r = (hyp2(cur, c) + hyp2(end, c)) / 2;
      const a0 = Math.atan2(cur.y - c.y, cur.x - c.x);
      const a1 = Math.atan2(end.y - c.y, end.x - c.x);
      let sweep = s.ccw ? mod2pi(a1 - a0) : -mod2pi(a0 - a1);
      // coincident endpoints with a real radius = full circle
      if (Math.abs(sweep) < 1e-6 && hyp2(cur, end) < r * 1e-3) sweep = s.ccw ? TAU : -TAU;
      const n = Math.max(2, Math.min(96, Math.ceil(Math.abs(sweep) / maxAngle)));
      for (let i = 1; i < n; i++) {
        const a = a0 + sweep * (i / n);
        out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
      }
    }
    out.push(end);
    cur = end;
  }
  // last point closes onto start
  if (out.length > 1 && hyp2(out[out.length - 1], out[0]) < 1e-9) out.pop();
  return out;
}

function hyp2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mod2pi(a) { return ((a % TAU) + TAU) % TAU; }
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }

// ---------------- public entry ----------------

// pathPts: a stored normalized polygon. aspect = hw/hh of the layer box in
// this view. pxPerUnit converts u-space lengths to screen pixels, so every
// tolerance scales with how the user actually saw the stroke.
// Returns a seg path, or null when the stroke reads as organic / too small.
export function interpretStoredPath(pathPts, aspect, pxPerUnit) {
  try {
    if (!Array.isArray(pathPts) || pathPts.length < 8) return null;
    if (!isFinite(aspect) || aspect <= 0) aspect = 1;
    if (!isFinite(pxPerUnit) || pxPerUnit <= 0) return null;
    const u = pathPts.map((p) => ({ x: p.x * aspect, y: p.y }));
    const res = interpretPolygon(u, pxPerUnit);
    if (!res) return null;
    const r5 = (v) => +v.toFixed(5);
    const rp = (p) => ({ x: r5(p.x), y: r5(p.y) });
    const rseg = (s) => s.t === 'a'
      ? { t: 'a', x: r5(s.x), y: r5(s.y), cx: r5(s.cx), cy: r5(s.cy), ccw: !!s.ccw }
      : { t: 'l', x: r5(s.x), y: r5(s.y) };
    return {
      fmt: 'segs',
      aspect: r5(aspect),
      start: rp(res.start),
      segs: res.segs.map(rseg),
      base: { verts: res.base.verts.map(rp), segs: res.base.segs.map(rseg) },
      cornerR: res.cornerR.map(r5),
      raw: pathPts.map((p) => ({ x: p.x, y: p.y })),
    };
  } catch (err) {
    console.warn('interpretation failed, keeping raw stroke', err);
    return null;
  }
}

// ---------------- pipeline ----------------

function interpretPolygon(input, pxPerUnit) {
  const px = 1 / pxPerUnit; // length of one screen pixel in u space

  const P0 = dedupe(input, px * 0.05);
  const perim = perimeter(P0);
  if (perim < px * 40) return null;

  // 1. uniform resampling so windowed curvature is stable
  const step = clamp(perim / 200, px * 1.2, px * 9);
  const N = Math.round(perim / step);
  if (N < 32) return null;
  let P = resampleClosed(P0, N);

  // 2. symmetry pre-pass about the box vertical centerline (x = 0)
  const symmetric = detectSymmetry(P, px);
  if (symmetric) P = symmetrize(P);

  const ctx = makeCtx(P, step, px);

  // 3. split at curvature peaks, then refine recursively until each range
  //    is well-fit by a line or a circular arc
  let ranges = seedRanges(ctx);
  ranges = ranges.flatMap((r) => refineRange(ctx, r.i0, r.n, 0));

  // 4. nudge boundaries to the split that fits best, then merge fragments
  refineBoundaries(ctx, ranges);
  ranges = mergeRanges(ctx, ranges);
  refineBoundaries(ctx, ranges);
  ranges = mergeRanges(ctx, ranges);

  // 5. quality gate: organic strokes stay raw
  if (ranges.length > 12) return null;
  let errSum = 0, lenSum = 0;
  for (const r of ranges) { errSum += r.fit.err * r.fit.len; lenSum += r.fit.len; }
  if (lenSum < 1e-9 || errSum / lenSum > px * 3.2) return null;

  const prims = ranges.map((r) => toPrim(ctx, r));

  // whole stroke is one circle
  if (prims.length === 1) {
    if (prims[0].kind !== 'arc') return null;
    return finalizeCircle(prims[0]);
  }
  if (prims.length < 2) return null;

  // 6. constraint snapping: H/V/45 line directions, arc-line tangency
  for (const p of prims) if (p.kind === 'line') snapLineDirection(p);
  snapTangencies(prims, px);

  // 7. fillet detection: a short arc between two lines is a rounded corner
  const { baseSegsRaw, fillets } = extractFillets(ctx, prims);
  if (baseSegsRaw.length < 2) {
    // e.g. a stadium shape collapsed to one line + one arc — keep generic path
    baseSegsRaw.length = 0;
    for (const p of prims) baseSegsRaw.push({ prim: p, filletR: 0 });
  }
  clusterRadii(fillets);

  // 8. base vertices = junctions between consecutive primitives
  const verts = buildVertices(ctx, baseSegsRaw, px);
  if (!verts) return null;

  // 9. alignment / near-equal-length snapping + symmetry perfecting
  clusterVertexCoords(baseSegsRaw, verts, px);
  if (symmetric) symmetrizeVertices(baseSegsRaw, verts, px);

  const base = finalizeBase(baseSegsRaw, verts);
  if (!base) return null;
  const cornerR = baseSegsRaw.map((b) => b.filletR || 0);

  const result = applyFillets(base, cornerR);
  if (!result) return null;

  // 10. sanity: the interpreted outline must still hug the stroke
  const tess = tessellateSegs(result.start, result.segs, 0.2);
  if (tess.length < 3) return null;
  const dev = deviation(P, tess);
  if (dev.mean > px * 4.5 || dev.max > px * 14) return null;

  return { start: result.start, segs: result.segs, base, cornerR };
}

// ---------------- sampling & curvature ----------------

function dedupe(pts, eps) {
  const out = [];
  for (const p of pts) {
    if (!out.length || hyp2(p, out[out.length - 1]) > eps) out.push(p);
  }
  while (out.length > 1 && hyp2(out[0], out[out.length - 1]) <= eps) out.pop();
  return out;
}

function perimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += hyp2(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

function resampleClosed(pts, n) {
  const per = perimeter(pts);
  const step = per / n;
  const out = [];
  let i = 0, acc = 0, want = 0;
  let a = pts[0], b = pts[1 % pts.length];
  let segLen = hyp2(a, b);
  for (let k = 0; k < n; k++) {
    want = k * step;
    while (acc + segLen < want) {
      acc += segLen;
      i++;
      a = pts[i % pts.length];
      b = pts[(i + 1) % pts.length];
      segLen = hyp2(a, b);
    }
    const t = segLen > 1e-12 ? (want - acc) / segLen : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function makeCtx(P, step, px) {
  const N = P.length;
  const k = Math.max(2, Math.round((px * 10) / step));
  const turnW = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const pm = P[(i - k + N) % N], p = P[i], pp = P[(i + k) % N];
    const a1 = Math.atan2(pp.y - p.y, pp.x - p.x);
    const a0 = Math.atan2(p.y - pm.y, p.x - pm.x);
    turnW[i] = angDiff(a1, a0);
  }
  return {
    P, N, step, px, k, turnW,
    minSamples: Math.max(5, Math.round((px * 12) / step)),
    tol: (len) => px * (1.3 + Math.min(2.4, (len / px) * 0.009)),
  };
}

// Initial segmentation. Splitting AT curvature peaks cuts every fillet down the
// middle (so "line + fillet + line" fits as one line or one arc and the fillet
// is lost). Instead we segment by curvature REGIONS: contiguous runs where the
// stroke is turning become their own ranges (a fillet/arc isolated between its
// tangent points), and the straight runs between them become line ranges. Short
// intense runs are sharp corners — a single split, no arc. Recursive refinement
// downstream still recovers large smooth arcs hiding inside a "straight" run.
function seedRanges(ctx) {
  const { N, P, turnW, k, step, px } = ctx;
  const TH = 0.18; // rad of windowed turn that counts as "turning"
  const turning = new Uint8Array(N);
  let anyTurn = false, anyStraight = false;
  for (let i = 0; i < N; i++) {
    turning[i] = Math.abs(turnW[i]) > TH ? 1 : 0;
    if (turning[i]) anyTurn = true; else anyStraight = true;
  }
  // uniform curvature (circle / ellipse) or dead straight: let peak-seeding +
  // recursion handle it
  if (!anyTurn || !anyStraight) return seedByPeaks(ctx);

  // start the scan on a straight sample so runs never wrap the seam
  let s0 = 0;
  while (s0 < N && turning[s0]) s0++;
  if (s0 === N) return seedByPeaks(ctx);
  const real = (shifted) => (s0 + shifted) % N;

  const runs = [];
  for (let i = 0; i < N;) {
    if (turning[real(i)]) {
      const a = i;
      while (i < N && turning[real(i)]) i++;
      runs.push({ a, b: i - 1 });
    } else i++;
  }
  if (runs.length < 2) return seedByPeaks(ctx);

  // turn each run into boundary indices. Discriminate sharp corner vs rounded
  // fillet by the radius the raw stroke actually traces through the turn
  // (arc length / net tangent change). A rounded transition spread over real
  // distance becomes its own arc range; a sharp corner is a single split.
  const tangentAt = (idx) => {
    const a = P[(idx - k + N) % N], b = P[(idx + k) % N];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const bounds = new Set();
  for (const run of runs) {
    const net = Math.abs(angDiff(tangentAt(real(run.b)), tangentAt(real(run.a))));
    const arcLen = (run.b - run.a + 1) * step;
    const radius = arcLen / Math.max(net, 0.05);
    if (radius > px * 5 && net > 0.3) {
      bounds.add(real(run.a));
      bounds.add(real((run.b + 1) % N));
    } else {
      let peak = run.a, best = -1;
      for (let j = run.a; j <= run.b; j++) {
        const t = Math.abs(turnW[real(j)]);
        if (t > best) { best = t; peak = j; }
      }
      bounds.add(real(peak));
    }
  }
  const list = [...bounds].sort((x, y) => x - y);
  if (list.length < 2) return seedByPeaks(ctx);
  const ranges = [];
  for (let j = 0; j < list.length; j++) {
    const i0 = list[j];
    const i1 = list[(j + 1) % list.length];
    ranges.push({ i0, n: ((i1 - i0 + N) % N) + 1 });
  }
  return ranges;
}

// Legacy seeding: split at non-max-suppressed curvature peaks. Still used for
// smooth shapes (circles/ellipses) where there are no distinct turn regions.
function seedByPeaks(ctx) {
  const { N, turnW, k } = ctx;
  const peaks = [];
  for (let i = 0; i < N; i++) {
    const t = Math.abs(turnW[i]);
    if (t < 0.55) continue;
    let isMax = true;
    for (let d = -2 * k; d <= 2 * k; d++) {
      if (d === 0) continue;
      const o = Math.abs(turnW[(i + d + N) % N]);
      if (o > t || (o === t && d < 0)) { isMax = false; break; }
    }
    if (isMax) peaks.push(i);
  }
  if (peaks.length < 2) {
    // smooth closed shape — start with two arbitrary halves, recursion sorts it out
    let m = 0;
    for (let i = 0; i < N; i++) if (Math.abs(turnW[i]) > Math.abs(turnW[m])) m = i;
    peaks.length = 0;
    peaks.push(m, (m + (N >> 1)) % N);
    peaks.sort((a, b) => a - b);
  }
  const ranges = [];
  for (let j = 0; j < peaks.length; j++) {
    const i0 = peaks[j];
    const i1 = peaks[(j + 1) % peaks.length];
    const n = ((i1 - i0 + N) % N) + 1;
    ranges.push({ i0, n });
  }
  return ranges;
}

function rangePts(ctx, i0, n) {
  const out = new Array(n);
  for (let j = 0; j < n; j++) out[j] = ctx.P[(i0 + j) % ctx.N];
  return out;
}

// ---------------- primitive fitting ----------------

function fitLine(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  sxx /= n; sxy /= n; syy /= n;
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d = { x: Math.cos(ang), y: Math.sin(ang) };
  const half = (sxx + syy) / 2;
  const eigMin = half - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  return { p: { x: mx, y: my }, d, err: Math.sqrt(Math.max(0, eigMin)) };
}

// Kasa algebraic circle fit.
function fitCircle(pts) {
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * z; syz += p.y * z; sz += z;
  }
  // solve [sxx sxy sx; sxy syy sy; sx sy n] * [D E F]' = [sxz syz sz]'
  const sol = solve3(
    [sxx, sxy, sx, sxz],
    [sxy, syy, sy, syz],
    [sx, sy, n, sz],
  );
  if (!sol) return null;
  const [D, E, F] = sol;
  const cx = D / 2, cy = E / 2;
  const r2 = F + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let err = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy) - r;
    err += d * d;
  }
  return { c: { x: cx, y: cy }, r, err: Math.sqrt(err / n) };
}

function solve3(r0, r1, r2) {
  const m = [r0.slice(), r1.slice(), r2.slice()];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

function polylineLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += hyp2(pts[i], pts[i - 1]);
  return s;
}

function totalTurn(pts) {
  let s = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a0 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    const a1 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    s += angDiff(a1, a0);
  }
  return s;
}

// Pick line or arc for a sample range, with a bias toward lines.
function bestFit(ctx, i0, n) {
  const pts = rangePts(ctx, i0, n);
  const len = polylineLen(pts);
  const line = fitLine(pts);
  const turn = totalTurn(pts);
  let circ = null;
  if (n >= 6 && Math.abs(turn) > 0.12) {
    const c = fitCircle(pts);
    if (c && c.r < len * 25 && c.r > ctx.px * 2) circ = c;
  }
  const useLine = !circ || line.err <= Math.max(ctx.px * 0.55, circ.err * 1.3);
  if (useLine) return { kind: 'line', line, err: line.err, len, turn };
  return { kind: 'arc', circ, err: circ.err, len, turn };
}

function refineRange(ctx, i0, n, depth) {
  const fit = bestFit(ctx, i0, n);
  if (fit.err <= ctx.tol(fit.len) || n <= ctx.minSamples * 2 || depth > 20) {
    return [{ i0, n, fit }];
  }
  // split where the windowed curvature peaks (away from the ends)
  const m = Math.max(2, Math.min(ctx.k, n >> 2));
  let best = -1, at = m + (n >> 1) % (n - 2 * m);
  for (let j = m; j < n - m; j++) {
    const t = Math.abs(ctx.turnW[(i0 + j) % ctx.N]);
    if (t > best) { best = t; at = j; }
  }
  if (at <= 2 || at >= n - 3) at = n >> 1;
  return [
    ...refineRange(ctx, i0, at + 1, depth + 1),
    ...refineRange(ctx, (i0 + at) % ctx.N, n - at, depth + 1),
  ];
}

// shift each shared boundary a few samples to minimize combined error
function refineBoundaries(ctx, ranges) {
  const R = ranges.length;
  if (R < 2) return;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < R; j++) {
      const a = ranges[j], b = ranges[(j + 1) % R];
      let bestCost = Infinity, bestD = 0;
      for (let d = -ctx.k; d <= ctx.k; d++) {
        const na = a.n + d, nb = b.n - d;
        if (na < ctx.minSamples || nb < ctx.minSamples) continue;
        const fa = bestFit(ctx, a.i0, na);
        const fb = bestFit(ctx, (b.i0 + d + ctx.N) % ctx.N, nb);
        const cost = fa.err * fa.err * na + fb.err * fb.err * nb;
        if (cost < bestCost) { bestCost = cost; bestD = d; }
      }
      if (bestD !== 0) {
        a.n += bestD;
        b.i0 = (b.i0 + bestD + ctx.N) % ctx.N;
        b.n -= bestD;
        a.fit = bestFit(ctx, a.i0, a.n);
        b.fit = bestFit(ctx, b.i0, b.n);
      } else {
        a.fit = a.fit ?? bestFit(ctx, a.i0, a.n);
        b.fit = b.fit ?? bestFit(ctx, b.i0, b.n);
      }
    }
  }
}

// merge neighbors that re-fit as one primitive (split residue, arc fragments)
function mergeRanges(ctx, ranges) {
  let merged = true;
  let list = ranges.slice();
  while (merged && list.length > 2) {
    merged = false;
    for (let j = 0; j < list.length; j++) {
      const a = list[j], b = list[(j + 1) % list.length];
      const i0 = a.i0, n = a.n + b.n - 1;
      if (n >= ctx.N) break;
      const fit = bestFit(ctx, i0, n);
      const sameKind = a.fit.kind === b.fit.kind;
      const allow = fit.err <= ctx.tol(fit.len) * (sameKind ? 1.05 : 0.85);
      if (allow) {
        const nu = { i0, n, fit };
        if (j + 1 < list.length) list.splice(j, 2, nu);
        else { list.splice(j, 1); list.splice(0, 1); list.push(nu); }
        merged = true;
        break;
      }
    }
  }
  return list;
}

function toPrim(ctx, r) {
  const f = r.fit;
  if (f.kind === 'line') {
    return { kind: 'line', p: f.line.p, d: f.line.d, i0: r.i0, n: r.n, len: f.len };
  }
  return {
    kind: 'arc', c: f.circ.c, r: f.circ.r, ccw: f.turn > 0,
    i0: r.i0, n: r.n, len: f.len, sweep: Math.abs(f.turn),
  };
}

// ---------------- constraint snapping ----------------

const SNAP_ANGLE = (6 * Math.PI) / 180;

function snapLineDirection(prim) {
  const ang = Math.atan2(prim.d.y, prim.d.x);
  for (let k = -4; k <= 4; k++) {
    const target = (k * Math.PI) / 4;
    if (Math.abs(angDiff(ang, target)) <= SNAP_ANGLE) {
      prim.d = { x: Math.cos(target), y: Math.sin(target) };
      // exact zeros for H/V so coordinates come out clean
      if (Math.abs(prim.d.x) < 1e-9) prim.d.x = 0;
      if (Math.abs(prim.d.y) < 1e-9) prim.d.y = 0;
      return;
    }
  }
}

function distPointLine(pt, line) {
  const nx = -line.d.y, ny = line.d.x;
  return (pt.x - line.p.x) * nx + (pt.y - line.p.y) * ny; // signed
}

// where an arc meets a line nearly tangentially, shift the arc center so the
// contact is exactly tangent
function snapTangencies(prims, px) {
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < prims.length; j++) {
      const a = prims[j], b = prims[(j + 1) % prims.length];
      const pair = a.kind === 'line' && b.kind === 'arc' ? [a, b]
        : a.kind === 'arc' && b.kind === 'line' ? [b, a] : null;
      if (!pair) continue;
      const [line, arc] = pair;
      const d = distPointLine(arc.c, line);
      const gap = Math.abs(Math.abs(d) - arc.r);
      if (gap > px * 4 || gap < 1e-9) continue;
      const sign = d >= 0 ? 1 : -1;
      const nx = -line.d.y, ny = line.d.x;
      const shift = sign * arc.r - d;
      arc.c = { x: arc.c.x + nx * shift, y: arc.c.y + ny * shift };
    }
  }
}

// ---------------- fillets ----------------

// a short arc sandwiched between two lines reads as a rounded corner
function extractFillets(ctx, prims) {
  const M = prims.length;
  const baseSegsRaw = [];
  const fillets = [];
  for (let j = 0; j < M; j++) {
    const p = prims[j];
    if (p.kind === 'arc' && M >= 3) {
      const prev = prims[(j - 1 + M) % M], next = prims[(j + 1) % M];
      const isFillet = prev.kind === 'line' && next.kind === 'line'
        && p.len < Math.min(prev.len, next.len) * 0.8
        && p.sweep > 0.15 && p.sweep < 2.7;
      if (isFillet) {
        // the corner folds into the PREVIOUS base seg's end vertex
        const entry = { filletR: p.r, filletRaw: ctx.P[(p.i0 + (p.n >> 1)) % ctx.N] };
        fillets.push(entry);
        baseSegsRaw.push({ pendingFillet: entry });
        continue;
      }
    }
    baseSegsRaw.push({ prim: p, filletR: 0 });
  }
  // fold fillet markers onto the following real segment's start vertex
  const folded = [];
  let pending = null;
  for (const e of baseSegsRaw) {
    if (e.pendingFillet) { pending = e.pendingFillet; continue; }
    if (pending) { e.filletR = pending.filletR; e.filletRaw = pending.filletRaw; pending = null; }
    folded.push(e);
  }
  if (pending && folded.length) { folded[0].filletR = pending.filletR; folded[0].filletRaw = pending.filletRaw; }
  return { baseSegsRaw: folded, fillets };
}

// cluster similar fillet radii (within 20%) to a shared value so corners match
function clusterRadii(fillets) {
  const items = fillets.filter((f) => f.filletR > 0).sort((a, b) => a.filletR - b.filletR);
  let cluster = [];
  const flush = () => {
    if (cluster.length < 2) { cluster = []; return; }
    const mean = cluster.reduce((s, f) => s + f.filletR, 0) / cluster.length;
    for (const f of cluster) f.filletR = mean;
    cluster = [];
  };
  for (const f of items) {
    if (!cluster.length || f.filletR <= cluster[0].filletR * 1.2) cluster.push(f);
    else { flush(); cluster.push(f); }
  }
  flush();
}

// ---------------- junction construction ----------------

function lineLineIntersect(a, b) {
  const det = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(det) < 1e-6) return null;
  const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y;
  const t = (dx * b.d.y - dy * b.d.x) / det;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}

function lineCircleJunction(line, arc, raw, px) {
  const d = distPointLine(arc.c, line);
  const foot = {
    x: arc.c.x - (-line.d.y) * d,
    y: arc.c.y - (line.d.x) * d,
  };
  const ad = Math.abs(d);
  if (ad >= arc.r) return foot; // tangent (or detached): contact at the foot
  const h = Math.sqrt(Math.max(0, arc.r * arc.r - d * d));
  const i1 = { x: foot.x + line.d.x * h, y: foot.y + line.d.y * h };
  const i2 = { x: foot.x - line.d.x * h, y: foot.y - line.d.y * h };
  return hyp2(i1, raw) <= hyp2(i2, raw) ? i1 : i2;
}

function circleCircleJunction(a, b, raw) {
  const dx = b.c.x - a.c.x, dy = b.c.y - a.c.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > a.r + b.r || d < Math.abs(a.r - b.r)) return raw;
  const t = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
  const h2 = a.r * a.r - t * t;
  const h = Math.sqrt(Math.max(0, h2));
  const mx = a.c.x + (dx / d) * t, my = a.c.y + (dy / d) * t;
  const i1 = { x: mx + (-dy / d) * h, y: my + (dx / d) * h };
  const i2 = { x: mx - (-dy / d) * h, y: my - (dx / d) * h };
  return hyp2(i1, raw) <= hyp2(i2, raw) ? i1 : i2;
}

// vertex j sits between base seg j-1 and base seg j
function buildVertices(ctx, baseSegsRaw, px) {
  const V = baseSegsRaw.length;
  const verts = new Array(V);
  for (let j = 0; j < V; j++) {
    const prev = baseSegsRaw[(j - 1 + V) % V].prim;
    const cur = baseSegsRaw[j].prim;
    // raw junction: where this segment's samples begin (or the saved corner apex)
    const raw = baseSegsRaw[j].filletRaw ?? ctx.P[cur.i0 % ctx.N];
    let v = null;
    if (prev.kind === 'line' && cur.kind === 'line') {
      v = lineLineIntersect(prev, cur);
      if (v && hyp2(v, raw) > Math.max(prev.len, cur.len)) v = null; // wild intersection
    } else if (prev.kind === 'line' && cur.kind === 'arc') {
      v = lineCircleJunction(prev, cur, raw, px);
    } else if (prev.kind === 'arc' && cur.kind === 'line') {
      v = lineCircleJunction(cur, prev, raw, px);
    } else {
      v = circleCircleJunction(prev, cur, raw);
    }
    verts[j] = v ?? { x: raw.x, y: raw.y };
    if (!isFinite(verts[j].x) || !isFinite(verts[j].y)) return null;
  }
  return verts;
}

// snap near-equal coordinates among line-line vertices: this is what makes
// near-equal edge lengths exactly equal without ever breaking closure
function clusterVertexCoords(baseSegsRaw, verts, px) {
  const V = verts.length;
  const eligible = [];
  for (let j = 0; j < V; j++) {
    const prev = baseSegsRaw[(j - 1 + V) % V].prim;
    const cur = baseSegsRaw[j].prim;
    if (prev.kind === 'line' && cur.kind === 'line') eligible.push(j);
  }
  for (const axis of ['x', 'y']) {
    const sorted = eligible.slice().sort((a, b) => verts[a][axis] - verts[b][axis]);
    let cluster = [];
    const flush = () => {
      if (cluster.length >= 2) {
        const mean = cluster.reduce((s, j) => s + verts[j][axis], 0) / cluster.length;
        for (const j of cluster) verts[j][axis] = mean;
      }
      cluster = [];
    };
    for (const j of sorted) {
      if (!cluster.length || verts[j][axis] - verts[cluster[0]][axis] <= px * 5) cluster.push(j);
      else { flush(); cluster.push(j); }
    }
    flush();
  }
}

// ---------------- symmetry ----------------

function detectSymmetry(P, px) {
  const N = P.length;
  const stride = Math.max(1, N >> 6);
  let sum = 0, max = 0, count = 0;
  for (let i = 0; i < N; i += stride) {
    const m = { x: -P[i].x, y: P[i].y };
    const d = distToPolygon(m, P);
    sum += d; max = Math.max(max, d); count++;
  }
  return sum / count < px * 3 && max < px * 9;
}

function distToPolygon(p, P) {
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    best = Math.min(best, distToSeg(p, a, b));
    if (best === 0) break;
  }
  return best;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function symmetrize(P) {
  return P.map((p) => {
    const m = { x: -p.x, y: p.y };
    const q = closestOnPolygon(m, P);
    return { x: (p.x - q.x) / 2, y: (p.y + q.y) / 2 };
  });
}

function closestOnPolygon(p, P) {
  let best = Infinity, bp = P[0];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = hyp2(p, q);
    if (d < best) { best = d; bp = q; }
  }
  return bp;
}

// perfect mirrored vertex pairs about x = 0
function symmetrizeVertices(baseSegsRaw, verts, px) {
  const V = verts.length;
  const used = new Set();
  for (let i = 0; i < V; i++) {
    if (used.has(i)) continue;
    const m = { x: -verts[i].x, y: verts[i].y };
    if (Math.abs(verts[i].x) < px * 4) { verts[i].x = 0; used.add(i); continue; }
    let bj = -1, bd = Infinity;
    for (let j = 0; j < V; j++) {
      if (j === i || used.has(j)) continue;
      const d = hyp2(m, verts[j]);
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj >= 0 && bd < px * 8) {
      const ax = (Math.abs(verts[i].x) + Math.abs(verts[bj].x)) / 2;
      const ay = (verts[i].y + verts[bj].y) / 2;
      verts[i] = { x: Math.sign(verts[i].x) * ax, y: ay };
      verts[bj] = { x: Math.sign(verts[bj].x) * ax, y: ay };
      // pair up mirrored fillet radii too
      const ri = baseSegsRaw[i].filletR, rj = baseSegsRaw[bj].filletR;
      if (ri > 0 && rj > 0) baseSegsRaw[i].filletR = baseSegsRaw[bj].filletR = (ri + rj) / 2;
      used.add(i); used.add(bj);
    }
  }
}

// ---------------- base path & fillet application ----------------

// base seg j connects vert j -> vert j+1
function finalizeBase(baseSegsRaw, verts) {
  const V = verts.length;
  const segs = new Array(V);
  for (let j = 0; j < V; j++) {
    const prim = baseSegsRaw[j].prim;
    const a = verts[j], b = verts[(j + 1) % V];
    if (prim.kind === 'line') {
      segs[j] = { t: 'l', x: b.x, y: b.y };
      continue;
    }
    // re-center the arc so it passes exactly through both vertices at radius r
    const chord = hyp2(a, b);
    if (chord < 1e-9) {
      segs[j] = { t: 'a', x: b.x, y: b.y, cx: prim.c.x, cy: prim.c.y, ccw: prim.ccw };
      continue;
    }
    let r = Math.max(prim.r, chord / 2 + 1e-9);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
    const nx = -(b.y - a.y) / chord, ny = (b.x - a.x) / chord;
    const c1 = { x: mx + nx * h, y: my + ny * h };
    const c2 = { x: mx - nx * h, y: my - ny * h };
    let c = hyp2(c1, prim.c) <= hyp2(c2, prim.c) ? c1 : c2;
    // major arcs (sweep > pi) must keep the center on the matching side
    if (prim.sweep > Math.PI) {
      const want = prim.ccw ? -1 : 1; // center sits right of travel for ccw minor... pick by sample check below
      const mid = midOfArc(a, b, c, prim.ccw);
      // if the reconstructed minor arc midpoint is far from the fitted circle's
      // sampled side, flip to the other center
      const altMid = midOfArc(a, b, c === c1 ? c2 : c1, prim.ccw);
      if (hyp2(altMid, prim.c) < hyp2(mid, prim.c) - 1e-9) c = (c === c1 ? c2 : c1);
      void want;
    }
    segs[j] = { t: 'a', x: b.x, y: b.y, cx: c.x, cy: c.y, ccw: prim.ccw };
    if (!isFinite(c.x) || !isFinite(c.y)) return null;
  }
  return { verts: verts.map((v) => ({ x: v.x, y: v.y })), segs };
}

function midOfArc(a, b, c, ccw) {
  const r = (hyp2(a, c) + hyp2(b, c)) / 2;
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const a1 = Math.atan2(b.y - c.y, b.x - c.x);
  const sweep = ccw ? mod2pi(a1 - a0) : -mod2pi(a0 - a1);
  const am = a0 + sweep / 2;
  return { x: c.x + Math.cos(am) * r, y: c.y + Math.sin(am) * r };
}

// Replace base corners that have a radius with tangent arcs.
// Exported so [ / ] can rebuild the path live as the radius changes.
export function applyFillets(base, cornerR) {
  const V = base.verts.length;
  if (!V || base.segs.length !== V) return null;
  const verts = base.verts;
  // per-vertex contribution: either the sharp vertex, or {pa, arc, pb}
  const contrib = new Array(V);
  for (let j = 0; j < V; j++) {
    const v = verts[j];
    const segIn = base.segs[(j - 1 + V) % V], segOut = base.segs[j];
    const r0 = cornerR[j] || 0;
    if (r0 <= 0 || segIn.t !== 'l' || segOut.t !== 'l') { contrib[j] = { pt: v }; continue; }
    const vPrev = verts[(j - 1 + V) % V], vNext = verts[(j + 1) % V];
    const lenIn = hyp2(v, vPrev), lenOut = hyp2(vNext, v);
    if (lenIn < 1e-9 || lenOut < 1e-9) { contrib[j] = { pt: v }; continue; }
    const dIn = { x: (v.x - vPrev.x) / lenIn, y: (v.y - vPrev.y) / lenIn };
    const dOut = { x: (vNext.x - v.x) / lenOut, y: (vNext.y - v.y) / lenOut };
    const dot = -(dIn.x * dOut.x + dIn.y * dOut.y);
    const phi = Math.acos(Math.max(-1, Math.min(1, dot))); // interior angle
    if (phi < 0.2 || phi > Math.PI - 0.05) { contrib[j] = { pt: v }; continue; }
    let t = r0 / Math.tan(phi / 2);
    const avail = 0.45 * Math.min(lenIn, lenOut);
    let r = r0;
    if (t > avail) { t = avail; r = t * Math.tan(phi / 2); }
    if (r < 1e-6) { contrib[j] = { pt: v }; continue; }
    const u1 = { x: -dIn.x, y: -dIn.y };
    const bis = { x: u1.x + dOut.x, y: u1.y + dOut.y };
    const bl = Math.hypot(bis.x, bis.y);
    if (bl < 1e-9) { contrib[j] = { pt: v }; continue; }
    const c = {
      x: v.x + (bis.x / bl) * (r / Math.sin(phi / 2)),
      y: v.y + (bis.y / bl) * (r / Math.sin(phi / 2)),
    };
    contrib[j] = {
      pa: { x: v.x - dIn.x * t, y: v.y - dIn.y * t },
      pb: { x: v.x + dOut.x * t, y: v.y + dOut.y * t },
      arc: { cx: c.x, cy: c.y, ccw: (dIn.x * dOut.y - dIn.y * dOut.x) > 0 },
    };
  }
  // stitch: connector before vertex j is base seg j-1
  const segs = [];
  let start = null, started = false;
  const connSeg = (j, p) => {
    const s = base.segs[(j - 1 + V) % V];
    return s.t === 'a'
      ? { t: 'a', x: p.x, y: p.y, cx: s.cx, cy: s.cy, ccw: s.ccw }
      : { t: 'l', x: p.x, y: p.y };
  };
  for (let j = 0; j < V; j++) {
    const c = contrib[j];
    const entry = c.pt ?? c.pa;
    if (!started) { start = entry; started = true; }
    else segs.push(connSeg(j, entry));
    if (c.arc) segs.push({ t: 'a', x: c.pb.x, y: c.pb.y, cx: c.arc.cx, cy: c.arc.cy, ccw: c.arc.ccw });
  }
  segs.push(connSeg(0, start)); // close the loop
  return { start, segs };
}

function finalizeCircle(prim) {
  const c = prim.c, r = prim.r;
  const start = { x: c.x + r, y: c.y };
  const opposite = { x: c.x - r, y: c.y };
  const ccw = prim.ccw;
  const segs = [
    { t: 'a', x: opposite.x, y: opposite.y, cx: c.x, cy: c.y, ccw },
    { t: 'a', x: start.x, y: start.y, cx: c.x, cy: c.y, ccw },
  ];
  const verts = [start, opposite];
  return { start, segs, base: { verts, segs: segs.map((s) => ({ ...s })) }, cornerR: [0, 0] };
}

// how far the interpreted outline strays from the resampled stroke
function deviation(P, tess) {
  const stride = Math.max(1, P.length >> 6);
  let sum = 0, max = 0, count = 0;
  for (let i = 0; i < P.length; i += stride) {
    const d = distToPolygon(P[i], tess);
    sum += d; max = Math.max(max, d); count++;
  }
  return { mean: sum / count, max };
}

// ---------------- live corner radius ([ / ]) ----------------

// Nudge every rounded corner's radius by one shared step (so clustered
// corners stay matched). When the path has no rounding yet, "]" seeds all
// line-line corners with a starter radius — same feel as Phase 1 rects.
export function adjustSegPathRadius(segPath, dir) {
  if (!isSegPath(segPath) || !segPath.base) return false;
  const base = segPath.base;
  const V = base.verts.length;
  const cornerR = segPath.cornerR ?? new Array(V).fill(0);
  const maxRs = new Array(V).fill(0);
  let globalMax = 0;
  for (let j = 0; j < V; j++) {
    const segIn = base.segs[(j - 1 + V) % V], segOut = base.segs[j];
    if (segIn.t !== 'l' || segOut.t !== 'l') continue;
    const v = base.verts[j], vp = base.verts[(j - 1 + V) % V], vn = base.verts[(j + 1) % V];
    const lenIn = hyp2(v, vp), lenOut = hyp2(vn, v);
    const dIn = { x: (v.x - vp.x) / (lenIn || 1), y: (v.y - vp.y) / (lenIn || 1) };
    const dOut = { x: (vn.x - v.x) / (lenOut || 1), y: (vn.y - v.y) / (lenOut || 1) };
    const dot = -(dIn.x * dOut.x + dIn.y * dOut.y);
    const phi = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (phi < 0.2 || phi > Math.PI - 0.05) continue;
    maxRs[j] = 0.45 * Math.min(lenIn, lenOut) * Math.tan(phi / 2);
    globalMax = Math.max(globalMax, maxRs[j]);
  }
  if (globalMax <= 0) return false;
  const step = dir * globalMax * 0.1;
  let changed = false;
  for (let j = 0; j < V; j++) {
    if (maxRs[j] <= 0) continue;
    const next = Math.max(0, Math.min(cornerR[j] + step, maxRs[j]));
    if (Math.abs(next - cornerR[j]) > 1e-9) { cornerR[j] = next; changed = true; }
  }
  if (!changed) return false;
  const rebuilt = applyFillets(base, cornerR);
  if (!rebuilt) return false;
  segPath.cornerR = cornerR;
  segPath.start = rebuilt.start;
  segPath.segs = rebuilt.segs;
  invalidateTessellation(segPath);
  return true;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
