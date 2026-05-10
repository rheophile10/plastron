// ============================================================================
// fetch-demo — exercise plastron-fetch end-to-end.
//
//   1. Boot a fresh state, install plastron-fetch.
//   2. Hydrate three cels:
//        - userRequest   : value cel holding a FetchRequest
//        - userResponse  : lambda cel { l: "fetchJson",
//                                      inputMap: { request: "userRequest" } }
//        - userName      : lambda cel that reads userResponse.data and
//                          extracts a name field.
//   3. Run a cycle. The cascade fires fetchJson, awaits it, then fires
//      the extractor.
//   4. Inspect the response. On success, prints the parsed name. On
//      network failure (offline, DNS issue, etc.), the error-as-value
//      path surfaces as `{ ok: false, error: "..." }` and the
//      extractor reports it.
//   5. Demonstrate POST + JSON body shaping.
//   6. Demonstrate the channel onCommit hook.
//   7. Tear the segment down via flush.
// ============================================================================

import type { Fn, LambdaKey } from "../../../plastron/src/index.js";
import { createInitialState, listSegments } from "../../../plastron/src/index.js";
import {
  createFetchChannel, FETCH_JSON_KEY, installFetch, PLASTRON_FETCH_SEGMENT,
  type FetchRequest, type FetchResponse,
} from "../../../segments/plastron-fetch/src/index.js";

const EXTRACT_NAME_KEY: LambdaKey = "fetchDemo:extractName";
const EXTRACT_POST_KEY: LambdaKey = "fetchDemo:extractPost";

const extractName: Fn = ({ response }: { response: FetchResponse | undefined }): string => {
  if (!response) return "(no response yet)";
  if (!response.ok) return `error: ${response.error ?? "unknown"}`;
  const data = response.data as { name?: unknown } | null;
  if (!data || typeof data !== "object") return "(no data)";
  const n = data.name;
  return typeof n === "string" ? n : "(name field missing)";
};

const extractPost: Fn = ({ response }: { response: FetchResponse | undefined }): string => {
  if (!response) return "(no response yet)";
  if (!response.ok) return `error: ${response.error ?? "unknown"}`;
  const data = response.data as { json?: unknown; data?: unknown } | null;
  if (!data || typeof data !== "object") return "(no data)";
  // httpbin echoes the request body back at .json (when JSON) and .data (raw).
  // Return whatever we see for inspection.
  return JSON.stringify(data.json ?? data.data ?? "(no body echoed)");
};

const state = createInitialState();
installFetch(state);

console.log("[1] segments after installFetch:");
for (const m of listSegments(state)) console.log("    -", `${m.segment}@${m.version}`);

const hydrate = state.fns.get("hydrate") as Fn;
const runCycle = state.fns.get("runCycle") as Fn;
const set = state.fns.get("set") as Fn;
const get = state.fns.get("get") as Fn;
const flush = state.fns.get("flush") as Fn;

const userRequest: FetchRequest = {
  url: "https://jsonplaceholder.typicode.com/users/1",
  method: "GET",
};

hydrate(
  state,
  [{
    key: "fetch-demo",
    cels: [
      { key: "userRequest",  v: userRequest, segment: "fetch-demo" },
      {
        key: "userResponse",
        l: FETCH_JSON_KEY,
        inputMap: { request: "userRequest" },
        segment: "fetch-demo",
      },
      {
        key: "userName",
        l: EXTRACT_NAME_KEY,
        inputMap: { response: "userResponse" },
        segment: "fetch-demo",
      },
    ],
  }],
  [new Map<LambdaKey, Fn>([
    [EXTRACT_NAME_KEY, extractName],
  ])],
);

console.log("\n[2] running cycle (GET /users/1):");
await runCycle(state);

const response1 = get(state, "userResponse") as FetchResponse;
console.log("    userResponse.ok:    ", response1.ok);
if (response1.ok) {
  console.log("    userResponse.status:", response1.status);
  const data = response1.data as Record<string, unknown> | null;
  if (data) {
    const preview: Record<string, unknown> = {};
    for (const k of ["id", "name", "username", "email"]) {
      if (k in data) preview[k] = data[k];
    }
    console.log("    userResponse.data (preview):", JSON.stringify(preview));
  }
} else {
  console.log("    userResponse.error: ", response1.error);
}
console.log("    userName:           ", get(state, "userName"));

