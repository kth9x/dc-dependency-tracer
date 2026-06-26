// ── The dependency / impact tracer ────────────────────────────────────
// Faithful port of the original `Wm` tracer + `Fm/$m/Pm/Im` selectors.

import type { Edge, Rule, System, TraceSettings } from "./types";
import {
  categoryOf,
  cellRacks,
  containerRacks,
  containersByLevel,
  nodeById,
  nodesOfType,
} from "./graph";
import depRulesData from "../data/depRules.json";
import impRulesData from "../data/impRules.json";

/** Index a rule list by sourceType (the original `Pr`). */
function indexRules(rules: Rule[]): Map<string, Rule[]> {
  const m = new Map<string, Rule[]>();
  for (const r of rules) {
    const arr = m.get(r.sourceType);
    if (arr) arr.push(r);
    else m.set(r.sourceType, [r]);
  }
  return m;
}

const depRulesByType = indexRules(depRulesData as Rule[]); // `wr`
const impRulesByType = indexRules(impRulesData as Rule[]); // `_o`

const LOAD_SCOPE_TO_LEVEL: Record<string, "row" | "zone" | "room"> = {
  Row: "row",
  Zone: "zone",
  "Room Bundle": "room",
  "Room PDU Bundle": "room",
  "UPS Bundle": "room",
};

/** Above this many fed racks, the load fan-out aggregates to containers. */
const LOAD_EDGE_CAP = 48;

/** All rack ids, hoisted so the load fan-out doesn't rebuild it per rule. */
const ALL_RACK_IDS = nodesOfType("Rack").map((r) => r.id);

/**
 * Build the edge set for a set of selected nodes under the current settings.
 * - Dependency = what *feeds* the node (upstream + local), capped at upstreamLevels.
 * - Impact = what the node *affects* (downstream + load fan-out), capped at downstreamLevels.
 *   The load fan-out aggregates to Row/Zone/Room containers past LOAD_EDGE_CAP
 *   so a single high-level trace stays O(containers), not O(racks).
 */
