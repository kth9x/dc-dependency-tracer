// ── 3D scene — instanced for scale (thousands of racks @ 60 FPS) ───────
// Racks/cooling/equipment render as a handful of InstancedMeshes (one draw
// call each) with per-instance color driven imperatively from the trace, not
// one React component per node. See plan: in-real-case-the-snazzy-wilkes.md.
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { CameraControls, Environment, Html, Line, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type CameraControlsImpl from "camera-controls";
import type { DcNode, Edge, System } from "../lib/types";
import {
  containerById,
  containers,
  containersByLevel,
  equipment as allEquipment,
  nodeById,
  racks as allRacks,
  sanNodes as allSan,
} from "../lib/graph";
import { colorForSystem, palette } from "../lib/palette";
import { controlsRef } from "./controlsRef";
import { GlProbe, PerfHud, usePerfHud } from "./PerfHud";

interface SceneProps {
  activeTsns: string[];
  edges: Edge[];
  hlSystems: Record<string, System>;
  relatedIds: Set<string>;
  hoverSet: Set<string>;
  hiddenTypes: Set<string>;
  nodeLevels: Record<string, number>;
  showLines: boolean;
  curvedLines: boolean;
  animated: boolean;
  showLabels: boolean;
  hoveredNode: string | null;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

const RACK = { w: 0.24, h: 0.55, d: 0.38 };
const M = 0.26; // generic-equipment cube size
// Google-Maps-style label tiers + declutter (see LabelManager).
const LABEL_MAX = 14; // max simultaneous on-screen labels after decluttering
const LABEL_FAR_Y = 28; // camera height above which only room labels show
const LABEL_CLOSE_Y = 12; // ...below which device labels show and rooms drop
const LABEL_DEVICE_DIST = 22; // only devices within this camera distance are label candidates
const MAX_RENDER_EDGES = 320; // hard cap on drawn edge lines (perf guarantee)
const MAX_FLOW_DOTS = 240; // hard cap on animated flow particles

const EQUIP_BOX: Record<string, [number, number, number]> = {
  CDU: [0.31, 0.39, 0.31],
  UPS: [0.32, 0.4, 0.32],
  "Room PDU": [0.32, 0.4, 0.32],
  "Air Cooling Unit": [0.32, 0.4, 0.32],
  RPP: [0.26, 0.32, 0.2],
  BESS: [0.7, 0.18, 0.32],
  "Switch Gear": [0.5, 0.4, 0.16],
};
const COOLING_BIT: Record<
  string,
  { w: number; h: number; d: number; yOff: number; col: string }
> = {
  "Liquid Loop": { w: 0.24, h: 0.04, d: 0.38, yOff: 0.58, col: "#0EA5E9" },
  RDHx: { w: 0.01, h: 0.3, d: 0.08, yOff: 0.18, col: "#3B82F6" },
  DTC: { w: 0.04, h: 0.45, d: 0.18, yOff: 0.25, col: "#3B82F6" },
};

// Detailed GLB models, shown only for the few nodes nearest the camera (LOD).
// `merge`: collapse the GLB's many sub-meshes into one vertex-colored mesh so a
// pooled clone is ONE draw call (equipment GLBs have 400+ sub-meshes otherwise).
type GlbDef = { path: string; scale: [number, number, number]; yOff: number; merge?: boolean };
// Resolve model URLs against the app base (import.meta.env.BASE_URL) so the
// build works under a subpath (e.g. GitHub Pages /<repo>/), not only at root.
const MODELS = ((import.meta as any).env?.BASE_URL ?? "/") + "models/";
const GLB_CONFIG: Record<string, GlbDef> = {
  Rack: { path: `${MODELS}rack.glb`, scale: [0.24 / 0.619, 0.55 / 2.031, 0.38 / 1.119], yOff: 0.0225 * (0.55 / 2.031) },
  CDU: { path: `${MODELS}cdu.glb`, scale: [0.31 / 6.4, 0.39 / 3.13, 0.31 / 1.41], yOff: 0.005, merge: true },
  UPS: { path: `${MODELS}ups.glb`, scale: [0.32 / 1.84, 0.4 / 2.17, 0.32 / 0.95], yOff: 0.005, merge: true },
  "Room PDU": { path: `${MODELS}room-pdu.glb`, scale: [0.32 / 0.84, 0.4 / 2.28, 0.32 / 0.64], yOff: 0.005, merge: true },
  "Air Cooling Unit": { path: `${MODELS}crah.glb`, scale: [0.32 / 1.77, 0.4 / 2.41, 0.32 / 0.93], yOff: 0.005, merge: true },
  RPP: { path: `${MODELS}rpp.glb`, scale: [0.26 / 0.61, 0.32 / 1.96, 0.2 / 0.39], yOff: 0.005, merge: true },
  BESS: { path: `${MODELS}bess.glb`, scale: [0.7 / 4.68, 0.18 / 0.89, 0.32 / 2.13], yOff: 0.09, merge: true },
  "Switch Gear": { path: `${MODELS}switchgear.glb`, scale: [0.5 / 4.56, 0.4 / 2.395, 0.16 / 0.96], yOff: 0.005, merge: true },
};
const RACK_LOD = 15; // promote racks within this camera distance to detailed GLB
const EQUIP_LOD = 11; // equipment promote distance

// ── Per-instance color from trace state (replaces opacity-based fade) ───
const _fog = new THREE.Color("#EDF0F4");
const _white = new THREE.Color("#ffffff");
interface InstCtx {
  hasTrace: boolean;
  nodeLevels: Record<string, number>;
  hlSystems: Record<string, System>;
  activeSet: Set<string>;
}
/** Write the state color for one node into `out` (no allocation). */
function applyState(out: THREE.Color, baseHex: string, id: string, ctx: InstCtx) {
  if (!ctx.hasTrace) {
    out.set(baseHex);
    return;
  }
  if (ctx.activeSet.has(id)) {
    out.set(baseHex).lerp(_white, 0.5); // source: bright
    return;
  }
  const lvl = ctx.nodeLevels[id];
  if (lvl === undefined) {
    out.set(baseHex).lerp(_fog, 0.85); // dim (not in trace)
    return;
  }
  const sys = ctx.hlSystems[id];
  out.set(sys ? colorForSystem(sys) : baseHex);
  const fade = lvl <= 1 ? 0 : lvl === 2 ? 0.2 : lvl === 3 ? 0.45 : 0.65;
  if (fade > 0) out.lerp(_fog, fade);
}

/** One InstancedMesh over a homogeneous group of nodes (one draw call). */
function InstancedNodes({
  nodes,
  geom,
  yOf,
  baseColor,
  castShadow = false,
  groupVisible,
  visibleSet,
  pick = false,
  ctx,
  meshRef,
  onHover,
  onClick,
}: {
  nodes: DcNode[];
  geom: THREE.BufferGeometry;
  yOf: number;
  baseColor: string;
  castShadow?: boolean;
  groupVisible?: boolean;
  visibleSet?: Set<string>;
  pick?: boolean;
  ctx: InstCtx;
  meshRef?: { current: THREE.InstancedMesh | null };
  onHover?: (id: string | null) => void;
  onClick?: (id: string) => void;
}) {
  const internalRef = useRef<THREE.InstancedMesh>(null);
  const ref = meshRef ?? internalRef;
  const count = nodes.length;

  // Matrices: static position; per-instance hide (scale→0) when visibleSet given.
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh || count === 0) return;
    const m = new THREE.Matrix4();
    const hidden = new THREE.Matrix4().makeScale(1e-6, 1e-6, 1e-6);
    for (let i = 0; i < count; i++) {
      const n = nodes[i];
      const vis = visibleSet ? visibleSet.has(n.id) : true;
      mesh.setMatrixAt(i, vis ? m.makeTranslation(n.x, yOf, n.y) : hidden);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [nodes, count, yOf, visibleSet]);

  // Group-level visibility (whole type toggled).
  useEffect(() => {
    if (ref.current && groupVisible !== undefined) ref.current.visible = groupVisible;
  }, [groupVisible]);

  // Colors from trace state.
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh || count === 0) return;
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      applyState(c, baseColor, nodes[i].id, ctx);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [nodes, count, baseColor, ctx]);

  const handlers = pick
    ? {
        onPointerMove: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          if (e.instanceId != null) onHover?.(nodes[e.instanceId].id);
        },
        onPointerOut: () => onHover?.(null),
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId != null) onClick?.(nodes[e.instanceId].id);
        },
      }
    : {};

  return (
    <instancedMesh
      ref={ref}
      args={[undefined as any, undefined as any, Math.max(count, 1)]}
      castShadow={castShadow}
      frustumCulled={false}
      {...handlers}
    >
      <primitive object={geom} attach="geometry" />
      <meshStandardMaterial color="#ffffff" metalness={0.04} roughness={0.85} />
    </instancedMesh>
  );
}

