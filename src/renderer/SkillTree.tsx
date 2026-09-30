import React, { useEffect, useMemo, useState } from "react";
import type { BuiltInCapability, SkillSummary } from "../shared/types.js";
import { LLAMA31_CAPABILITIES, LLAMA31_PROFILE_CATEGORY } from "../shared/llama31Capabilities.js";

/** Custom (self-taught) skills and built-in (native) tools render in the
 * same tree — this union carries just what layout/rendering needs from
 * either, so the rest of the component doesn't care which one it has. */
type TreeItem =
  | { kind: "custom"; name: string; category: string; parent: string | null; skill: SkillSummary }
  | { kind: "builtin"; name: string; category: string; parent: null; cap: BuiltInCapability }
  | { kind: "model"; name: string; category: string; parent: null; description: string; grade: string };

type VisualStatus = "passed" | "failed" | "unverified" | "builtin" | "reference";

const STATUS_LABEL: Record<VisualStatus, string> = {
  passed: "VERIFIED",
  failed: "FAILED",
  unverified: "UNVERIFIED",
  builtin: "BUILT-IN",
  reference: "MODEL PROFILE"
};

function visualStatus(item: TreeItem): VisualStatus {
  if (item.kind === "builtin") return "builtin";
  if (item.kind === "model") return "reference";
  return item.skill.status;
}

const COL_WIDTH = 118;
const ROW_HEIGHT = 68;
const NODE_R = 15;
const HUB_R = 19;
const PAD = 26;

interface LayoutNode {
  id: string;
  item: TreeItem | null; // null only for the category's own hub
  children: LayoutNode[];
  x: number;
  y: number;
}

/** Groups items by category, then within each category builds a
 * parent -> children map (customs only — builtins are always flat
 * children of the hub). A parent reference to a different category, or a
 * dangling one, is treated as a root so an item never just vanishes. */
function groupIntoCategories(items: TreeItem[]): Map<string, { roots: TreeItem[]; childrenOf: Map<string, TreeItem[]> }> {
  const byCategory = new Map<string, TreeItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  const result = new Map<string, { roots: TreeItem[]; childrenOf: Map<string, TreeItem[]> }>();
  for (const [category, list] of byCategory) {
    const namesInCategory = new Set(list.map((i) => i.name));
    const childrenOf = new Map<string, TreeItem[]>();
    const roots: TreeItem[] = [];
    for (const item of list) {
      if (item.parent && namesInCategory.has(item.parent)) {
        const siblings = childrenOf.get(item.parent) ?? [];
        siblings.push(item);
        childrenOf.set(item.parent, siblings);
      } else {
        roots.push(item);
      }
    }
    result.set(category, { roots, childrenOf });
  }
  return result;
}

/** Lays out one category like a conventional skill tree: capability nodes
 * in the same tier sit side by side, while dependent skills appear below
 * their parent. The hub is centered above its branch so connector geometry
 * and its visible circle always share the same point. */
function layoutCategory(category: string, roots: TreeItem[], childrenOf: Map<string, TreeItem[]>): LayoutNode {
  function build(item: TreeItem): LayoutNode {
    const kids = (childrenOf.get(item.name) ?? []).map(build);
    return { id: item.name, item, children: kids, x: 0, y: 0 };
  }
  const hub: LayoutNode = { id: `__hub__${category}`, item: null, children: roots.map(build), x: 0, y: 0 };

  let nextLeafSlot = 0;
  function assign(node: LayoutNode, depth: number): void {
    node.y = depth * ROW_HEIGHT;
    if (node.children.length === 0) {
      node.x = nextLeafSlot * COL_WIDTH;
      nextLeafSlot += 1;
      return;
    }
    for (const child of node.children) assign(child, depth + 1);
    const xs = node.children.map((c) => c.x);
    node.x = (Math.min(...xs) + Math.max(...xs)) / 2;
  }
  assign(hub, 0);
  return hub;
}

interface FlatLayout {
  nodes: LayoutNode[];
  edges: Array<{ from: LayoutNode; to: LayoutNode }>;
  maxX: number;
  maxY: number;
}

