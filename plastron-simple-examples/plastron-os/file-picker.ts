// ============================================================================
// file-picker.ts — modal Open dialog shared by Notepad + Sheets (and any
// future app that uses the file toolbar).
//
// Renders into #modal (a separate top-level mount target in index.html); CSS
// hides it when `picker.app` is null and overlays it on top of the active
// app's view when an app is set. The picker reuses the same fs-tree data
// (folders + locations) as File Explorer, scoped to the requesting app — so
// Notepad's Open shows notepad docs only, Sheets' shows sheet docs only.
//
// Wiring:
//   file-toolbar's Open button dispatches `file.pick`, which records the
//   active app on `picker.app` and resets `picker.cwd` to `/<app>`. The
//   modal's file cards dispatch `picker.select` which routes through
//   `file.open(name)` and clears `picker.app`. The backdrop and × dispatch
//   `picker.cancel`.
// ============================================================================

import { resolveFn } from "../../plastron-simple/dist/index.js";

type State = unknown;
const get = (state: State, k: string): unknown =>
  (resolveFn(state as never, "get") as (...a: unknown[]) => unknown)(state as never, k);
const set = async (state: State, k: string, v: unknown): Promise<void> => {
  await (resolveFn(state as never, "set") as (...a: unknown[]) => Promise<unknown>)(state as never, k, v, { flush: "all" });
};
const callFn = async (state: State, k: string, ...args: unknown[]): Promise<unknown> =>
  await (resolveFn(state as never, k) as (...a: unknown[]) => Promise<unknown>)(state as never, ...args);

// ── path helpers (mirrors file-explorer's; small enough to dup) ─────────────

