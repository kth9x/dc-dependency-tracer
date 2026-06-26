// ── Dev perf HUD: FPS + draw calls + triangles ────────────────────────
// <GlProbe> runs inside <Canvas> and samples gl.info ~2x/sec; <PerfHud> is a
// plain screen overlay that displays the latest sample. Shown when ?synth or DEV.
import { useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { SYNTH_PRESETS, setSynthTarget, synthTarget } from "../lib/synth";

export interface PerfSample {
  fps: number;
  calls: number;
  tris: number;
}

export function GlProbe({ onSample }: { onSample: (s: PerfSample) => void }) {
  const gl = useThree((s) => s.gl);
  const frames = useRef(0);
  const last = useRef(performance.now());
  useFrame(() => {
    frames.current++;
    const now = performance.now();
    const dt = now - last.current;
    if (dt >= 500) {
      onSample({
        fps: Math.round((frames.current * 1000) / dt),
        calls: gl.info.render.calls,
        tris: gl.info.render.triangles,
      });
      frames.current = 0;
      last.current = now;
    }
  });
  return null;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  return n.toLocaleString();
}

/**
 * Dev panel (top-left): live FPS / draw calls / triangles plus a "Simulated
 * racks" switcher to stress-test the scene at 100 → 5K racks. Collapsible so it
 * stays out of the way; switching reloads with `?synth=N` for a clean measure.
 */
export function PerfHud({
  sample,
  rackCount,
}: {
  sample: PerfSample | null;
  rackCount?: number;
}) {
  const [open, setOpen] = useState(true);
  const current = synthTarget();
  const fps = sample?.fps ?? null;
  const fpsColor =
    fps == null ? "#94A3B8" : fps >= 58 ? "#16A34A" : fps >= 45 ? "#CA8A04" : "#DC2626";

  return (
    <div className="animate-dt-fade-up absolute left-2 top-2 z-50 w-[216px] select-none rounded-lg border border-[#0F172A]/[0.07] bg-white/90 p-2 shadow-sm backdrop-blur-md">
      {/* header — click to collapse; FPS stays visible when collapsed */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between"
      >
        <span className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">
            Dev Tools
          </span>
          {!open && fps != null && (
            <span className="text-[11px] font-bold tabular-nums" style={{ color: fpsColor }}>
              {fps} FPS
            </span>
          )}
        </span>
        <svg
          width="9"
          height="6"
          viewBox="0 0 9 6"
          className={`text-[#CBD5E1] transition-transform ${open ? "" : "rotate-180"}`}
        >
          <path d="M1 1l3.5 3.5L8 1" stroke="currentColor" strokeWidth="1.4" fill="none" />
        </svg>
      </button>

      {open && (
        <div className="mt-2 space-y-2.5">
          {/* live readout */}
          <div className="flex items-baseline gap-2">
            <span className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full"
                style={{ background: fpsColor }}
              />
              <span
                className="text-[16px] font-bold leading-none tabular-nums"
                style={{ color: fpsColor }}
              >
                {fps ?? "—"}
              </span>
              <span className="text-[10px] font-semibold text-[#94A3B8]">FPS</span>
            </span>
            {sample && (
              <span className="ml-auto text-right text-[10px] leading-[1.35] text-[#94A3B8] tabular-nums">
                {sample.calls.toLocaleString()} calls
                <br />
                {fmtCount(sample.tris)} tris
              </span>
            )}
          </div>

          {/* simulated-rack switcher */}
          <div>
            <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">
              Simulated racks
            </div>
            <div className="flex gap-0.5 rounded-md bg-[#F1F5F9] p-0.5">
              {SYNTH_PRESETS.map((p) => {
                const active = current === p.value;
                return (
                  <button
                    key={p.label}
                    onClick={() => !active && setSynthTarget(p.value)}
                    title={p.value == null ? "Real dataset" : `${p.value} racks`}
                    className={`flex-1 rounded px-0 py-1 text-[10px] font-semibold tabular-nums transition-colors ${
                      active
                        ? "bg-[#475569] text-white shadow-sm"
                        : "text-[#64748B] hover:bg-white hover:text-[#1E293B]"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            {rackCount != null && (
              <div className="mt-1.5 text-[10px] text-[#94A3B8] tabular-nums">
                {rackCount.toLocaleString()} racks rendered
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Hook: HUD visible in dev or when ?synth is present. */
export function usePerfHud() {
  const [sample, setSample] = useState<PerfSample | null>(null);
  const show =
    (import.meta as any).env?.DEV ||
    (typeof location !== "undefined" && /[?&]synth=/.test(location.search));
  return { sample, setSample, show };
}
