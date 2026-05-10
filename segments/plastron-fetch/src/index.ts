import type {
  Cel, Fn, LambdaKey, SegmentManifest, State,
} from "../../../plastron/src/index.js";
import {
  createFetchChannel, DEFAULT_FETCH_CHANNEL_KEY,
  type FetchChannelOptions,
} from "./channel.js";
import {
  fetchBytes, fetchJson, fetchText,
  FETCH_BYTES_KEY, FETCH_JSON_KEY, FETCH_TEXT_KEY,
} from "./lambdas.js";
import {
  fetchRequestSchema, fetchResponseSchema,
  FETCH_REQUEST_SCHEMA_KEY, FETCH_RESPONSE_SCHEMA_KEY,
} from "./schemas.js";

// ========================================================================
// segment: plastron-fetch
//
// HTTP requests as cels. Three async lambdas (fetchJson / fetchText /
// fetchBytes) settle their results into cel.v as a structured
// FetchResponse. Errors return as values; nothing throws.
//
// Lambda input convention:
//   • All three take `{ request: FetchRequest, signal?: AbortSignal }`.
//   • Hosts wire them through inputMap:
//
//       { key: "myReq",  v: { url: "https://…" } }
//       { key: "myResp", l: "fetchJson", inputMap: { request: "myReq" } }
//
//   • To support abort, declare a value cel holding an AbortSignal and
//     reference it: `inputMap: { request: "myReq", signal: "myAbort" }`.
//
// Optional channel:
//   The "fetch" channel is observation-only by default. It does NOT
//   drive the HTTP work — that happens in the cascade. Bind cels via
//   `channel: "fetch"` for an `onCommit` notification when the response
//   settles. With `debounceMs > 0` the channel coalesces repeated
//   commits per cel key.
//
// Teardown: call `flush(state, PLASTRON_FETCH_SEGMENT)`. The segment's
// sentinel cel has a `_dispose` closure that disposes the channel and
// removes it from `state.channelRegistry`. Note that `flush` removes
// cels in the segment (and fires their `_dispose` hooks). It does NOT
// remove lambdas or schemas from `state.fns` / `state.schemas` —
// those persist for the lifetime of the state. Hosts that want a
// truly clean wipe can `state.fns.delete(...)` / `state.schemas.delete(...)`
// after flushing.
// ========================================================================

export const PLASTRON_FETCH_SEGMENT = "plastron-fetch" as const;

export const plastronFetchManifest: SegmentManifest = {
  segment: PLASTRON_FETCH_SEGMENT,
  version: "0.0.1",
  description: "HTTP requests as async cels with optional batching channel.",
  provides: {
    lambdas: [FETCH_JSON_KEY, FETCH_TEXT_KEY, FETCH_BYTES_KEY],
    schemas: [FETCH_REQUEST_SCHEMA_KEY, FETCH_RESPONSE_SCHEMA_KEY],
    channels: [DEFAULT_FETCH_CHANNEL_KEY],
    celSegments: [PLASTRON_FETCH_SEGMENT],
  },
};

// ── Re-exports ────────────────────────────────────────────────────────────

export type {
  FetchHeaders, FetchMethod, FetchRequest, FetchResponse,
} from "./schemas.js";
export {
  fetchHeadersSchema, fetchMethodSchema, fetchRequestSchema, fetchResponseSchema,
  FETCH_REQUEST_SCHEMA_KEY, FETCH_RESPONSE_SCHEMA_KEY,
} from "./schemas.js";
export {
  fetchBytes, fetchJson, fetchText,
  FETCH_BYTES_KEY, FETCH_JSON_KEY, FETCH_TEXT_KEY,
} from "./lambdas.js";
export type { FetchChannelOptions } from "./channel.js";
export { createFetchChannel, DEFAULT_FETCH_CHANNEL_KEY } from "./channel.js";

// ── installFetch ──────────────────────────────────────────────────────────

const sentinelCelKey = (channelKey: string): string =>
  `__plastronFetch:sentinel:${channelKey}`;

export interface InstallFetchOptions {
  /** Channel key under which to register the fetch channel in
   *  state.channelRegistry. Default 'fetch'. Pass distinct keys if
   *  installing multiple fetch channels in the same state (e.g. one
   *  pass-through and one debounced). */
  channelKey?: string;
  /** Channel options. See FetchChannelOptions for details. Default
   *  pass-through (debounceMs: 0, no onCommit). */
  channelOptions?: FetchChannelOptions;
}

