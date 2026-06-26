// ── Reusable 2D toolbar widgets (ports of Wr/uc/Mu/Fr/ng/$r/cg/ig) ────
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Edge, System } from "../lib/types";
import { legendColor, legendLabel } from "../lib/palette";

/** Split toggle button with a count badge + chevron menu trigger (original `Wr`). */
export function SplitToggle({
  on,
  onToggle,
  onMenu,
  menuOpen,
  children,
  count,
}: {
  on: boolean;
  onToggle: () => void;
  onMenu: () => void;
  menuOpen: boolean;
  children: ReactNode;
  count: number;
}) {
  return (
    <div
      className="flex items-center rounded-full transition-all duration-200"
      style={
        on
          ? {
              background: "rgba(71,85,105,0.06)",
              boxShadow: "0 0 0 1px rgba(71,85,105,0.18)",
            }
          : {
              background: "transparent",
              boxShadow: "0 0 0 1px rgba(15,23,42,0.08)",
            }
      }
    >
      <button
        type="button"
        onClick={onToggle}
        className="rounded-l-full py-1.5 pl-4 pr-1 text-[13px] font-semibold"
        style={{ color: on ? "#475569" : "#94A3B8" }}
      >
        {children}
        {on && count > 0 && (
          <span
            className="ml-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: "rgba(71,85,105,0.10)", color: "#475569" }}
          >
            {count}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onMenu}
        className="rounded-r-full py-1.5 pl-1 pr-3 transition-colors hover:bg-black/[0.03]"
        style={{ color: on ? "#475569" : "#94A3B8" }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`transition-transform ${menuOpen ? "rotate-180" : ""}`}
        >
          <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.3" fill="none" />
        </svg>
      </button>
    </div>
  );
}

/** Toggle switch with label (original `uc`). */
export function Toggle({
  on,
  set,
  label,
}: {
  on: boolean;
  set: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 select-none">
      <div
        onClick={() => set(!on)}
        className={`relative h-[18px] w-[32px] rounded-full transition-colors duration-200 ${
          on ? "bg-[#475569]" : "bg-[#CBD5E1]"
        }`}
      >
        <div
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform duration-200 ${
            on ? "left-[16px]" : "left-[2px]"
          }`}
          style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.12)" }}
        />
      </div>
      <span className="text-[12px] font-medium text-[#64748B]">{label}</span>
    </label>
  );
}

/** Pill toggle button (original `Mu`). */
export function Pill({
  on,
  set,
  label,
  icon,
}: {
  on: boolean;
  set: (v: boolean) => void;
  label: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => set(!on)}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all duration-150 ${
        on
          ? "bg-[#1E293B] text-white shadow-sm"
          : "bg-transparent text-[#94A3B8] hover:bg-[#F1F5F9] hover:text-[#64748B]"
      }`}
    >
      {icon && <span className="text-[11px]">{icon}</span>}
      {label}
    </button>
  );
}

