// ── Redundancy-aware blast-radius engine ──────────────────────────────
// Traverses the INSTANCE-level supply graph (links), not the abstract
// type→type rules, so failure impact is computed truthfully:
//   • a node is "up" only if, for EACH resource kind it consumes, its feeds
//     are satisfied — feeds of one kind combine by OR (2N path redundancy:
//     alive if any feeder is alive) or by N+1 (a capacity pool: alive if the
//     surviving members' capacity ≥ the pooled load); kinds combine by AND
//     (a rack needs BOTH power AND cooling).
//   • redundancy ("at-risk") = up, but a single further failure would drop it.
//
// From these primitives: simulateFailure, findSPOFs, validateRedundancy.

import type { DcNode, Link, ResourceKind } from "./types";
import type { Facility } from "./facility";

export interface SimResult {
  failed: string[];
  /** Racks that lost ALL supply of some kind → offline. */
  dropped: string[];
  /** Racks still up, but no longer redundant (one more failure would drop them). */
  atRisk: string[];
  /** Every node (incl. infra) that is de-energized — for path/segment coloring. */
  down: string[];
  kwLost: number;
  tenants: string[];
}

export interface Spof {
  id: string;
  label: string;
  nodeType: string;
  kwLost: number;
  racksDropped: number;
}

export interface Violation {
  category: "power-2N" | "cooling-N+1" | "generator";
  scope: string;
  detail: string;
  racks?: number;
  kw?: number;
}

export interface Ctx {
  byId: Map<string, DcNode>;
  /** consumer id → incoming supply links. */
  feeders: Map<string, Link[]>;
  racks: DcNode[];
  nodes: DcNode[];
}

export function buildContext(f: Facility): Ctx {
  const byId = new Map<string, DcNode>();
  for (const n of f.nodes) byId.set(n.id, n);
  const feeders = new Map<string, Link[]>();
  for (const l of f.links) {
    const arr = feeders.get(l.toId);
    if (arr) arr.push(l);
    else feeders.set(l.toId, [l]);
  }
  return { byId, feeders, racks: f.nodes.filter((n) => n.shape === "rack"), nodes: f.nodes };
}

/** Memoized "is this node energized" given a set of failed nodes. */
function evaluate(ctx: Ctx, failed: Set<string>) {
  const up = new Map<string, boolean>();
  const visiting = new Set<string>();

  const isUp = (id: string): boolean => {
    const cached = up.get(id);
    if (cached !== undefined) return cached;
    const node = ctx.byId.get(id);
    if (!node || failed.has(id)) {
      up.set(id, false);
      return false;
    }
    const feeders = ctx.feeders.get(id) ?? [];
    if (feeders.length === 0) {
      // No upstream supply: only true sources (utility/generator/plant) are live.
      const r = node.isSource === true;
      up.set(id, r);
      return r;
    }
    if (visiting.has(id)) return false; // cycle guard (graph is a DAG)
    visiting.add(id);

    const byKind = new Map<ResourceKind, Link[]>();
    for (const l of feeders) {
      const arr = byKind.get(l.kind);
      if (arr) arr.push(l);
      else byKind.set(l.kind, [l]);
    }
    let ok = true;
    for (const [, ls] of byKind) {
      const upFeeders = ls.filter((l) => isUp(l.fromId));
      if (node.combine === "n+1") {
        const cap = upFeeders.reduce((s, l) => s + (ctx.byId.get(l.fromId)?.capacityKw ?? 0), 0);
        if (!(upFeeders.length > 0 && cap >= (node.loadKw ?? 0))) {
          ok = false;
          break;
        }
      } else if (upFeeders.length === 0) {
        ok = false;
        break;
      }
    }
    visiting.delete(id);
    up.set(id, ok);
    return ok;
  };

  for (const n of ctx.nodes) isUp(n.id);
  return isUp;
}

/** Alive member capacity of an N+1 pool node. */
function poolAliveCap(ctx: Ctx, isUp: (id: string) => boolean, poolId: string): number {
  return (ctx.feeders.get(poolId) ?? [])
    .filter((l) => l.kind === "cooling" && isUp(l.fromId))
    .reduce((s, l) => s + (ctx.byId.get(l.fromId)?.capacityKw ?? 0), 0);
}

/** A pool has a spare iff it would still meet load after losing its smallest alive member. */
function poolHasSpare(ctx: Ctx, isUp: (id: string) => boolean, poolId: string): boolean {
  const caps = (ctx.feeders.get(poolId) ?? [])
    .filter((l) => l.kind === "cooling" && isUp(l.fromId))
    .map((l) => ctx.byId.get(l.fromId)?.capacityKw ?? 0);
  if (!caps.length) return false;
  const aliveCap = caps.reduce((a, b) => a + b, 0);
  const minMember = Math.min(...caps);
  const load = ctx.byId.get(poolId)?.loadKw ?? 0;
  return aliveCap - minMember >= load;
}

