import type { CompiledEnvelope, Fn, Key, State } from "../../types/index.js";
import { compileFormula, extractDeps } from "../../kernel/formula.js";
import { resolveFn } from "../../kernel/resolve-fn.js";
import type { EventBinding } from "../view/vnode.js";

// compileFormula always emits a CompiledEnvelope; narrow to grab its entry fn.
const formulaFn = (src: string): Fn => (compileFormula(src) as CompiledEnvelope).fn;

// ============================================================================
// Event registries — the mechanism layer the painter (raf-channel) drives.
// Two registries: per-element (listeners on vnode-rendered DOM nodes) and
// global (listeners on document / window / selector targets sourced from a
// FormulaCel). See docs/1-design/2-in-evaluation/event-registries.md.
//
// The kernel ships no DOM lib (tsconfig lib: ES2023), so this module narrows
// the host structurally: an event target is anything with add/remove
// EventListener; an element additionally exposes childNodes for the detach
// walk; the event is an opaque record we only read `.target`/`.key` off of
// inside action formulas. The painter passes real DOM nodes at runtime.
// ============================================================================

export type DomEvent = { type?: string; target?: unknown; [k: string]: unknown };
export type Handler = (event: DomEvent) => void;

export interface Listenable {
  addEventListener(type: string, fn: Handler): void;
  removeEventListener(type: string, fn: Handler): void;
}

interface ElementLike extends Listenable {
  childNodes?: ArrayLike<unknown>;
  nodeType?: number;
}

export interface AttachedListener {
  /** Last-applied binding, for diffing. */
  binding: EventBinding;
  /** The actual handler attached to the target. */
  fn: Handler;
}

export type ListenerRegistry = WeakMap<object, Map<string, AttachedListener>>;

// ── action formulas ─────────────────────────────────────────────────────────
//
// An event binding's `{ f: source }` is an ACTION, not a value. Two verbs are
// special-formed because their first operand is a cel KEY (a literal symbol),
// which the value-formula language would otherwise evaluate to the cel's
// value:
//   (set <key> <valueExpr>)        — write valueExpr's result to cel <key>
//   (dispatch <key> <argExpr>?)    — call the fn at <key> with (state, arg, event)
// Any other head is evaluated as an ordinary value formula for its side
// effects (e.g. calling a registered fn) and its result discarded.

// Split "(head a b (nested x))" into ["head", "a", "b", "(nested x)"] —
// top-level operands only, respecting nested parens and "quoted" strings.
const splitTopLevel = (source: string): string[] => {
  const s = source.trim();
  if (!s.startsWith("(") || !s.endsWith(")")) return [s];
  const inner = s.slice(1, -1);
  const parts: string[] = [];
  let depth = 0, start = 0, inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth--; continue; }
    if (depth === 0 && (c === " " || c === "\t" || c === "\n" || c === "\r")) {
      if (i > start) parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (start < inner.length) parts.push(inner.slice(start));
  return parts.filter((p) => p.length > 0);
};

// A cel-key operand may be written either as a bare symbol (set app.count …)
// or as a string literal (set "app.count" …) — both name the same cel; strip
// the quotes from the literal form.
const unquoteKey = (s: string): string =>
  s.length >= 2 && s.charCodeAt(0) === 34 && s.charCodeAt(s.length - 1) === 34
    ? s.slice(1, -1)
    : s;

// Build the value-formula record for an action: cel values/callables by key,
// plus the live DOM event under `event`.
const buildRecord = (deps: Key[], state: State, event: DomEvent): Record<string, unknown> => {
  const record: Record<string, unknown> = { event };
  for (const d of deps) {
    if (d === "event") continue;
    const cel = state.cels.get(d) as { celType: string; v: unknown; _fn?: unknown } | undefined;
    if (!cel) { record[d] = undefined; continue; }
    record[d] = cel.celType === "FormulaCel" ? cel.v : (cel._fn ?? cel.v);
  }
  return record;
};

