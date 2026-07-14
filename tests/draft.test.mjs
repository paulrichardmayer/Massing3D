// Smoke test for draft mode: geometry helpers, entity flattening, snapping,
// ortho lock, and v7 serialization round-trip.
import { circumcircle, arcParams, arcPoints, catmullRom } from '../js/geometry.js';
import { entityPoints, snapDraftPoint, orthoLock } from '../js/draft.js';
import { state, addDrawing, undo, redo, serialize, deserialize } from '../js/state.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

// ---- circumcircle / arc ----
{
  const c = circumcircle({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 });
  check('circumcircle: unit-ish circle recovered', c && near(c.cx, 0) && near(c.cy, 0) && near(c.r, 10));
  check('circumcircle: collinear -> null', circumcircle({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 9 }) === null);

  const p = arcParams({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 });
  const pts = arcPoints(p, 16);
  check('arc: passes near the through point', pts.some((q) => Math.hypot(q.x, q.y - 10) < 0.5));
  check('arc: endpoints exact', near(pts[0].x, 10, 1e-4) && near(pts[pts.length - 1].x, -10, 1e-4));
  // same three points, through on the OTHER side -> the long way around
  const p2 = arcParams({ x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 });
  const pts2 = arcPoints(p2, 16);
  check('arc: sweep follows the through point', pts2.some((q) => q.y < -9));
}

// ---- catmull-rom ----
{
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: 0 }];
  const open = catmullRom(pts, false, 8);
  check('curve: interpolates its through points', pts.every((p) => open.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.01)));
  check('curve: open ends at the last point', near(open[open.length - 1].x, 20));
  const closed = catmullRom(pts, true, 8);
  check('curve: closed loops back to start', near(closed[closed.length - 1].x, closed[0].x));
}

// ---- entity flattening ----
{
  const circle = entityPoints({ kind: 'circle', pts: [{ x: 5, y: 5 }, { x: 15, y: 5 }] });
  check('circle entity: radius honored', circle.every((p) => near(Math.hypot(p.x - 5, p.y - 5), 10, 1e-6)));
  const line = entityPoints({ kind: 'poly', pts: [{ x: 0, y: 0 }, { x: 7, y: 7 }], closed: false });
  check('poly entity: passthrough', line.length === 2 && line[1].x === 7);
}

// ---- snapping + ortho (mock view) ----
{
  state.drawings.front = [{ kind: 'poly', pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false }];
  const view = { name: 'front', cam: { scale: 2 }, draftOp: null };
  let s = snapDraftPoint(view, { h: 101, v: 2 });
  check('snap: endpoint wins nearby', s.label === 'end' && s.x === 100 && s.y === 0);
  s = snapDraftPoint(view, { h: 51, v: 1 });
  check('snap: midpoint of a segment', s.label === 'mid' && s.x === 50);
  s = snapDraftPoint(view, { h: 248.5, v: 251 });
  check('snap: grid at 10mm when nothing closer', s.label === 'grid' && s.x === 250 && s.y === 250);
  s = snapDraftPoint(view, { h: 333.7, v: 444.2 });
  check('snap: none -> raw point', s.label === null && near(s.x, 333.7));

  const o = orthoLock({ x: 0, y: 0 }, { x: 100, y: 8 });
  check('ortho: near-horizontal locks to 0 deg', near(o.y, 0) && o.x > 99);
  const o45 = orthoLock({ x: 0, y: 0 }, { x: 90, y: 100 });
  check('ortho: diagonal locks to 45 deg', near(o45.x, o45.y));
  state.drawings.front = [];
}

// ---- drawings undo + v7 round-trip ----
{
  deserialize({ v: 6, units: 'mm', activeLayerId: 1, layers: [
    { id: 1, name: 'Part 1', visible: true, role: 'solid', box: { w: 100, h: 100, d: 100 }, position: { x: 0, y: 50, z: 0 }, fillet: 0, paths: { top: [], front: [], side: [] } },
  ] });
  check('v6 load: empty drawings + massing mode', state.drawings.front.length === 0 && state.draftMode === false);

  addDrawing('front', { kind: 'poly', pts: [{ x: 0, y: 0 }, { x: 450, y: 0 }], closed: false });
  addDrawing('front', { kind: 'circle', pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }], closed: true });
  check('addDrawing: two entities stored', state.drawings.front.length === 2);
  undo();
  check('undo: drops the circle', state.drawings.front.length === 1);
  redo();
  check('redo: circle returns', state.drawings.front.length === 2);

  state.draftMode = true;
  const out = serialize();
  check('serialize: v7 with drawings + sticky mode', out.v === 7 && out.drawings.front.length === 2 && out.draftMode === true);
  deserialize(JSON.parse(JSON.stringify(out)));
  check('round-trip: drawings + mode survive', state.drawings.front.length === 2 && state.draftMode === true);
  // malformed entities are dropped, not fatal
  out.drawings.front.push({ kind: 'poly', pts: [{ x: NaN, y: 0 }] }, { kind: 'nope', pts: [] });
  deserialize(JSON.parse(JSON.stringify(out)));
  check('defensive load: malformed entities dropped', state.drawings.front.length === 2);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