/** Translucent hover affordance (replaces the per-rack hover box). */
function HoverBox({ id }: { id: string | null }) {
  const n = id ? nodeById.get(id) : null;
  if (!n) return null;
  const isRack = n.shape === "rack";
  const w = isRack ? RACK.w : M * 1.2;
  const h = isRack ? RACK.h : M;
  const d = isRack ? RACK.d : M * 0.8;
  return (
    <mesh position={[n.x, h / 2, n.y]}>
      <boxGeometry args={[w + 0.03, h + 0.03, d + 0.03]} />
      <meshBasicMaterial color="#fff" transparent opacity={0.1} depthWrite={false} />
    </mesh>
  );
}

// ── Camera + controls (unchanged) ─────────────────────────────────────
function Controls() {
  const ref = useRef<CameraControlsImpl>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    controlsRef.ctrl = c as unknown as CameraControlsImpl;
    const box = new THREE.Box3();
    for (const n of nodeById.values()) {
      if (n.traceOnly) continue;
      box.expandByPoint(new THREE.Vector3(n.x - 0.3, 0, n.y - 0.3));
      box.expandByPoint(new THREE.Vector3(n.x + 0.3, 0.6, n.y + 0.3));
    }
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const radius = Math.max(size.x, size.z);
    const raf = requestAnimationFrame(() => {
      // Default = straight top-down (plan) view, looking directly down at the
      // floor. The tiny z-offset avoids the exact-pole gimbal; fitToBox frames
      // the whole layout (orientation is preserved → stays top-down).
      c.setLookAt(center.x, radius * 1.2, center.z + 0.001, center.x, 0, center.z, false);
      c.fitToBox(box, false, {
        paddingLeft: 0.06,
        paddingRight: 0.06,
        paddingTop: 0.1,
        paddingBottom: 0.06,
      }).then(() => c.saveState());
    });
    return () => {
      cancelAnimationFrame(raf);
      controlsRef.ctrl = null;
    };
  }, []);
  return (
    <CameraControls
      ref={ref}
      makeDefault
      minPolarAngle={0}
      maxPolarAngle={Math.PI / 2.2}
      minDistance={0.5}
      maxDistance={250}
      smoothTime={0.25}
      draggingSmoothTime={0.12}
    />
  );
}

