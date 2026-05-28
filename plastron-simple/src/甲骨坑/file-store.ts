import type { 甲骨, Cel, Fn } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./file-store.json" with { type: "json" };

// ============================================================================
// file-store — Phase A. Pathlib-shaped fns over OPFS (browser) or
// node:fs/promises (CLI). One backend selected sync at module load;
// no per-state config in this phase — see
// docs/1-design/3-accepted/09-storage/opfs-file-store.md.
//
// Formula-callable fns receive (...args) only — no state ref — so the
// backend lives at module scope. The descriptor cels (file-store.backend,
// .root, .*-available) document the active singleton; mutating them
// after install does NOT re-bind. A state-aware fs.bind fn arrives in
// a later phase alongside the broader config-via-cels story.
// ============================================================================

// ----- Capability detection (sync, at module load) -----

interface NavigatorShape {
  storage?: { getDirectory?: () => Promise<OpfsDirHandle> };
}
interface ProcessShape {
  versions?: { node?: string };
  env?: Record<string, string | undefined>;
}

const _opfsAvailable: boolean =
  typeof (globalThis as { navigator?: NavigatorShape }).navigator?.storage?.getDirectory === "function";
const _nodeFsAvailable: boolean =
  typeof (globalThis as { process?: ProcessShape }).process?.versions?.node === "string";

type BackendName = "opfs" | "node-fs" | "none";
const _backend: BackendName =
  _opfsAvailable ? "opfs" : _nodeFsAvailable ? "node-fs" : "none";

// Root override via env var so tests can isolate. Read once at module
// load; subsequent process.env mutations don't propagate (matches the
// "singleton, immutable in Phase A" stance).
const _envRoot =
  (globalThis as { process?: ProcessShape }).process?.env?.PLASTRON_FILE_STORE_ROOT;
const _root: string =
  _backend === "node-fs" ? (_envRoot ?? "./.plastron-fs") : "";

// ----- Path normalization -----

// POSIX-style. Collapses "." and "..", rejects "..  escapes past root.
// Returns the segments array used downstream by both backends.
const splitPath = (input: string): string[] => {
  const trimmed = input.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return [];
  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        throw new Error(`file-store: path escapes root: ${input}`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts;
};

// ----- Shared backend interface -----

interface FileStat { size: number; isDir: boolean; mtime: number; }

interface FileBackend {
  exists(path: string[]): Promise<boolean>;
  read(path: string[]): Promise<Uint8Array>;
  write(path: string[], content: Uint8Array): Promise<void>;
  delete(path: string[]): Promise<void>;
  mkdir(path: string[], recursive: boolean): Promise<void>;
  rmdir(path: string[], recursive: boolean): Promise<void>;
  list(path: string[]): Promise<string[]>;
  stat(path: string[]): Promise<FileStat>;
  rename(oldPath: string[], newPath: string[]): Promise<void>;
}

// ----- node-fs backend -----

interface NodeFsPromises {
  readFile: (p: string) => Promise<Uint8Array>;
  writeFile: (p: string, c: Uint8Array) => Promise<void>;
  unlink: (p: string) => Promise<void>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  rm: (p: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  readdir: (p: string) => Promise<string[]>;
  stat: (p: string) => Promise<{ size: number; isDirectory(): boolean; mtimeMs: number }>;
  rename: (a: string, b: string) => Promise<void>;
  access: (p: string) => Promise<void>;
}
interface NodePath {
  join: (...segments: string[]) => string;
  resolve: (...segments: string[]) => string;
  dirname: (p: string) => string;
  sep: string;
}

const createNodeBackend = async (root: string): Promise<FileBackend> => {
  // Dynamic imports with /* @vite-ignore */ so browser bundlers skip
  // these specifiers (the segment installs in both runtimes; the OPFS
  // path won't reach here).
  const fs   = await import(/* @vite-ignore */ "node:fs/promises") as unknown as NodeFsPromises;
  const path = await import(/* @vite-ignore */ "node:path")        as unknown as NodePath;

  const resolvedRoot = path.resolve(root);
  await fs.mkdir(resolvedRoot, { recursive: true });

  const abs = (segments: string[]): string => {
    if (segments.length === 0) return resolvedRoot;
    const joined = path.join(resolvedRoot, ...segments);
    // Defense-in-depth: splitPath rejects ".." escapes already, but
    // re-check the resolved path in case path.resolve normalizes
    // anything we missed (symlinks aren't followed by resolve, but
    // the assertion is cheap).
    const resolved = path.resolve(joined);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`file-store: resolved path escapes root: ${segments.join("/")}`);
    }
    return resolved;
  };

  const swallowMissing = async (fn: () => Promise<void>): Promise<void> => {
    try { await fn(); }
    catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
  };

  return {
    exists: async (p) => fs.access(abs(p)).then(() => true, () => false),
    read:   (p)       => fs.readFile(abs(p)),
    write:  async (p, content) => {
      const absPath = abs(p);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
    },
    delete: async (p) => swallowMissing(() => fs.unlink(abs(p))),
    mkdir:  (p, recursive) => fs.mkdir(abs(p), { recursive }),
    rmdir:  async (p, recursive) =>
      swallowMissing(() => fs.rm(abs(p), { recursive, force: true })),
    list:   (p) => fs.readdir(abs(p)),
    stat:   async (p) => {
      const s = await fs.stat(abs(p));
      return { size: s.size, isDir: s.isDirectory(), mtime: s.mtimeMs };
    },
    rename: (oldP, newP) => fs.rename(abs(oldP), abs(newP)),
  };
};

