// ── Risk-aware placement search ───────────────────────────────────────
// Given a demand (a workload to place) and the free-capacity model, screen
// every supply block PASS/FAIL on space / power / cooling / redundancy, then
// rank by a simplified score: fit + capacity-preserved + a RISK delta from the
// reliability engine (don't recommend a zone that already has a 2N/N+1 gap).
// Pure + unit-tested; consumed by the Plan-mode UI.

import type { Ctx } from "./engine";
import type { BlockCapacity, CapacityModel } from "./capacity";
import type { Demand } from "./types";

export interface Candidate {
  blockId: string; // "" for a multi-zone candidate
  label: string;
  fit: boolean;
  score: number; // 0..1, higher is better
  rackIds: string[]; // proposed free racks to fill
  usesRacks: number;
  reasons: string[]; // PASS/FAIL detail
  riskOk: boolean;
  riskNote: string;
  capacityPreservedPct: number;
}

function demandTotals(d: Demand) {
  let racks = 0;
  let kw = 0;
  let maxPerRackKw = 0;
  for (const r of d.roles) {
    racks += r.count;
    kw += r.count * r.perRackKw;
    maxPerRackKw = Math.max(maxPerRackKw, r.perRackKw);
  }
  return { racks, kw, maxPerRackKw };
}

/** Racks in a block that are empty AND have enough budget for the densest role. */
function usableFree(ctx: Ctx, block: BlockCapacity, maxPerRackKw: number): string[] {
  return block.freeRacks.filter((id) => (ctx.byId.get(id)?.capacityKw ?? 0) >= maxPerRackKw);
}

function existingPowerFault(ctx: Ctx, block: BlockCapacity): boolean {
  return block.racks.some((id) => {
    const n = ctx.byId.get(id);
    if (!n || (n.loadKw ?? 0) === 0) return false; // only occupied racks count
    return (ctx.feeders.get(id) ?? []).filter((l) => l.kind === "power").length < 2;
  });
}

function scoreBlock(ctx: Ctx, block: BlockCapacity, d: Demand) {
  const { racks, kw, maxPerRackKw } = demandTotals(d);
  const usable = usableFree(ctx, block, maxPerRackKw);
  const reasons: string[] = [];

  const spaceOk = usable.length >= racks;
  reasons.push(`${usable.length} free rack${usable.length === 1 ? "" : "s"} (need ${racks})`);

  const freeA = block.powerA.freeKw;
  const freeB = block.powerB?.freeKw ?? 0;
  const powerOk =
    d.powerRedundancy === "2N"
      ? block.dualCorded && block.powerB != null && freeA >= kw && freeB >= kw
      : freeA >= kw;
  reasons.push(
    `power ${d.powerRedundancy}: A ${Math.round(freeA)}${block.powerB ? ` / B ${Math.round(freeB)}` : ""} kW free (need ${kw})`,
  );

  const coolFree = block.cooling.freeKw + (d.coolingRedundancy === "N" ? block.cooling.spareKw : 0);
  const coolOk = coolFree >= kw;
  reasons.push(`cooling ${d.coolingRedundancy}: ${Math.round(coolFree)} kW free (need ${kw})`);

  const fit = spaceOk && powerOk && coolOk;

  const powerFault = existingPowerFault(ctx, block);
  const coolingFault = block.cooling.committedKw > block.cooling.capacityKw; // over its N+1 usable
  const riskOk = !powerFault && !coolingFault;
  const riskNote = powerFault
    ? "zone has a single-corded row (2N gap)"
    : coolingFault
      ? "zone cooling is already over N+1"
      : d.powerRedundancy === "2N"
        ? "keeps 2N + N+1"
        : "keeps N+1";

  // Best-fit: filling a zone more tightly preserves larger blocks for bigger future demands.
  const tightness = usable.length > 0 ? Math.min(1, racks / usable.length) : 0;
  const score = fit ? (riskOk ? 0.7 : 0.35) + 0.3 * tightness : 0;
  const capacityPreservedPct = usable.length > 0 ? Math.round((1 - racks / usable.length) * 100) : 0;

  return {
    blockId: block.id,
    label: block.label,
    fit,
    score,
    rackIds: usable.slice(0, racks),
    usesRacks: Math.min(racks, usable.length),
    reasons,
    riskOk,
    riskNote,
    capacityPreservedPct: Math.max(0, capacityPreservedPct),
  };
}

/** Rank candidate placements for a demand. Single-zone first; a greedy
 *  multi-zone option is appended when no single block can hold it. */
export function findPlacements(ctx: Ctx, cap: CapacityModel, demand: Demand): Candidate[] {
  const { racks, kw } = demandTotals(demand);
  const singles = cap.blocks.map((b) => scoreBlock(ctx, b, demand));
  singles.sort((a, b) => Number(b.fit) - Number(a.fit) || b.score - a.score);

  const anySingleFit = singles.some((c) => c.fit);
  if (!anySingleFit) {
    // Greedy multi-zone: fill the best risk-OK zones, capping each by what it
    // can actually hold (racks AND power AND cooling), until the demand is met.
    const perRack = racks > 0 ? kw / racks : 0;
    const rackIds: string[] = [];
    const zones: string[] = [];
    for (const c of [...singles].filter((s) => s.riskOk).sort((a, b) => b.score - a.score)) {
      if (rackIds.length >= racks) break;
      const block = cap.blocks.find((b) => b.id === c.blockId)!;
      const usable = usableFree(ctx, block, perRack);
      const power2N = block.powerB ? Math.min(block.powerA.freeKw, block.powerB.freeKw) : block.powerA.freeKw;
      const canHold = Math.min(
        usable.length,
        perRack > 0 ? Math.floor(power2N / perRack) : usable.length,
        perRack > 0 ? Math.floor(block.cooling.freeKw / perRack) : usable.length,
      );
      const take = usable.slice(0, Math.max(0, Math.min(canHold, racks - rackIds.length)));
      if (take.length) {
        rackIds.push(...take);
        zones.push(c.label);
      }
    }
    if (rackIds.length >= racks) {
      singles.unshift({
        blockId: "",
        label: `Multi-zone (${zones.join(" + ")})`,
        fit: true,
        score: 0.6,
        rackIds,
        usesRacks: rackIds.length,
        reasons: [`spans ${zones.length} zones to fit ${racks} racks / ${kw} kW`],
        riskOk: true,
        riskNote: "spread across healthy zones",
        capacityPreservedPct: 0,
      });
    }
  }
  return singles;
}

/** A few ready-made demands for the Plan-mode UI. */
export const DEMAND_PRESETS: Demand[] = [
  { id: "gpu10", label: "GPU cluster · 10 racks · 2N", roles: [{ role: "Compute", type: "GPU", count: 10, perRackKw: 96 }], powerRedundancy: "2N", coolingRedundancy: "N+1" },
  { id: "gpu5", label: "GPU pod · 5 racks · N+1", roles: [{ role: "Compute", type: "GPU", count: 5, perRackKw: 96 }], powerRedundancy: "N+1", coolingRedundancy: "N+1" },
  { id: "gpu25", label: "Large GPU · 25 racks · 2N", roles: [{ role: "Compute", type: "GPU", count: 25, perRackKw: 96 }], powerRedundancy: "2N", coolingRedundancy: "N+1" },
  { id: "sto8", label: "Storage pod · 8 racks · N+1", roles: [{ role: "Storage", type: "Storage", count: 8, perRackKw: 24 }], powerRedundancy: "N+1", coolingRedundancy: "N+1" },
];