function flatten(hub: LayoutNode): FlatLayout {
  const nodes: LayoutNode[] = [];
  const edges: FlatLayout["edges"] = [];
  let maxX = 0;
  let maxY = 0;
  function walk(node: LayoutNode) {
    if (node.item) {
      nodes.push(node);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    for (const child of node.children) {
      edges.push({ from: node, to: child });
      walk(child);
    }
  }
  walk(hub);
  return { nodes, edges, maxX, maxY };
}

/**
 * A visual record of everything the current AI can do — native tools it
 * always has (gold nodes), an optional Llama 3.1 8B reference profile
 * (blue-gray nodes), and skills it's actually taught itself (green =
 * verified working, red = failed, gray = never run).
 */
export default function SkillTree({ onClose }: { onClose: () => void }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [builtIns, setBuiltIns] = useState<BuiltInCapability[] | null>(null);
  const [selected, setSelected] = useState<TreeItem | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [skillsRoot, setSkillsRoot] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    void window.mimir.skills.getRoot().then(setSkillsRoot);
    void window.mimir.skills.listBuiltIns().then(setBuiltIns);
  }, []);

  async function refresh() {
    const list = await window.mimir.skills.list();
    setSkills(list);
  }

  async function verify(name: string) {
    setVerifying(name);
    const updated = await window.mimir.skills.verify(name);
    setVerifying(null);
    if (!updated) return;
    setSkills((prev) => (prev ? prev.map((s) => (s.name === name ? updated : s)) : prev));
    setSelected((prev) => (prev?.kind === "custom" && prev.name === name ? { ...prev, skill: updated } : prev));
  }

  const items: TreeItem[] = useMemo(() => {
    const customItems: TreeItem[] = (skills ?? []).map((skill) => ({
      kind: "custom",
      name: skill.name,
      category: skill.category,
      parent: skill.parent,
      skill
    }));
    const builtInItems: TreeItem[] = (builtIns ?? []).map((cap) => ({
      kind: "builtin",
      name: cap.name,
      category: cap.category,
      parent: null,
      cap
    }));
    const modelProfileItems: TreeItem[] = LLAMA31_CAPABILITIES.map((cap) => ({
      kind: "model",
      name: cap.name,
      category: LLAMA31_PROFILE_CATEGORY,
      parent: null,
      description: cap.description,
      grade: cap.grade
    }));
    return [...builtInItems, ...modelProfileItems, ...customItems];
  }, [skills, builtIns]);

  const categories = useMemo(() => {
    const grouped = groupIntoCategories(items);
    return [...grouped.entries()]
      .map(([category, { roots, childrenOf }]) => ({ category, layout: layoutCategory(category, roots, childrenOf) }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }, [items]);

  const loading = skills === null || builtIns === null;

  return (
    <div className="skill-tree">
      <div className="skill-tree-header">
        <h2>Skill Tree</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">
        Gold = native Mimir tools. Blue-gray = Llama 3.1 8B reference capabilities, not installed model weights.
        Green/red/gray = saved skills, colored by whether their code has run and passed.
      </p>
      <div className="key-row">
        <button type="button" className="btn" onClick={() => void window.mimir.skills.openFolder()}>
          Open in Finder
        </button>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {loading && <p className="hint">Loading…</p>}
      {!loading && items.length === 0 && <p className="hint">Nothing to show yet.</p>}

      <div className="skill-categories">
      {categories.map(({ category, layout }) => {
        const { nodes, edges, maxX, maxY } = flatten(layout);
        const width = maxX + PAD * 2 + NODE_R;
        const height = Math.max(maxY, 0) + PAD * 2 + NODE_R;
        return (
          <div key={category} className="skill-category">
            <div className="skill-category-header">{category}</div>
            <div className="skill-tree-row">
              <svg
                className="skill-tree-svg"
                width={Math.max(width, HUB_R * 2 + PAD * 2)}
                height={Math.max(height, HUB_R * 2 + PAD)}
                role="img"
                aria-label={`${category} skill tree`}
              >
                {edges.map(({ from, to }) => (
                  <line
                    key={`${from.id}-${to.id}`}
                    className="skill-edge"
                    x1={from.x + PAD}
                    y1={from.y + PAD}
                    x2={to.x + PAD}
                    y2={to.y + PAD}
                  />
                ))}
                <circle className="skill-hub" cx={layout.x + PAD} cy={layout.y + PAD} r={HUB_R} />
                {nodes.map((node) => {
                  const item = node.item;
                  if (!item) return null;
                  const status = visualStatus(item);
                  const isSelected = selected?.kind === item.kind && selected.name === item.name;
                  return (
                    <g
                      key={node.id}
                      className="skill-node-g"
                      transform={`translate(${node.x + PAD}, ${node.y + PAD})`}
                      onClick={() => setSelected(item)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") setSelected(item);
                      }}
                    >
                      <circle
                        r={NODE_R}
                        className={`skill-node-circle skill-node-circle--${status}${isSelected ? " skill-node-circle--selected" : ""}`}
                      />
                      <text className="skill-node-label" y={NODE_R + 13}>
                        {item.name}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        );
      })}

      {selected && (
        <div className="skill-detail">
          <div className="skill-detail-header">
            <span className={`skill-node-status skill-node-status--${visualStatus(selected)}`}>
              {STATUS_LABEL[visualStatus(selected)]}
            </span>
            {selected.kind === "custom" && selected.skill.hasParameters && (
              <span className="skill-node-status skill-node-status--builtin">TOOL: skill_{selected.name}</span>
            )}
            <span className="skill-node-name">{selected.name}</span>
          </div>
          <p className="skill-node-description">
            {selected.kind === "builtin" ? selected.cap.description : selected.kind === "model" ? selected.description : selected.skill.description}
          </p>
          {selected.kind === "model" && <p className="skill-node-meta">Practical grade: {selected.grade}. Reference only; Llama 3.1 8B is not installed on this Mac.</p>}
          {selected.kind === "custom" && (
            <>
              <p className="skill-node-meta">
                {formatVerifiedAt(selected.skill.verifiedAt)}
                {selected.skill.hasParameters && " — it takes real arguments, so it's verified by an actual call, not on save."}
              </p>
              {selected.skill.status === "failed" && selected.skill.error && (
                <pre className="skill-node-error">{selected.skill.error}</pre>
              )}
              <pre className="skill-node-code">{selected.skill.code}</pre>
              <button
                type="button"
                className="btn"
                disabled={verifying === selected.name}
                onClick={() => void verify(selected.name)}
              >
                {verifying === selected.name ? "Verifying…" : "Verify now"}
              </button>
            </>
          )}
          {selected.kind === "builtin" && <p className="hint">Native tool, always available, nothing to verify.</p>}
        </div>
      )}

      </div>

      {skillsRoot && <p className="hint">{skillsRoot}</p>}
    </div>
  );
}

function formatVerifiedAt(verifiedAt: number | null): string {
  if (verifiedAt === null) return "Never verified";
  const seconds = Math.max(0, Math.round((Date.now() - verifiedAt) / 1000));
  if (seconds < 60) return "Verified just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Verified ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Verified ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Verified ${days}d ago`;
}
