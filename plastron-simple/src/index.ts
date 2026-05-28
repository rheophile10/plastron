import type {
  Cel, Key, State, 冊,
} from "./types/index.js";

import manifestSeed from "./甲骨坑/冊.json" with { type: "json" };

// Code seeds — each module exports `name` (segment) and `cels: Cel[]`.
// Lambda + Compiler cels ship with their runtime fn already on the cel
// (LambdaCel._fn, CompilerCel.v), so the kernel's resolveFn(state, key)
// reaches them directly from state.cels — no separate dispatch surface.
import * as kernelInternal  from "./甲骨坑/kernel-internal.js";
import * as kernelIo        from "./甲骨坑/kernel-io.js";
import * as kernelLifecycle from "./甲骨坑/kernel-lifecycle.js";
import * as kernelSegments  from "./甲骨坑/kernel-segments.js";
import * as csp             from "./甲骨坑/csp.js";
import * as celError        from "./甲骨坑/cel-error.js";
import * as host            from "./甲骨坑/host.js";
import * as wasmTypes       from "./甲骨坑/wasm-types.js";
import * as lambdaSource    from "./甲骨坑/lambda-source.js";
import * as jsCommonSchema  from "./甲骨坑/js-common-schema.js";
import * as jsCompiler      from "./甲骨坑/js-compiler.js";
import * as builtins        from "./甲骨坑/builtins.js";
import * as watCompiler     from "./甲骨坑/wat-compiler.js";
import * as wasmBytes       from "./甲骨坑/wasm-bytes.js";
import * as pyCompiler      from "./甲骨坑/py-compiler.js";
import * as quickjsCompiler from "./甲骨坑/quickjs-compiler.js";
import * as fileStore       from "./甲骨坑/file-store.js";
import * as htmlTemplate    from "./甲骨坑/html-template-parser.js";
import * as plastronDom     from "./甲骨坑/plastron-dom.js";
import * as segmentStore    from "./甲骨坑/segment-store.js";
import * as opfsSeeding     from "./甲骨坑/opfs-seeding.js";
import * as cliSegmentExport from "./甲骨坑/cli-segment-export.js";
import * as sheet           from "./甲骨坑/sheet.js";
import * as userSpaceOps    from "./甲骨坑/user-space-ops.js";
import * as segmentArchive  from "./甲骨坑/segment-archive.js";
import * as appHost         from "./甲骨坑/app-host.js";
import * as sound           from "./甲骨坑/sound.js";

// ============================================================================
// Boot dispatch — 冊.json drives which segments install. Each named
// manifest must have a loader registered below. The loader returns
// the Cel[] to install. Adding a new bundled segment is two lines:
// import here, add a loader entry.
// ============================================================================

const segmentLoaders: Record<Key, () => Cel[]> = {
  "kernel":           () => [
    // kernelInternal.cels is a builder — its v's are mutable containers
    // (Maps inside PrecomputedIndexes, the compile-cache Map itself)
    // and each State needs its own.
    ...kernelInternal.cels(),
    ...kernelIo.cels,
    ...kernelLifecycle.cels,
    ...kernelSegments.cels,
  ],
  "csp":              () => [...csp.cels],
  "cel-error":        () => [...celError.cels],
  "host":             () => [...host.cels],
  "wasm-types":       () => [...wasmTypes.cels],
  "lambda-source":    () => [...lambdaSource.cels],
  "js-common-schema": () => [...jsCommonSchema.cels],
  "js-compiler":      () => [...jsCompiler.cels],
  "builtins":         () => [...builtins.cels],
  "wat-compiler":     () => [...watCompiler.cels],
  "wasm-bytes":       () => [...wasmBytes.cels],
  "py-compiler":      () => [...pyCompiler.cels],
  "quickjs-compiler": () => [...quickjsCompiler.cels],
  "file-store":       () => [...fileStore.cels],
  "html-template-parser": () => [...htmlTemplate.cels],
  "plastron-dom":     () => [...plastronDom.cels],
  "segment-store":    () => [...segmentStore.cels],
  "opfs-seeding":     () => [...opfsSeeding.cels],
  "cli-segment-export": () => [...cliSegmentExport.cels],
  "sheet":            () => [...sheet.cels],
  "user-space-ops":   () => [...userSpaceOps.cels],
  "segment-archive":  () => [...segmentArchive.cels],
  "app-host":         () => [...appHost.cels],
  "sound":            () => [...sound.cels],
};

const seedManifests: ReadonlyArray<冊> = manifestSeed as unknown as 冊[];

export const createInitialState = (): State => {
  const cels     = new Map<Key, Cel>();
  const segments = new Map<Key, 冊>();

  for (const m of seedManifests) {
    segments.set(m.name, m);
    const loader = segmentLoaders[m.name];
    if (!loader) {
      throw new Error(
        `createInitialState: 冊.json names segment "${m.name}" but no loader is registered.`,
      );
    }
    for (const cel of loader()) {
      cels.set(cel.metadata.key, cel);
    }
  }

  return {
    cels,
    precomputeGeneration: 0,
    segments,
  };
};

export type * from "./types/index.js";
export { precompute, precomputeOptional } from "./kernel/precompute/index.js";
export {
  getSegmentManifest, listSegments, findDependents,
} from "./kernel/segments.js";
export { zodToJsonSchema, jsonSchemaToZod } from "./kernel/zod-schema-utils.js";
export { resolveFn } from "./kernel/resolve-fn.js";
export { isFireable, kindOf } from "./types/cels.js";
export { isWitPrimitive, isWasmHandle } from "./types/wit.js";
export { isCelError, makeCelError } from "./甲骨坑/cel-error.js";
export { buildSheet } from "./甲骨坑/sheet.js";
export { buildNotepad, installNotepadActions } from "./甲骨坑/notepad/build.js";
export { buildWebEditor, installWebEditorActions, COUNTER_EXAMPLE, WEATHER_EXAMPLE } from "./甲骨坑/web-editor/build.js";
export { createPainter, getPainter, setPainter } from "./甲骨坑/plastron-dom.js";
