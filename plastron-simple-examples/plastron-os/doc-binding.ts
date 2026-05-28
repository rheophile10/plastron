// ============================================================================
// doc-binding.ts — bind each app's editor cels to the active user-space.
//
// Background. saveUserSpace(doc) dehydrates cels whose metadata.segment === doc.
// At boot, an app like notepad authors `notepad.text` with metadata.segment =
// "notepad" (the application segment), so a naïve save persists nothing
// document-shaped. This module is the bridge: each app declares its editor
// cels via registerDocBinding({ app, cels, empty }), and file.new / file.save /
// file.open call rebindCelsToDoc to retarget those cels' metadata.segment to
// the active user-space. dehydrate then picks them up; hydrate (on load)
// replaces them again with the persisted values.
//
// The mechanism is the kernel's documented hydrate-replace-collision path:
// inflateAllCels replaces an existing unlocked cel with the incoming one
// (after disposeCel), and hydrate accepts `manifests: []` so we can rebind
// cels without re-asserting the manifest (which is already loaded).
// ============================================================================

import { resolveFn } from "../../plastron-simple/dist/index.js";

type State = unknown;
type Cel = { celType: string; v?: unknown; f?: string; metadata: Record<string, unknown> };

export interface DocBinding {
  /** application segment name — used as the registry key */
  readonly app: string;
  /** the cel keys whose values "are" the document */
  readonly cels: readonly string[];
  /** initial value for each cel when starting a fresh document */
  empty: (key: string) => unknown;
}

const bindings = new Map<string, DocBinding>();

export const registerDocBinding = (binding: DocBinding): void => {
  bindings.set(binding.app, binding);
};

export const getDocBinding = (app: string): DocBinding | undefined => bindings.get(app);

const get = (state: State, key: string): unknown =>
  (resolveFn(state as never, "get") as (...a: unknown[]) => unknown)(state, key);

const cels = (state: State): Map<string, Cel> =>
  (state as { cels: Map<string, Cel> }).cels;

/** Build a dehydrated-cel record for one editor cel, retargeted to `doc`.
 *  `clear` resets to the app's empty seed (used by New); otherwise the
 *  cel's current value + (formula) source is carried over. */
const buildRebindDC = (
  state: State, binding: DocBinding, key: string, doc: string, clear: boolean,
): Record<string, unknown> => {
  const existing = cels(state).get(key);
  if (clear || !existing) {
    return {
      key, celType: "ValueCel",
      metadata: { key, segment: doc, v: binding.empty(key) },
    };
  }
  const md: Record<string, unknown> = { ...existing.metadata, key, segment: doc };
  if (existing.v !== undefined) md.v = existing.v;
  const dc: Record<string, unknown> = {
    key, celType: existing.celType, metadata: md,
  };
  if (existing.f !== undefined) dc.f = existing.f;
  return dc;
};

/** Retarget the active editor cels of `app` to belong to user-space `doc`.
 *  Pass `clear: true` for a fresh New (start blank). */
export const rebindCelsToDoc = async (
  state: State, app: string, doc: string, opts: { clear?: boolean } = {},
): Promise<void> => {
  const binding = bindings.get(app);
  if (!binding) return;
  const hydrate = resolveFn(state as never, "hydrate") as (...a: unknown[]) => Promise<unknown>;
  const dcs = binding.cels.map((k) => buildRebindDC(state, binding, k, doc, opts.clear ?? false));
  await hydrate(state, [{ name: doc, cels: dcs }], []);
};

/** True if cel `key` (an editor cel) currently belongs to user-space `doc`. */
export const isCelInDoc = (state: State, key: string, doc: string): boolean =>
  cels(state).get(key)?.metadata.segment === doc;

/** The active doc per os.doc, or null if no document is loaded. */
export const activeDoc = (state: State): string | null => {
  const v = get(state, "os.doc");
  return typeof v === "string" && v.length > 0 ? v : null;
};