/** Numeric stepper (original `Fr`). */
export function Stepper({
  label,
  value,
  min,
  max,
  set,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  set: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[12px] font-medium text-[#64748B]">{label}</span>
      <div className="flex items-center rounded-full bg-[#F1F5F9] ring-1 ring-[rgba(15,23,42,0.06)]">
        <button
          type="button"
          onClick={() => set(Math.max(min, value - 1))}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-bold text-[#64748B] transition-colors hover:bg-[#E2E8F0]"
          disabled={value <= min}
        >
          −
        </button>
        <span className="min-w-[22px] text-center text-[13px] font-bold text-[#0F172A]">
          {value}
        </span>
        <button
          type="button"
          onClick={() => set(Math.min(max, value + 1))}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-bold text-[#64748B] transition-colors hover:bg-[#E2E8F0]"
          disabled={value >= max}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** Labeled select (original `ng`). */
export function Select({
  label,
  value,
  set,
  opts,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  opts: string[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] font-medium text-[#64748B]">{label}</span>
      <select
        value={value}
        onChange={(e) => set(e.target.value)}
        className="rounded-md border-none bg-[#F1F5F9] px-2 py-1 text-[12px] font-semibold text-[#334155] outline-none"
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Click-outside popover (original `$r`). */
export function Popover({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 10);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-50 mt-2 w-[230px] rounded-xl bg-white p-3 shadow-[0_12px_40px_rgba(15,23,42,0.12)] ring-1 ring-[rgba(15,23,42,0.06)] animate-dt-drop-in"
    >
      {children}
    </div>
  );
}

/** Bottom-right legend with animated flow dots (original `cg`). */
export function Legend({ edges }: { edges: Edge[] }) {
  if (!edges.length) return null;
  const isDep = (e: Edge) => e.topology === "upstream" || e.topology === "local";
  const isImp = (e: Edge) => e.topology === "downstream" || e.topology === "load";

  const depSystems = new Set<System>();
  const impSystems = new Set<System>();
  for (const e of edges) {
    if (isDep(e)) depSystems.add(e.system);
    if (isImp(e)) impSystems.add(e.system);
  }

  const order: System[] = ["electrical", "cooling", "spatial", "whitespace"];
  const items: { color: string; label: string; dashed: boolean }[] = [];
  for (const s of order)
    if (depSystems.has(s))
      items.push({ color: legendColor[s], label: `${legendLabel[s]} dep.`, dashed: true });
  for (const s of order)
    if (impSystems.has(s))
      items.push({ color: legendColor[s], label: `${legendLabel[s]} impact`, dashed: false });
  const deduped = items.filter(
    (it, i, arr) => arr.findIndex((x) => x.label === it.label) === i,
  );

  return (
    <div className="absolute bottom-3 right-3 z-30 flex items-center gap-3 rounded-xl bg-white/90 px-4 py-1.5 shadow-sm ring-1 ring-black/[0.04] backdrop-blur-md animate-dt-fade-up">
      <div className="flex items-center gap-1.5">
        <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
          <rect x="1" y="0.5" width="10" height="13" rx="1.2" stroke="#334155" strokeWidth="1" fill="#F1F5F9" />
          <rect x="2.5" y="2.5" width="7" height="1.8" rx=".4" fill="#64748B" />
          <rect x="2.5" y="5.5" width="7" height="1.8" rx=".4" fill="#64748B" />
          <rect x="2.5" y="8.5" width="7" height="1.8" rx=".4" fill="#94A3B8" />
          <circle cx="8.2" cy="3.4" r=".5" fill="#34D399" />
          <circle cx="8.2" cy="6.4" r=".5" fill="#34D399" />
        </svg>
        <span className="text-[10px] font-semibold text-[#334155]">Source</span>
      </div>
      {deduped.map(({ color, label, dashed }) => (
        <div key={label} className="flex items-center gap-1.5">
          <svg width="28" height="6" viewBox="0 0 28 6">
            <line
              x1="0"
              y1="3"
              x2="22"
              y2="3"
              stroke={color}
              strokeWidth={dashed ? 1.5 : 2.5}
              strokeDasharray={dashed ? "4 3" : undefined}
              opacity=".7"
            />
            <polygon points="22,0.5 28,3 22,5.5" fill={color} opacity=".6" />
            <circle r="1.8" fill={color} opacity=".7">
              <animateMotion dur="1s" repeatCount="indefinite" path="M0,3 L22,3" />
            </circle>
          </svg>
          <span className="text-[10px] font-semibold text-[#334155]">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** "Loading infrastructure…" splash (original `ig`). */
export function LoadingSplash() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDone(true), 600);
    return () => clearTimeout(t);
  }, []);
  if (done) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
      style={{
        background:
          "linear-gradient(180deg, rgba(248,250,252,0.96) 0%, rgba(241,245,249,0.88) 100%)",
        animation: "fade-out 300ms ease-in-out 400ms forwards",
      }}
    >
      <div className="flex flex-col items-center gap-3">
        <div className="relative h-10 w-10">
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-[#E2E8F0] border-t-[#06B6D4]" />
        </div>
        <div className="text-[12px] font-medium text-[#94A3B8] tracking-wide">
          Loading infrastructure…
        </div>
      </div>
      <style>{`@keyframes fade-out { to { opacity: 0; visibility: hidden; } }`}</style>
    </div>
  );
}
