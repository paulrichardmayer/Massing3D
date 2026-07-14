// Smoke test for the manufacturing-process SDF generators + v6 migration.
import { compilePart, meshPart } from '../js/sdf.js';
import { state, deserialize, serialize, drivingView } from '../js/state.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failures++;
};

const rect = (hw, hh) => [
  { x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh },
];
const box = { hw: 80, hh: 80, hd: 120 };

// ---- 1. plain extrusion: square front profile swept along Z ----
{
  const desc = { box, k: 0, process: 'extrude', params: { view: 'front' }, views: { front: [rect(50, 50)] } };
  const sdf = compilePart(desc);
  check('extrude: center inside', sdf(0, 0, 0) < 0);
  check('extrude: inside near both ends', sdf(45, 45, -115) < 0 && sdf(45, 45, 115) < 0);
  check('extrude: outside profile', sdf(60, 0, 0) > 0);
  check('extrude: outside past cap', sdf(0, 0, 125) > 0);
  const m = meshPart({ ...desc, res: 64 });
  check('extrude: mesh non-empty', m.indices.length > 0 && m.positions.length > 0);
  // mesh extents ≈ 100 x 100 x 240
  let maxX = 0, maxY = 0, maxZ = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    maxX = Math.max(maxX, Math.abs(m.positions[i]));
    maxY = Math.max(maxY, Math.abs(m.positions[i + 1]));
    maxZ = Math.max(maxZ, Math.abs(m.positions[i + 2]));
  }
  check('extrude: mesh extents ~ (50,50,120)',
    Math.abs(maxX - 50) < 6 && Math.abs(maxY - 50) < 6 && Math.abs(maxZ - 120) < 6,
    `got ${maxX.toFixed(1)}, ${maxY.toFixed(1)}, ${maxZ.toFixed(1)}`);
}

// ---- 2. draft: section erodes toward the +axis end ----
{
  const draftTan = Math.tan(10 * Math.PI / 180); // ~42mm erosion over 240mm
  const desc = {
    box, k: 0, process: 'extrude',
    params: { view: 'front', draftTan }, views: { front: [rect(50, 50)] },
  };
  const sdf = compilePart(desc);
  check('draft: base end still full-size', sdf(45, 0, -115) < 0);
  check('draft: far end eroded at x=45', sdf(45, 0, 115) > 0);
  check('draft: far end keeps its core', sdf(4, 0, 115) < 0);
}

// ---- 3. twist: rectangle rotates ~90° end-to-end ----
{
  const desc = {
    box, k: 0, process: 'extrude',
    params: { view: 'front', twistRad: Math.PI / 2 }, views: { front: [rect(60, 20)] },
  };
  const sdf = compilePart(desc);
  check('twist: base end wide & short', sdf(50, 0, -118) < 0 && sdf(0, 50, -118) > 0);
  check('twist: far end tall & narrow', sdf(0, 50, 118) < 0 && sdf(50, 0, 118) > 0);
}

// ---- 3b. edge treatment on the extrusion caps (Phase 7) ----
{
  const mk = (edge, edgeSize) => compilePart({
    box, k: 0, process: 'extrude',
    params: { view: 'front', edge, edgeSize }, views: { front: [rect(50, 50)] },
  });
  const round = mk('round', 8);
  check('edge round: cap-perimeter corner cut', round(49.5, 0, 119.5) > 0);
  check('edge round: wall mid still full-size', round(49.5, 0, 0) < 0);
  check('edge round: cap center intact', round(0, 0, 119.5) < 0);
  // the rounded corner passes ~r from both faces: probe the 45-degree point
  const r = 8, c = Math.SQRT1_2 * r;
  check('edge round: arc surface at 45 degrees', Math.abs(round(50 - r + c, 0, 120 - r + c)) < 0.8);
  const cham = mk('chamfer', 8);
  check('edge chamfer: corner cut', cham(49.5, 0, 119.5) > 0);
  check('edge chamfer: wall & cap intact', cham(49.5, 0, 0) < 0 && cham(0, 0, 119.5) < 0);
  // chamfer surface: profile-dist + axis-dist = -c -> e.g. (-4) + (-4) = -8
  check('edge chamfer: 45-degree plane at the edge', Math.abs(cham(46, 0, 116)) < 0.8);
}

