// ============================================================================
// File Explorer v2 — standard file-explorer UX.
//
// What's new vs v1: folders + drag-and-drop, no "+ New file" (the apps own
// creation, the explorer just explores). The state model is two cels:
//
//   fs-tree.folders   : string[]                — absolute folder paths
//   fs-tree.locations : Record<segName, path>   — where each file lives
//
// Persisted as a `fs-tree` user-space segment (applications: ["file-explorer"])
// so the layout survives reloads. At first boot it's seeded with one folder
// per known app ("/notepad", "/sheets"); new docs without a recorded location
// are auto-filed into "/<app>" by `refresh`.
//
// CWD navigation:
//   file-explorer.cwd : string  (default "/")
//
// Drag-and-drop:
//   - file card has draggable=true; `fe.dragstart` sets dataTransfer
//   - folder card has dragover→preventDefault (so drop is allowed) + drop
//     handler that reads the segment name and calls `fe.move(name, folder)`.
//
// Click handling: click a folder → fe.cd into it; click a file → fe.open.
// ============================================================================

import { resolveFn } from "../../plastron-simple/dist/index.js";

const FS_TREE = "fs-tree";

// ── types ───────────────────────────────────────────────────────────────────

interface StoreListEntry { name: string; latest: string }
interface FileEntry { name: string; manifest: { role?: string; applications?: string[]; version?: string } }

type State = unknown;
const get = (state: State, k: string): unknown =>
  (resolveFn(state as never, "get") as (...a: unknown[]) => unknown)(state as never, k);
const set = async (state: State, k: string, v: unknown): Promise<void> => {
  await (resolveFn(state as never, "set") as (...a: unknown[]) => Promise<unknown>)(state as never, k, v, { flush: "all" });
};
const callFn = async (state: State, k: string, ...args: unknown[]): Promise<unknown> =>
  await (resolveFn(state as never, k) as (...a: unknown[]) => Promise<unknown>)(state as never, ...args);

// ── path helpers ────────────────────────────────────────────────────────────

