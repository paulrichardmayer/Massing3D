# Massing3D — Testing checklist

Manual QA checklist tied to each phase's acceptance criteria. Run from a fresh
load (`New` clears everything). Items marked ✅ have been verified in automated
checks driven through the live modules; re-verify by hand after UI changes.

## Invariants (never break these)

- [ ] Undo/redo covers sketches **and** part create / delete / duplicate / move / role / reorder.
- [ ] `.json` Save → Open round-trips exactly (schema **v6**; older v1–v5 files migrate on load — a v5 `revolve:true` part loads as the **Turn** process).
- [ ] Share link encodes/decodes the whole project (minus underlay images).
- [ ] OBJ and STL export produce a watertight mesh.

---

## Phase 2 — Sketch interpretation ("Clean up")

- [ ] Draw a sloppy rectangle with the **mouse** → snaps to an exact rectangle (auto-interprets on release).
- [ ] Draw a rectangle with intentionally rounded corners → rectangle with **equal-radius** fillets; `[` `]` adjust the radius live.
- [ ] Draw a camera side profile (straight bottom, curved top) → straight bottom edge, smooth arc top, tangent transitions.
- [ ] Draw an organic blob with a **stylus** (auto-interpret off for pen) → left untouched.
- [ ] `Q` toggles interpreted ↔ raw; the ~250 ms morph plays; one `Ctrl+Z` restores the raw stroke.

## Phase 3 — Parts

- [ ] New part spawns **beside** the active part on +X (not stacked on top).
- [ ] Dragging a part snaps to other parts' faces, their centerlines, and the world origin.
- [ ] Build a camera from 3 parts: **body** (solid) + **lens barrel** (solid) + **grip** (cut). The grip cut carves the body where they overlap.
- [ ] **Mirror duplicate (X)** makes an instant mirrored pair (position and silhouettes mirrored about the centerline).
- [ ] Duplicate, rename (double-click), reorder (drag), isolate/solo (Alt-click) all work.
- [ ] Delete a part, then `Ctrl+Z` → the part returns **with its sketches**.
- [ ] Cut parts render as translucent red ghosts and are excluded from OBJ/STL export.
- [ ] Moving a cut away from a solid it was biting restores that solid (no stale hole).
- [ ] Old project files (v1–v4) open; "Layer N" auto-names become "Part N"; role defaults to Solid.

## Phase 4 — SDF mesh pipeline

- [ ] **Steinmetz:** circle in Top + circle in Front, **Blend = 0** → the sharp Steinmetz (bicylinder) solid; extents match the circle diameters.
- [ ] Dragging the **Blend** slider melts the form into a soft pebble **in real time** (no UI stall — meshing runs in the worker; the previous mesh stays visible while it computes).
- [ ] Surfaces look liquid-smooth (vertex normals from the SDF gradient), not faceted.
- [ ] Exported **STL is watertight** (every edge shared by exactly two triangles; consistent outward winding) and uses a finer resolution than the interactive view.
- [ ] **Sharp mode** matches the old boolean output (crisp CSG edges) and ignores the Blend slider.
- [ ] A Cut part still subtracts under the SDF pipeline, blended with the same `k`.
- [ ] No console errors while dragging Blend or toggling Sharp.

## Phase 5 — Revolve (now the **Turn** process)

- [ ] Turn a part to **Revolve**, sketch a bottle half-profile in **Side** view → a clean lathe form (verify the circular cross-section in Top view).
- [ ] On a Revolve part, drawing in Top/Front view is rejected with a one-line hint; Side view still works.
- [ ] The **Blend** slider still softens a revolved form.
- [ ] **Cut + Revolve** combine: a revolved Cut part carves a revolved recess into an overlapping solid; result stays watertight.

## Phase 6 — Manufacturing processes (extrusion) ✅

Automated coverage: `node tests/processes.test.mjs` (SDF generators + v5→v6
migration, dependency-free). Manual checks:

- [x] Process picker shows **Massing / Extrude / Turn**; Massing is the default and extrude controls stay hidden until Extrude is picked.
- [x] **Extrude** + rectangle in the Front view → a crisp constant-section prism through the full depth (no silhouette mush), correct in all ghost projections.
- [x] **Draft 10°** tapers the section toward the +axis end in real time; the base end stays full-size.
- [x] **Twist 120°** spirals the section along the sweep; Draft and Twist compose.
- [x] Drawing in a non-profile view on an Extrude part is rejected with a hint naming the right view; same for Turn (Side).
- [x] Switching the profile view to one with no sketch leaves the part as its plain box (no crash).
- [x] Undo/redo across process switches doesn't throw; switching back to Massing restores the silhouette pipeline.
- [x] No console errors through all of the above (verified via scripted Chromium run).
- [ ] OBJ/STL export of an extruded part with draft + twist is watertight (worker path, finer grid).
- [ ] A Cut part with the Extrude process carves a drafted/twisted recess.