/** Screen-facing pill label (drei Html). Kept ≤LABEL_CAP on screen for perf. */
function LabelPill({
  position,
  text,
  color,
  bg,
  border,
  weight = 600,
  size = 11,
}: {
  position: [number, number, number];
  text: string;
  color: string;
  bg: string;
  border: string;
  weight?: number;
  size?: number;
}) {
  return (
    <Html position={position} center style={{ pointerEvents: "none", whiteSpace: "nowrap" }}>
      <div
        className="animate-dt-fade-up"
        style={{
          fontSize: size,
          fontWeight: weight,
          fontFamily: "'Inter',system-ui,sans-serif",
          color,
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 6,
          padding: "3px 9px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        }}
      >
        {text}
      </div>
    </Html>
  );
}

/** Room labels, capped to the nearest LABEL_CAP rooms to the camera. */
type LabelKind = "room" | "zone" | "cell" | "device" | "sel" | "hover";
interface ChosenLabel {
  id: string;
  text: string;
  pos: [number, number, number];
  kind: LabelKind;
}
const LABEL_PR: Record<LabelKind, number> = { hover: 0, sel: 1, room: 2, cell: 3, zone: 3, device: 4 };

/** Pill styling per label kind (rooms bold dark, zones tinted, devices light). */
function labelStyle(kind: LabelKind, text: string) {
  if (kind === "room") {
    const elec = text.includes("Electrical");
    const special = elec || text.includes("Mechanical");
    return {
      color: special ? (elec ? "#92400E" : "#1E40AF") : "#1E293B",
      bg: special ? (elec ? "rgba(255,251,235,0.97)" : "rgba(239,246,255,0.97)") : "rgba(255,255,255,0.96)",
      border: special ? (elec ? "rgba(217,119,6,0.3)" : "rgba(59,130,246,0.3)") : "rgba(15,23,42,0.10)",
      weight: 700,
      size: 12,
    };
  }
  if (kind === "cell")
    return { color: "#92400E", bg: "rgba(255,251,235,0.95)", border: "rgba(217,119,6,0.28)", weight: 600, size: 11 };
  if (kind === "zone")
    return { color: "#155E75", bg: "rgba(236,254,255,0.95)", border: "rgba(8,145,178,0.28)", weight: 600, size: 11 };
  if (kind === "sel" || kind === "hover")
    return { color: "#0F172A", bg: "rgba(255,255,255,0.98)", border: "rgba(15,23,42,0.18)", weight: 700, size: 12 };
  return { color: "#334155", bg: "rgba(255,255,255,0.92)", border: "rgba(15,23,42,0.08)", weight: 600, size: 10 };
}

/**
 * Google-Maps-style label manager: zoom tiers (far=rooms, mid=+zones,
 * close=devices) + selected/hovered always; project to screen, rank by
 * priority, greedily place skipping overlaps, cap LABEL_MAX. Throttled ~8 Hz
 * with hysteresis so labels stay stable. drei <Html> tracks each chosen pos.
 */
function LabelManager({
  enabled,
  hiddenTypes,
  activeTsns,
  hoveredNode,
  onChange,
}: {
  enabled: boolean;
  hiddenTypes: Set<string>;
  activeTsns: string[];
  hoveredNode: string | null;
  onChange: (labels: ChosenLabel[]) => void;
}) {
  const lastT = useRef(0);
  const prevIds = useRef("");
  const prevChosen = useRef<Set<string>>(new Set());
  const v = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera, size, clock }) => {
    if (!enabled) {
      if (prevIds.current !== "") {
        prevIds.current = "";
        prevChosen.current = new Set();
        onChange([]);
      }
      return;
    }
    const t = clock.getElapsedTime();
    if (t - lastT.current < 0.12) return;
    lastT.current = t;

    const cam = camera.position;
    const tier = cam.y > LABEL_FAR_Y ? "far" : cam.y < LABEL_CLOSE_Y ? "close" : "mid";

    type Cand = { id: string; text: string; x: number; y: number; z: number; pr: number; kind: LabelKind };
    const cands: Cand[] = [];
    const seen = new Set<string>();
    const add = (id: string, text: string, x: number, y: number, z: number, kind: LabelKind) => {
      if (seen.has(id)) return;
      seen.add(id);
      cands.push({ id, text, x, y, z, pr: LABEL_PR[kind], kind });
    };

    for (const id of activeTsns) {
      const n = nodeById.get(id);
      if (n) {
        const a = nodeAnchor(n);
        add(id, n.label, a.x, a.y + 0.2, a.z, "sel");
      }
    }
    if (hoveredNode) {
      const n = nodeById.get(hoveredNode);
      if (n) {
        const a = nodeAnchor(n);
        add(hoveredNode, n.label, a.x, a.y + 0.2, a.z, "hover");
      }
    }
    if (tier !== "close")
      for (const c of containersByLevel.room) add("room:" + c.id, c.label, c.cx, 0.34, c.cz, "room");
    if (tier !== "far")
      for (const n of allSan)
        if (!hiddenTypes.has(n.nodeType)) {
          const a = nodeAnchor(n);
          add(n.id, n.label, a.x, a.y, a.z, n.nodeType === "Capacity Cell" ? "cell" : "zone");
        }
    if (tier === "close") {
      const near: { n: DcNode; d2: number }[] = [];
      const r2 = LABEL_DEVICE_DIST * LABEL_DEVICE_DIST;
      for (const n of allRacks) {
        const dx = n.x - cam.x, dz = n.y - cam.z, d2 = dx * dx + dz * dz;
        if (d2 < r2) near.push({ n, d2 });
      }
      for (const n of allEquipment) {
        if (hiddenTypes.has(n.nodeType)) continue;
        const dx = n.x - cam.x, dz = n.y - cam.z, d2 = dx * dx + dz * dz;
        if (d2 < r2) near.push({ n, d2 });
      }
      near.sort((a, b) => a.d2 - b.d2);
      for (const { n } of near.slice(0, 60)) {
        const a = nodeAnchor(n);
        add(n.id, n.label, a.x, a.y + 0.15, a.z, "device");
      }
    }

    type P = Cand & { sx: number; sy: number; sort: number };
    const proj: P[] = [];
    for (const c of cands) {
      v.set(c.x, c.y, c.z).project(camera);
      if (v.z > 1) continue; // behind camera
      const sx = (v.x * 0.5 + 0.5) * size.width;
      const sy = (-v.y * 0.5 + 0.5) * size.height;
      if (sx < -60 || sy < -30 || sx > size.width + 60 || sy > size.height + 30) continue;
      const dx = c.x - cam.x, dy = c.y - cam.y, dz = c.z - cam.z;
      const persist = prevChosen.current.has(c.id) ? -0.5 : 0; // hysteresis
      proj.push({ ...c, sx, sy, sort: c.pr + persist + (dx * dx + dy * dy + dz * dz) * 1e-5 });
    }
    proj.sort((a, b) => a.sort - b.sort);

    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const chosen: ChosenLabel[] = [];
    for (const p of proj) {
      if (chosen.length >= LABEL_MAX) break;
      const fs = labelStyle(p.kind, p.text).size;
      const w = p.text.length * 6.3 * (fs / 11) + 18;
      const h = fs + 12;
      const x0 = p.sx - w / 2, y0 = p.sy - h / 2;
      let ok = true;
      for (const r of placed)
        if (x0 < r.x + r.w + 4 && x0 + w > r.x - 4 && y0 < r.y + r.h + 4 && y0 + h > r.y - 4) {
          ok = false;
          break;
        }
      if (!ok) continue;
      placed.push({ x: x0, y: y0, w, h });
      chosen.push({ id: p.id, text: p.text, pos: [p.x, p.y, p.z], kind: p.kind });
    }

    const ids = chosen.map((c) => c.id).join("|");
    if (ids !== prevIds.current) {
      prevIds.current = ids;
      prevChosen.current = new Set(chosen.map((c) => c.id));
      onChange(chosen);
    }
  });
  return null;
}

