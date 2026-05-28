import type { Fn, Key, State, 冊, 甲骨 } from "../../types/index.js";
import { resolveFn } from "../../kernel/resolve-fn.js";
import { zipBytes, unzipBytes, type ZipEntry } from "./zip.js";

// ============================================================================
// Role-aware segment archive — packs/unpacks segments as a role-foldered .zip
// (the `.甲` archive), over the kernel's existing dehydrate/hydrate. The
// kernel closure (role:"kernel" + its transitive deps — i.e. everything that
// boots with the bundle) is always excluded; on import those deps resolve
// against the already-booted kernel.
//
// Layout:
//   plastron.index.json                  — { format, entries: [{name,version,role,dependencies}] }
//   applications/<name>@<version>/{manifest,segment}.json
//   libraries/<name>@<version>/{manifest,segment}.json
//   user/<name>@<version>/{manifest,segment}.json
// ============================================================================

export type Role = "kernel" | "library" | "application" | "user-space";

const ROLE_FOLDER: Record<string, string> = {
  application: "applications",
  library: "libraries",
  "user-space": "user",
};
const FOLDER_ROLE: Record<string, Role> = {
  applications: "application",
  libraries: "library",
  user: "user-space",
};

const roleOf = (state: State, name: Key): Role =>
  ((state.segments.get(name)?.role as Role | undefined) ?? "library");

/** Names of role:"kernel" segments plus their transitive deps — the boot
 *  closure that ships with the bundle and is never archived. */
const kernelClosure = (state: State): Set<Key> => {
  const out = new Set<Key>();
  const queue: Key[] = [];
  for (const [name, m] of state.segments) if (m.role === "kernel") queue.push(name);
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (out.has(name)) continue;
    out.add(name);
    for (const dep of state.segments.get(name)?.dependencies ?? []) queue.push(dep);
  }
  return out;
};

/** BFS from `roots` over the dependency graph, collecting every reachable
 *  segment whose role is in `includeRoles` and which isn't in the kernel
 *  closure. Traversal follows ALL deps (so a deeper includable dep behind a
 *  referenced one is still found); only matching roles are collected. */
const closureForRoles = (state: State, roots: Key[], includeRoles: Set<Role>): Set<Key> => {
  const kernel = kernelClosure(state);
  const include = new Set<Key>();
  const seen = new Set<Key>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const m = state.segments.get(name);
    if (!m) continue;
    if (!kernel.has(name) && includeRoles.has(roleOf(state, name))) include.add(name);
    for (const dep of m.dependencies ?? []) queue.push(dep);
  }
  return include;
};

// ── per-tier include sets ───────────────────────────────────────────────────
//
//   library     — the library + its transitive library deps (self-contained)
//   application — the app + its transitive library deps (self-contained, runnable)
//   user        — the user-space + its private (role:user-space) deps only;
//                 shared libraries + the application are REFERENCED, not packed
//                 (they're expected present — bundled or already loaded — on import)
//   all         — every loaded segment outside the kernel closure, by role

export const includeForLibrary = (state: State, name: Key): Set<Key> =>
  closureForRoles(state, [name], new Set<Role>(["library"]));

export const includeForApplication = (state: State, name: Key): Set<Key> =>
  closureForRoles(state, [name], new Set<Role>(["application", "library"]));

export const includeForUser = (state: State, name: Key): Set<Key> =>
  closureForRoles(state, [name], new Set<Role>(["user-space"]));

export const includeAll = (state: State): Set<Key> => {
  const kernel = kernelClosure(state);
  const out = new Set<Key>();
  for (const [name, m] of state.segments) {
    if (kernel.has(name)) continue;
    if (m.role === "kernel") continue;
    out.add(name);
  }
  return out;
};

// ── build ────────────────────────────────────────────────────────────────────

interface IndexEntry { name: Key; version: string; role: Role; dependencies: Key[]; }

