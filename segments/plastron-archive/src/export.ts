import { zipSync, strToU8 } from "fflate";
import type { Segment } from "../../../plastron/src/types/index.js";
import {
  ARCHIVE_FORMAT_VERSION, ARCHIVE_MIME,
  MANIFEST_PATH, SEGMENTS_DIR,
  type ArchiveManifest,
} from "./manifest.js";

export interface ExportOptions {
  /** ISO-8601 string. Defaults to `new Date().toISOString()`. */
  createdAt?: string;
  /** JSON.stringify space arg. Defaults to 2 — pretty-print so the
   *  unzipped tree is human-readable. Pass 0 for compact JSON. */
  jsonIndent?: number;
}

// Reject keys that would produce confusing or unsafe filenames inside
// the zip. `/` and `\` would create unintended subdirectories; leading
// dots collide with `.` / `..`; NUL terminates C-strings.
const validateSegmentKey = (key: string): void => {
  if (
    key === "" ||
    key.includes("/") || key.includes("\\") ||
    key.includes("\0") ||
    key.startsWith(".")
  ) {
    throw new Error(
      `Segment key ${JSON.stringify(key)} is not safe as a filename. ` +
      `Avoid /, \\, NUL bytes, and leading dots.`,
    );
  }
};

export const exportArchive = (
  segments: Segment[],
  options: ExportOptions = {},
): Uint8Array => {
  const indent = options.jsonIndent ?? 2;
  const createdAt = options.createdAt ?? new Date().toISOString();

  const seen = new Set<string>();
  for (const seg of segments) {
    validateSegmentKey(seg.key);
    if (seen.has(seg.key)) {
      throw new Error(`Duplicate segment key ${JSON.stringify(seg.key)}.`);
    }
    seen.add(seg.key);
  }

  const manifest: ArchiveManifest = {
    version: ARCHIVE_FORMAT_VERSION,
    format: ARCHIVE_MIME,
    createdAt,
    segments: segments.map((s) => s.key),
  };

  const stringify = (value: unknown): string =>
    JSON.stringify(value, null, indent) + "\n";

  const files: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: strToU8(stringify(manifest)),
  };
  for (const seg of segments) {
    files[`${SEGMENTS_DIR}/${seg.key}.json`] = strToU8(stringify(seg));
  }

  return zipSync(files);
};