// ── Edge helpers (kept; batched renderer comes in the next phase) ──────
function nodeAnchor(node: DcNode): THREE.Vector3 {
  if (node.shape === "san") {
    const w = node.w || 2;
    const h = node.h || 2;
    const isCell = node.nodeType === "Capacity Cell";
    return new THREE.Vector3(
      node.x + (isCell ? w / 2 - 0.06 : -w / 2 + 0.06),
      0.532,
      node.y + (isCell ? h / 2 : -h / 2),
    );
  }
  const y = node.shape === "rack" ? 0.42 : 0.13;
  return new THREE.Vector3(node.x, y, node.y);
}
/** Anchor for an edge endpoint — a node or an aggregate container. */
function edgeAnchor(id: string): THREE.Vector3 | null {
  const n = nodeById.get(id);
  if (n) return nodeAnchor(n);
  const c = containerById.get(id);
  if (c) return new THREE.Vector3(c.cx, 0.35, c.cz);
  return null;
}
function edgePts(a: THREE.Vector3, b: THREE.Vector3, curved: boolean): [number, number, number][] {
  if (curved) {
    const midY = Math.max(a.y, b.y) + 0.2 + a.distanceTo(b) * 0.05;
    const curve = new THREE.QuadraticBezierCurve3(
      a,
      new THREE.Vector3((a.x + b.x) / 2, midY, (a.z + b.z) / 2),
      b,
    );
    return curve.getPoints(16).map((p) => [p.x, p.y, p.z]);
  }
  return [
    [a.x, a.y, a.z],
    [b.x, b.y, b.z],
  ];
}
function hashOffset(s: string): number {
  let e = 0;
  for (let i = 0; i < s.length; i++) e = ((e << 5) - e + s.charCodeAt(i)) | 0;
  return Math.abs(e % 1000) / 1000;
}

function Zone({
  node,
  isHl,
  hlColor,
  showLabels,
  onHover,
  onClick,
}: {
  node: DcNode;
  isHl: boolean;
  hlColor: string | null;
  showLabels: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}) {
  const w = node.w || 2;
  const h = node.h || 2;
  const p = 0.5;
  const isCell = node.nodeType === "Capacity Cell";
  const base = isCell ? "#B45309" : "#0891B2";
  const highlighted = isHl && hlColor;
  const lineColor = highlighted ? hlColor! : base;
  const lineOp = highlighted || isCell ? 0.35 : 0.22;
  const r = w / 2;
  const o = h / 2;
  return (
    <group position={[node.x, 0.002, node.y]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.001, 0]}
        onClick={(e) => { e.stopPropagation(); onClick(node.id); }}
        onPointerOver={(e) => { e.stopPropagation(); onHover(node.id); }}
        onPointerOut={() => onHover(null)}
      >
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color={base} transparent opacity={highlighted ? 0.06 : 0.03} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line
        points={[
          [-r, 0, -o], [r, 0, -o], [r, 0, o], [-r, 0, o], [-r, 0, -o],
          [-r, p, -o], [r, p, -o], [r, p, o], [-r, p, o], [-r, p, -o],
        ]}
        color={lineColor}
        lineWidth={1}
        transparent
        opacity={lineOp}
      />
    </group>
  );
}

function Shells({
  highlighted,
  hasTrace,
  showLabels,
}: {
  highlighted: Set<string>;
  hasTrace: boolean;
  showLabels: boolean;
}) {
  const isSpecial = (label: string) =>
    label.includes("Electrical") || label.includes("Mechanical");
  return (
    <group>
      {containers.map((c) => {
        const isFloor = c.level === "floor";
        const isRoom = c.level === "room";
        const isZone = c.level === "zone";
        const isRow = c.level === "row";
        const isHl = highlighted.has(c.id);
        const special = isRoom && isSpecial(c.label);
        const y = isFloor ? 0 : isRoom ? 0.001 : isZone ? 0.003 : 0.01;
        const hw = c.w / 2;
        const hd = c.d / 2;
        const fillColor = special
          ? c.label.includes("Electrical") ? "#F59E0B" : "#3B82F6"
          : isRow ? "#8A9BAA" : "#94A3B8";
        const fillOp = isFloor ? 0.015 : isRoom ? (special ? 0.06 : 0.04) : isZone ? 0.03 : isRow ? 0.35 : 0;
        const lineColor = isRoom ? "#64748B" : "#94A3B8";
        const lineOp = isHl ? 0.18 : isFloor ? 0.01 : isRoom ? 0.1 : isZone ? 0.05 : 0.03;
        const lineW = isHl ? 1.2 : isRoom ? 1 : 0.5;
        return (
          <group key={c.id} position={[c.cx, y, c.cz]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[c.w, c.d]} />
              <meshBasicMaterial color={fillColor} transparent opacity={fillOp} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <Line
              points={[[-hw, 0.001, -hd], [hw, 0.001, -hd], [hw, 0.001, hd], [-hw, 0.001, hd], [-hw, 0.001, -hd]]}
              color={lineColor}
              lineWidth={lineW}
              transparent
              opacity={lineOp}
            />
          </group>
        );
      })}
    </group>
  );
}

