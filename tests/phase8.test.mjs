// Phase 8 smoke tests: cut list builder + DXF writer.
import { buildCutList, cutListCSV } from '../js/cutlist.js';
import { dxfFromDrawings } from '../js/dxf.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

// ---- cut list ----
{
  const layers = [
    { name: 'Seat', visible: true, role: 'solid', box: { w: 400, h: 18, d: 350 } },
    { name: 'Left side', visible: true, role: 'solid', box: { w: 18, h: 700, d: 350 } },
    { name: 'Right side', visible: true, role: 'solid', box: { w: 18, h: 700.04, d: 350 } }, // rounds into the same group
    { name: 'Groove', visible: true, role: 'cut', box: { w: 10, h: 10, d: 350 } },
    { name: 'Hidden shelf', visible: false, role: 'solid', box: { w: 300, h: 18, d: 250 } },
  ];
  const rows = buildCutList(layers);
  check('cutlist: cuts and hidden parts excluded', rows.every((r) => !r.parts.includes('Groove') && !r.parts.includes('Hidden shelf')));
  const sides = rows.find((r) => r.parts.includes('Left side'));
  check('cutlist: identical sizes group with qty', sides?.qty === 2 && sides.parts.includes('Right side'));
  check('cutlist: dims sorted L>=W>=T', rows.every((r) => r.length >= r.width && r.width >= r.thickness));
  check('cutlist: sides read 700 x 350 x 18', sides.length === 700 && sides.width === 350 && sides.thickness === 18);
  check('cutlist: biggest piece first', rows[0].parts.includes('Left side'));
  const csv = cutListCSV(rows);
  check('cutlist: CSV header + one line per group', csv.split('\n').length === rows.length + 1 && csv.startsWith('Qty,'));
}

// ---- DXF ----
{
  const drawings = {
    top: [],
    front: [
      { kind: 'poly', pts: [{ x: 0, y: 0 }, { x: 450, y: 0 }], closed: false },
      { kind: 'poly', pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }], closed: true, fillet: 10 },
      { kind: 'circle', pts: [{ x: 50, y: 30 }, { x: 62, y: 30 }], closed: true },
      { kind: 'arc', pts: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }] },
    ],
    side: [{ kind: 'curve', pts: [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 80, y: 0 }], closed: false }],
  };
  const dxf = dxfFromDrawings(drawings);
  check('dxf: sections + EOF', dxf.includes('SECTION') && dxf.includes('ENTITIES') && dxf.trim().endsWith('EOF'));
  check('dxf: polylines emitted', (dxf.match(/^POLYLINE$/gm) || []).length === 3); // line, filleted rect, curve
  check('dxf: circle with radius 12', dxf.includes('CIRCLE') && dxf.includes('12.000'));
  check('dxf: true arc entity', (dxf.match(/^ARC$/gm) || []).length === 1);
  check('dxf: per-view layers', dxf.includes('FRONT') && dxf.includes('SIDE'));
  const closedFlags = (dxf.match(/^70$/gm) || []).length;
  check('dxf: closed flag rows present', closedFlags === 3);
  // the filleted rectangle flattens with arcs: more vertices than 4
  const verts = (dxf.match(/^VERTEX$/gm) || []).length;
  check('dxf: fillets flattened into vertices', verts > 2 + 4 + 25); // line(2) + rect(>4) + curve samples
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
