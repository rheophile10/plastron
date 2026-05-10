import type {
  ChannelEnqueue, ChannelHandler, DehydratedCel, Fn, LambdaKey,
  SegmentManifest, State,
} from "../../../plastron/src/index.js";
import {
  compileRoutes, matchKey, matchRoute,
  type CompiledRoute, type RouteEntry, type RouteMatch,
} from "./match.js";

// ============================================================================
// installRouter — wires the router into an existing State.
//
// What it installs:
//   • A match lambda whose body closes over the compiled route table.
//   • Three cels — route:hash (data), route:match (lambda), route:view (data).
//   • A loader channel handler bound to route:match. The handler is
//     async: dynamic-import → hydrate → runCycle → set route:view.
//   • A hashchange listener that writes window.location.hash into
//     route:hash via state.fns.get("set").
//   • A SegmentManifest entry under "plastronRoutes".
//
// Returned handle:
//   • navigate(path) — sets window.location.hash; the listener picks
//     it up and the loader handler runs.
//   • dispose() — removes the listener (idempotent).
//
// What it does NOT do:
//   • No <a> click interception. Hash hrefs (`#/foo`) navigate without
//     reload natively, and the listener handles the rest.
//   • No history-API mode. Callers wanting clean URLs land on a v2.
// ============================================================================

export const ROUTES_SEGMENT = "plastronRoutes" as const;
export const ROUTE_HASH_KEY = "route:hash" as const;
export const ROUTE_MATCH_KEY = "route:match" as const;
export const ROUTE_VIEW_KEY = "route:view" as const;
export const ROUTE_MATCH_FN_KEY = "plastronRoutes:match" as const;
export const ROUTE_MATCH_ISCHANGED_KEY = "plastronRoutes:matchIsChanged" as const;
export const ROUTE_LOADER_CHANNEL = "route:loader" as const;

export interface InstallRouterOptions {
  routes: RouteEntry[];
  /** View key written to route:view when no pattern matches.
   *  Default: route:view stays empty on miss. */
  fallback?: string;
  /** Channel key under which to register the loader. Default
   *  'route:loader'. Pass distinct keys if installing multiple
   *  routers in the same state. */
  channelKey?: string;
}

export interface RouterHandle {
  /** Programmatic navigation. Sets window.location.hash, which fires
   *  hashchange and flows through the cel graph just like a click. */
  navigate: (path: string) => void;
  /** Idempotent teardown — removes the hashchange listener. Does NOT
   *  flush the segment from state; call
   *  state.fns.get("flush")(state, "plastronRoutes") for that. */
  dispose: () => void;
}

export const plastronRoutesManifest: SegmentManifest = {
  segment: ROUTES_SEGMENT,
  version: "0.1.0",
  description: "Hash-based URL router with lazy segment loading.",
  provides: {
    schemas: [],
    lambdas: [ROUTE_MATCH_FN_KEY, ROUTE_MATCH_ISCHANGED_KEY],
    channels: [ROUTE_LOADER_CHANNEL],
    celSegments: [ROUTES_SEGMENT],
  },
};

const readHash = (): string => {
  if (typeof window === "undefined") return "/";
  const raw = window.location.hash;
  if (!raw || raw === "#") return "/";
  return raw.startsWith("#") ? raw.slice(1) : raw;
};