const normalize = (p: string): string => {
  const parts = p.split("/").filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
};
const parentOf = (p: string): string => {
  const n = normalize(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
};
const childName = (p: string): string => {
  const n = normalize(p);
  return n === "/" ? "/" : n.slice(n.lastIndexOf("/") + 1);
};
const isDirectChild = (parent: string, candidate: string): boolean =>
  parentOf(candidate) === normalize(parent) && candidate !== parent;

// ── fs-tree lifecycle ───────────────────────────────────────────────────────

/** Build the cel records for an fs-tree segment. Preserves any current values
 *  in state.cels — used both for first-boot bootstrap and for later resaves. */
const fsTreeCels = (state: State, folders: string[], locations: Record<string, string>) => ([
  { key: "fs-tree.folders",   celType: "ValueCel", metadata: { key: "fs-tree.folders",   segment: FS_TREE, v: folders   } },
  { key: "fs-tree.locations", celType: "ValueCel", metadata: { key: "fs-tree.locations", segment: FS_TREE, v: locations } },
]);

/** Make sure the fs-tree user-space exists in segment-store and is loaded.
 *  First-time setup seeds it with one folder per known application. */
const ensureFsTree = async (state: State, defaultFolders: string[]): Promise<void> => {
  const has = resolveFn(state as never, "store.has") as (n: string) => Promise<boolean>;
  if (await has(FS_TREE)) {
    if (!(state as { segments: Map<string, unknown> }).segments.has(FS_TREE)) {
      await callFn(state, "loadUserSpace", FS_TREE);
    }
    return;
  }
  // Bootstrap: create the user-space, retarget the placeholder cels onto it,
  // and persist.
  await callFn(state, "newUserSpace", FS_TREE, "file-explorer", { autoSave: false });
  const hydrate = resolveFn(state as never, "hydrate") as (s: unknown, segs: unknown, m: unknown) => Promise<unknown>;
  await hydrate(state, [{ name: FS_TREE, cels: fsTreeCels(state, defaultFolders, {}) }], []);
  await callFn(state, "saveUserSpace", FS_TREE);
};

/** Persist current fs-tree.folders + fs-tree.locations to the store. */
const saveFsTree = async (state: State): Promise<void> => {
  await callFn(state, "saveUserSpace", FS_TREE);
};

// ── refresh: pull user-space list from store, auto-file new docs ────────────

/** Read the segment-store, exclude fs-tree itself, auto-file any user-space
 *  that has no recorded location into "/<app>". Updates file-explorer.items
 *  + fs-tree.locations (saving when locations changed). */
export const refresh = async (state: State): Promise<void> => {
  const list = resolveFn(state as never, "store.list") as () => Promise<StoreListEntry[]>;
  const getOne = resolveFn(state as never, "store.get") as (n: string) => Promise<{ manifest: FileEntry["manifest"] } | undefined>;
  const all = (await list()) ?? [];
  const hydrated = await Promise.all(all.map(async (e) => {
    const got = await getOne(e.name);
    return got ? { name: e.name, manifest: got.manifest } : undefined;
  }));
  const userSpaces = hydrated.filter((e): e is FileEntry =>
    !!e && e.manifest.role === "user-space" && e.name !== FS_TREE,
  );

  // Auto-file: any user-space without a location gets "/<app>".
  const locations = { ...(get(state, "fs-tree.locations") as Record<string, string> | undefined ?? {}) };
  const folders = new Set(get(state, "fs-tree.folders") as string[] | undefined ?? []);
  let dirty = false;
  for (const f of userSpaces) {
    if (locations[f.name]) continue;
    const app = f.manifest.applications?.[0] ?? "unfiled";
    const folder = `/${app}`;
    locations[f.name] = folder;
    if (!folders.has(folder)) { folders.add(folder); }
    dirty = true;
  }
  if (dirty) {
    await set(state, "fs-tree.folders", [...folders]);
    await set(state, "fs-tree.locations", locations);
    await saveFsTree(state);
  }
  await set(state, "file-explorer.items", userSpaces);
};

// ── navigation + folder ops (registered as fe.*) ────────────────────────────

export const cd = async (state: State, path: string): Promise<void> => {
  await set(state, "file-explorer.cwd", normalize(path));
};

export const up = async (state: State): Promise<void> => {
  const cwd = String(get(state, "file-explorer.cwd") ?? "/");
  await cd(state, parentOf(cwd));
};

/** mkdir under cwd. With a `name` payload tests skip the prompt. */
export const mkdir = async (state: State, namePayload?: string): Promise<string | undefined> => {
  const cwd = String(get(state, "file-explorer.cwd") ?? "/");
  const ask = (globalThis as { prompt?: (m: string, d?: string) => string | null }).prompt;
  const name = namePayload ?? ask?.("New folder name?", "untitled") ?? undefined;
  if (!name) return undefined;
  const clean = name.replace(/[/\\]/g, "").trim();
  if (!clean) return undefined;
  const path = normalize(`${cwd === "/" ? "" : cwd}/${clean}`);
  const folders = (get(state, "fs-tree.folders") as string[] | undefined) ?? [];
  if (folders.includes(path)) return path;
  await set(state, "fs-tree.folders", [...folders, path]);
  await saveFsTree(state);
  return path;
};

/** Move a file (by segment name) into folder `path`. */
export const move = async (state: State, name: string, path: string): Promise<void> => {
  if (!name || !path) return;
  const locations = { ...((get(state, "fs-tree.locations") as Record<string, string> | undefined) ?? {}) };
  locations[name] = normalize(path);
  await set(state, "fs-tree.locations", locations);
  await saveFsTree(state);
};

// ── drag-and-drop dispatchers ──────────────────────────────────────────────
// The kernel passes the native DomEvent as the 3rd arg; payload is whatever
// the dispatch site bound. We carry the segment name in dataTransfer as
// plain text so a folder drop handler can recover it.

export const dragstart = (_state: State, name: string, event: { dataTransfer?: { setData?: (k: string, v: string) => void; effectAllowed?: string } }): void => {
  if (!event?.dataTransfer) return;
  event.dataTransfer.setData?.("text/plain", String(name));
  event.dataTransfer.effectAllowed = "move";
};

export const dragover = (_state: State, _payload: unknown, event: { preventDefault?: () => void; dataTransfer?: { dropEffect?: string } }): void => {
  // preventDefault on dragover is the standard "I accept drops here" signal.
  event?.preventDefault?.();
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
};

export const drop = async (state: State, folderPath: string, event: { preventDefault?: () => void; dataTransfer?: { getData?: (k: string) => string } }): Promise<void> => {
  event?.preventDefault?.();
  const name = event?.dataTransfer?.getData?.("text/plain") ?? "";
  if (!name) return;
  await move(state, name, folderPath);
};

// ── open: existing behavior (loads + launches the app) ──────────────────────

export const open = async (state: State, name: string): Promise<void> => {
  const getOne = resolveFn(state as never, "store.get") as (n: string) => Promise<{ manifest: FileEntry["manifest"] } | undefined>;
  const got = await getOne(name);
  if (!got) return;
  const app = got.manifest.applications?.[0];
  if (!app) return;
  if (!(state as { segments: Map<string, unknown> }).segments.has(name)) {
    await callFn(state, "loadUserSpace", name);
  }
  await set(state, "os.doc", name);
  await callFn(state, "os.launch", app, name);
};

// ── rendering ───────────────────────────────────────────────────────────────

const esc = (s: string): string => String(s).replace(/[<>{}&"']/g, (c) => `&#${c.charCodeAt(0)};`);

const renderBreadcrumb = (cwd: string): string => {
  const cn = normalize(cwd);
  const segs = [`<button class="crumb" onClick={{(dispatch "fe.cd" "/")}}>📁 /</button>`];
  if (cn === "/") return segs[0]!;
  const parts = cn.split("/").filter(Boolean);
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    segs.push(`<button class="crumb" onClick={{(dispatch "fe.cd" "${esc(acc)}")}}>${esc(p)}</button>`);
  }
  return segs.join('<span class="sep">›</span>');
};

/** Render the body: an .. card if not at root, then folder cards (drop
 *  targets), then file cards (draggable). */
export const renderExplorerBody = (
  cwd: string | undefined,
  folders: string[] | undefined,
  locations: Record<string, string> | undefined,
  items: FileEntry[] | undefined,
): string => {
  const cn = normalize(cwd ?? "/");
  const allFolders = folders ?? [];
  const locs = locations ?? {};
  const allFiles = items ?? [];

  const subfolders = allFolders.filter((f) => isDirectChild(cn, f));
  const filesHere = allFiles.filter((f) => normalize(locs[f.name] ?? "/") === cn);

  let html = `<div class="explorer-grid">`;

  if (cn !== "/") {
    html += `<button class="card up" onClick={{(dispatch "fe.up")}}>📁 ..</button>`;
  }
  for (const folder of subfolders) {
    const display = esc(childName(folder));
    html += `<button class="card folder" `
         + `onClick={{(dispatch "fe.cd" "${esc(folder)}")}} `
         + `onDragOver={{(dispatch "fe.dragover")}} `
         + `onDrop={{(dispatch "fe.drop" "${esc(folder)}")}}>📁 ${display}</button>`;
  }
  for (const f of filesHere) {
    const app = esc(f.manifest.applications?.[0] ?? "unfiled");
    html += `<div class="card file" draggable="true" `
         + `onDragStart={{(dispatch "fe.dragstart" "${esc(f.name)}")}} `
         + `onClick={{(dispatch "fe.open" "${esc(f.name)}")}}>`
         + `📄 ${esc(f.name)}<small>${app}</small></div>`;
  }
  if (subfolders.length === 0 && filesHere.length === 0 && cn === "/") {
    html += `<p class="empty">Empty. Open Notepad or Sheets and use Save to create a file.</p>`;
  }

  return html + `</div>`;
};

// ── app segment + setup ─────────────────────────────────────────────────────

const TEMPLATE = `
<div class="fe">
  <div class="toolbar">
    <button class="close" onClick={{(dispatch "os.exit")}}>×</button>
    <span class="title">File Explorer</span>
    <span class="breadcrumb-host">{{(renderBreadcrumb cwd)}}</span>
    <button class="mkdir" onClick={{(dispatch "fe.mkdir")}}>+ Folder</button>
  </div>
  {{(renderExplorerBody cwd folders locations items)}}
</div>`;

/** Lookup the app ids that should get default folders at first-boot
 *  bootstrap. Reads os.apps so the seed naturally tracks the icon roster. */
const knownApps = (state: State): string[] => {
  const apps = (get(state, "os.apps") as Array<{ id?: string; application?: string }> | undefined) ?? [];
  const out: string[] = [];
  for (const a of apps) {
    const id = a.application ?? a.id;
    if (id && id !== "file-explorer") out.push(`/${id}`);
  }
  return out;
};

export const setupFileExplorer = async (state: State): Promise<void> => {
  const reg = resolveFn(state as never, "registerLambda") as (s: unknown, a: unknown) => Promise<unknown>;
  await reg(state, { key: "renderBreadcrumb",  fn: renderBreadcrumb,  kind: "custom" });
  await reg(state, { key: "renderExplorerBody", fn: renderExplorerBody, kind: "custom" });
  await reg(state, { key: "fe.refresh",   fn: refresh,   kind: "custom" });
  await reg(state, { key: "fe.open",      fn: open,      kind: "custom" });
  await reg(state, { key: "fe.cd",        fn: cd,        kind: "custom" });
  await reg(state, { key: "fe.up",        fn: up,        kind: "custom" });
  await reg(state, { key: "fe.mkdir",     fn: mkdir,     kind: "custom" });
  await reg(state, { key: "fe.move",      fn: move,      kind: "custom" });
  await reg(state, { key: "fe.dragstart", fn: dragstart, kind: "custom" });
  await reg(state, { key: "fe.dragover",  fn: dragover,  kind: "custom" });
  await reg(state, { key: "fe.drop",      fn: drop,      kind: "custom" });
  await reg(state, { key: "if", fn: (c: unknown, a: unknown, b: unknown) => (c ? a : b), kind: "custom" });
  await reg(state, { key: "eq", fn: (a: unknown, b: unknown) => a === b, kind: "custom" });

  const seg = {
    name: "file-explorer", version: "0.2.0",
    dependencies: ["app-host", "html-template-parser", "plastron-dom", "segment-store", "user-space-ops"],
    role: "application",
    cels: [
      // Placeholder fs-tree cels — initial empty defaults, retargeted to the
      // fs-tree segment on first boot or replaced by hydrate on load.
      { key: "fs-tree.folders",   celType: "ValueCel", metadata: { key: "fs-tree.folders",   segment: "file-explorer" }, v: [] },
      { key: "fs-tree.locations", celType: "ValueCel", metadata: { key: "fs-tree.locations", segment: "file-explorer" }, v: {} },
      { key: "file-explorer.items", celType: "ValueCel", metadata: { key: "file-explorer.items", segment: "file-explorer" }, v: [] },
      { key: "file-explorer.cwd",   celType: "ValueCel", metadata: { key: "file-explorer.cwd",   segment: "file-explorer" }, v: "/" },
      {
        key: "file-explorer.mount", celType: "FormulaCel",
        metadata: { key: "file-explorer.mount", segment: "file-explorer", parser: "f", inputMap: { active: "os.active" } },
        f: `(if (eq active "file-explorer") "#app" null)`,
      },
      {
        key: "file-explorer.view", celType: "FormulaCel",
        metadata: {
          key: "file-explorer.view", segment: "file-explorer", parser: "html-template", schema: "render-spec",
          channel: ["plastron-dom.paint"],
          inputMap: {
            mount: "file-explorer.mount",
            items: "file-explorer.items",
            cwd: "file-explorer.cwd",
            folders: "fs-tree.folders",
            locations: "fs-tree.locations",
          },
        },
        f: TEMPLATE,
      },
    ],
  };
  await callFn(state, "hydrate", [seg], [{ name: seg.name, version: seg.version, dependencies: seg.dependencies, role: "application" }]);

  // Seed + load fs-tree, then run a refresh so the current store is reflected.
  await ensureFsTree(state, knownApps(state));
  await refresh(state);
};
