// Orthographic sketch viewports (Top / Front / Side).
// 2D canvas overlay with pan/zoom, freehand + bezier drawing, symmetry,
// underlay rendering, and box-layer dragging with face snapping.
// Drawing happens here ONLY — the perspective view never receives sketches.

import {
  state, activeLayer, setViewPaths, recordPathsChange, recordPartMove, touch, emit, on,
} from './state.js';
import {
  dist, simplifyDP, chaikinClosed, flattenBezierPath, pathArea, mirrorPathH,
  smoothClosure, roundedRectPath, ellipsePath,
} from './geometry.js';
import {
  interpretStoredPath, tessellatePath, isSegPath, adjustSegPathRadius,
} from './interpret.js';
import PolyBool from './vendor/polybool.js';
import { getProjection } from './scene3d.js';
import { showToast } from './toast.js';

// Per-view axis mapping. h/v are the planar coordinates stored in paths.
// vSign: +1 means screen-down increases v, -1 means screen-up increases v.
const VIEW_CONFIGS = {
  top:   { hAxis: 'x', vAxis: 'z', vSign: 1,  hDim: 'w', vDim: 'd', plane: 'xz' },
  front: { hAxis: 'x', vAxis: 'y', vSign: -1, hDim: 'w', vDim: 'h', plane: 'xy' },
  side:  { hAxis: 'z', vAxis: 'y', vSign: -1, hDim: 'd', vDim: 'h', plane: 'yz' },
};

const CLOSE_THRESHOLD_PX = 12;
const CLOSURE_ANIM_MS = 650;
const MORPH_MS = 250; // raw -> interpreted morph: the user must see the "aha"

export const sketchViews = {};
let lastFocusedView = 'front';
export function getLastFocusedView() { return lastFocusedView; }

// Union `path` with itself (resolving self-intersections) and, when given,
// with `mirrored`. Operates in normalized box space. Falls back to the raw
// inputs if the boolean op fails so a sketch is never silently dropped.
function cleanPaths(path, mirrored) {
  const toRegion = (pts) => pts.map((p) => [p.x, p.y]);
  try {
    const result = PolyBool.union(
      { regions: [toRegion(path)], inverted: false },
      { regions: mirrored ? [toRegion(mirrored)] : [], inverted: false },
    );
    return result.regions
      .map((r) => r.map(([x, y]) => ({ x: +x.toFixed(5), y: +y.toFixed(5) })))
      .filter((r) => r.length >= 3 && pathArea(r) > 1e-4); // drop slivers
  } catch (err) {
    console.warn('2D union failed, storing raw path(s)', err);
    return mirrored ? [path, mirrored] : [path];
  }
}

export class SketchView {
  constructor(viewportEl, name) {
    this.name = name;
    this.cfg = VIEW_CONFIGS[name];
    this.el = viewportEl;
    this.canvas = viewportEl.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cam = { h: 0, v: 0, scale: 1.6 }; // world center + px per mm
    this.drawing = null;        // freehand in progress: [{x,y} screen]
    this.bezier = null;         // bezier in progress: { anchors: [...], pending }
    this.shapeDrag = null;      // rect/ellipse drag: { tool, start, curr (world h/v), shift }
    this.pendingRect = null;    // released rect awaiting radius tweak: { layer, ch, cv, hw, hh, r }
    this.lastPendingCommit = 0; // timestamp guard so the committing click's dblclick doesn't fill-box
    this.hoverPos = null;
    this.dragLayer = null;      // { layer, startH, startV, origPos }
    this.panState = null;
    this.imageCache = new Map();

    this.setupCanvas();
    this.bindPointer();
    sketchViews[name] = this;
  }

