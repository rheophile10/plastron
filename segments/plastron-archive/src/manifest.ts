import type {
  SegmentBundle, SegmentManifest, FingerprintComponents,
} from "../../../plastron/src/index.js";

// ========================================================================
// Archive manifest — top-level metadata for a `.甲` file.
//
// The plastron-archive format wraps one or more SegmentBundles plus
// optional audit-log data and binary blobs into a single canonically-
// serialized JSON document. The archive manifest sits at the root and
// declares:
//
//   • format identity (mime, version)
//   • runtime fingerprint at export time
//   • requires block — kind handlers, tag protocols, named segments,
//     native lambda keys, engine version that the host must supply
//   • optional top-level signature over the archive contents
//
// Per-segment manifests still live inside their bundles (each 卷 may
// carry its own 印). The archive manifest is a 印 over the assembled
// stack of scrolls — the augur's seal on the bound book.
// ========================================================================

export const ARCHIVE_FORMAT_VERSION = 1 as const;

/** MIME type for `.甲` archives. Vendor-prefixed so any
 *  Content-Type-aware tool can identify them. */
export const ARCHIVE_MIME = "application/vnd.plastron.甲" as const;

/** File extensions accepted by the loader. The first is canonical;
 *  the others are practical aliases for environments that mangle
 *  Unicode filenames. */
export const ARCHIVE_EXTENSIONS = ["甲", "turtle", "plastron", "plast"] as const;
export const CANONICAL_EXTENSION = "甲" as const;

export interface ArchiveRequires {
  /** Semver-style range. Compared against ENGINE_VERSION at load. */
  engineVersion?: string;
  /** Kind handler keys the host must register. */
  kinds?: string[];
  /** Tag protocol keys the host must register. */
  tags?: string[];
  /** Named userland segments the host must install (audit-log, etc.). */
  segments?: string[];
  /** Lambda keys the host's FnRegistry must provide for the native kind. */
  nativeLambdas?: string[];
}

export interface ArchiveCreator {
  /** Agent / model identifier — e.g. "claude-opus-4.7". */
  agent?: string;
  /** Human signer — username, email, GitHub login. */
  user?: string;
}

export interface ArchiveManifest {
  version: typeof ARCHIVE_FORMAT_VERSION;
  format: typeof ARCHIVE_MIME;
  /** Runtime fingerprint at the moment of export. */
  fingerprint?: string;
  /** ISO-8601 timestamp at export. */
  createdAt: string;
  createdBy?: ArchiveCreator;
  requires?: ArchiveRequires;
  /** Optional top-level seal — Ed25519 signature over the canonical JSON
   *  of the archive body with this manifest's signature stripped out. */
  manifest?: SegmentManifest;
  /** Diagnostic snapshot of fingerprint inputs — useful for "why did
   *  the seal change?" investigations. Not used for verification. */
  componentSnapshot?: FingerprintComponents;
}

export interface ArchiveBody {
  manifest: ArchiveManifest;
  bundles: SegmentBundle[];
  /** Optional captured AuditEvent[] from the audit-log segment, when
   *  the exporter was configured to include it. */
  auditLog?: unknown[];
}
