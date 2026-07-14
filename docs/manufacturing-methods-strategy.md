# Strategy — Manufacturing Methods

**Branch:** `Idea/ManufacturingMethods`
**Status:** Phases 0–4 SHIPPED. Phase 0–1: process model + Extrusion generator
(draft/twist), Revolve reframed as Turn. Phase 2: 3D-print preview analyzer
(layer lines, needs-support highlighting + % readout, build-height scrub).
Phase 3: injection-molding analyzer (pull direction, draft heat-map, SDF-marched
undercut detection, parting line, wall-thickness map). Phase 4: **Stamp /
deep-draw generator** — the sketched form acts as the die and the part becomes a
constant-thickness formed skin with a pick-able open face (trays, cups,
enclosures); brake-press bend lines + unfold stayed on the stretch list because
they need open-path sketching, which fights the app's closed-profile model. AI
spike parked per §5.3. Remaining stretch: sweep/loft, bend lines + unfold, CNC
accessibility.

**Revision 2 (2026-07-14):** direction expanded per review — see **Part II:
Drafting-first** below. The instant-extrude behavior becomes one *mode* rather
than the app's core assumption, and a Rhino-style 2D drafting layer (lines,
polylines, arcs, circles, open curves, snaps, numeric input) becomes the
foundation, so technical drawings of furniture can live in the ortho views
without generating solids.

---

# Part II — Drafting-first revision

## II.1 What changed in the brief

