import { Archive } from "xit-wasm";
import { stringify as yamlStringify } from "yaml";
import type { Segment } from "../../../plastron/src/index.js";
import {
  ARCHIVE_FORMAT_VERSION, ARCHIVE_MIME,
  DEFAULT_SEGMENT_FORMAT,
  MANIFEST_PATH, SEGMENTS_DIR,
  validateSegmentKey,
  type ArchiveManifest,
  type SegmentFormat,
} from "./manifest.js";

export interface ExportOptions {
  /** ISO-8601 string. Defaults to `new Date().toISOString()`. */
  createdAt?: string;
  /** On-disk format for the per-segment files. Defaults to "json".
   *  Use "yaml" when segments contain multi-line strings (e.g. Python
   *  source on a LambdaMetadata) that you want to diff line-by-line
   *  in git — the emitter renders those as `|` block scalars. */
  format?: SegmentFormat;
  /** JSON.stringify space arg. Defaults to 2 — pretty-print so the
   *  unzipped tree is human-readable. Pass 0 for compact JSON.
   *  Ignored when format is "yaml". */
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

const enc = new TextEncoder();

const segmentPath = (key: string, format: SegmentFormat): string =>
  `${SEGMENTS_DIR}/${key}.${format}`;

export const exportArchive = async (
  segments: Segment[],
  options: ExportOptions = {},
): Promise<Uint8Array> => {
  const indent = options.jsonIndent ?? 2;
  const format = options.format ?? DEFAULT_SEGMENT_FORMAT;
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
    segmentFormat: format,
    segments: segments.map((s) => s.key),
  };

  // Manifest itself is always JSON. It's small and machine-shaped —
  // a tiny table of contents — so JSON wins for stability and parser
  // availability. Only segment payloads honour the format toggle.
  const stringifyManifest = (value: unknown): string =>
    JSON.stringify(value, null, indent) + "\n";

  // yaml.stringify already promotes multi-line strings to `|` block
  // scalars; lineWidth: 0 disables auto-folding of long single-line
  // strings, which would otherwise mangle code or URLs. yaml.stringify
  // emits a trailing newline.
  const stringifySegment = (value: unknown): string =>
    format === "yaml"
      ? yamlStringify(value, { lineWidth: 0 })
      : JSON.stringify(value, null, indent) + "\n";

  const archive = await Archive.open(options.previous);

  // Manifest is rewritten on every export.
  await archive.write(MANIFEST_PATH, enc.encode(stringifyManifest(manifest)));

  // Drop segment files no longer present in this export, so the working
  // tree matches what we're committing. Keep manifest + repo internals
  // (Archive.list already filters internals). When the format toggles
  // between exports, the old-extension files end up in the unwanted set
  // and are removed here.
  const desiredPaths = new Set<string>([MANIFEST_PATH]);
  for (const seg of segments) desiredPaths.add(segmentPath(seg.key, format));

  const existing = await archive.list();
  for (const path of existing) {
    if (!desiredPaths.has(path)) {
      await archive.remove(path);
    }
  }

  for (const seg of segments) {
    await archive.write(
      segmentPath(seg.key, format),
      enc.encode(stringifySegment(seg)),
    );
  }

  await archive.commit(
    options.message ?? `export at ${createdAt}`,
    options.author ? { author: options.author } : undefined,
  );

  const bytes = await archive.toBytes();
  await archive.close();
  return bytes;
};
