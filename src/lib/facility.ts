// ── Faithful facility generator ───────────────────────────────────────
// Produces ONE believable data center as an instance-level topology:
// real A/B power trains (2N), dual-corded racks, a generator backup, and
// N+1 cooling pools — with per-node kW and tenants.
//
// White space: each zone keeps an EMPTY expansion row (racks with loadKw=0)
// and the power/cooling chain is sized for FULL build-out, so there is genuine
// free capacity to plan into. A rack's `capacityKw` is its power *budget*;
// `loadKw` is the current draw (0 = empty/free).
//
// Planted faults give the engines ground truth to test:
//   • one single-corded row       → 2N violation + a real SPOF
//   • one fully-built, under-cooled zone (N CDUs, no +1 at full load)
//   • a single cooling plant       → facility-wide SPOF
//
// Densities + the capacity-value rate are reused verbatim from dc-bp-redesign
// (js/data.js) so this is the instance-level realization of DC-BP's specs.

import type { Container, DcNode, Link } from "./types";

/** $/kW·yr captured-capacity value — single source for every $ figure (dc-bp). */
export const RATE_PER_KW = 1730;
/** Realistic rack densities (dc-bp js/data.js). */
export const KW = { GPU: 96, Storage: 24, Network: 12 } as const;

export interface Facility {
  nodes: DcNode[];
  links: Link[];
  containers: Container[];
}

// ── Layout ──
const RACKS_PER_ROW = 10;
const ROWS_PER_ZONE = 3;
const RACKS_PER_ZONE = RACKS_PER_ROW * ROWS_PER_ZONE; // 30
const RACK_DX = 0.7;
const ROW_DZ = 1.7;
const ZONE_GAP_X = 3;
const ZONE_GAP_Z = 3;
const ZONE_W = RACKS_PER_ROW * RACK_DX; // 7
const ZONE_D = ROWS_PER_ZONE * ROW_DZ; // 5.1
const EXPANSION_ROW = 1; // the GPU row left empty (white space) in partial zones

const TENANTS = ["Frontier", "Atlas", "Orion", "Vega", "Nova", "Lyra"];

/** Density profile for a row within a zone (GPU compute + a low-power network row). */
function rowProfile(rowIdx: number): { role: string; kw: number } {
  if (rowIdx % 3 === 2) return { role: "Network", kw: KW.Network };
  return { role: "Compute", kw: KW.GPU };
}

/**
 * Generate the facility. `targetRacks` controls scale (rounds up to whole zones).
 */
