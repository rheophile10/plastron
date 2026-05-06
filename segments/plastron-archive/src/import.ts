import type {
  State, FnRegistry, KindRegistry, TagRegistry,
  HookSubscription, HydrateOptions,
} from "../../../plastron/src/index.js";
import {
  runtimeFromBundles, ENGINE_VERSION, canonicalize, sha256Hex,
} from "../../../plastron/src/index.js";
import type { ArchiveBody, ArchiveManifest, ArchiveRequires } from "./manifest.js";
import { ARCHIVE_FORMAT_VERSION, ARCHIVE_MIME } from "./manifest.js";

// ========================================================================
// importArchive — load a `.甲` JSON string into a runtime.
//
// Three checks happen before hydration:
//
//   1. Format identity — the manifest's version + mime must match.
//   2. Requires validation — every kind / tag / native-lambda the
//      archive declares is required must be available on the host.
//      Throws a single combined error listing every missing piece, so
//      users don't fix one missing dep at a time.
//   3. Optional signature verification — if the archive carries a
//      top-level seal, the caller can pass a verifier; default skips.
//
// Then segments are installed via segmentResolver, and finally
// hydrateBundles runs.
// ========================================================================

export interface ImportOptions {
  /** FnRegistry for native lambdas. The archive's
   *  requires.nativeLambdas must all resolve in here. */
  fnRegistry?: FnRegistry;
  /** Kind handlers to register. Must cover requires.kinds. */
  kinds?: KindRegistry;
  /** Tag protocols to register. Must cover requires.tags. */
  tags?: TagRegistry;
  /** Resolver for named segments — e.g., "audit-log" → installAuditLog.
   *  Must handle every entry in requires.segments. */
  segmentResolver?: (segmentName: string, state: State) => Promise<void> | void;
  /** Hook subscribers to register at boot. */
  hooks?: HookSubscription[];
  /** Per-bundle manifest verifier passed through to hydrateBundles. */
  verifySegment?: HydrateOptions["verifySegment"];
  /** Top-level archive-seal verifier. When the archive carries
   *  manifest.manifest, this is invoked with (body, manifest). Default
   *  skips verification (records but does not enforce). */
  verifyArchive?: (
    body: ArchiveBody,
    manifest: NonNullable<ArchiveManifest["manifest"]>,
  ) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  /** Forwarded to the runtime constructor. */
  installDefaults?: boolean;
}

const compareEngineVersion = (required: string | undefined, actual: string): boolean => {
  if (!required) return true;
  // Tiny semver: support ">=X.Y.Z" or "X.Y.Z" exact match.
  const m = required.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [reqMajor, reqMinor, reqPatch] = m.slice(1).map(Number);
    const a = actual.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!a) return false;
    const [aMajor, aMinor, aPatch] = a.slice(1).map(Number);
    if (aMajor !== reqMajor) return aMajor > reqMajor;
    if (aMinor !== reqMinor) return aMinor > reqMinor;
    return aPatch >= reqPatch;
  }
  return required === actual;
};

const validateRequires = (
  requires: ArchiveRequires | undefined,
  options: ImportOptions,
): string[] => {
  if (!requires) return [];
  const missing: string[] = [];

  if (requires.engineVersion && !compareEngineVersion(requires.engineVersion, ENGINE_VERSION)) {
    missing.push(
      `engineVersion ${requires.engineVersion} (host has ${ENGINE_VERSION})`
    );
  }

  for (const k of requires.kinds ?? []) {
    if (k === "native") continue; // always available
    if (!options.kinds || !options.kinds[k]) {
      missing.push(`kind handler "${k}"`);
    }
  }

  for (const t of requires.tags ?? []) {
    if (!options.tags || !options.tags[t]) {
      missing.push(`tag protocol "${t}"`);
    }
  }

  for (const s of requires.segments ?? []) {
    if (!options.segmentResolver) {
      missing.push(`segment "${s}" (no segmentResolver provided)`);
    }
    // Per-segment availability is checked when the resolver is called;
    // a user-supplied resolver decides whether to throw or no-op.
  }

  for (const lk of requires.nativeLambdas ?? []) {
    if (!options.fnRegistry || !options.fnRegistry[lk]) {
      missing.push(`native lambda "${lk}"`);
    }
  }

  return missing;
};

/** Parse and load a `.甲` JSON string into a runtime. */
export const importArchive = async (
  source: string,
  options: ImportOptions = {},
): Promise<State> => {
  let body: ArchiveBody;
  try {
    body = JSON.parse(source) as ArchiveBody;
  } catch (e) {
    throw new Error(`plastron-archive: cannot parse archive JSON — ${(e as Error).message}`);
  }

  if (!body || typeof body !== "object" || !body.manifest) {
    throw new Error("plastron-archive: archive missing top-level manifest");
  }

  const m = body.manifest;
  if (m.format !== ARCHIVE_MIME) {
    throw new Error(`plastron-archive: unsupported format "${m.format}" (expected "${ARCHIVE_MIME}")`);
  }
  if (m.version !== ARCHIVE_FORMAT_VERSION) {
    throw new Error(
      `plastron-archive: archive declares version ${m.version} but this loader supports ${ARCHIVE_FORMAT_VERSION}`
    );
  }

  // ---------- Requires validation ----------
  const missing = validateRequires(m.requires, options);
  if (missing.length > 0) {
    throw new Error(
      `plastron-archive: archive requires the following but the host did not provide them:\n  • ` +
      missing.join("\n  • ")
    );
  }

  // ---------- Top-level signature verification ----------
  if (m.manifest && options.verifyArchive) {
    // Strip the seal before hashing — it must match what was hashed at sign-time.
    const { manifest: seal, ...manifestWithoutSeal } = m;
    const bodyForHash: ArchiveBody = { ...body, manifest: manifestWithoutSeal as ArchiveManifest };
    const expectedHash = await sha256Hex(canonicalize(bodyForHash));
    if (seal.contentHash !== expectedHash) {
      throw new Error(
        `plastron-archive: archive content hash mismatch — declared ${seal.contentHash}, computed ${expectedHash}`
      );
    }
    const result = await Promise.resolve(options.verifyArchive(body, seal));
    if (!result.ok) {
      throw new Error(`plastron-archive: archive verification refused — ${result.reason ?? "no reason given"}`);
    }
  }

  // ---------- Hydration ----------
  const state = await runtimeFromBundles(body.bundles, options.fnRegistry ?? {}, {
    kinds: options.kinds,
    tags: options.tags,
    hooks: options.hooks,
    verifySegment: options.verifySegment,
    installDefaults: options.installDefaults,
  });

  // ---------- Required segments ----------
  for (const s of m.requires?.segments ?? []) {
    if (options.segmentResolver) {
      await Promise.resolve(options.segmentResolver(s, state));
    }
  }

  // ---------- Replay audit log if present ----------
  // (We deliberately do NOT replay audit-log into the new runtime —
  //  the audit log is historical record, not state to reactivate. If
  //  the audit-log segment is installed by the resolver, fresh events
  //  will accumulate alongside whatever was archived.)

  return state;
};
