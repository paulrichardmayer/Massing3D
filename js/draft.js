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

import { state, addDrawing, recordDrawingsChange, emit, addPartFromRegion } from './state.js';
import { dist, arcParams, arcPoints, catmullRom, filletPolyline, segIntersect } from './geometry.js';
import { showToast } from './toast.js';

export const DRAFT_TOOLS = ['line', 'polyline', 'arc', 'circle', 'curve'];

const SNAP_PX = 9;          // screen-space snap radius
const CLOSE_PX = 12;        // click-the-first-point closure radius

// ---------------- entity -> renderable polyline(s) ----------------

export function entityPoints(e, seg = 18) {
  if (e.kind === 'poly') {
    return e.fillet > 0 ? filletPolyline(e.pts, !!e.closed, e.fillet, !!e.chamfer) : e.pts;
  }
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

// Intersections of drawing segments near the probe point (label 'int').
// Only segments whose boxes reach the probe are paired, so this stays cheap.
function intersectionSnaps(view, w, tol) {
  const segs = [];
  for (const e of state.drawings[view.name]) {
    const pts = entityPoints(e, 10);
    const n = e.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.min(a.x, b.x) - tol > w.h || Math.max(a.x, b.x) + tol < w.h) continue;
      if (Math.min(a.y, b.y) - tol > w.v || Math.max(a.y, b.y) + tol < w.v) continue;
      segs.push([a, b, e]);
    }
    if (segs.length > 400) return []; // pathological density — skip quietly
  }
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[i][2] === segs[j][2]) continue; // same entity: joints, not intersections
      const p = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (p) out.push({ x: p.x, y: p.y, label: 'int' });
    }
  }
  return out;
}

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
  for (const c of intersectionSnaps(view, w, tol)) {
    const d = Math.hypot(c.x - w.h, c.y - w.v);
    if (d < bestD) { bestD = d; best = c; }
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

// Advance the active op with a resolved point — shared by pointer clicks and
// numeric (typed-length) placement.
function placePoint(view, pt) {
  const op = view.draftOp;
  const tool = op.tool;
  if (tool === 'line') {
    commitOp(view, { kind: 'poly', pts: [op.pts[0], { x: pt.x, y: pt.y }], closed: false });
    return;
  }
  if (tool === 'circle') {
    commitOp(view, { kind: 'circle', pts: [op.pts[0], { x: pt.x, y: pt.y }], closed: true });
    return;
  }
  if (tool === 'arc') {
    if (op.pts.length === 1) { op.pts.push({ x: pt.x, y: pt.y }); view.draw(); return; }
    // stored order: start, through, end
    commitOp(view, { kind: 'arc', pts: [op.pts[0], { x: pt.x, y: pt.y }, op.pts[1]], closed: false });
    return;
  }
  // polyline / curve: close on the first point, else append
  if (op.pts.length >= 2 && dist(op.pts[0], pt) * view.cam.scale < CLOSE_PX) {
    commitOp(view, { kind: tool === 'curve' ? 'curve' : 'poly', pts: op.pts, closed: true });
    return;
  }
  op.pts.push({ x: pt.x, y: pt.y });
  view.draw();
}

export function draftPointerDown(view, screenP, e) {
  const tool = state.tool;
  if (!DRAFT_TOOLS.includes(tool)) return false;
  const pt = resolvePoint(view, screenP, e);
  if (!view.draftOp) {
    view.draftOp = { tool, pts: [{ x: pt.x, y: pt.y }], hover: pt };
    view.draw();
    return true;
  }
  numeric = ''; // a click supersedes any half-typed length
  placePoint(view, pt);
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
  const had = !!view.draftOp || view.draftSel != null || !!numeric;
  view.draftOp = null;
  view.draftHover = null;
  view.draftSel = null;
  numeric = '';
  if (had) view.draw();
  return had;
}

function commitOp(view, entity) {
  view.draftOp = null;
  numeric = '';
  addDrawing(view.name, JSON.parse(JSON.stringify(entity)));
}

// ---------------- numeric entry (type a length mid-tool) ----------------
// Rhino muscle memory: click a start point, type "450", Enter — the segment
// is exactly 450 mm along the current (snapped / ortho-locked) direction.
// For circles the number is the radius.

let numeric = ''; // shared buffer; owned by whichever view has the active op

export function numericBuffer() { return numeric; }

function opView(views) {
  return views.find((v) => v.draftOp) ?? null;
}

// Handle a keydown while drafting. Returns true when consumed.
export function draftNumericKey(e, views) {
  const view = opView(views);
  if (!view) return false;
  const op = view.draftOp;
  if (/^[0-9.]$/.test(e.key)) {
    if (op.tool === 'arc') return false; // lengths don't define a 3-pt arc step
    if (e.key === '.' && numeric.includes('.')) return true;
    numeric += e.key;
    view.draw();
    return true;
  }
  if (e.key === 'Backspace' && numeric) {
    numeric = numeric.slice(0, -1);
    view.draw();
    return true;
  }
  if (e.key === 'Enter' && numeric) {
    const value = parseFloat(numeric);
    numeric = '';
    if (!isFinite(value) || value <= 0) { view.draw(); return true; }
    const last = op.pts[op.pts.length - 1];
    const h = op.hover ?? { x: last.x + 1, y: last.y };
    let dx = h.x - last.x, dy = h.y - last.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
    placePoint(view, { x: last.x + dx * value, y: last.y + dy * value });
    return true;
  }
  return false;
}

// ---------------- selection & editing ----------------
// Select tool in draft mode: click picks the nearest entity (8 px), drag
// moves it, Delete removes it, M mirrors a copy about the view's vertical
// axis, [ ] adjust corner fillet radius on polylines, C toggles chamfer.

const PICK_PX = 8;

function hitEntity(view, w) {
  const tol = PICK_PX / view.cam.scale;
  let best = -1, bestD = tol;
  const ents = state.drawings[view.name];
  for (let i = 0; i < ents.length; i++) {
    const pts = entityPoints(ents[i], 10);
    const n = ents[i].closed ? pts.length : pts.length - 1;
    for (let s = 0; s < n; s++) {
      const a = pts[s], b = pts[(s + 1) % pts.length];
      const d = distToSeg(w, a, b);
      if (d < bestD) { bestD = d; best = i; }
    }
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

// Select-tool pointerdown. Returns true when it hit (and begins a move drag).
export function draftSelectDown(view, screenP) {
  const w0 = view.s2w(screenP.x, screenP.y);
  const idx = hitEntity(view, { x: w0.h, y: w0.v });
  view.draftSel = idx >= 0 ? idx : null;
  if (idx < 0) { view.draw(); return false; }
  view.draftDrag = {
    before: JSON.parse(JSON.stringify(state.drawings[view.name])),
    lastH: w0.h, lastV: w0.v, moved: false,
  };
  view.draw();
  return true;
}

export function draftDragMove(view, screenP) {
  const drag = view.draftDrag;
  if (!drag || view.draftSel == null) return false;
  const w = view.s2w(screenP.x, screenP.y);
  const dx = w.h - drag.lastH, dy = w.v - drag.lastV;
  drag.lastH = w.h; drag.lastV = w.v;
  if (dx || dy) {
    drag.moved = true;
    const e = state.drawings[view.name][view.draftSel];
    for (const p of e.pts) { p.x += dx; p.y += dy; }
    view.draw();
  }
  return true;
}

export function draftDragEnd(view) {
  const drag = view.draftDrag;
  view.draftDrag = null;
  if (!drag) return false;
  if (drag.moved) recordDrawingsChange(view.name, drag.before);
  return true;
}

export function draftDeleteSelected(view) {
  if (view.draftSel == null) return false;
  const before = JSON.parse(JSON.stringify(state.drawings[view.name]));
  state.drawings[view.name].splice(view.draftSel, 1);
  view.draftSel = null;
  recordDrawingsChange(view.name, before);
  emit('change');
  return true;
}

// Mirrored COPY about the view's vertical axis (x = 0) — instant left/right
// furniture symmetry. The copy becomes the selection.
export function draftMirrorSelected(view) {
  if (view.draftSel == null) return false;
  const src = state.drawings[view.name][view.draftSel];
  const copy = JSON.parse(JSON.stringify(src));
  for (const p of copy.pts) p.x = -p.x;
  if (copy.kind === 'arc') copy.pts.reverse(); // keep the sweep through-point valid
  addDrawing(view.name, copy);
  view.draftSel = state.drawings[view.name].length - 1;
  showToast('Mirrored copy about the vertical axis');
  return true;
}

// [ / ] on a selected polyline: corner radius. C: chamfer <-> round.
export function draftAdjustFillet(view, dir) {
  if (view.draftSel == null) return false;
  const e = state.drawings[view.name][view.draftSel];
  if (e.kind !== 'poly' || e.pts.length < 3) {
    showToast('Corner fillets apply to polylines');
    return true;
  }
  const before = JSON.parse(JSON.stringify(state.drawings[view.name]));
  e.fillet = Math.max(0, (e.fillet || 0) + dir * 2);
  recordDrawingsChange(view.name, before);
  showToast(e.fillet > 0 ? `Corner ${e.chamfer ? 'chamfer' : 'fillet'} ${e.fillet} mm` : 'Sharp corners');
  emit('change');
  return true;
}

// The bridge (Phase 7): promote the selected CLOSED region into a real part —
// an extrusion whose profile is the drawing and whose depth is the panel
// thickness. The drawing stays on the board as the source of truth.
export function draftPromoteSelected(view, thickness) {
  if (view.draftSel == null) {
    showToast('Select a closed drawing with the Select tool first');
    return false;
  }
  const e = state.drawings[view.name][view.draftSel];
  if (!e.closed) {
    showToast('Only closed regions become parts — close the outline first');
    return false;
  }
  const pts = entityPoints(e, 24);
  const layer = addPartFromRegion(view.name, pts, { thickness });
  if (!layer) return false;
  showToast(`${layer.name} created — ${layer.box[{ front: 'd', top: 'h', side: 'w' }[view.name]]} mm panel from the drawing`);
  return true;
}

export function draftToggleChamfer(view) {
  if (view.draftSel == null) return false;
  const e = state.drawings[view.name][view.draftSel];
  if (e.kind !== 'poly') return true;
  const before = JSON.parse(JSON.stringify(state.drawings[view.name]));
  e.chamfer = !e.chamfer;
  if (!e.fillet) e.fillet = 6; // toggling style implies wanting treated corners
  recordDrawingsChange(view.name, before);
  showToast(e.chamfer ? 'Chamfered corners' : 'Rounded corners');
  emit('change');
  return true;
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
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 0; i < ents.length; i++) {
      const selected = state.draftMode && view.draftSel === i;
      ctx.strokeStyle = selected ? '#fbbf24'
        : state.draftMode ? DRAFT_STROKE : DRAFT_STROKE_DIM;
      ctx.lineWidth = selected ? 2.2 : 1.5;
      strokePts(view, ctx, entityPoints(ents[i]), ents[i].closed);
      if (selected) {
        ctx.fillStyle = '#fbbf24';
        for (const p of ents[i].pts) {
          const s = view.w2s(p.x, p.y);
          ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
        }
      }
    }
    ctx.restore();
  }
  if (!state.draftMode) {
    drawSnapMarker(view, ctx); // massing shape tools snap to drawings too
    return;
  }

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

  drawSnapMarker(view, ctx);
}

// Snap marker + label — also shown in Quick Massing when a shape tool snaps
// to drafted geometry (the drawings are live reference, not wallpaper).
export function drawSnapMarker(view, ctx) {
  const op = view.draftOp;
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

  // typed-length chip ("450 mm ⏎") beside the cursor
  if (op && numeric) {
    const anchor = op.hover ?? op.pts[op.pts.length - 1];
    const s = view.w2s(anchor.x, anchor.y);
    const label = `${numeric} mm ⏎`;
    ctx.save();
    ctx.font = '11px sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(24, 24, 27, 0.92)';
    ctx.fillRect(s.x + 12, s.y - 24, tw + 12, 18);
    ctx.strokeStyle = '#fbbf24';
    ctx.strokeRect(s.x + 12, s.y - 24, tw + 12, 18);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(label, s.x + 18, s.y - 11);
    ctx.restore();
  }
}