const reportError = (label: string, err: unknown): void => {
  const c = (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console;
  c?.error?.(`[plastron-dom] ${label} failed:`, err);
};

/** Compile an action-formula source into a dispatch handler. The compile
 *  happens ONCE here (caller caches the returned closure on the
 *  AttachedListener), so a binding compiles once per install, not per event. */
export const compileAction = (source: string, state: State): Handler => {
  const parts = splitTopLevel(source);
  const head = parts[0];

  if (head === "set" && parts.length >= 3) {
    const key = unquoteKey(parts[1]!);
    const valueSrc = parts.slice(2).join(" ");
    const valueFn = formulaFn(valueSrc);
    const deps = extractDeps(valueSrc);
    return (event) => {
      try {
        const value = valueFn(buildRecord(deps, state, event));
        const set = resolveFn(state, "set");
        if (set) void Promise.resolve(set(state, key, value)).catch((e) => reportError(`set "${key}"`, e));
      } catch (e) { reportError(`set "${key}"`, e); }
    };
  }

  if (head === "dispatch" && parts.length >= 2) {
    const key = unquoteKey(parts[1]!);
    const argSrc = parts.length >= 3 ? parts.slice(2).join(" ") : undefined;
    const argFn = argSrc ? formulaFn(argSrc) : undefined;
    const deps = argSrc ? extractDeps(argSrc) : [];
    return (event) => {
      try {
        const arg = argFn ? argFn(buildRecord(deps, state, event)) : undefined;
        const fn = resolveFn(state, key);
        if (fn) void Promise.resolve(fn(state, arg, event)).catch((e) => reportError(`dispatch "${key}"`, e));
        else reportError(`dispatch "${key}"`, new Error("not registered"));
      } catch (e) { reportError(`dispatch "${key}"`, e); }
    };
  }

  // General value formula evaluated for side effects.
  const fn = formulaFn(source);
  const deps = extractDeps(source);
  return (event) => {
    try { fn(buildRecord(deps, state, event)); }
    catch (e) { reportError(`action "${source.slice(0, 40)}"`, e); }
  };
};

// ── makeListener ────────────────────────────────────────────────────────────

const extractFromTarget = (event: DomEvent, name: string): unknown => {
  const t = event.target as Record<string, unknown> | null | undefined;
  return t ? t[name] : undefined;
};

/** Build the DOM EventListener for a binding. The `{ f }` form is compiled
 *  lazily on first dispatch and the compiled handler cached on a per-listener
 *  closure cell, so the formula compiles exactly once per binding install. */
export const makeListener = (binding: EventBinding, state: State): Handler => {
  if (binding.f !== undefined) {
    const src = binding.f;
    let compiled: Handler | undefined;
    return (event) => {
      if (!compiled) compiled = compileAction(src, state);
      compiled(event);
    };
  }
  return (event) => {
    if (binding.set !== undefined) {
      let value: unknown;
      if (binding.value !== undefined) value = binding.value;
      else if (binding.extract !== undefined) value = extractFromTarget(event, binding.extract);
      else value = { type: event.type, value: extractFromTarget(event, "value") };
      const set = resolveFn(state, "set");
      if (set) void Promise.resolve(set(state, binding.set, value)).catch((e) => reportError(`set "${binding.set}"`, e));
    }
    if (binding.dispatch !== undefined) {
      const fn = resolveFn(state, binding.dispatch);
      if (fn) void Promise.resolve(fn(state, binding.payload, event)).catch((e) => reportError(`dispatch "${binding.dispatch}"`, e));
      else reportError(`dispatch "${binding.dispatch}"`, new Error("not registered"));
    }
  };
};

// ── per-element registry ──────────────────────────────────────────────────

export const attachEvents = (
  el: Listenable, events: Record<string, EventBinding>, reg: ListenerRegistry, state: State,
): void => {
  const map = reg.get(el) ?? new Map<string, AttachedListener>();
  for (const [type, binding] of Object.entries(events)) {
    const fn = makeListener(binding, state);
    el.addEventListener(type, fn);
    map.set(type, { binding: { ...binding }, fn });
  }
  if (map.size > 0) reg.set(el, map);
};

/** Apply an events delta (upsert / remove) to one element's listeners,
 *  swapping fns in place. Mirrors the legacy plastron-dom applyEventDelta. */
export const applyEventDelta = (
  el: Listenable,
  delta: { upsert?: Record<string, EventBinding>; remove?: string[] },
  reg: ListenerRegistry, state: State,
): void => {
  const map = reg.get(el) ?? new Map<string, AttachedListener>();
  if (delta.remove) {
    for (const type of delta.remove) {
      const attached = map.get(type);
      if (attached) { el.removeEventListener(type, attached.fn); map.delete(type); }
    }
  }
  if (delta.upsert) {
    for (const [type, binding] of Object.entries(delta.upsert)) {
      const attached = map.get(type);
      if (attached) el.removeEventListener(type, attached.fn);
      const fn = makeListener(binding, state);
      el.addEventListener(type, fn);
      map.set(type, { binding: { ...binding }, fn });
    }
  }
  if (map.size > 0) reg.set(el, map);
  else reg.delete(el);
};

/** Detach every listener on a node and its descendants, clearing the
 *  registry — called when a subtree is removed or replaced. */
export const detachAllListeners = (node: unknown, reg: ListenerRegistry): void => {
  const el = node as ElementLike;
  if (!el || (el.nodeType !== undefined && el.nodeType !== 1)) {
    // Non-element node with no listeners; nothing to detach.
    if (!el || typeof el.removeEventListener !== "function") return;
  }
  const map = reg.get(el);
  if (map) {
    for (const [type, attached] of map) el.removeEventListener(type, attached.fn);
    reg.delete(el);
  }
  const kids = el.childNodes;
  if (kids) for (let i = 0; i < kids.length; i++) detachAllListeners(kids[i], reg);
};

// ── global registry ─────────────────────────────────────────────────────────

/** Key: "target|event" — one listener per target-event pair. */
export type GlobalRegistry = Map<string, { spec: string; fn: Handler; target: Listenable; type: string }>;

export interface ParsedSpec { target: string; event: string; source: string; }

/** Parse "target|event|f-source". The source may itself contain "|", so only
 *  the first two separators are structural. */
export const parseSpec = (spec: string): ParsedSpec | null => {
  const i = spec.indexOf("|");
  if (i === -1) return null;
  const j = spec.indexOf("|", i + 1);
  if (j === -1) return null;
  return { target: spec.slice(0, i), event: spec.slice(i + 1, j), source: spec.slice(j + 1) };
};

export type ResolveTarget = (name: string) => Listenable | null;

/** Default target resolution against the ambient host (document / window /
 *  document.body / a selector). Returns null off-browser or when absent. */
export const defaultResolveTarget: ResolveTarget = (name) => {
  const g = globalThis as {
    document?: { body?: Listenable; querySelector?: (s: string) => Listenable | null } & Listenable;
    window?: Listenable;
  };
  if (name === "document") return g.document ?? null;
  if (name === "window") return g.window ?? null;
  if (name === "document.body") return g.document?.body ?? null;
  return g.document?.querySelector?.(name) ?? null;
};

/** Diff two listener-spec arrays into add / remove sets (string identity). */
export const diffListenerSpecs = (
  prev: readonly string[] | undefined, next: readonly string[],
): { add: string[]; remove: string[] } => {
  const prevSet = new Set(prev ?? []);
  const nextSet = new Set(next);
  const add: string[] = [];
  const remove: string[] = [];
  for (const s of next) if (!prevSet.has(s)) add.push(s);
  for (const s of prev ?? []) if (!nextSet.has(s)) remove.push(s);
  return { add, remove };
};

/** Reconcile the global registry against the next listener-spec array.
 *  Conflict policy: FIRST-WINS — if two specs in the same render name the
 *  same target|event pair, the first is kept and the rest are warned and
 *  dropped (one listener per target-event pair). */
export const applyListenerDelta = (
  prev: readonly string[] | undefined, next: readonly string[],
  reg: GlobalRegistry, state: State, resolveTarget: ResolveTarget = defaultResolveTarget,
): void => {
  const { add, remove } = diffListenerSpecs(prev, next);

  for (const spec of remove) {
    const parsed = parseSpec(spec);
    if (!parsed) continue;
    const dedupe = `${parsed.target}|${parsed.event}`;
    const entry = reg.get(dedupe);
    if (entry && entry.spec === spec) {
      entry.target.removeEventListener(entry.type, entry.fn);
      reg.delete(dedupe);
    }
  }

  for (const spec of add) {
    const parsed = parseSpec(spec);
    if (!parsed) continue;
    const dedupe = `${parsed.target}|${parsed.event}`;
    if (reg.has(dedupe)) {
      reportError(`global listener "${dedupe}"`, new Error(`duplicate target|event — first-wins, dropping "${spec}"`));
      continue;
    }
    const target = resolveTarget(parsed.target);
    if (!target) continue;
    const fn = makeListener({ f: parsed.source }, state);
    target.addEventListener(parsed.event, fn);
    reg.set(dedupe, { spec, fn, target, type: parsed.event });
  }
};
