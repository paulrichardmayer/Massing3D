# Massing3D

A web-based 3D tool for **furniture design ideation** — think Spline/Womp/Sloyd, but for chairs, tables and lamps. You work in a single 3D perspective view: click a furniture primitive (**Slab, Board, Leg, Rod, Cylinder**) into the empty scene, then **drag parts directly in 3D** — they slide on the ground plane, `Shift`-drag lifts them, and everything snaps to the ground, part centers, and face-to-face contact (legs against a slab edge, a top landing exactly on the legs). Under the hood every part is a smooth signed-distance-field solid, so forms can melt together and export watertight (OBJ/STL).

Sketching lives in a drawer: press `Tab` to open the 2D drawing boards (Top/Front/Side) with Rhino-style drafting tools, draw a custom profile, make a part from it — `Tab` again returns you to the 3D room exactly as you left it.

Roadmap (see `docs/manufacturing-methods-strategy.md`, Part III): **R1 ✅ 3D-first shell** · R2 parametric templates (Chair, Stool, Sofa, Table, Lamp) · R3 clay tools (melt/fillet/carve across parts) · R4 feature drawers (analyzers, cut list, DXF).

## The 3D room (default)

- The app boots to an **empty perspective view**. The toolbar holds a Select tool and five primitives — one click drops a grounded part, auto-placed clear of the others.
- **Click** a part to select it; **drag** to move it on the floor; **`Shift`+drag** to lift. Snapping targets: ground, world center, other parts' centerlines, and exact face-to-face contact/stacking distances.
- The **nav cube** (bottom center) mirrors the camera live — drag it to orbit, double-click a face to fly there, click faces to toggle ortho panes.
- `Ctrl+Z` / `Ctrl+Y` undo/redo everything, including 3D moves.

## Two modes (the sketching drawer)

- **Quick Massing** (default) — what the rest of this README describes: closed
  sketches instantly become 3D form via the part's manufacturing process.
- **Draft mode** (`Tab` or the Draft toggle) — the ortho views become 2D
  drawing boards for **technical drawings** (furniture plans/elevations).
  Rhino-style tools: **Line** (Shift = exact ortho, 45° steps), **Polyline**
  (Enter/double-click ends open, click the first point to close), **3-point
  Arc**, **Circle** (center + radius), and a smooth **Curve** through clicked
  points — plus Rect/Ellipse/Freehand, which land as drawings here. Points
  snap to entity **endpoints, midpoints, centers and the grid** with a marker
  + label at the cursor; open paths are first-class. Drawings never generate
  solids, save with the project (schema v7), and stay visible as a dimmed
  reference layer when you switch back to massing. The mode is sticky per
  project.

  **Precision & editing:** while drawing, **type a length and press Enter**
  ("click, `450`, Enter" = an exact 450 mm segment along the current
  direction; for circles the number is the radius). Points also snap to
  **intersections** of drawn geometry. With the Select tool, click an entity
  to select it (amber): **drag** moves it, **Delete** removes it, **M** makes
  a mirrored copy about the vertical axis, **[ ]** grow/shrink a
  non-destructive **corner fillet** on polylines and **C** switches it to a
  **chamfer** — the furniture edge treatments, right in the drawing.

  **The bridge — Make Part (`P`).** Select a CLOSED region, pick a material
  preset (18 mm ply, 12 mm MDF, 25 mm hardwood…), press `P`: the drawing
  becomes a real **panel** — an extrusion whose profile is the region and
  whose depth is the sheet thickness, placed exactly where you drew it.
  Extruded parts (panels included) also get a 3D **edge treatment** on their
  cap perimeters: **Round** or **Chamfer** with a size slider — the
  table-top edge break, computed in the SDF, preserved dimensions.

## How it works

