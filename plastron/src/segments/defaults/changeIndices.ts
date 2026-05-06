import type { Key } from "../../common.js";
import type { State } from "../../state/types/index.js";
import type {
  ChangeIndexConfig, ChangeIndices,
} from "../../state/segments/types/index.js";
import type { HookSubscription } from "../../state/cycle/hooks.js";
import type { DehydratedCel } from "../../state/hydration/types.js";

// ========================================================================
// Default segment — change indices.
//
// Maintains two reserved cels:
//
//   • changeIndexConfig — { indexName: tagList[] }. Empty tag list =
//     "every cel that fired"; non-empty = only cels carrying any tag in
//     the list. Users write this cel to declare what they want tracked.
//
//   • changeIndices — populated by this segment. Shape:
//     { indexName: Key[][] } — outer index is wave number, inner array
//     is the keys that fired in that wave matching the tag filter.
//
// This was previously inline in runCycle. Lives here so plastron core
// can stay agnostic about which post-cycle views matter.
// ========================================================================

export const CHANGE_INDICES_SEGMENT = "changeIndices" as const;

export const changeIndicesCels: Record<Key, DehydratedCel> = {
  changeIndexConfig: {
    key: "changeIndexConfig",
    name: "Change Index Config",
    description: "Named change-tracking indices. { indexName: tagList }. Empty tag list = catch-all.",
    segment: CHANGE_INDICES_SEGMENT,
    v: {} satisfies ChangeIndexConfig,
  },
  changeIndices: {
    key: "changeIndices",
    name: "Change Indices",
    description: "Runtime-populated each cycle, wave-partitioned. { indexName: Key[][] }.",
    segment: CHANGE_INDICES_SEGMENT,
    v: {} satisfies ChangeIndices,
    dynamic: true,
  },
};

const resetIndices = (state: State): void => {
  const indicesCel = state.Cels.get("changeIndices");
  const configCel = state.Cels.get("changeIndexConfig");
  if (!indicesCel || !configCel) return;
  const config = (configCel.v ?? {}) as ChangeIndexConfig;
  const next: ChangeIndices = {};
  for (const name of Object.keys(config)) next[name] = [];
  indicesCel.v = next;
};

const recordWave = (
  state: State,
  waveIndex: number,
  changedKeys: Key[],
): void => {
  const indicesCel = state.Cels.get("changeIndices");
  const configCel = state.Cels.get("changeIndexConfig");
  if (!indicesCel || !configCel) return;

  const config = (configCel.v ?? {}) as ChangeIndexConfig;
  const indices = (indicesCel.v ?? {}) as ChangeIndices;

  for (const [indexName, tagList] of Object.entries(config)) {
    const matches: Key[] = [];
    for (const key of changedKeys) {
      const cel = state.Cels.get(key);
      if (!cel) continue;
      if (tagList.length === 0) {
        matches.push(key);
      } else if (cel.tags?.some((t) => tagList.includes(t))) {
        matches.push(key);
      }
    }
    const arr = indices[indexName] ?? [];
    while (arr.length <= waveIndex) arr.push([]);
    arr[waveIndex] = matches;
    indices[indexName] = arr;
  }

  indicesCel.v = indices;
};

/** Hook subscription that maintains the change-indices cels. Reset on
 *  beforeCycle, append on afterWave. */
export const changeIndicesHook = (state: State): HookSubscription => ({
  id: "plastron-defaults:changeIndices",
  beforeCycle: () => resetIndices(state),
  afterWave: (e) => recordWave(state, e.waveIndex, e.changedKeys),
});

/** Install the change-indices default segment on an existing State.
 *  Hydrates the two reserved cels and registers the hook subscription. */
export const installChangeIndices = async (state: State): Promise<void> => {
  // Skip if already installed (idempotent).
  if (state.Cels.has("changeIndices")) return;
  await state.hydrate!(
    [changeIndicesCels],
    [],
    {},
    {
      segments: {
        [CHANGE_INDICES_SEGMENT]: {
          key: CHANGE_INDICES_SEGMENT,
          role: "system",
          description: "Default segment — wave-partitioned change tracking.",
        },
      },
      hooks: changeIndicesHook(state),
    },
  );
};