// ----- OPFS backend -----

interface OpfsFile {
  size: number;
  lastModified: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}
interface OpfsWritable {
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}
interface OpfsFileHandle {
  kind: "file";
  name: string;
  getFile: () => Promise<OpfsFile>;
  createWritable: () => Promise<OpfsWritable>;
  move?: (newParent: OpfsDirHandle, newName?: string) => Promise<void>;
}
interface OpfsDirHandle {
  kind: "directory";
  name: string;
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<OpfsDirHandle>;
  getFileHandle:      (name: string, opts?: { create?: boolean }) => Promise<OpfsFileHandle>;
  removeEntry:        (name: string, opts?: { recursive?: boolean }) => Promise<void>;
  values:             () => AsyncIterable<OpfsFileHandle | OpfsDirHandle>;
  move?:              (newParent: OpfsDirHandle, newName?: string) => Promise<void>;
}

const createOpfsBackend = async (): Promise<FileBackend> => {
  const nav = (globalThis as { navigator: NavigatorShape }).navigator;
  if (!nav.storage?.getDirectory) {
    throw new Error("file-store: OPFS unavailable (re-probe failed)");
  }
  const opfsRoot = await nav.storage.getDirectory();

  const walkDir = async (segments: string[], create: boolean): Promise<OpfsDirHandle> => {
    let dir = opfsRoot;
    for (const name of segments) {
      dir = await dir.getDirectoryHandle(name, { create });
    }
    return dir;
  };

  const fileAt = async (segments: string[], create: boolean): Promise<OpfsFileHandle> => {
    if (segments.length === 0) throw new Error("file-store: empty file path");
    const parent = await walkDir(segments.slice(0, -1), create);
    return parent.getFileHandle(segments[segments.length - 1], { create });
  };

  // Three-way probe — used by exists/stat to avoid catching the same
  // NotFoundError twice in callers.
  const probe = async (segments: string[]): Promise<"file" | "dir" | "missing"> => {
    if (segments.length === 0) return "dir";
    let parent: OpfsDirHandle;
    try { parent = await walkDir(segments.slice(0, -1), false); }
    catch { return "missing"; }
    const name = segments[segments.length - 1];
    try { await parent.getFileHandle(name);      return "file"; } catch { /* not a file */ }
    try { await parent.getDirectoryHandle(name); return "dir";  } catch { return "missing"; }
  };

  return {
    exists: async (p) => (await probe(p)) !== "missing",

    read: async (p) => {
      const fh = await fileAt(p, false);
      const f  = await fh.getFile();
      return new Uint8Array(await f.arrayBuffer());
    },

    write: async (p, content) => {
      const fh = await fileAt(p, true);
      const w  = await fh.createWritable();
      try { await w.write(content); } finally { await w.close(); }
    },

    delete: async (p) => {
      if (p.length === 0) return;
      let parent: OpfsDirHandle;
      try { parent = await walkDir(p.slice(0, -1), false); } catch { return; }
      try { await parent.removeEntry(p[p.length - 1]); } catch { /* missing — no-op */ }
    },

    mkdir: async (p, _recursive) => {
      // OPFS getDirectoryHandle({create:true}) is always per-segment-
      // create, so recursion is implicit.
      await walkDir(p, true);
    },

    rmdir: async (p, recursive) => {
      if (p.length === 0) {
        // Origin root itself can't be removed; clear children if recursive.
        if (!recursive) return;
        for await (const entry of opfsRoot.values()) {
          try { await opfsRoot.removeEntry(entry.name, { recursive: true }); }
          catch { /* swallow */ }
        }
        return;
      }
      let parent: OpfsDirHandle;
      try { parent = await walkDir(p.slice(0, -1), false); } catch { return; }
      try { await parent.removeEntry(p[p.length - 1], { recursive }); }
      catch { /* missing — no-op */ }
    },

    list: async (p) => {
      const dir = await walkDir(p, false);
      const names: string[] = [];
      for await (const entry of dir.values()) names.push(entry.name);
      return names;
    },

    stat: async (p) => {
      const kind = await probe(p);
      if (kind === "missing") throw new Error(`file-store: not found: ${p.join("/")}`);
      if (kind === "dir")     return { size: 0, isDir: true, mtime: 0 };
      const fh = await fileAt(p, false);
      const f  = await fh.getFile();
      return { size: f.size, isDir: false, mtime: f.lastModified };
    },

    rename: async (oldP, newP) => {
      if (oldP.length === 0) throw new Error("file-store: cannot rename root");
      if (newP.length === 0) throw new Error("file-store: cannot move to root");

      const oldParent = await walkDir(oldP.slice(0, -1), false);
      const newParent = await walkDir(newP.slice(0, -1), true);
      const oldName   = oldP[oldP.length - 1];
      const newName   = newP[newP.length - 1];

      let handle: OpfsFileHandle | OpfsDirHandle;
      try { handle = await oldParent.getFileHandle(oldName); }
      catch {
        try { handle = await oldParent.getDirectoryHandle(oldName); }
        catch { throw new Error(`file-store: rename source not found: ${oldP.join("/")}`); }
      }

      // Prefer the native .move() (Chromium 110+, Safari 17.4+). Fallback
      // is file-only — directory move via read+write would need a tree
      // walk, which Phase A doesn't ship.
      if (typeof handle.move === "function") {
        await handle.move(newParent, newName);
        return;
      }
      if (handle.kind !== "file") {
        throw new Error(
          `file-store: directory rename requires FileSystemHandle.move (unsupported here)`,
        );
      }
      const f     = await handle.getFile();
      const bytes = new Uint8Array(await f.arrayBuffer());
      const dst   = await newParent.getFileHandle(newName, { create: true });
      const w     = await dst.createWritable();
      try { await w.write(bytes); } finally { await w.close(); }
      await oldParent.removeEntry(oldName);
    },
  };
};