export const installRouter = (
  state: State,
  options: InstallRouterOptions,
): RouterHandle => {
  if (options.routes.length === 0) {
    throw new Error("installRouter: at least one route required.");
  }
  const channelKey = options.channelKey ?? ROUTE_LOADER_CHANNEL;
  if (state.channelRegistry.has(channelKey)) {
    throw new Error(
      `installRouter: channel "${channelKey}" already registered. ` +
      `Pass options.channelKey to namespace.`,
    );
  }

  const compiled = compileRoutes(options.routes);

  // Build the loader channel. Closure captures `compiled` + the
  // resolved kernel fns. State is captured so the handler can call
  // hydrate / runCycle / set without re-reading the registry.
  const loadedViews = new Set<string>();
  const channel = createLoaderChannel(state, compiled, loadedViews, options.fallback);

  state.channelRegistry.set(channelKey, channel);

  // Match lambda — closes over compiled. Pure: only reads its declared
  // input. Returns RouteMatch | null.
  const matchFn: Fn = (inputs: { hash: unknown }) => {
    const hash = typeof inputs.hash === "string" ? inputs.hash : "/";
    return matchRoute(hash, compiled);
  };

  // Change suppression — same view + params + query => no re-fire of
  // the loader. The kernel calls _isChanged with (prev, next) values;
  // we compute a stable string from each and compare.
  const matchIsChanged: Fn = (prev: unknown, next: unknown) =>
    matchKey(prev as RouteMatch | null) !== matchKey(next as RouteMatch | null);

  const cels: DehydratedCel[] = [
    { key: ROUTE_HASH_KEY, v: readHash(), segment: ROUTES_SEGMENT },
    {
      key: ROUTE_MATCH_KEY,
      l: ROUTE_MATCH_FN_KEY,
      inputMap: { hash: ROUTE_HASH_KEY },
      channel: channelKey,
      segment: ROUTES_SEGMENT,
    },
    { key: ROUTE_VIEW_KEY, v: "", segment: ROUTES_SEGMENT },
  ];

  // Manifest. Mirror plastron-dom's pattern: if channelKey was
  // overridden, emit a manifest reflecting the actual channel name.
  const manifest: SegmentManifest =
    channelKey === ROUTE_LOADER_CHANNEL
      ? plastronRoutesManifest
      : {
          ...plastronRoutesManifest,
          provides: {
            ...plastronRoutesManifest.provides,
            channels: [channelKey],
          },
        };

  const fns = new Map<LambdaKey, Fn>([
    [ROUTE_MATCH_FN_KEY, matchFn],
    [ROUTE_MATCH_ISCHANGED_KEY, matchIsChanged],
  ]);

  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(
    state,
    [{ key: ROUTES_SEGMENT, cels, manifest }],
    [fns],
  );

  // Wire the change-suppression fn onto the match cel post-hydrate.
  // We don't use schemaMetadata here because there's no value schema —
  // RouteMatch is a plain JSON shape, identity-only. Direct assignment
  // is the lighter path.
  const matchCel = state.cels.get(ROUTE_MATCH_KEY);
  if (matchCel) matchCel._isChanged = matchIsChanged;

  // Sentinel cel — flush(ROUTES_SEGMENT) calls dispose, which removes
  // the channel and detaches the listener.
  const sentinelKey = `__plastronRoutes:sentinel:${channelKey}`;
  let listenerAttached = false;
  let disposed = false;

  const setFn = state.fns.get("set") as Fn;
  const onHashChange = () => {
    if (disposed) return;
    void setFn(state, ROUTE_HASH_KEY, readHash());
  };
  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", onHashChange);
    listenerAttached = true;
  }

  const detach = () => {
    if (!listenerAttached) return;
    if (typeof window !== "undefined") {
      window.removeEventListener("hashchange", onHashChange);
    }
    listenerAttached = false;
  };

  state.cels.set(sentinelKey, {
    key: sentinelKey,
    v: null,
    segment: ROUTES_SEGMENT,
    _dispose: () => {
      detach();
      channel.dispose();
      state.channelRegistry.delete(channelKey);
    },
  });

  const navigate = (path: string): void => {
    if (disposed || typeof window === "undefined") return;
    const hash = path.startsWith("#") ? path : `#${path.startsWith("/") ? path : `/${path}`}`;
    if (window.location.hash === hash) {
      // No-op assignment doesn't fire hashchange — push the cel ourselves.
      void setFn(state, ROUTE_HASH_KEY, readHash());
      return;
    }
    window.location.hash = hash;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    detach();
  };

  return { navigate, dispose };
};

// ----------------------------------------------------------------------------
// Loader channel — async drain that handles dynamic-import + hydrate +
// runCycle + view-switch. Coalesced: only the latest match is processed.
// ----------------------------------------------------------------------------

const createLoaderChannel = (
  state: State,
  compiled: CompiledRoute[],
  loadedViews: Set<string>,
  fallback: string | undefined,
): ChannelHandler => {
  let pending: { value: RouteMatch | null } | undefined;
  let drainPromise: Promise<void> | null = null;
  let scheduled = false;
  let disposed = false;

  const byPattern = new Map<string, CompiledRoute>();
  for (const r of compiled) byPattern.set(r.entry.pattern, r);

  const setFn = state.fns.get("set") as Fn;
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;

  const process = async (match: RouteMatch | null): Promise<void> => {
    if (match === null) {
      if (fallback !== undefined) {
        await setFn(state, ROUTE_VIEW_KEY, fallback);
      }
      return;
    }
    const route = byPattern.get(match.pattern);
    if (route?.entry.load && !loadedViews.has(match.view)) {
      const bundle = await route.entry.load();
      hydrate(state, [bundle.segment], [bundle.fns]);
      loadedViews.add(match.view);
      await runCycle(state);
    }
    await setFn(state, ROUTE_VIEW_KEY, match.view);
  };

  const enqueue = ({ cel }: ChannelEnqueue): void => {
    if (disposed) return;
    pending = { value: cel.v as RouteMatch | null };
    if (drainPromise || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed || pending === undefined) return;
      void drain();
    });
  };

  const hasPending = (): boolean =>
    pending !== undefined || drainPromise !== null;

  const drain = (): void | Promise<void> => {
    if (drainPromise) return drainPromise;
    if (pending === undefined) return;
    drainPromise = (async () => {
      try {
        while (pending !== undefined && !disposed) {
          const m = pending.value;
          pending = undefined;
          await process(m);
        }
      } finally {
        drainPromise = null;
      }
    })();
    return drainPromise;
  };

  const dispose = (): void => {
    disposed = true;
    pending = undefined;
  };

  return { enqueue, hasPending, drain, dispose };
};
