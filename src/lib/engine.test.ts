// ── Engine ground-truth tests ─────────────────────────────────────────
// Run: npx esbuild src/lib/engine.test.ts --bundle --platform=node \
//        --outfile=tmp.engine.mjs && node tmp.engine.mjs
// Asserts the blast-radius engine against the faults PLANTED by genFacility:
//   • single-corded row in the last zone (zone 3, row B) → RPP-A failure drops it
//   • under-provisioned cooling pool in zone 1 (3 CDUs, no spare)
//   • a single cooling plant (facility-wide SPOF)

import { genFacility, KW } from "./facility";
import { buildContext, simulateFailure, findSPOFs, validateRedundancy } from "./engine";

let failures = 0;
const ok = (cond: boolean, msg: string, extra?: unknown) => {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`, extra ?? "");
  }
};

// Default facility: 4 zones × 30 racks = 120; zone load = 2×(10·96 GPU) + 10·12 Network = 2040 kW.
const f = genFacility(120);
const ctx = buildContext(f);
const TOTAL_RACKS = ctx.racks.length;
const TOTAL_KW = ctx.racks.reduce((s, r) => s + (r.loadKw ?? 0), 0);
const ZONE_KW = 2 * 10 * KW.GPU + 10 * KW.Network; // 2040
const SINGLE_ROW_KW = 10 * KW.GPU; // 960 (row B of zone 3 is GPU)

console.log(`facility: ${f.nodes.length} nodes, ${f.links.length} links, ${TOTAL_RACKS} racks, ${TOTAL_KW} kW`);

console.log("\nbaseline (nothing failed):");
const base = simulateFailure(ctx, []);
ok(base.dropped.length === 0, "no racks dropped at baseline", base.dropped.length);
ok(base.atRisk.length > 0, "some racks at-risk at baseline (planted single-corded + under-cooled)", base.atRisk.length);

console.log("\nfail a 2N UPS (ups-B) — redundancy should absorb it:");
const ups = simulateFailure(ctx, ["ups-B"]);
ok(ups.dropped.length === 0, "0 racks dropped (A-side carries the load)", ups.dropped.length);
ok(ups.atRisk.length > 0, "racks flagged at-risk (now running on one side)", ups.atRisk.length);

console.log("\nfail the A-side UPS (ups-A) — the planted single-corded row has no B-feed, so it drops:");
const upsA = simulateFailure(ctx, ["ups-A"]);
ok(upsA.dropped.length === 10, "10 single-corded racks drop (truthful — they're A-only)", upsA.dropped.length);

console.log("\nfail the single-corded row's A-side RPP (rpp-A-3) — only that row drops:");
const rpp = simulateFailure(ctx, ["rpp-A-3"]);
ok(rpp.dropped.length === 10, "exactly 10 racks dropped (the single-corded row)", rpp.dropped.length);
ok(rpp.kwLost === SINGLE_ROW_KW, `kW lost = ${SINGLE_ROW_KW}`, rpp.kwLost);

console.log("\nfail the sole cooling plant (cplant) — whole floor loses cooling:");
const plant = simulateFailure(ctx, ["cplant"]);
ok(plant.dropped.length === TOTAL_RACKS, "every rack dropped", plant.dropped.length);
ok(plant.kwLost === TOTAL_KW, `kW lost = total (${TOTAL_KW})`, plant.kwLost);

console.log("\nfail one CDU in the under-provisioned zone (cdu-1-0) — that zone loses cooling:");
const cdu = simulateFailure(ctx, ["cdu-1-0"]);
ok(cdu.dropped.length === 30, "30 racks dropped (no spare in zone 1)", cdu.dropped.length);
ok(cdu.kwLost === ZONE_KW, `kW lost = zone load (${ZONE_KW})`, cdu.kwLost);

console.log("\nfail one CDU in a healthy N+1 zone (cdu-0-0) — spare absorbs it:");
const cduOk = simulateFailure(ctx, ["cdu-0-0"]);
ok(cduOk.dropped.length === 0, "0 racks dropped (N+1 holds)", cduOk.dropped.length);

console.log("\nSPOF audit:");
const spofs = findSPOFs(ctx);
ok(spofs[0]?.id === "cplant", "top SPOF is the cooling plant", spofs[0]);
ok(spofs.some((s) => s.id === "rpp-A-3" && s.racksDropped === 10), "single-corded RPP is a SPOF (10 racks)");
ok(spofs.filter((s) => s.nodeType === "CDU" && s.racksDropped === 30).length === 3, "the 3 under-provisioned CDUs are SPOFs (30 each)");
ok(!spofs.some((s) => s.id === "ups-B"), "the B-side UPS is NOT a SPOF (fully 2N-protected)");
ok(spofs.some((s) => s.id === "ups-A"), "the A-side UPS IS a SPOF (it solely feeds the single-corded row)");
console.log(`  (${spofs.length} SPOFs; top 3: ${spofs.slice(0, 3).map((s) => `${s.label} ${s.kwLost}kW`).join(", ")})`);

console.log("\nredundancy validation:");
const v = validateRedundancy(ctx);
const p2n = v.filter((x) => x.category === "power-2N");
const np1 = v.filter((x) => x.category === "cooling-N+1");
ok(p2n.length === 1 && p2n[0].racks === 10, "flags the single-corded row (10 racks)", p2n);
ok(np1.length === 1, "flags the under-provisioned cooling pool", np1);
ok(v.filter((x) => x.category === "generator").length === 0, "no generator-backup violations");

console.log("\nscale check (synth 1000):");
const big = buildContext(genFacility(1000));
ok(big.racks.length >= 1000, "≥1000 racks generated", big.racks.length);
const t0 = Date.now();
const spofBig = findSPOFs(big);
ok(spofBig[0]?.nodeType === "Cooling Plant", "plant still top SPOF at scale");
console.log(`  findSPOFs over ${big.nodes.length} nodes took ${Date.now() - t0} ms`);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
const proc = (globalThis as { process?: { exitCode?: number } }).process;
if (proc) proc.exitCode = failures === 0 ? 0 : 1;