// ----- Backend singleton -----

let _backendPromise: Promise<FileBackend> | undefined;

const getBackend = (): Promise<FileBackend> => {
  if (_backendPromise) return _backendPromise;
  if (_backend === "opfs")    _backendPromise = createOpfsBackend();
  else if (_backend === "node-fs") _backendPromise = createNodeBackend(_root);
  else _backendPromise = Promise.reject(new Error(
    "file-store: no backend available — neither OPFS nor node:fs/promises detected.",
  ));
  return _backendPromise;
};

// ----- Fn surface -----

const toBytes = (content: unknown): Uint8Array => {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string")   return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  throw new Error(`fs.write: content must be Uint8Array | string | ArrayBuffer (got ${typeof content})`);
};

const exists:    Fn = async (path: unknown) =>
  (await getBackend()).exists(splitPath(String(path)));
const read:      Fn = async (path: unknown) =>
  (await getBackend()).read(splitPath(String(path)));
const readText:  Fn = async (path: unknown) => {
  const bytes = await (await getBackend()).read(splitPath(String(path)));
  return new TextDecoder("utf-8").decode(bytes);
};
const write:     Fn = async (path: unknown, content: unknown) =>
  (await getBackend()).write(splitPath(String(path)), toBytes(content));
const writeText: Fn = async (path: unknown, content: unknown) =>
  (await getBackend()).write(splitPath(String(path)), new TextEncoder().encode(String(content)));
