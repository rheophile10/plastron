import type {
  Cel, DehydratedCel, Fn, LambdaKey, State,
} from "../../../plastron/src/index.js";
import { createPainter, type DomRoot, type PainterRoot, type Painter } from "./paint.js";
import { diffVNodes, isNoop } from "./diff.js";
import {
  vnodeEquals, vnodeSchema,
  VNODE_SCHEMA_KEY, VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY,
  type VNode,
} from "./vnode.js";

// ========================================================================
// segment: plastron-dom
//
// Pipeline (per root):
//
//   <user tree cel> ──→ __plastronDom:patch:<rootKey> ──→ painter (rAF)
//        wave 0                wave 1
//
//   The patch cel is graph-resident: its `v` is a Patch (JSON-shape,
//   inspectable, snapshottable). Its lambda also schedules an rAF on
//   the painter side as a side effect — combined to avoid an extra cel
//   per root.
//
//   The patch fn's closure holds a `lastApplied: VNode | null` reference
//   shared with the painter. Each cycle's diff is computed against
//   lastApplied, NOT against the previously-rendered tree — that way,
//   if multiple cycles run between rAFs, each successive patch
//   supersedes the previous one. The painter's onApplied callback
//   advances lastApplied to whatever it just committed to the DOM.
//
// Tree cels declare `schema: vnodeSchema` (exported from this module).
// installDom registers the schema's isChanged + diff fns; hydrate's
// auto-wire materializes them onto every tree cel as cel._isChanged
// and cel._diffFn. No manual patching, no tag handler — change
// detection lives where it belongs (on the schema).
//
// Teardown is `flush(PLASTRON_DOM_SEGMENT)`: the painter sentinel cel
// has a `_dispose` closure that cancels rAF, detaches listeners, and
// clears mounted state. flush walks every cel with the segment marker,
// fires its _dispose, removes it. No JS-level uninstall method.
// ========================================================================

export const PLASTRON_DOM_SEGMENT = "plastronDom" as const;

export type {
  VNode, VText, VElement, AttrValue, EventBinding, EventInfo,
} from "./vnode.js";
export {
  el, text, vnodeEquals, vnodeSchema,
  VNODE_SCHEMA_KEY, VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY,
} from "./vnode.js";
export type { Patch, PatchEl, PatchInit, PatchReplace, PatchText, PatchNoop, ChildPatch } from "./diff.js";
export { diffVNodes, isNoop } from "./diff.js";
export type { DomRoot, Painter } from "./paint.js";
export { createPainter } from "./paint.js";

export interface InstallDomOptions {
  /** Map from a stable root key (your choice) to mount target + tree cel. */
  roots: Record<string, { selector?: string; element?: Element; cel: string }>;
}

export interface DomHandle {
  painter: Painter;
  /** Patch cel keys, one per root. Useful for devtools / snapshot
   *  tooling that wants to inspect "what's about to be applied." */
  patchCels: Record<string, string>;
}

const PAINTER_CEL_KEY = "__plastronDom:painter" as const;
const patchCelKey = (rk: string): string => `__plastronDom:patch:${rk}`;
const patchFnKey  = (rk: string): string => `__plastronDom:patchFn:${rk}`;

/** Install the plastron-dom segment on an existing State. Tree cels
 *  must already be hydrated and must declare `schema: vnodeSchema`.
 *  installDom registers the schema's isChanged + diff fns (the
 *  kernel's auto-wire then attaches them to every matching tree cel),
 *  builds one patch cel per root, and creates the painter.
 *
 *  Teardown: call `state.fns.get("flush")(state, PLASTRON_DOM_SEGMENT)`. */
export const installDom = (
  state: State,
  options: InstallDomOptions,
): DomHandle => {
  const sourceRoots = options.roots;
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

  // Painter is created up front so the per-root patch fns can capture it.
  const painterRoots: Record<string, PainterRoot> = {};
  const painter = createPainter(state, painterRoots);

  // Per-root closures + the patch fn that uses them.
  const patchFns = new Map<LambdaKey, Fn>([
    [VNODE_IS_CHANGED_KEY, (prev: unknown, next: unknown) =>
      !vnodeEquals(prev as VNode, next as VNode)],
    [VNODE_DIFF_KEY, (prev: unknown, next: unknown) =>
      diffVNodes(prev as VNode | null, next as VNode)],
  ]);
  const patchCels: DehydratedCel[] = [];
  const patchCelByRoot: Record<string, string> = {};

  for (const [rootKey, root] of Object.entries(sourceRoots)) {
    // Closure shared between the diff fn and the painter:
    //   lastApplied — what's currently in the DOM (or null pre-mount).
    const slot: { lastApplied: VNode | null } = { lastApplied: null };

    const fnKey = patchFnKey(rootKey);
    const cKey = patchCelKey(rootKey);
    patchCelByRoot[rootKey] = cKey;

    patchFns.set(fnKey, ({ tree }: { tree: VNode }) => {
      const patch = diffVNodes(slot.lastApplied, tree);
      if (!isNoop(patch)) painter.schedule(rootKey);
      return patch;
    });

    patchCels.push({
      key: cKey,
      segment: PLASTRON_DOM_SEGMENT,
      l: fnKey,
      inputMap: { tree: root.cel },
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

  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(state, [{ key: PLASTRON_DOM_SEGMENT, cels: patchCels }], [patchFns]);

  // Painter sentinel cel — `flush(PLASTRON_DOM_SEGMENT)` walks cels,
  // fires _dispose, removes them. The painter is captured by closure;
  // cel.v stays null so the cel round-trips cleanly through dehydrate.
  const painterCel: Cel = {
    key: PAINTER_CEL_KEY,
    v: null,
    segment: PLASTRON_DOM_SEGMENT,
    _dispose: () => painter.dispose(),
  };
  state.cels.set(PAINTER_CEL_KEY, painterCel);

  // Initial paint — every root mounts on the next rAF.
  painter.scheduleAll();

  return { painter, patchCels: patchCelByRoot };
};
