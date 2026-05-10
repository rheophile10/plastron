import type {
  Cel, DehydratedCel, Fn, LambdaKey, SegmentManifest, State,
} from "../../../plastron/src/index.js";
import { createDomChannel, type DomRoot, type PainterRoot, type DomChannelHandle } from "./paint.js";
import { diffVNodes } from "./diff.js";
import {
  vnodeByteLength, vnodeEquals, vnodeSchema,
  VNODE_SCHEMA_KEY, VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY, VNODE_BYTELENGTH_KEY,
  type VNode,
} from "./vnode.js";

// ========================================================================
// segment: plastron-dom
//
// Pipeline (per root):
//
//   <user tree cel> ──→ __plastronDom:patch:<rootKey> ──→ dom channel (rAF)
//        wave 0                wave 1                       state.channelRegistry
//
//   The patch cel is graph-resident: its `v` is a Patch (JSON-shape,
//   inspectable, snapshottable). Its lambda is pure — it computes the
//   diff against `lastApplied` and returns it. The kernel routes the
//   changed cel onto the dom channel via cel.channel; the channel
//   schedules an rAF and applies on flush.
//
//   The patch fn's closure holds a `lastApplied: VNode | null` reference
//   shared with the channel via the per-root onApplied callback. Each
//   cycle's diff is computed against lastApplied, NOT against the
//   previously-rendered tree — that way, if multiple cycles run between
//   rAFs, each successive patch supersedes the previous one. The
//   channel's onApplied callback advances lastApplied to whatever it
//   just committed to the DOM.
//
// Tree cels declare `schema: vnodeSchema` (exported from this module).
// installDom registers the schema's isChanged + diff fns; hydrate's
// auto-wire materializes them onto every tree cel as cel._isChanged
// and cel._diffFn. No manual patching, no tag handler — change
// detection lives where it belongs (on the schema).
//
// Teardown is `flush(PLASTRON_DOM_SEGMENT)`: the painter sentinel cel
// has a `_dispose` closure that calls channel.dispose() (cancels rAF,
// detaches listeners, clears mounted state) and removes the channel
// entry from state.channelRegistry.
// ========================================================================

export const PLASTRON_DOM_SEGMENT = "plastronDom" as const;
export const DEFAULT_DOM_CHANNEL_KEY = "plastronDom" as const;

/** Manifest for the plastron-dom segment. Declares its version, the
 *  schemas/lambdas it registers, the channel it owns, and the cel
 *  segment it manages. No `dependsOn`: the DOM painter is leaf-level
 *  in the dependency graph (it consumes tree cels but doesn't
 *  require any other plastron-* package to be loaded). */
export const plastronDomManifest: SegmentManifest = {
  segment: PLASTRON_DOM_SEGMENT,
  version: "1.0.1",
  description:
    "rAF-batched DOM painter — diffs vnode trees and patches the DOM via a channel.",
  provides: {
    schemas: [VNODE_SCHEMA_KEY],
    lambdas: [VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY, VNODE_BYTELENGTH_KEY],
    channels: [DEFAULT_DOM_CHANNEL_KEY],
    celSegments: [PLASTRON_DOM_SEGMENT],
  },
};

export type {
  VNode, VText, VElement, AttrValue, EventBinding, EventInfo,
} from "./vnode.js";
export {
  el, text, vnodeEquals, vnodeByteLength, vnodeSchema,
  VNODE_SCHEMA_KEY, VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY, VNODE_BYTELENGTH_KEY,
} from "./vnode.js";
export type { Patch, PatchEl, PatchInit, PatchReplace, PatchText, PatchNoop, ChildPatch } from "./diff.js";
export { diffVNodes, isNoop } from "./diff.js";
export type { DomRoot, DomChannelHandle } from "./paint.js";
export { createDomChannel } from "./paint.js";

export interface InstallDomOptions {
  /** Map from a stable root key (your choice) to mount target + tree cel. */
  roots: Record<string, { selector?: string; element?: Element; cel: string }>;
  /** Channel key under which to register this painter in
   *  state.channelRegistry. Default 'plastronDom'. Pass distinct keys
   *  if installing multiple painters in the same state. */
  channelKey?: string;
}

export interface DomHandle {
  channel: DomChannelHandle;
  /** Patch cel keys, one per root. Useful for devtools / snapshot
   *  tooling that wants to inspect "what's about to be applied." */
  patchCels: Record<string, string>;
}

const painterCelKey = (channelKey: string): string =>
  `__plastronDom:painter:${channelKey}`;
const patchCelKey = (rk: string): string => `__plastronDom:patch:${rk}`;
const patchFnKey  = (rk: string): string => `__plastronDom:patchFn:${rk}`;

/** Install the plastron-dom segment on an existing State. Tree cels
 *  must already be hydrated and must declare `schema: vnodeSchema`.
 *  installDom registers the schema's isChanged + diff fns (the
 *  kernel's auto-wire then attaches them to every matching tree cel),
 *  builds one patch cel per root, registers a single rAF-batched
 *  channel under options.channelKey (default 'plastronDom'), and
 *  binds each patch cel to that channel.
 *
 *  First paint happens whenever the host's first cascade fires the
 *  patch cels — call `runCycle` or `set` on a tree cel to kick it.
 *
 *  Teardown: call `state.fns.get("flush")(state, PLASTRON_DOM_SEGMENT)`. */
