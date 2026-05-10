import {
  createElement, memo, useEffect, useId, useRef, useState,
  type ReactNode,
} from "react";
import type { State } from "../../../plastron/src/index.js";
import { installDom } from "../../../segments/plastron-dom/src/index.js";

// ========================================================================
// <PlastronHost> — host-containment for plastron inside React.
//
// React owns the surrounding tree; PlastronHost mounts an empty <div>
// and hands its DOM node to plastron-dom. Plastron paints into the div;
// React never touches what's inside. The wrapper div has children:[]
// at every render, so React's reconciler sees no children to diff.
//
// Lifecycle (per mount):
//
//   ┌─ React mount
//   │   • render <div ref={hostRef} />        (React)
//   │   • useEffect runs:                     (post-paint)
//   │       1. generate unique channelKey + rootKey
//   │       2. installDom(state, { roots: { [rootKey]: { element, cel } },
//   │                              channelKey })
//   │       3. drain the channel once so the initial paint commits
//   │       4. setReady(true) so the optional `loading` placeholder
//   │          gets removed (it's an absolutely-positioned overlay so
//   │          plastron's paint isn't visible behind it on first frame)
//   │
//   ├─ Strict mode dev cycle (mount → unmount → mount): the cleanup
//   │   below tears down the channel + cels we installed, so the second
//   │   mount sees a clean slate. If installDom throws because a leftover
//   │   channelKey is still registered, that's the bug — but we never
//   │   reuse a channelKey across remounts (useId + useRef counter), so
//   │   it can't happen here.
//   │
//   └─ React unmount
//       • cancel scheduled rAF (channel.dispose)
//       • remove the painter cel + patch cel from state.cels
//       • remove the channel from state.channelRegistry
//       • flush(state, "plastronDom", { force: true }) is NOT called —
//         that would tear down OTHER hosts on the same state. We do
//         targeted cleanup ourselves.
//
// Props:
//   • state         — pre-built plastron state (host's responsibility
//                     to construct + hydrate before mounting).
//   • cel           — root cel key whose vnode tree gets painted.
//   • loading?      — optional placeholder shown until the first paint
//                     commits. Removed once the channel drains.
//   • className?    — applied to the wrapper div.
//   • style?        — applied to the wrapper div.
//
// React.memo: the component re-renders only when props change. Its
// useEffect deps are [state, cel] — re-running the effect re-installs
// the painter, which is expensive. Hosts should treat `state` as stable
// (build once at app start, reuse forever). Changing `cel` is a
// supported way to swap the root tree without unmounting.
//
// SSR caveat: useEffect doesn't fire on the server. The wrapper div
// renders empty during SSR. The `loading` placeholder (if provided)
// renders on the server and stays through hydration until the client
// effect drains the first paint. There's no built-in hydration-mismatch
// handling — plastron paints client-side only. Hosts wanting SSR'd
// initial content should render a static snapshot via `loading`.
// ========================================================================

/**
 * Props for `<PlastronHost>`.
 *
 * Layout caveat: the *inner* paint-target div uses `display: contents`
 * so plastron-painted children participate directly in the surrounding
 * flex/grid layout. A side effect is that the inner div has no layout
 * box of its own — `getBoundingClientRect()`, IntersectionObserver
 * targeting the inner div, and CSS rules sizing the inner div all see
 * a zero-sized geometry. If a host needs real layout-box semantics,
 * apply `className` / `style` to the *outer* wrapper (which has a
 * normal box) rather than relying on the inner target div.
 */
export interface PlastronHostProps {
  /** Pre-built plastron state. Should be stable across renders. */
  state: State;
  /** Root cel key whose vnode tree to render. */
  cel: string;
  /** Optional placeholder shown until first paint commits. */
  loading?: ReactNode;
  /** Optional className for the outer wrapper div. */
  className?: string;
  /** Optional style for the outer wrapper div. */
  style?: React.CSSProperties;
}

// Counter that lets useId-derived channel keys stay unique even when a
// component instance remounts under the same React id (rare but
// possible in dev / strict mode if React reuses an id). Bumped per
// effect-run, captured in the closure so cleanup uses the same key.
let mountCounter = 0;

