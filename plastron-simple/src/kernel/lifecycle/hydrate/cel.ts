import type {
  Cel, CelMetadata, ChannelCel, ComputeCel, ComputeCelMetadata, DehydratedCel,
  State,
} from "../../../types/index.js";
import { isFireable } from "../../../types/index.js";
import { resolveFn } from "../../resolve-fn.js";

// tsconfig deliberately omits DOM/Node libs; declare the one host
// global we touch (best-effort deprecation warning) locally.
declare const console: { warn(message: string): void } | undefined;

// One-time deprecation warning when a .甲 still uses the old
// FormulaCelMetadata.compiler field. The migration itself is silent
// per-cel; we only log the first occurrence to keep output sane.
let compilerMigrationWarned = false;

const migrateCompilerToParser = (
  metadata: { parser?: string; compiler?: string },
  key: string,
): void => {
  if (metadata.compiler === undefined) return;
  if (metadata.parser === undefined) metadata.parser = metadata.compiler;
  delete metadata.compiler;
  if (compilerMigrationWarned) return;
  compilerMigrationWarned = true;
  console?.warn(
    `plastron: FormulaCelMetadata.compiler is deprecated — ` +
    `rename to FormulaCelMetadata.parser. Migrated cel "${key}" ` +
    `(further occurrences in this process are silenced).`,
  );
};

// Build a live Cel of the right kind from a DehydratedCel. Pure
// construct — no compilation. Fireable cels carry over their `f`
// source body but `_fn` is left unset; compileFireable runs a topo-
// ordered compile pass after every cel in the hydrate batch is
// installed, so a compiler defined in the same batch as the cels
// that name it resolves correctly.
export const inflateCel = (dc: DehydratedCel): Cel => {
  const metadata: CelMetadata = { ...dc.metadata, key: dc.key };
  if (dc.celType === "FormulaCel") {
    migrateCompilerToParser(metadata as { parser?: string; compiler?: string }, dc.key);
  }
  // Authored seed JSON puts `v` at the DehydratedCel top level for
  // readability (see js-common-schema.json, cel-error.json — schema
  // bodies are too rich to nest under metadata). Dehydrate, by contrast,
  // writes value into metadata.v so the type stays homogeneous. Inflate
  // accepts either: top-level wins (the authoring form), metadata.v is
  // the fallback (round-trip form).
  const dcLoose = dc as DehydratedCel & { v?: unknown };
  const baseV: unknown = dcLoose.v ?? metadata.v ?? null;

  switch (dc.celType) {
    case "ValueCel": {
      const cel = { celType: "ValueCel", metadata, v: baseV } as Cel;
      if (dc.wave   !== undefined) (cel as { wave?: number }).wave   = dc.wave;
      if (dc.locked !== undefined) cel.locked  = dc.locked;
      return cel;
    }
    case "SchemaCel":
    case "CompilerCel":
    case "ChannelCel": {
      const cel = { celType: dc.celType, metadata, v: baseV } as Cel;
      if (dc.locked !== undefined) cel.locked = dc.locked;
      if (dc.celType === "ChannelCel") {
        // Live Channel cache is populated by precompute.buildChannel;
        // placeholder here is just the dehydrated descriptor on v.
        (cel as ChannelCel)._channel = undefined;
      }
      return cel;
    }
    case "FormulaCel":
    case "EditableLambdaCel":
    case "LockedLambdaCel": {
      const cel = {
        celType: dc.celType,
        metadata: metadata as ComputeCelMetadata,
        v: baseV,
      } as ComputeCel;
      if (dc.wave    !== undefined) cel.wave    = dc.wave;
      if (dc.locked  !== undefined) cel.locked  = dc.locked;
      if (dc.dynamic !== undefined) cel.dynamic = dc.dynamic;
      if (dc.f       !== undefined) cel.f       = dc.f;
      return cel as Cel;
    }
  }
};

export const disposeCel = (cel: Cel, state: State): void => {
  if (isFireable(cel) && cel._dispose) {
    try { cel._dispose(); } catch { /* swallow */ }
  }
  const disposeKey = cel.schema?.protocols.dispose;
  const disposeFn = disposeKey ? resolveFn(state, disposeKey) : undefined;
  if (disposeFn) {
    try { disposeFn(); } catch { /* swallow */ }
  }
};