function EdgeLine({ edge, curved, faded }: { edge: Edge; curved: boolean; faded: boolean }) {
  const a = edgeAnchor(edge.fromId);
  const b = edgeAnchor(edge.toId);
  const pts = useMemo(
    () => (a && b ? edgePts(a, b, curved) : []),
    [edge.fromId, edge.toId, curved],
  );
  if (!a || !b) return null;
  const isDep = edge.topology === "upstream" || edge.topology === "local";
  const color = colorForSystem(edge.system);
  const lvl = edge.level ?? 1;
  const elec = edge.system === "electrical";
  let width: number;
  let opacity: number;
  if (faded) { width = 0.5; opacity = 0.03; }
  else if (lvl <= 1) { width = isDep ? (elec ? 2.8 : 2.2) : elec ? 3 : 2.5; opacity = isDep ? (elec ? 0.85 : 0.75) : elec ? 0.9 : 0.8; }
  else if (lvl === 2) { width = isDep ? 2 : 2.2; opacity = isDep ? 0.65 : 0.7; }
  else if (lvl === 3) { width = 1.4; opacity = 0.45; }
  else { width = 1; opacity = 0.3; }
  return (
    <Line points={pts} color={color} lineWidth={width} transparent opacity={opacity} dashed={isDep} dashSize={0.1} gapSize={0.05} />
  );
}

function FlowDots({ paths }: { paths: { pts: [number, number, number][]; col: string; off: number }[] }) {
  const geomRef = useRef<THREE.BufferGeometry>(null);
  const count = paths.length;
  const { positions, colors } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      c.set(paths[i].col);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    return { positions, colors };
  }, [paths, count]);
  useFrame(({ clock }) => {
    const g = geomRef.current;
    if (!g || count === 0) return;
    const attr = g.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const t = clock.getElapsedTime() * 0.25;
    for (let i = 0; i < count; i++) {
      const d = paths[i].pts;
      const m = d.length;
      if (m < 2) continue;
      const g2 = ((t + paths[i].off) % 1) * (m - 1);
      const v = Math.floor(g2);
      const s = g2 - v;
      const a = d[Math.min(v, m - 1)];
      const b = d[Math.min(v + 1, m - 1)];
      arr[i * 3] = a[0] + (b[0] - a[0]) * s;
      arr[i * 3 + 1] = a[1] + (b[1] - a[1]) * s;
      arr[i * 3 + 2] = a[2] + (b[2] - a[2]) * s;
    }
    attr.needsUpdate = true;
  });
  if (count === 0) return null;
  return (
    <points>
      <bufferGeometry ref={geomRef}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.055} vertexColors transparent opacity={0.72} sizeAttenuation depthWrite={false} />
    </points>
  );
}

function SystemLabels({ nodes }: { nodes: DcNode[] }) {
  const labels = useMemo(() => {
    const out: { label: string; color: string; x: number; z: number }[] = [];
    const elec = nodes.filter((n) => n.system === "electrical" && n.traceOnly);
    const cool = nodes.filter((n) => n.system === "cooling" && n.traceOnly);
    if (elec.length >= 2) {
      out.push({ label: "POWER", color: palette.elec, x: elec.reduce((s, n) => s + n.x, 0) / elec.length, z: elec.reduce((s, n) => s + n.y, 0) / elec.length });
    }
    if (cool.length >= 2) {
      out.push({ label: "COOLING", color: palette.cool, x: cool.reduce((s, n) => s + n.x, 0) / cool.length, z: cool.reduce((s, n) => s + n.y, 0) / cool.length });
    }
    return out;
  }, [nodes]);
  return (
    <>
      {labels.map((l) => (
        <Html key={l.label} position={[l.x, 0.8, l.z]} center style={{ pointerEvents: "none", whiteSpace: "nowrap" }}>
          <div style={{ fontSize: 9, fontWeight: 800, fontFamily: "'Inter',system-ui,sans-serif", color: l.color, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.45 }}>
            {l.label}
          </div>
        </Html>
      ))}
    </>
  );
}

// ── Instanced node layer (racks + cooling + equipment) ─────────────────
/** Flips a flag when the camera drops below a height (zoomed in), with hysteresis. */
function ZoomWatch({ onChange }: { onChange: (v: boolean) => void }) {
  const on = useRef(false);
  const acc = useRef(0);
  useFrame(({ camera, clock }, dt) => {
    if (clock.getElapsedTime() < 1) return; // let the initial camera fit settle
    acc.current += dt;
    if (acc.current < 0.2) return;
    acc.current = 0;
    const y = camera.position.y;
    const next = on.current ? y < 16 : y < 12;
    if (next !== on.current) {
      on.current = next;
      onChange(next);
    }
  });
  return null;
}

/** Load a GLB; when `glb.merge`, collapse its 400+ sub-meshes into ONE
 *  vertex-colored mesh (so a pooled clone is 1 draw call). The display transform
 *  (incl. the non-uniform `glb.scale`) is baked via a scaled clone's matrixWorld
 *  — the same hierarchy three uses for the raw rack clone — so rotated parts keep
 *  their correct orientation/proportions (no shear). The baked size IS final, so
 *  DetailPool must NOT re-apply scale to a merged clone. */
