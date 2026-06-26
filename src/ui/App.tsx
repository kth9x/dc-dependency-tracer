// ── Main application shell (port of the original `og`) ─────────────────
import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
  startTransition,
} from "react";
import {
  Legend,
  LoadingSplash,
  Pill,
  Popover,
  Select,
  SplitToggle,
  Stepper,
  Toggle,
} from "./components";
import {
  edgeCounts,
  hoverSet,
  nodeLevels,
  relatedIds,
  systemByNode,
  traceEdges,
} from "../lib/trace";
import { allNodes, containers, links, nodeById } from "../lib/graph";
import {
  buildContext,
  findSPOFs,
  simulateFailure,
  supplyLinks,
  validateRedundancy,
} from "../lib/engine";
import type { SimResult, Spof, Violation } from "../lib/engine";
import { computeCapacity } from "../lib/capacity";
import { DEMAND_PRESETS, findPlacements } from "../lib/placement";
import type { Candidate } from "../lib/placement";
import { RATE_PER_KW } from "../lib/facility";
import type { FailState } from "../scene/Scene3D";
import type { Demand, LoadScope, TraceSettings } from "../lib/types";
import { focusNode, resetView } from "../scene/controlsRef";
import meta from "../data/meta.json";

const Scene3D = lazy(() => import("../scene/Scene3D"));

const PRIMARY_TYPES = ["UPS", "Room PDU", "Air Cooling Unit", "BESS", "Switch Gear"];
const MORE_TYPES = ["Air Zone", "Capacity Cell", "Liquid Loop", "RDHx", "DTC"];

const ALL_TOGGLE_TYPES = [...PRIMARY_TYPES, ...MORE_TYPES];

/** Optional deep-link: "#trace=rack1,ups1" preselects nodes on load. */
function parseInitialSelection(): string[] {
  if (typeof location === "undefined") return [];
  const m = location.hash.match(/trace=([^&]+)/);
  if (!m) return [];
  return decodeURIComponent(m[1])
    .split(",")
    .map((s) => s.trim())
    .filter((id) => nodeById.has(id));
}

/** Optional deep-link: "#...&show=Room PDU,UPS" pre-enables node types. */
function parseInitialVisible(allTypes: string[]): Record<string, boolean> {
  const base = Object.fromEntries(allTypes.map((t) => [t, false]));
  if (typeof location !== "undefined") {
    const m = location.hash.match(/show=([^&]+)/);
    if (m)
      for (const t of decodeURIComponent(m[1]).split(",").map((s) => s.trim()))
        if (t in base) base[t] = true;
  }
  return base;
}

