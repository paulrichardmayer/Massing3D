# Massing3D — Testing checklist

Manual QA checklist tied to each phase's acceptance criteria. Run from a fresh
load (`New` clears everything). Items marked ✅ have been verified in automated
checks driven through the live modules; re-verify by hand after UI changes.

## Invariants (never break these)

- [ ] Undo/redo covers sketches **and** part create / delete / duplicate / move / role / reorder.
- [ ] `.json` Save → Open round-trips exactly (schema **v5**; older v1–v4 files migrate on load).
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

## Phase 5 — Revolve

- [ ] Turn a part to **Revolve**, sketch a bottle half-profile in **Side** view → a clean lathe form (verify the circular cross-section in Top view).
- [ ] On a Revolve part, drawing in Top/Front view is rejected with a one-line hint; Side view still works.
- [ ] The **Blend** slider still softens a revolved form.
- [ ] **Cut + Revolve** combine: a revolved Cut part carves a revolved recess into an overlapping solid; result stays watertight.

---

## Performance targets

- [ ] Interactive part rebuild < ~150 ms at the default grid (96³ along the longest axis).
- [ ] Export re-meshes at the finer grid (192³).
