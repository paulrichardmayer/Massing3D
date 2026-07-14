// Minimal DXF (R12 ASCII) writer for the drafting layer (Phase 8) — the
// interchange format furniture shops and CNC/laser vendors actually take.
// One DXF layer per view (TOP / FRONT / SIDE). Arcs and circles stay true
// entities; polylines/curves flatten. Pure and node-testable.

import { arcParams, catmullRom, filletPolyline } from './geometry.js';

const DEG = 180 / Math.PI;

function polylineEnt(out, layer, pts, closed) {
  out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0');
  for (const p of pts) {
    out.push('0', 'VERTEX', '8', layer, '10', p.x.toFixed(3), '20', p.y.toFixed(3));
  }
  out.push('0', 'SEQEND');
}

export function dxfFromDrawings(drawings) {
  const out = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const [view, ents] of Object.entries(drawings)) {
    const layer = view.toUpperCase();
    for (const e of ents) {
      if (e.kind === 'circle') {
        const r = Math.hypot(e.pts[1].x - e.pts[0].x, e.pts[1].y - e.pts[0].y);
        out.push('0', 'CIRCLE', '8', layer,
          '10', e.pts[0].x.toFixed(3), '20', e.pts[0].y.toFixed(3), '40', r.toFixed(3));
      } else if (e.kind === 'arc') {
        const p = arcParams(e.pts[0], e.pts[1], e.pts[2]);
        if (!p) { polylineEnt(out, layer, [e.pts[0], e.pts[2]], false); continue; }
        // DXF arcs are always CCW from angle 51 to 61
        const a0 = (p.ccw ? p.a0 : p.a2) * DEG;
        const a1 = (p.ccw ? p.a2 : p.a0) * DEG;
        out.push('0', 'ARC', '8', layer,
          '10', p.cx.toFixed(3), '20', p.cy.toFixed(3), '40', p.r.toFixed(3),
          '50', ((a0 + 360) % 360).toFixed(3), '51', ((a1 + 360) % 360).toFixed(3));
      } else if (e.kind === 'curve') {
        polylineEnt(out, layer, catmullRom(e.pts, !!e.closed, 12), !!e.closed);
      } else if (e.kind === 'poly') {
        const pts = e.fillet > 0 ? filletPolyline(e.pts, !!e.closed, e.fillet, !!e.chamfer) : e.pts;
        polylineEnt(out, layer, pts, !!e.closed);
      }
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}
