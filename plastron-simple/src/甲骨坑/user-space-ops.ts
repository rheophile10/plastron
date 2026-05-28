import type { 甲骨, Cel, Fn, Key, State, 冊 } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { hydrate } from "../kernel/lifecycle/hydrate/index.js";
import { dehydrate } from "../kernel/lifecycle/dehydrate/index.js";
import { flush } from "../kernel/lifecycle/flush.js";
import { hydrateClosure } from "../kernel/lifecycle/hydrate/closure.js";
import { transitiveClosure, topoLevels } from "../kernel/topo.js";
import { resolveFn } from "../kernel/resolve-fn.js";
import seed from "./user-space-ops.json" with { type: "json" };

// ============================================================================
// user-space-ops — chunk D. The four user-space lifecycle ops (new / save /
// load / close) plus the shared hydrate-closure cel. Generic over any
// application: apps wrap these with app-specific defaults rather than each
// re-implementing hydrate/dehydrate/segment-store plumbing.
//
// Design: docs/1-design/.../session-segments.md.
//
// SCOPE (v1 deferrals, documented in 4-current):
//   • Dirty-flag tracking. The design's open-question #1 leans toward a
//     <name>.dirty cel auto-set by setCel on mutation. That instruments the
//     locked kernel mutation path; deferred. closeUserSpace is save-agnostic
//     (close != save) and the round-trip contract doesn't need it. Hosts can
//     track dirtiness themselves until a follow-up lands the auto-set.
//   • runUntilSettled-before-save (open-question #5). v1 assumes saveUserSpace
//     is called between cascades (host responsibility); it reads cel.v as-is.
//   • startApplication is a chunk-G concern; loadUserSpace auto-starts the
//     parent application inline via hydrateClosure(state, appName).
// ============================================================================

interface NewOptions {
  version?: string;
  description?: string;
  extraDeps?: Key[];
  overwrite?: boolean;
  autoSave?: boolean;
}

// A dep is PRIVATE to `owner` when it is itself a user-space whose
// application affinity is a subset of the owner's — i.e. data the user
// authored under the same app, not a shared library/application/kernel dep.
const isPrivateDep = (state: State, depName: Key, owner: 冊): boolean => {
  const m = state.segments.get(depName);
  if (!m || m.role !== "user-space") return false;
  const ownerApps = new Set(owner.applications ?? []);
  return (m.applications ?? []).every((a) => ownerApps.has(a));
};

// The user-space's private closure: the root plus every transitively-
// reachable private dep. Library/application/kernel deps are pruned at the
// edge, so they never enter the set.
const privateClosure = (state: State, name: Key): Key[] => {
  const owner = state.segments.get(name);
  if (!owner) return [name];
  return [...transitiveClosure([name], (n) => {
    const m = state.segments.get(n);
    return (m?.dependencies ?? []).filter((d) => isPrivateDep(state, d, owner));
  })];
};

const assertUserSpace = (state: State, name: Key, op: string): 冊 => {
  const m = state.segments.get(name);
  if (!m) throw new Error(`${op}: "${name}" is not loaded.`);
  if (m.role !== "user-space") {
    throw new Error(`${op}: "${name}" is role:"${m.role}", not "user-space".`);
  }
  return m;
};

// ── saveUserSpace ───────────────────────────────────────────────────────────
const saveUserSpace: Fn = async (stateArg: unknown, nameArg: unknown): Promise<Key[]> => {
  const state = stateArg as State;
  const name = String(nameArg);
  assertUserSpace(state, name, "saveUserSpace");

  const closure = privateClosure(state, name);
  const { segments, manifests } = dehydrate(state, { onlySegments: closure });
  const put = resolveFn(state, "store.put") as Fn;

  // Drive off manifests (authoritative for the closure): a freshly-created
  // empty user-space has a manifest but no cels, so groupCelsBySegment emits
  // no 甲骨 for it — fall back to an empty payload.
  const segByName = new Map(segments.map((s) => [s.name, s]));
  for (const manifest of manifests) {
    const segment: 甲骨 = segByName.get(manifest.name) ?? { name: manifest.name, cels: [] };
    await put(manifest.name, manifest.version, manifest, segment);
  }
  return closure;
};

