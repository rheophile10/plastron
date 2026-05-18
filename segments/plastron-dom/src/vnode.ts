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
  /** Child-reconciliation hint. UNRELATED to `cel.key` — this is a
   *  string id used only by `diffVNodes` when reconciling a parent's
   *  children list, to match "the same logical element across
   *  renders" by identity instead of position. When every child in
   *  both old and new children lists is a VElement with a defined
   *  `key`, the diff switches to keyed reconciliation and emits a
   *  `reconcile` ChildPatch. Mixed or missing keys → positional
   *  diff (the default). */
  key?: string;
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
   *  with (state, key, value). When neither `value` nor `extract` is
   *  set, the painter writes a small EventInfo record describing the
   *  event (rarely what you want for controlled inputs — use `extract`). */
  set?: string;
  /** Fixed value to write when `set` is present. */
  value?: unknown;
  /** Read a property off `event.target` and write it to the cel named
   *  by `set`. Lets controlled inputs route their text / checked /
   *  numeric value to a cel without a dispatch handler.
   *
   *  Precedence when `set` is present: `value` > `extract` > EventInfo. */
  extract?:
    | "value"
    | "checked"
    | "valueAsNumber"
    | "valueAsDate"
    | "files";
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
  let key: string | undefined;
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
      } else if (k === "key" && typeof v === "string") {
        key = v;
      } else {
        attrs[k] = v as AttrValue;
      }
    }
  }
  const node: VElement = { type: "el", tag };
  if (key !== undefined) node.key = key;
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
  if (a.key !== be.key) return false;
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
  && a.extract === b.extract
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

// ------------------------------------------------------------------------
// Authoring helpers — pure data builders + binding shorthands. Not
// load-bearing; every callsite can be written manually. They earn their
// keep by collapsing patterns that show up in every render lambda.
// ------------------------------------------------------------------------

export type ClassPart = string | number | false | null | undefined;

/** clsx-style className builder. Drops falsy parts, stringifies truthy
 *  ones, joins with " ". Empty input → "". Helper avoids the
 *  `class: cond ? "x" : null` pattern that pushes `null` through the
 *  diff machinery (apply.ts removes the attr correctly, but matching
 *  on null-vs-string-vs-empty across cycles is noisier than necessary). */
export const cx = (...parts: ClassPart[]): string => {
  let s = "";
  for (const p of parts) {
    if (!p) continue;
    s = s.length === 0 ? String(p) : s + " " + String(p);
  }
  return s;
};

/** Conditional child. Returns `factory()` if `cond` is truthy, else
 *  `null`. Children pipelines (`el(...children)`) already drop null,
 *  so this composes naturally. Factory rather than eager value so
 *  callers don't allocate vnode subtrees they're going to discard. */
export const when = <T>(cond: unknown, factory: () => T): T | null =>
  cond ? factory() : null;

/** Pretty-print a value for display in a vnode. Lifted from
 *  plastron-sheet's parse.ts; same shape every render lambda needs
 *  when it has to put a `v` straight into a `<td>`. Integers stay
 *  bare; finite floats get two decimals; non-finite numbers fall to
 *  "—"; null / undefined / "" all render as the empty string. */
export const displayValue = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") {
    return Number.isFinite(v)
      ? (Number.isInteger(v) ? String(v) : v.toFixed(2))
      : "—";
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
};

// ── EventBinding builders ──────────────────────────────────────────────

/** Build a `dispatch:` binding. Use for buttons that call into a
 *  registered state.fn, optionally with a static payload. */
export const onClick = (
  handler: string,
  payload?: unknown,
): EventBinding =>
  payload === undefined ? { dispatch: handler } : { dispatch: handler, payload };

/** Build a `set:` binding with a static value. Use for clicks that
 *  write a fixed value to a cel. */
export const onSet = (
  target: string,
  value?: unknown,
): EventBinding =>
  value === undefined ? { set: target } : { set: target, value };

// ── Form-input binding builders (use `extract`) ────────────────────────

/** Write `event.target.value` (the input's text) to a cel. Pair with
 *  `value:` on the same vnode for a controlled text input. */
export const bindValue = (key: string): EventBinding =>
  ({ set: key, extract: "value" });

/** Write `event.target.checked` (for checkboxes / radios) to a cel. */
export const bindChecked = (key: string): EventBinding =>
  ({ set: key, extract: "checked" });

/** Write `event.target.valueAsNumber` (for `<input type="number">` /
 *  `<input type="range">`) to a cel. Yields `NaN` for empty inputs. */
export const bindNumber = (key: string): EventBinding =>
  ({ set: key, extract: "valueAsNumber" });

/** Write `event.target.files` (a FileList) to a cel for
 *  `<input type="file">`. */
export const bindFiles = (key: string): EventBinding =>
  ({ set: key, extract: "files" });

/** Compound helper for the standard controlled-text-input pattern.
 *  Returns the props bag wired to write the input's text into `celKey`
 *  on every `input` event, with `value` pre-filled from the cel's
 *  current value.
 *
 *  Use: `el("input", inputBind("draft", inputs.draft))` instead of
 *  authoring the inline `{ value, onInput: { set: ..., extract: "value" } }`. */
export const inputBind = (
  celKey: string,
  value: unknown,
): { value: AttrValue; onInput: EventBinding } =>
  ({ value: value as AttrValue, onInput: bindValue(celKey) });

// ------------------------------------------------------------------------

export const vnodeByteLength = (n: VNode | null | undefined): number => {
  if (n == null) return 0;
  if (n.type === "text") return NODE_OVERHEAD + 2 * n.text.length;
  let s = NODE_OVERHEAD + 2 * n.tag.length;
  if (n.key) s += 2 * n.key.length + KEY_OVERHEAD;
  s += recordBytes(n.attrs);
  s += recordBytes(n.style);
  s += eventsBytes(n.events);
  if (n.children && n.children.length > 0) {
    s += ARRAY_OVERHEAD;
    for (const c of n.children) s += vnodeByteLength(c);
  }
  return s;
};

