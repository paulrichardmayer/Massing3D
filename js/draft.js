// Draft mode (Part II, Phase 5): Rhino-style 2D drafting in the ortho views.
//
// Entities live in state.drawings[view] (world-planar mm, open paths allowed)
// and never generate solids — this is the technical-drawing layer furniture
// design needs. Tools follow Rhino input patterns:
//   line      click A, click B                     · Shift = ortho lock
//   polyline  click…click · Enter/dbl-click = open · click first pt = closed
//   arc       click start, click end, click through
//   circle    click center, click rim
//   curve     like polyline, smooth through-points (Catmull-Rom)
// Snaps: entity endpoints, segment midpoints, then the view grid. The active
// snap shows as a marker + label at the cursor.
//
// This module owns the draft tool state machine per view; sketchview.js
// delegates pointer/keyboard events here when state.draftMode is on.

import { state, addDrawing } from './state.js';
import { dist, arcParams, arcPoints, catmullRom } from './geometry.js';

export const DRAFT_TOOLS = ['line', 'polyline', 'arc', 'circle', 'curve'];

const SNAP_PX = 9;          // screen-space snap radius
const CLOSE_PX = 12;        // click-the-first-point closure radius

// ---------------- entity -> renderable polyline(s) ----------------

export function entityPoints(e, seg = 18) {
  if (e.kind === 'poly') return e.pts;
  if (e.kind === 'curve') return catmullRom(e.pts, e.closed, seg);
  if (e.kind === 'arc') {
    const p = arcParams(e.pts[0], e.pts[1], e.pts[2]);
    return p ? arcPoints(p, 32) : [e.pts[0], e.pts[2]];
  }
  if (e.kind === 'circle') {
    const r = dist(e.pts[0], e.pts[1]);
    const out = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      out.push({ x: e.pts[0].x + Math.cos(a) * r, y: e.pts[0].y + Math.sin(a) * r });
    }
    return out;
  }
  return [];
}

// Snap-relevant points of an entity: endpoints + segment midpoints + centers.
function snapCandidates(e) {
  const out = [];
  const push = (p, label) => out.push({ x: p.x, y: p.y, label });
  if (e.kind === 'poly' || e.kind === 'curve') {
    const pts = e.pts;
    for (const p of pts) push(p, 'end');
    const n = e.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 'mid');
    }
  } else if (e.kind === 'arc') {
    push(e.pts[0], 'end'); push(e.pts[2], 'end'); push(e.pts[1], 'mid');
  } else if (e.kind === 'circle') {
    push(e.pts[0], 'center');
    const r = dist(e.pts[0], e.pts[1]);
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      push({ x: e.pts[0].x + Math.cos(a) * r, y: e.pts[0].y + Math.sin(a) * r }, 'quad');
    }
  }
  return out;
}

// ---------------- snapping + ortho ----------------

// The grid the user SEES (mirrors sketchview.drawGrid's minor step).
function gridStep(scale) { return scale > 4 ? 5 : scale > 0.8 ? 10 : 100; }

