import type { Key } from "../../common.js";
import type { State } from "../types/index.js";
import type { LambdaKey, LambdaMetadata } from "../../lambdas/types/lambda.js";
import type { DehydratedCel, FnRegistry, HydrateOptions } from "./types.js";
import type { SegmentBundle } from "../segments/types/bundle.js";
import type { SegmentMetadata } from "../segments/types/segments.js";
import { validateBundleVersion } from "../segments/serialization.js";
import { hydrate } from "./hydrate.js";

// ========================================================================
// hydrateBundles — hydrate from one or more SegmentBundle objects.
// Wraps the lower-level hydrate() in three additional steps:
//
//   1. Bundle version validation — refuses incompatible formats.
//   2. Per-bundle verification via options.verifySegment, when the
//      bundle carries a manifest. Default (no verifier) accepts all.
//   3. Aggregation — fans bundles out into the cels[] / lambdas[] /
//      aliases / segments shape that hydrate() expects.
//
// fnRegistry is supplied separately because bundles never carry real
// native-kind function references (those ship as code, not data). For
// non-native kinds, the lambda source string travels inside the bundle
// via LambdaMetadata.source.
// ========================================================================

export const hydrateBundles = async (
  bundles: SegmentBundle[],
  fnRegistry: FnRegistry = {},
  existing?: State,
  options?: HydrateOptions,
): Promise<State> => {
  for (const b of bundles) validateBundleVersion(b);

  const verifier = options?.verifySegment;
  if (verifier) {
    for (const b of bundles) {
      if (!b.manifest) continue;
      const result = await Promise.resolve(verifier(b, b.manifest));
      if (!result.ok) {
        const reason = result.reason ?? "no reason given";
        const verifierName = result.verifier ? ` (verifier: ${result.verifier})` : "";
        throw new Error(
          `Segment "${b.key}" failed verification: ${reason}${verifierName}`
        );
      }
    }
  }

  const cels: Array<Record<Key, DehydratedCel>> = [];
  const lambdas: Array<Record<LambdaKey, LambdaMetadata>> = [];
  const aliases: Record<string, LambdaKey> = { ...(options?.aliases ?? {}) };
  const segments: Record<Key, SegmentMetadata> = { ...(options?.segments ?? {}) };

  for (const b of bundles) {
    cels.push(b.cels);
    if (b.lambdas) lambdas.push(b.lambdas);
    if (b.aliases) Object.assign(aliases, b.aliases);
    if (b.metadata) segments[b.key] = { ...b.metadata, key: b.key };
  }

  return await hydrate(cels, lambdas, fnRegistry, existing, {
    ...options,
    aliases,
    segments,
  });
};