const del:       Fn = async (path: unknown) =>
  (await getBackend()).delete(splitPath(String(path)));
const mkdir:     Fn = async (path: unknown, recursive: unknown) =>
  (await getBackend()).mkdir(splitPath(String(path)), recursive === undefined ? true : Boolean(recursive));
const rmdir:     Fn = async (path: unknown, recursive: unknown) =>
  (await getBackend()).rmdir(splitPath(String(path)), recursive === undefined ? true : Boolean(recursive));
const list:      Fn = async (path: unknown) =>
  (await getBackend()).list(splitPath(String(path)));
const stat:      Fn = async (path: unknown) =>
  (await getBackend()).stat(splitPath(String(path)));
const rename:    Fn = async (oldP: unknown, newP: unknown) =>
  (await getBackend()).rename(splitPath(String(oldP)), splitPath(String(newP)));

// Additive internal export: the path-string fs operations, for sibling
// segments (e.g. segment-store) that compose over file-store at the
// module level rather than re-implementing the backend. Not a cel; not
// part of the public kernel API. fs.* cels remain the formula-facing
// surface.
export const fsOps = {
  exists, read, readText, write, writeText,
  delete: del, mkdir, rmdir, list, stat, rename,
} as const;

// The active backend label, decided at module load. Sibling segments
// (cli-segment-export) gate cel installation on this — CLI-only fns
// install only when the live backend is node-fs.
export const backend = _backend;

// Backend-relative root (resolved root for node-fs; "" for OPFS). Used by
// cli-segment-export to locate the store on the real filesystem.
export const root = _root;

// ----- file-binary schema protocols -----

const fileBinarySize: Fn = (v: unknown) =>
  v instanceof Uint8Array ? v.length : 0;

const fileBinaryIsChanged: Fn = (oldV: unknown, newV: unknown) => {
  if (!(oldV instanceof Uint8Array) || !(newV instanceof Uint8Array)) return oldV !== newV;
  if (oldV.length !== newV.length) return true;
  for (let i = 0; i < oldV.length; i++) if (oldV[i] !== newV[i]) return true;
  return false;
};

const fileBinaryMime: Fn = (_v: unknown) => "application/octet-stream";

// ----- Segment export -----

export const name = "file-store" as const;

const _cels = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["fs.exists",             exists],
  ["fs.read",               read],
  ["fs.readText",           readText],
  ["fs.write",              write],
  ["fs.writeText",          writeText],
  ["fs.delete",             del],
  ["fs.mkdir",              mkdir],
  ["fs.rmdir",              rmdir],
  ["fs.list",               list],
  ["fs.stat",               stat],
  ["fs.rename",             rename],
  ["file-binary_size",      fileBinarySize],
  ["file-binary_isChanged", fileBinaryIsChanged],
  ["file-binary_mime",      fileBinaryMime],
]));

// JSON seeds the descriptor cels with v=null; populate from the
// module-load probes so reads of file-store.backend / .root return the
// active singleton's values.
for (const cel of _cels) {
  if (cel.celType !== "ValueCel") continue;
  switch (cel.metadata.key) {
    case "file-store.opfs-available":    cel.v = _opfsAvailable;    break;
    case "file-store.node-fs-available": cel.v = _nodeFsAvailable;  break;
    case "file-store.backend":           cel.v = _backend;          break;
    case "file-store.root":              cel.v = _root;             break;
  }
}

export const cels: Cel[] = _cels;