export function genFacility(targetRacks = 120): Facility {
  const zones = Math.max(1, Math.ceil(targetRacks / RACKS_PER_ZONE));
  const zoneCols = Math.ceil(Math.sqrt(zones));

  const nodes: DcNode[] = [];
  const links: Link[] = [];
  const containers: Container[] = [];

  // Planted faults (kept distinct when there are ≥2 zones).
  const underCooledZone = Math.min(1, zones - 1); // fully built + only N CDUs (no +1)
  const singleCordedZone = zones - 1; // last zone
  const singleCordedRow = 0; // an OCCUPIED row → real blast radius
  const isFull = (z: number) => z === underCooledZone; // fully built (no expansion white space)
  const isOccupied = (z: number, r: number) => isFull(z) || r !== EXPANSION_ROW;

  let linkId = 0;
  const link = (fromId: string, toId: string, kind: Link["kind"], side?: "A" | "B") =>
    links.push({ id: `l${linkId++}`, fromId, toId, kind, side });
  const node = (n: DcNode) => {
    nodes.push(n);
    return n.id;
  };

  // Full build-out load (every rack occupied) — sizes the 2N power train + cooling.
  const fullZoneKw = (() => {
    let s = 0;
    for (let r = 0; r < ROWS_PER_ZONE; r++) s += rowProfile(r).kw * RACKS_PER_ROW;
    return s;
  })();
  const trainKw = Math.ceil(fullZoneKw * zones * 1.25); // each side carries 100% (+headroom)

  // ── Global power sources + 2N train heads (placed left of the floor) ──
  const sideX = -6;
  node({ id: "util-A", label: "Utility A", nodeType: "Utility Feed", system: "electrical", shape: "equipment", x: sideX, y: 0, side: "A", isSource: true, capacityKw: trainKw, tier: 0 });
  node({ id: "util-B", label: "Utility B", nodeType: "Utility Feed", system: "electrical", shape: "equipment", x: sideX, y: 3, side: "B", isSource: true, capacityKw: trainKw, tier: 0 });
  node({ id: "gen", label: "Generator", nodeType: "Generator", system: "electrical", shape: "equipment", x: sideX, y: 6, isSource: true, capacityKw: trainKw, tier: 0 });

  node({ id: "sg-A", label: "Switch Gear A", nodeType: "Switch Gear", system: "electrical", shape: "equipment", x: sideX + 1.2, y: 0, side: "A", capacityKw: trainKw, tier: 1 });
  node({ id: "sg-B", label: "Switch Gear B", nodeType: "Switch Gear", system: "electrical", shape: "equipment", x: sideX + 1.2, y: 3, side: "B", capacityKw: trainKw, tier: 1 });
  // Utility feeds its side; the generator backs up BOTH (combine "or" → alive if either source is alive).
  link("util-A", "sg-A", "power", "A");
  link("gen", "sg-A", "power", "A");
  link("util-B", "sg-B", "power", "B");
  link("gen", "sg-B", "power", "B");

  node({ id: "ups-A", label: "UPS A", nodeType: "UPS", system: "electrical", shape: "equipment", x: sideX + 2.4, y: 0, side: "A", capacityKw: trainKw, tier: 2 });
  node({ id: "ups-B", label: "UPS B", nodeType: "UPS", system: "electrical", shape: "equipment", x: sideX + 2.4, y: 3, side: "B", capacityKw: trainKw, tier: 2 });
  link("sg-A", "ups-A", "power", "A");
  link("sg-B", "ups-B", "power", "B");

  node({ id: "rpdu-A", label: "Room PDU A", nodeType: "Room PDU", system: "electrical", shape: "equipment", x: sideX + 3.6, y: 0, side: "A", capacityKw: trainKw, tier: 3 });
  node({ id: "rpdu-B", label: "Room PDU B", nodeType: "Room PDU", system: "electrical", shape: "equipment", x: sideX + 3.6, y: 3, side: "B", capacityKw: trainKw, tier: 3 });
  link("ups-A", "rpdu-A", "power", "A");
  link("ups-B", "rpdu-B", "power", "B");

  // ── Cooling source (single plant = planted facility-wide SPOF) ──
  node({ id: "cplant", label: "Cooling Plant", nodeType: "Cooling Plant", system: "cooling", shape: "equipment", x: sideX + 1.2, y: 6, isSource: true, capacityKw: trainKw, tier: 1 });

  const zoneFullKw = fullZoneKw; // per-zone full build-out load
  const perCduKw = Math.ceil(zoneFullKw / 3); // CDUs sized so any 3 carry a full zone

  // ── Per-zone power branch, cooling pool, and racks ──
  for (let z = 0; z < zones; z++) {
    const col = z % zoneCols;
    const zrow = Math.floor(z / zoneCols);
    const ox = col * (ZONE_W + ZONE_GAP_X);
    const oz = zrow * (ZONE_D + ZONE_GAP_Z);
    const tenant = TENANTS[z % TENANTS.length];

    // actual occupied cooling load in this zone (what the pool must serve now)
    let occCoolKw = 0;
    for (let r = 0; r < ROWS_PER_ZONE; r++)
      if (isOccupied(z, r)) occCoolKw += rowProfile(r).kw * RACKS_PER_ROW;

    // zone RPP per side, fed by the room PDUs — sized for full build-out.
    const rppA = `rpp-A-${z}`;
    const rppB = `rpp-B-${z}`;
    const rppKw = Math.ceil(zoneFullKw * 1.25);
    node({ id: rppA, label: `RPP A·Z${z + 1}`, nodeType: "RPP", system: "electrical", shape: "equipment", x: ox - 0.5, y: oz + ZONE_D / 2, side: "A", capacityKw: rppKw, tier: 4 });
    node({ id: rppB, label: `RPP B·Z${z + 1}`, nodeType: "RPP", system: "electrical", shape: "equipment", x: ox + ZONE_W + 0.5, y: oz + ZONE_D / 2, side: "B", capacityKw: rppKw, tier: 4 });
    link("rpdu-A", rppA, "power", "A");
    link("rpdu-B", rppB, "power", "B");

    // zone cooling pool: N+1 normally (4 CDUs); the under-cooled zone gets only 3.
    const members = z === underCooledZone ? 3 : 4;
    const poolId = `cpool-${z}`;
    for (let m = 0; m < members; m++) {
      const cduId = `cdu-${z}-${m}`;
      node({ id: cduId, label: `CDU Z${z + 1}·${m + 1}`, nodeType: "CDU", system: "cooling", shape: "equipment", x: ox + (m + 0.5) * (ZONE_W / members), y: oz + ZONE_D + 0.6, capacityKw: perCduKw, tier: 5 });
      link("cplant", cduId, "cooling");
      link(cduId, poolId, "cooling");
    }
    // virtual pool aggregator (engine-only; not rendered). loadKw = current occupied cooling.
    node({ id: poolId, label: `Cooling Z${z + 1}`, nodeType: "Cooling Pool", system: "cooling", shape: "equipment", x: ox + ZONE_W / 2, y: oz + ZONE_D / 2, combine: "n+1", loadKw: occCoolKw, capacityKw: perCduKw * members, virtual: true, tier: 6 });

    // racks
    for (let r = 0; r < ROWS_PER_ZONE; r++) {
      const { kw } = rowProfile(r);
      const occ = isOccupied(z, r);
      const rowSingleCorded = z === singleCordedZone && r === singleCordedRow;
      const rowId = `row-${z}-${r}`;
      containers.push({ id: rowId, label: `Row ${String.fromCharCode(65 + r)}·Z${z + 1}`, level: "row", cx: ox + ZONE_W / 2, cz: oz + (r + 0.5) * ROW_DZ, w: ZONE_W, d: ROW_DZ * 0.8 });
      for (let c = 0; c < RACKS_PER_ROW; c++) {
        const id = `rk-${z}-${r}-${c}`;
        node({
          id,
          label: `R${z + 1}-${String.fromCharCode(65 + r)}${c + 1}`,
          nodeType: "Rack",
          system: "spatial",
          shape: "rack",
          x: ox + (c + 0.5) * RACK_DX,
          y: oz + (r + 0.5) * ROW_DZ,
          loadKw: occ ? kw : 0, // 0 = empty / available white space
          capacityKw: kw, // the rack's power budget when filled
          tenant: occ ? tenant : undefined,
          tier: 7,
        });
        // power cords: A always; B unless this is the planted single-corded row
        link(rppA, id, "power", "A");
        if (!rowSingleCorded) link(rppB, id, "power", "B");
        // cooling from the zone pool
        link(poolId, id, "cooling");
      }
    }

    // zone container
    containers.push({ id: `zone-${z}`, label: `Zone ${z + 1} · ${tenant}`, level: "zone", cx: ox + ZONE_W / 2, cz: oz + ZONE_D / 2, w: ZONE_W + 1.4, d: ZONE_D + 1.4 });
  }

  // floor container spanning everything
  const maxCol = Math.min(zones, zoneCols);
  const maxRow = Math.ceil(zones / zoneCols);
  const floorW = maxCol * (ZONE_W + ZONE_GAP_X) + 6;
  const floorD = maxRow * (ZONE_D + ZONE_GAP_Z);
  containers.push({ id: "floor-1", label: "Floor 1", level: "floor", cx: floorW / 2 - 3, cz: floorD / 2 - ZONE_GAP_Z / 2, w: floorW + 8, d: floorD + 4 });

  return { nodes, links, containers };
}
