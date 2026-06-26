// ── Placement search tests ────────────────────────────────────────────
// Run: npx esbuild src/lib/placement.test.ts --bundle --platform=node \
//        --outfile=tmp.p.mjs && node tmp.p.mjs

import { genFacility } from "./facility";
import { buildContext } from "./engine";
import { computeCapacity } from "./capacity";
import { findPlacements, DEMAND_PRESETS } from "./placement";
import type { Demand } from "./types";

let failures = 0;
const ok = (c: boolean, m: string, extra?: unknown) => {
  if (c) console.log(`  ✓ ${m}`);
  else {
    failures++;
    console.log(`  ✗ ${m}`, extra ?? "");
  }
};

const ctx = buildContext(genFacility(120));
const cap = computeCapacity(ctx);
const gpu10 = DEMAND_PRESETS.find((d) => d.id === "gpu10")!;
const gpu25 = DEMAND_PRESETS.find((d) => d.id === "gpu25")!;
const gpu15: Demand = { id: "gpu15", label: "GPU · 15 · 2N", roles: [{ role: "Compute", type: "GPU", count: 15, perRackKw: 96 }], powerRedundancy: "2N", coolingRedundancy: "N+1" };

console.log("\n10-rack GPU 2N demand:");
const c10 = findPlacements(ctx, cap, gpu10);
console.log(`  ranked: ${c10.map((c) => `${c.label}${c.fit ? "" : "✗"}(${c.score.toFixed(2)})`).join(", ")}`);
ok(c10[0].fit && c10[0].riskOk, "top candidate fits and is risk-OK", c10[0]);
ok(["rpp-A-0", "rpp-A-2"].includes(c10[0].blockId), "top candidate is a healthy zone", c10[0].blockId);
const z3 = c10.find((c) => c.blockId === "rpp-A-3")!;
ok(z3.fit && !z3.riskOk, "single-corded zone fits but is flagged risky", z3);
const z1 = c10.find((c) => c.blockId === "rpp-A-1")!;
ok(!z1.fit, "under-cooled full zone does not fit", z1?.reasons);
const iHealthy = c10.findIndex((c) => ["rpp-A-0", "rpp-A-2"].includes(c.blockId));
const iZ3 = c10.findIndex((c) => c.blockId === "rpp-A-3");
const iZ1 = c10.findIndex((c) => c.blockId === "rpp-A-1");
ok(iHealthy < iZ3 && iZ3 < iZ1, "ranked healthy > single-corded > under-cooled", { iHealthy, iZ3, iZ1 });

console.log("\n15-rack GPU 2N demand (bigger than one zone):");
const c15 = findPlacements(ctx, cap, gpu15);
ok(c15[0].blockId === "" && c15[0].fit, "multi-zone candidate on top", c15[0]?.label);
ok(c15[0].rackIds.length === 15, "multi-zone reserves exactly 15 racks", c15[0]?.rackIds.length);

console.log("\n25-rack GPU 2N demand (exceeds healthy capacity):");
const c25 = findPlacements(ctx, cap, gpu25);
ok(!c25.some((c) => c.fit), "no fit — not enough redundant capacity", c25.filter((c) => c.fit).map((c) => c.label));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
const proc = (globalThis as { process?: { exitCode?: number } }).process;
if (proc) proc.exitCode = failures === 0 ? 0 : 1;
