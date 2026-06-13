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
