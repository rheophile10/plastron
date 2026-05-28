import {
  bindingsEqual, vnodeEquals,
  type AttrValue, type EventBinding, type VElement, type VNode, type VText,
} from "../view/vnode.js";

// ============================================================================
// VNode diff — produces a JSON-shaped Patch describing what would change if
// `next` replaced `prev`. Pure data: no DOM, no closures. Carried forward
// from the legacy segments/plastron-dom/src/diff.ts (per raf-channel.md),
// reading the plastron-simple vnode types.
//
// Children diff is positional by default; when BOTH lists are entirely keyed
// VElements it switches to keyed reconciliation (matching by `key` across
// renders so reorders / insertions / removals reuse nodes). A keyed reconcile
// that turns out to be all-in-place downgrades to positional patches so the
// cheap path stays cheap.
//
// Reference equality is checked first at every level — the memoSafe-
// composition payoff: a ref-stable subtree bails out in O(1).
// ============================================================================

export type Patch = PatchNoop | PatchInit | PatchReplace | PatchText | PatchEl;

export interface PatchNoop { kind: "noop"; }
export interface PatchInit { kind: "init"; node: VNode; }
export interface PatchReplace { kind: "replace"; node: VNode; }
export interface PatchText { kind: "text"; text: string; }
export interface PatchEl {
  kind: "el";
  attrs?: { set?: Record<string, AttrValue>; remove?: string[] };
  style?: { set?: Record<string, AttrValue>; remove?: string[] };
  events?: { upsert?: Record<string, EventBinding>; remove?: string[] };
  children?: ChildPatch[];
}

export type ChildPatch =
  | { op: "patch"; index: number; patch: Patch }
  | { op: "appendMany"; nodes: VNode[] }
  | { op: "trim"; count: number }
  | { op: "reconcile"; entries: ReconcileEntry[] };

export type ReconcileEntry =
  | { kind: "keep"; fromIndex: number; patch: Patch }
  | { kind: "mount"; node: VNode };

const NOOP: PatchNoop = { kind: "noop" };

export const isNoop = (p: Patch): boolean => p.kind === "noop";

export const diffVNodes = (prev: VNode | null, next: VNode): Patch => {
  if (prev === null) return { kind: "init", node: next };
  if (prev === next) return NOOP;                 // ref-eq subtree bail-out
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
  if (a) for (const k of Object.keys(a)) if (!b || !(k in b)) remove.push(k);
  if (b) for (const [k, v] of Object.entries(b)) { if (a && a[k] === v) continue; set[k] = v; }
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
  if (a) for (const k of Object.keys(a)) if (!b || !(k in b)) remove.push(k);
  if (b) for (const [type, binding] of Object.entries(b)) {
    const prev = a?.[type];
    if (prev && bindingsEqual(prev, binding)) continue;
    upsert[type] = binding;
  }
  const hasUpsert = Object.keys(upsert).length > 0;
  const hasRemove = remove.length > 0;
  if (!hasUpsert && !hasRemove) return null;
  const out: { upsert?: Record<string, EventBinding>; remove?: string[] } = {};
  if (hasUpsert) out.upsert = upsert;
  if (hasRemove) out.remove = remove;
  return out;
};

const diffChildren = (a: VNode[] | undefined, b: VNode[] | undefined): ChildPatch[] => {
  const oc = a ?? [];
  const nc = b ?? [];
  if (allKeyedElements(oc) && allKeyedElements(nc)) {
    return diffChildrenKeyed(oc as VElement[], nc as VElement[]);
  }
  return diffChildrenPositional(oc, nc);
};

const allKeyedElements = (c: VNode[]): boolean => {
  if (c.length === 0) return false;
  for (const child of c) {
    if (child.type !== "el") return false;
    if (typeof (child as VElement).key !== "string") return false;
  }
  return true;
};

const diffChildrenPositional = (oc: VNode[], nc: VNode[]): ChildPatch[] => {
  const ops: ChildPatch[] = [];
  const min = Math.min(oc.length, nc.length);
  for (let i = 0; i < min; i++) {
    const sub = diffVNodes(oc[i]!, nc[i]!);
    if (sub.kind !== "noop") ops.push({ op: "patch", index: i, patch: sub });
  }
  if (nc.length > oc.length) ops.push({ op: "appendMany", nodes: nc.slice(oc.length) });
  else if (oc.length > nc.length) ops.push({ op: "trim", count: oc.length - nc.length });
  return ops;
};

const diffChildrenKeyed = (oc: VElement[], nc: VElement[]): ChildPatch[] => {
  const oldByKey = new Map<string, { index: number; node: VElement }>();
  for (let i = 0; i < oc.length; i++) oldByKey.set(oc[i]!.key!, { index: i, node: oc[i]! });

  const entries: ReconcileEntry[] = [];
  for (let i = 0; i < nc.length; i++) {
    const newChild = nc[i]!;
    const match = oldByKey.get(newChild.key!);
    if (match) {
      entries.push({ kind: "keep", fromIndex: match.index, patch: diffVNodes(match.node, newChild) });
      oldByKey.delete(newChild.key!);
    } else {
      entries.push({ kind: "mount", node: newChild });
    }
  }

  // Downgrade pure in-place updates (no reorder/add/remove) to positional ops.
  let inPlace = entries.length === oc.length;
  if (inPlace) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.kind !== "keep" || e.fromIndex !== i) { inPlace = false; break; }
    }
  }
  if (inPlace) {
    const ops: ChildPatch[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as { kind: "keep"; fromIndex: number; patch: Patch };
      if (e.patch.kind !== "noop") ops.push({ op: "patch", index: i, patch: e.patch });
    }
    return ops;
  }
  return [{ op: "reconcile", entries }];
};
