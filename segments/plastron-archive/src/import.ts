import { Archive } from "xit-wasm";
import { parse as yamlParse } from "yaml";
import type { Segment } from "../../../plastron/src/index.js";
import {
  ARCHIVE_FORMAT_VERSION, ARCHIVE_MIME,
  DEFAULT_SEGMENT_FORMAT,
  MANIFEST_PATH, SEGMENTS_DIR,
  validateSegmentKey,
  type ArchiveManifest,
  type SegmentFormat,
} from "./manifest.js";

export interface ImportResult {
  manifest: ArchiveManifest;
  /** Segments in the order specified by `manifest.segments`. Pass
   *  directly to `hydrate(state, segments, fns)`. */
  segments: Segment[];
  /** The live xit-wasm Archive backing this import.
   *
   *  Power users get the pleasant surprise of a real version-controlled
   *  repo. Methods on `archive` include:
   *
   *    - `commit(msg)` — make a new commit on top of the imported state
   *    - `branch(name)` / `checkout(name)` / `merge(name)` — branching
   *    - `log()` — read the history
   *    - `toBytes()` — re-serialize back to a `.甲`
   *
   *  Callers who only want segments can ignore this field; remember to
   *  call `archive.close()` when done if you do hold onto it. */
  archive: Archive;
}

const dec = new TextDecoder();

// Close the archive on any error, then re-throw with `cause` set. Keeps
// the WASM-backed handle from leaking when bytes are corrupted (parse
// failures) or when the manifest fails validation post-parse.
const failClosed = async (
  archive: Archive,
  message: string,
  cause?: unknown,
): Promise<never> => {
  await archive.close();
  throw cause === undefined ? new Error(message) : new Error(message, { cause });
};

export const importArchive = async (bytes: Uint8Array): Promise<ImportResult> => {
  const archive = await Archive.open(bytes);

  const manifestBytes = await archive.read(MANIFEST_PATH);
  if (!manifestBytes) {
    return failClosed(archive, `Archive is missing ${MANIFEST_PATH}.`);
  }

  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(dec.decode(manifestBytes)) as ArchiveManifest;
  } catch (e) {
    return failClosed(archive, `Archive manifest is not valid JSON.`, e);
  }

  if (manifest.version !== ARCHIVE_FORMAT_VERSION) {
    return failClosed(
      archive,
      `Archive manifest version ${JSON.stringify(manifest.version)} ` +
      `is not supported (this loader handles version ${ARCHIVE_FORMAT_VERSION}).`,
    );
  }
  if (manifest.format !== ARCHIVE_MIME) {
    return failClosed(
      archive,
      `Archive manifest format ${JSON.stringify(manifest.format)} ` +
      `does not match ${JSON.stringify(ARCHIVE_MIME)}.`,
    );
  }
  if (!Array.isArray(manifest.segments)) {
    return failClosed(archive, `Archive manifest is missing the "segments" array.`);
  }

  // Legacy archives (format v1 pre-yaml-flag) have no segmentFormat
  // field; the on-disk files are `.json`. Anything newer carries an
  // explicit marker.
  const format: SegmentFormat = manifest.segmentFormat ?? DEFAULT_SEGMENT_FORMAT;
  const parseSegment = (text: string): Segment =>
    (format === "yaml" ? yamlParse(text) : JSON.parse(text)) as Segment;

  const segments: Segment[] = [];
  for (const key of manifest.segments) {
    try {
      validateSegmentKey(key);
    } catch (e) {
      return failClosed(archive, `Archive manifest contains an unsafe segment key.`, e);
    }
    const path = `${SEGMENTS_DIR}/${key}.${format}`;
    const segBytes = await archive.read(path);
    if (!segBytes) {
      return failClosed(
        archive,
        `Archive manifest lists segment ${JSON.stringify(key)} but ${path} is missing.`,
      );
    }
    try {
      segments.push(parseSegment(dec.decode(segBytes)));
    } catch (e) {
      return failClosed(archive, `Segment file ${path} is not valid ${format}.`, e);
    }
  }

  return { manifest, segments, archive };
};
