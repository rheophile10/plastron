import type { State } from "../../types/index.js";
import type { AttrValue, VElement, VNode, VText } from "../view/vnode.js";
import type { Patch, PatchEl } from "./diff.js";
import {
  attachEvents, applyEventDelta, detachAllListeners,
  type ListenerRegistry, type Listenable,
} from "./events.js";

// ============================================================================
// applyPatch — consume a Patch and mutate the DOM. The only DOM-touching code
// in the segment, gated by the painter on isBrowser. Carried forward from the
// legacy segments/plastron-dom/src/apply.ts, adapted for plastron-simple:
//   • the document is injected (DocLike) rather than a global, so tests can
//     drive it with a structural fake and the kernel keeps its no-DOM lib;
//   • per-element listener bookkeeping delegates to dom/events.ts (which owns
//     makeListener and the { f } action form).
//
// The replace-target / attribute-merge mode from the legacy painter is out of
// scope for v1 — the view mounts into a root via replaceChildren.
// ============================================================================

interface NodeLike { nodeType: number; }
interface TextLike extends NodeLike { data: string; }
interface ElementLike extends NodeLike, Listenable {
  tagName?: string;
  value?: string;
  childNodes: ArrayLike<NodeLike>;
  firstChild: NodeLike | null;
  lastChild: NodeLike | null;
  style?: { setProperty(p: string, v: string): void; removeProperty(p: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(c: NodeLike): NodeLike;
  replaceChild(n: NodeLike, old: NodeLike): NodeLike;
  removeChild(c: NodeLike): NodeLike;
  insertBefore(n: NodeLike, ref: NodeLike | null): NodeLike;
  replaceChildren(...c: NodeLike[]): void;
}

export interface DocLike {
  createElement(tag: string): ElementLike;
  createTextNode(s: string): TextLike;
}

export const applyPatch = (
  target: ElementLike,
  mounted: NodeLike | null,
  patch: Patch,
  reg: ListenerRegistry,
  state: State,
  doc: DocLike,
): NodeLike | null => {
  switch (patch.kind) {
    case "noop":
      return mounted;
    case "init":
    case "replace": {
      if (mounted) detachAllListeners(mounted, reg);
      const fresh = createNode(patch.node, reg, state, doc);
      target.replaceChildren(fresh);
      return fresh;
    }
    case "text": {
      if (mounted && mounted.nodeType === 3) { (mounted as TextLike).data = patch.text; return mounted; }
      return mounted;
    }
    case "el": {
      if (!mounted || mounted.nodeType !== 1) return mounted;
      applyElPatch(mounted as ElementLike, patch, reg, state, doc);
      return mounted;
    }
  }
};

const applyElPatch = (
  el: ElementLike, patch: PatchEl, reg: ListenerRegistry, state: State, doc: DocLike,
): void => {
  if (patch.attrs) applyAttrDelta(el, patch.attrs);
  if (patch.style) applyStyleDelta(el, patch.style);
  if (patch.events) applyEventDelta(el, patch.events, reg, state);
  if (!patch.children) return;

  for (const op of patch.children) {
    switch (op.op) {
      case "patch": {
        const child = el.childNodes[op.index];
        if (!child) continue;
        const next = applyPatchToChild(child, op.patch, reg, state, doc);
        if (next && next !== child) el.replaceChild(next, child);
        break;
      }
      case "appendMany":
        for (const v of op.nodes) el.appendChild(createNode(v, reg, state, doc));
        break;
      case "trim":
        for (let i = 0; i < op.count; i++) {
          const last = el.lastChild;
          if (!last) break;
          detachAllListeners(last, reg);
          el.removeChild(last);
        }
        break;
      case "reconcile":
        applyReconcile(el, op.entries, reg, state, doc);
        break;
    }
  }
};

const applyReconcile = (
  el: ElementLike,
  entries: Array<{ kind: "keep"; fromIndex: number; patch: Patch } | { kind: "mount"; node: VNode }>,
  reg: ListenerRegistry, state: State, doc: DocLike,
): void => {
  // Phase 1: snapshot + drop children not kept.
  const snapshot: NodeLike[] = [];
  for (let i = 0; i < el.childNodes.length; i++) snapshot.push(el.childNodes[i]!);
  const survivors = new Set<number>();
  for (const e of entries) if (e.kind === "keep") survivors.add(e.fromIndex);
  for (let i = 0; i < snapshot.length; i++) {
    if (!survivors.has(i)) { detachAllListeners(snapshot[i]!, reg); el.removeChild(snapshot[i]!); }
  }

  // Build desired order + source-index vector (-1 = fresh mount).
  const newOrder: NodeLike[] = new Array(entries.length);
  const sourceIdx: number[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind === "keep") { newOrder[i] = snapshot[e.fromIndex]!; sourceIdx[i] = e.fromIndex; }
    else { newOrder[i] = createNode(e.node, reg, state, doc); sourceIdx[i] = -1; }
  }

  // Phase 2: reorder right-to-left, moving only non-LIS positions.
  const stable = lisPositions(sourceIdx);
  let anchor: NodeLike | null = null;
  for (let i = newOrder.length - 1; i >= 0; i--) {
    const node = newOrder[i]!;
    if (stable.has(i)) anchor = node;
    else { el.insertBefore(node, anchor); anchor = node; }
  }

  // Phase 3: apply sub-patches in place.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind !== "keep" || e.patch.kind === "noop") continue;
    const node = newOrder[i]!;
    const result = applyPatchToChild(node, e.patch, reg, state, doc);
    if (result && result !== node) el.replaceChild(result, node);
  }
};

