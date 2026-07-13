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

---

## Performance targets

- [ ] Interactive part rebuild < ~150 ms at the default grid (96³ along the longest axis).
- [ ] Export re-meshes at the finer grid (192³).