/** Dehydrate the included segments and pack them into a role-foldered .zip. */
export const buildArchive = async (state: State, includeNames: Set<Key>): Promise<Uint8Array> => {
  const dehydrate = resolveFn(state, "dehydrate") as Fn | undefined;
  if (!dehydrate) throw new Error("archive: dehydrate fn unavailable");
  const dumped = dehydrate(state, { onlySegments: [...includeNames] }) as { segments: 甲骨[]; manifests: 冊[] };
  const manByName = new Map<Key, 冊>(dumped.manifests.map((m) => [m.name, m]));

  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];
  const index: IndexEntry[] = [];

  for (const seg of dumped.segments) {
    const m = manByName.get(seg.name) ?? state.segments.get(seg.name);
    const role = (m?.role as Role | undefined) ?? roleOf(state, seg.name);
    const folder = ROLE_FOLDER[role];
    if (!folder) continue; // kernel — never archived
    const version = m?.version ?? "0.0.0";
    const dir = `${folder}/${seg.name}@${version}`;
    const manifest = m ?? { name: seg.name, version, role, dependencies: [] };
    entries.push({ path: `${dir}/manifest.json`, bytes: enc.encode(JSON.stringify(manifest, null, 2)) });
    entries.push({ path: `${dir}/segment.json`, bytes: enc.encode(JSON.stringify(seg, null, 2)) });
    index.push({ name: seg.name, version, role, dependencies: m?.dependencies ?? [] });
  }

  entries.unshift({
    path: "plastron.index.json",
    bytes: enc.encode(JSON.stringify({ format: "plastron-archive/1", entries: index }, null, 2)),
  });
  return zipBytes(entries);
};

// ── load ──────────────────────────────────────────────────────────────────────

export interface LoadOptions {
  /** When present, only segments of these roles are hydrated from the archive
   *  (tiered import — e.g. pull just the user-spaces out of a full workspace). */
  onlyRoles?: Role[];
}

const ENTRY_RE = /^(applications|libraries|user)\/(.+)\/(manifest|segment)\.json$/;

/** Unzip an archive and hydrate its segments into `state`, skipping the
 *  kernel closure (it comes from the booted bundle). External deps resolve
 *  against what's already loaded. */
export const loadArchive = async (state: State, bytes: Uint8Array, opts: LoadOptions = {}): Promise<State> => {
  const dec = new TextDecoder();
  const entries = await unzipBytes(bytes);
  const byDir = new Map<string, { folder: string; manifest?: 冊; segment?: 甲骨 }>();

  for (const e of entries) {
    if (e.path === "plastron.index.json") continue; // advisory; folders are authoritative
    const m = ENTRY_RE.exec(e.path);
    if (!m) continue;
    const dir = `${m[1]}/${m[2]}`;
    const slot = byDir.get(dir) ?? { folder: m[1]! };
    if (m[3] === "manifest") slot.manifest = JSON.parse(dec.decode(e.bytes)) as 冊;
    else slot.segment = JSON.parse(dec.decode(e.bytes)) as 甲骨;
    byDir.set(dir, slot);
  }

  const onlyRoles = opts.onlyRoles ? new Set<Role>(opts.onlyRoles) : undefined;
  const segments: 甲骨[] = [];
  const manifests: 冊[] = [];
  for (const slot of byDir.values()) {
    if (!slot.manifest || !slot.segment) continue;
    const role = (slot.manifest.role as Role | undefined) ?? FOLDER_ROLE[slot.folder] ?? "library";
    if (role === "kernel") continue; // never imported — comes from the bundle
    if (onlyRoles && !onlyRoles.has(role)) continue;
    segments.push(slot.segment);
    manifests.push(slot.manifest);
  }

  const hydrate = resolveFn(state, "hydrate") as Fn | undefined;
  if (!hydrate) throw new Error("archive: hydrate fn unavailable");
  await hydrate(state, segments, manifests);
  return state;
};