- A product is built from **Parts**. Each part is a 3D bounding box with its own sketched silhouettes. New parts spawn **beside** the active one (free placement, not stacked) and can be dragged/snapped against other parts' faces and centerlines with the Select/Move tool.
- Draw a **closed shape** in any orthographic view (Top, Front, Side). It is extruded through the box along that view's axis.
- With a shape tool (Rectangle/Ellipse) active, **double-click inside a part's box** to fill that box face with the shape instantly — ellipse-fill gives you cylinders/capsules for free.
- Each view holds **one profile per part** — the silhouette from that direction. Drawing again in the same view replaces the previous profile (`Ctrl+Z` restores it), so you can iterate on a silhouette as fast as you can sketch. Sketches that miss the box entirely are rejected with a warning instead of clipping the form to nothing.
- Nobody draws a straight line with a mouse, so **Clean Up** (`Q` or the wand) reads your intent: a wobbly stroke snaps to crisp straight lines, true circular arcs, and equal-radius rounded corners, with a quick morph so you can see it happen. By default this runs automatically when you finish a mouse stroke (off for stylus). Interpreted profiles stay resolution-independent (stored as lines + arcs, tessellated only at draw/mesh time), and `[` `]` adjust their corner radii live just like rectangles.
- Draw in two or more views and the part's surface is the **intersection** of those silhouettes with the bounding box. The **Blend** slider melts every edge and intersection seam uniformly (a real smooth-minimum on the signed distance field) — `0` is crisp, higher values turn the form into a soft pebble in real time.
- **Roles** compose parts: a **Solid** adds volume; a **Cut** is subtracted from every solid it overlaps (grips, lens openings, button recesses, screens). **Sharp mode** swaps a part back to crisp boolean edges (CSG) when you don't want any blend.
- Every part has a **manufacturing process** that decides HOW its 3D form is generated. **Massing** (default) is the silhouette intersection above. **Extrude** sweeps ONE cross-section along its view's axis — pick the profile view (Top / Front / Side), then add **Draft** to taper the section like molding draft and **Twist** to spiral it end-to-end. **Turn** lathes the Side profile around the vertical centerline (lenses, knobs, bottles, lamp bases). **Stamp** treats your sketched form as the **die** and turns the part into a constant-**thickness** skin formed over it (deep-draw / thermoform) with one box face left **open** — instant trays, cups, enclosures. Extrude and Turn take sketches only in their profile view — the other views become ghost-only and hint where to draw.
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
| Nav cube | — | Bottom-center 3D cube that **mirrors the perspective camera live**. Click a face to toggle its view pane (lit = visible) · **drag the cube to orbit** the perspective camera · **double-click T / F / S to fly the camera** to that elevation · the **3D** pill toggles the perspective pane |

## Navigation

**Perspective view** — Orbit: RMB drag or Alt+LMB drag · Pan: MMB drag or Shift+RMB drag · Zoom: scroll wheel or Ctrl+RMB drag. Drawing tools are always ignored here.

**Orthographic views** — Pan: RMB or MMB drag (orbiting disabled) · Zoom: scroll wheel, centered on the cursor.

**Other shortcuts** — `Ctrl+Z` / `Ctrl+Y` undo/redo (sketches **and** part create / delete / duplicate / move) · `Esc` cancels the in-progress sketch, exits fullscreen, or deselects the tool · Double-click a viewport header to maximize it (menus auto-hide; `Esc` restores).

## Parts

Parts live in a **vertical Parts panel** (top-right by default): one row per part — color swatch, name, a **CUT** badge when it subtracts and a process badge (**EXT / TRN / STM**) when it isn't plain massing — with the selected part's **settings inline beneath the list** (one object, one place; the chevron collapses them — and the header chevron collapses the whole panel to its title bar). Every floating panel drags by its grip handle: **drop it anywhere to leave it floating exactly there**, or release near a screen corner to dock it (docked panels stack; floating ones are nudged back on-screen when the window resizes). Rationale: `docs/ux-review-parts-panel.md`.

Each part chip: **click** to select & open settings · **double-click** to rename · **Alt-click** to isolate/solo (Alt-click again restores) · **drag** to reorder · the **⋯ button** (or right-click) opens part actions: Duplicate, **Mirror duplicate (X)** for instant left/right pairs (speakers, handles, hinges), Make Solid / Make Cut, Rename, Delete. Every structural edit is undoable.

Click a chip to open its panel:

- **Role** — Solid (adds volume) or Cut (subtracted from overlapping solids; rendered as a translucent red ghost)
- **Process** — **Massing** (silhouette intersection), **Extrude** (one cross-section swept along its view's axis, with profile-view picker plus live **Draft** and **Twist** sliders), **Turn** (lathe the Side profile around the vertical centerline), or **Stamp** (constant-thickness skin over the sketched die, with sheet-thickness slider and open-face picker)
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
- **Cut List** — every visible solid part as **Qty · L × W × T** (identical sizes grouped), with CSV download — the list a furniture maker takes to the shop
- **DXF** — exports the drafting layer as DXF R12 (one layer per view, true arcs/circles) for CNC and laser vendors

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