// ── Demo 2: POST with JSON body ──────────────────────────────────────────

console.log("\n[3] POST with JSON body (auto Content-Type):");
hydrate(
  state,
  [{
    key: "fetch-demo-post",
    cels: [
      {
        key: "postRequest",
        v: {
          url: "https://httpbin.org/post",
          method: "POST",
          body: { greeting: "hello", from: "plastron-fetch" },
        } satisfies FetchRequest,
        segment: "fetch-demo-post",
      },
      {
        key: "postResponse",
        l: FETCH_JSON_KEY,
        inputMap: { request: "postRequest" },
        segment: "fetch-demo-post",
      },
      {
        key: "postEcho",
        l: EXTRACT_POST_KEY,
        inputMap: { response: "postResponse" },
        segment: "fetch-demo-post",
      },
    ],
  }],
  [new Map<LambdaKey, Fn>([
    [EXTRACT_POST_KEY, extractPost],
  ])],
);

await runCycle(state);

const response2 = get(state, "postResponse") as FetchResponse;
console.log("    postResponse.ok:    ", response2.ok);
if (response2.ok) {
  console.log("    postResponse.status:", response2.status);
  console.log("    postEcho:           ", get(state, "postEcho"));
} else {
  console.log("    postResponse.error: ", response2.error);
}

// ── Demo 3: Demonstrate the error-as-value path with a bad URL ───────────

console.log("\n[4] error-as-value path (intentional bad URL):");
await set(state, "userRequest", {
  url: "https://this-host-does-not-exist.invalid/users/1",
  method: "GET",
} satisfies FetchRequest);

const response3 = get(state, "userResponse") as FetchResponse;
console.log("    userResponse.ok:    ", response3.ok);
console.log("    userResponse.error: ", response3.error);
console.log("    userName:           ", get(state, "userName"));

// ── Demo 4: Channel onCommit hook ────────────────────────────────────────

console.log("\n[5] channel onCommit hook (separate channel + debounced):");
// Register a second fetch channel with onCommit + debounce so we can
// observe commits without colliding with the default channel.
const observed: Array<{ key: string; status: number | undefined; ok: boolean }> = [];
const debouncedChannel = createFetchChannel(state, {
  debounceMs: 10,
  onCommit: (celKey, value) => {
    const v = value as FetchResponse;
    observed.push({ key: celKey, status: v.status, ok: v.ok });
  },
});
state.channelRegistry.set("fetch:observed", debouncedChannel);

hydrate(
  state,
  [{
    key: "fetch-demo-observed",
    cels: [
      {
        key: "obsRequest",
        v: {
          url: "https://jsonplaceholder.typicode.com/users/2",
          method: "GET",
        } satisfies FetchRequest,
        segment: "fetch-demo-observed",
      },
      {
        key: "obsResponse",
        l: FETCH_JSON_KEY,
        inputMap: { request: "obsRequest" },
        channel: "fetch:observed",
        segment: "fetch-demo-observed",
      },
    ],
  }],
  [],
);

await runCycle(state);
// Drain the debounced channel so onCommit fires before we check.
const drain = state.fns.get("drain") as Fn;
await drain(state, "fetch:observed");
console.log("    onCommit observations:", JSON.stringify(observed));
debouncedChannel.dispose();
state.channelRegistry.delete("fetch:observed");

// ── Demo 5: Flush teardown ───────────────────────────────────────────────

console.log("\n[6] flush plastron-fetch (cascade through dependents):");
// Flush the user-segments first since they live in their own segments
// and don't declare a dependsOn — but plastron-fetch's flush only
// removes its own sentinel cel and the channel.
await flush(state, "fetch-demo");
await flush(state, "fetch-demo-post");
await flush(state, "fetch-demo-observed");
await flush(state, PLASTRON_FETCH_SEGMENT);
console.log("    fetch channel still registered?:", state.channelRegistry.has("fetch"));
console.log("    plastron-fetch in segments?:    ",
  listSegments(state).some((m) => m.segment === PLASTRON_FETCH_SEGMENT));
console.log("    fetchJson lambda still in fns?: ", state.fns.has(FETCH_JSON_KEY),
  "(flush removes cels + channel via _dispose, NOT lambdas/schemas)");

console.log("\n[7] done.");