## Phase 7 — 3D-print preview (analyzer) ✅

Automated coverage: support-area math in `tests/processes.test.mjs`-style node
checks (see `js/printpreview.js` — `computeSupportStats` is three-free). Manual
checks (verified via scripted Chromium run on a horizontal cylinder):

- [x] **Print** button toggles the preview + dockable panel; solids get layer banding, cuts stay red ghosts.
- [x] Overhang readout is physical: a horizontal cylinder reads MORE support area as the threshold tightens (24.2% @ 20° → 14.1% @ 45° → none @ 80°, where only the bed-exempt bottom faces that steeply down).
- [x] **Build progress** scrub removes material above the cut, shows the interior as flat infill-orange, glows the current layer amber.
- [x] Re-meshing while the preview is on (Blend drag) returns an analyzed mesh and refreshes the support readout.
- [x] Toggle off restores the standard materials exactly; ortho ghosts always show the whole part (scrub is lifted for projection renders).
- [x] No console errors through all of the above.
- [ ] Multi-part build: two solids at different heights share one plate/build range.

## Phase 8 — Injection-molding preview (analyzer) ✅

Automated coverage: `node tests/mold.test.mjs` (undercut shadowing, thickness,
area stats on analytic shapes). Manual checks (verified via scripted Chromium
on a box with a cut hole through it):

