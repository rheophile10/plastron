import type { 甲骨, Cel, Fn, Key, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import { resolveFn } from "../kernel/resolve-fn.js";
import seed from "./app-host.json" with { type: "json" };

// ============================================================================
// app-host — the plastron-OS launcher MECHANISM (role: library, rendering-
// agnostic). Holds the active-app + installed-app registry cels and the
// launch/switch/exit ops, composed over session-segments (user-space-ops).
// The kernel stays the headless substrate; the desktop application renders
// this state. See docs/1-design/1-under-consideration/plastron-os.md.
// ============================================================================

interface AppEntry { id: string; title?: string; icon?: string; application?: string; }
interface LaunchOpts { save?: boolean; }
interface ExitOpts { save?: boolean; }

const call = (state: State, key: Key, ...args: unknown[]): unknown => {
  const fn = resolveFn(state, key);
  if (!fn) throw new Error(`app-host: required op "${key}" is unavailable`);
  return fn(state, ...args);
};

const apps = (state: State): AppEntry[] => (resolveFn(state, "get")!(state, "os.apps") as AppEntry[] | undefined) ?? [];

/** Activate an app; with a docName, ensure its user-space is loaded first. */
const launch: Fn = async (state: State, appId: Key, docName?: Key, opts?: LaunchOpts) => {
  const app = apps(state).find((a) => a.id === appId);
  if (docName && !state.segments.has(docName)) {
    const has = resolveFn(state, "store.has") as Fn | undefined;
    if (has && (await has(docName))) {
      await call(state, "loadUserSpace", docName);
    } else {
      const appName = app?.application ?? appId;
      await call(state, "newUserSpace", docName, appName, { autoSave: opts?.save !== false });
    }
  }
  // flush:"all" drains the paint channel so the desktop repaints this frame.
  await call(state, "batch", [["os.active", appId], ["os.doc", docName ?? null]], { flush: "all" });
  return state;
};

/** Switch to an already-loaded app. (dispatch-safe: ignores the event arg.) */
const switchTo: Fn = async (state: State, appId: Key) => {
  await call(state, "set", "os.active", appId, { flush: "all" });
  return state;
};

/** Return to the launcher; optionally save the active document first.
 *  (dispatch-safe: a click binding `{f:"(dispatch \"os.exit\")"}` calls this
 *  with opts === undefined.) */
const exit: Fn = async (state: State, opts?: ExitOpts) => {
  const doc = resolveFn(state, "get")!(state, "os.doc") as Key | null | undefined;
  if (opts?.save && doc) await call(state, "saveUserSpace", doc);
  await call(state, "batch", [["os.active", "home"], ["os.doc", null]], { flush: "all" });
  return state;
};

/** Append an app descriptor to the registry (idempotent by id). */
const registerApp: Fn = async (state: State, app: AppEntry) => {
  const current = apps(state);
  if (current.some((a) => a.id === app.id)) return state;
  await call(state, "set", "os.apps", [...current, app], { flush: "all" });
  return state;
};

export const name = "app-host" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["os.launch",       launch],
  ["os.switch",       switchTo],
  ["os.exit",         exit],
  ["os.register-app", registerApp],
]));
