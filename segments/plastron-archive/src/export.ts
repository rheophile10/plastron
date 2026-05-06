import type {
  State, SegmentBundle, SegmentRegistry, SegmentRole,
} from "../../../plastron/src/index.js";
import {
  canonicalize, sha256Hex, fingerprint, fingerprintComponents,
  BUNDLE_FORMAT_VERSION,
} from "../../../plastron/src/index.js";
import type { Cel } from "../../../plastron/src/state/types/cel.js";
import type {
  DehydratedCel, FnRegistry,
} from "../../../plastron/src/state/index.js";
import type { LambdaMetadata, LambdaKey } from "../../../plastron/src/lambdas/types/lambda.js";
import type { Key } from "../../../plastron/src/common.js";
import type {
  ArchiveBody, ArchiveManifest, ArchiveRequires, ArchiveCreator,
} from "./manifest.js";
import { ARCHIVE_FORMAT_VERSION, ARCHIVE_MIME } from "./manifest.js";

// ========================================================================
// exportArchive — serialize a runtime State to a canonical `.甲` JSON
// string.
//
// The export flow:
//
//   1. Group cels by their .segment field. Skip system roles
//      (config / indexes / state / input / changeIndices / errors)
//      unless explicitly included via options.
//   2. Dehydrate each cel — strip _-prefixed runtime fields, project
//      back to the DehydratedCel shape. Provenance fields and tagged
//      values flow through unchanged.
//   3. Collect lambda metadata for every lambda key referenced in each
//      segment's cels. For non-native kinds the source string travels
//      with the metadata; native lambdas carry only metadata (the host
//      must supply the Fn at import).
//   4. Emit one SegmentBundle per segment, copying segment metadata and
//      manifest from the segmentRegistry cel.
//   5. Compute the requires block from State (kinds, tags, segments,
//      native lambda keys actually referenced).
//   6. Wrap in an ArchiveManifest. Optionally sign.
//   7. Canonicalize the whole thing to deterministic JSON.
// ========================================================================

const SYSTEM_ROLES: ReadonlySet<SegmentRole | undefined> = new Set([
  "system",
] as const);

/** Segments whose cels are never copied into bundles. Two kinds of
 *  reasons:
 *    • config / indexes / state / input — runtime-owned plumbing,
 *      not part of any user document; rebuilt at bootstrap.
 *    • auditLog — its events are archived separately as body.auditLog
 *      (a discrete field) so the host can decide to replay, drop, or
 *      merge them. The segment itself is re-installed fresh on import. */
const SKIP_BUNDLE_SEGMENTS: ReadonlySet<string> = new Set([
  "config", "indexes", "state", "input",
  "auditLog",
]);

/** Serialize a Cel back to its DehydratedCel form. Strips _-prefixed
 *  runtime fields; preserves user-set fields including provenance. */
const dehydrateCel = (cel: Cel): DehydratedCel => {
  const dc: DehydratedCel = {
    key: cel.key,
    segment: cel.segment ?? "",
  };
  if (cel.v !== null && cel.v !== undefined) dc.v = cel.v;
  if (cel.children && cel.children.length > 0) dc.children = [...cel.children];
  if (cel.tags) dc.tags = [...cel.tags];
  if (cel.schema !== undefined) dc.schema = cel.schema;
  if (cel.name !== undefined) dc.name = cel.name;
  if (cel.description !== undefined) dc.description = cel.description;
  if (cel.metadata !== undefined) dc.metadata = cel.metadata;
  if (cel.readOnly !== undefined) dc.readOnly = cel.readOnly;
  if (cel.l !== undefined) dc.l = cel.l;
  if (cel.kind !== undefined) dc.kind = cel.kind;
  if (cel.inputMap !== undefined) dc.inputMap = { ...cel.inputMap };
  if (cel.imports !== undefined) dc.imports = [...cel.imports];
  if (cel.f !== undefined) dc.f = cel.f;
  if (cel.sizeHint !== undefined) dc.sizeHint = cel.sizeHint;
  if (cel.dynamic !== undefined) dc.dynamic = cel.dynamic;
  if (cel.wave !== undefined) dc.wave = cel.wave;
  if (cel.prevDepth !== undefined) dc.prevDepth = cel.prevDepth;
  if (cel.authoredBy !== undefined) dc.authoredBy = cel.authoredBy;
  if (cel.generatedAt !== undefined) dc.generatedAt = cel.generatedAt;
  if (cel.promptId !== undefined) dc.promptId = cel.promptId;
  if (cel.agentModel !== undefined) dc.agentModel = cel.agentModel;
  return dc;
};

/** Strip runtime-only fields from LambdaMetadata. */
const cleanLambdaMeta = (meta: LambdaMetadata): LambdaMetadata => {
  const { ...rest } = meta;
  return rest;
};