function useMergedGlb(glb: GlbDef): THREE.Object3D {
  const { scene } = useGLTF(glb.path) as any;
  return useMemo(() => {
    if (!glb.merge) return scene as THREE.Object3D;
    const inst = scene.clone(true) as THREE.Object3D;
    inst.scale.set(glb.scale[0], glb.scale[1], glb.scale[2]);
    inst.position.set(0, 0, 0);
    // KEEP the scene root's rotation (GLBs often carry a Y-up→Z-up rotation);
    // stripping it is what made merged equipment lie flat vs. the raw rack clone.
    inst.updateMatrixWorld(true);

    const geoms: THREE.BufferGeometry[] = [];
    const col = new THREE.Color();
    const tmp = new THREE.Matrix4();
    const bake = (geom: THREE.BufferGeometry, matrix: THREE.Matrix4, material: any) => {
      let g = geom.clone() as THREE.BufferGeometry;
      for (const k of Object.keys(g.attributes))
        if (k !== "position" && k !== "normal") g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(matrix);
      if (g.index) g = g.toNonIndexed();
      const m = Array.isArray(material) ? material[0] : material;
      col.copy((m && m.color) || new THREE.Color("#9aa3ad"));
      if (m && m.emissive) col.add(m.emissive.clone().multiplyScalar(0.6));
      const n = g.attributes.position.count;
      const carr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        carr[i * 3] = col.r;
        carr[i * 3 + 1] = col.g;
        carr[i * 3 + 2] = col.b;
      }
      g.setAttribute("color", new THREE.BufferAttribute(carr, 3));
      geoms.push(g);
    };
    inst.traverse((o: any) => {
      if (!o.geometry) return;
      if (o.isInstancedMesh) {
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, tmp);
          bake(o.geometry, new THREE.Matrix4().multiplyMatrices(o.matrixWorld, tmp), o.material);
        }
      } else if (o.isMesh) {
        bake(o.geometry, o.matrixWorld, o.material);
      }
    });
    if (!geoms.length) return scene as THREE.Object3D;
    const merged = mergeGeometries(geoms, false);
    if (!merged) return scene as THREE.Object3D;
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.25, roughness: 0.65 }),
    );
    mesh.castShadow = true;
    const grp = new THREE.Group();
    grp.add(mesh);
    return grp;
  }, [scene, glb]);
}

/**
 * Bounded pool of detailed GLB clones that snap to the nodes nearest the camera,
 * hiding those nodes' instanced box(es). Detailed-model count stays constant
 * regardless of total node count. Mounted only when zoomed in (lazy GLB load).
 */
function DetailPool({
  nodes,
  glb,
  lodDistance,
  poolSize,
  boxes,
  visibleSet,
  onHover,
  onClick,
}: {
  nodes: DcNode[];
  glb: GlbDef;
  lodDistance: number;
  poolSize: number;
  boxes: { ref: { current: THREE.InstancedMesh | null }; yOf: number }[];
  visibleSet?: Set<string>;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}) {
  const template = useMergedGlb(glb);
  const clones = useMemo(
    () =>
      Array.from({ length: poolSize }, () => {
        const c = template.clone(true) as THREE.Object3D;
        // Merged templates already bake glb.scale; only the raw (rack) needs it.
        if (!glb.merge) c.scale.set(glb.scale[0], glb.scale[1], glb.scale[2]);
        c.visible = false;
        return c;
      }),
    [template, poolSize, glb],
  );
  const slotNode = useRef<(string | null)[]>(Array(poolSize).fill(null));
  const promoted = useRef<Set<number>>(new Set());
  const acc = useRef(0);
  const tmp = useMemo(() => new THREE.Matrix4(), []);
  const hideMat = useMemo(() => new THREE.Matrix4().makeScale(1e-6, 1e-6, 1e-6), []);

  const setBox = (i: number, hide: boolean) => {
    const n = nodes[i];
    const vis = visibleSet ? visibleSet.has(n.id) : true;
    for (const b of boxes) {
      const mesh = b.ref.current;
      if (!mesh) continue;
      mesh.setMatrixAt(i, hide ? hideMat : vis ? tmp.makeTranslation(n.x, b.yOf, n.y) : hideMat);
      mesh.instanceMatrix.needsUpdate = true;
    }
  };

  useFrame(({ camera }, dt) => {
    acc.current += dt;
    if (acc.current < 0.12) return;
    acc.current = 0;
    const cam = camera.position;
    const onT = lodDistance * lodDistance;
    const offT = (lodDistance + 2) * (lodDistance + 2);
    const cands: { i: number; d2: number }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (visibleSet && !visibleSet.has(n.id)) continue;
      const dx = n.x - cam.x;
      const dy = glb.yOff - cam.y;
      const dz = n.y - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= (promoted.current.has(i) ? offT : onT)) cands.push({ i, d2 });
    }
    cands.sort((a, b) => a.d2 - b.d2);
    const chosen = cands.slice(0, poolSize);
    const chosenSet = new Set(chosen.map((c) => c.i));
    for (const i of promoted.current) if (!chosenSet.has(i)) setBox(i, false);
    for (const c of chosen) if (!promoted.current.has(c.i)) setBox(c.i, true);
    promoted.current = chosenSet;
    for (let s = 0; s < poolSize; s++) {
      const c = clones[s];
      if (s < chosen.length) {
        const n = nodes[chosen[s].i];
        c.position.set(n.x, glb.yOff, n.y);
        c.visible = true;
        slotNode.current[s] = n.id;
      } else {
        c.visible = false;
        slotNode.current[s] = null;
      }
    }
  });

  // Restore any hidden boxes when the pool unmounts (zoom out / type hidden).
  useEffect(
    () => () => {
      for (const i of promoted.current) setBox(i, false);
      promoted.current = new Set();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <>
      {clones.map((c, s) => (
        <primitive
          key={s}
          object={c}
          onPointerOver={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            const id = slotNode.current[s];
            if (id) onHover(id);
          }}
          onPointerOut={() => onHover(null)}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            const id = slotNode.current[s];
            if (id) onClick(id);
          }}
        />
      ))}
    </>
  );
}

