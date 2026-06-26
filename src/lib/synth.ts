// ── Synthetic scale generator (dev/benchmark only) ────────────────────
// Tiles the real ~120-rack dataset into a grid until it reaches the target
// rack count, so the whole structure (rooms, zones, rules-by-type, the 1:1
// cooling appendages) scales realistically. Activated via ?synth=N.

import type { Container, DcNode } from "./types";
import nodesData from "../data/nodes.json";
import containersData from "../data/containers.json";

const baseNodes = nodesData as DcNode[];
const baseContainers = containersData as Container[];

export function genSynthetic(targetRacks: number): {
  nodes: DcNode[];
  containers: Container[];
} {
  const baseRacks = baseNodes.filter((n) => n.shape === "rack").length || 1;
  const tiles = Math.max(1, Math.ceil(targetRacks / baseRacks));
  const cols = Math.ceil(Math.sqrt(tiles));

  // Footprint of one tile (+ margin) so copies don't overlap.
  const xs = baseNodes.map((n) => n.x);
  const ys = baseNodes.map((n) => n.y);
  const tileW = Math.max(...xs) - Math.min(...xs) + 6;
  const tileD = Math.max(...ys) - Math.min(...ys) + 6;

  const nodes: DcNode[] = [];
  const containers: Container[] = [];
  for (let k = 0; k < tiles; k++) {
    const dx = (k % cols) * tileW;
    const dz = Math.floor(k / cols) * tileD;
    for (const n of baseNodes)
      nodes.push({ ...n, id: `${n.id}#${k}`, x: n.x + dx, y: n.y + dz });
    for (const c of baseContainers)
      containers.push({ ...c, id: `${c.id}#${k}`, cx: c.cx + dx, cz: c.cz + dz });
  }
  return { nodes, containers };
}

/** Parse ?synth=N from the URL; returns null when absent/invalid. */
export function synthTarget(): number | null {
  if (typeof location === "undefined") return null;
  const m = location.search.match(/[?&]synth=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Rack-count presets for the dev performance menu (`null` = real dataset). */
export const SYNTH_PRESETS: { label: string; value: number | null }[] = [
  { label: "Real", value: null },
  { label: "100", value: 100 },
  { label: "500", value: 500 },
  { label: "1K", value: 1000 },
  { label: "2K", value: 2000 },
  { label: "5K", value: 5000 },
];

/**
 * Switch the simulated rack count: rewrite `?synth=N` and reload. The graph
 * (and all instanced geometry) is built once at module load, so a reload gives
 * a clean, uncontaminated measurement instead of a half-rebuilt scene.
 */
export function setSynthTarget(target: number | null): void {
  if (typeof location === "undefined") return;
  const url = new URL(location.href);
  if (target == null) url.searchParams.delete("synth");
  else url.searchParams.set("synth", String(target));
  // Keep the hash (deep-linked trace) intact across the reload.
  location.assign(url.toString());
}
