// 2D path utilities: simplification, smoothing, corner rounding, hit tests.

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Perpendicular distance from point p to segment ab.
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Douglas-Peucker simplification.
export function simplifyDP(points, epsilon) {
  if (points.length < 3) return points.slice();
  let maxD = 0, idx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > epsilon) {
    const left = simplifyDP(points.slice(0, idx + 1), epsilon);
    const right = simplifyDP(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// One pass of Chaikin corner-cutting for gentle smoothing of a closed path.
export function chaikinClosed(points, iterations = 1) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    pts = out;
  }
  return pts;
}


// Flatten a cubic bezier segment into line samples (excludes start point).
export function sampleCubic(p0, c0, c1, p1, samples = 16) {
  const out = [];
  for (let s = 1; s <= samples; s++) {
    const t = s / samples, mt = 1 - t;
    out.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * c0.x + 3 * mt * t * t * c1.x + t * t * t * p1.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * c0.y + 3 * mt * t * t * c1.y + t * t * t * p1.y,
    });
  }
  return out;
}

// Flatten a closed bezier path (anchors with in/out handles) to a polygon.
export function flattenBezierPath(anchors, samplesPerSeg = 16) {
  const pts = [];
  const n = anchors.length;
  for (let i = 0; i < n; i++) {
    const a = anchors[i], b = anchors[(i + 1) % n];
    pts.push({ x: a.x, y: a.y });
    const seg = sampleCubic(
      a, a.out ?? a, b.in ?? b, b, samplesPerSeg
    );
    seg.pop(); // endpoint added as next anchor
    pts.push(...seg);
  }
  return pts;
}

// Smooth closure for freehand strokes. Closing last->first with a straight
// chord slices the profile when the endpoints are far apart; instead, when the
// gap exceeds `gapRatio` of the stroke's bounding-box diagonal, bridge it with
// a cubic blend that continues the end tangent and arrives along the start
// tangent. Returns the bridge points (excluding both endpoints), or null when
// a plain implicit closure is fine.
export function smoothClosure(path, gapRatio = 0.1, samples = 14) {
  const n = path.length;
  if (n < 4) return null;
  const first = path[0], last = path[n - 1];
  const gap = dist(first, last);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 1e-6 || gap <= diag * gapRatio) return null;

  // tangents averaged over a few points for stability against stroke jitter
  const back = path[Math.max(0, n - 4)];
  const ahead = path[Math.min(n - 1, 3)];
  const tEnd = norm({ x: last.x - back.x, y: last.y - back.y });
  const tStart = norm({ x: ahead.x - first.x, y: ahead.y - first.y });
  const k = gap / 3;
  const c0 = { x: last.x + tEnd.x * k, y: last.y + tEnd.y * k };
  const c1 = { x: first.x - tStart.x * k, y: first.y - tStart.y * k };
  const pts = sampleCubic(last, c0, c1, first, samples);
  pts.pop(); // drop the endpoint — `first` already starts the path
  return pts;
}