function NodeInstances({
  ctx,
  hiddenTypes,
  relatedIds,
  activeTsns,
  detail,
  onHover,
  onClick,
}: {
  ctx: InstCtx;
  hiddenTypes: Set<string>;
  relatedIds: Set<string>;
  activeTsns: string[];
  detail: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}) {
  const rackGeom = useMemo(() => new THREE.BoxGeometry(RACK.w, RACK.h, RACK.d), []);
  const bandGeom = useMemo(() => new THREE.BoxGeometry(RACK.w, 0.01, RACK.d), []);

  // Equipment grouped by type, each with its geometry + render kind.
  const groups = useMemo(() => {
    const byType = new Map<string, DcNode[]>();
    for (const n of allEquipment) {
      const arr = byType.get(n.nodeType);
      if (arr) arr.push(n);
      else byType.set(n.nodeType, [n]);
    }
    return [...byType.entries()].map(([type, nodes]) => {
      const bit = COOLING_BIT[type];
      const box = EQUIP_BOX[type];
      const meshRef: { current: THREE.InstancedMesh | null } = { current: null };
      if (bit)
        return { type, nodes, meshRef, geom: new THREE.BoxGeometry(bit.w, bit.h, bit.d), yOf: bit.yOff, baseColor: bit.col, castShadow: false, kind: "cooling" as const };
      if (box)
        return { type, nodes, meshRef, geom: new THREE.BoxGeometry(box[0], box[1], box[2]), yOf: box[1] / 2, baseColor: palette.node, castShadow: true, kind: "box" as const };
      return { type, nodes, meshRef, geom: new THREE.BoxGeometry(M * 1.2, M, M * 0.8), yOf: M / 2, baseColor: palette.node, castShadow: true, kind: "generic" as const };
    });
  }, []);

  const rackBodyRef = useRef<THREE.InstancedMesh>(null);
  const rackBandRef = useRef<THREE.InstancedMesh>(null);

  // Visible set for generic traceOnly singletons (shown only when in the trace).
  const genericVisible = useMemo(() => {
    const s = new Set<string>();
    const active = new Set(activeTsns);
    for (const g of groups)
      if (g.kind === "generic")
        for (const n of g.nodes)
          if (relatedIds.has(n.id) || active.has(n.id)) s.add(n.id);
    return s;
  }, [groups, relatedIds, activeTsns]);

  return (
    <>
      <InstancedNodes nodes={allRacks} geom={rackGeom} yOf={RACK.h / 2} baseColor={palette.node} castShadow pick ctx={ctx} meshRef={rackBodyRef} onHover={onHover} onClick={onClick} />
      <InstancedNodes nodes={allRacks} geom={bandGeom} yOf={RACK.h + 0.005} baseColor="#475569" ctx={ctx} meshRef={rackBandRef} />
      {detail && (
        <Suspense fallback={null}>
          <DetailPool
            nodes={allRacks}
            glb={GLB_CONFIG.Rack}
            lodDistance={RACK_LOD}
            poolSize={24}
            boxes={[
              { ref: rackBodyRef, yOf: RACK.h / 2 },
              { ref: rackBandRef, yOf: RACK.h + 0.005 },
            ]}
            onHover={onHover}
            onClick={onClick}
          />
        </Suspense>
      )}
      {groups.map((g) => (
        <InstancedNodes
          key={g.type}
          nodes={g.nodes}
          geom={g.geom}
          yOf={g.yOf}
          baseColor={g.baseColor}
          castShadow={g.castShadow}
          groupVisible={g.kind === "generic" ? undefined : !hiddenTypes.has(g.type)}
          visibleSet={g.kind === "generic" ? genericVisible : undefined}
          pick={g.kind !== "cooling"}
          ctx={ctx}
          meshRef={g.meshRef}
          onHover={onHover}
          onClick={onClick}
        />
      ))}
      {/* Equipment detail pools — GLBs merged to one vertex-colored mesh each
          (so a clone is 1 draw call despite 400+ source sub-meshes). */}
      {detail &&
        groups.map((g) =>
          g.kind === "box" && GLB_CONFIG[g.type] && !hiddenTypes.has(g.type) ? (
            <Suspense key={`pool-${g.type}`} fallback={null}>
              <DetailPool
                nodes={g.nodes}
                glb={GLB_CONFIG[g.type]}
                lodDistance={EQUIP_LOD}
                poolSize={6}
                boxes={[{ ref: g.meshRef, yOf: g.yOf }]}
                onHover={onHover}
                onClick={onClick}
              />
            </Suspense>
          ) : null,
        )}
    </>
  );
}

