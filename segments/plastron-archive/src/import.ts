import { Archive } from "xit-wasm";
import type { Segment } from "../../../plastron/src/types/index.js";
import {
  MANIFEST_PATH, SEGMENTS_DIR,
  type ArchiveManifest,
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

export const importArchive = async (bytes: Uint8Array): Promise<ImportResult> => {
  const archive = await Archive.open(bytes);

  const manifestBytes = await archive.read(MANIFEST_PATH);
  if (!manifestBytes) {
    await archive.close();
    throw new Error(`Archive is missing ${MANIFEST_PATH}.`);
  }
  const manifest = JSON.parse(dec.decode(manifestBytes)) as ArchiveManifest;

  if (!Array.isArray(manifest.segments)) {
    await archive.close();
    throw new Error(`Archive manifest is missing the "segments" array.`);
  }

  const segments: Segment[] = [];
  for (const key of manifest.segments) {
    const path = `${SEGMENTS_DIR}/${key}.json`;
    const segBytes = await archive.read(path);
    if (!segBytes) {
      await archive.close();
      throw new Error(`Archive manifest lists segment ${JSON.stringify(key)} but ${path} is missing.`);
    }
    segments.push(JSON.parse(dec.decode(segBytes)) as Segment);
  }

  return { manifest, segments, archive };
};
