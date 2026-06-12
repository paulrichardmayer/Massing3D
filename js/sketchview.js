// Orthographic sketch viewports (Top / Front / Side).
// 2D canvas overlay with pan/zoom, freehand + bezier drawing, symmetry,
// underlay rendering, and box-layer dragging with face snapping.
// Drawing happens here ONLY — the perspective view never receives sketches.

import {
  state, activeLayer, setViewPaths, touch, emit, on,
} from './state.js';
import {
  dist, simplifyDP, chaikinClosed, flattenBezierPath, pathArea, mirrorPathH,
  smoothClosure,
} from './geometry.js';
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

      const tool = state.tool;
      if (tool === 'nav') {
        this.panState = { x: p.x, y: p.y };
        c.setPointerCapture(e.pointerId);
      } else if (tool === 'select') {
        this.beginLayerDrag(p, e);
      } else if (tool === 'freehand') {
        if (!activeLayer()) return;
        this.drawing = [p];
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
      if (this.bezier?.pending) this.bezier.pending = false;
      if (this.dragLayer) {
        this.dragLayer = null;
        touch(activeLayer());
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    c.addEventListener('pointerleave', () => { this.hoverPos = null; this.draw(); });

    // Scroll wheel zoom centered on cursor.
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
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
    this.commitPath(layer, path);
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
    const had = this.drawing || this.bezier;
    this.drawing = null;
    this.bezier = null;
    if (had) this.draw();
    return !!had;
  }

  // Convert world-planar path to box-normalized coords ([-1,1] per axis),
  // apply symmetry, commit. Design-director workflow: each view holds ONE
  // profile (the silhouette from that direction) — a new sketch replaces the
  // previous one, and Ctrl+Z restores it. The final form is always the
  // intersection of the three silhouettes within the box.
  commitPath(layer, worldPath) {
    if (pathArea(worldPath) < 4) { this.draw(); return; }
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
      return;
    }

    // Boolean cleanup: repair self-intersecting strokes, and with symmetry on
    // union the stroke with its mirror so a stroke crossing the centerline
    // yields one clean outline instead of two overlapping shapes (which would
    // self-intersect the extrusion brush and break CSG).
    const paths = cleanPaths(rel, state.symmetry ? mirrorPathH(rel, 0) : null);
    if (!paths.length) { this.draw(); return; }
    const replaced = layer.paths[this.name].length > 0;
    setViewPaths(layer, this.name, paths);
    if (replaced) {
      const label = { top: 'Top', front: 'Front', side: 'Side' }[this.name];
      showToast(`${label} profile updated (Ctrl+Z restores the previous one)`);
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

  // Snap dragged box faces flush / stacked against other layers' faces.
  snapToOtherBoxes(layer, nh, nv) {
    const snapDist = 8 / this.cam.scale;
    const hw = layer.box[this.cfg.hDim] / 2;
    const hh = layer.box[this.cfg.vDim] / 2;
    let bestH = null, bestV = null;
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
    const bp = this.boxPlanar(layer);
    const isActive = layer.id === state.activeLayerId;
    const colorHex = '#' + layer.color.toString(16).padStart(6, '0');
    for (const path of layer.paths[this.name]) {
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

export function cancelAllSketches() {
  let any = false;
  for (const v of Object.values(sketchViews)) any = v.cancelSketch() || any;
  return any;
}

// CSG rebuilds finish after the 'change' redraw — refresh the ghost
// projections once the new mesh exists.
on('projection', () => redrawAll());