- [x] **Mold** button toggles the preview + panel; Draft view shows orange under-drafted walls, magenta undercut inside the hole, cyan parting ring where the surface turns through vertical (flat vertical walls do NOT flood cyan — they're a draft problem, not a parting line).
- [x] Pull-axis physics: hole ⊥ pull → 23.6% undercut; pull along the hole axis → 0.0% undercut (releases through the openings).
- [x] Thickness view: a solid block reads uniformly thick/red with a 40–240 mm range readout.
- [x] Print and Mold previews are mutually exclusive — enabling one closes the other.
- [x] Re-meshing while the preview is on (Blend drag) re-bakes undercut/thickness attributes.
- [x] Loading a project through **Open** while previews exist round-trips v6 cleanly.
- [x] No console errors through all of the above.
- [ ] Undercut bake cost on very dense parts (export-res meshes) — watch for hitching.

## Phase 9 — Stamp / deep-draw generator ✅

Automated coverage: stamp block in `tests/processes.test.mjs` (hollow center,
skin straddles the die surface, open face peels the panel, sealed variant).
Manual checks (scripted Chromium):

- [x] **Stamp** process turns the sketched form into a constant-thickness skin; the open-face picker flips which side peels (tray ↓, cup ↑, sealed hollow).
- [x] Sheet-thickness slider re-forms the shell live.
- [x] Cross-check with the molding **Thickness** analyzer: an 8 mm stamped skin reads ~5–11 mm (green), vs 40–240 mm for the solid die.
- [x] Undo across process switches; no console errors.
- [x] The single-file preview build (all libs inlined) boots with **zero external requests**, and still meshes when `Worker` is unavailable (main-thread fallback).
- [ ] STL export of a stamped shell is watertight at export resolution.

## Phase 10 — Draft mode (technical drawings) ✅

Automated coverage: `node tests/draft.test.mjs` (arc/circumcircle/curve math,
snapping, ortho lock, drawings undo, v7 round-trip, defensive load). Manual
checks (scripted Chromium — a side-table elevation drawn in the Front view):

- [x] `Tab` toggles Draft mode: amber `· DRAFT` header badge, draft tool buttons appear, crosshair cursor; toggle is sticky per project (saved in the file).
- [x] All five tools commit correct entities: closed polyline (click-first), open polyline (Enter), 3-point arc, circle, open curve — verified in the saved `.json` (v7).
- [x] **Shift ortho beats snapping**: a deliberately off-vertical click stores a leg with dx = 0.0000 (regression: grid snap used to bend ortho lines).
- [x] Esc cancels a half-built polyline without storing anything; Ctrl+Z removes exactly the last entity.
- [x] Back in Quick Massing: drawings dim to a reference layer and solid workflows (fill-box, processes, analyzers) are unaffected.
- [x] No console errors throughout.
- [ ] Stylus polyline/curve input on an actual tablet.

## Phase 11 — Draft precision pass + free-floating panels ✅

Automated coverage: fillet/chamfer/intersection math in
`tests/draft.test.mjs` (33 checks). Manual checks (scripted Chromium,
asserted against real Save downloads):

- [x] **Typed length**: click, type `450`, Enter → the stored segment is 450.000 mm with dy = 0 (direction from the ortho-locked hover).
- [x] Selection editing: click an entity with Select (amber highlight) → **drag** moves it (single undo step restores exactly), **Delete** removes it, **M** creates a mirrored copy about x = 0.
- [x] **[ ]** apply a non-destructive corner fillet to a selected polyline (stored as `fillet` on the entity); **C** toggles chamfer — both visible and round-trip through save.
- [x] Points snap to **intersections** of drawn segments (label `int`).
- [x] **Panels float freely**: drop the Parts strip mid-screen and it stays exactly there; drop near a corner and it docks flush (12 px margin) and stacks as before.
- [x] No console errors.
- [ ] Numeric entry for angles (only lengths ship in this phase).

## Phase 12 — The bridge + parts panel UX + nav cube ✅

Automated coverage: edge round/chamfer SDF + `addPartFromRegion` in
`tests/processes.test.mjs`. Manual checks (scripted Chromium):

- [x] **Make Part (P)**: closed drafted region + "25 mm hardwood" preset → a real part: `process=extrude`, `box.d=25`, profile normalized to the region bbox, positioned where drawn; EXT badge appears in the parts list; open entities are refused with a hint.
- [x] **Edge treatment**: Round/Chamfer buttons + size slider on extruded parts re-mesh live; save round-trips `edgeStyle`/`edgeSize` (verified `round@8mm`).
- [x] **Vertical Parts panel**: rows with color, name, CUT/EXT badges; row click activates + opens inline settings; chevron collapses; the panel never outgrows the viewport (inspector scrolls).
- [x] **Nav cube**: clicking the F face hides the Front pane and unlights the face; clicking again restores; 3D pill toggles perspective.
- [x] Caught during verification: the parts-panel rework initially left the `<aside>` unclosed, which swallowed the toolbar + nav cube into it (wild positions); also the draft toolbar exceeded the viewport width — fixed by hiding massing-only tools (bezier/wand/auto/symmetry) in draft mode.
- [x] No console errors.
- [ ] Cut list from panels (Phase 8).

## Phase 13 — Cut list + DXF + nav-cube navigation + panel polish ✅

Automated coverage: `node tests/phase8.test.mjs` (cut-list grouping/CSV, DXF
entities/layers/flags). Manual checks (scripted Chromium):

- [x] Parts list has **no horizontal overflow** even with 8 parts + a max-length name (root cause: tooltip pseudo-elements contributed layout width inside the scroller; rows are now position-static so tooltips anchor to the panel).
- [x] Header chevron **collapses the whole Parts panel** to a 50 px title bar and back.
- [x] Nav cube **mirrors the camera live**, **drag orbits** (without toggling panes — capture engages only past the drag threshold), **double-click F flies the camera** to exactly the front elevation, and single-click still toggles panes.
- [x] **Cut List** modal groups 8 identical parts into one Qty-8 row; CSV downloads with the right header and grouping.
- [x] **DXF** download contains ENTITIES/POLYLINE/CIRCLE on per-view layers and ends with EOF; empty drafting layer refuses with a hint.
- [x] No console errors.
- [ ] Open the exported DXF in a real CAD package (LibreCAD/Rhino) — visual spot-check.

## Phase 14 — Workflow shakedown: modeling a real stool ✅

A stool was modeled END-TO-END through the UI in a scripted browser (plan
drafted in Top view → seat + 4 legs promoted with material presets → legs
dimensioned to 430 mm → seat drag-snapped onto the leg tops, gap 0.0 mm).
Bugs found by actually using the tool, all fixed:

- [x] **Rect-after-rect ate every second rectangle** (the pending-commit click swallowed the next drag's start). Shape tools now commit AND begin the next shape in one press.
- [x] **The P hotkey died after touching the material preset** (focus stayed on the select, which hotkeys rightly ignore). The preset now blurs on change.
- [x] **First promotion converts a pristine default part** instead of leaving a zombie box beside your drawing.
- [x] **Massing shape tools snap to drafted geometry** (endpoint/mid/intersection, with the marker) — drawings are reference, not wallpaper.
- [x] Settings-section horizontal scrollbar removed (same tooltip-layout disease as the rows list; `overflow-y:auto` forces `overflow-x:auto` per spec).
- [x] Nav cube: all **six faces** (−T/−F/−S dimmed), usable from every angle — orbit, then click/double-click what you see; paired faces light together.
- [x] File menu under the logo: New / Save / Open / Export OBJ / STL / DXF; closes on item click and outside click.
- [ ] Known friction (Phase 9 candidates): numeric part position/size entry in the inspector; choosing the promotion plane (e.g. legs drawn in front view placed at chosen depths); drag-snap of parts to DRAFTED lines.

---

## Performance targets

- [ ] Interactive part rebuild < ~150 ms at the default grid (96³ along the longest axis).
- [ ] Export re-meshes at the finer grid (192³).
