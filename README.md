# Massing3D

A web-based 3D ideation tool for industrial designers. Draw 2D orthographic sketches (Top, Front, Side) and Massing3D turns the extruded profiles into smooth 3D volumes via a signed-distance-field pipeline — rapid visualization, fun ideation, and quick mesh export (OBJ/STL). Optimized for both mouse and tablet/stylus (iPad) input.

## How it works

- A product is built from **Parts**. Each part is a 3D bounding box with its own sketched silhouettes. New parts spawn **beside** the active one (free placement, not stacked) and can be dragged/snapped against other parts' faces and centerlines with the Select/Move tool.
- Draw a **closed shape** in any orthographic view (Top, Front, Side). It is extruded through the box along that view's axis.
- With a shape tool (Rectangle/Ellipse) active, **double-click inside a part's box** to fill that box face with the shape instantly — ellipse-fill gives you cylinders/capsules for free.
- Each view holds **one profile per part** — the silhouette from that direction. Drawing again in the same view replaces the previous profile (`Ctrl+Z` restores it), so you can iterate on a silhouette as fast as you can sketch. Sketches that miss the box entirely are rejected with a warning instead of clipping the form to nothing.
- Nobody draws a straight line with a mouse, so **Clean Up** (`Q` or the wand) reads your intent: a wobbly stroke snaps to crisp straight lines, true circular arcs, and equal-radius rounded corners, with a quick morph so you can see it happen. By default this runs automatically when you finish a mouse stroke (off for stylus). Interpreted profiles stay resolution-independent (stored as lines + arcs, tessellated only at draw/mesh time), and `[` `]` adjust their corner radii live just like rectangles.
- Draw in two or more views and the part's surface is the **intersection** of those silhouettes with the bounding box. The **Blend** slider melts every edge and intersection seam uniformly (a real smooth-minimum on the signed distance field) — `0` is crisp, higher values turn the form into a soft pebble in real time.
- **Roles** compose parts: a **Solid** adds volume; a **Cut** is subtracted from every solid it overlaps (grips, lens openings, button recesses, screens). **Sharp mode** swaps a part back to crisp boolean edges (CSG) when you don't want any blend.
- Every part has a **manufacturing process** that decides HOW its 3D form is generated. **Massing** (default) is the silhouette intersection above. **Extrude** sweeps ONE cross-section along its view's axis — pick the profile view (Top / Front / Side), then add **Draft** to taper the section like molding draft and **Twist** to spiral it end-to-end. **Turn** lathes the Side profile around the vertical centerline (lenses, knobs, bottles, lamp bases). Extrude and Turn take sketches only in their profile view — the other views become ghost-only and hint where to draw.
- Every ortho view shows a translucent **ghost projection of the actual 3D result**, so a change made in one view (or to dimensions / blend / role) is immediately visible in all the others.
- The **Perspective view never accepts drawing** — it is navigation-only (orbit/pan/zoom).

The 3D surface is generated as a **signed distance field** and triangulated with Surface Nets in a Web Worker (so dragging Blend never blocks the UI); vertex normals come from the SDF gradient, which is what makes the surfaces look liquid-smooth. Meshes are watertight and export-ready.

## Tools (bottom menu)

| Tool | Key | Notes |
|---|---|---|
| Navigate | — | Pan/zoom the view |
| Select / Move | `W` | Drag parts in ortho views; snaps to other parts' faces, their centerlines, and the world origin |
| Rectangle | `R` | Drag corner-to-corner · `Shift` = square · after release, scroll or `[` `]` round the corners live, next click commits |
| Ellipse | `E` | Drag the bounding box · `Shift` = circle |
| Bezier Line | `L` | Tap to place anchors, drag for handles, click the first anchor to close |
| Freehand Sketch | `F` | Stylus-friendly (pointer events + coalescing), Douglas-Peucker smoothed |
| Clean Up (wand) | `Q` | Interprets the focused view's freehand profile into crisp lines, true arcs, and equal-radius rounded corners. Press again to toggle back to the raw stroke |
| Auto Clean-Up | — | Runs Clean Up the moment you finish a stroke. Default: **on** for mouse, **off** for stylus (toggle overrides) |
| Symmetry | `S` | Mirrors new sketches across the box's vertical centerline |
| View toggles | — | T / F / S / 3D — remaining viewports adapt to fill the space |

## Navigation

