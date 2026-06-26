// ── Static graph data + derived lookup maps ───────────────────────────
// (ports the index chunk's data tables: qu, Bu, Ha, Nu, tp, Km, Jm, km)

import type { Container, DcNode, System } from "./types";
import nodesData from "../data/nodes.json";
import containersData from "../data/containers.json";
import categoriesData from "../data/categories.json";
import { genSynthetic, synthTarget } from "./synth";

// Real dataset by default; ?synth=N tiles it up to N racks for benchmarking.
const base = (() => {
  const target = synthTarget();
  if (target)
    try {
      return genSynthetic(target);
    } catch {
      /* fall through to real data */
    }
  return {
    nodes: nodesData as DcNode[],
    containers: containersData as Container[],
  };
})();

export const nodes = base.nodes;
export const containers = base.containers;

/** nodeType -> system category (the original `Ha` map). */
export const categoryOf = categoriesData as Record<string, System>;

/** id -> node (the original `tp`). */
export const nodeById = new Map<string, DcNode>(nodes.map((n) => [n.id, n]));

/** id -> container, for resolving aggregate-edge endpoints. */
export const containerById = new Map<string, Container>(
  containers.map((c) => [c.id, c]),
);

/** nodeType -> nodes[] (the original `Nu`). */
const byType = (() => {
  const m = new Map<string, DcNode[]>();
  for (const n of nodes) {
    const arr = m.get(n.nodeType);
    if (arr) arr.push(n);
    else m.set(n.nodeType, [n]);
  }
  return m;
})();

/** all nodes of a type (the original `ac`). */
export const nodesOfType = (t: string): DcNode[] => byType.get(t) ?? [];

export const racks = nodes.filter((n) => n.shape === "rack");
export const sanNodes = nodes.filter((n) => n.shape === "san");
export const equipment = nodes.filter((n) => n.shape === "equipment");

/** Capacity Cell id -> contained rack ids (spatial overlap test) — original `Km`. */
export const cellRacks: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  const cells = byType.get("Capacity Cell") ?? [];
  const rk = byType.get("Rack") ?? [];
  for (const cell of cells) {
    const halfW = (cell.w || 2) / 2;
    const halfH = (cell.h || 2) / 2;
    const ids: string[] = [];
    for (const r of rk) {
      if (
        Math.abs(r.x - cell.x) < halfW + 0.1 &&
        Math.abs(r.y - cell.y) < halfH + 0.1
      )
        ids.push(r.id);
    }
    m.set(cell.id, ids);
  }
  return m;
})();

/** "level:id" -> contained rack ids for floor/room/zone/row — original `Jm`. */
export const containerRacks: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  const rk = byType.get("Rack") ?? [];
  for (const c of containers) {
    if (c.level === "floor") continue;
    const halfW = c.w / 2;
    const halfD = c.d / 2;
    const ids: string[] = [];
    for (const r of rk) {
      if (
        Math.abs(r.x - c.cx) < halfW + 0.1 &&
        Math.abs(r.y - c.cz) < halfD + 0.1
      )
        ids.push(r.id);
    }
    m.set(`${c.level}:${c.id}`, ids);
  }
  return m;
})();

/** containers grouped by level — original `km`. */
export const containersByLevel = {
  floor: containers.filter((c) => c.level === "floor"),
  room: containers.filter((c) => c.level === "room"),
  zone: containers.filter((c) => c.level === "zone"),
  row: containers.filter((c) => c.level === "row"),
} as const;
