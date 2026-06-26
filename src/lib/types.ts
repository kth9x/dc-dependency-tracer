// ── Domain types (recovered from the original bundle) ─────────────────

export type System = "electrical" | "cooling" | "spatial" | "whitespace";
export type Shape = "rack" | "equipment" | "san";
export type Topology = "upstream" | "local" | "downstream" | "load";

/** What a link carries — the two independent supply systems we model. */
export type ResourceKind = "power" | "cooling";

/** How a node's incoming feeds (of one kind) combine to keep it alive. */
export type Combine =
  | "or" // path redundancy: alive if ANY feeder of that kind is alive (2N / single-feeder series)
  | "n+1"; // capacity pool: alive if Σ(alive feeder capacityKw) ≥ this node's loadKw

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

  // ── Reliability model (instance-level power/cooling) ──
  /** Supply/throughput rating (sources, distribution, pools). */
  capacityKw?: number;
  /** Demand drawn by a load (racks) or aggregate served by a pool node. */
  loadKw?: number;
  /** Power train this node belongs to (2N A/B). */
  side?: "A" | "B";
  /** Electrical/cooling tier, for ordering + reports. */
  tier?: number;
  /** Tenant a rack belongs to (for "tenants affected"). */
  tenant?: string;
  /** How incoming feeds combine to keep this node alive (default "or"). */
  combine?: Combine;
  /** True for utility/generator/cooling-plant — energized whenever not failed. */
  isSource?: boolean;
  /** Engine-only node (pools/aggregators) — not rendered in the 3D scene. */
  virtual?: boolean;
}

/**
 * A real instance-level supply link: `fromId` (the feeder/upstream) supplies
 * `toId` (the consumer/downstream). The blast-radius engine traverses these,
 * NOT the abstract type→type rules.
 */
export interface Link {
  id: string;
  fromId: string;
  toId: string;
  kind: ResourceKind;
  side?: "A" | "B";
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
