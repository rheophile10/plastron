import { Archive } from "xit-wasm";
import type { Segment } from "../../../plastron/src/index.js";
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
  /** Bytes of a previous `.甲` to extend with this export. When given,
   *  the new export becomes the next commit on top of the previous
   *  archive's history. Without it, a fresh repo is initialized.
   *
   *  Power users who want finer control over branching/merging can
   *  open the archive directly via `Archive.open` instead. */
  previous?: Uint8Array;
  /** Commit message. Defaults to a timestamped marker. */
  message?: string;
  /** Author/committer string in `Name <email>` form. Defaults to
   *  `"plastron <plastron@local>"`. */
  author?: string;
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

const enc = new TextEncoder();

const segmentPath = (key: string): string => `${SEGMENTS_DIR}/${key}.json`;

export const exportArchive = async (
  segments: Segment[],
  options: ExportOptions = {},
): Promise<Uint8Array> => {
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

  const archive = await Archive.open(options.previous);

  // Manifest is rewritten on every export.
  await archive.write(MANIFEST_PATH, enc.encode(stringify(manifest)));

  // Drop segment files no longer present in this export, so the working
  // tree matches what we're committing. Keep manifest + repo internals
  // (Archive.list already filters internals).
  const desiredPaths = new Set<string>([MANIFEST_PATH]);
  for (const seg of segments) desiredPaths.add(segmentPath(seg.key));

  const existing = await archive.list();
  for (const path of existing) {
    if (!desiredPaths.has(path)) {
      await archive.remove(path);
    }
  }

  for (const seg of segments) {
    await archive.write(segmentPath(seg.key), enc.encode(stringify(seg)));
  }

  await archive.commit(
    options.message ?? `export at ${createdAt}`,
    options.author ? { author: options.author } : undefined,
  );

  const bytes = await archive.toBytes();
  await archive.close();
  return bytes;
};
