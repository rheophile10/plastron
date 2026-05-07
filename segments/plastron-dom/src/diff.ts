import {
  bindingsEqual, vnodeEquals,
  type AttrValue, type EventBinding, type VElement, type VNode, type VText,
} from "./vnode.js";

// ========================================================================
// VNode diff — produces a JSON-shaped Patch describing what would change
// if `next` replaced `prev` in the DOM. Pure data: no DOM, no closures.
//
// The Patch is graph-resident — it lives at the cel value of
// `__plastronDom:patch:<rootKey>` so a host can inspect, log, snapshot,
// or replay it. The painter consumes it at rAF time and applies via
// applyPatch (in apply.ts).
//
// Semantic kinds:
//   noop      — trees are structurally identical
//   init      — first paint; mount the whole tree fresh
//   replace   — type / tag mismatch; swap the whole subtree
//   text      — same node is text; only the text changed
//   el        — same tag; sub-changes to attrs, style, events, children
//
// Children diff is positional, not keyed. Keyed reconciliation (using a
// `key?` prop on VElement) is a future change and would emit a different
// shape of ChildPatch ops.
// ========================================================================

export type Patch =
  | PatchNoop
  | PatchInit
  | PatchReplace
  | PatchText
  | PatchEl;

export interface PatchNoop {
  kind: "noop";
}

export interface PatchInit {
  kind: "init";
  node: VNode;
}

export interface PatchReplace {
  kind: "replace";
  node: VNode;
}

export interface PatchText {
  kind: "text";
  text: string;
}

export interface PatchEl {
  kind: "el";
  attrs?: { set?: Record<string, AttrValue>; remove?: string[] };
  style?: { set?: Record<string, AttrValue>; remove?: string[] };
  events?: { upsert?: Record<string, EventBinding>; remove?: string[] };
  children?: ChildPatch[];
}

export type ChildPatch =
  /** Recurse on the existing child at `index`. */
  | { op: "patch"; index: number; patch: Patch }
  /** Append these new children to the end. */
  | { op: "appendMany"; nodes: VNode[] }
  /** Remove the last `count` children. */
  | { op: "trim"; count: number };

const NOOP: PatchNoop = { kind: "noop" };

export const isNoop = (p: Patch): boolean => p.kind === "noop";

export const diffVNodes = (prev: VNode | null, next: VNode): Patch => {
  if (prev === null) return { kind: "init", node: next };
  if (prev === next) return NOOP;
  if (vnodeEquals(prev, next)) return NOOP;
  if (prev.type !== next.type) return { kind: "replace", node: next };

  if (next.type === "text") {
    const p = prev as VText;
    if (p.text === next.text) return NOOP;
    return { kind: "text", text: next.text };
  }

  const p = prev as VElement;
  const n = next;
  if (p.tag !== n.tag) return { kind: "replace", node: n };

  const out: PatchEl = { kind: "el" };

  const attrs = diffRecord(p.attrs, n.attrs);
  if (attrs) out.attrs = attrs;

  const style = diffRecord(p.style, n.style);
  if (style) out.style = style;

  const events = diffEvents(p.events, n.events);
  if (events) out.events = events;

  const children = diffChildren(p.children, n.children);
  if (children.length > 0) out.children = children;

  if (!out.attrs && !out.style && !out.events && !out.children) return NOOP;
  return out;
};

const diffRecord = (
  a: Record<string, AttrValue> | undefined,
  b: Record<string, AttrValue> | undefined,
): { set?: Record<string, AttrValue>; remove?: string[] } | null => {
  const set: Record<string, AttrValue> = {};
  const remove: string[] = [];
  if (a) {
    for (const k of Object.keys(a)) {
      if (!b || !(k in b)) remove.push(k);
    }
  }
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      if (a && a[k] === v) continue;
      set[k] = v;
    }
  }
  const hasSet = Object.keys(set).length > 0;
  const hasRemove = remove.length > 0;
  if (!hasSet && !hasRemove) return null;
  const out: { set?: Record<string, AttrValue>; remove?: string[] } = {};
  if (hasSet) out.set = set;
  if (hasRemove) out.remove = remove;
  return out;
};

const diffEvents = (
  a: Record<string, EventBinding> | undefined,
  b: Record<string, EventBinding> | undefined,
): { upsert?: Record<string, EventBinding>; remove?: string[] } | null => {
  const upsert: Record<string, EventBinding> = {};
  const remove: string[] = [];
  if (a) {
    for (const k of Object.keys(a)) {
      if (!b || !(k in b)) remove.push(k);
    }
  }
  if (b) {
    for (const [type, binding] of Object.entries(b)) {
      const prev = a?.[type];
      if (prev && bindingsEqual(prev, binding)) continue;
      upsert[type] = binding;
    }
  }
  const hasUpsert = Object.keys(upsert).length > 0;
  const hasRemove = remove.length > 0;
  if (!hasUpsert && !hasRemove) return null;
  const out: { upsert?: Record<string, EventBinding>; remove?: string[] } = {};
  if (hasUpsert) out.upsert = upsert;
  if (hasRemove) out.remove = remove;
  return out;
};

const diffChildren = (
  a: VNode[] | undefined,
  b: VNode[] | undefined,
): ChildPatch[] => {
  const oc = a ?? [];
  const nc = b ?? [];
  const ops: ChildPatch[] = [];
  const min = Math.min(oc.length, nc.length);

  for (let i = 0; i < min; i++) {
    const sub = diffVNodes(oc[i]!, nc[i]!);
    if (sub.kind !== "noop") ops.push({ op: "patch", index: i, patch: sub });
  }
  if (nc.length > oc.length) {
    ops.push({ op: "appendMany", nodes: nc.slice(oc.length) });
  } else if (oc.length > nc.length) {
    ops.push({ op: "trim", count: oc.length - nc.length });
  }
  return ops;
};
