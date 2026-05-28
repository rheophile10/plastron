// ============================================================================
// plastron-OS desktop — the home-screen application, composed entirely on
// shipped segments: app-host (launcher mechanism) + html-template-parser +
// plastron-dom + event-registries. No new kernel work.
//
// Per-view mount gating: every view's `mount` is a formula
// `(if (eq active "<id>") root null)`, so only the view whose id matches
// os.active paints into #app — the painter handles the rest (a null mount is
// a no-op). The home screen is just another view, gated on "home".
// ============================================================================

import { resolveFn } from "../../plastron-simple/dist/index.js";

export interface DesktopApp {
  id: string;
  title?: string;
  icon?: string;
  /** Optional inline view template for a *stub* app (demos/tests). A real
   *  app omits this and supplies its own gated view (e.g. sheet.view). */
  html?: string;
  /** The application segment name backing this icon. Defaults to `id`
   *  (works for our convention where the icon id matches the segment
   *  name: "notepad" → "notepad" segment). Used by file.* helpers to
   *  resolve which app the current view belongs to. */
  application?: string;
}

/** Build the icon-grid HTML (template syntax — the home view fragment-inlines
 *  it, so the onClick interpolations become real event bindings). Each icon
 *  dispatches os.switch (dispatch-safe: ignores the event arg). */
export const renderIcons = (apps: DesktopApp[] | undefined): string =>
  (apps ?? [])
    .map((a) =>
      `<button class="icon" onClick={{(dispatch "os.switch" "${a.id}")}}>` +
      `${a.icon ?? "▢"} ${a.title ?? a.id}</button>`,
    )
    .join("\n");

/** Register the small view-stdlib the desktop templates use. */
export const registerDesktopHelpers = async (state: unknown): Promise<void> => {
  const reg = resolveFn(state as never, "registerLambda") as (s: unknown, a: unknown) => Promise<unknown>;
  await reg(state, { key: "if", fn: (c: unknown, a: unknown, b: unknown) => (c ? a : b), kind: "custom" });
  await reg(state, { key: "eq", fn: (a: unknown, b: unknown) => a === b, kind: "custom" });
  await reg(state, { key: "renderIcons", fn: renderIcons, kind: "custom" });
};

const mountGate = (id: string) => ({
  key: `${id}.mount`,
  celType: "FormulaCel" as const,
  metadata: { key: `${id}.mount`, segment: "desktop", parser: "f", inputMap: { active: "os.active", root: "os.root" } },
  f: `(if (eq active "${id}") root null)`,
});

const viewCel = (id: string, f: string) => ({
  key: `${id}.view`,
  celType: "FormulaCel" as const,
  metadata: {
    key: `${id}.view`, segment: "desktop", parser: "html-template", schema: "render-spec",
    channel: ["plastron-dom.paint"], inputMap: { mount: `${id}.mount` },
  },
  f,
});

/** The desktop segment: the mount target, the home view (icon grid), and a
 *  gated view per app. Hydrate it after registering the helpers, then
 *  register the apps with app-host so the home grid lists them. */
export const desktopSegment = (apps: DesktopApp[]) => {
  const cels: unknown[] = [
    { key: "os.root", celType: "ValueCel", metadata: { key: "os.root", segment: "desktop" }, v: "#app" },
    mountGate("home"),
    {
      ...viewCel("home", `<div class="home"><h1>plastron OS</h1><div class="icons">{{(renderIcons apps)}}</div></div>`),
      metadata: {
        key: "home.view", segment: "desktop", parser: "html-template", schema: "render-spec",
        channel: ["plastron-dom.paint"], inputMap: { mount: "home.mount", apps: "os.apps" },
      },
    },
  ];
  // Only apps that carry inline `html` get a desktop-owned stub view+gate
  // (handy for demos/tests). A "real" app (no html) supplies its own gated
  // view (e.g. buildSheetsApp's sheet.view) — generating a stub here too
  // would fight it for the #app mount.
  for (const a of apps) {
    if (!a.html) continue;
    cels.push(mountGate(a.id));
    cels.push(viewCel(a.id, a.html));
  }
  return {
    name: "desktop", version: "0.1.0",
    dependencies: ["app-host", "html-template-parser", "plastron-dom"], role: "application",
    cels,
  };
};

/** Convenience: register helpers, hydrate the desktop, and register the apps
 *  with app-host (so os.apps drives the icon grid). */
export const setupDesktop = async (state: unknown, apps: DesktopApp[]): Promise<void> => {
  await registerDesktopHelpers(state);
  const seg = desktopSegment(apps);
  const hydrate = resolveFn(state as never, "hydrate") as (s: unknown, segs: unknown, m: unknown) => Promise<unknown>;
  await hydrate(state, [seg], [{ name: "desktop", version: "0.1.0", dependencies: ["app-host", "html-template-parser", "plastron-dom"], role: "application" }]);
  const register = resolveFn(state as never, "os.register-app") as (s: unknown, a: unknown) => Promise<unknown>;
  for (const a of apps) await register(state, { id: a.id, title: a.title, icon: a.icon, application: a.application ?? a.id });
};