// ---- 3c. drafting -> parts bridge: addPartFromRegion (Phase 7) ----
{
  const { state: st, addPartFromRegion } = await import('../js/state.js');
  const region = [
    { x: -50, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 400 }, { x: -50, y: 400 },
  ];
  const before = st.layers.length;
  const panel = addPartFromRegion('front', region, { thickness: 18 });
  check('promote: part created', st.layers.length === before + 1 && panel.name.startsWith('Panel'));
  check('promote: box wraps the region + thickness', panel.box.w === 100 && panel.box.h === 300 && panel.box.d === 18);
  check('promote: positioned at the region center, on-axis', panel.position.x === 0 && panel.position.y === 250 && panel.position.z === 0);
  check('promote: extrude process w/ the drawing view', panel.process === 'extrude' && panel.processParams.profileView === 'front');
  const prof = panel.paths.front[0];
  check('promote: profile normalized to the box', prof.length === 4 && Math.abs(prof[0].x) === 1 && Math.abs(prof[0].y) === 1);
  // a plan-view (top) panel rests on the ground
  const flat = addPartFromRegion('top', region, { thickness: 12 });
  check('promote: plan panels rest on the ground', flat.box.h === 12 && flat.position.y === 6);
}

// ---- 4. turn (was revolve): side profile lathed around Y ----
{
  const desc = { box, k: 0, process: 'turn', views: { side: [rect(60, 60)] } };
  const sdf = compilePart(desc);
  check('turn: inside on X axis (radius < 60)', sdf(50, 0, 0) < 0);
  check('turn: inside on Z axis too (lathed)', sdf(0, 0, 50) < 0);
  check('turn: outside past radius on diagonal', sdf(55, 0, 55) > 0);
  // legacy descriptor spelling still lathes
  const legacy = compilePart({ box, k: 0, revolve: true, views: { side: [rect(60, 60)] } });
  check('turn: legacy revolve flag honored', legacy(0, 0, 50) < 0 && legacy(55, 0, 55) > 0);
}

// ---- 5. massing unchanged: two silhouettes intersect ----
{
  const desc = { box, k: 0, process: 'massing', views: { front: [rect(50, 50)], side: [rect(50, 50)] } };
  const sdf = compilePart(desc);
  check('massing: Steinmetz-ish core inside', sdf(0, 0, 0) < 0);
  check('massing: clipped by both profiles', sdf(0, 60, 0) > 0);
}

// ---- 5b. stamp: constant-thickness skin over the die, open face peels ----
{
  const t = 6;
  const mk = (openFace) => compilePart({
    box, k: 0, process: 'stamp',
    params: { thickness: t, openFace }, views: {}, // die = the plain box
  });
  const closed = mk('none');
  check('stamp: center is hollow', closed(0, 0, 0) > 0);
  check('stamp: skin straddles the die surface', closed(80, 0, 0) < 0 && closed(80 - t, 0, 0) > 0 && closed(80 + t, 0, 0) > 0);
  check('stamp: bottom panel present when sealed', closed(0, -80, 0) < 0);
  const tray = mk('ny');
  check('stamp: open face removes the bottom panel', tray(0, -80, 0) > 0);
  check('stamp: walls survive the open face', tray(80, 0, 0) < 0);
  const m = meshPart({ box, k: 0, process: 'stamp', params: { thickness: t, openFace: 'ny' }, views: {}, res: 64 });
  check('stamp: mesh non-empty', m.indices.length > 0);
}

// ---- 6. v5 -> v6 migration + round-trip ----
{
  const v5 = {
    v: 5, units: 'mm', activeLayerId: 1,
    layers: [
      { id: 1, name: 'Part 1', visible: true, role: 'solid', sharp: false, revolve: true, color: 0x60a5fa, box: { w: 100, h: 100, d: 100 }, position: { x: 0, y: 50, z: 0 }, fillet: 0.2, paths: { top: [], front: [], side: [] } },
      { id: 2, name: 'Part 2', visible: true, role: 'solid', sharp: true, revolve: false, color: 0xf472b6, box: { w: 100, h: 100, d: 100 }, position: { x: 120, y: 50, z: 0 }, fillet: 0, paths: { top: [], front: [], side: [] } },
    ],
  };
  deserialize(v5);
  check('migrate: revolve:true -> turn', state.layers[0].process === 'turn');
  check('migrate: revolve:false -> massing', state.layers[1].process === 'massing');
  check('migrate: default params present', state.layers[0].processParams.profileView === 'front' && state.layers[0].processParams.draft === 0);
  check('drivingView: turn -> side', drivingView(state.layers[0]) === 'side');
  check('drivingView: massing -> null', drivingView(state.layers[1]) === null);

  const out = serialize();
  check('serialize: writes current schema + process', out.v === 7 && out.layers[0].process === 'turn');
  deserialize(JSON.parse(JSON.stringify(out))); // v6 round-trip
  check('round-trip: v6 loads clean', state.layers[0].process === 'turn' && state.layers[1].process === 'massing');

  state.layers[1].process = 'extrude';
  state.layers[1].processParams.profileView = 'top';
  check('drivingView: extrude -> its profile view', drivingView(state.layers[1]) === 'top');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