const normalize = (p: string): string => {
  const parts = String(p).split("/").filter(Boolean);
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

const esc = (s: string): string => String(s).replace(/[<>{}&"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface FileEntry { name: string; manifest: { role?: string; applications?: string[]; version?: string } }

// ── current-app probe (matches file-toolbar's) ──────────────────────────────

const currentApp = (state: State): string | undefined => {
  const active = get(state, "os.active") as string | undefined;
  if (!active || active === "home") return undefined;
  const apps = (get(state, "os.apps") as Array<{ id: string; application?: string }> | undefined) ?? [];
  return apps.find((a) => a.id === active)?.application ?? active;
};

// ── dispatch helpers (registered as file.pick / picker.* / picker.select) ───

/** Open the picker for the active app. Initialises picker.cwd to /<app>
 *  so the user lands on their app's bucket. */
export const filePick = async (state: State): Promise<void> => {
  const app = currentApp(state);
  if (!app) return;
  await callFn(state, "fe.refresh");                 // make sure the listing is fresh
  await set(state, "picker.cwd", `/${app}`);
  await set(state, "picker.app", app);
};

export const pickerCd = async (state: State, path: string): Promise<void> => {
  await set(state, "picker.cwd", normalize(path));
};

export const pickerUp = async (state: State): Promise<void> => {
  const cwd = String(get(state, "picker.cwd") ?? "/");
  await pickerCd(state, parentOf(cwd));
};

/** Select a file: call file.open (which loads + os.launches the app), then close. */
export const pickerSelect = async (state: State, name: string): Promise<void> => {
  if (!name) return;
  await callFn(state, "file.open", name);
  await set(state, "picker.app", null);
};

export const pickerCancel = async (state: State): Promise<void> => {
  await set(state, "picker.app", null);
};

// ── render helpers ──────────────────────────────────────────────────────────

const renderPickerBreadcrumb = (cwd: string): string => {
  const cn = normalize(cwd);
  const segs = [`<button class="crumb" onClick={{(dispatch "picker.cd" "/")}}>📁 /</button>`];
  if (cn === "/") return segs[0]!;
  const parts = cn.split("/").filter(Boolean);
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    segs.push(`<button class="crumb" onClick={{(dispatch "picker.cd" "${esc(acc)}")}}>${esc(p)}</button>`);
  }
  return segs.join('<span class="sep">›</span>');
};

interface AppType { key: string; title: string; extension: string; icon: string }

/** Render the modal body — the folder + file grid scoped to `app`. */
export const renderPickerBody = (
  app: string | null | undefined,
  cwd: string | undefined,
  folders: string[] | undefined,
  locations: Record<string, string> | undefined,
  items: FileEntry[] | undefined,
  appTypes: Record<string, AppType> | undefined,
): string => {
  // Closed state — empty placeholder; CSS hides the wrapper via [data-open=false].
  if (!app) return `<div class="picker-empty"></div>`;

  const cn = normalize(cwd ?? "/");
  const allFolders = folders ?? [];
  const locs = locations ?? {};
  const allItems = items ?? [];
  const fileIcon = appTypes?.[app]?.icon ?? "📄";
  const appTitle = appTypes?.[app]?.title ?? app;

  // App-scoped: only show files whose manifest.applications includes `app`.
  // Folders aren't app-scoped (a user can drop any file anywhere); we still
  // show them all so navigation matches what they see in File Explorer.
  const subfolders = allFolders.filter((f) => isDirectChild(cn, f));
  const filesHere = allItems.filter(
    (f) =>
      (f.manifest.applications ?? []).includes(app) &&
      normalize(locs[f.name] ?? "/") === cn,
  );

  let body = `<div class="picker-grid">`;
  if (cn !== "/") body += `<button class="card up" onClick={{(dispatch "picker.up")}}>📁 ..</button>`;
  for (const folder of subfolders) {
    body += `<button class="card folder" onClick={{(dispatch "picker.cd" "${esc(folder)}")}}>📁 ${esc(childName(folder))}</button>`;
  }
  for (const f of filesHere) {
    body += `<button class="card file" onClick={{(dispatch "picker.select" "${esc(f.name)}")}}>${esc(fileIcon)} ${esc(f.name)}</button>`;
  }
  if (subfolders.length === 0 && filesHere.length === 0) {
    body += `<p class="empty">No ${esc(appTitle)} files here. Click 📁 / to start at the root.</p>`;
  }
  body += `</div>`;

  return `
    <div class="picker-backdrop" onClick={{(dispatch "picker.cancel")}}></div>
    <div class="picker-panel" onClick={{(dispatch "picker.swallow")}}>
      <div class="picker-bar">
        <span class="picker-title">Open in ${esc(appTitle)}</span>
        <span class="breadcrumb-host">${renderPickerBreadcrumb(cn)}</span>
        <button class="picker-x" onClick={{(dispatch "picker.cancel")}}>×</button>
      </div>
      ${body}
    </div>`;
};

// ── setup ───────────────────────────────────────────────────────────────────

const TEMPLATE = `
<div class="picker-root" data-open="{{(boolStr app)}}">
  {{(renderPickerBody app cwd folders locations items appTypes)}}
</div>`;

export const setupFilePicker = async (state: State): Promise<void> => {
  const reg = resolveFn(state as never, "registerLambda") as (s: unknown, a: unknown) => Promise<unknown>;
  await reg(state, { key: "renderPickerBody", fn: renderPickerBody, kind: "custom" });
  await reg(state, { key: "renderPickerBreadcrumb", fn: renderPickerBreadcrumb, kind: "custom" });
  // String form of "is the picker open?" — used as a data attribute so CSS
  // can switch display:none on/off without us hand-managing a class.
  await reg(state, { key: "boolStr", fn: (v: unknown) => (v ? "true" : "false"), kind: "custom" });
  // Swallows click events on the panel so a click inside doesn't bubble up
  // to the backdrop's cancel handler.
  await reg(state, {
    key: "picker.swallow", kind: "custom",
    fn: (_state: unknown, _payload: unknown, event: { stopPropagation?: () => void }) => {
      event?.stopPropagation?.();
    },
  });
  await reg(state, { key: "file.pick",      fn: filePick,      kind: "custom" });
  await reg(state, { key: "picker.cd",      fn: pickerCd,      kind: "custom" });
  await reg(state, { key: "picker.up",      fn: pickerUp,      kind: "custom" });
  await reg(state, { key: "picker.select",  fn: pickerSelect,  kind: "custom" });
  await reg(state, { key: "picker.cancel",  fn: pickerCancel,  kind: "custom" });

  // Role: library. No static dep on file-explorer — the picker only READS
  // fs-tree.* and file-explorer.items at runtime (via inputMap), so as long
  // as setupFileExplorer ran first in bootOS those cels are there. A static
  // dep on the app would violate the kernel's "library < application"
  // layering rule.
  const seg = {
    name: "file-picker", version: "0.1.0",
    dependencies: ["app-host", "html-template-parser", "plastron-dom"],
    role: "library",
    cels: [
      { key: "picker.app", celType: "ValueCel", metadata: { key: "picker.app", segment: "file-picker" }, v: null },
      { key: "picker.cwd", celType: "ValueCel", metadata: { key: "picker.cwd", segment: "file-picker" }, v: "/" },
      // Always mounted to #modal — the inner data-open attribute drives
      // visibility, so opening / closing doesn't depend on remounting.
      { key: "picker.mount", celType: "ValueCel", metadata: { key: "picker.mount", segment: "file-picker" }, v: "#modal" },
      {
        key: "picker.view", celType: "FormulaCel",
        metadata: {
          key: "picker.view", segment: "file-picker", parser: "html-template", schema: "render-spec",
          channel: ["plastron-dom.paint"],
          inputMap: {
            mount: "picker.mount",
            app: "picker.app",
            cwd: "picker.cwd",
            folders: "fs-tree.folders",
            locations: "fs-tree.locations",
            items: "file-explorer.items",
            appTypes: "fe.app-types",
          },
        },
        f: TEMPLATE,
      },
    ],
  };
  await callFn(state, "hydrate", [seg], [{ name: seg.name, version: seg.version, dependencies: seg.dependencies, role: "library" }]);
};