export const installDom = (
  state: State,
  options: InstallDomOptions,
): DomHandle => {
  const sourceRoots = options.roots;
  const channelKey = options.channelKey ?? DEFAULT_DOM_CHANNEL_KEY;

  if (state.channelRegistry.has(channelKey)) {
    throw new Error(
      `installDom: channel "${channelKey}" already registered. ` +
      `Pass options.channelKey to namespace.`,
    );
  }

  for (const [rootKey, root] of Object.entries(sourceRoots)) {
    if (!state.cels.has(root.cel)) {
      throw new Error(
        `installDom: root "${rootKey}" references cel "${root.cel}" which is not in state. ` +
        `Hydrate tree cels before calling installDom.`,
      );
    }
  }

  // Register the schema and metadata directly on state. Schemas don't
  // need to round-trip through JSON for our purposes — the kernel uses
  // the live ZodType as a Map key.
  state.schemas.set(VNODE_SCHEMA_KEY, vnodeSchema);
  state.schemaMetadata.set(VNODE_SCHEMA_KEY, {
    key: VNODE_SCHEMA_KEY,
    isChanged: VNODE_IS_CHANGED_KEY,
    diff: VNODE_DIFF_KEY,
    byteLength: VNODE_BYTELENGTH_KEY,
  });

  // Stamp each root cel with the live schema. Hydrate's auto-wire loop
  // (re-runs when we hydrate the patch cels below) will then materialize
  // _isChanged and _diffFn from the schema metadata. We only stamp
  // roots — intermediate tree cels (e.g. a sub-component's output that
  // gets composed into a root) don't need their own change suppression
  // because the root's _isChanged catches structural equality at the
  // top of the tree.
  for (const root of Object.values(sourceRoots)) {
    const cel = state.cels.get(root.cel)!;
    cel.schema = vnodeSchema;
  }

  // Build painter roots up front so the channel can resolve cel.key →
  // rootKey at enqueue time. onApplied still closes over each root's
  // `slot.lastApplied` so the patch fn keeps producing diffs against
  // what's actually on screen.
  const painterRoots: Record<string, PainterRoot> = {};
  const slots: Record<string, { lastApplied: VNode | null }> = {};

  // Patch fns + schema fns. Patch fn is now PURE — kernel routes the
  // resulting Patch through the dom channel via cel.channel.
  const patchFns = new Map<LambdaKey, Fn>([
    [VNODE_IS_CHANGED_KEY, (prev: unknown, next: unknown) =>
      !vnodeEquals(prev as VNode, next as VNode)],
    [VNODE_DIFF_KEY, (prev: unknown, next: unknown) =>
      diffVNodes(prev as VNode | null, next as VNode)],
    [VNODE_BYTELENGTH_KEY, (v: unknown) =>
      vnodeByteLength(v as VNode | null | undefined)],
  ]);
  const patchCels: DehydratedCel[] = [];
  const patchCelByRoot: Record<string, string> = {};

  for (const [rootKey, root] of Object.entries(sourceRoots)) {
    const slot: { lastApplied: VNode | null } = { lastApplied: null };
    slots[rootKey] = slot;

    const fnKey = patchFnKey(rootKey);
    const cKey = patchCelKey(rootKey);
    patchCelByRoot[rootKey] = cKey;

    patchFns.set(fnKey, ({ tree }: { tree: VNode }) =>
      diffVNodes(slot.lastApplied, tree));

    patchCels.push({
      key: cKey,
      segment: PLASTRON_DOM_SEGMENT,
      l: fnKey,
      inputMap: { tree: root.cel },
      channel: channelKey,
    });

    const dr: DomRoot = { patchCel: cKey };
    if (root.selector) dr.selector = root.selector;
    if (root.element)  dr.element  = root.element;
    painterRoots[rootKey] = {
      ...dr,
      onApplied: () => {
        const tree = state.cels.get(root.cel)?.v;
        if (tree && typeof tree === "object" && "type" in (tree as object)) {
          slot.lastApplied = tree as VNode;
        }
      },
    };
  }

  const channel = createDomChannel(state, painterRoots);
  state.channelRegistry.set(channelKey, channel);

  // Attach the manifest so a host loading multiple painters (each
  // with its own channelKey) gets exactly one entry in state.segments
  // — installDom is called per channel but the segment key stays the
  // same. Honour the channelKey override by emitting a manifest that
  // lists the actual channel.
  //
  // Multi-install caveat: installDom called twice with different
  // channelKeys will leave the second invocation's channelKey as the
  // recorded provider in `state.segments.get(PLASTRON_DOM_SEGMENT)
  // .provides.channels` — the manifest pass overwrites rather than
  // merges. This is intentional: the segment owns whichever channel it
  // most recently registered. The previously-registered channel still
  // works at runtime (it stays in state.channelRegistry), but it's no
  // longer advertised in the manifest. Hosts wanting both channels
  // discoverable via introspection should register the second handler
  // manually (state.channelRegistry.set + their own manifest patch)
  // rather than calling installDom twice.
  const manifest: SegmentManifest =
    channelKey === DEFAULT_DOM_CHANNEL_KEY
      ? plastronDomManifest
      : {
          ...plastronDomManifest,
          provides: {
            ...plastronDomManifest.provides,
            channels: [channelKey],
          },
        };

  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(
    state,
    [{ key: PLASTRON_DOM_SEGMENT, cels: patchCels, manifest }],
    [patchFns],
  );

  // Painter sentinel cel — `flush(PLASTRON_DOM_SEGMENT)` walks cels,
  // fires _dispose, removes them. The dispose hook tears down the
  // channel (cancels rAF, detaches listeners) and unregisters it from
  // state.channelRegistry.
  const painterCel: Cel = {
    key: painterCelKey(channelKey),
    v: null,
    segment: PLASTRON_DOM_SEGMENT,
    _dispose: () => {
      channel.dispose();
      state.channelRegistry.delete(channelKey);
    },
  };
  state.cels.set(painterCel.key, painterCel);

  return { channel, patchCels: patchCelByRoot };
};
