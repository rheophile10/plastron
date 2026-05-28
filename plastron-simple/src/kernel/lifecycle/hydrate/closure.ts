import type { Fn, Key, State, 冊, 甲骨 } from "../../../types/index.js";
import { topoLevels } from "../../topo.js";
import { resolveFn } from "../../resolve-fn.js";
import { hydrate } from "./index.js";

// ============================================================================
// hydrateClosure — the shared "read-walk-topo-hydrate" pipeline (chunk D).
//
// Given a root segment name, BFS the segment-store collecting the root's
// full transitive dependency closure as { manifest, segment } records,
// drop the segments already loaded into `state`, topo-order the rest
// (dependencies first), and fold them in via a single hydrate() call.
//
// Idempotent: when the whole closure is already loaded, the filter empties
// the work set and the function is a no-op returning []. Reused by
// loadUserSpace, application auto-start, and (future) chunk E's loadSegment.
//
// Design: docs/1-design/.../session-segments.md "The shared hydrateClosure
// helper". transitiveClosure (topo.ts) is sync, so the dependency walk is
// done here by hand against the async segment-store.get.
// ============================================================================

interface StoreRecord { manifest: 冊; segment: 甲骨; }

export const hydrateClosure = async (
  state: State,
  rootName: Key,
  version?: string,
): Promise<Key[]> => {
  const get = resolveFn(state, "store.get") as Fn;

  // 1-2. BFS the store from the root, collecting one record per reachable
  //      segment. The root is read at the requested version; deps always
  //      resolve to the store's latest (a user-space pins its own version,
  //      not its libraries').
  const records = new Map<Key, StoreRecord>();
  const queue: Array<[Key, string | undefined]> = [[rootName, version]];
  while (queue.length > 0) {
    const [name, ver] = queue.shift()!;
    if (records.has(name)) continue;
    // A dep that's already loaded into state (e.g. a runtime application
    // segment like "notepad" or "file-explorer") is satisfied — its
    // upstream is already in memory. Don't fetch it from the store; its
    // closure is implicit. This is what makes a saved user-space portable
    // back into any session that has the parent app booted.
    if (name !== rootName && state.segments.has(name)) continue;
    const rec = (await get(name, ver)) as StoreRecord | undefined;
    if (!rec) {
      throw new Error(
        name === rootName
          ? `hydrateClosure: "${rootName}" not found in segment-store.`
          : `hydrateClosure: dependency "${name}" of "${rootName}" not found in segment-store.`,
      );
    }
    records.set(name, rec);
    for (const dep of rec.manifest.dependencies ?? []) {
      if (!records.has(dep)) queue.push([dep, undefined]);
    }
  }

  // 3. Drop segments already loaded — that's what makes reopen idempotent.
  const toLoad = [...records.keys()].filter((n) => !state.segments.has(n));
  if (toLoad.length === 0) return [];

  // 4-6. Topo-order the work set (deps first). Upstream edges are limited
  //      to the work set via memberSet, so already-loaded deps count as
  //      satisfied and don't force a re-load.
  const memberSet = new Set(toLoad);
  const ordered = topoLevels(
    toLoad,
    (n) => records.get(n)!.manifest.dependencies ?? [],
    { memberSet, cycleMessagePrefix: "hydrateClosure dependency cycle" },
  ).flat();

  const segments: 甲骨[] = ordered.map((n) => records.get(n)!.segment);
  const manifests: 冊[] = ordered.map((n) => records.get(n)!.manifest);

  // 7. One hydrate call; topo order preserved so an in-batch compiler dep
  //    installs before the cels that name it.
  await hydrate(state, segments, manifests);
  return ordered;
};
