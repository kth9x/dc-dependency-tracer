// ── Domain types (recovered from the original bundle) ─────────────────

export type System = "electrical" | "cooling" | "spatial" | "whitespace";
export type Shape = "rack" | "equipment" | "san";
export type Topology = "upstream" | "local" | "downstream" | "load";

export interface DcNode {
  id: string;
  label: string;
  nodeType: string;
  system: System;
  shape: Shape;
  x: number;
  y: number; // floor-plan Y == world Z
  w?: number;
  h?: number;
  traceOnly?: boolean; // participates in tracing but only renders when relevant
}

export type ContainerLevel = "floor" | "room" | "zone" | "row";
export interface Container {
  id: string;
  label: string;
  level: ContainerLevel;
  cx: number;
  cz: number;
  w: number;
  d: number;
}

export interface Rule {
  sourceType: string;
  targetType: string;
  topology: Topology;
  level: number | null;
}

export interface Edge {
  id: string;
  fromId: string;
  toId: string;
  topology: Topology;
  system: System;
  level: number | null;
  /** For aggregated load edges: how many racks this single edge stands in for. */
  count?: number;
  /** True when toId is a container (Row/Zone/Room) aggregate, not a node. */
  aggregate?: boolean;
}

export type LoadScope =
  | "Rack"
  | "Row"
  | "Zone"
  | "Capacity Cell"
  | "Room Bundle"
  | "Room PDU Bundle"
  | "UPS Bundle";

export interface TraceSettings {
  trace: { dependency: boolean; impact: boolean };
  dependency: { upstream: boolean; local: boolean; upstreamLevels: number };
  impact: {
    downstream: boolean;
    load: boolean;
    downstreamLevels: number;
    loadScope: LoadScope;
  };
  showLines: boolean;
}
