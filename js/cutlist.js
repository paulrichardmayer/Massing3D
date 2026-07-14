// Cut list (Phase 8): the list a furniture maker takes to the shop.
// Every visible SOLID part contributes its bounding dimensions, sorted
// L ≥ W ≥ T; identical sizes group into one row with a quantity. Pure and
// three-free so it's node-testable.

// Round to 0.1 mm so float noise never splits a quantity group.
const r1 = (v) => Math.round(v * 10) / 10;

export function buildCutList(layers) {
  const groups = new Map();
  for (const l of layers) {
    if (!l.visible || l.role === 'cut') continue;
    const dims = [r1(l.box.w), r1(l.box.h), r1(l.box.d)].sort((a, b) => b - a);
    const key = dims.join('x');
    const g = groups.get(key);
    if (g) { g.qty += 1; g.parts.push(l.name); }
    else groups.set(key, { length: dims[0], width: dims[1], thickness: dims[2], qty: 1, parts: [l.name] });
  }
  // big pieces first — how cut lists are actually read
  return [...groups.values()].sort((a, b) => b.length * b.width - a.length * a.width);
}

export function cutListCSV(rows) {
  const esc = (s) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = ['Qty,Length (mm),Width (mm),Thickness (mm),Parts'];
  for (const row of rows) {
    lines.push(`${row.qty},${row.length},${row.width},${row.thickness},${esc(row.parts.join('; '))}`);
  }
  return lines.join('\n');
}
