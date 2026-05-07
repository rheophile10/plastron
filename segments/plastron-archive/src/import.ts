import { unzipSync, strFromU8 } from "fflate";
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
}

export const importArchive = (bytes: Uint8Array): ImportResult => {
  const files = unzipSync(bytes);

  const manifestBytes = files[MANIFEST_PATH];
  if (!manifestBytes) {
    throw new Error(`Archive is missing ${MANIFEST_PATH}.`);
  }
  const manifest = JSON.parse(strFromU8(manifestBytes)) as ArchiveManifest;

  if (!Array.isArray(manifest.segments)) {
    throw new Error(`Archive manifest is missing the "segments" array.`);
  }

  const segments: Segment[] = [];
  for (const key of manifest.segments) {
    const path = `${SEGMENTS_DIR}/${key}.json`;
    const segBytes = files[path];
    if (!segBytes) {
      throw new Error(`Archive manifest lists segment ${JSON.stringify(key)} but ${path} is missing.`);
    }
    segments.push(JSON.parse(strFromU8(segBytes)) as Segment);
  }

  return { manifest, segments };
};
