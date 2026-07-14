# UX Review — Parts & View Navigation
*Design-director pass, 2026-07-14. Scope: the Parts strip, the part settings
panel, and the T/F/S/3D view toggles.*

## What's wrong, specifically

**1. The horizontal strip fights its own content.** Parts are a *list* — they
grow, they get renamed to meaningful words ("Seat panel", "Left leg"), they
get reordered. A horizontal chip strip is the one layout that punishes all
three: names truncate, four parts exhaust the width, and drag-reorder along
X while the list *means* stacking order is a small but constant cognitive
tax. Horizontal strips are for a handful of fixed-size, fixed-count things
(tools). Parts are neither fixed-size nor fixed-count.

**2. One mental object, two floating islands.** "The part I'm working on" is
a single thing in the user's head, but its identity (chip) and its behavior
(settings panel) live in two separately draggable, separately docking
panels. The settings panel isn't even labeled as belonging to the chip — the
connection is only the name in its header. Every disconnect like this costs
a saccade per edit, hundreds of times a session.

**3. The strip and the toolbar compete for the same edge.** Bottom-right
Parts strip + bottom-center tool row + bottom-left analyzer panels = three
things negotiating one horizontal band. On a 13" laptop they collide.

**4. Identity is under-encoded.** A cut part vs a solid is a *structural*
difference (it subtracts!) but reads as a red dot vs a colored dot. The
manufacturing process — now the core concept of the app — isn't visible on
the chip at all. You must click every part to know what it is.

**5. T/F/S/3D is spatial information rendered as text.** Four letter-buttons
at the end of the tool row toggle *spatial viewports*. The mapping T→top,
F→front, S→side is a legend the user keeps in their head, and the buttons
communicate nothing about orientation. This is exactly the job a **nav
cube** solves: the control *is* the space it controls.

## The proposal

**A. One vertical Parts panel (right edge, top-right default).**
List rows, not chips: color swatch · name (room to breathe) · badges ·
visibility eye · overflow. Rows scale to any count, reorder along the axis
the list actually means, and long names survive. The active row carries the
accent.

**B. The inspector lives *inside* the panel.** Selected part's settings
render directly beneath the list in the same panel — one object, one place.
No second panel to hunt, dock, or mentally re-attach. (The panel still
free-floats/docks as a whole via the Phase 6 dock system.)

**C. Badges encode structure.** Each row shows: CUT badge (red) when
subtracting, and a process badge (EXT / TRN / STM) when the part isn't plain
massing. Now the composition is legible at a glance — which is the entire
point of a parts list.

**D. The nav cube replaces T/F/S/3D.** A small isometric cube, bottom-center
above the tool row: its **top / front / side faces are the toggles**, lit
when the pane is visible; a "3D" pill beside it toggles the perspective
pane. Orientation is now shown, not remembered. (Click = toggle, exactly the
old semantics — never allows zero panes.)

## What deliberately does NOT change
- All existing gestures: click to select, double-click rename, Alt-click
  solo, drag to reorder, right-click / ⋯ menu, eye toggle.
- The print/mold analyzer panels (bottom-left family, already fine).
- Free-float + corner docking (Phase 6) — the merged panel uses it as-is.

## Risks & mitigations
- Vertical panel occludes the Side view's right edge → default dock
  top-right where the perspective view (navigation-only) sits; it's the
  least sketch-critical real estate. And it drags anywhere.
- Rows cost more vertical space than chips → the list scrolls beyond ~8
  parts; settings stay pinned below.
