// ============================================================================
// plastromancy — Vite SPA entry.
//
// Hydrates the rite into a fresh state, mounts plastron-dom against
// #root, and lets the painter handle every cycle thereafter.
//
// FEATURES SHOWN:
//   • multi-segment hydrate (rules + session)
//   • augur kind — JSON rule book compiled at hydrate
//   • S-expression formula — (/ heat thickness)
//   • crack schema with isChanged that ignores intensity drift
//   • vnode schema diff materialized on cel._diff each cycle, then
//     applied to the DOM by plastron-dom's painter
//   • dispatchers — button clicks call kernel fns directly
// ============================================================================

import type { Fn, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import {
  installDom,
  vnodeSchema, VNODE_SCHEMA_KEY, VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY,
} from "../../../segments/plastron-dom/src/index.js";
import { rulesSegment, sessionSegment } from "./segments.js";
import { chiselFns } from "./lambdas.js";
import { augurCompiler } from "./kind.js";
import {
  crackSchema, CRACK_SCHEMA_KEY, CRACK_IS_CHANGED_KEY,
} from "./schemas.js";

const installShellEnvironment = (state: State): void => {
  state.schemas.set(VNODE_SCHEMA_KEY, vnodeSchema);
  state.schemaMetadata.set(VNODE_SCHEMA_KEY, {
    key:       VNODE_SCHEMA_KEY,
    isChanged: VNODE_IS_CHANGED_KEY,
    diff:      VNODE_DIFF_KEY,
  });
  state.schemas.set(CRACK_SCHEMA_KEY, crackSchema);
  state.schemaMetadata.set(CRACK_SCHEMA_KEY, {
    key:       CRACK_SCHEMA_KEY,
    isChanged: CRACK_IS_CHANGED_KEY,
  });
  state.fns.set("augur", augurCompiler);
};

const state = createInitialState();
installShellEnvironment(state);

const hydrate  = state.fns.get("hydrate")  as Fn;
const runCycle = state.fns.get("runCycle") as Fn;

hydrate(state, [rulesSegment, sessionSegment], [chiselFns]);
await runCycle(state);

const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: "appTree" } },
});

// Force the first paint synchronously instead of waiting for the next
// rAF — a lot more pleasant during dev refreshes.
handle.channel.drain();

// Devtools handle.
(globalThis as { __plastromancy?: unknown }).__plastromancy = state;
console.log("[plastromancy] mounted");