**Perspective view** — Orbit: RMB drag or Alt+LMB drag · Pan: MMB drag or Shift+RMB drag · Zoom: scroll wheel or Ctrl+RMB drag. Drawing tools are always ignored here.

**Orthographic views** — Pan: RMB or MMB drag (orbiting disabled) · Zoom: scroll wheel, centered on the cursor.

**Other shortcuts** — `Ctrl+Z` / `Ctrl+Y` undo/redo (sketches **and** part create / delete / duplicate / move) · `Esc` cancels the in-progress sketch, exits fullscreen, or deselects the tool · Double-click a viewport header to maximize it (menus auto-hide; `Esc` restores).

## Parts

The **Parts** strip docks to the bottom-right corner by default, with the settings panel stacked directly above it. Both are draggable by their grip handles and dock to whichever screen corner you drop them near.

Each part chip: **click** to select & open settings · **double-click** to rename · **Alt-click** to isolate/solo (Alt-click again restores) · **drag** to reorder · the **⋯ button** (or right-click) opens part actions: Duplicate, **Mirror duplicate (X)** for instant left/right pairs (speakers, handles, hinges), Make Solid / Make Cut, Rename, Delete. Every structural edit is undoable.

Click a chip to open its panel:

- **Role** — Solid (adds volume) or Cut (subtracted from overlapping solids; rendered as a translucent red ghost)
- **Process** — **Massing** (silhouette intersection), **Extrude** (one cross-section swept along its view's axis, with profile-view picker plus live **Draft** and **Twist** sliders), or **Turn** (lathe the Side profile around the vertical centerline)
- **Surface** — **Sharp** (crisp boolean edges instead of the smooth blend; Massing parts only — Extrude and Turn are SDF-native)
- **Dimensions** — bounding box W/H/D with units (mm / cm / m)
- **Blend (soft edges)** — the SDF blend radius `k`; melts every edge and seam uniformly. Drag it and the form melts in real time
- **Smart image underlay** — upload a JPEG/PNG reference; it is mapped onto the median internal cross-section plane of the current view, can be rotated to the other two orthogonal median planes (XY / XZ / YZ), flipped, and faded with an opacity slider. Visible both in the matching ortho view and inside the 3D box.

## File menu (top)

- **New / Save / Open** — projects round-trip as `.json` (underlay images included)
- **OBJ / STL** — exports the visible solid parts as a watertight mesh, re-meshed at a finer resolution at export time (cut parts are tools, not output)
- **Share** — copies a link with the whole project encoded in the URL (underlay images excluded for size)
- **Print** — toggles the **3D-print preview** analyzer
- **Mold** — toggles the **injection-molding preview** analyzer (one analyzer at a time)

## 3D-print preview (analyzer)

A render-layer mode on the finished solids — no geometry is generated or modified, so it is always in sync with the model and free to leave on while editing:

- **FDM layer lines** shade every surface at the chosen **layer height** (derivative-anti-aliased, so thin layers fade instead of moiré-ing)
- Surfaces steeper than the **max overhang** angle glow **red — needs support** (bed-adjacent first layers are exempt), with a live **% of surface** readout
- The **build progress** slider scrubs the print bottom-up: material above the cut vanishes, the exposed interior shows flat infill-orange, and the layer being printed glows amber

Guidance only — indicative, not a slicer or DFM sign-off.

## Injection-molding preview (analyzer)

Pick a **pull direction** (the axis the two mold halves separate along) and every solid part is analyzed as its own molded component:

- **Draft view** — walls flatter than the **min draft** angle tint orange (they'll scuff or stick); the **parting line** renders as a cyan band exactly where the surface crosses from the cavity half to the core half; **undercuts** — surfaces the geometry shadows along their own release direction (side holes, hooks) — tint magenta, detected by marching the part's signed distance field from every vertex
- **Thickness view** — wall thickness measured through the part (blue = thinner than the healthy range → short-shot risk, green = healthy, red = thicker → sink marks), with a 5–95% range readout
- Live stats: **% under-drafted · % undercut** area

Same guidance-only caveat as the print preview.

## Tech stack

Vanilla ES modules + import maps — a custom signed-distance-field + Surface Nets mesher (`js/sdf.js`) running in a Web Worker for the smooth pipeline, three-bvh-csg for the crisp Sharp-mode booleans, Three.js for the perspective viewport, HTML5 Canvas for the 2D sketch overlays, Tailwind CSS for UI chrome.