const PlastronHostImpl = ({
  state, cel, loading, className, style,
}: PlastronHostProps): ReactNode => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const reactId = useId();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;

    if (!state.cels.has(cel)) {
      // eslint-disable-next-line no-console
      console.error(
        `[plastron-react-host] cel "${cel}" not in state.cels. ` +
        `Hydrate the segment that owns it before mounting <PlastronHost>.`,
      );
      return;
    }

    const mountId = ++mountCounter;
    const channelKey = `react-host:${reactId}:${mountId}`;
    const rootKey    = `react-host:${reactId}:${mountId}`;

    let cancelled = false;
    let dispose: (() => void) | null = null;

    try {
      const handle = installDom(state, {
        roots: { [rootKey]: { element, cel } },
        channelKey,
      });

      // Drain pending work so the first paint commits before we flip
      // `ready`. If a runCycle hasn't been called yet for the cel
      // tree, drain is a noop and ready flips immediately — the host
      // is responsible for having computed the initial vnode tree
      // (via runCycle) before mount, OR for accepting that the first
      // paint lands one cycle later.
      const drainResult = handle.channel.drain();
      const onDrained = (): void => {
        if (cancelled) return;
        setReady(true);
      };
      if (drainResult instanceof Promise) {
        drainResult.then(onDrained, onDrained);
      } else {
        onDrained();
      }

      dispose = (): void => {
        cancelled = true;
        // Tear down the channel (cancels rAF, detaches listeners,
        // clears mounted state).
        try { handle.channel.dispose(); } catch { /* swallow */ }
        // Remove the channel from the registry so the next mount with
        // the same id (which can't happen due to mountCounter, but be
        // defensive) doesn't collide.
        state.channelRegistry.delete(channelKey);
        // Remove the patch cel(s) and the painter sentinel cel that
        // installDom added. Keys follow installDom's internal naming
        // convention; mirroring it here keeps the package self-
        // contained without exposing those keys from plastron-dom.
        state.cels.delete(`__plastronDom:patch:${rootKey}`);
        state.cels.delete(`__plastronDom:painter:${channelKey}`);
        // Remove the patch fn we registered.
        state.fns.delete(`__plastronDom:patchFn:${rootKey}`);
        // Re-run precompute so the topology indexes drop the removed
        // cels. precompute is exposed via the kernel's internal API
        // through the precomputedStates seed; the safest cross-version
        // path is to call setFn on a still-present cel — but that's
        // overkill. Instead, leave the indexes stale: the next
        // hydrate / set / flush will refresh them. Stale indexes
        // referencing dropped cels are harmless because cascade lookups
        // go through state.cels.get which returns undefined for them.
        //
        // Cleanup asymmetry — what installDom mutates that we do NOT
        // undo on unmount:
        //   • state.schemas[VNODE_SCHEMA_KEY]            (added by installDom)
        //   • cel.schema on the user's root cel          (mutated to vnodeSchema)
        //   • state.segments[PLASTRON_DOM_SEGMENT]       (manifest entry)
        // These are intentionally left in place. They're idempotent on
        // remount (installDom would re-set them to the same values) and
        // shared across all hosts on the same state, so undoing them on
        // a per-host basis would break sibling hosts. The lifecycle
        // contract is: state-level mutations from installDom persist for
        // the lifetime of the state; per-host mutations (cels, channels,
        // patch fn) get cleaned up here.
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[plastron-react-host] installDom failed:`, err);
    }

    return () => {
      if (dispose) dispose();
    };
  }, [state, cel, reactId]);

  // The wrapper div has NO children — React reconciles an empty list
  // every render and never touches plastron's painted nodes. The
  // `loading` overlay sits next to the wrapper (sibling, not child)
  // so React owns it cleanly and removes it once `ready` flips.
  return createElement(
    "div",
    { className, style, "data-plastron-host": "" },
    createElement("div", {
      ref: hostRef,
      "data-plastron-host-target": "",
      style: { display: "contents" },
    }),
    !ready && loading
      ? createElement(
          "div",
          { "data-plastron-host-loading": "" },
          loading,
        )
      : null,
  );
};

/** React.memo'd — only re-renders when props change by reference. The
 *  internal useEffect deps gate re-attach independently. */
export const PlastronHost = memo(PlastronHostImpl);
PlastronHost.displayName = "PlastronHost";