export function traceEdges(s: TraceSettings, selectedIds: string[]): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();

  const add = (
    fromId: string,
    toId: string,
    topology: Edge["topology"],
    system: System,
    level: number | null,
  ) => {
    const id = `${fromId}|${toId}|${topology}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, fromId, toId, topology, system, level });
  };

  // Aggregate load edge: one edge to a container (Row/Zone/Room) standing in
  // for `count` racks, instead of one edge per rack (keeps edges O(containers)).
  const addAgg = (fromId: string, toId: string, system: System, count: number) => {
    const id = `${fromId}|${toId}|load`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, fromId, toId, topology: "load", system, level: null, count, aggregate: true });
  };

  for (const sel of selectedIds) {
    const node = nodeById.get(sel);
    if (!node) continue;
    const type = node.nodeType;

    // ── Dependency: upstream ──
    if (s.trace.dependency && s.dependency.upstream) {
      const maxLevel = s.dependency.upstreamLevels;
      for (const rule of depRulesByType.get(type) ?? []) {
        if (
          rule.topology !== "upstream" ||
          (rule.level !== null && rule.level > maxLevel)
        )
          continue;
        const system = categoryOf[rule.targetType] ?? "spatial";
        for (const tgt of nodesOfType(rule.targetType))
          add(tgt.id, sel, "upstream", system, rule.level);
      }
    }

    // ── Dependency: local ──
    if (s.trace.dependency && s.dependency.local) {
      for (const rule of depRulesByType.get(type) ?? []) {
        if (rule.topology !== "local") continue;
        const system = categoryOf[rule.targetType] ?? "spatial";
        for (const tgt of nodesOfType(rule.targetType))
          add(tgt.id, sel, "local", system, null);
      }
    }

    const hasImpactRules = (impRulesByType.get(type) ?? []).length > 0;

    // ── Impact: downstream ──
    if (s.trace.impact && s.impact.downstream && hasImpactRules) {
      const maxLevel = s.impact.downstreamLevels;
      for (const rule of impRulesByType.get(type) ?? []) {
        if (
          rule.topology !== "downstream" ||
          (rule.level !== null && rule.level > maxLevel)
        )
          continue;
        const system = categoryOf[type] ?? categoryOf[rule.targetType] ?? "spatial";
        for (const tgt of nodesOfType(rule.targetType))
          add(sel, tgt.id, "downstream", system, rule.level);
      }
    }

    // ── Impact: load fan-out (aggregated past LOAD_EDGE_CAP) ──
    if (s.trace.impact && s.impact.load) {
      const scope = s.impact.loadScope;
      const system = categoryOf[type] ?? "spatial";

      // Racks ultimately fed by this node.
      let fedRacks: string[] = [];
      const loadsRacks =
        hasImpactRules &&
        (impRulesByType.get(type) ?? []).some(
          (r) => r.topology === "load" && r.targetType === "Rack",
        );
      if (loadsRacks) fedRacks = ALL_RACK_IDS;
      else if (type === "Rack") fedRacks = [sel];

      if (fedRacks.length !== 0) {
        const small = fedRacks.length <= LOAD_EDGE_CAP;
        if (scope === "Rack" && small) {
          // Few racks → draw them individually.
          for (const id of fedRacks) if (id !== sel) add(sel, id, "load", system, null);
        } else if (scope === "Capacity Cell") {
          // Aggregate to each capacity-cell node carrying its rack count.
          const fed = new Set(fedRacks);
          for (const cell of nodesOfType("Capacity Cell")) {
            let cnt = 0;
            for (const id of cellRacks.get(cell.id) ?? [])
              if (id !== sel && fed.has(id)) cnt++;
            if (cnt > 0) addAgg(sel, cell.id, system, cnt);
          }
        } else {
          // Aggregate to Row/Zone/Room containers (or Zone for "Rack" overflow).
          const level = scope === "Rack" ? "zone" : LOAD_SCOPE_TO_LEVEL[scope] ?? "room";
          const fed = new Set(fedRacks);
          for (const c of containersByLevel[level]) {
            let cnt = 0;
            for (const id of containerRacks.get(`${c.level}:${c.id}`) ?? [])
              if (id !== sel && fed.has(id)) cnt++;
            if (cnt > 0) addAgg(sel, c.id, system, cnt);
          }
        }
      }
    }
  }

  return out;
}

const isDependency = (e: Edge) =>
  e.topology === "upstream" || e.topology === "local";
const isImpact = (e: Edge) =>
  e.topology === "downstream" || e.topology === "load";

/** All node ids touched by the trace, plus the selection (original `Fm`). */
export function relatedIds(edges: Edge[], selectedIds: string[]): Set<string> {
  const set = new Set(selectedIds);
  for (const e of edges) {
    set.add(e.fromId);
    set.add(e.toId);
  }
  return set;
}

/** Edge ids incident to the hovered node (original `$m`). */
export function hoverSet(edges: Edge[], hoveredId: string | null): Set<string> {
  if (!hoveredId) return new Set();
  return new Set(
    edges
      .filter((e) => e.fromId === hoveredId || e.toId === hoveredId)
      .map((e) => e.id),
  );
}

/** node id -> system, for coloring (original `Pm`). */
export function systemByNode(edges: Edge[]): Record<string, System> {
  const m: Record<string, System> = {};
  for (const e of edges) {
    m[e.fromId] = e.system;
    m[e.toId] = e.system;
  }
  return m;
}

/** node id -> minimum depth level, for fade/scale (original `Im`). */
export function nodeLevels(
  edges: Edge[],
  selectedIds: string[],
): Record<string, number> {
  const m: Record<string, number> = {};
  for (const id of selectedIds) m[id] = 0;
  for (const e of edges) {
    const lvl = e.level ?? 1;
    if (!(e.fromId in m) || m[e.fromId] > lvl) m[e.fromId] = lvl;
    if (!(e.toId in m) || m[e.toId] > lvl) m[e.toId] = lvl;
  }
  return m;
}

/** Count dependency vs impact edges (for the toolbar badges). */
export function edgeCounts(edges: Edge[]): { dep: number; imp: number } {
  let dep = 0;
  let imp = 0;
  for (const e of edges) {
    if (isDependency(e)) dep++;
    else if (isImpact(e)) imp++;
  }
  return { dep, imp };
}