/** Install the plastron-fetch segment on an existing State.
 *
 *  Registers the three lambdas (fetchJson / fetchText / fetchBytes),
 *  the FetchRequest / FetchResponse schemas, the fetch channel, and a
 *  sentinel cel whose `_dispose` hook tears the channel down on flush.
 *
 *  Idempotent — a second call with the same channelKey throws to
 *  surface a likely double-install. To re-install with new options,
 *  call `flush(state, PLASTRON_FETCH_SEGMENT)` first. */
export const installFetch = (
  state: State,
  options: InstallFetchOptions = {},
): void => {
  const channelKey = options.channelKey ?? DEFAULT_FETCH_CHANNEL_KEY;

  if (state.channelRegistry.has(channelKey)) {
    throw new Error(
      `installFetch: channel "${channelKey}" already registered. ` +
      `Pass options.channelKey to namespace, or flush plastron-fetch first.`,
    );
  }

  // Register schemas + schemaMetadata directly. The kernel uses live
  // ZodType refs as Map keys, so we do NOT round-trip through
  // hydrate's HydrateSchemas pass.
  if (!state.schemas.has(FETCH_REQUEST_SCHEMA_KEY)) {
    state.schemas.set(FETCH_REQUEST_SCHEMA_KEY, fetchRequestSchema);
  }
  if (!state.schemas.has(FETCH_RESPONSE_SCHEMA_KEY)) {
    state.schemas.set(FETCH_RESPONSE_SCHEMA_KEY, fetchResponseSchema);
  }
  if (!state.schemaMetadata.has(FETCH_REQUEST_SCHEMA_KEY)) {
    state.schemaMetadata.set(FETCH_REQUEST_SCHEMA_KEY, {
      key: FETCH_REQUEST_SCHEMA_KEY,
    });
  }
  if (!state.schemaMetadata.has(FETCH_RESPONSE_SCHEMA_KEY)) {
    state.schemaMetadata.set(FETCH_RESPONSE_SCHEMA_KEY, {
      key: FETCH_RESPONSE_SCHEMA_KEY,
    });
  }

  // Register the channel.
  const channel = createFetchChannel(state, options.channelOptions);
  state.channelRegistry.set(channelKey, channel);

  // Build the lambda map and register them via hydrate so the
  // segment manifest lands in state.segments uniformly. We attach
  // input/output schema references to all three so reordering inside
  // this map is safe.
  const fns = new Map<LambdaKey, Fn>([
    [FETCH_JSON_KEY,  fetchJson],
    [FETCH_TEXT_KEY,  fetchText],
    [FETCH_BYTES_KEY, fetchBytes],
  ]);

  const fnMetaData = {
    [FETCH_JSON_KEY]:  {
      key: FETCH_JSON_KEY,
      kind: "native",
      inputSchema: FETCH_REQUEST_SCHEMA_KEY,
      outputSchema: FETCH_RESPONSE_SCHEMA_KEY,
    },
    [FETCH_TEXT_KEY]: {
      key: FETCH_TEXT_KEY,
      kind: "native",
      inputSchema: FETCH_REQUEST_SCHEMA_KEY,
      outputSchema: FETCH_RESPONSE_SCHEMA_KEY,
    },
    [FETCH_BYTES_KEY]: {
      key: FETCH_BYTES_KEY,
      kind: "native",
      inputSchema: FETCH_REQUEST_SCHEMA_KEY,
      outputSchema: FETCH_RESPONSE_SCHEMA_KEY,
    },
  };

  // Honor channelKey override in the manifest's `provides.channels`,
  // mirroring the plastron-dom pattern.
  const manifest: SegmentManifest =
    channelKey === DEFAULT_FETCH_CHANNEL_KEY
      ? plastronFetchManifest
      : {
          ...plastronFetchManifest,
          provides: {
            ...plastronFetchManifest.provides,
            channels: [channelKey],
          },
        };

  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(
    state,
    [{
      key: PLASTRON_FETCH_SEGMENT,
      cels: [],
      fnMetaData,
      manifest,
    }],
    [fns],
  );

  // Sentinel cel — `flush(PLASTRON_FETCH_SEGMENT)` walks cels in this
  // segment, fires their _dispose, removes them. The sentinel's
  // _dispose tears down the channel and unregisters it.
  const sentinel: Cel = {
    key: sentinelCelKey(channelKey),
    v: null,
    segment: PLASTRON_FETCH_SEGMENT,
    _dispose: () => {
      channel.dispose();
      state.channelRegistry.delete(channelKey);
    },
  };
  state.cels.set(sentinel.key, sentinel);
};