function norm(v) {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

// Axis-aligned rectangle with circular rounded corners, sampled as a closed
// polygon. cx/cy center, hw/hh half-extents, r corner radius (clamped so
// opposite arcs never overlap). r = 0 yields the sharp 4-corner rect.
export function roundedRectPath(cx, cy, hw, hh, r = 0, arcSamples = 8) {
  r = Math.max(0, Math.min(r, hw, hh));
  if (r < 1e-6) {
    return [
      { x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh },
      { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh },
    ];
  }
  // arc centers, walked CCW starting from the +x/+y corner
  const corners = [
    { x: cx + hw - r, y: cy + hh - r, a0: 0 },
    { x: cx - hw + r, y: cy + hh - r, a0: Math.PI / 2 },
    { x: cx - hw + r, y: cy - hh + r, a0: Math.PI },
    { x: cx + hw - r, y: cy - hh + r, a0: Math.PI * 1.5 },
  ];
  const out = [];
  for (const c of corners) {
    for (let s = 0; s <= arcSamples; s++) {
      const a = c.a0 + (s / arcSamples) * (Math.PI / 2);
      out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    }
  }
  return out;
}

// Axis-aligned ellipse sampled as a closed polygon.
export function ellipsePath(cx, cy, rx, ry, samples = 64) {
  const out = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

export function pathArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

export function pointInRect(p, cx, cy, hw, hh) {
  return Math.abs(p.x - cx) <= hw && Math.abs(p.y - cy) <= hh;
}

export function mirrorPathH(points, axisX) {
  return points.map((p) => ({ x: 2 * axisX - p.x, y: p.y })).reverse();
}

// ---------------- drafting helpers (Phase 5: draft mode) ----------------

// Circumcircle through three points, or null when (near-)collinear.
export function circumcircle(a, m, b) {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, m2 = m.x * m.x + m.y * m.y, b2 = b.x * b.x + b.y * b.y;
  const cx = (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d;
  const cy = (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

// Arc through three points (start, through, end) -> center, radius, start/end
// angles and sweep direction chosen so the arc passes through the middle
// point. Null when collinear (callers draw a straight segment instead).
export function arcParams(a, m, b) {
  const c = circumcircle(a, m, b);
  if (!c) return null;
  const a0 = Math.atan2(a.y - c.cy, a.x - c.cx);
  const a1 = Math.atan2(m.y - c.cy, m.x - c.cx);
  const a2 = Math.atan2(b.y - c.cy, b.x - c.cx);
  const TAU = Math.PI * 2;
  // sweep from a0 to a2 going CCW; does it pass a1?
  const ccwSweep = (a2 - a0 + TAU) % TAU;
  const ccwToMid = (a1 - a0 + TAU) % TAU;
  const ccw = ccwToMid <= ccwSweep;
  return { cx: c.cx, cy: c.cy, r: c.r, a0, a2, ccw };
}

// Sample an arcParams result into a polyline (including both endpoints).
export function arcPoints(p, samples = 24) {
  const TAU = Math.PI * 2;
  const sweep = p.ccw ? (p.a2 - p.a0 + TAU) % TAU : -((p.a0 - p.a2 + TAU) % TAU);
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const t = p.a0 + sweep * (i / samples);
    out.push({ x: p.cx + Math.cos(t) * p.r, y: p.cy + Math.sin(t) * p.r });
  }
  return out;
}

// Catmull-Rom spline through the given points (open or closed), sampled to a
// polyline. The standard uniform form; endpoints are clamped for open curves.
export function catmullRom(pts, closed = false, seg = 12) {
  const n = pts.length;
  if (n < 2) return pts.slice();
  if (n === 2 && !closed) return [pts[0], pts[1]];
  const P = (i) => pts[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
  const out = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let j = 0; j < seg; j++) {
      const t = j / seg, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(closed ? { ...out[0] } : { ...pts[n - 1] });
  return out;
}

// Corner fillet / chamfer on a polyline (Phase 6). Each treated vertex is
// replaced by a tangent arc of radius r (or the straight chamfer chord).
// The tangent length is clamped to half of each adjacent segment so corners
// never overlap; open paths keep their end vertices untouched.
export function filletPolyline(pts, closed, r, chamfer = false, arcStep = Math.PI / 12) {
  const n = pts.length;
  if (r <= 1e-9 || n < 3) return pts.slice();
  const out = [];
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  if (!closed) out.push({ ...pts[0] });
  for (let i = first; i <= last; i++) {
    const v = pts[i];
    const p = pts[(i - 1 + n) % n], q = pts[(i + 1) % n];
    const l1 = dist(p, v), l2 = dist(v, q);
    if (l1 < 1e-9 || l2 < 1e-9) { out.push({ ...v }); continue; }
    const u1 = { x: (p.x - v.x) / l1, y: (p.y - v.y) / l1 }; // v -> prev
    const u2 = { x: (q.x - v.x) / l2, y: (q.y - v.y) / l2 }; // v -> next
    const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const theta = Math.acos(dot); // interior angle at v
    if (theta < 0.02 || theta > Math.PI - 0.02) { out.push({ ...v }); continue; }
    // tangent length for radius r, clamped to half of each adjacent segment
    let t = r / Math.tan(theta / 2);
    t = Math.min(t, l1 * 0.5, l2 * 0.5);
    const rEff = t * Math.tan(theta / 2);
    const A = { x: v.x + u1.x * t, y: v.y + u1.y * t };
    const B = { x: v.x + u2.x * t, y: v.y + u2.y * t };
    if (chamfer) { out.push(A, B); continue; }
    // arc center along the angle bisector
    const bis = { x: u1.x + u2.x, y: u1.y + u2.y };
    const bl = Math.hypot(bis.x, bis.y) || 1;
    const C = {
      x: v.x + (bis.x / bl) * (rEff / Math.sin(theta / 2)),
      y: v.y + (bis.y / bl) * (rEff / Math.sin(theta / 2)),
    };
    const a0 = Math.atan2(A.y - C.y, A.x - C.x);
    let a1 = Math.atan2(B.y - C.y, B.x - C.x);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / arcStep));
    for (let s = 0; s <= steps; s++) {
      const a = a0 + sweep * (s / steps);
      out.push({ x: C.x + Math.cos(a) * rEff, y: C.y + Math.sin(a) * rEff });
    }
  }
  if (!closed) out.push({ ...pts[n - 1] });
  return out;
}

// Intersection of segments ab and cd (proper, within both), or null.
export function segIntersect(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}
