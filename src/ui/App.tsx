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
import { nodeById } from "../lib/graph";
import type { LoadScope, TraceSettings } from "../lib/types";
import { resetView } from "../scene/controlsRef";
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

  const edges = useMemo(
    () => traceEdges(deferredSettings, deferredSelected),
    [deferredSettings, deferredSelected],
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
      {selected.length > 0 && (
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
              showLines={deferredSettings.showLines}
              curvedLines={curved}
              animated={flow}
              showLabels={labels}
              hoveredNode={hovered}
              onHover={setHovered}
              onClick={toggleSelect}
            />
          </Suspense>
        </div>
        <LoadingSplash />
        <Legend edges={edges} />
        {!selected.length && (
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
