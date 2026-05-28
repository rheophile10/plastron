// ============================================================================
// VNode — a JSON-shaped virtual-DOM tree, the output of the view-layer's
// template parser and the input to the painter (raf-channel). Pure data:
// no DOM, no closures, round-trips through dehydrate.
//
// Carried forward from the legacy `segments/plastron-dom/src/vnode.ts`
// (per the htm-view-layers / raf-channel designs) and trimmed to the core
// the plastron-simple kernel surface needs. The one substantive addition
// is the `{ f: string }` form on EventBinding — a formula-source binding
// the painter compiles lazily on first dispatch (see event-registries).
//
// tsconfig here ships no DOM lib, so this module stays free of Element /
// EventListener types; those live in the painter (apply), which narrows
// the host structurally.
// ============================================================================

export type AttrValue = string | number | boolean | null;

/** Declarative event binding carried inside a VElement's `events` bag.
 *  All four forms are JSON-shaped — they round-trip through dehydrate and
 *  carry no closures. The painter turns them into real DOM listeners. */
export interface EventBinding {
  /** Formula-source binding. The painter compiles this S-expression
   *  lazily on first dispatch and caches the closure. The primary form
   *  produced by the template parser for event slots (see the
   *  htm-view-layers "event-slot" rule). */
  f?: string;
  /** Cel key to write on the event. */
  set?: string;
  /** Fixed value to write when `set` is present. */
  value?: unknown;
  /** Read a named property off `event.target` and write it to `set`.
   *  Precedence when `set` is present: `value` > `extract` > EventInfo. */
  extract?: "value" | "checked" | "valueAsNumber" | "valueAsDate" | "files";
  /** Cel key naming a registered fn to invoke on the event. */
  dispatch?: string;
  /** Static payload passed to the dispatch fn. */
  payload?: unknown;
}

export interface VText {
  type: "text";
  text: string;
}

export interface VElement {
  type: "el";
  tag: string;
  /** Child-reconciliation hint — local to the parent's children list,
   *  UNRELATED to `cel.key`. When every child in both the old and new
   *  lists is a keyed VElement, the diff reconciles by key. */
  key?: string;
  attrs?: Record<string, AttrValue>;
  /** Inline styles, diffed and applied per-property at paint time. */
  style?: Record<string, AttrValue>;
  events?: Record<string, EventBinding>;
  children?: VNode[];
}

export type VNode = VText | VElement;

/** The view cel's output: the vnode tree, where to mount it, and the
 *  global listener specs the painter reconciles (see event-registries). */
export interface RenderSpec {
  vnode: VNode;
  mount: string | null;
  listeners: string[];
}

// ── builders ────────────────────────────────────────────────────────────────

export const text = (s: string | number | boolean): VText => ({
  type: "text",
  text: String(s),
});

// ── structural equality ───────────────────────────────────────────────────

const recordEqual = (
  a: Record<string, AttrValue> | undefined,
  b: Record<string, AttrValue> | undefined,
): boolean => {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a![k] !== b?.[k]) return false;
  return true;
};

export const bindingsEqual = (a: EventBinding, b: EventBinding): boolean =>
  a.f === b.f
  && a.set === b.set
  && Object.is(a.value, b.value)
  && a.extract === b.extract
  && a.dispatch === b.dispatch
  && Object.is(a.payload, b.payload);

const eventsEqual = (
  a: Record<string, EventBinding> | undefined,
  b: Record<string, EventBinding> | undefined,
): boolean => {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const bv = b?.[k];
    if (!bv) return false;
    if (!bindingsEqual(a![k]!, bv)) return false;
  }
  return true;
};

const childrenEqual = (
  a: VNode[] | undefined,
  b: VNode[] | undefined,
): boolean => {
  const ac = a ?? [];
  const bc = b ?? [];
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    if (!vnodeEquals(ac[i]!, bc[i]!)) return false;
  }
  return true;
};

/** Deep structural equality over two vnode trees. Fast-paths reference
 *  equality at every level so memoSafe composition (ref-stable subtrees)
 *  short-circuits in O(1). */
export const vnodeEquals = (a: VNode, b: VNode): boolean => {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.type === "text") return a.text === (b as VText).text;
  const be = b as VElement;
  if (a.tag !== be.tag) return false;
  if (a.key !== be.key) return false;
  if (!recordEqual(a.attrs, be.attrs)) return false;
  if (!recordEqual(a.style, be.style)) return false;
  if (!eventsEqual(a.events, be.events)) return false;
  return childrenEqual(a.children, be.children);
};
