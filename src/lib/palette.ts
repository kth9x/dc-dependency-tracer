import type { System } from "./types";

/** 3D scene palette (original `Sa`). */
export const palette = {
  elec: "#EA580C",
  cool: "#2563EB",
  node: "#8B939E",
} as const;

/** system -> edge/accent color in the 3D scene (original `Gd`). */
export function colorForSystem(system: System): string {
  if (system === "electrical") return palette.elec;
  if (system === "cooling") return palette.cool;
  return "#94A3B8";
}

/** 2D legend colors + labels (original `cg`). */
export const legendColor: Record<System, string> = {
  electrical: "#E8714A",
  cooling: "#4A90D9",
  spatial: "#94A3B8",
  whitespace: "#94A3B8",
};
export const legendLabel: Record<System, string> = {
  electrical: "Electrical",
  cooling: "Cooling",
  spatial: "Load",
  whitespace: "Load",
};