// Snap a raw world point against drawing geometry, then the grid.
// Returns { x, y, label } — label null when unsnapped.
export function snapDraftPoint(view, w) {
  const tol = SNAP_PX / view.cam.scale;
  let best = null, bestD = tol;
  for (const e of state.drawings[view.name]) {
    for (const c of snapCandidates(e)) {
      const d = Math.hypot(c.x - w.h, c.y - w.v);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  // the in-progress op's own vertices snap too (lets a polyline close cleanly)
  const op = view.draftOp;
  if (op?.pts?.length) {
    for (const p of op.pts) {
      const d = Math.hypot(p.x - w.h, p.y - w.v);
      if (d < bestD) { bestD = d; best = { x: p.x, y: p.y, label: 'end' }; }
    }
  }
  if (best) return best;
  const step = gridStep(view.cam.scale);
  const gx = Math.round(w.h / step) * step, gy = Math.round(w.v / step) * step;
  if (Math.hypot(gx - w.h, gy - w.v) < tol) return { x: gx, y: gy, label: 'grid' };
  return { x: w.h, y: w.v, label: null };
}

// Ortho lock: constrain p to the nearest multiple of 45° about `anchor`.
export function orthoLock(anchor, p) {
  const dx = p.x - anchor.x, dy = p.y - anchor.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { ...p };
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: anchor.x + Math.cos(a) * len, y: anchor.y + Math.sin(a) * len };
}

// Resolve a pointer event to a draft point. Shift = ortho lock, and it WINS
// over snapping — "hold Shift" must always mean exactly vertical/horizontal/
// 45°, never a nearby grid point that bends the line. Unshifted input snaps.
function resolvePoint(view, screenP, e) {
  const w = view.s2w(screenP.x, screenP.y);
  const op = view.draftOp;
  if (e?.shiftKey && op?.pts?.length) {
    const locked = orthoLock(op.pts[op.pts.length - 1], { x: w.h, y: w.v });
    return { ...locked, label: 'ortho' };
  }
  return snapDraftPoint(view, w);
}

// ---------------- tool state machine ----------------
// view.draftOp = { tool, pts: [{x,y}...], hover: {x,y,label} }

export function draftPointerDown(view, screenP, e) {
  const tool = state.tool;
  if (!DRAFT_TOOLS.includes(tool)) return false;
  const pt = resolvePoint(view, screenP, e);
  let op = view.draftOp;

  if (!op) {
    view.draftOp = { tool, pts: [{ x: pt.x, y: pt.y }], hover: pt };
    view.draw();
    return true;
  }

  if (tool === 'line') {
    commitOp(view, { kind: 'poly', pts: [op.pts[0], { x: pt.x, y: pt.y }], closed: false });
    return true;
  }
  if (tool === 'circle') {
    commitOp(view, { kind: 'circle', pts: [op.pts[0], { x: pt.x, y: pt.y }], closed: true });
    return true;
  }
  if (tool === 'arc') {
    if (op.pts.length === 1) { op.pts.push({ x: pt.x, y: pt.y }); view.draw(); return true; }
    // stored order: start, through, end
    commitOp(view, { kind: 'arc', pts: [op.pts[0], { x: pt.x, y: pt.y }, op.pts[1]], closed: false });
    return true;
  }
  // polyline / curve: close on the first point, else append
  if (op.pts.length >= 2 && dist(op.pts[0], pt) * view.cam.scale < CLOSE_PX) {
    commitOp(view, { kind: tool === 'curve' ? 'curve' : 'poly', pts: op.pts, closed: true });
    return true;
  }
  op.pts.push({ x: pt.x, y: pt.y });
  view.draw();
  return true;
}

export function draftPointerMove(view, screenP, e) {
  if (!DRAFT_TOOLS.includes(state.tool)) return false;
  const pt = resolvePoint(view, screenP, e);
  if (view.draftOp) view.draftOp.hover = pt;
  else view.draftHover = pt; // idle: still show snap targets under the cursor
  view.draw();
  return !!view.draftOp;
}

// Enter / double-click: commit an open polyline or curve in progress.
export function draftCommitOpen(view) {
  const op = view.draftOp;
  if (!op || (op.tool !== 'polyline' && op.tool !== 'curve')) return false;
  if (op.pts.length < 2) { view.draftOp = null; view.draw(); return true; }
  commitOp(view, { kind: op.tool === 'curve' ? 'curve' : 'poly', pts: op.pts, closed: false });
  return true;
}

export function draftCancel(view) {
  const had = !!view.draftOp;
  view.draftOp = null;
  view.draftHover = null;
  if (had) view.draw();
  return had;
}

function commitOp(view, entity) {
  view.draftOp = null;
  addDrawing(view.name, JSON.parse(JSON.stringify(entity)));
}

// ---------------- rendering ----------------

const DRAFT_STROKE = 'rgba(228, 228, 231, 0.92)';   // committed, draft mode
const DRAFT_STROKE_DIM = 'rgba(228, 228, 231, 0.30)'; // committed, massing mode
const PREVIEW_STROKE = 'rgba(56, 189, 248, 0.95)';

function strokePts(view, ctx, pts, closed) {
  if (pts.length < 2) return;
  ctx.beginPath();
  const s0 = view.w2s(pts[0].x, pts[0].y);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < pts.length; i++) {
    const s = view.w2s(pts[i].x, pts[i].y);
    ctx.lineTo(s.x, s.y);
  }
  if (closed) ctx.closePath();
  ctx.stroke();
}

export function drawDraftLayer(view, ctx) {
  const ents = state.drawings[view.name];
  if (ents.length) {
    ctx.save();
    ctx.strokeStyle = state.draftMode ? DRAFT_STROKE : DRAFT_STROKE_DIM;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const e of ents) strokePts(view, ctx, entityPoints(e), e.closed);
    ctx.restore();
  }
  if (!state.draftMode) return;

  const op = view.draftOp;
  if (op) {
    ctx.save();
    ctx.strokeStyle = PREVIEW_STROKE;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    const h = op.hover ? { x: op.hover.x, y: op.hover.y } : null;
    if (op.tool === 'line' && h) strokePts(view, ctx, [op.pts[0], h], false);
    else if (op.tool === 'circle' && h) {
      strokePts(view, ctx, entityPoints({ kind: 'circle', pts: [op.pts[0], h] }), false);
    } else if (op.tool === 'arc') {
      if (op.pts.length === 1 && h) strokePts(view, ctx, [op.pts[0], h], false);
      else if (h) strokePts(view, ctx, entityPoints({ kind: 'arc', pts: [op.pts[0], h, op.pts[1]] }), false);
    } else if (op.tool === 'curve') {
      strokePts(view, ctx, catmullRom(h ? [...op.pts, h] : op.pts, false, 12), false);
    } else if (h) {
      strokePts(view, ctx, [...op.pts, h], false);
    }
    // vertices placed so far
    ctx.setLineDash([]);
    ctx.fillStyle = PREVIEW_STROKE;
    for (const p of op.pts) {
      const s = view.w2s(p.x, p.y);
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
    }
    ctx.restore();
  }

  // snap marker + label
  const hov = op?.hover ?? view.draftHover;
  if (hov?.label) {
    const s = view.w2s(hov.x, hov.y);
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(s.x - 4.5, s.y - 4.5, 9, 9);
    ctx.fillStyle = '#fbbf24';
    ctx.font = '10px sans-serif';
    ctx.fillText(hov.label, s.x + 8, s.y - 8);
    ctx.restore();
  }
}
