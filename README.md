# Massing3D

A web-based 3D ideation tool for industrial designers. Draw 2D orthographic sketches (Top, Front, Side) and Massing3D automatically generates 3D volumes via boolean intersections of the extruded profiles — rapid visualization, fun ideation, and quick mesh export (OBJ/STL). Optimized for both mouse and tablet/stylus (iPad) input.

## How it works

- Each **layer** is a 3D bounding box. New layers stack on top of the previous one and can be dragged/snapped against other boxes with the Select/Move tool.
- Draw a **closed shape** in any orthographic view (Top, Front, Side). It is extruded through the box along that view's axis.
- With a shape tool (Rectangle/Ellipse) active, **double-click inside a layer's box** to fill that box face with the shape instantly — ellipse-fill gives you cylinders/capsules for free.
- Each view holds **one profile per layer** — the silhouette from that direction. Drawing again in the same view replaces the previous profile (`Ctrl+Z` restores it), so you can iterate on a silhouette as fast as you can sketch. Sketches that miss the box entirely are rejected with a warning instead of clipping the form to nothing.
- Draw in two or more views and the final mesh is the **boolean intersection** of those silhouettes, clipped to the layer's bounding box (powered by [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg)).
- Every ortho view shows a translucent **ghost projection of the actual 3D result**, so a change made in one view (or to dimensions/fillet) is immediately visible in all the others.
- The **Perspective view never accepts drawing** — it is navigation-only (orbit/pan/zoom).

## Tools (bottom menu)

| Tool | Key | Notes |
|---|---|---|
| Navigate | — | Pan/zoom the view |
| Select / Move | `W` | Drag box layers in ortho views, snaps to other boxes' faces |
| Rectangle | `R` | Drag corner-to-corner · `Shift` = square · after release, scroll or `[` `]` round the corners live, next click commits |
| Ellipse | `E` | Drag the bounding box · `Shift` = circle |
| Bezier Line | `L` | Tap to place anchors, drag for handles, click the first anchor to close |
| Freehand Sketch | `F` | Stylus-friendly (pointer events + coalescing), Douglas-Peucker smoothed |
| Symmetry | `S` | Mirrors new sketches across the box's vertical centerline |
| View toggles | — | T / F / S / 3D — remaining viewports adapt to fill the space |

## Navigation

**Perspective view** — Orbit: RMB drag or Alt+LMB drag · Pan: MMB drag or Shift+RMB drag · Zoom: scroll wheel or Ctrl+RMB drag. Drawing tools are always ignored here.

**Orthographic views** — Pan: RMB or MMB drag (orbiting disabled) · Zoom: scroll wheel, centered on the cursor.

**Other shortcuts** — `Ctrl+Z` / `Ctrl+Y` undo/redo sketches · `Esc` cancels the in-progress sketch, exits fullscreen, or deselects the tool · Double-click a viewport header to maximize it (menus auto-hide; `Esc` restores).

## Layer settings (side panel)

The layer strip docks to the bottom-right corner by default, with the settings panel stacked directly above it. Both are draggable by their grip handles and dock to whichever screen corner you drop them near.

Click a layer chip in the floating layer strip to open its panel:

- **Dimensions** — bounding box W/H/D with units (mm / cm / m)
- **Fillet/Chamfer slider** — rounds the sharp edge intersections of the layer's mesh (approximated by rounding the bounding box and the 2D profiles before extrusion)
- **Smart image underlay** — upload a JPEG/PNG reference; it is mapped onto the median internal cross-section plane of the current view, can be rotated to the other two orthogonal median planes (XY / XZ / YZ), flipped, and faded with an opacity slider. Visible both in the matching ortho view and inside the 3D box.

## File menu (top)

- **New / Save / Open** — projects round-trip as `.json` (underlay images included)
- **OBJ / STL** — exports the visible layer meshes
- **Share** — copies a link with the whole project encoded in the URL (underlay images excluded for size)

## Tech stack

Vanilla ES modules + import maps — Three.js for the perspective viewport and mesh generation, three-bvh-csg for boolean intersections, HTML5 Canvas for the 2D sketch overlays, Tailwind CSS for UI chrome.
