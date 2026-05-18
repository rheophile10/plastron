import type { State } from "../../../plastron/src/index.js";
import type { AttrValue } from "./vnode.js";

// ============================================================================
// CSS authoring helpers + per-State managed stylesheet.
//
// Two public surfaces:
//
//   • style(rules) / rule(selector, rules) — pure-data builders. No
//     side effects; these just type the records that VElement.style or
//     a future css channel will consume.
//
//   • cn(state, rules) — atomic-CSS class-name builder. Hashes the style
//     record deterministically; if the same record has been seen before
//     it returns the cached class name; if new, it inserts a rule into
//     the install's per-State <style> element via CSSOM and returns the
//     class name.
//
// Per-State stylesheet: created by installDom (via ensureCssRegistry),
// torn down by the painter sentinel cel's _dispose (via
// disposeCssRegistry). Held in a module-scope WeakMap<State, …> so two
// installDom calls on different States don't collide. CSSStyleSheet
// reference is the only DOM-element holder in this module — JSON-vs-
// HTML invariant preserved: nothing here is reachable from cel values.
//
// This is the HN-scope cut. Post-HN, the in-plastron-dom stylesheet
// manager moves into a proper plastron-css B3 segment with its own
// `css` channel; cn becomes a re-export. Migration path is non-painful
// — same WeakMap, same hash, just moved.
// ============================================================================

export type StyleRecord = Record<string, AttrValue>;

export interface RuleRecord {
  selector: string;
  rules: StyleRecord;
}

/** Reserved cel key under which installDom registers a State-bound
 *  `cn` wrapper as a native-fn cel. Render lambdas wire it via
 *  `inputMap: { cn: CN_CEL_KEY }` and call it from within the render. */
export const CN_CEL_KEY = "__plastronDom:cn" as const;

/** Identity for inline-style records. The runtime collapses inline
 *  style records into class names via `cn`; until then, `style` is
 *  just typed pass-through. Earns its keep when callers want a typed
 *  builder rather than authoring raw objects. */
export const style = (rules: StyleRecord): StyleRecord => rules;

/** Build a rule record (selector + ruleset). Today this is a data-only
 *  helper for hosts that want to author stylesheet rules outside the
 *  vnode tree. When the plastron-css segment lands, its `css` channel
 *  will consume these records directly. */
export const rule = (selector: string, rules: StyleRecord): RuleRecord =>
  ({ selector, rules });

// ── Per-State stylesheet machinery ───────────────────────────────────────────

interface CssRegistryEntry {
  el: HTMLStyleElement;
  /** Map: hash → class name. Lookup before inserting a new rule. */
  interned: Map<string, string>;
  /** Monotonic counter for the rare hash-collision case (different
   *  rules hashing to the same value). The class name disambiguates. */
  collision: number;
}

const cssRegistry = new WeakMap<State, CssRegistryEntry>();

const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { document?: unknown }).document !== "undefined";

/** Create the per-State stylesheet entry if it doesn't exist yet.
 *  Returns true if this call created it (caller's installDom owns
 *  teardown), false if a prior installDom already created it (their
 *  installDom owns teardown — current install must NOT dispose). */
export const ensureCssRegistry = (state: State): boolean => {
  if (cssRegistry.has(state)) return false;
  if (!isBrowser) {
    // Off-browser (tests / SSR): record an empty entry so cn() can
    // still return stable class names without writing to a stylesheet.
    cssRegistry.set(state, {
      el: undefined as unknown as HTMLStyleElement,
      interned: new Map(),
      collision: 0,
    });
    return true;
  }
  const el = document.createElement("style");
  el.setAttribute("data-plastron-dom", "");
  document.head.appendChild(el);
  cssRegistry.set(state, { el, interned: new Map(), collision: 0 });
  return true;
};

export const disposeCssRegistry = (state: State): void => {
  const entry = cssRegistry.get(state);
  if (!entry) return;
  if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
  cssRegistry.delete(state);
};

// ── cn — atomic-CSS class-name builder ───────────────────────────────────────

const CSS_RESERVED = /[^A-Za-z0-9_-]/g;

/** Convert a JS-side property name (camelCase or kebab-case) to its
 *  CSS form (kebab-case). `backgroundColor` → `background-color`.
 *  Pass-through for properties already kebab-case. */
const propToCss = (k: string): string =>
  /[A-Z]/.test(k) ? k.replace(/([A-Z])/g, "-$1").toLowerCase() : k;

/** Serialize a StyleRecord to a CSS declaration block. Keys sorted so
 *  two records with the same properties in different orders produce
 *  the same declarations (and therefore the same hash). Values are
 *  written verbatim; CSS-unsafe characters in selectors / values are
 *  the caller's responsibility (the hash means most attacks at this
 *  layer would just produce a broken rule, not an injection). */
const serializeRules = (rules: StyleRecord): string => {
  const keys = Object.keys(rules).sort();
  let s = "";
  for (const k of keys) {
    const v = rules[k];
    if (v === null || v === undefined || v === false) continue;
    s += propToCss(k) + ":" + (typeof v === "string" ? v : String(v)) + ";";
  }
  return s;
};

/** djb2 hash over the canonical-serialized rules. Cheap, no deps,
 *  good enough collision resistance for ~thousands of distinct
 *  records. Returns base36 string for compact class names. */
const hashRules = (serialized: string): string => {
  let h = 5381;
  for (let i = 0; i < serialized.length; i++) {
    h = (h * 33) ^ serialized.charCodeAt(i);
  }
  // Force unsigned, then base36
  return (h >>> 0).toString(36);
};

/** Insert a rule into the install's managed <style> element and return
 *  the class name. Same rules → same class name across the whole State
 *  (interned). Off-browser, returns a stable class name without
 *  touching a stylesheet. */
export const cn = (state: State, rules: StyleRecord): string => {
  const entry = cssRegistry.get(state);
  if (!entry) {
    throw new Error(
      "cn(state, rules): installDom hasn't run on this State yet. " +
      "Call installDom (or installDomSchemas + ensureCssRegistry) first.",
    );
  }
  const serialized = serializeRules(rules);
  const hash = hashRules(serialized);
  const cached = entry.interned.get(hash);
  if (cached) return cached;

  const name = "cn-" + hash + (entry.collision ? "-" + entry.collision : "");
  const safeName = name.replace(CSS_RESERVED, "_");
  entry.interned.set(hash, safeName);

  if (entry.el && entry.el.sheet) {
    try {
      entry.el.sheet.insertRule(
        "." + safeName + " { " + serialized + " }",
        entry.el.sheet.cssRules.length,
      );
    } catch {
      // Bad rule (e.g. caller passed `null` value mid-string). Skip
      // insertion — name is still returned so the diff stays stable.
    }
  }
  return safeName;
};
