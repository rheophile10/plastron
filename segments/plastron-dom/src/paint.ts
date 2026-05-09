import type {
  ChannelEnqueue, ChannelHandler, Fn, State,
} from "../../../plastron/src/index.js";
import { applyPatch, detachAllListeners, type ListenerRegistry } from "./apply.js";
import { isNoop, type Patch } from "./diff.js";

// ========================================================================
// DOM channel — rAF-batched ChannelHandler.
//
// The channel owns three pieces of state:
//
//   • dirty       : Set<rootKey>  — roots scheduled to paint this rAF
//   • mounted     : Map<rootKey, Node | null> — current root child node
//   • listeners   : WeakMap<Element, Map<eventType, AttachedListener>>
//
// kernel ──enqueue({cel,state})──► channel
//   • derive rootKey from cel.key (patchCelToRoot lookup)
//   • read cel.v as Patch; skip if noop
//   • mark rootKey dirty; queue rAF if not already pending
//
// rAF (or drain) ──► flush()
//   • for each dirty root: read patch from cel.v, applyPatch to DOM,
//     advance lastApplied via root.onApplied, clear dirty set
//
// Off-browser, the channel still advances per-root state (mounted node
// remains null, lastApplied moves forward via onApplied) so the patch
// cel produces incremental diffs in tests / SSR. The DOM mutation step
// is the only browser-gated piece.
// ========================================================================

export interface DomRoot {
  /** CSS selector used at first paint to locate the mount target. Either
   *  `selector` or `element` must be present. */
  selector?: string;
  /** Pre-resolved mount target. Wins over `selector`. */
  element?: Element;
  /** Cel key whose value (a Patch) the channel applies. */
  patchCel: string;
}

export interface PainterRoot extends DomRoot {
  /** Called after applyPatch resolves, with the patch that was applied.
   *  Used by the patch fn's closure to advance lastApplied. */
  onApplied: (patch: Patch) => void;
}

/** Channel-handler shape for plastron-dom. Identical to ChannelHandler
 *  today; the alias exists so future dom-specific additions land in
 *  one named type. */
export type DomChannelHandle = ChannelHandler;

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

export const createDomChannel = (
  state: State,
  roots: Record<string, PainterRoot>,
): DomChannelHandle => {
  const dirty = new Set<string>();
  const mounted = new Map<string, Node | null>();
  const listeners: ListenerRegistry = new WeakMap();
  const setFn = state.fns.get("set") as Fn | undefined;
  let rafId: number | null = null;
  let disposed = false;

  // Reverse lookup: patch cel key → root key. The kernel hands us a Cel
  // via enqueue; we need its root to schedule + flush correctly.
  const patchCelToRoot = new Map<string, string>();
  for (const [rootKey, root] of Object.entries(roots)) {
    patchCelToRoot.set(root.patchCel, rootKey);
  }

  const flush = (): void => {
    rafId = null;
    if (disposed) return;
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

  // ── ChannelHandler surface ───────────────────────────────────────────

  const enqueue = ({ cel }: ChannelEnqueue): void => {
    const rootKey = patchCelToRoot.get(cel.key);
    if (rootKey === undefined) return;
    // Skip noop patches — the optimization the patch fn body used to
    // do inline. cel.v is the Patch produced by the patch lambda; if
    // the diff was a noop, no rAF is needed.
    const v = cel.v;
    if (!v || typeof v !== "object" || !("kind" in (v as object))) return;
    if (isNoop(v as Patch)) return;
    schedule(rootKey);
  };

  const hasPending = (): boolean => dirty.size > 0;

  const drain = (): void => {
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

  return { enqueue, hasPending, drain, dispose };
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
