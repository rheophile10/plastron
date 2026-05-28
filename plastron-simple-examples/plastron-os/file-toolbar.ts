// ============================================================================
// Shared file toolbar — New / Save / Open across every app.
//
// Each app's view template includes `{{(renderFileToolbar doc)}}` which
// fragment-inlines into the toolbar HTML; the click bindings dispatch into
// the file.* helpers below, which compose user-space-ops + segment-store. A
// helper finds the current app's `application` segment name by reading
// os.active → os.apps, so the same toolbar drops into any app.
//
// Active-doc binding (doc-binding.ts) is the bridge that makes the round-trip
// real: each app registers its editor cels via registerDocBinding, and
// fileNew / fileSave / fileOpen retarget those cels' metadata.segment to the
// active user-space so saveUserSpace's dehydrate picks them up.
//
// The dispatch helpers accept an optional `name` payload — when present, the
// browser prompt is skipped. Tests pass it explicitly; real clicks fall back
// to `globalThis.prompt`. (A custom in-page picker is a v1.1 polish.)
// ============================================================================

import { resolveFn } from "../../plastron-simple/dist/index.js";
import { getDocBinding, rebindCelsToDoc } from "./doc-binding.js";

export const renderFileToolbar = (doc: string | null | undefined): string => {
  const label = doc ?? "(unsaved)";
  return `
    <div class="file-toolbar">
      <button class="ft-new"  onClick={{(dispatch "file.new")}}>📄 New</button>
      <button class="ft-save" onClick={{(dispatch "file.save")}}>💾 Save</button>
      <button class="ft-open" onClick={{(dispatch "file.open")}}>📂 Open</button>
      <span class="doc-name">${String(label).replace(/[<>{}]/g, "")}</span>
    </div>`;
};

// ── helpers shared with the dispatch handlers ───────────────────────────────

const currentApp = (state: any): string | undefined => {
  const get = resolveFn(state, "get") as (...a: unknown[]) => unknown;
  const active = get(state, "os.active") as string | undefined;
  if (!active || active === "home") return undefined;
  const apps = (get(state, "os.apps") as Array<{ id: string; application?: string }> | undefined) ?? [];
  return apps.find((a) => a.id === active)?.application ?? active;
};

const ask = (msg: string, def?: string): string | null => {
  const p = (globalThis as { prompt?: (m: string, d?: string) => string | null }).prompt;
  return p ? p(msg, def) : null;
};

// ── file.new ────────────────────────────────────────────────────────────────

/** Create a fresh empty user-space under the active app: blank editor cels
 *  retargeted to the new segment, then persisted. */
export const fileNew = async (state: any, namePayload?: string): Promise<string | undefined> => {
  const app = currentApp(state);
  if (!app) return undefined;
  const fallback = `${app}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  const name = namePayload ?? ask(`New ${app} — name?`, fallback) ?? undefined;
  if (!name) return undefined;
  // autoSave: false — we'll persist once the editor cels are retargeted below.
  await (resolveFn(state, "newUserSpace") as Function)(state, name, app, { autoSave: false });
  await rebindCelsToDoc(state, app, name, { clear: true });
  await (resolveFn(state, "set") as Function)(state, "os.doc", name, { flush: "all" });
  await (resolveFn(state, "saveUserSpace") as Function)(state, name);
  // Let File Explorer auto-file the new doc into /<app>.
  const refresh = resolveFn(state, "fe.refresh") as Function | undefined;
  if (refresh) await refresh(state);
  return name;
};

// ── file.save ───────────────────────────────────────────────────────────────

/** Persist the active document. With no doc loaded, behaves like Save As:
 *  prompt for a name, create the user-space, retarget the editor cels
 *  WITHOUT clearing (preserve whatever the user has typed), then save. */
export const fileSave = async (state: any): Promise<string | undefined> => {
  const get = resolveFn(state, "get") as (...a: unknown[]) => unknown;
  const doc = get(state, "os.doc") as string | null | undefined;
  if (doc) {
    await (resolveFn(state, "saveUserSpace") as Function)(state, doc);
    return doc;
  }
  const app = currentApp(state);
  if (!app) return undefined;
  const fallback = `${app}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  const name = ask(`Save ${app} as —`, fallback) ?? undefined;
  if (!name) return undefined;
  await (resolveFn(state, "newUserSpace") as Function)(state, name, app, { autoSave: false });
  await rebindCelsToDoc(state, app, name);          // preserve content
  await (resolveFn(state, "set") as Function)(state, "os.doc", name, { flush: "all" });
  await (resolveFn(state, "saveUserSpace") as Function)(state, name);
  const refresh = resolveFn(state, "fe.refresh") as Function | undefined;
  if (refresh) await refresh(state);
  return name;
};

// ── file.open ───────────────────────────────────────────────────────────────

/** List the user-spaces under the active app from segment-store and load
 *  the chosen one. loadUserSpace's hydrate replaces the editor cels with the
 *  persisted values — no explicit rebind needed.
 *  With a `namePayload` the prompt is skipped (for tests). */
export const fileOpen = async (state: any, namePayload?: string): Promise<string | undefined> => {
  const app = currentApp(state);
  if (!app) return undefined;
  // store.list returns { name, latest }; pull manifests via store.get to filter.
  const list = resolveFn(state, "store.list") as Function;
  const getOne = resolveFn(state, "store.get") as (n: string) => Promise<{ manifest: { role?: string; applications?: string[] } } | undefined>;
  const all = (await list()) as Array<{ name: string; latest: string }>;
  const withMeta = await Promise.all(all.map(async (e) => ({ name: e.name, entry: await getOne(e.name) })));
  const candidates = withMeta
    .filter((e) => e.entry && e.entry.manifest.role === "user-space" && (e.entry.manifest.applications ?? []).includes(app))
    .map((e) => e.name);
  if (candidates.length === 0) return undefined;
  const choice = namePayload ?? ask(`Open ${app} —\n${candidates.join("\n")}\n\nWhich?`, candidates[0]) ?? undefined;
  if (!choice) return undefined;
  if (!(state as { segments: Map<string, unknown> }).segments.has(choice)) {
    await (resolveFn(state, "loadUserSpace") as Function)(state, choice);
  } else {
    // Already loaded (we created it earlier this session); rebinding from the
    // persisted store is a no-op because hydrate-replace already moved the
    // editor cels into the segment. Still: if the binding has been moved off
    // to another doc since, retarget back. The cheap thing is to just
    // re-hydrate the segment-store's payload via load + replace.
    const get = resolveFn(state, "store.get") as Function;
    const entry = await get(choice);
    if (entry?.segment) {
      const hydrate = resolveFn(state, "hydrate") as Function;
      await hydrate(state, [entry.segment], []);
    }
  }
  await (resolveFn(state, "set") as Function)(state, "os.doc", choice, { flush: "all" });
  return choice;
};

// ── one-shot setup: register helpers + the renderFileToolbar partial ────────

export const setupFileToolbar = async (state: any): Promise<void> => {
  const reg = resolveFn(state, "registerLambda") as (s: unknown, a: unknown) => Promise<unknown>;
  await reg(state, { key: "renderFileToolbar", fn: renderFileToolbar, kind: "custom" });
  await reg(state, { key: "file.new", fn: fileNew, kind: "custom" });
  await reg(state, { key: "file.save", fn: fileSave, kind: "custom" });
  await reg(state, { key: "file.open", fn: fileOpen, kind: "custom" });
};

export { getDocBinding, rebindCelsToDoc } from "./doc-binding.js";