  setupCanvas() {
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    };
    new ResizeObserver(resize).observe(this.el);
    resize();
  }

  // ----- coordinate transforms (screen px <-> world planar mm) -----
  w2s(h, v) {
    const cw = this.el.clientWidth / 2, ch = this.el.clientHeight / 2;
    return {
      x: cw + (h - this.cam.h) * this.cam.scale,
      y: ch + (v - this.cam.v) * this.cam.scale * this.cfg.vSign,
    };
  }
  s2w(x, y) {
    const cw = this.el.clientWidth / 2, ch = this.el.clientHeight / 2;
    return {
      h: this.cam.h + (x - cw) / this.cam.scale,
      v: this.cam.v + ((y - ch) / this.cam.scale) * this.cfg.vSign,
    };
  }

  // Planar center & half-extents of a layer's box in this view.
  boxPlanar(layer) {
    return {
      ch: layer.position[this.cfg.hAxis],
      cv: layer.position[this.cfg.vAxis],
      hw: layer.box[this.cfg.hDim] / 2,
      hh: layer.box[this.cfg.vDim] / 2,
    };
  }

  localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ----- pointer handling -----
  bindPointer() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      lastFocusedView = this.name;
      const p = this.localPos(e);

      // RMB / MMB always pan in orthographic views (orbiting disabled).
      if (e.button === 2 || e.button === 1) {
        this.panState = { x: p.x, y: p.y };
        c.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;

      // a click anywhere commits the rect awaiting corner-radius tweaks
      for (const v of Object.values(sketchViews)) {
        if (v !== this && v.pendingRect) v.commitPendingRect();
      }
      if (this.pendingRect) {
        this.commitPendingRect();
        return;
      }

      const tool = state.tool;
      // A revolve part is defined by its Side profile only — block (and hint)
      // drawing in the other views.
      const drawTool = tool === 'freehand' || tool === 'bezier' || tool === 'rect' || tool === 'ellipse';
      if (drawTool && this.name !== 'side' && activeLayer()?.revolve) {
        showToast('Revolve part — sketch its profile in the Side view');
        return;
      }
      if (tool === 'rect' || tool === 'ellipse') {
        if (!activeLayer()) return;
        const w = this.s2w(p.x, p.y);
        this.shapeDrag = { tool, start: { h: w.h, v: w.v }, curr: { h: w.h, v: w.v }, shift: e.shiftKey };
        c.setPointerCapture(e.pointerId);
      } else if (tool === 'nav') {
        this.panState = { x: p.x, y: p.y };
        c.setPointerCapture(e.pointerId);
      } else if (tool === 'select') {
        this.beginLayerDrag(p, e);
      } else if (tool === 'freehand') {
        if (!activeLayer()) return;
        this.drawing = [p];
        this.drawingPointerType = e.pointerType || 'mouse';
        c.setPointerCapture(e.pointerId);
      } else if (tool === 'bezier') {
        this.bezierDown(p, e);
      }
    });

    c.addEventListener('pointermove', (e) => {
      const p = this.localPos(e);
      this.hoverPos = p;

      if (this.panState) {
        this.cam.h -= (p.x - this.panState.x) / this.cam.scale;
        this.cam.v -= ((p.y - this.panState.y) / this.cam.scale) * this.cfg.vSign;
        this.panState = { x: p.x, y: p.y };
        this.draw();
        return;
      }
      if (this.shapeDrag) {
        const w = this.s2w(p.x, p.y);
        this.shapeDrag.curr = { h: w.h, v: w.v };
        this.shapeDrag.shift = e.shiftKey;
        this.draw();
        return;
      }
      if (this.drawing) {
        // collect coalesced events for smooth stylus capture
        let events = e.getCoalescedEvents?.() ?? [];
        if (!events.length) events = [e];
        for (const ev of events) this.drawing.push(this.localPos(ev));
        this.draw();
        return;
      }
      if (this.bezier?.pending) {
        // dragging out a handle from the last anchor
        const a = this.bezier.anchors[this.bezier.anchors.length - 1];
        const w = this.s2w(p.x, p.y);
        a.out = { x: w.h, y: w.v };
        a.in = { x: 2 * a.x - w.h, y: 2 * a.y - w.v };
        this.draw();
        return;
      }
      if (this.dragLayer) {
        this.updateLayerDrag(p);
        return;
      }
      if (this.bezier || state.tool === 'bezier') this.draw();
    });

    const up = (e) => {
      if (this.panState) {
        this.panState = null;
        try { c.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      }
      if (this.drawing) {
        this.finishFreehand();
        try { c.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      }
      if (this.shapeDrag) {
        this.finishShapeDrag();
        try { c.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      }
      if (this.bezier?.pending) this.bezier.pending = false;
      if (this.dragLayer) {
        const { layer, origPos } = this.dragLayer;
        this.dragLayer = null;
        recordPartMove(layer.id, origPos); // undoable move (no-op if it didn't move)
        touch(layer);
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    c.addEventListener('pointerleave', () => { this.hoverPos = null; this.draw(); });

    // Double-click inside a layer's box with a shape tool active fills the
    // box face with that shape (rect = the face itself, ellipse = inscribed).
    c.addEventListener('dblclick', (e) => {
      const tool = state.tool;
      if (tool !== 'rect' && tool !== 'ellipse') return;
      // the first click of this dblclick just committed a pending rect —
      // don't immediately replace it with a fill-box shape
      if (performance.now() - this.lastPendingCommit < 500) return;
      this.fillBox(this.localPos(e), tool);
    });

    // Scroll wheel: corner-radius tweak while a rect is pending, else zoom.
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.pendingRect) {
        const pr = this.pendingRect;
        const step = Math.min(pr.hw, pr.hh) * 0.0012 * -e.deltaY;
        pr.r = Math.max(0, Math.min(pr.r + step, Math.min(pr.hw, pr.hh)));
        this.draw();
        return;
      }
      const p = this.localPos(e);
      const before = this.s2w(p.x, p.y);
      const factor = Math.exp(-e.deltaY * 0.0012);
      this.cam.scale = Math.max(0.05, Math.min(40, this.cam.scale * factor));
      const after = this.s2w(p.x, p.y);
      this.cam.h += before.h - after.h;
      this.cam.v += before.v - after.v;
      this.draw();
    }, { passive: false });
  }

  // ----- freehand -----
  finishFreehand() {
    const raw = this.drawing;
    const pointerType = this.drawingPointerType || 'mouse';
    this.drawing = null;
    if (!raw || raw.length < 8) { this.draw(); return; }
    const layer = activeLayer();
    if (!layer) return;

    // simplify in screen space (Douglas-Peucker), then convert + smooth
    let pts = simplifyDP(raw, 2.2);
    let world = pts.map((p) => this.s2w(p.x, p.y));
    let path = world.map((w) => ({ x: w.h, y: w.v }));

    // If the endpoints are far apart, bridge the gap with a smooth tangent
    // blend instead of letting the implicit chord slice across the profile —
    // and animate the bridge so the user sees what closed the shape.
    const bridge = smoothClosure(path);
    if (bridge) {
      this.startClosureAnim([path[path.length - 1], ...bridge, path[0]]);
      path = path.concat(bridge);
    }
    path = chaikinClosed(path, 1);
    const committed = this.commitPath(layer, path);

    // Auto-interpret on stroke finish. Default: ON for mouse, OFF for stylus
    // (detected via pointerType); a manual toggle overrides that default.
    const auto = state.autoInterpret
      && (state.autoInterpretUserSet || pointerType !== 'pen');
    if (committed && auto) this.interpretProfile({ morph: true, silent: true });
  }

  startClosureAnim(worldPts) {
    this.closureAnim = { pts: worldPts, start: performance.now() };
    const tick = () => {
      if (!this.closureAnim) return;
      this.draw();
      if (performance.now() - this.closureAnim.start > CLOSURE_ANIM_MS) {
        this.closureAnim = null;
        this.draw();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }

  // ----- shape tools (rect / ellipse) -----
  // Resolve a shape drag to center + half-extents in world planar coords.
  // Shift constrains to a square/circle sized by the larger drag dimension.
  shapeDragBounds(drag = this.shapeDrag) {
    const { start, curr, shift } = drag;
    let dh = curr.h - start.h, dv = curr.v - start.v;
    if (shift) {
      const side = Math.max(Math.abs(dh), Math.abs(dv));
      dh = Math.sign(dh || 1) * side;
      dv = Math.sign(dv || 1) * side;
    }
    return {
      ch: start.h + dh / 2, cv: start.v + dv / 2,
      hw: Math.abs(dh) / 2, hh: Math.abs(dv) / 2,
    };
  }

  finishShapeDrag() {
    const drag = this.shapeDrag;
    this.shapeDrag = null;
    const layer = activeLayer();
    if (!layer) { this.draw(); return; }
    const b = this.shapeDragBounds(drag);
    // discard accidental clicks / sub-pixel drags
    if (Math.min(b.hw, b.hh) * 2 * this.cam.scale < 4) { this.draw(); return; }

    if (drag.tool === 'ellipse') {
      this.commitPath(layer, ellipsePath(b.ch, b.cv, b.hw, b.hh, 64));
      return;
    }
    // rect stays pending so the corner radius can be tuned live;
    // the next click (or Enter / tool change) commits it
    this.pendingRect = { layer, ...b, r: 0 };
    showToast('Scroll or [ ] to round corners — click to commit');
    this.draw();
  }

  commitPendingRect() {
    const pr = this.pendingRect;
    this.pendingRect = null;
    if (!pr) return;
    this.lastPendingCommit = performance.now();
    this.commitPath(pr.layer, roundedRectPath(pr.ch, pr.cv, pr.hw, pr.hh, pr.r));
  }

  // [ / ] keys nudge the pending rect's corner radius.
  adjustPendingRadius(dir) {
    const pr = this.pendingRect;
    if (!pr) return false;
    const max = Math.min(pr.hw, pr.hh);
    pr.r = Math.max(0, Math.min(pr.r + dir * max * 0.1, max));
    this.draw();
    return true;
  }

  // Double-click fill: fit the shape to the box face of the layer under p.
  fillBox(p, tool) {
    const w = this.s2w(p.x, p.y);
    const candidates = [...state.layers].reverse();
    const act = activeLayer();
    if (act) candidates.unshift(act);
    for (const layer of candidates) {
      if (!layer.visible) continue;
      const bp = this.boxPlanar(layer);
      if (Math.abs(w.h - bp.ch) > bp.hw || Math.abs(w.v - bp.cv) > bp.hh) continue;
      state.activeLayerId = layer.id;
      const path = tool === 'ellipse'
        ? ellipsePath(bp.ch, bp.cv, bp.hw, bp.hh, 64)
        : roundedRectPath(bp.ch, bp.cv, bp.hw, bp.hh, 0);
      this.commitPath(layer, path);
      return;
    }
  }

  // ----- bezier -----
  bezierDown(p, e) {
    const layer = activeLayer();
    if (!layer) return;
    if (!this.bezier) this.bezier = { anchors: [], pending: false };
    const b = this.bezier;

    // closing click on the first anchor?
    if (b.anchors.length >= 3) {
      const first = this.w2s(b.anchors[0].x, b.anchors[0].y);
      if (Math.hypot(p.x - first.x, p.y - first.y) < CLOSE_THRESHOLD_PX) {
        this.finishBezier();
        return;
      }
    }
    const w = this.s2w(p.x, p.y);
    b.anchors.push({ x: w.h, y: w.v, in: null, out: null });
    b.pending = true; // drag now to pull handles
    this.canvas.setPointerCapture(e.pointerId);
    this.draw();
  }

  finishBezier() {
    const b = this.bezier;
    this.bezier = null;
    if (!b || b.anchors.length < 3) { this.draw(); return; }
    const layer = activeLayer();
    if (!layer) return;
    const path = flattenBezierPath(b.anchors, 14);
    this.commitPath(layer, path);
  }

  cancelSketch() {
    const had = this.drawing || this.bezier || this.shapeDrag || this.pendingRect;
    this.drawing = null;
    this.bezier = null;
    this.shapeDrag = null;
    this.pendingRect = null;
    if (had) this.draw();
    return !!had;
  }

  // Convert world-planar path to box-normalized coords ([-1,1] per axis),
  // apply symmetry, commit. Design-director workflow: each view holds ONE
  // profile (the silhouette from that direction) — a new sketch replaces the
  // previous one, and Ctrl+Z restores it. The final form is always the
  // intersection of the three silhouettes within the box.
  commitPath(layer, worldPath) {
    if (pathArea(worldPath) < 4) { this.draw(); return false; }
    if (layer.revolve && this.name !== 'side') {
      showToast('Revolve part — sketch its profile in the Side view');
      this.draw();
      return false;
    }
    const bp = this.boxPlanar(layer);
    const rel = worldPath.map((p) => ({
      x: +((p.x - bp.ch) / bp.hw).toFixed(5),
      y: +((p.y - bp.cv) / bp.hh).toFixed(5),
    }));

    // a sketch that never overlaps the box would clip the form to nothing
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of rel) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const overlaps = minX <= 1 && maxX >= -1 && minY <= 1 && maxY >= -1;
    if (!overlaps) {
      showToast('Sketch is outside the layer’s box — draw over the box outline');
      this.draw();
      return false;
    }

    // Boolean cleanup: repair self-intersecting strokes, and with symmetry on
    // union the stroke with its mirror so a stroke crossing the centerline
    // yields one clean outline instead of two overlapping shapes (which would
    // self-intersect the extrusion brush and break CSG).
    const paths = cleanPaths(rel, state.symmetry ? mirrorPathH(rel, 0) : null);
    if (!paths.length) { this.draw(); return false; }
    const replaced = layer.paths[this.name].length > 0;
    setViewPaths(layer, this.name, paths);
    if (replaced) {
      const label = { top: 'Top', front: 'Front', side: 'Side' }[this.name];
      showToast(`${label} profile updated (Ctrl+Z restores the previous one)`);
    }
    return true;
  }

  // ----- sketch interpretation ("Clean up", wand / Q) -----
  // Tolerances scale with how the user saw the stroke: aspect keeps arcs
  // circular despite a non-square box, pxPerUnit ties every tolerance to
  // on-screen pixels. (One u-space unit spans bp.hh mm => bp.hh*scale px.)
  interpretCtx(layer) {
    const bp = this.boxPlanar(layer);
    return { bp, aspect: bp.hw / bp.hh, pxPerUnit: bp.hh * this.cam.scale };
  }

  // Toggle the focused view's profile between the raw stroke and its crisp
  // interpretation, morphing between the two so the user sees the tool "get
  // it". One Ctrl+Z restores whatever was there before.
  interpretProfile({ morph = true, silent = false } = {}) {
    const layer = activeLayer();
    if (!layer) return false;
    const stored = layer.paths[this.name];
    if (!stored.length) {
      if (!silent) showToast('Draw a profile first, then press Q to clean it up');
      return false;
    }

    const fromArr = stored.map((p) => tessellatePath(p));

    // already interpreted -> cycle back to the raw stroke
    if (stored.some(isSegPath)) {
      const out = stored.map((s) => (isSegPath(s) && Array.isArray(s.raw)
        ? s.raw.map((p) => ({ x: p.x, y: p.y })) : s));
      if (morph) this.startMorph(layer.id, fromArr, out.map((p) => tessellatePath(p)));
      setViewPaths(layer, this.name, out);
      if (!silent) showToast('Back to the raw stroke (Q cleans it up again)');
      return true;
    }

    // raw -> interpreted, region by region; organic regions stay untouched
    const { aspect, pxPerUnit } = this.interpretCtx(layer);
    let changed = false;
    const out = stored.map((region) => {
      const seg = interpretStoredPath(tessellatePath(region), aspect, pxPerUnit);
      if (seg) { changed = true; return seg; }
      return region;
    });
    if (!changed) {
      if (!silent) showToast('Reads as organic — kept exactly as drawn');
      return false;
    }
    if (morph) this.startMorph(layer.id, fromArr, out.map((p) => tessellatePath(p)));
    setViewPaths(layer, this.name, out);
    if (!silent) showToast('Cleaned up — Q toggles raw · [ ] adjusts corner radius');
    return true;
  }

  // Live corner-radius on an interpreted profile ([ / ]), coalesced into a
  // single undo step per burst (matches the feel of Phase 1 rects).
  adjustInterpretedRadius(dir) {
    const layer = activeLayer();
    if (!layer) return false;
    const paths = layer.paths[this.name];
    const segs = paths.filter(isSegPath);
    if (!segs.length) return false;
    if (!this.radiusSession || this.radiusSession.layer !== layer) {
      this.radiusSession = { layer, view: this.name, before: JSON.parse(JSON.stringify(paths)) };
    }
    let changed = false;
    for (const s of segs) changed = adjustSegPathRadius(s, dir) || changed;
    if (changed) {
      touch(layer);
      clearTimeout(this.radiusTimer);
      const sess = this.radiusSession;
      this.radiusTimer = setTimeout(() => {
        const after = JSON.parse(JSON.stringify(sess.layer.paths[sess.view]));
        recordPathsChange(sess.layer, sess.view, sess.before, after);
        if (this.radiusSession === sess) this.radiusSession = null;
      }, 500);
    }
    return true; // consumed the key even if already at the radius limit
  }

  // ----- raw <-> interpreted morph (visual only; state is already final) -----
  startMorph(layerId, fromArr, toArr) {
    const regions = [];
    const n = Math.min(fromArr.length, toArr.length);
    for (let i = 0; i < n; i++) {
      const from = resampleClosedN(fromArr[i], MORPH_SAMPLES);
      const to = alignLoop(from, resampleClosedN(toArr[i], MORPH_SAMPLES));
      if (from.length && to.length) regions.push({ from, to });
    }
    if (!regions.length) { this.draw(); return; }
    this.morphAnim = { layerId, regions, start: performance.now() };
    const tick = () => {
      if (!this.morphAnim) return;
      this.draw();
      if (performance.now() - this.morphAnim.start >= MORPH_MS) {
        this.morphAnim = null;
        this.draw();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }

  drawMorph(ctx, layer) {
    const t = Math.min(1, (performance.now() - this.morphAnim.start) / MORPH_MS);
    const e = t * t * (3 - 2 * t); // smoothstep
    const bp = this.boxPlanar(layer);
    const colorHex = '#' + layer.color.toString(16).padStart(6, '0');
    for (const region of this.morphAnim.regions) {
      ctx.beginPath();
      region.from.forEach((a, i) => {
        const b = region.to[i];
        const x = a.x + (b.x - a.x) * e, y = a.y + (b.y - a.y) * e;
        const s = this.w2s(bp.ch + x * bp.hw, bp.cv + y * bp.hh);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = colorHex + '2e';
      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 1.8;
      ctx.fill();
      ctx.stroke();
    }
  }

  // ----- layer dragging (Select / Move tool, W) -----
  beginLayerDrag(p, e) {
    const w = this.s2w(p.x, p.y);
    // prefer the active layer, else topmost hit
    const candidates = [...state.layers].reverse();
    const act = activeLayer();
    if (act) candidates.unshift(act);
    for (const layer of candidates) {
      if (!layer.visible) continue;
      const bp = this.boxPlanar(layer);
      if (Math.abs(w.h - bp.ch) <= bp.hw && Math.abs(w.v - bp.cv) <= bp.hh) {
        state.activeLayerId = layer.id;
        this.dragLayer = {
          layer,
          grabH: w.h - layer.position[this.cfg.hAxis],
          grabV: w.v - layer.position[this.cfg.vAxis],
          origPos: { ...layer.position }, // for one coalesced move-undo on release
        };
        this.canvas.setPointerCapture(e.pointerId);
        emit('change');
        return;
      }
    }
  }

  updateLayerDrag(p) {
    const { layer, grabH, grabV } = this.dragLayer;
    const w = this.s2w(p.x, p.y);
    let nh = w.h - grabH;
    let nv = w.v - grabV;
    const snapped = this.snapToOtherBoxes(layer, nh, nv);
    layer.position[this.cfg.hAxis] = snapped.h;
    layer.position[this.cfg.vAxis] = snapped.v;
    emit('change');
  }

  // Snap dragged box faces flush / stacked against other parts' faces, and snap
  // the part's centerline to other parts' centers and the world origin.
  snapToOtherBoxes(layer, nh, nv) {
    const snapDist = 8 / this.cam.scale;
    const hw = layer.box[this.cfg.hDim] / 2;
    const hh = layer.box[this.cfg.vDim] / 2;
    let bestH = null, bestV = null;
    // world centerline (origin) — keeps mirror-paired parts aligned to center
    if (Math.abs(nh) < snapDist) bestH = { c: 0, d: Math.abs(nh) };
    if (Math.abs(nv) < snapDist) bestV = { c: 0, d: Math.abs(nv) };
    for (const other of state.layers) {
      if (other === layer || !other.visible) continue;
      const ob = this.boxPlanar(other);
      // candidate alignments per axis: face-to-face stacking + flush faces + centers
      const hCands = [
        ob.ch - ob.hw - hw, ob.ch + ob.hw + hw, // stacked beside
        ob.ch - ob.hw + hw, ob.ch + ob.hw - hw, // flush edges
        ob.ch,                                   // centers aligned
      ];
      const vCands = [
        ob.cv - ob.hh - hh, ob.cv + ob.hh + hh,
        ob.cv - ob.hh + hh, ob.cv + ob.hh - hh,
        ob.cv,
      ];
      for (const c of hCands) {
        const d = Math.abs(nh - c);
        if (d < snapDist && (bestH === null || d < bestH.d)) bestH = { c, d };
      }
      for (const c of vCands) {
        const d = Math.abs(nv - c);
        if (d < snapDist && (bestV === null || d < bestV.d)) bestV = { c, d };
      }
    }
    return { h: bestH ? bestH.c : nh, v: bestV ? bestV.c : nv };
  }

  // Fit camera so all boxes are visible.
  zoomExtents() {
    if (!state.layers.length) return;
    let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const l of state.layers) {
      const bp = this.boxPlanar(l);
      minH = Math.min(minH, bp.ch - bp.hw); maxH = Math.max(maxH, bp.ch + bp.hw);
      minV = Math.min(minV, bp.cv - bp.hh); maxV = Math.max(maxV, bp.cv + bp.hh);
    }
    this.cam.h = (minH + maxH) / 2;
    this.cam.v = (minV + maxV) / 2;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (w && h) {
      this.cam.scale = Math.min(
        w / Math.max(50, (maxH - minH) * 1.5),
        h / Math.max(50, (maxV - minV) * 1.5),
      );
    }
    this.draw();
  }

  // ----- rendering -----
  draw() {
    const ctx = this.ctx;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    this.drawGrid(ctx, w, h);
    this.drawProjection(ctx);

    for (const layer of state.layers) {
      if (!layer.visible) continue;
      this.drawUnderlay(ctx, layer);
    }
    for (const layer of state.layers) {
      if (!layer.visible) continue;
      this.drawBox(ctx, layer);
      this.drawPaths(ctx, layer);
    }
    this.drawSymmetryAxis(ctx, h);
    this.drawInProgress(ctx);
  }

  drawGrid(ctx, w, h) {
    const minor = this.cam.scale > 4 ? 5 : this.cam.scale > 0.8 ? 10 : 100;
    const major = minor * 10;
    const tl = this.s2w(0, 0), br = this.s2w(w, h);
    const hMin = Math.min(tl.h, br.h), hMax = Math.max(tl.h, br.h);
    const vMin = Math.min(tl.v, br.v), vMax = Math.max(tl.v, br.v);

    for (const [step, color] of [[minor, '#222226'], [major, '#2e2e33']]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gh = Math.ceil(hMin / step) * step; gh <= hMax; gh += step) {
        const s = this.w2s(gh, 0);
        ctx.moveTo(s.x, 0); ctx.lineTo(s.x, h);
      }
      for (let gv = Math.ceil(vMin / step) * step; gv <= vMax; gv += step) {
        const s = this.w2s(0, gv);
        ctx.moveTo(0, s.y); ctx.lineTo(w, s.y);
      }
      ctx.stroke();
    }
    // origin axes
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 1.2;
    const o = this.w2s(0, 0);
    ctx.beginPath();
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, h);
    ctx.moveTo(0, o.y); ctx.lineTo(w, o.y);
    ctx.stroke();
  }

  // Translucent render of the actual 3D result from this view's direction —
  // every model change is visible in every view.
  drawProjection(ctx) {
    const proj = getProjection(this.name);
    if (!proj?.rect) return;
    const a = this.w2s(proj.rect.hMin, proj.rect.vMin);
    const b = this.w2s(proj.rect.hMax, proj.rect.vMax);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.drawImage(proj.canvas, x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
  }

  drawBox(ctx, layer) {
    const bp = this.boxPlanar(layer);
    const a = this.w2s(bp.ch - bp.hw, bp.cv - bp.hh);
    const b = this.w2s(bp.ch + bp.hw, bp.cv + bp.hh);
    const isActive = layer.id === state.activeLayerId;
    ctx.strokeStyle = isActive ? 'rgba(56,189,248,0.85)' : 'rgba(113,113,122,0.4)';
    ctx.lineWidth = isActive ? 1.5 : 1;
    ctx.setLineDash(isActive ? [] : [4, 4]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
  }

  drawPaths(ctx, layer) {
    // during a raw<->interpreted morph this view shows the tween instead
    if (this.morphAnim && this.morphAnim.layerId === layer.id) {
      this.drawMorph(ctx, layer);
      return;
    }
    const bp = this.boxPlanar(layer);
    const isActive = layer.id === state.activeLayerId;
    const colorHex = '#' + layer.color.toString(16).padStart(6, '0');
    for (const stored of layer.paths[this.name]) {
      const path = tessellatePath(stored);
      if (path.length < 2) continue;
      ctx.beginPath();
      path.forEach((p, i) => {
        const s = this.w2s(bp.ch + p.x * bp.hw, bp.cv + p.y * bp.hh);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = isActive ? colorHex + '2e' : colorHex + '14';
      ctx.strokeStyle = isActive ? colorHex : colorHex + '66';
      ctx.lineWidth = isActive ? 1.8 : 1.2;
      ctx.fill();
      ctx.stroke();
    }
  }

  drawUnderlay(ctx, layer) {
    const u = layer.underlay;
    if (!u || u.plane !== this.cfg.plane) return;
    let img = this.imageCache.get(u.src);
    if (!img) {
      img = new Image();
      img.src = u.src;
      img.onload = () => this.draw();
      this.imageCache.set(u.src, img);
    }
    if (!img.complete || !img.naturalWidth) return;
    const bp = this.boxPlanar(layer);
    const a = this.w2s(bp.ch - bp.hw, bp.cv - bp.hh);
    const b = this.w2s(bp.ch + bp.hw, bp.cv + bp.hh);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const dw = Math.abs(b.x - a.x), dh = Math.abs(b.y - a.y);
    ctx.save();
    ctx.globalAlpha = u.opacity;
    ctx.translate(x + dw / 2, y + dh / 2);
    ctx.scale(u.flipH ? -1 : 1, u.flipV ? -1 : 1);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  drawSymmetryAxis(ctx, h) {
    if (!state.symmetry) return;
    const layer = activeLayer();
    if (!layer) return;
    const bp = this.boxPlanar(layer);
    const s = this.w2s(bp.ch, 0);
    ctx.strokeStyle = 'rgba(251,191,36,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(s.x, 0); ctx.lineTo(s.x, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Stroke a rect/ellipse outline given world planar center + half-extents.
  strokeShape(ctx, tool, ch, cv, hw, hh, r, fill) {
    const pts = tool === 'ellipse'
      ? ellipsePath(ch, cv, hw, hh, 64)
      : roundedRectPath(ch, cv, hw, hh, r);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = this.w2s(p.x, p.y);
      i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    if (fill) { ctx.fillStyle = 'rgba(56,189,248,0.12)'; ctx.fill(); }
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  drawInProgress(ctx) {
    // closure animation: draw-on the smooth bridge, then fade it out
    if (this.closureAnim) {
      const t = Math.min(1, (performance.now() - this.closureAnim.start) / CLOSURE_ANIM_MS);
      const reveal = Math.min(1, t / 0.45); // draw on in the first 45%, fade after
      const alpha = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
      const pts = this.closureAnim.pts;
      const count = Math.max(2, Math.ceil(pts.length * reveal));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const s = this.w2s(pts[i].x, pts[i].y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
      ctx.restore();
    }
    // shape drag preview (rect / ellipse)
    if (this.shapeDrag) {
      const b = this.shapeDragBounds();
      this.strokeShape(ctx, this.shapeDrag.tool, b.ch, b.cv, b.hw, b.hh, 0, false);
    }
    // pending rect with live corner radius
    if (this.pendingRect) {
      const pr = this.pendingRect;
      this.strokeShape(ctx, 'rect', pr.ch, pr.cv, pr.hw, pr.hh, pr.r, true);
      const s = this.w2s(pr.ch, pr.cv - this.cfg.vSign * pr.hh);
      ctx.fillStyle = 'rgba(228,228,231,0.75)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('scroll / [ ] — corner radius · click to commit', s.x, s.y - 10);
      ctx.textAlign = 'left';
    }
    // freehand stroke
    if (this.drawing && this.drawing.length > 1) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      this.drawing.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
    // bezier preview
    if (this.bezier) {
      const b = this.bezier;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      b.anchors.forEach((a, i) => {
        const s = this.w2s(a.x, a.y);
        if (i === 0) { ctx.moveTo(s.x, s.y); return; }
        const prev = b.anchors[i - 1];
        const c0 = prev.out ?? prev, c1 = a.in ?? a;
        const sc0 = this.w2s(c0.x, c0.y), sc1 = this.w2s(c1.x, c1.y);
        ctx.bezierCurveTo(sc0.x, sc0.y, sc1.x, sc1.y, s.x, s.y);
      });
      ctx.stroke();
      // rubber-band to cursor
      if (this.hoverPos && b.anchors.length && !b.pending) {
        const last = b.anchors[b.anchors.length - 1];
        const s = this.w2s(last.x, last.y);
        ctx.strokeStyle = 'rgba(56,189,248,0.35)';
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(this.hoverPos.x, this.hoverPos.y);
        ctx.stroke();
      }
      // anchors + handles
      for (const a of b.anchors) {
        const s = this.w2s(a.x, a.y);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
        for (const handle of [a.in, a.out]) {
          if (!handle) continue;
          const hs = this.w2s(handle.x, handle.y);
          ctx.strokeStyle = 'rgba(56,189,248,0.5)';
          ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(hs.x, hs.y); ctx.stroke();
          ctx.beginPath(); ctx.arc(hs.x, hs.y, 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      // close indicator
      if (b.anchors.length >= 3) {
        const first = this.w2s(b.anchors[0].x, b.anchors[0].y);
        ctx.strokeStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(first.x, first.y, CLOSE_THRESHOLD_PX * 0.7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

export function redrawAll() {
  for (const v of Object.values(sketchViews)) v.draw();
}

const MORPH_SAMPLES = 96;

// Resample a closed polygon to exactly n points spaced by arc length.
function resampleClosedN(pts, n) {
  if (!pts || pts.length < 2) return [];
  let per = 0;
  for (let i = 0; i < pts.length; i++) per += dist(pts[i], pts[(i + 1) % pts.length]);
  if (per < 1e-9) return [];
  const step = per / n;
  const out = [];
  let i = 0, acc = 0;
  let a = pts[0], b = pts[1 % pts.length], segLen = dist(a, b);
  for (let k = 0; k < n; k++) {
    const want = k * step;
    while (acc + segLen < want && i < pts.length * 2) {
      acc += segLen; i++;
      a = pts[i % pts.length]; b = pts[(i + 1) % pts.length]; segLen = dist(a, b);
    }
    const t = segLen > 1e-12 ? (want - acc) / segLen : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// Rotate (and possibly reverse) `loop` to best line up with `ref` so the
// morph travels the shortest, least-twisted way between the two shapes.
function alignLoop(ref, loop) {
  const n = loop.length;
  if (ref.length !== n || n === 0) return loop;
  const candidates = [loop, loop.slice().reverse()];
  let best = loop, bestCost = Infinity;
  const stride = Math.max(1, n >> 4); // coarse offset search is plenty for 250ms
  for (const cand of candidates) {
    for (let off = 0; off < n; off += stride) {
      let cost = 0;
      for (let i = 0; i < n; i += stride) {
        const p = cand[(i + off) % n], q = ref[i];
        cost += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = cand.map((_, i) => cand[(i + off) % n]);
      }
    }
  }
  return best;
}

// Route the wand button / Q key to whichever ortho view the user last touched.
export function interpretFocusedView(opts) {
  const v = sketchViews[lastFocusedView];
  return v ? v.interpretProfile(opts) : false;
}

// [ / ] corner radius: a pending rect wins, otherwise the focused view's
// interpreted profile (if any).
export function adjustCornerRadius(dir) {
  if (adjustPendingCornerRadius(dir)) return true;
  const v = sketchViews[lastFocusedView];
  return v ? v.adjustInterpretedRadius(dir) : false;
}

// Commit any rect still pending a corner-radius tweak (e.g. on tool change),
// so switching tools never silently drops a drawn shape.
export function commitAllPendingShapes() {
  for (const v of Object.values(sketchViews)) {
    if (v.pendingRect) v.commitPendingRect();
  }
}

// Route [ / ] corner-radius hotkeys to whichever view holds the pending rect.
export function adjustPendingCornerRadius(dir) {
  for (const v of Object.values(sketchViews)) {
    if (v.adjustPendingRadius(dir)) return true;
  }
  return false;
}

export function cancelAllSketches() {
  let any = false;
  for (const v of Object.values(sketchViews)) any = v.cancelSketch() || any;
  return any;
}

// CSG rebuilds finish after the 'change' redraw — refresh the ghost
// projections once the new mesh exists.
on('projection', () => redrawAll());