Massing3D was built on one welded assumption: **a closed stroke in a view IS a
3D solid** (it becomes the part's silhouette and extrudes instantly). That's
great for fast massing and it's why the tool feels magic in the first minute —
but it makes the app *unable to simply draw*. There is no line tool, no open
curve, no way to draft a plan/elevation of a chair with real dimensions,
because every mark on the canvas is conscripted into solid generation.

The revision: **decouple drawing from solid generation**, the way Rhino does.
Curves become first-class objects. Solids become something you explicitly
*make from* curves. The old instant-extrude behavior survives as a mode —
**Quick Massing** — because it's genuinely valuable; it just stops being the
only truth.

## II.2 The two modes

- **Draft mode (new).** The ortho views are drawing boards. Line, polyline,
  arc, circle, rectangle, ellipse, and open freehand/interpreted curves — all
  storable as OPEN or closed paths, with snaps and numeric input. Nothing
  becomes 3D unless you say so. This is where furniture technical drawings
  (plans, elevations, sections) live. Drawings belong to the *view*, not to a
  part's box.
- **Model mode (today's behavior, renamed Quick Massing).** A closed profile
  drawn in a view still instantly drives the active part's process (massing /
  extrude / turn / stamp) exactly as shipped in Phases 0–4. Nothing regresses.

A visible mode toggle (`Tab` or toolbar) switches which world a stroke lands
in. **DECIDED (2026-07-14):** Quick Massing is the fresh-file default
(first-minute magic intact); the mode is sticky per project (serialized).
"TD" confirmed = **technical drawings** — plans/elevations to real dimensions,
a required step in furniture design practice.

## II.3 The bridge: from drafting to solids

Drafted curves that form a closed loop can be **promoted**: select a region →
"Make Part from region" → choose the process (extrude / turn / stamp /
massing silhouette). This turns the drafting layer into the *precise front
door* to the same SDF pipeline — the furniture plan you drew becomes the seat
panel you extrude. Loop detection can start naive (a single closed polyline /
curve) and grow into real region-finding (planar loops from multiple curves)
later.

## II.4 Rhino-style tool set (scoped)

Creation — the v1 six:
| Tool | Input pattern (Rhino-familiar) |
|---|---|
| Line | click A, click B · Shift = ortho lock |
| Polyline | click, click, … · Enter/double-click ends open · click first point closes |
| Arc | 3 points (start, end, through) — the drafting-friendly variant |
| Circle | center → radius (type a number to set radius exactly) |
| Curve (control points) | click points, smooth open spline through them · Enter ends |
| Rect / Ellipse | already shipped — gain the open/draft context for free |

Precision — what makes it drafting and not doodling:
- **Snaps**: endpoint, midpoint, intersection, grid, and the existing
  part-face/centerline snaps; a snap readout chip near the cursor.
- **Ortho lock** (Shift) and **numeric entry**: type a length/angle mid-tool,
  Rhino-style ("click, type 450, Enter" = 450 mm segment).
- **Dimension readout** while drawing; later, persistent dimension annotations.

Editing (second wave): move/delete entities, offset, fillet corners (the
interpret machinery already does tangent fillets), **chamfer corners** (the
45° sibling — confirmed wanted), mirror, trim/extend last.

## II.4b Furniture-specific features (added per review, 2026-07-14)

Requested directly:
- **Panel thickness.** The furniture-native promotion: draw a surface (side
  panel, seat, shelf) in a view → "give it thickness" → a solid board. Under
  the hood this is the extrude process with length = board thickness, but the
  UX is one action with **material presets** (18 mm ply, 12 mm MDF, 25 mm
  hardwood…). An OPEN drafted polyline + thickness = a bent-sheet strip
  (laminations, tambours) via the stamp/shell math.
- **Edge fillet & chamfer.** Selective edge treatment, not the global Blend:
  a table top gets a round-over or chamfer on its face edges. SDF-feasible
  version: **edge style (round / chamfer) + size on the extrusion/panel
  cross-section caps** — the classic rounded/chamfered-extrusion field, which
  treats exactly the edges furniture cares about (panel perimeters) without
  needing general edge selection. Plus a cheap global win: a **Chamfer
  variant of the Blend slider** (chamfer-min instead of quadratic smooth-min)
  for crisp 45° transitions everywhere.

Added by the studio (field-relevant, cheap on this architecture):
- **Cut list.** Every panel/part knows its W×H×T and quantity — auto-generate
  the cut list a furniture maker actually takes to the shop. Near-free from
  the part model.
- **Dimensions & annotations** on the drafting layer (already Phase 8 —
  elevated in priority: TDs without dimensions aren't TDs).
- **DXF/SVG export of the drafting layer** — hand drawings to CNC/laser
  vendors; the standard furniture-shop interchange.
- **Drawings as 3D reference** (stretch): show a view's drafting layer as
  faint lines on its world plane in the perspective view — elevations wrap
  the model like a paper mock-up.
- **Joinery cuts** (stretch): dado/rabbet/groove as parametric Cut parts
  snapped to panel edges.

## II.5 Architecture fit

- **New entity model**: `state.drawings[view] = [{ kind, pts/segs, closed,
  style }]` — per-view 2D entities, open or closed, undoable, serialized as
  schema v7. Parts and their process profiles are untouched.
- **sketchview.js** grows a draft-mode input path (tool state machines for
  line/polyline/arc/curve) and renders the drafting layer under/over the
  ghost projections. The interpret (clean-up) machinery already stores
  line+arc seg-paths — the same representation serves drafted entities, so
  fillet-radius editing and resolution independence carry over.
- **The SDF pipeline is untouched** until promotion (II.3) hands it a closed
  region — which is exactly the format it already eats.
- Existing seg-path + snapping code means the v1 six tools are mostly input
  UX, not new geometry math.

## II.6 Revised roadmap

- **Phase 5 — Draft mode core.** Mode toggle (Quick Massing default, sticky)
  + drawing entity model (v7) + Line / Polyline / Arc / Circle / open Curve
  tools + endpoint/mid/grid snaps + ortho lock. Deliverable: draw a credible
  furniture elevation in a view.
- **Phase 6 — Precision pass.** SHIPPED 2026-07-14: numeric entry mid-tool,
  intersection snaps, entity select/move/delete, mirror copy, non-destructive
  corner fillet + chamfer on polylines; plus free-floating dockable panels.
  (Deferred within phase: numeric ANGLE entry, offset, trim/extend.)
- **Phase 7 — The bridge + panels.** SHIPPED 2026-07-14: "Make Part" (P)
  promotes a closed drafted region into an extruded panel with material
  presets (ply/MDF/hardwood/acrylic/steel); edge round/chamfer on
  extrusion/panel caps in the SDF. Shipped alongside: the design-director
  UX pass (vertical Parts panel with inline inspector + badges — see
  docs/ux-review-parts-panel.md) and the bottom-center 3D nav cube that
  replaced the T/F/S/3D buttons. (Deferred: chamfer variant of the Blend
  slider; promotion into turn/stamp processes.)
- **Phase 8 (in progress).** SHIPPED 2026-07-14: **cut list** (qty-grouped
  L×W×T + CSV) and **DXF export** of the drafting layer (R12, per-view
  layers, true arcs); plus nav-cube camera navigation (live mirror, drag
  orbit, double-click fly-to) and Parts-panel polish (collapse, scrollbar
  fix). Remaining stretch: dimensions/annotations, sweep/loft, bend lines +
  unfold, drawings-in-3D reference, joinery cuts, CNC accessibility, AI
  spike.

Note the compounding: open-path drafting **unblocks the sheet-metal bend-line
generator** that Phase 4 had to defer, and drafted rails make sweep/loft
natural. This revision isn't a detour from manufacturing methods — it feeds
the two stretch generators that needed it.

## II.7 Risks

- **Mode confusion** — the one UX risk that matters. The toggle must be
  loud (cursor, canvas tint, or header badge), and a stroke landing in the
  "wrong" world needs one-keystroke correction (undo + re-mode).
- **Scope gravity** — Rhino has ~40 curve tools; we ship six plus snaps and
  stop. Trim/extend/offset only after real drafting use.
- **Serialization v7** — drawings add a parallel store; migration is additive
  (old files load with empty drawings), same pattern as v6.
**Author:** drafted with Claude, 2026-07-09

---

## 1. The pitch, in one line

Turn Massing3D from a *silhouette-massing* toy into a **manufacturing playground**:
the user picks a real industrial process — extrusion, turning, 3D printing, stamping,
injection molding — and the tool generates and visualizes geometry *the way that process
actually makes it.* You don't draw a shape and hope; you pick a process and the process
shapes the result.

## 2. Is this doable? — Short answer: yes, and it's the *right* fix

Yes. And more importantly, it directly solves the complaint that motivated this branch.

**Why the current "side-view extrusion" feels bad.** Today a part's surface is the
**intersection of three orthographic silhouettes** clipped to a box (`js/sdf.js` →
`compilePart` does `smax(box, front, top, side)`). That's a *massing* operation: it's
great for blocking out proportions, but it is fundamentally ambiguous. Three flat
shadows can describe infinitely many solids, so the SDF picks the "safest" mushy
intersection. There is no single correct 3D form to recover, so the result reads as
soft and vague — exactly the "doesn't produce good results" symptom.

**Why manufacturing methods fix it.** A manufacturing process is *not* ambiguous. It is
a **well-defined constructive rule** that turns a small, honest 2D input into exactly
one crisp 3D result:

| Process | Honest input | Deterministic 3D result |
|---|---|---|
| Extrusion | 1 cross-section profile + length | that profile swept along an axis |
| Turning (lathe) | 1 half-profile + axis | profile revolved 360° |
| Sheet / stamping | 1 flat outline + bend lines + thickness | constant-thickness formed shell |
| 3D printing | any solid + layer height | the same solid, shown built up in layers |
| Injection molding | a solid + pull direction | the solid + draft/thickness/undercut readout |

So "manufacturing methods" is **not a detour from fixing extrusion — it *is* the fix.**
Each method is a *generator*: minimal 2D intent in, faithful 3D out, no guessing.
We already shipped one such generator — **Revolve** (`revolve` flag, `sdf.js` lathes the
side profile around Y). That's literally the *turning* process. The branch generalizes
that idea into a family.

## 3. Two kinds of "manufacturing" feature

It helps to separate them, because they have different UX and different effort:

- **(A) Generators** — *make* geometry via a process. Extrusion, revolve/turning,
  sweep-along-path, loft, sheet-metal/stamping, thermoforming. These replace or augment
  the "draw silhouettes" step and are where the crisp-results win comes from.
- **(B) Analyzers** — *evaluate* an existing solid for a process. Draft-angle heat-map,
  wall-thickness map, undercut/parting-line detection, slice/layer preview, tool-path
  preview. These are overlays on the mesh we already generate. High wow-factor, and
  because they read the finished SDF/mesh they don't touch the fragile drawing code.

A good v1 ships **one strong generator** and **one striking analyzer** so the branch
demonstrates both halves of the story.

## 4. The process catalog (feature list)

Each entry: what the user does, and how it lands on the existing pipeline.

### 4.1 Extrusion (generator) — *the flagship*
- **User:** draws **one** cross-section, sets a length + axis; optionally a **draft
  angle** (taper) or **twist**. Gets a true constant-section extrusion — aluminum
  T-slot, a bottle-cap knurl, a heat-sink.
- **Pipeline:** a new part `process: 'extrude'`. In `compilePart`, sweep is
  `max(profileSDF(cross-plane), |axis| - halfLength)` — cheaper and *crisper* than the
  triple-silhouette intersection because only ONE profile drives it. Draft = scale the
  profile sample by a function of the axis coordinate; twist = rotate the sample point.
- **Why first:** smallest change, biggest quality jump, and it's the exact thing the
  user said is broken.

### 4.2 Turning / Lathe (generator) — *already 80% done*
- **User:** draws a half-profile against a centerline → revolved solid (knobs, bottles,
  lamp bases, lenses). Add: **partial sweep angle** (e.g. 270° to show the cut), and a
  **facing/grooving** readout.
- **Pipeline:** this is the existing `revolve`. Reframe it in the UI as the "Turning"
  process and expose sweep-angle. Almost free.

### 4.3 Sweep-along-path & Loft (generators)
- **User:** draw a profile in one view + a **path/spine** in another → profile follows
  the path (extruded-plastic trim, tubing, handles). Loft = two profiles blended.
- **Pipeline:** medium effort. Sweep = evaluate the profile in a moving frame along the
  path; loft = interpolate two profile grids by the axis parameter. Both fit the SDF
  model as a parameterized cross-section.

### 4.4 Sheet metal / Stamping (generator)
- **User:** draw a flat outline, mark **bend lines** + angles, set **thickness** → a
  constant-thickness formed part (bracket, enclosure, chassis). Bonus: **unfold** to the
  flat blank (shows material usage / nesting).
- **Pipeline:** shell the profile to a thin constant-thickness band (`abs(sdf) -
  t/2`), then apply bends as local rotations of half-spaces. Higher effort; strong
  differentiator because *no other casual tool does sheet metal.*

### 4.5 3D printing (analyzer + generator flavor)
- **User:** takes any finished solid and sees it **built up in layers** — a slider
  scrubs the build height, FDM **layer lines** shade the surface, and **overhangs beyond
  a threshold angle glow red** ("needs support"). Optional: auto-suggested support pillars.
- **Pipeline:** pure post-process on the mesh we already have. Layer look = a fragment
  shader banding on world-Y; overhang = compare vertex normal·(-up) to the angle
  threshold; build-scrub = clip plane. No changes to geometry generation at all — very
  high ratio of wow to effort.

### 4.6 Injection molding / Casting (analyzer) — *manufacturability readout*
- **User:** picks a **pull direction**, and the model recolors: **draft-angle heat-map**
  (faces too vertical to release = red), **wall-thickness map** (too thick = sink marks,
  too thin = short shot), **undercut detection** + the **parting line**.
- **Pipeline:** draft = normal·pull-dir per face. Thickness = sphere/ray probe inward
  from each surface point (the SDF makes this natural — march the gradient). Undercut =
  faces whose normal opposes pull *and* are shadowed. These read the SDF directly.

### 4.7 CNC milling / Subtractive (stretch)
- **User:** define **stock**, choose 3-axis access directions, see what a mill *can't*
  reach (deep pockets, internal corners with tool-radius limits).
- **Pipeline:** accessibility test against tool radius + approach axes. Later-phase; heavier.

### 4.8 Thermoforming / Vacuum forming (stretch)
- **User:** draw a **buck**, drape a sheet over it → thin skin conforming to the top,
  webbing in the valleys. Nice for packaging/trays. Later phase.

## 5. The AI pivot — addressed honestly

You raised a real fork: *"pivot to an AI creative tool that takes the side views and
generates a 3D model in perspective."* This deserves a straight answer because it points
in a **different direction** than manufacturing simulation.

### 5.1 It's genuinely possible now
Image/sketch-to-3D is a solved-enough problem in 2026. A few orthographic sketches can be
fed to an image-to-3D model (the Meshy / Rodin / Trellis / Hunyuan3D-class APIs, or an
open model self-hosted) and you get back a textured mesh in seconds. Wiring that into the
perspective viewport is a weekend-shaped spike, not research.

### 5.2 But it's a *different product*, and it fights the manufacturing goal
The two ideas pull opposite ways on the one axis that matters — **control**:

| | Manufacturing methods | AI image-to-3D |
|---|---|---|
| Output | **parametric, editable, process-true** | freeform mesh, **not editable**, no process meaning |
| Value | "can this be *made*, and how" | "give me a *pretty concept* fast" |
| Trust | deterministic, offline, yours | stochastic, external API, per-call cost |
| Fit with current app | extends the SDF pipeline | replaces it with a black box |

An AI mesh is the *opposite* of manufacturable: you can't set a draft angle on a blob you
can't parameterize. So AI-generation and manufacturing-simulation are **two separate
bets**, and cramming both into this one branch dilutes each.

### 5.3 Recommendation
- **Keep `Idea/ManufacturingMethods` = the parametric/process bet.** It *directly fixes*
  the extrusion-quality complaint, needs no external service, and preserves what's good
  about the app (fast, local, vanilla, yours).
- **Spin the AI idea into its own spike** — say `Idea/AIPerspective`. Scope it as: 3
  ortho sketches → image-to-3D API → drop the result into the perspective view as a
  *reference/concept ghost* (not an editable part). That keeps it cheap to try and honest
  about what it is.
- **They can converge later, in one killer direction:** AI proposes the concept form →
  the manufacturing generators let the user *re-derive a manufacturable version* of it
  (trace the AI ghost with an extrusion/lathe/sheet-metal profile). AI for *inspiration*,
  process tools for *realization*. That's a stronger story than either alone — but it only
  works if we build the process tools first, which is this branch.

**Open decision for you:** do we treat AI as a *separate* later spike (my recommendation),
or do you want an AI "concept ghost" import folded into this branch's v1 as a source of
tracing references? Everything below assumes the former.

## 6. Architecture — how it grafts onto today's code

The current model is friendly to this. Minimal-surgery plan:

1. **Add `process` to the part model** (`js/state.js`): `'massing'` (today's default —
   silhouette intersection) | `'extrude'` | `'turn'` | `'sheet'` | … plus a small
   `processParams` bag (length, axis, draft, twist, thickness, bendLines…). Bump the
   serialize version (currently `v: 5`) with a pass-through migration — old files load as
   `process: 'massing'`.
2. **Branch inside `compilePart`** (`js/sdf.js`) on `desc.process`. Each generator is a
   new SDF assembly; `revolve` becomes the `'turn'` branch. The Surface-Nets mesher, the
   worker, normals, and export are all **downstream and untouched** — they just triangulate
   whatever SDF they're handed. This is the big architectural gift: *new processes are new
   fields, nothing after them changes.*
3. **Analyzers are a render layer, not geometry.** Draft/thickness/overhang colorings live
   in `js/scene3d.js` as shader/material variants + a legend; slice-scrub is a clip plane.
   They consume the mesh + SDF that already exist.
4. **UI:** a **Process picker** on the part panel (`js/ui.js`) that swaps which drawing
   inputs and parameter sliders are shown — e.g. "Extrude" hides two of the three ortho
   views and shows length/draft/twist. This also *simplifies* drawing: a process tells the
   user which single view actually matters, removing the "draw three silhouettes and pray"
   confusion.

No new build step, no framework, stays vanilla ES modules.

## 7. Phased roadmap

- **Phase 0 — Model plumbing.** Add `process` + `processParams` to the part model,
  serialization migration, and the Process-picker UI shell. Default `'massing'` keeps
  every current file identical. *No visual change yet — just the rails.*
- **Phase 1 — Extrusion generator (the flagship).** True single-profile extrude with
  length + draft + twist. This is the "results finally look right" moment. Reframe the
  existing revolve as the **Turning** process in the same UI.
- **Phase 2 — 3D-printing analyzer.** Layer-band shader, overhang-glow, build-height
  scrub. Cheap, and the most demo-able feature in the whole plan.
- **Phase 3 — Injection-molding analyzer.** Pull-direction draft heat-map + wall-thickness
  map + parting line. This is the "is it *actually manufacturable*" payoff.
- **Phase 4 — Sheet metal / stamping generator.** Bend lines, thickness, and unfold-to-flat.
  The standout differentiator.
- **Phase 5+ (stretch).** Sweep/loft, CNC accessibility, thermoforming, and — separately —
  the `Idea/AIPerspective` spike.

Each phase is independently shippable and independently *fun* — the point of the original
project.

## 8. Risks & open questions

- **Scope creep** — the process list is long; discipline is "one great generator + one great
  analyzer" before breadth. Phases 1–2 are the real MVP.
- **Sheet metal and CNC are the hard ones** (bends, tool accessibility). Deliberately late.
- **Analyzer accuracy vs. honesty** — a draft/thickness readout must be clearly
  "indicative, not a DFM sign-off," or it over-promises. Label it as guidance.
- **The AI fork** (§5.3) is the one decision that changes the branch's identity — worth
  settling before Phase 1.
- **Does the user want export to stay a single watertight mesh**, or should processes carry
  through to export metadata (e.g. STL + a "printed in N layers / bends at these lines"
  sidecar)? Probably later, but flag it.

## 9. Bottom line

Doable, and it's the *correct* response to the extrusion complaint rather than a pivot away
from it: process-driven generators turn ambiguous silhouette-massing into crisp,
purposeful geometry, and the analyzers add a genuinely novel "can this be made?" layer that
nothing else in this casual-tool space offers. Recommend building the parametric process
tools here and treating AI image-to-3D as a separate, later spike that *feeds* these tools
rather than replacing them.
