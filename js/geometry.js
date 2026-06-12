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

// Round the corners of a closed polygon by replacing each vertex with a
// quadratic-bezier arc of the given radius. Used for the fillet modifier:
// rounding the 2D profiles approximates rounded edge intersections along
// each extrusion axis.
export function roundCorners(points, radius, samples = 6) {
  if (radius <= 0 || points.length < 3) return points.slice();
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const dPrev = dist(curr, prev), dNext = dist(curr, next);
    if (dPrev < 1e-6 || dNext < 1e-6) { out.push(curr); continue; }
    const r = Math.min(radius, dPrev * 0.45, dNext * 0.45);
    const p1 = {
      x: curr.x + (prev.x - curr.x) * (r / dPrev),
      y: curr.y + (prev.y - curr.y) * (r / dPrev),
    };
    const p2 = {
      x: curr.x + (next.x - curr.x) * (r / dNext),
      y: curr.y + (next.y - curr.y) * (r / dNext),
    };
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const mt = 1 - t;
      out.push({
        x: mt * mt * p1.x + 2 * mt * t * curr.x + t * t * p2.x,
        y: mt * mt * p1.y + 2 * mt * t * curr.y + t * t * p2.y,
      });
    }
  }
  return out;
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