export default function App() {
  const [selected, setSelected] = useState<string[]>(parseInitialSelection);
  const [hovered, setHovered] = useState<string | null>(null);
  const [flow, setFlow] = useState(true);
  const [curved, setCurved] = useState(true);
  const [labels, setLabels] = useState(true);
  const [depMenu, setDepMenu] = useState(false);
  const [impMenu, setImpMenu] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [reliability, setReliability] = useState(false);
  const [relView, setRelView] = useState<"failure" | "density">("failure");
  // Whitespace planning (Plan mode).
  const [plan, setPlan] = useState(false);
  const [demandId, setDemandId] = useState(DEMAND_PRESETS[0].id);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [reservations, setReservations] = useState<
    { id: string; label: string; rackIds: string[]; kw: number }[]
  >([]);

  const [typeVisible, setTypeVisible] = useState<Record<string, boolean>>(() =>
    parseInitialVisible(ALL_TOGGLE_TYPES),
  );
  const moreCount = MORE_TYPES.filter((t) => typeVisible[t]).length;

  const [settings, setSettings] = useState<TraceSettings>({
    trace: { dependency: true, impact: true },
    dependency: { upstream: true, local: true, upstreamLevels: 2 },
    impact: { downstream: true, load: true, downstreamLevels: 2, loadScope: "Rack" },
    showLines: true,
  });

  // Defer the heavy recompute so toolbar interactions stay snappy.
  const deferredSelected = useDeferredValue(selected);
  const deferredSettings = useDeferredValue(settings);

  const hiddenTypes = useMemo(() => {
    const s = new Set<string>();
    for (const [type, visible] of Object.entries(typeVisible))
      if (!visible) s.add(type);
    return s;
  }, [typeVisible]);

  // In reliability mode the trace is suppressed — the engine drives the view.
  const edges = useMemo(
    () => (reliability ? [] : traceEdges(deferredSettings, deferredSelected)),
    [reliability, deferredSettings, deferredSelected],
  );
  const systems = useMemo(() => systemByNode(edges), [edges]);
  const related = useMemo(
    () => relatedIds(edges, deferredSelected),
    [edges, deferredSelected],
  );
  const hoverEdges = useMemo(
    () => (hovered ? hoverSet(edges, hovered) : new Set<string>()),
    [edges, hovered],
  );
  const levels = useMemo(
    () => nodeLevels(edges, deferredSelected),
    [edges, deferredSelected],
  );

  // ── Reliability engine (blast-radius / SPOF / validation) ──
  const engineCtx = useMemo(
    () => buildContext({ nodes: allNodes, links, containers }),
    [],
  );
  // Selected nodes ARE the failed set (click what you want to fail). With
  // nothing selected this returns the baseline (pre-existing at-risk racks).
  const sim = useMemo<SimResult | null>(
    () => (reliability ? simulateFailure(engineCtx, deferredSelected) : null),
    [reliability, deferredSelected, engineCtx],
  );
  const failState = useMemo<Map<string, FailState> | undefined>(() => {
    if (!reliability) return undefined;
    const m = new Map<string, FailState>();
    for (const id of deferredSelected) m.set(id, "failed");
    if (sim) {
      for (const id of sim.dropped) if (!m.has(id)) m.set(id, "dropped");
      for (const id of sim.atRisk) if (!m.has(id)) m.set(id, "atRisk");
    }
    return m;
  }, [reliability, deferredSelected, sim]);
  const spofs = useMemo<Spof[]>(
    () => (reliability ? findSPOFs(engineCtx) : []),
    [reliability, engineCtx],
  );
  const violations = useMemo<Violation[]>(
    () => (reliability ? validateRedundancy(engineCtx) : []),
    [reliability, engineCtx],
  );
  // Hover a node in reliability mode → draw its A/B power trains + cooling tree,
  // with de-energized segments in red (so redundancy is visible at a glance).
  const posById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), []);
  const supplyLines = useMemo(() => {
    if (!reliability || !hovered) return undefined;
    const dead = new Set(sim?.down ?? []);
    const lines: { points: [number, number, number][]; color: string }[] = [];
    for (const l of supplyLinks(engineCtx, hovered)) {
      const a = posById.get(l.fromId);
      const b = posById.get(l.toId);
      if (!a || !b) continue;
      const isDead = dead.has(l.fromId) || dead.has(l.toId);
      const color = isDead
        ? "#DC2626"
        : l.kind === "cooling"
          ? "#06B6D4"
          : l.side === "B"
            ? "#8B5CF6"
            : "#2563EB";
      lines.push({ points: [[a.x, 0.45, a.y], [b.x, 0.45, b.y]], color });
    }
    return lines;
  }, [reliability, hovered, sim, engineCtx, posById]);
  // Capacity view: color racks by power density (kW).
  const heat = useMemo<Map<string, string> | undefined>(() => {
    if (!reliability || relView !== "density") return undefined;
    const m = new Map<string, string>();
    for (const n of allNodes) if (n.shape === "rack") m.set(n.id, densityColor(n.loadKw ?? 0));
    return m;
  }, [reliability, relView]);
  const densityStats = useMemo(() => {
    let total = 0;
    const tiers = { high: 0, mid: 0, low: 0 };
    for (const n of allNodes) {
      if (n.shape !== "rack") continue;
      const kw = n.loadKw ?? 0;
      total += kw;
      if (kw >= 90) tiers.high++;
      else if (kw >= 20) tiers.mid++;
      else tiers.low++;
    }
    return { total, tiers };
  }, []);

  // ── Whitespace planning (capacity + placement) ──
  const reservedMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reservations) {
      const per = r.rackIds.length ? r.kw / r.rackIds.length : 0;
      for (const id of r.rackIds) m.set(id, per);
    }
    return m;
  }, [reservations]);
  const capModel = useMemo(() => computeCapacity(engineCtx, reservedMap), [engineCtx, reservedMap]);
  const demand = useMemo(
    () => DEMAND_PRESETS.find((d) => d.id === demandId) ?? DEMAND_PRESETS[0],
    [demandId],
  );
  const candidates = useMemo<Candidate[]>(
    () => (plan ? findPlacements(engineCtx, capModel, demand) : []),
    [plan, engineCtx, capModel, demand],
  );
  const previewCand = candidates[Math.min(previewIdx, Math.max(0, candidates.length - 1))];
  const planHeat = useMemo<Map<string, string> | undefined>(() => {
    if (!plan) return undefined;
    const m = new Map<string, string>();
    for (const b of capModel.blocks) for (const id of b.freeRacks) m.set(id, "#BBF7D0"); // available white space
    for (const r of reservations) for (const id of r.rackIds) m.set(id, "#3B82F6"); // reserved
    if (previewCand) for (const id of previewCand.rackIds) m.set(id, "#16A34A"); // current pick
    return m;
  }, [plan, capModel, reservations, previewCand]);

  const toggleSelect = useCallback((id: string) => {
    startTransition(() => {
      setSelected((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    });
  }, []);

  const { dep: depCount, imp: impCount } = useMemo(() => edgeCounts(edges), [edges]);

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-[#F8FAFC]">
      {/* ── Toolbar ── */}
      <div
        className="relative z-20 flex items-center gap-2 px-3 py-2 backdrop-blur-xl"
        style={{
          background: "rgba(255,255,255,0.92)",
          borderBottom: "1px solid rgba(15,23,42,0.06)",
        }}
      >
        {/* node-type visibility group */}
        <div
          className="flex items-center gap-0.5 rounded-lg px-1 py-0.5"
          style={{ background: "#F8FAFC", border: "1px solid rgba(15,23,42,0.04)" }}
        >
          <span className="px-2 text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">
            SAN
          </span>
          {PRIMARY_TYPES.map((t) => (
            <TypeCheckbox
              key={t}
              type={t}
              checked={typeVisible[t]}
              onChange={(v) => setTypeVisible((s) => ({ ...s, [t]: v }))}
              variant="inline"
            />
          ))}
          <div className="relative">
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                moreOpen || moreCount > 0
                  ? "bg-white text-[#1E293B] shadow-sm"
                  : "text-[#94A3B8] hover:text-[#64748B]"
              }`}
            >
              More
              {moreCount > 0 && (
                <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#475569] px-1 text-[9px] font-bold text-white">
                  {moreCount}
                </span>
              )}
              <svg
                width="8"
                height="5"
                viewBox="0 0 8 5"
                className={`ml-0.5 transition-transform ${moreOpen ? "rotate-180" : ""}`}
              >
                <path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.3" fill="none" />
              </svg>
            </button>
            {moreOpen && (
              <div
                className="animate-dt-fade-up absolute left-0 top-full z-30 mt-1.5 rounded-lg border border-[#E2E8F0] bg-white p-1 shadow-lg"
                style={{ minWidth: 180 }}
              >
                {MORE_TYPES.map((t) => (
                  <TypeCheckbox
                    key={t}
                    type={t}
                    checked={typeVisible[t]}
                    onChange={(v) => setTypeVisible((s) => ({ ...s, [t]: v }))}
                    variant="row"
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mx-0.5 h-5 w-px bg-[#E2E8F0]" />

        {/* view toggles */}
        <div
          className="flex items-center gap-0.5 rounded-lg p-0.5"
          style={{ background: "#F8FAFC", border: "1px solid rgba(15,23,42,0.04)" }}
        >
          <Pill
            on={settings.showLines}
            set={(v) => setSettings((s) => ({ ...s, showLines: v }))}
            label="Lines"
          />
          <Pill on={curved} set={setCurved} label="Curved" />
          <Pill on={flow} set={setFlow} label="Flow" />
          <Pill on={labels} set={setLabels} label="Labels" />
          <Pill on={false} set={() => resetView()} label="Reset view" />
        </div>

        <div className="mx-0.5 h-5 w-px bg-[#E2E8F0]" />

        {/* Reliability mode — blast-radius / SPOF analysis */}
        <button
          onClick={() => {
            setReliability((v) => !v);
            setPlan(false);
          }}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all ${
            reliability
              ? "bg-[#0F172A] text-white shadow-sm"
              : "bg-white text-[#475569] ring-1 ring-[#E2E8F0] hover:ring-[#CBD5E1]"
          }`}
          title="Reliability mode: simulate failures, find single points of failure"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${reliability ? "bg-[#F59E0B]" : "bg-[#94A3B8]"}`} />
          Reliability
        </button>

        {/* Plan mode — whitespace placement */}
        <button
          onClick={() => {
            setPlan((v) => !v);
            setReliability(false);
          }}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all ${
            plan
              ? "bg-[#0F172A] text-white shadow-sm"
              : "bg-white text-[#475569] ring-1 ring-[#E2E8F0] hover:ring-[#CBD5E1]"
          }`}
          title="Plan mode: place a workload into free white-space capacity"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${plan ? "bg-[#16A34A]" : "bg-[#94A3B8]"}`} />
          Plan
        </button>

        <div className="flex-1" />

        {/* Dependencies */}
        <div className="relative">
          <SplitToggle
            on={settings.trace.dependency}
            count={depCount}
            menuOpen={depMenu}
            onToggle={() => {
              setSettings((s) => ({
                ...s,
                trace: { ...s.trace, dependency: !s.trace.dependency },
              }));
              if (settings.trace.dependency) setDepMenu(false);
            }}
            onMenu={() => {
              setDepMenu((v) => !v);
              setImpMenu(false);
            }}
          >
            Dependencies
          </SplitToggle>
          <Popover open={depMenu} onClose={() => setDepMenu(false)}>
            <div className="space-y-2.5">
              <div className="flex gap-3">
                <Toggle
                  on={settings.dependency.upstream}
                  set={(v) =>
                    setSettings((s) => ({
                      ...s,
                      dependency: { ...s.dependency, upstream: v },
                    }))
                  }
                  label="Upstream"
                />
                <Toggle
                  on={settings.dependency.local}
                  set={(v) =>
                    setSettings((s) => ({
                      ...s,
                      dependency: { ...s.dependency, local: v },
                    }))
                  }
                  label="Local"
                />
              </div>
              <Stepper
                label="Depth"
                value={settings.dependency.upstreamLevels}
                min={1}
                max={meta.maxDepDepth}
                set={(v) =>
                  setSettings((s) => ({
                    ...s,
                    dependency: { ...s.dependency, upstreamLevels: v },
                  }))
                }
              />
            </div>
          </Popover>
        </div>

        {/* Impact */}
        <div className="relative">
          <SplitToggle
            on={settings.trace.impact}
            count={impCount}
            menuOpen={impMenu}
            onToggle={() => {
              setSettings((s) => ({
                ...s,
                trace: { ...s.trace, impact: !s.trace.impact },
              }));
              if (settings.trace.impact) setImpMenu(false);
            }}
            onMenu={() => {
              setImpMenu((v) => !v);
              setDepMenu(false);
            }}
          >
            Impact
          </SplitToggle>
          <Popover open={impMenu} onClose={() => setImpMenu(false)}>
            <div className="space-y-2.5">
              <div className="flex gap-3">
                <Toggle
                  on={settings.impact.downstream}
                  set={(v) =>
                    setSettings((s) => ({
                      ...s,
                      impact: { ...s.impact, downstream: v },
                    }))
                  }
                  label="Downstream"
                />
                <Toggle
                  on={settings.impact.load}
                  set={(v) =>
                    setSettings((s) => ({ ...s, impact: { ...s.impact, load: v } }))
                  }
                  label="Load"
                />
              </div>
              <Stepper
                label="Depth"
                value={settings.impact.downstreamLevels}
                min={1}
                max={meta.maxImpactDepth}
                set={(v) =>
                  setSettings((s) => ({
                    ...s,
                    impact: { ...s.impact, downstreamLevels: v },
                  }))
                }
              />
              <Select
                label="Scope"
                value={settings.impact.loadScope}
                set={(v) =>
                  setSettings((s) => ({
                    ...s,
                    impact: { ...s.impact, loadScope: v as LoadScope },
                  }))
                }
                opts={meta.traceSources}
              />
            </div>
          </Popover>
        </div>
      </div>

      {/* ── Selection chips ── */}
      {!plan && selected.length > 0 && (
        <div className="relative z-10 flex items-center gap-1.5 overflow-hidden bg-white/60 px-3 py-1 shadow-[0_1px_0_rgba(15,23,42,0.03)] backdrop-blur-sm animate-dt-expand-h">
          {selected.map((id) => {
            const node = nodeById.get(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleSelect(id)}
                className="flex items-center gap-1.5 rounded-full bg-[#F1F5F9] px-3 py-1 text-[12px] font-semibold text-[#334155] ring-1 ring-[#94A3B8]/25 transition-all hover:ring-[#94A3B8]/40 animate-dt-chip-in"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[#334155]" />
                {node?.label}
                <svg width="6" height="6" viewBox="0 0 6 6" className="ml-0.5 opacity-40">
                  <path d="M1 1l4 4M5 1l-4 4" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setSelected([])}
            className="ml-auto text-[9px] font-semibold text-[#CBD5E1] hover:text-[#94A3B8]"
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Canvas ── */}
      <div style={{ flex: "1 1 0%", position: "relative", overflow: "hidden", minHeight: 0 }}>
        <div style={{ position: "absolute", inset: 0 }}>
          <Suspense fallback={null}>
            <Scene3D
              activeTsns={deferredSelected}
              edges={edges}
              hlSystems={systems}
              relatedIds={related}
              hoverSet={hoverEdges}
              hiddenTypes={hiddenTypes}
              nodeLevels={levels}
              showLines={reliability || plan ? false : deferredSettings.showLines}
              curvedLines={curved}
              animated={flow}
              showLabels={labels}
              hoveredNode={hovered}
              failState={relView === "failure" ? failState : undefined}
              heat={plan ? planHeat : heat}
              supplyLines={relView === "failure" ? supplyLines : undefined}
              onHover={setHovered}
              onClick={toggleSelect}
            />
          </Suspense>
        </div>
        <LoadingSplash />
        {!reliability && <Legend edges={edges} />}
        {reliability && (
          <ReliabilityPanel
            sim={sim}
            spofs={spofs}
            violations={violations}
            selectedCount={selected.length}
            view={relView}
            onView={setRelView}
            densityStats={densityStats}
            onPick={(id) => {
              const n = nodeById.get(id);
              startTransition(() => setSelected([id]));
              if (n) focusNode(n.x, n.y);
            }}
            onClear={() => setSelected([])}
          />
        )}
        {reliability && <ReliabilityLegend view={relView} />}
        {plan && (
          <PlanPanel
            demand={demand}
            demandId={demandId}
            onDemand={(id) => {
              setDemandId(id);
              setPreviewIdx(0);
            }}
            candidates={candidates}
            previewIdx={Math.min(previewIdx, Math.max(0, candidates.length - 1))}
            onPreview={(i) => {
              setPreviewIdx(i);
              const first = candidates[i]?.rackIds[0];
              const n = first ? nodeById.get(first) : undefined;
              if (n) focusNode(n.x, n.y);
            }}
            onReserve={(c) => {
              setReservations((prev) => [
                ...prev,
                { id: `r${prev.length}`, label: demand.label, rackIds: c.rackIds, kw: demand.roles.reduce((s, r) => s + r.count * r.perRackKw, 0) },
              ]);
              setPreviewIdx(0);
            }}
            reservations={reservations}
            onClearReservations={() => setReservations([])}
            totals={capModel.totals}
          />
        )}
        {plan && <PlanLegend />}
        {!reliability && !plan && !selected.length && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
            <div className="rounded-xl bg-white/90 px-6 py-2.5 text-[14px] font-medium text-[#94A3B8] shadow-sm ring-1 ring-black/[0.04] backdrop-blur-sm animate-dt-fade-up">
              Select a rack to trace
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Checkbox styled exactly like the original's type toggles. */
function TypeCheckbox({
  type,
  checked,
  onChange,
  variant,
}: {
  type: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  variant: "inline" | "row";
}) {
  const wrap =
    variant === "inline"
      ? `flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
          checked ? "bg-white text-[#1E293B] shadow-sm" : "text-[#94A3B8] hover:text-[#64748B]"
        }`
      : `flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-all duration-150 ${
          checked ? "bg-[#F1F5F9] text-[#1E293B]" : "text-[#64748B] hover:bg-[#F8FAFC]"
        }`;
  return (
    <label className={wrap}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="hidden"
      />
      <span
        className={`flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors ${
          checked ? "border-[#475569] bg-[#475569]" : "border-[#CBD5E1] bg-white"
        }`}
      >
        {checked && (
          <svg width="8" height="8" viewBox="0 0 8 8">
            <path d="M1.5 4L3 5.5L6.5 2" stroke="white" strokeWidth="1.3" fill="none" />
          </svg>
        )}
      </span>
      {type}
    </label>
  );
}

// ── Reliability panel (blast-radius result · SPOF audit · validation) ──
const fmtKw = (kw: number) =>
  kw >= 1000 ? `${(kw / 1000).toFixed(1)} MW` : `${Math.round(kw)} kW`;
/** Power-density heat color for a rack by its kW draw. */
const densityColor = (kw: number) =>
  kw >= 90 ? "#DC2626" : kw >= 40 ? "#F59E0B" : kw >= 20 ? "#FACC15" : "#3B82F6";
const usdCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const violationLabel = (c: Violation["category"]) =>
  c === "power-2N" ? "Power 2N" : c === "cooling-N+1" ? "Cooling N+1" : "Generator";

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "warning";
}) {
  const color = tone === "danger" ? "#DC2626" : tone === "warning" ? "#B45309" : "#0F172A";
  return (
    <div className="rounded-md bg-[#F8FAFC] px-2.5 py-2">
      <div className="text-[10px] text-[#94A3B8]">{label}</div>
      <div className="text-[18px] font-bold leading-tight" style={{ color }}>
        {value}
      </div>
      {sub && <div className="truncate text-[9px] text-[#CBD5E1]">{sub}</div>}
    </div>
  );
}

function PlanLegend() {
  const dot = (c: string, t: string) => (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: c }} />
      {t}
    </span>
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <div className="flex items-center gap-3 rounded-full bg-white/90 px-4 py-1.5 text-[11px] font-medium text-[#475569] shadow-sm ring-1 ring-black/[0.05] backdrop-blur-sm animate-dt-fade-up">
        {dot("#BBF7D0", "Available")}
        {dot("#16A34A", "This placement")}
        {dot("#3B82F6", "Reserved")}
      </div>
    </div>
  );
}

function PlanPanel({
  demand,
  demandId,
  onDemand,
  candidates,
  previewIdx,
  onPreview,
  onReserve,
  reservations,
  onClearReservations,
  totals,
}: {
  demand: Demand;
  demandId: string;
  onDemand: (id: string) => void;
  candidates: Candidate[];
  previewIdx: number;
  onPreview: (i: number) => void;
  onReserve: (c: Candidate) => void;
  reservations: { id: string; label: string; rackIds: string[]; kw: number }[];
  onClearReservations: () => void;
  totals: { freeRacks: number; freePowerKw: number; freeCoolingKw: number; strandedKw: number };
}) {
  const totalRacks = demand.roles.reduce((s, r) => s + r.count, 0);
  const totalKw = demand.roles.reduce((s, r) => s + r.count * r.perRackKw, 0);
  const sel = candidates[previewIdx];
  return (
    <div className="animate-dt-fade-up absolute right-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-[320px] flex-col overflow-hidden rounded-xl bg-white/90 shadow-lg ring-1 ring-black/[0.06] backdrop-blur-xl">
      <div className="flex items-center gap-2 border-b border-[#0F172A]/[0.06] px-4 py-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#0F172A] text-white">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" />
            <rect x="13" y="13" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
        <div>
          <div className="text-[13px] font-semibold leading-tight text-[#0F172A]">Plan</div>
          <div className="text-[10px] text-[#94A3B8]">Whitespace placement</div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">Workload</div>
          <select
            value={demandId}
            onChange={(e) => onDemand(e.target.value)}
            className="w-full rounded-md border border-[#E2E8F0] bg-white px-2 py-1.5 text-[12px] text-[#334155]"
          >
            {DEMAND_PRESETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <div className="mt-1.5 text-[11px] text-[#64748B]">
            {totalRacks} racks · {fmtKw(totalKw)} · power {demand.powerRedundancy} · cooling {demand.coolingRedundancy}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Metric label="Free racks" value={String(totals.freeRacks)} />
          <Metric label="Free power" value={fmtKw(totals.freePowerKw)} />
          <Metric label="Free cooling" value={fmtKw(totals.freeCoolingKw)} />
          <Metric label="Stranded" value={fmtKw(totals.strandedKw)} tone="warning" />
        </div>

        <div>
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
            Placements <span className="text-[#CBD5E1]">· {candidates.length}</span>
          </div>
          {candidates.length === 0 ? (
            <div className="text-[11px] text-[#94A3B8]">No candidates.</div>
          ) : (
            <div className="space-y-1">
              {candidates.map((c, i) => (
                <button
                  key={c.blockId || `multi-${i}`}
                  onClick={() => onPreview(i)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    i === previewIdx ? "bg-[#ECFDF5] ring-1 ring-[#A7F3D0]" : "hover:bg-[#F1F5F9]"
                  }`}
                >
                  <span
                    className={`flex h-4 items-center rounded px-1.5 text-[9px] font-bold ${
                      c.fit ? "bg-[#DCFCE7] text-[#166534]" : "bg-[#FEE2E2] text-[#991B1B]"
                    }`}
                  >
                    {c.fit ? "FIT" : "NO"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-[#334155]">{c.label}</span>
                    <span className={`block truncate text-[10px] ${c.riskOk ? "text-[#94A3B8]" : "text-[#B45309]"}`}>{c.riskNote}</span>
                  </span>
                  {c.fit && (
                    <span className="h-1.5 w-10 overflow-hidden rounded-full bg-[#E2E8F0]">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${Math.round(c.score * 100)}%`, background: c.riskOk ? "#16A34A" : "#F59E0B" }}
                      />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {sel && (
          <div className="rounded-lg border border-[#E2E8F0] p-2.5">
            <div className="mb-1 text-[12px] font-semibold text-[#334155]">{sel.label}</div>
            <ul className="mb-2 space-y-0.5">
              {sel.reasons.map((r, i) => (
                <li key={i} className="text-[11px] text-[#64748B]">
                  · {r}
                </li>
              ))}
            </ul>
            <button
              disabled={!sel.fit}
              onClick={() => onReserve(sel)}
              className={`w-full rounded-md py-1.5 text-[12px] font-semibold transition-colors ${
                sel.fit ? "bg-[#0F172A] text-white hover:bg-[#1E293B]" : "cursor-not-allowed bg-[#F1F5F9] text-[#CBD5E1]"
              }`}
            >
              {sel.fit ? `Reserve ${sel.usesRacks} racks` : "Doesn't fit"}
            </button>
          </div>
        )}

        {reservations.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">Reserved · {reservations.length}</span>
              <button onClick={onClearReservations} className="text-[10px] font-semibold text-[#CBD5E1] hover:text-[#64748B]">
                Clear
              </button>
            </div>
            <div className="space-y-1">
              {reservations.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[11px]">
                  <span className="h-2 w-2 rounded-sm bg-[#3B82F6]" />
                  <span className="flex-1 truncate text-[#475569]">{r.label}</span>
                  <span className="text-[#94A3B8]">{r.rackIds.length} rk · {fmtKw(r.kw)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReliabilityLegend({ view }: { view: "failure" | "density" }) {
  const dot = (c: string, t: string) => (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: c }} />
      {t}
    </span>
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <div className="flex items-center gap-3 rounded-full bg-white/90 px-4 py-1.5 text-[11px] font-medium text-[#475569] shadow-sm ring-1 ring-black/[0.05] backdrop-blur-sm animate-dt-fade-up">
        {view === "density" ? (
          <>
            <span className="text-[10px] text-[#94A3B8]">Power density:</span>
            {dot("#DC2626", "High")}
            {dot("#FACC15", "Mid")}
            {dot("#3B82F6", "Low")}
          </>
        ) : (
          <>
            {dot("#DC2626", "Down")}
            {dot("#F59E0B", "At-risk")}
            {dot("#111827", "Failed")}
            {dot("#CBD5E1", "Unaffected")}
            <span className="h-3 w-px bg-[#E2E8F0]" />
            <span className="text-[10px] text-[#94A3B8]">Hover a node:</span>
            {dot("#2563EB", "A")}
            {dot("#8B5CF6", "B")}
            {dot("#06B6D4", "Cooling")}
          </>
        )}
      </div>
    </div>
  );
}

function DensityRow({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      <span className="flex-1 text-[#475569]">{label}</span>
      <span className="font-semibold text-[#334155]">{n}</span>
    </div>
  );
}

function ReliabilityPanel({
  sim,
  spofs,
  violations,
  selectedCount,
  view,
  onView,
  densityStats,
  onPick,
  onClear,
}: {
  sim: SimResult | null;
  spofs: Spof[];
  violations: Violation[];
  selectedCount: number;
  view: "failure" | "density";
  onView: (v: "failure" | "density") => void;
  densityStats: { total: number; tiers: { high: number; mid: number; low: number } };
  onPick: (id: string) => void;
  onClear: () => void;
}) {
  const active = selectedCount > 0 && sim != null;
  const maxKw = spofs.length ? spofs[0].kwLost : 1;
  return (
    <div className="animate-dt-fade-up absolute right-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-[300px] flex-col overflow-hidden rounded-xl bg-white/90 shadow-lg ring-1 ring-black/[0.06] backdrop-blur-xl">
      <div className="flex items-center gap-2 border-b border-[#0F172A]/[0.06] px-4 py-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#0F172A] text-white">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <div className="text-[13px] font-semibold leading-tight text-[#0F172A]">Reliability</div>
          <div className="text-[10px] text-[#94A3B8]">Blast-radius &amp; SPOF analysis</div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div className="flex gap-0.5 rounded-md bg-[#F1F5F9] p-0.5">
          {(["failure", "density"] as const).map((v) => (
            <button
              key={v}
              onClick={() => onView(v)}
              className={`flex-1 rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
                view === v ? "bg-white text-[#1E293B] shadow-sm" : "text-[#64748B] hover:text-[#1E293B]"
              }`}
            >
              {v === "failure" ? "Failure" : "Power density"}
            </button>
          ))}
        </div>

        {view === "failure" && (
          <>
            {active ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">Simulated failure</div>
              <button onClick={onClear} className="text-[10px] font-semibold text-[#CBD5E1] hover:text-[#64748B]">
                Clear
              </button>
            </div>
            <div className="text-[12px] font-medium text-[#334155]">
              {sim!.failed.map((id) => nodeById.get(id)?.label ?? id).join(", ")}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Racks down" value={String(sim!.dropped.length)} tone="danger" />
              <Metric label="Load lost" value={fmtKw(sim!.kwLost)} tone="danger" />
              <Metric label="At-risk" value={String(sim!.atRisk.length)} tone="warning" />
              <Metric label="Tenants hit" value={String(sim!.tenants.length)} sub={sim!.tenants.join(", ")} />
            </div>
            {sim!.kwLost > 0 && (
              <div className="rounded-md bg-[#FEF2F2] px-3 py-2 text-[11px] text-[#991B1B]">
                ≈ ${usdCompact.format(sim!.kwLost * RATE_PER_KW)}/yr capacity value at risk
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg bg-[#F8FAFC] px-3 py-2.5 text-[11px] leading-relaxed text-[#64748B]">
            Click any node to <span className="font-semibold text-[#334155]">simulate its failure</span>. Racks turn red (down) or amber (redundancy lost).
            {sim && sim.atRisk.length > 0 && (
              <div className="mt-1.5 text-[#B45309]">{sim.atRisk.length} racks already at-risk at baseline.</div>
            )}
          </div>
        )}

        <div>
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
            Single points of failure <span className="text-[#CBD5E1]">· {spofs.length}</span>
          </div>
          {spofs.length === 0 ? (
            <div className="text-[11px] text-[#16A34A]">None — every load is redundant.</div>
          ) : (
            <div className="space-y-1">
              {spofs.slice(0, 8).map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => onPick(s.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[#F1F5F9]"
                >
                  <span className="w-3 text-[10px] text-[#CBD5E1]">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-[#334155]">{s.label}</span>
                    <span
                      className="mt-0.5 block h-1 rounded-full bg-[#FCA5A5]"
                      style={{ width: `${Math.max(6, (s.kwLost / maxKw) * 100)}%` }}
                    />
                  </span>
                  <span className="whitespace-nowrap text-right text-[11px] font-semibold text-[#334155]">{fmtKw(s.kwLost)}</span>
                  <span className="w-10 whitespace-nowrap text-right text-[10px] text-[#94A3B8]">{s.racksDropped} rk</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">Redundancy validation</div>
          {violations.length === 0 ? (
            <div className="flex items-center gap-1.5 text-[11px] text-[#16A34A]">
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.5L4.5 9L10 3" stroke="#16A34A" strokeWidth="1.6" fill="none" /></svg>
              All checks pass
            </div>
          ) : (
            <div className="space-y-1.5">
              {violations.map((v, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px]">
                  <span className="mt-0.5 text-[#DC2626]">
                    <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.5" /></svg>
                  </span>
                  <span className="text-[#475569]">
                    <span className="font-semibold text-[#334155]">{violationLabel(v.category)}</span> — {v.scope}: {v.detail}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
          </>
        )}

        {view === "density" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Total IT load" value={fmtKw(densityStats.total)} />
              <Metric label="Annual value" value={`$${usdCompact.format(densityStats.total * RATE_PER_KW)}`} />
            </div>
            <div className="space-y-1.5 text-[11px]">
              <DensityRow color="#DC2626" label="High (GPU ≥ 90 kW)" n={densityStats.tiers.high} />
              <DensityRow color="#FACC15" label="Mid (20–89 kW)" n={densityStats.tiers.mid} />
              <DensityRow color="#3B82F6" label="Low (< 20 kW)" n={densityStats.tiers.low} />
            </div>
            <div className="rounded-lg bg-[#F8FAFC] px-3 py-2.5 text-[11px] leading-relaxed text-[#64748B]">
              Racks are colored by power draw — see where load and heat concentrate.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
