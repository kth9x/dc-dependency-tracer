// ── Free-capacity model tests ─────────────────────────────────────────
// Run: npx esbuild src/lib/capacity.test.ts --bundle --platform=node \
//        --outfile=tmp.cap.mjs && node tmp.cap.mjs

import { genFacility } from "./facility";
import { buildContext } from "./engine";
import { computeCapacity } from "./capacity";

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
const block = (id: string) => cap.blocks.find((b) => b.id === id)!;

console.log(
  `blocks=${cap.blocks.length} | totals: freeRacks=${cap.totals.freeRacks} freePower=${Math.round(cap.totals.freePowerKw)} freeCool=${Math.round(cap.totals.freeCoolingKw)} stranded=${Math.round(cap.totals.strandedKw)}`,
);

console.log("\nhealthy partial zone (rpp-A-0):");
const h = block("rpp-A-0");
ok(h.freeRacks.length === 10, "10 free racks (the expansion row)", h?.freeRacks.length);
ok(h.cooling.freeKw === 960, "free cooling = 960 kW (one GPU row, N+1 spare kept)", h?.cooling.freeKw);
ok(h.powerA.freeKw > 0 && (h.powerB?.freeKw ?? 0) > 0, "free power on both A and B");
ok(h.dualCorded === true, "free racks are dual-corded (2N-ready)");

console.log("\nunder-cooled, fully-built zone (rpp-A-1):");
const u = block("rpp-A-1");
ok(u.freeRacks.length === 0, "0 free racks (zone is full)", u?.freeRacks.length);
ok(u.cooling.freeKw === 0, "0 free cooling (pool maxed, no spare)", u?.cooling.freeKw);
ok(u.strandedKw > 0, "has stranded power (kW with no usable racks/cooling)", u?.strandedKw);

console.log("\nsingle-corded zone (rpp-A-3):");
const s = block("rpp-A-3");
ok(s.freeRacks.length === 10, "still has 10 free (dual-corded) expansion racks", s?.freeRacks.length);
ok((s.powerB?.committedKw ?? 0) < s.powerA.committedKw, "commits less on B (row A is A-only)", {
  A: s?.powerA.committedKw,
  B: s?.powerB?.committedKw,
});

console.log("\ntotals:");
ok(cap.totals.freeRacks === 30, "30 free racks total (3 partial zones × 10)", cap.totals.freeRacks);
ok(cap.totals.strandedKw > 0, "some capacity is stranded", cap.totals.strandedKw);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
const proc = (globalThis as { process?: { exitCode?: number } }).process;
if (proc) proc.exitCode = failures === 0 ? 0 : 1;