// ── newUserSpace ──────────────────────────────────────────────────────────
const newUserSpace: Fn = async (
  stateArg: unknown, nameArg: unknown, appArg: unknown, optsArg?: unknown,
): Promise<冊> => {
  const state = stateArg as State;
  const name = String(nameArg);
  const applicationName = String(appArg);
  const options = (optsArg ?? {}) as NewOptions;

  // 1. The parent application must be a loaded role:"application" segment.
  const app = state.segments.get(applicationName);
  if (!app || app.role !== "application") {
    throw new Error(
      `newUserSpace: application "${applicationName}" is not a loaded role:"application" segment ` +
      `(start it first).`,
    );
  }
  // 2. Collision check — loaded segments and the store (unless overwrite).
  if (state.segments.has(name)) {
    throw new Error(`newUserSpace: "${name}" is already loaded.`);
  }
  if (!options.overwrite) {
    const has = resolveFn(state, "store.has") as Fn;
    if (await has(name)) {
      throw new Error(
        `newUserSpace: "${name}" already exists in segment-store; pass { overwrite: true } to replace it.`,
      );
    }
  }
  // 3-4. Manifest + empty 甲骨.
  const manifest: 冊 = {
    name,
    version: options.version ?? "0.0.1",
    description: options.description ?? "",
    role: "user-space",
    applications: [applicationName],
    dependencies: [applicationName, ...(options.extraDeps ?? [])],
  };
  const segment: 甲骨 = { name, cels: [] };

  // 5. Hydrate into state.
  await hydrate(state, [segment], [manifest]);

  // 6. Persist immediately unless explicitly opted out.
  if (options.autoSave !== false) await saveUserSpace(state, name);
  return manifest;
};

// ── loadUserSpace ───────────────────────────────────────────────────────────
const loadUserSpace: Fn = async (
  stateArg: unknown, nameArg: unknown, versionArg?: unknown,
): Promise<冊> => {
  const state = stateArg as State;
  const name = String(nameArg);
  const version = versionArg === undefined ? undefined : String(versionArg);

  const get = resolveFn(state, "store.get") as Fn;
  const probe = (await get(name, version)) as { manifest: 冊 } | undefined;
  if (!probe) throw new Error(`loadUserSpace: "${name}" not found in segment-store.`);
  if (probe.manifest.role !== "user-space") {
    throw new Error(`loadUserSpace: "${name}" is role:"${probe.manifest.role}", not "user-space".`);
  }

  // Auto-start the parent application (and its library deps) if not running.
  const appName = probe.manifest.applications?.[0];
  if (appName !== undefined && !state.segments.has(appName)) {
    await hydrateClosure(state, appName);
  }

  // Hydrate the user-space's own closure. Idempotent if already open.
  await hydrateClosure(state, name, version);
  return probe.manifest;
};

// ── closeUserSpace ──────────────────────────────────────────────────────────
const closeUserSpace: Fn = async (stateArg: unknown, nameArg: unknown): Promise<void> => {
  const state = stateArg as State;
  const name = String(nameArg);
  assertUserSpace(state, name, "closeUserSpace");

  const closure = privateClosure(state, name);
  // Flush root-first (dependents before deps) so each flush's dependent
  // check passes: deps-first topo order, reversed. memberSet confines the
  // leveling to the private closure (library/app upstreams are ignored).
  const memberSet = new Set(closure);
  const rootFirst = topoLevels(
    closure,
    (n) => state.segments.get(n)?.dependencies ?? [],
    { memberSet },
  ).flat().reverse();

  for (const segName of rootFirst) {
    await (flush as Fn)(state, segName);
  }
};

// ── hydrate-closure (exposed cel; loadUserSpace uses the helper directly) ──
const hydrateClosureCel: Fn = (
  stateArg: unknown, rootArg: unknown, versionArg?: unknown,
): Promise<Key[]> =>
  hydrateClosure(
    stateArg as State,
    String(rootArg),
    versionArg === undefined ? undefined : String(versionArg),
  );

export const name = "user-space-ops" as const;

export const cels: Cel[] = bindNativeFns(
  seed as unknown as 甲骨,
  new Map<string, Fn>([
    ["newUserSpace", newUserSpace],
    ["saveUserSpace", saveUserSpace],
    ["loadUserSpace", loadUserSpace],
    ["closeUserSpace", closeUserSpace],
    ["hydrate-closure", hydrateClosureCel],
  ]),
);
