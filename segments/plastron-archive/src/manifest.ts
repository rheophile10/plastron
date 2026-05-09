// ========================================================================
// Archive manifest — top-level metadata for a `.甲` file.
//
// `.甲` is a zip wrapping a xit repository: the working tree holds one
// `manifest.json` at the root and one JSON file per Segment under
// `segments/`, alongside xit's `.xit/` repo internals. Each export is a
// commit, so the archive carries its full history without an outer VCS.
// ========================================================================

export const ARCHIVE_FORMAT_VERSION = 1 as const;

/** MIME type for `.甲` archives. Vendor-prefixed so Content-Type-aware
 *  tools can identify them. */
export const ARCHIVE_MIME = "application/vnd.plastron.甲" as const;

/** Canonical filename suffix. Loaders accept the bytes regardless of
 *  extension — the manifest inside drives parsing. */
export const CANONICAL_EXTENSION = ".甲" as const;

/** Path of the top-level manifest within the zip. */
export const MANIFEST_PATH = "manifest.json" as const;

/** Directory under which per-segment JSON files live. */
export const SEGMENTS_DIR = "segments" as const;

export interface ArchiveManifest {
  version: typeof ARCHIVE_FORMAT_VERSION;
  format: typeof ARCHIVE_MIME;
  /** ISO-8601 timestamp at export. */
  createdAt: string;
  /** Segment keys, in the order they should be hydrated. The loader
   *  uses this both to find the per-segment files and to preserve
   *  hydrate order. */
  segments: string[];
}
