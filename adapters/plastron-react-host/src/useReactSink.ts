import { useEffect, useState } from "react";
import type {
  ChannelEnqueue, ChannelHandler, State,
} from "../../../plastron/src/index.js";

// ========================================================================
// useReactSink(state, channelName) — mirror a plastron channel into
// React state.
//
// Registers a synchronous ChannelHandler under `channelName`. Every cel
// the cascade routes onto this channel pushes its `cel.v` into a React
// useState, triggering a React re-render. The hook returns the latest
// pushed value, or `undefined` until the first enqueue.
//
// Use case: read-only display of a plastron-computed value inside a
// React component without wrapping the whole subtree in <PlastronHost>.
// Bind one or more cels to this channel via cel.channel = "myChannel"
// at hydrate time; each value change flows into React's setState.
//
// Lifecycle:
//   • mount:    register handler in state.channelRegistry
//   • update:   if state OR channelName changes, dispose old handler
//               and register a fresh one (last-write-wins)
//   • unmount:  channel.dispose() + state.channelRegistry.delete(key)
//
// Strict-mode / double-effect safety: each effect run creates a fresh
// handler and the cleanup function unregisters it. Two effect runs in
// dev produce: register-A → cleanup-A → register-B. There's a brief
// window during the cleanup where the channel is unregistered — any
// cascade firing during that window for the dropped cel will silently
// drop the value (it routes through `_channelHandlers` which was
// resolved at precompute, but the handler's enqueue still runs and
// just won't deliver to React because the handler is in the disposed
// state). The next mount picks up the next change.
//
// Channel collision: if `channelName` is already registered (e.g. by
// installDom or another sink), useReactSink logs and returns silently
// without registering a handler for this hook instance — the existing
// registration is left untouched. The caller must pick a free channel
// name to actually receive values. There's intentionally no "wrap
// existing handler" mode — multiple sinks on the same channel would
// compete for cel.v ownership semantics that the kernel doesn't
// promise.
//
// drain semantics: the channel is sync — drain runs immediately,
// hasPending always returns false. setState is batched by React 18+
// across multiple cels in a single enqueue burst; concrete coalescing
// behavior is React's, not the channel's.
// ========================================================================

export const useReactSink = <T = unknown>(
  state: State,
  channelName: string,
): T | undefined => {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    if (state.channelRegistry.has(channelName)) {
      // eslint-disable-next-line no-console
      console.error(
        `[plastron-react-host] useReactSink: channel "${channelName}" ` +
        `is already registered. Pick a unique name.`,
      );
      return;
    }

    let disposed = false;

    const handler: ChannelHandler = {
      enqueue: ({ cel }: ChannelEnqueue): void => {
        if (disposed) return;
        setValue(cel.v as T);
      },
      hasPending: () => false,
      drain: () => { /* sync — nothing to flush */ },
      dispose: () => {
        disposed = true;
      },
    };

    state.channelRegistry.set(channelName, handler);

    return () => {
      handler.dispose();
      // Only delete from the registry if we still own the slot — a
      // re-render that re-registered under the same key would have
      // overwritten us, and we don't want to clobber the new entry.
      if (state.channelRegistry.get(channelName) === handler) {
        state.channelRegistry.delete(channelName);
      }
    };
  }, [state, channelName]);

  return value;
};
