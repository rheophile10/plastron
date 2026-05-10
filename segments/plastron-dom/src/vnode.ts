import { z } from "zod";

// ========================================================================
// VNode — a JSON-shaped virtual-DOM tree. Held directly as a cel's `v`
// (no wrapper).
//
// Tree cels declare `schema: vnodeSchema` — that's how the kernel
// auto-wires `_isChanged` (vnodeEquals-driven) and `_diffFn`
// (diffVNodes-driven) onto the cel at hydrate time. No tag handler:
// VNodes are JSON, so there's no value-protocol concern (no opaque
// resource, no custom serialize). Tags are reserved for that.
//
// Two node kinds: text and element. Element nodes carry attributes,
// inline styles, declarative event bindings, and an ordered list of
// children. JSON-shape end-to-end — a VNode round-trips through hydrate
// / dehydrate / plastron-archive cleanly.
// ========================================================================

/** SchemaKey to register against state.schemas. */
export const VNODE_SCHEMA_KEY = "plastronDom:vnode" as const;

/** Live Zod schema acting as a map key. The kernel uses it to look up
 *  SchemaMetadata.isChanged and SchemaMetadata.diff at hydrate. We
 *  don't actually validate VNodes against it — they're trusted output
 *  of render lambdas — so `z.unknown()` is enough. */
export const vnodeSchema: z.ZodType = z.unknown();

/** LambdaKey of the `isChanged` fn for vnodeSchema. The kernel wires
 *  this onto every cel declaring `schema: vnodeSchema` as
 *  `cel._isChanged` at hydrate. */
export const VNODE_IS_CHANGED_KEY = "plastronDom:vnodeIsChanged" as const;

/** LambdaKey of the `diff` fn for vnodeSchema. Optional companion;
 *  when present, the kernel writes the diff to `cel._diff` on each
 *  change. plastron-dom's painter doesn't read `cel._diff` (it needs
 *  diffs against `lastApplied`, not against the previous cycle), but
 *  audit/sync/devtool consumers can. */
export const VNODE_DIFF_KEY = "plastronDom:vnodeDiff" as const;

/** LambdaKey of the `byteLength` fn for vnodeSchema. Walks the vnode
 *  tree and reports an approximate byte count for the per-cel memory
 *  reporting in plastron's perf-tracking pass. More accurate than the
 *  kernel's depth-capped recursive default (which under-counts trees
 *  deeper than 4 levels). */
export const VNODE_BYTELENGTH_KEY = "plastronDom:vnodeByteLength" as const;

export interface VText {
  type: "text";
  text: string;
}

export interface VElement {
  type: "el";
  tag: string;
  attrs?: Record<string, AttrValue>;
  /** Inline styles, applied per-property at paint time. Diffed
   *  separately from attrs so a single style change doesn't reapply
   *  the whole `style="…"` string. */
  style?: Record<string, AttrValue>;
  events?: Record<string, EventBinding>;
  children?: VNode[];
}

export type VNode = VText | VElement;

export type AttrValue = string | number | boolean | null;

export interface EventBinding {
  /** Cel key to write on event. The painter calls state.fns.get("set")
   *  with (state, key, value). When `value` is omitted, the painter
   *  writes a small EventInfo record describing the event. */
  set?: string;
  /** Fixed value to write when `set` is present. */
  value?: unknown;
  /** Lambda key in state.fns to invoke on event. The painter calls
   *  the fn with (state, payload). Use this to trigger host actions
   *  that don't fit a single cel write — lazy segment loading,
   *  navigation, anything that needs to mutate state.cels (hydrate)
   *  before firing a cycle.
   *
   *  When both `set` and `dispatch` are present, the set runs first
   *  (synchronously), then the dispatch. */
  dispatch?: string;
  /** Static payload passed to the dispatch fn. */
  payload?: unknown;
}

export interface EventInfo {
  type: string;
  /** target.value when present (form fields), else undefined. */
  value?: unknown;
  /** target.checked for checkboxes / radios. */
  checked?: boolean;
}

// ------------------------------------------------------------------------
// Builders.
// ------------------------------------------------------------------------

export const text = (s: string | number | boolean): VText => ({
  type: "text",
  text: String(s),
});

type Child = VNode | string | number | boolean;

const toChild = (c: Child): VNode =>
  typeof c === "object" && c !== null ? c : text(c);

/** Build a VElement. Props prefixed with `on` (e.g. `onClick`) become
 *  event bindings. A `style` prop holding a record becomes the inline
 *  style object. Everything else is an attribute. */