const collectBundles = (
  state: State,
  options: { includeRoles?: ReadonlySet<SegmentRole> },
): SegmentBundle[] => {
  const cels = state.Cels;
  const registry = (cels.get("segmentRegistry")?.v ?? {}) as SegmentRegistry;
  const includeRoles = options.includeRoles
    ?? new Set<SegmentRole>(["code", "schema", "documentation", "metadata", "test", "devtools"]);

  // Group cels by segment.
  const bySegment = new Map<Key, Cel[]>();
  for (const cel of cels.values()) {
    if (!cel.segment) continue;
    if (SKIP_BUNDLE_SEGMENTS.has(cel.segment)) continue;
    if (!bySegment.has(cel.segment)) bySegment.set(cel.segment, []);
    bySegment.get(cel.segment)!.push(cel);
  }

  const bundles: SegmentBundle[] = [];
  for (const [segmentKey, segCels] of bySegment) {
    const segMeta = registry[segmentKey];
    // Apply role filter if registry knows the role; otherwise include.
    if (segMeta?.role) {
      if (SYSTEM_ROLES.has(segMeta.role)) continue;
      if (!includeRoles.has(segMeta.role)) continue;
    }

    // Build cels record.
    const celsRecord: Record<Key, DehydratedCel> = {};
    for (const cel of segCels) {
      celsRecord[cel.key] = dehydrateCel(cel);
    }

    // Build lambdas record — every unique lambda key referenced in this
    // segment's cels, taken from cel._lambdaMeta.
    const lambdasRecord: Record<LambdaKey, LambdaMetadata> = {};
    for (const cel of segCels) {
      if (!cel.l || !cel._lambdaMeta) continue;
      if (!lambdasRecord[cel.l]) {
        lambdasRecord[cel.l] = cleanLambdaMeta(cel._lambdaMeta);
      }
    }

    const bundle: SegmentBundle = {
      version: BUNDLE_FORMAT_VERSION,
      key: segmentKey,
      cels: celsRecord,
    };
    if (Object.keys(lambdasRecord).length > 0) bundle.lambdas = lambdasRecord;

    if (segMeta) {
      const { key: _segKey, ...metaWithoutKey } = segMeta;
      if (Object.keys(metaWithoutKey).length > 0) {
        bundle.metadata = metaWithoutKey;
      }
    }

    bundles.push(bundle);
  }

  return bundles;
};

/** Walk the State and derive an ArchiveRequires block automatically. */
const deriveRequires = (state: State): ArchiveRequires => {
  const components = fingerprintComponents(state);

  const nativeKeys = new Set<string>();
  for (const cel of state.Cels.values()) {
    if (!cel.l) continue;
    const kindKey = cel.kind ?? cel._lambdaMeta?.kind ?? "native";
    if (kindKey === "native") nativeKeys.add(cel.l);
  }

  // Filter out only role="system" segments from requires. Runtime-
  // owned plumbing (config/indexes/state/input) doesn't appear in
  // segmentRegistry so it's already absent from components.segments.
  // auditLog (role="metadata") legitimately belongs in requires —
  // the host needs to install it to capture future events even though
  // its cels aren't bundled.
  const userlandSegments = components.segments
    .filter((s) => s.role !== "system")
    .map((s) => s.key)
    .sort();

  return {
    kinds: components.kinds.length > 0 ? components.kinds : undefined,
    tags: components.tags.length > 0 ? components.tags : undefined,
    segments: userlandSegments.length > 0 ? userlandSegments : undefined,
    nativeLambdas: nativeKeys.size > 0 ? [...nativeKeys].sort() : undefined,
  };
};

export interface ExportOptions {
  /** When true, the exporter looks up the auditEvents cel and embeds
   *  its current value into the archive body. Default false. */
  includeAuditLog?: boolean;
  /** Optional creator metadata. */
  createdBy?: ArchiveCreator;
  /** Override role filter. Default: code, schema, documentation,
   *  metadata, test, devtools (excludes system). */
  includeRoles?: ReadonlySet<SegmentRole>;
  /** When provided, the exporter computes the canonical content hash
   *  of the archive body and signs it with Ed25519. signEd25519 is
   *  passed in to keep this segment dependency-free; in practice the
   *  caller imports it from plastron-trust. */
  signWith?: {
    privateKey: string;
    publicKey: string;
    signerName?: string;
    signEd25519: (data: string, privateKey: string) => Promise<string>;
  };
  /** Override or augment the auto-derived requires block. */
  requires?: ArchiveRequires;
}

/** Serialize a runtime State to a canonical `.甲` JSON string. */
export const exportArchive = async (
  state: State,
  options: ExportOptions = {},
): Promise<string> => {
  const fp = await fingerprint(state);
  const requires = options.requires ?? deriveRequires(state);
  const bundles = collectBundles(state, { includeRoles: options.includeRoles });

  let auditLog: unknown[] | undefined;
  if (options.includeAuditLog) {
    const events = state.Cels.get("auditEvents")?.v;
    if (Array.isArray(events) && events.length > 0) auditLog = events;
  }

  const archiveManifest: ArchiveManifest = {
    version: ARCHIVE_FORMAT_VERSION,
    format: ARCHIVE_MIME,
    fingerprint: fp,
    createdAt: new Date().toISOString(),
    componentSnapshot: fingerprintComponents(state),
  };
  if (options.createdBy) archiveManifest.createdBy = options.createdBy;
  if (Object.keys(requires).length > 0) archiveManifest.requires = requires;

  const body: ArchiveBody = {
    manifest: archiveManifest,
    bundles,
  };
  if (auditLog) body.auditLog = auditLog;

  if (options.signWith) {
    // Hash the canonical body with the manifest's own .manifest field
    // stripped (avoids circular signing).
    const { manifest: _existingSeal, ...manifestWithoutSeal } = archiveManifest;
    const bodyForHash: ArchiveBody = { ...body, manifest: manifestWithoutSeal as ArchiveManifest };
    const contentHash = await sha256Hex(canonicalize(bodyForHash));
    const signature = await options.signWith.signEd25519(contentHash, options.signWith.privateKey);
    archiveManifest.manifest = {
      contentHash,
      signature,
      signerPublicKey: options.signWith.publicKey,
      signedAt: new Date().toISOString(),
    };
    if (options.signWith.signerName !== undefined) {
      archiveManifest.manifest.signerName = options.signWith.signerName;
    }
  }

  return canonicalize(body);
};