const applyPatchToChild = (
  node: NodeLike, patch: Patch, reg: ListenerRegistry, state: State, doc: DocLike,
): NodeLike | null => {
  switch (patch.kind) {
    case "noop": return node;
    case "init":
    case "replace": detachAllListeners(node, reg); return createNode(patch.node, reg, state, doc);
    case "text": if (node.nodeType === 3) { (node as TextLike).data = patch.text; } return node;
    case "el": if (node.nodeType === 1) applyElPatch(node as ElementLike, patch, reg, state, doc); return node;
  }
};

const createNode = (v: VNode, reg: ListenerRegistry, state: State, doc: DocLike): NodeLike => {
  if (v.type === "text") return doc.createTextNode((v as VText).text);
  const ve = v as VElement;
  const el = doc.createElement(ve.tag);
  if (ve.attrs) for (const [k, val] of Object.entries(ve.attrs)) writeAttr(el, k, val);
  if (ve.style) for (const [k, val] of Object.entries(ve.style)) writeStyle(el, k, val);
  if (ve.events) attachEvents(el, ve.events, reg, state);
  if (ve.children) for (const c of ve.children) el.appendChild(createNode(c, reg, state, doc));
  return el;
};

const writeAttr = (el: ElementLike, name: string, value: AttrValue): void => {
  if (name === "value" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const next = value === null || value === undefined || value === false ? "" : String(value);
    if (el.value !== next) el.value = next;
  }
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else if (value === true) el.setAttribute(name, "");
  else el.setAttribute(name, String(value));
};

const applyAttrDelta = (el: ElementLike, delta: { set?: Record<string, AttrValue>; remove?: string[] }): void => {
  if (delta.remove) for (const name of delta.remove) el.removeAttribute(name);
  if (delta.set) for (const [name, value] of Object.entries(delta.set)) writeAttr(el, name, value);
};

const writeStyle = (el: ElementLike, prop: string, value: AttrValue): void => {
  const style = el.style;
  if (!style) return;
  if (value === null || value === undefined || value === false) style.removeProperty(prop);
  else style.setProperty(prop, String(value));
};

const applyStyleDelta = (el: ElementLike, delta: { set?: Record<string, AttrValue>; remove?: string[] }): void => {
  const style = el.style;
  if (!style) return;
  if (delta.remove) for (const prop of delta.remove) style.removeProperty(prop);
  if (delta.set) for (const [prop, value] of Object.entries(delta.set)) writeStyle(el, prop, value);
};

// Longest-increasing-subsequence over `arr` (−1 = never in LIS). Returns the
// set of positions whose kept node is already in correct relative order, so
// reconcile phase 2 only moves the rest. Standard patience-sort + parents.
const lisPositions = (arr: number[]): Set<number> => {
  const n = arr.length;
  const result = new Set<number>();
  if (n === 0) return result;
  const tails: number[] = [];
  const tailsIdx: number[] = [];
  const parent = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = arr[i]!;
    if (v === -1) continue;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (tails[mid]! < v) lo = mid + 1; else hi = mid; }
    if (lo === tails.length) { tails.push(v); tailsIdx.push(i); }
    else { tails[lo] = v; tailsIdx[lo] = i; }
    parent[i] = lo > 0 ? tailsIdx[lo - 1]! : -1;
  }
  if (tailsIdx.length === 0) return result;
  let cur: number | undefined = tailsIdx[tailsIdx.length - 1];
  while (cur !== undefined && cur !== -1) { result.add(cur); cur = parent[cur]; }
  return result;
};