export const el = (
  tag: string,
  props?: Record<string, AttrValue | EventBinding | Record<string, AttrValue>> | null,
  ...children: Child[]
): VElement => {
  const attrs: Record<string, AttrValue> = {};
  let style: Record<string, AttrValue> | undefined;
  const events: Record<string, EventBinding> = {};
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      const isEventLike = v !== null && typeof v === "object" &&
        ("set" in (v as object) || "dispatch" in (v as object));
      if (
        k.length > 2 &&
        k.startsWith("on") &&
        k[2] === k[2]!.toUpperCase() &&
        isEventLike
      ) {
        events[k.slice(2).toLowerCase()] = v as EventBinding;
      } else if (k === "style" && v !== null && typeof v === "object" && !isEventLike) {
        style = v as Record<string, AttrValue>;
      } else {
        attrs[k] = v as AttrValue;
      }
    }
  }
  const node: VElement = { type: "el", tag };
  if (Object.keys(attrs).length > 0) node.attrs = attrs;
  if (style && Object.keys(style).length > 0) node.style = style;
  if (Object.keys(events).length > 0) node.events = events;
  if (children.length > 0) node.children = children.map(toChild);
  return node;
};

// ------------------------------------------------------------------------
// Structural equality. Used by diff for fast bailout and by installDom
// to set _isChanged on tree cels.
// ------------------------------------------------------------------------

export const vnodeEquals = (a: VNode, b: VNode): boolean => {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.type === "text") return a.text === (b as VText).text;
  const be = b as VElement;
  if (a.tag !== be.tag) return false;
  if (!recordEqual(a.attrs, be.attrs)) return false;
  if (!recordEqual(a.style, be.style)) return false;
  if (!eventsEqual(a.events, be.events)) return false;
  return childrenEqual(a.children, be.children);
};

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

const eventsEqual = (
  a: Record<string, EventBinding> | undefined,
  b: Record<string, EventBinding> | undefined,
): boolean => {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a![k]!;
    const bv = b?.[k];
    if (!bv) return false;
    if (!bindingsEqual(av, bv)) return false;
  }
  return true;
};

export const bindingsEqual = (a: EventBinding, b: EventBinding): boolean =>
  a.set === b.set
  && Object.is(a.value, b.value)
  && a.dispatch === b.dispatch
  && Object.is(a.payload, b.payload);

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

// ------------------------------------------------------------------------
// Byte-length estimation for the perf-tracking accountant. Walks the
// tree once and approximates retained bytes — UTF-16 string costs
// (2 bytes/char) plus per-node and per-record object overheads. Fixed
// constants are intentionally fuzzy: this is a relative reporting tool,
// not a heap auditor.
// ------------------------------------------------------------------------

const NODE_OVERHEAD     = 24;   // per object hidden class + slot pointers
const KEY_OVERHEAD      = 8;    // per record entry: name pointer + value slot
const ARRAY_OVERHEAD    = 24;
const PRIMITIVE_BYTES   = 8;    // number / boolean / null

const recordBytes = (r: Record<string, unknown> | undefined): number => {
  if (!r) return 0;
  let s = NODE_OVERHEAD;
  for (const k of Object.keys(r)) {
    s += 2 * k.length + KEY_OVERHEAD;
    const v = r[k];
    if (typeof v === "string") s += 2 * v.length;
    else                       s += PRIMITIVE_BYTES;
  }
  return s;
};

const eventsBytes = (e: Record<string, EventBinding> | undefined): number => {
  if (!e) return 0;
  let s = NODE_OVERHEAD;
  for (const k of Object.keys(e)) {
    s += 2 * k.length + KEY_OVERHEAD;
    const b = e[k]!;
    s += NODE_OVERHEAD;
    if (b.set)      s += 2 * b.set.length;
    if (b.dispatch) s += 2 * b.dispatch.length;
    // value / payload — treat as 8 if primitive, else best-effort 32.
    if ("value"   in b) s += typeof b.value   === "string" ? 2 * (b.value as string).length : 32;
    if ("payload" in b) s += typeof b.payload === "string" ? 2 * (b.payload as string).length : 32;
  }
  return s;
};

export const vnodeByteLength = (n: VNode | null | undefined): number => {
  if (n == null) return 0;
  if (n.type === "text") return NODE_OVERHEAD + 2 * n.text.length;
  let s = NODE_OVERHEAD + 2 * n.tag.length;
  s += recordBytes(n.attrs);
  s += recordBytes(n.style);
  s += eventsBytes(n.events);
  if (n.children && n.children.length > 0) {
    s += ARRAY_OVERHEAD;
    for (const c of n.children) s += vnodeByteLength(c);
  }
  return s;
};

