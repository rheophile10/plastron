import type { 甲骨, Cel, Fn, Key, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import {
  buildArchive, loadArchive,
  includeAll, includeForApplication, includeForLibrary, includeForUser,
  type LoadOptions,
} from "./archive/archive.js";
import seed from "./segment-archive.json" with { type: "json" };

// ============================================================================
// segment-archive — tiered + whole-workspace export/import as a role-foldered
// .zip (the `.甲` archive), over dehydrate/hydrate + the zero-dep zip core.
// Runtime-agnostic: the ops take/return Uint8Array, so the host wires the
// sink/source (browser download/upload, or node-fs). The kernel closure is
// always excluded — it ships in the bundle. See
// docs/1-design/2-in-evaluation/segment-archive.md.
// ============================================================================

const exportAll: Fn = (state: State) => buildArchive(state, includeAll(state));
const exportApplication: Fn = (state: State, name: Key) => buildArchive(state, includeForApplication(state, name));
const exportLibrary: Fn = (state: State, name: Key) => buildArchive(state, includeForLibrary(state, name));
const exportUser: Fn = (state: State, name: Key) => buildArchive(state, includeForUser(state, name));
const importArchive: Fn = (state: State, bytes: Uint8Array, opts?: LoadOptions) => loadArchive(state, bytes, opts);

export const name = "segment-archive" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["segment-archive.export-all",         exportAll],
  ["segment-archive.export-application", exportApplication],
  ["segment-archive.export-library",     exportLibrary],
  ["segment-archive.export-user",        exportUser],
  ["segment-archive.import",             importArchive],
]));

// Direct surface for hosts that want to skip cel dispatch (e.g. a browser
// download/upload helper that already holds the bytes).
export { buildArchive, loadArchive } from "./archive/archive.js";
export { zipBytes, unzipBytes } from "./archive/zip.js";
