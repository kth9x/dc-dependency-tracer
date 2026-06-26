# Dependency Tracer — runnable clone

A reverse-engineered, editable rebuild of **https://dc-ui-v2.netlify.app**
(“Dependency Tracer”) — a 3D data-center power/cooling **dependency & impact**
explorer. Select a rack and the app traces what *feeds* it (dependencies) and
what it *affects* if something fails (impact / blast-radius).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build && npm run preview
```

## Scaling to thousands of racks (60 FPS)

The scene is built for scale — racks, the 1:1 cooling appendages (Liquid Loop /
RDHx / DTC), and equipment each render as **one `InstancedMesh`** (a few draw
calls total, not one component + mesh per node). Benchmark any size with the
`?synth=N` flag, which tiles the real dataset up to N racks:

```
http://localhost:5173/?synth=1000     # ~1,080 racks (+ ~1,900 cooling bodies)
http://localhost:5173/?synth=5000     # headroom check
```

A **Dev Tools panel** (top-left, shown in dev or with `?synth`) reports live
**FPS / draw calls / triangles** and has a **Simulated racks** switcher
(`Real · 100 · 500 · 1K · 2K · 5K`) so you can change the load without editing
the URL — picking a preset reloads with the matching `?synth=N` for a clean
measurement. The panel collapses to a single FPS pill. Focus the window so the
render loop runs (browsers pause `requestAnimationFrame` in background tabs).

Key techniques:
- **GPU instancing** for racks/cooling/equipment; per-node state (dim / depth
  fade / highlight / source) is written to `instanceColor` imperatively on trace
  change — no per-node React re-render. "Dim" lerps toward the fog color so the
  material stays **opaque** (no transparency sorting).
- **Picking** via `event.instanceId` on the instanced meshes (one hit test).
- **Labels are capped** to the ~22 nearest rooms (Html cost scales with label
  count, not scene size) plus a single hovered-node label.
- **Edges are bounded**: the load fan-out **aggregates to Row/Zone/Room
  containers** past a threshold (a UPS trace is ~1 edge per zone with a rack
  count, not one per rack), and the renderer hard-caps drawn edges (lowest depth
  first).

**Detailed models on zoom-in (near-pool LOD).** Zoom into a cluster and the
nearest racks swap from instanced boxes to the real `rack.glb` cabinets; zoom
out and they revert. It's a bounded pool (≤24 detailed racks at once) of GLB
clones that snap to the nodes closest to the camera and hide those box
instances — so detailed-model cost is constant regardless of total racks. GLBs
load lazily on the first zoom (the aerial view stays box-only and never pays the
decode), and picking is forwarded from the hidden box to the detailed clone so
zoomed nodes stay clickable. **Equipment goes detailed too** (CDU/UPS/Room
PDU/CRAH/RPP/BESS/Switch Gear): their GLBs have 400+ sub-meshes each
(`cdu.glb`=401, `ups.glb`=477), so each is **merged once into a single
vertex-colored mesh** (`useMergedGlb`) — a pooled clone is then 1 draw call
instead of hundreds. The merge bakes each sub-mesh's transform + material color
into vertex colors (textures/PBR are approximated away for the LOD).

Deferred levers (documented, not yet wired): per-room `InstancedMesh` chunking
(>~5k racks, for frustum/shadow culling), a Web-Worker tracer, batched shell
geometry, and a `PerformanceMonitor` that drops DPR/shadows under load.

## Stack

| Layer | Choice | Mirrors original |
|------|--------|------------------|
| Build | Vite + React 18 + TypeScript | Vite + React |
| 2D UI | Tailwind CSS | Tailwind |
| 3D | three.js + @react-three/fiber + @react-three/drei | same |
| Split | `Scene3D` lazy-loaded behind `<Suspense>` | same (index + Scene3D chunks) |

No backend — all data is embedded, exactly like the original.

## How it works

```
src/
  data/            extracted verbatim from the original bundle
    nodes.json        397 nodes  {id,label,nodeType,system,shape,x,y,w?,h?,traceOnly?}
    containers.json   36 building containers (floor/room/zone/row)
    depRules.json     146 dependency rules {sourceType,targetType,topology,level}
    impRules.json     117 impact rules
    categories.json   nodeType -> system (electrical/cooling/spatial/whitespace)
    meta.json         trace scopes + max depths
  lib/
    types.ts        domain types
    graph.ts        lookup maps + spatial-containment maps (cell→racks, container→racks)
    trace.ts        the tracer: traceEdges() + relatedIds/hoverSet/systemByNode/nodeLevels
    palette.ts      colors
  ui/
    App.tsx         toolbar + selection chips + canvas shell  (original `og`)
    components.tsx  SplitToggle / Toggle / Pill / Stepper / Select / Popover / Legend / LoadingSplash
  scene/
    Scene3D.tsx     the whole 3D scene (original `dN`)
    controlsRef.ts  shared CameraControls handle for "Reset view"
```

### The model
- **24 node types** in 4 categories: `electrical` (Rack PDU → RPP → Room PDU → UPS/BESS → Switch Gear → Utility Feed/Generator), `cooling` (RDHx/DTC/Liquid Loop → CDU → Cooling Distribution → Cooling Plant; Air Zone → Air Cooling Unit), `spatial` (Rack/Row/Zone/Aisle), `whitespace` (Capacity Cell, Room/Room-PDU/UPS Bundle).
- Two **rule matrices** drive tracing: dependency rules (`upstream`/`local`, depth-leveled) and impact rules (`downstream`/`load`).

### The tracer (`traceEdges`)
For every selected node, walk its rules:
- **Dependency** → upstream + local edges, capped at `Depth`.
- **Impact** → downstream edges (capped) + a **load fan-out**: find every rack ultimately fed, then aggregate to the chosen **Scope** (Rack / Capacity Cell / Row / Zone / Bundle) via precomputed spatial-containment maps.

Derived per render: related-node set, hovered-edge set, per-node category color, per-node min depth (drives 3D fade/scale).

## Faithful vs. approximated

**Faithful (ported 1:1 from the deobfuscated bundle):** all data, the full
tracer + selectors, every toolbar control and its styling, the design tokens,
the `dt-*` animations, the 3D camera (fov 60, fit-to-box on load), CameraControls,
3-light rig + studio environment + fog, ground/grid, dashed-dependency /
solid-impact bezier edges with depth-scaled width/opacity, animated flow points,
building shells with labels, and node fade-by-depth.

**Detailed GLB models with LOD** — the real `/models/*.glb` (rack + 7 equipment
types, meshopt-compressed) live in `public/models/` and are swapped in by camera
distance via drei `<Detailed>` (racks at <15 units, equipment at <10), exactly
like the original. Far away you get cheap boxes; zoom in and the detailed cabinets
stream in. Loading is gated behind `requestIdleCallback` (`detailReady`) so first
paint stays fast, models are preloaded, and each instance is a `<Clone>` of an
opacity-baked template (shared geometry/material) to keep ~120 racks cheap.

**Still simplified:** hover debounce is immediate (original had an 80 ms leave
delay), and the rack capacity-tooltip overlay is omitted.
