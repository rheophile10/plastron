import type { Cel } from "./cels.js";
import type { State } from "./index.js";

// ============================================================================
// Channels — pluggable side-effect outputs.
//
// A channel sits between the cascade and the outside world. When a cel
// bound to a channel changes, runCascade calls handler.enqueue({cel, state}).
// The handler decides what to commit, when to commit, and whether to
// coalesce. Concrete handlers cover DOM (rAF-batched), audio (clock-tick),
// log (sync), persist (debounced), network (microtask-batched), tests
// (sync), …
//
// Channels are independent. Cross-channel ordering happens through the
// graph: cel A (channel: persist) → cel B (channel: dom) cascades A
// before B; their channels still commit on their own clocks.
//
// Sync flushAll drains to fixed point: a channel commit may write back
// via set/batch, kicking a new cascade that enqueues to other channels.
// hasPending lets the kernel detect this and re-iterate.
// ============================================================================

export type ChannelKey = string;

export interface ChannelEnqueue {
  cel: Cel;
  state: State;
}

export interface ChannelHandler {
  /** Called from runCascade when a bound cel's value changes. The
   *  handler reads cel.v / cel._diff itself — kernel doesn't pre-decide
   *  which one matters. */
  enqueue: (args: ChannelEnqueue) => void;
  /** True iff there is queued work that flushSync would commit. Used
   *  by the fixed-point drain in flushChannels. */
  hasPending: () => boolean;
  /** Apply all pending work synchronously. Triggered by the channel's
   *  own scheduler tick AND by flushChannels (set/batch with flush
   *  option, or an explicit flushSync call). */
  flushSync: () => void;
  /** Idempotent teardown. Cancel timers, detach listeners, clear queues. */
  dispose: () => void;
}