function rackStatus(ctx: Ctx, isUp: (id: string) => boolean, rack: DcNode) {
  const feeders = ctx.feeders.get(rack.id) ?? [];
  const powerUp = feeders.filter((l) => l.kind === "power" && isUp(l.fromId)).length;
  const coolFeeders = feeders.filter((l) => l.kind === "cooling");
  const pool = coolFeeders.find((l) => ctx.byId.get(l.fromId)?.combine === "n+1");
  const coolRedundant = pool
    ? isUp(pool.fromId) && poolHasSpare(ctx, isUp, pool.fromId)
    : coolFeeders.filter((l) => isUp(l.fromId)).length >= 2;
  return { up: isUp(rack.id), powerRedundant: powerUp >= 2, coolRedundant };
}

/** Blast radius of failing `failedIds` (one or many nodes simultaneously). */
export function simulateFailure(ctx: Ctx, failedIds: string[]): SimResult {
  const failed = new Set(failedIds);
  const isUp = evaluate(ctx, failed);
  const dropped: string[] = [];
  const atRisk: string[] = [];
  const down: string[] = [];
  const tenants = new Set<string>();
  let kwLost = 0;
  for (const n of ctx.nodes) if (!isUp(n.id)) down.push(n.id);
  for (const rk of ctx.racks) {
    const s = rackStatus(ctx, isUp, rk);
    if (!s.up) {
      dropped.push(rk.id);
      kwLost += rk.loadKw ?? 0;
      if (rk.tenant) tenants.add(rk.tenant);
    } else if (!(s.powerRedundant && s.coolRedundant)) {
      atRisk.push(rk.id);
    }
  }
  return { failed: [...failed], dropped, atRisk, down, kwLost, tenants: [...tenants] };
}

/** Every node whose sole failure drops ≥1 rack, ranked by kW at risk. */
export function findSPOFs(ctx: Ctx): Spof[] {
  const out: Spof[] = [];
  for (const n of ctx.nodes) {
    if (n.shape === "rack" || n.virtual) continue; // racks are trivially their own SPOF; pools are virtual
    const r = simulateFailure(ctx, [n.id]);
    if (r.dropped.length > 0)
      out.push({ id: n.id, label: n.label, nodeType: n.nodeType, kwLost: r.kwLost, racksDropped: r.dropped.length });
  }
  out.sort((a, b) => b.kwLost - a.kwLost);
  return out;
}

/** All upstream supply links feeding `nodeId` (its A/B power trains + cooling
 *  tree, up to the sources) — for drawing redundancy paths on hover. Bounded. */
export function supplyLinks(ctx: Ctx, nodeId: string): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    for (const l of ctx.feeders.get(id) ?? []) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
      walk(l.fromId);
    }
  };
  walk(nodeId);
  return out;
}

function rowKey(id: string): string {
  const m = /^rk-(\d+)-(\d+)-\d+$/.exec(id);
  if (!m) return "Unknown row";
  return `Zone ${Number(m[1]) + 1} · Row ${String.fromCharCode(65 + Number(m[2]))}`;
}

/** Declared-vs-actual redundancy audit at baseline (nothing failed). */
export function validateRedundancy(ctx: Ctx): Violation[] {
  const isUp = evaluate(ctx, new Set());
  const violations: Violation[] = [];

  // Power 2N — racks with fewer than 2 power cords.
  const byRow = new Map<string, { racks: number; kw: number }>();
  for (const rk of ctx.racks) {
    const cords = (ctx.feeders.get(rk.id) ?? []).filter((l) => l.kind === "power").length;
    if (cords < 2) {
      const k = rowKey(rk.id);
      const e = byRow.get(k) ?? { racks: 0, kw: 0 };
      e.racks++;
      e.kw += rk.loadKw ?? 0;
      byRow.set(k, e);
    }
  }
  for (const [scope, e] of byRow)
    violations.push({ category: "power-2N", scope, detail: `${e.racks} racks single-corded (no B feed)`, racks: e.racks, kw: e.kw });

  // Cooling N+1 — pools without a spare.
  for (const n of ctx.nodes) {
    if (n.combine !== "n+1") continue;
    if (!poolHasSpare(ctx, isUp, n.id)) {
      const cap = Math.round(poolAliveCap(ctx, isUp, n.id));
      violations.push({ category: "cooling-N+1", scope: n.label, detail: `no spare — ${cap} kW capacity vs ${Math.round(n.loadKw ?? 0)} kW load`, kw: n.loadKw });
    }
  }

  // Generator backup — switchgear lineups without a generator feeder.
  for (const n of ctx.nodes) {
    if (n.nodeType !== "Switch Gear") continue;
    const hasGen = (ctx.feeders.get(n.id) ?? []).some((l) => ctx.byId.get(l.fromId)?.nodeType === "Generator");
    if (!hasGen) violations.push({ category: "generator", scope: n.label, detail: "no generator backup" });
  }

  return violations;
}
