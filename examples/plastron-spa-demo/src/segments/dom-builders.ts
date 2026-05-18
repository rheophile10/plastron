import {
  bindValue, el, onClick, onSet, text, type VNode,
} from "../../../../segments/plastron-dom/src/index.js";
import type { SegmentBundle } from "./counter.js";

// ========================================================================
// dom-builders — function values exposed as cels so formulas can
// compose VNodes via `(dom "tag" props children…)` syntax.
//
// The formula compiler's S-expression evaluator looks up the head of
// each list in `inputs[head]`; when that's a function, it's called
// with the args. So a cel like
//
//   { l: "f", f: '(dom "section" null (text "hi"))', inputMap: {…} }
//
// pulls `dom` and `text` from the dom-builders cels (auto-wired into
// the consuming cel's inputMap by the formula compiler's extractDeps)
// and runs them with the literal args. No new operators, no kernel
// changes — just function-valued cels that come along for the ride.
//
// Builders:
//   dom(tag?, props?, ...children)   — primary element constructor;
//                                       tag defaults to "div" when
//                                       null/undefined
//   text(s)                          — text node
//   obj(...kvPairs)                  — record builder (formulas can't
//                                       construct objects literally)
//   onSet(targetCelKey, value?)      — event binding {set, value?}
//   onDispatch(lambdaKey, payload?)  — event binding {dispatch, payload?}
//   concat(...args)                  — string concat (formulas can't
//                                       interpolate strings literally)
//   ifx(cond, then, else)            — conditional (eager — both
//                                       branches evaluate; only the
//                                       picked one ends up in the tree)
//   eq(a, b) / neq(a, b)             — equality
//
// "ifx" rather than "if" because some downstream tooling (linters,
// formatters) special-cases the bare word; keep formulas resilient to
// that by avoiding the JS reserved-word collision.
// ========================================================================

type AnyChild = VNode | string | number | boolean | null | undefined;

const isVNode = (v: unknown): v is VNode =>
  !!v && typeof v === "object" && "type" in (v as object);

const looksLikeProps = (v: unknown): v is Record<string, unknown> =>
  v !== null && v !== undefined
  && typeof v === "object"
  && !isVNode(v)
  && !Array.isArray(v);

const toChildNode = (c: unknown): VNode | null => {
  if (c === null || c === undefined) return null;
  if (typeof c === "string" || typeof c === "number" || typeof c === "boolean") {
    return text(String(c));
  }
  if (isVNode(c)) return c;
  return null;  // unknown shape — drop rather than crash the render
};

// dom(tag?, props?, ...children).
//   • tag null / undefined / omitted → "div"
//   • props null / undefined → no props
//   • children: strings/numbers/booleans wrapped via text(); vnodes
//     pass through; null/undefined dropped
//
// The first-arg dispatch (props vs child) the per-tag wrappers used
// is gone — with `dom` taking tag explicitly, the second arg is
// unambiguously props.
const dom = (
  tag?: unknown,
  props?: unknown,
  ...children: AnyChild[]
): VNode => {
  const t = (typeof tag === "string" && tag.length > 0) ? tag : "div";
  const p = looksLikeProps(props) ? props : null;
  const kids = children
    .map(toChildNode)
    .filter((c): c is VNode => c !== null);
  return el(t, p as Parameters<typeof el>[1], ...kids);
};

const obj = (...kv: unknown[]): Record<string, unknown> => {
  const r: Record<string, unknown> = {};
  for (let i = 0; i < kv.length - 1; i += 2) {
    const k = kv[i];
    if (typeof k !== "string") {
      throw new Error(`obj: expected string key at position ${i}, got ${typeof k}`);
    }
    r[k] = kv[i + 1];
  }
  return r;
};

// onSet / onDispatch — re-exported from plastron-dom (onClick there).
// Kept under the formula-side name `onDispatch` since formulas in
// counter.ts / weather.ts reference it that way.
const onDispatch = onClick;

const concat = (...args: unknown[]): string => args.map((a) => String(a ?? "")).join("");

const ifFn = (cond: unknown, then: unknown, otherwise: unknown): unknown =>
  cond ? then : otherwise;

const eqFn = (a: unknown, b: unknown): boolean => a === b;
const neqFn = (a: unknown, b: unknown): boolean => a !== b;

const SEGMENT = "dom-builders";

export const domBuildersSegment: SegmentBundle = {
  segment: {
    key: SEGMENT,
    cels: [
      { key: "dom",        v: dom,        segment: SEGMENT },
      { key: "text",       v: text,       segment: SEGMENT },
      { key: "obj",        v: obj,        segment: SEGMENT },
      { key: "onSet",      v: onSet,      segment: SEGMENT },
      { key: "onDispatch", v: onDispatch, segment: SEGMENT },
      { key: "bindValue",  v: bindValue,  segment: SEGMENT },
      { key: "concat",     v: concat,     segment: SEGMENT },
      { key: "ifx",        v: ifFn,       segment: SEGMENT },
      { key: "eq",         v: eqFn,       segment: SEGMENT },
      { key: "neq",        v: neqFn,      segment: SEGMENT },
    ],
  },
  fns: new Map(),  // no lambdas, only value cels
};
