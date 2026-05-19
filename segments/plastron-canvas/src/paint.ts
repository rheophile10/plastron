import type {
  ChannelEnqueue, ChannelHandler, State,
} from "../../../plastron/src/index.js";
import type { CanvasRoot, ResizeMode } from "./types.js";

// ============================================================================
// Canvas channel — rAF-batched ChannelHandler.
//
// Per-root state:
//
//   • dirty       : Set<rootKey>  — roots scheduled to paint this rAF
//   • mounted     : Map<rootKey, MountedRoot> — resolved canvas + ctx +
//                   resize observer
//
// kernel ──enqueue({cel,state})──► channel
//   • derive rootKey from cel.key (celToRoot lookup)
//   • mark rootKey dirty; queue rAF if not already pending
//
// rAF (or drain) ──► flush()
//   • for each dirty root:
//     – resolve target lazily on first flush (canvas element may have
//       been painted into the DOM by plastron-dom between install and
//       first frame)
//     – read cel.v
//     – call user's draw(ctx, cel.v)
//   • clear dirty set
//
// Off-browser, the channel still tracks dirty + flushes (calling no draw
// since there's no canvas), so snapshot tests / SSR don't crash. The
// resolve-target step returns null off-browser; the per-root state stays
// unmounted and the draw fn is never called.
//
// Resize: a ResizeObserver per mounted root keeps the backing store
// matched to the CSS-pixel rect × devicePixelRatio. The observer's
// callback marks the root dirty and schedules a paint.
// ============================================================================

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

interface MountedRoot {
  element: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  resizeObserver: ResizeObserver | null;
}

const resolveElement = (root: CanvasRoot): HTMLCanvasElement | null => {
  if (root.element) return root.element;
  if (root.selector && isBrowser) {
    const el = document.querySelector(root.selector);
    return el instanceof HTMLCanvasElement ? el : null;
  }
  return null;
};

/** Resize the canvas backing store. Honors the `resize` mode:
 *
 *  • "fixed"               — no-op, leave width/height as authored
 *  • "device-pixel-ratio"  — backing store = element rect × DPR
 *  • "container"           — backing store = parent rect × DPR
 *
 * The CSS sizing is left untouched. Callers using a non-fixed mode
 * are expected to size the canvas via CSS (width: 100%, height:
 * 100%, etc.). */
const sizeCanvas = (
  canvas: HTMLCanvasElement,
  mode: ResizeMode,
): void => {
  if (mode === "fixed" || !isBrowser) return;
  const dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
  const target = mode === "container" ? (canvas.parentElement ?? canvas) : canvas;
  const rect = target.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width  * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width  !== w) canvas.width  = w;
  if (canvas.height !== h) canvas.height = h;
};

export const createCanvasChannel = (
  state: State,
  roots: Record<string, CanvasRoot>,
): ChannelHandler => {
  const dirty = new Set<string>();
  const mounted = new Map<string, MountedRoot>();
  let rafId: number | null = null;
  let disposed = false;

  // Reverse lookup: source cel key → root key. Built once at construction.
  const celToRoot = new Map<string, string>();
  for (const [rootKey, root] of Object.entries(roots)) {
    celToRoot.set(root.cel, rootKey);
  }

  const tryMount = (rootKey: string): MountedRoot | null => {
    const cached = mounted.get(rootKey);
    if (cached) return cached;
    const root = roots[rootKey];
    if (!root) return null;
    const element = resolveElement(root);
    if (!element) return null;
    const ctx = element.getContext("2d");
    if (!ctx) return null;
    const mode = root.resize ?? "device-pixel-ratio";
    sizeCanvas(element, mode);

    let resizeObserver: ResizeObserver | null = null;
    if (mode !== "fixed" && isBrowser && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        sizeCanvas(element, mode);
        // Force a repaint on resize. The user's draw fn sees the new
        // dimensions on the next rAF.
        if (!disposed) {
          dirty.add(rootKey);
          if (rafId === null) rafId = raf(flush);
        }
      });
      resizeObserver.observe(mode === "container" ? element.parentElement ?? element : element);
    }

    const m: MountedRoot = { element, ctx, resizeObserver };
    mounted.set(rootKey, m);
    return m;
  };

  const flush = (): void => {
    rafId = null;
    if (disposed) return;
    for (const rootKey of dirty) {
      const root = roots[rootKey];
      if (!root) continue;
      const m = tryMount(rootKey);
      // No canvas element yet? Keep the root dirty for the next attempt.
      // Off-browser, tryMount returns null indefinitely; we drop the
      // dirty mark to avoid an infinite re-schedule.
      if (!m) {
        if (!isBrowser) continue;
        // Still browser-side but target not found: drop and warn once.
        // eslint-disable-next-line no-console
        console.warn(`[plastron-canvas] root "${rootKey}" target not resolved; skipping paint.`);
        continue;
      }
      const cel = state.cels.get(root.cel);
      if (!cel) continue;
      try {
        root.draw(m.ctx, cel.v);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[plastron-canvas] draw "${rootKey}" failed:`, err);
      }
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
    const rootKey = celToRoot.get(cel.key);
    if (rootKey === undefined) return;
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
    for (const [, m] of mounted) {
      m.resizeObserver?.disconnect();
    }
    mounted.clear();
  };

  return { enqueue, hasPending, drain, dispose };
};

/** Mark every root in `roots` dirty on `channel`. Used by installCanvas
 *  after registering the channel so the initial paint commits on the
 *  caller's `handle.channel.drain()`. Without this, the channel never
 *  sees an `enqueue` (the user's cel hasn't changed since install) and
 *  the first frame doesn't paint until the cel mutates. */
export const enqueueAllRoots = (
  channel: ChannelHandler,
  state: State,
  roots: Record<string, CanvasRoot>,
): void => {
  for (const root of Object.values(roots)) {
    const cel = state.cels.get(root.cel);
    if (!cel) continue;
    channel.enqueue({ cel, state });
  }
};
