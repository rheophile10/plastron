import { createRuntime, hydrate, hydrateBundles } from "./state/index.js";
import type { DehydratedCel, FnRegistry, HydrateOptions, State, SegmentBundle } from "./state/index.js";
import type { LambdaMetadata } from "./lambdas/types/lambda.js";
import type { Key } from "./common.js";
import { installAllDefaults } from "./segments/defaults/index.js";

// ============================================================================
// plastron / runtime — the top-level entry points.
//
//   runtime(cels, lambdas, fnRegistry, options)
//     The English-named, cels-and-lambdas hydration path. Returns a
//     primed State with cycle + input attached and the default segments
//     (changeIndices, errors) installed.
//
//   runtimeFromBundles(bundles, fnRegistry, options)
//     The bundle-shaped variant. Each SegmentBundle carries its own
//     cels, lambda metadata, aliases, segment metadata, and optional
//     cryptographic manifest. options.verifySegment is consulted per
//     bundle when a manifest is present.
//
//   plastron(...)
//     Default export — alias for runtime(). Plastron core is English-
//     named; the plastromancy 龜卜藏 facade lives in the showcase
//     example (examples/plastromancy/src/mask/), demonstrating that
//     custom facades sit cleanly on top of the kernel.
// ============================================================================

const helloWorldCels = (): Record<string, DehydratedCel> => {
  const today = new Date().toISOString().slice(0, 10);
  return {
    name:    { key: "name",    segment: "helloWorld", v: "World" },
    date:    { key: "date",    segment: "helloWorld", v: today },
    welcome: {
      key: "welcome",
      segment: "helloWorld",
      f: "'hello ' |> concat(@name) |> concat(', welcome to plastron on ') |> concat(@date)",
    },
  };
};

export const runtime = async (
  cels: Record<Key, DehydratedCel>[] = [helloWorldCels()],
  lambdas: Record<Key, LambdaMetadata>[] = [],
  fnRegistry: FnRegistry = {},
  options?: HydrateOptions,
): Promise<State> => {
  const state = await hydrate(cels, lambdas, fnRegistry, undefined, options);
  const rt = createRuntime(state);
  if (options?.installDefaults !== false) {
    await installAllDefaults(rt);
  }
  return rt;
};

export const runtimeFromBundles = async (
  bundles: SegmentBundle[],
  fnRegistry: FnRegistry = {},
  options?: HydrateOptions,
): Promise<State> => {
  const state = await hydrateBundles(bundles, fnRegistry, undefined, options);
  const rt = createRuntime(state);
  if (options?.installDefaults !== false) {
    await installAllDefaults(rt);
  }
  return rt;
};

const plastron = runtime;
export default plastron;

export { replaceCels } from "./state/index.js";
export type {
  LambdaKindHandler, KindContext, KindRegistry, CompiledLambda, DisposeFn,
} from "./lambdas/types/kind.js";
export type {
  SegmentRole, SegmentMetadata, SegmentRegistry,
} from "./state/segments/types/index.js";
export type {
  HookSubscription, HookName,
  BeforeCycleEvent, AfterLambdaInvokeEvent, AfterWaveEvent,
  AfterCycleEvent, AfterHydrateEvent,
} from "./state/cycle/hooks.js";
export type {
  TaggedValue, TagProtocol, TagRegistry,
} from "./state/types/tags.js";
export {
  TAG_FIELD, TAG_VALUE_FIELD, isTaggedValue, tagged,
} from "./state/types/tags.js";
export type {
  SegmentBundle, SegmentManifest, SegmentCapabilities, VerificationResult,
} from "./state/segments/types/index.js";
export { BUNDLE_FORMAT_VERSION } from "./state/segments/types/index.js";
export {
  canonicalize, sha256Hex, bundleContentHash, validateBundleVersion,
} from "./state/segments/serialization.js";
export { nativeKind } from "./lambdas/kinds/native.js";
export {
  fingerprint, fingerprintComponents, ENGINE_VERSION,
} from "./state/fingerprint.js";
export type { FingerprintComponents } from "./state/fingerprint.js";
export {
  installChangeIndices, installErrors, installAllDefaults,
  changeIndicesCels, changeIndicesHook, CHANGE_INDICES_SEGMENT,
  errorsCels, errorsHook, ERRORS_SEGMENT,
} from "./segments/defaults/index.js";
