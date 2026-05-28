import type { 甲骨, Cel, Fn, Key, State, 冊 } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { backend, root } from "./file-store.js";
import { putRaw, readIndex, STORE_ROOT } from "./segment-store.js";
import { computeKernelClosure } from "../kernel/segments.js";
import seed from "./cli-segment-export.json" with { type: "json" };

// ============================================================================
// cli-segment-export — chunk F. Copy the plastron/ segment store to/from an
// arbitrary disk directory so users can git-version, ship, or archive their
// projects. CLI-only: cels install only when the active file-store backend
// is node-fs; a browser build gets an empty cel list (the manifest still
// loads, so dep validation is consistent — calls resolve to undefined).
//
// Design: docs/1-design/2-in-evaluation/cli-segment-export.md
// v1 ships the "dir" (mirror-layout) format only; tar.gz / zip are deferred.
//
// Node fs/path are dynamic-imported inside the fns so a browser bundle never
// references them at module top (and they're marked external in the bundler).
// ============================================================================

interface NodeFsPromises {
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<unknown>;
  readFile: (p: string, enc: "utf8") => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  readdir: (p: string) => Promise<string[]>;
  access: (p: string) => Promise<void>;
}
interface NodePath {
  resolve: (...s: string[]) => string;
  join: (...s: string[]) => string;
}
const loadNode = async (): Promise<{ fs: NodeFsPromises; path: NodePath }> => ({
  fs: await import(/* @vite-ignore */ "node:fs/promises") as unknown as NodeFsPromises,
  path: await import(/* @vite-ignore */ "node:path") as unknown as NodePath,
});

const exists = async (fs: NodeFsPromises, p: string): Promise<boolean> =>
  fs.access(p).then(() => true, () => false);

interface SegRef { name: Key; version: string; manifest: 冊; }

// Read every <name>/<latest>/manifest.json under a store root into a map.
const readManifests = async (
  fs: NodeFsPromises, path: NodePath, storeRoot: string,
): Promise<{ index: { version: number; segments: Record<string, { latest: string; versions: string[] }> }; manifests: Map<Key, SegRef> }> => {
  const indexPath = path.join(storeRoot, "index.json");
  const index = await exists(fs, indexPath)
    ? JSON.parse(await fs.readFile(indexPath, "utf8"))
    : { version: 1, segments: {} };
  const manifests = new Map<Key, SegRef>();
  for (const [name, entry] of Object.entries(index.segments) as [Key, { latest: string; versions: string[] }][]) {
    const version = entry.latest;
    const mPath = path.join(storeRoot, "segments", name, version, "manifest.json");
    if (!(await exists(fs, mPath))) continue;
    const manifest = JSON.parse(await fs.readFile(mPath, "utf8")) as 冊;
    manifests.set(name, { name, version, manifest });
  }
  return { index, manifests };
};

const exportToDir: Fn = async (stateArg: unknown, targetArg: unknown, optsArg?: unknown) => {
  const state = stateArg as State;
  const targetDir = String(targetArg);
  const opts = (optsArg ?? {}) as {
    onlySegments?: Key[]; includeTransitiveDeps?: boolean;
    includeKernel?: boolean; overwrite?: boolean;
  };
  const { fs, path } = await loadNode();

  const srcStore = path.join(path.resolve(String(state.cels.get("file-store.root")?.v ?? root)), STORE_ROOT);
  const dstStore = path.join(path.resolve(targetDir), STORE_ROOT);

  if (await exists(fs, dstStore) && !opts.overwrite) {
    throw new Error(`cli-segment-export: ${dstStore} already exists — pass { overwrite: true } to replace it.`);
  }

  const { manifests } = await readManifests(fs, path, srcStore);

  // Kernel closure (computed from the stored manifests) is excluded by default.
  const closure = computeKernelClosure(new Map([...manifests].map(([n, r]) => [n, r.manifest])));

  // Resolve the export set.
  let selected: Set<Key>;
  if (opts.onlySegments) {
    selected = new Set(opts.onlySegments);
    if (opts.includeTransitiveDeps !== false) {
      const queue = [...selected];
      while (queue.length) {
        const ref = manifests.get(queue.shift()!);
        for (const dep of ref?.manifest.dependencies ?? []) {
          if (!selected.has(dep)) { selected.add(dep); queue.push(dep); }
        }
      }
    }
  } else {
    selected = new Set(manifests.keys());
  }
  if (!opts.includeKernel) for (const k of closure) selected.delete(k);

  // Copy each selected segment's per-version dir, rebuild the dest index.
  const destIndex = { version: 1, segments: {} as Record<string, { latest: string; versions: string[] }> };
  const exportedSegments: Key[] = [];
  for (const name of selected) {
    const ref = manifests.get(name);
    if (!ref) continue; // requested a segment not in the store — skip
    const rel = path.join("segments", name, ref.version);
    const srcDir = path.join(srcStore, rel);
    const dstDir = path.join(dstStore, rel);
    await fs.mkdir(dstDir, { recursive: true });
    await fs.writeFile(path.join(dstDir, "manifest.json"), await fs.readFile(path.join(srcDir, "manifest.json"), "utf8"));
    await fs.writeFile(path.join(dstDir, "segment.json"), await fs.readFile(path.join(srcDir, "segment.json"), "utf8"));
    destIndex.segments[name] = { latest: ref.version, versions: [ref.version] };
    exportedSegments.push(name);
  }
  await fs.mkdir(dstStore, { recursive: true });
  await fs.writeFile(path.join(dstStore, "index.json"), JSON.stringify(destIndex, null, 2));

  return { exportedSegments, targetDir };
};

const importFromDir: Fn = async (stateArg: unknown, sourceArg: unknown, optsArg?: unknown) => {
  // state is unused today but kept in the signature for parity with
  // exportToDir and to leave room for state-aware policy later.
  void stateArg;
  const sourceDir = String(sourceArg);
  const opts = (optsArg ?? {}) as { overwrite?: boolean };
  const { fs, path } = await loadNode();

  const srcStore = path.join(path.resolve(sourceDir), STORE_ROOT);
  if (!(await exists(fs, srcStore))) {
    throw new Error(`cli-segment-export: ${srcStore} has no plastron/ store to import.`);
  }

  const liveIndex = await readIndex(); // the local store's index (via file-store)
  const importedSegments: Key[] = [];

  const { manifests } = await readManifests(fs, path, srcStore);
  for (const { name, version, manifest } of manifests.values()) {
    if (manifest.role === "kernel") continue; // kernel comes from the local bundle
    const liveEntry = liveIndex.segments[name];
    if (liveEntry && liveEntry.versions.includes(version) && !opts.overwrite) {
      throw new Error(`cli-segment-export: "${name}"@${version} already in the store — pass { overwrite: true } to replace it.`);
    }
    const segDir = path.join(srcStore, "segments", name, version);
    const segment = JSON.parse(await fs.readFile(path.join(segDir, "segment.json"), "utf8")) as 甲骨;
    await putRaw(name, version, manifest, segment);
    importedSegments.push(name);
  }
  return { importedSegments };
};

export const name = "cli-segment-export" as const;

// CLI-only: install the fn cels only when the live backend is node-fs.
// Browser builds get an empty cel list — the manifest still loads (dep
// validation stays consistent) but resolveFn(state, "exportToDir") is
// undefined, so hosts must feature-detect before offering an export UI.
export const cels: Cel[] =
  backend === "node-fs"
    ? bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
        ["exportToDir", exportToDir],
        ["importFromDir", importFromDir],
      ]))
    : [];