// ── Main scene ─────────────────────────────────────────────────────────
export default function Scene3D(props: SceneProps) {
  const {
    activeTsns, edges, hlSystems, relatedIds, hoverSet, hiddenTypes, nodeLevels,
    showLines, curvedLines, animated, showLabels, hoveredNode, onHover, onClick,
  } = props;

  const hasTrace = activeTsns.length > 0;
  const hud = usePerfHud();

  // Detailed GLB models load lazily once the browser is idle AND the user has
  // zoomed in — the default aerial view never pays the GLB decode cost.
  const [detailReady, setDetailReady] = useState(false);
  const [zoomedIn, setZoomedIn] = useState(false);
  const detail = detailReady && zoomedIn;
  const [labels, setLabels] = useState<ChosenLabel[]>([]);
  useEffect(() => {
    const ric = (window as any).requestIdleCallback;
    if (ric) {
      const id = ric(() => setDetailReady(true), { timeout: 1500 });
      return () => (window as any).cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setDetailReady(true), 800);
    return () => clearTimeout(t);
  }, []);

  const activeSet = useMemo(() => new Set(activeTsns), [activeTsns]);
  const ctx = useMemo<InstCtx>(
    () => ({ hasTrace, nodeLevels, hlSystems, activeSet }),
    [hasTrace, nodeLevels, hlSystems, activeSet],
  );

  const visibleSan = useMemo(() => allSan.filter((n) => !hiddenTypes.has(n.nodeType)), [hiddenTypes]);

  const isVisible = (n: DcNode) =>
    !(
      hiddenTypes.has(n.nodeType) ||
      (n.traceOnly && !relatedIds.has(n.id) && !activeSet.has(n.id) &&
        !["Room PDU", "UPS", "Air Cooling Unit", "Liquid Loop", "RDHx", "DTC", "BESS", "Switch Gear"].includes(n.nodeType))
    );

  const highlightedContainers = useMemo(() => {
    const set = new Set<string>();
    if (!hasTrace) return set;
    for (const rack of allRacks) {
      if (!relatedIds.has(rack.id) && !activeSet.has(rack.id)) continue;
      for (const c of containers)
        if (c.level !== "floor" && Math.abs(rack.x - c.cx) < c.w / 2 + 0.1 && Math.abs(rack.y - c.cz) < c.d / 2 + 0.1)
          set.add(c.id);
    }
    return set;
  }, [activeSet, relatedIds, hasTrace]);

  const flowPaths = useMemo(() => {
    if (!animated || !showLines) return [];
    const out: { pts: [number, number, number][]; col: string; off: number }[] = [];
    for (const e of edges) {
      if ((e.level ?? 1) > 2 || (hoveredNode !== null && !hoverSet.has(e.id))) continue;
      const from = nodeById.get(e.fromId);
      const to = nodeById.get(e.toId);
      if (from && !isVisible(from)) continue;
      if (to && !isVisible(to)) continue;
      const a = edgeAnchor(e.fromId);
      const b = edgeAnchor(e.toId);
      if (!a || !b) continue;
      out.push({ pts: edgePts(a, b, curvedLines), col: colorForSystem(e.system), off: hashOffset(e.id) });
      if (out.length >= MAX_FLOW_DOTS) break;
    }
    return out;
  }, [edges, animated, showLines, curvedLines, hoveredNode, hoverSet, hiddenTypes, relatedIds, activeSet]);

  // Visible edges, hard-capped (lowest depth first) so render stays bounded.
  const renderEdges = useMemo(() => {
    if (!showLines) return [];
    const vis = edges.filter((e) => {
      const from = nodeById.get(e.fromId);
      const to = nodeById.get(e.toId);
      return !((from && !isVisible(from)) || (to && !isVisible(to)));
    });
    if (vis.length <= MAX_RENDER_EDGES) return vis;
    return [...vis].sort((x, y) => (x.level ?? 1) - (y.level ?? 1)).slice(0, MAX_RENDER_EDGES);
  }, [edges, showLines, hiddenTypes, relatedIds, activeSet]);

  return (
    <div style={{ width: "100%", height: "100%" }} onContextMenu={(e) => e.preventDefault()}>
      {hud.show && <PerfHud sample={hud.sample} rackCount={allRacks.length} />}
      <Canvas
        dpr={[1, 1.5]}
        shadows
        camera={{ fov: 60, position: [3, 16, 0.5] }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.5 }}
        style={{ position: "absolute", inset: 0 }}
      >
        {hud.show && <GlProbe onSample={hud.setSample} />}
        <Controls />
        <ZoomWatch onChange={setZoomedIn} />
        <color attach="background" args={["#EDF0F4"]} />
        <fog attach="fog" args={["#EDF0F4", 30, 60]} />
        <Suspense fallback={null}>
          <Environment preset="studio" background={false} environmentIntensity={0.8} />
        </Suspense>

        <ambientLight intensity={0.5} color="#F0F4FA" />
        <directionalLight
          position={[8, 18, 6]} intensity={2} color="#FFFDF7" castShadow
          shadow-mapSize-width={1024} shadow-mapSize-height={1024}
          shadow-camera-left={-15} shadow-camera-right={18} shadow-camera-top={8} shadow-camera-bottom={-10}
          shadow-camera-near={5} shadow-camera-far={45} shadow-bias={-0.001} shadow-normalBias={0.02}
        />
        <directionalLight position={[-6, 12, -8]} intensity={0.4} color="#E0E7F0" />
        <hemisphereLight args={["#F0F4FA", "#D4D0C8", 0.35]} />

        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[3, -0.005, -2]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#D8DDE4" roughness={0.65} metalness={0.08} />
        </mesh>

        <Shells highlighted={highlightedContainers} hasTrace={hasTrace} showLabels={showLabels} />

        {visibleSan.map((n) => (
          <Zone key={n.id} node={n} isHl={relatedIds.has(n.id)} hlColor={hlSystems[n.id] ? colorForSystem(hlSystems[n.id]) : null} showLabels={showLabels} onHover={onHover} onClick={onClick} />
        ))}

        <NodeInstances ctx={ctx} hiddenTypes={hiddenTypes} relatedIds={relatedIds} activeTsns={activeTsns} detail={detail} onHover={onHover} onClick={onClick} />
        <HoverBox id={hoveredNode} />

        {hasTrace && showLabels && <SystemLabels nodes={allEquipment.filter(isVisible)} />}

        {/* Google-Maps-style decluttered labels (zoom-tiered, collision-free) */}
        <LabelManager
          enabled={showLabels}
          hiddenTypes={hiddenTypes}
          activeTsns={activeTsns}
          hoveredNode={hoveredNode}
          onChange={setLabels}
        />
        {labels.map((l) => (
          <LabelPill key={l.id} position={l.pos} text={l.text} {...labelStyle(l.kind, l.text)} />
        ))}

        {renderEdges.map((e) => (
          <EdgeLine
            key={e.id}
            edge={e}
            curved={curvedLines}
            faded={hoveredNode !== null ? !hoverSet.has(e.id) : false}
          />
        ))}

        <FlowDots paths={flowPaths} />
      </Canvas>
    </div>
  );
}
