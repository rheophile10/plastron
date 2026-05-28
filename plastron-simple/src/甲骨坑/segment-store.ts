import type { 甲骨, 冊, Cel, Fn } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { fsOps } from "./file-store.js";
import seed from "./segment-store.json" with { type: "json" };

// ============================================================================
// segment-store — chunk B of the segment-lifecycle umbrella. A pure
// composition over file-store's fs.* operations: no new I/O primitives.
// Dehydrated segments live under `plastron/segments/<name>/<version>/`
// as a manifest.json (冊) + segment.json (甲骨) pair; `plastron/index.json`
// is the name → version lookup table.
//
// See docs/1-design/2-in-evaluation/segment-opfs-layout.md for the full
// design (layout, versioning, atomicity). Uncompressed JSON in v1.
//
// NOTE: ships flat (segment-store.ts + .json) to match all sibling
// segments and the src/index.ts boot wiring; the design sketched a
// `segment-store/` subfolder. The flat form is the convention.
// ============================================================================

// ----- Storage layout -----

// Layout constants — exported so sibling storage segments (opfs-seeding,
// cli-segment-export) compose over the same on-disk shape.
export const STORE_ROOT = "plastron";
const ROOT = STORE_ROOT;
const INDEX = `${ROOT}/index.json`;
const INDEX_TMP = `${ROOT}/index.json.tmp`;
const segDir = (name: string, version: string) => `${ROOT}/segments/${name}/${version}`;

interface IndexEntry { latest: string; versions: string[]; }
export interface IndexFile { version: number; segments: Record<string, IndexEntry>; }

// ----- Typed wrappers over the file-store module singleton -----

const exists    = (p: string) => fsOps.exists(p)    as Promise<boolean>;
const readText  = (p: string) => fsOps.readText(p)  as Promise<string>;
const writeText = (p: string, c: string) => fsOps.writeText(p, c) as Promise<void>;
const rmdir     = (p: string) => fsOps.rmdir(p, true) as Promise<void>;
const rename    = (a: string, b: string) => fsOps.rename(a, b) as Promise<void>;

// ----- Name / version validation -----

// A stored name or version becomes a filesystem path component. Reject
// anything that isn't a safe single segment: empty, separators, NUL,
// "." / ".." traversal, or a leading dot.
const assertComponent = (kind: "name" | "version", value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`segment-store: ${kind} must be a non-empty string`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`segment-store: invalid ${kind} "${value}" (contains a path separator or NUL)`);
  }
  if (value === "." || value === ".." || value.startsWith(".")) {
    throw new Error(`segment-store: invalid ${kind} "${value}" (must not start with '.')`);
  }
  return value;
};

// ----- Index read / atomic write -----

export const readIndex = async (): Promise<IndexFile> => {
  if (!(await exists(INDEX))) return { version: 1, segments: {} };
  try {
    const parsed = JSON.parse(await readText(INDEX)) as IndexFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.segments !== "object") {
      throw new Error("malformed");
    }
    return parsed;
  } catch (e) {
    throw new Error(`segment-store: index.json is unreadable/corrupt: ${(e as Error).message}`);
  }
};

// Index-last + tmp-file-rename: write the new index to a temp path, then
// rename over the live file. The rename is atomic on every backend we
// target, so a reader sees either the old or the new index, never a
// partial write.
const writeIndexAtomic = async (idx: IndexFile): Promise<void> => {
  await writeText(INDEX_TMP, JSON.stringify(idx, null, 2));
  await rename(INDEX_TMP, INDEX);
};

// ----- Ops -----

// putRaw is the unguarded write: validate name/version, write the two
// files, update the index atomically. It does NOT refuse kernel-closure
// segments — that guard lives on the public `put` below. The seeding
// path (opfs-seeding) needs to write the kernel closure into the store,
// so it composes over putRaw directly. Exported for that reason; not a
// formula-facing cel.
export const putRaw: Fn = async (
  nameArg: unknown, versionArg: unknown, manifest: unknown, segment: unknown,
) => {
  const name = assertComponent("name", nameArg);
  const version = assertComponent("version", versionArg);

  // Per-segment files first, so any index entry we add below already has
  // its payload on disk.
  const dir = segDir(name, version);
  await writeText(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  await writeText(`${dir}/segment.json`, JSON.stringify(segment, null, 2));

  const idx = await readIndex();
  const entry = idx.segments[name] ?? { latest: version, versions: [] };
  if (!entry.versions.includes(version)) entry.versions.push(version);
  entry.latest = version;
  idx.segments[name] = entry;
  await writeIndexAtomic(idx);
};

const put: Fn = async (
  nameArg: unknown, versionArg: unknown, manifest: unknown, segment: unknown,
) => {
  // Kernel-role guard runs BEFORE the write — calling the public put on a
  // kernel-closure segment is a programming error (use the seeding path).
  if ((manifest as 冊)?.role === "kernel") {
    throw new Error(
      `segment-store: refusing to put kernel-closure segment "${String(nameArg)}" — kernel seeds are bundled, not stored.`,
    );
  }
  return putRaw(nameArg, versionArg, manifest, segment);
};

const get: Fn = async (nameArg: unknown, versionArg?: unknown) => {
  const name = String(nameArg);
  const idx = await readIndex();
  const entry = idx.segments[name];
  if (!entry) return undefined;
  const version = versionArg === undefined ? entry.latest : String(versionArg);
  if (!entry.versions.includes(version)) return undefined;
  const dir = segDir(name, version);
  if (!(await exists(`${dir}/manifest.json`))) return undefined;
  const manifest = JSON.parse(await readText(`${dir}/manifest.json`)) as 冊;
  const segment = JSON.parse(await readText(`${dir}/segment.json`)) as 甲骨;
  return { manifest, segment };
};

const list: Fn = async () => {
  const idx = await readIndex();
  return Object.entries(idx.segments).map(([name, entry]) => ({ name, latest: entry.latest }));
};

const del: Fn = async (nameArg: unknown, versionArg?: unknown) => {
  const name = String(nameArg);
  const idx = await readIndex();
  const entry = idx.segments[name];
  if (!entry) return; // nothing to do
  const version = versionArg === undefined ? entry.latest : String(versionArg);

  await rmdir(segDir(name, version));

  entry.versions = entry.versions.filter((v) => v !== version);
  if (entry.versions.length === 0) {
    delete idx.segments[name];
  } else if (entry.latest === version) {
    // Repoint latest to the most-recent remaining version. v1 has no
    // semver ordering; "last surviving in insertion order" is the rule.
    entry.latest = entry.versions[entry.versions.length - 1];
  }
  await writeIndexAtomic(idx);
};

const has: Fn = async (nameArg: unknown) => {
  const idx = await readIndex();
  return Boolean(idx.segments[String(nameArg)]);
};

// ----- Segment export -----

export const name = "segment-store" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["store.put",    put],
  ["store.get",    get],
  ["store.list",   list],
  ["store.delete", del],
  ["store.has",    has],
]));
