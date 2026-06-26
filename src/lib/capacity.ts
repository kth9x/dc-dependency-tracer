// ── Free-capacity model (whitespace-planning foundation) ──────────────
// Turns the live supply graph into per-supply-block free/committed/stranded
// numbers. A "supply block" = the racks sharing an A-side RPP — which, in this
// facility, IS a Capacity Cell (each zone owns its A/B RPP + cooling pool).
// Pure + unit-tested; consumed by placement.ts and the capacity overlay.

import type { DcNode, Link } from "./types";
import type { Ctx } from "./engine";

export interface SideCapacity {
  capacityKw: number;
  committedKw: number;
  freeKw: number;
}
export interface BlockCapacity {
  id: string; // = the A-side RPP id (the block / Capacity Cell key)
  label: string; // e.g. "Zone 4"
  rppA: string;
  rppB: string | null;
  poolId: string | null;
  racks: string[];
  freeRacks: string[]; // empty (placeable) rack ids
  occupiedCount: number;
  freeRackBudgetKw: number; // Σ free racks' power budget
  powerA: SideCapacity;
  powerB: SideCapacity | null; // null only if the block has no B side at all
  cooling: SideCapacity & { spareKw: number }; // free already keeps the N+1 spare
  dualCorded: boolean; // free racks have both A and B cords → placement can be 2N
  strandedKw: number; // free power that can't deploy (cooling/space binds first)
}
export interface CapacityModel {
  blocks: BlockCapacity[];
  byRack: Map<string, string>; // rackId → blockId
  totals: { freeRacks: number; freePowerKw: number; freeCoolingKw: number; strandedKw: number };
}

const feedersOf = (ctx: Ctx, id: string): Link[] => ctx.feeders.get(id) ?? [];
const powerFeed = (ctx: Ctx, rackId: string, side: "A" | "B"): string | null =>
  feedersOf(ctx, rackId).find((x) => x.kind === "power" && x.side === side)?.fromId ?? null;
const coolingFeed = (ctx: Ctx, rackId: string): string | null =>
  feedersOf(ctx, rackId).find((x) => x.kind === "cooling")?.fromId ?? null;

/** "rpp-A-3" → "Zone 4". */
function blockLabel(rppA: string): string {
  const m = /-(\d+)$/.exec(rppA);
  return m ? `Zone ${Number(m[1]) + 1}` : rppA;
}

export function computeCapacity(ctx: Ctx, reserved?: Map<string, number>): CapacityModel {
  // Effective load per rack — reservations overlay the baseline occupancy so
  // free capacity shrinks live as workloads are reserved.
  const load = (r: DcNode) => reserved?.get(r.id) ?? r.loadKw ?? 0;
  // Group racks into supply blocks keyed by their A-side RPP.
  const groups = new Map<string, DcNode[]>();
  for (const r of ctx.racks) {
    const a = powerFeed(ctx, r.id, "A");
    if (!a) continue;
    const arr = groups.get(a);
    if (arr) arr.push(r);
    else groups.set(a, [r]);
  }

  const blocks: BlockCapacity[] = [];
  const byRack = new Map<string, string>();

  for (const [rppA, racks] of groups) {
    // B-side RPP = the one feeding any dual-corded rack in the block.
    const rppB = racks.map((r) => powerFeed(ctx, r.id, "B")).find((x) => x != null) ?? null;
    const poolId = coolingFeed(ctx, racks[0].id);
    const occupied = racks.filter((r) => load(r) > 0);
    const freeRacks = racks.filter((r) => load(r) === 0);

    // Power: side A carries every occupied rack (2N → each side sized for 100%);
    // side B carries only dual-corded occupied racks.
    const committedA = occupied.reduce((s, r) => s + load(r), 0);
    const committedB = occupied
      .filter((r) => powerFeed(ctx, r.id, "B") != null)
      .reduce((s, r) => s + load(r), 0);
    const capA = ctx.byId.get(rppA)?.capacityKw ?? 0;
    const capB = rppB ? ctx.byId.get(rppB)?.capacityKw ?? 0 : 0;
    const powerA: SideCapacity = { capacityKw: capA, committedKw: committedA, freeKw: Math.max(0, capA - committedA) };
    const powerB: SideCapacity | null = rppB
      ? { capacityKw: capB, committedKw: committedB, freeKw: Math.max(0, capB - committedB) }
      : null;

    // Cooling: usable capacity keeps the N+1 spare (lose the smallest member, still meet load).
    const pool = poolId ? ctx.byId.get(poolId) : undefined;
    const memberCap = (poolId ? feedersOf(ctx, poolId) : [])
      .filter((l) => l.kind === "cooling")
      .map((l) => ctx.byId.get(l.fromId)?.capacityKw ?? 0);
    const totalCool = memberCap.reduce((a, b) => a + b, 0);
    const minMember = memberCap.length ? Math.min(...memberCap) : 0;
    const usableCool = Math.max(0, totalCool - minMember); // keep one spare → N+1
    // Reservations target free racks (not in pool.loadKw baseline), so add them.
    const reservedCoolKw = reserved ? racks.reduce((s, r) => s + (reserved.get(r.id) ?? 0), 0) : 0;
    const committedCool = (pool?.loadKw ?? 0) + reservedCoolKw;
    const cooling = {
      capacityKw: usableCool,
      committedKw: committedCool,
      freeKw: Math.max(0, usableCool - committedCool),
      spareKw: minMember,
    };

    const freeRackBudgetKw = freeRacks.reduce((s, r) => s + (r.capacityKw ?? 0), 0);
    const dualCorded = freeRacks.length > 0 && freeRacks.every((r) => powerFeed(ctx, r.id, "B") != null);

    // Stranded: free 2N power you can't deploy because cooling or rack space runs out first.
    const freePower2N = powerB ? Math.min(powerA.freeKw, powerB.freeKw) : powerA.freeKw;
    const deployable = Math.min(freePower2N, cooling.freeKw, freeRackBudgetKw);
    const strandedKw = Math.max(0, freePower2N - deployable);

    for (const r of racks) byRack.set(r.id, rppA);
    blocks.push({
      id: rppA,
      label: blockLabel(rppA),
      rppA,
      rppB,
      poolId,
      racks: racks.map((r) => r.id),
      freeRacks: freeRacks.map((r) => r.id),
      occupiedCount: occupied.length,
      freeRackBudgetKw,
      powerA,
      powerB,
      cooling,
      dualCorded,
      strandedKw,
    });
  }

  blocks.sort((a, b) => a.id.localeCompare(b.id));
  const totals = blocks.reduce(
    (t, b) => {
      t.freeRacks += b.freeRacks.length;
      t.freePowerKw += b.powerB ? Math.min(b.powerA.freeKw, b.powerB.freeKw) : b.powerA.freeKw;
      t.freeCoolingKw += b.cooling.freeKw;
      t.strandedKw += b.strandedKw;
      return t;
    },
    { freeRacks: 0, freePowerKw: 0, freeCoolingKw: 0, strandedKw: 0 },
  );
  return { blocks, byRack, totals };
}
