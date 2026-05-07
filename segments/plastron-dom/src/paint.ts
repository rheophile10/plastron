import type { Fn, State } from "../../../plastron/src/index.js";
import { applyPatch, detachAllListeners, type ListenerRegistry } from "./apply.js";
import type { Patch } from "./diff.js";

// ========================================================================
// Painter — rAF-batched dispatcher.
//
// The painter no longer computes diffs. It owns three pieces of state:
//
//   • dirty       : Set<rootKey>  — roots scheduled to paint this rAF
//   • mounted     : Map<rootKey, Node | null> — current root child node
//   • listeners   : WeakMap<Element, Map<eventType, AttachedListener>>
//
// At rAF flush, for each dirty root, the painter:
//   1. Reads `state.cels.get(patchCelKey).v` — a Patch produced by the
//      patch cel during runCascade.
//   2. Calls applyPatch(target, mounted, patch, listeners, state, setFn).
//   3. Notifies the per-root `onApplied` callback so the patch fn's
//      closure can advance its `lastApplied` reference. This is what
//      keeps the next cycle's diff against the actual DOM state, not
//      against whatever was last seen in the cel.
// ========================================================================

export interface DomRoot {
  /** CSS selector used at first paint to locate the mount target. Either
   *  `selector` or `element` must be present. */
  selector?: string;
  /** Pre-resolved mount target. Wins over `selector`. */
  element?: Element;
  /** Cel key whose value (a Patch) the painter applies. */
  patchCel: string;
}

export interface PainterRoot extends DomRoot {
  /** Called after applyPatch resolves, with the patch that was applied.
   *  Used by the patch fn's closure to advance lastApplied. */
  onApplied: (patch: Patch) => void;
}

export interface Painter {
  schedule: (rootKey: string) => void;
  scheduleAll: () => void;
  /** Force-resolve any pending rAF synchronously. Useful in tests. */
  flushNow: () => void;
  /** Tear down all listeners and clear mounted state. Idempotent. */
  dispose: () => void;
}

const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { document?: unknown }).document !== "undefined";

const raf =
  isBrowser && typeof requestAnimationFrame === "function"
    ? requestAnimationFrame.bind(globalThis)
    : (cb: FrameRequestCallback): number =>
        setTimeout(() => cb(performance.now?.() ?? Date.now()), 16) as unknown as number;

const cancelRaf =
  isBrowser && typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame.bind(globalThis)
    : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

export const createPainter = (
  state: State,
  roots: Record<string, PainterRoot>,
): Painter => {
  const dirty = new Set<string>();
  const mounted = new Map<string, Node | null>();
  const listeners: ListenerRegistry = new WeakMap();
  const setFn = state.fns.get("set") as Fn | undefined;
  let rafId: number | null = null;
  let disposed = false;

  const flush = (): void => {
    rafId = null;
    if (disposed) return;
    // Off-browser, the painter still advances per-root state (mounted
    // node remains null, lastApplied moves forward) so the patch cel
    // produces incremental diffs in tests / SSR. The DOM mutation step
    // is the only browser-gated piece.
    for (const rootKey of dirty) {
      const root = roots[rootKey];
      if (!root) continue;
      const patch = readPatch(state, root.patchCel);
      if (!patch) continue;
      if (isBrowser) {
        const target = resolveTarget(root);
        if (!target) continue;
        const next = applyPatch(target, mounted.get(rootKey) ?? null, patch, listeners, state, setFn);
        mounted.set(rootKey, next);
      }
      root.onApplied(patch);
    }
    dirty.clear();
  };

  const schedule = (rootKey: string): void => {
    if (disposed) return;
    dirty.add(rootKey);
    if (rafId !== null) return;
    rafId = raf(flush);
  };

  const scheduleAll = (): void => {
    if (disposed) return;
    for (const k of Object.keys(roots)) dirty.add(k);
    if (rafId !== null) return;
    rafId = raf(flush);
  };

  const flushNow = (): void => {
    if (rafId !== null) {
      cancelRaf(rafId);
      rafId = null;
    }
    flush();
  };

  const dispose = (): void => {
    disposed = true;
    if (rafId !== null) {
      cancelRaf(rafId);
      rafId = null;
    }
    dirty.clear();
    for (const [, node] of mounted) {
      if (node) detachAllListeners(node, listeners);
    }
    mounted.clear();
  };

  return { schedule, scheduleAll, flushNow, dispose };
};

const readPatch = (state: State, celKey: string): Patch | undefined => {
  const cel = state.cels.get(celKey);
  if (!cel) return undefined;
  const v = cel.v;
  if (v === null || typeof v !== "object" || !("kind" in (v as object))) return undefined;
  return v as Patch;
};

const resolveTarget = (root: PainterRoot): Element | null => {
  if (root.element) return root.element;
  if (root.selector) return document.querySelector(root.selector);
  return null;
};
