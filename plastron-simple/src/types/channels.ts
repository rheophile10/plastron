import type { Key } from "./index.js";
import type { BaseCel, BaseCelMetadata, Cel } from "./cels.js";
import type { State } from "./state.js";

export type ChannelKey = Key;

export interface ChannelEnqueue {
  cel: Cel;
  state: State;
}

/** Hydrated channel — the live form. Built at precompute by
 *  precompute.buildChannel from a DehydratedChannel; drain/dispose
 *  resolve through resolveFn(state, key) against the cel registry. */
export interface Channel {
  enqueue: (args: ChannelEnqueue) => void;
  hasPending: () => boolean;
  drain: () => void | Promise<void>;
  dispose: () => void;
}

/** Dehydrated channel — round-trippable. drain/dispose are Keys
 *  naming cels in state.cels (resolved through resolveFn); the kernel
 *  supplies default enqueue/hasPending at hydrate. */
export interface DehydratedChannel {
  drain: Key;
  dispose?: Key;
}

export interface ChannelCelMetadata extends BaseCelMetadata {
  drain: Key;
  dispose?: Key;
}

export interface ChannelCel extends BaseCel {
  celType: "ChannelCel";
  metadata: ChannelCelMetadata;
  v: DehydratedChannel;
  _channel?: Channel;
}
