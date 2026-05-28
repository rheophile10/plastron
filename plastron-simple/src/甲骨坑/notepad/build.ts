import type { DehydratedCel, Fn, Key, State, 甲骨 } from "../../types/index.js";
import { resolveFn } from "../../kernel/resolve-fn.js";

// ============================================================================
// notepad — the simplest non-spreadsheet application: a <textarea> bound to a
// text cel, rendered through html-template + plastron-dom. A clean
// demonstration that "an application is just cels + a view".
//
// buildNotepad generates the application segment (pure data: the text/mount/
// path/binding ValueCels + the view FormulaCel) the host hydrates — the same
// factory shape as buildSheet. Editing needs ZERO custom code: the textarea's
// onInput routes through the shipped `{ set, extract }` event binding, which
// reads event.target.value and `set`s the text cel directly. Only persistence
// needs native fns, and those are host-injected at runtime by
// installNotepadActions (registerLambda) rather than bundled into the boot —
// matching the host-capability model (the `host` segment, the painter).
//
// The cel keys are fixed ("notepad.text", …) regardless of the segment name,
// exactly like sheet's fixed "sheet.<addr>" keys: one note is active at a
// time. See docs/4-current/05-runCycle/08-notepad-app.md.
// ============================================================================

export interface BuildNotepadOpts {
  /** Initial note text (default ""). */
  text?: string;
  /** Mount selector the painter paints into (default "#notepad"). */
  mount?: string;
  /** File-store path save/load read & write (default "notepad.txt"). */
  path?: string;
  /** Segment name to tag the generated cels with (default "notepad"). */
  segment?: string;
}

// The view: a toolbar (Save / Load dispatch the host-registered fs actions)
// over a textarea whose value mirrors the text cel and whose input writes it
// back. `{{text}}` / `{{binding}}` are value slots (auto-wired deps); the
// `(dispatch …)` event slots are captured verbatim and resolved at click.
const NOTEPAD_VIEW = `<div class="notepad" id="notepad">
  <div class="notepad-toolbar">
    <button class="notepad-save" onClick={{(dispatch notepad.save)}}>Save</button>
    <button class="notepad-load" onClick={{(dispatch notepad.load)}}>Load</button>
  </div>
  <textarea class="notepad-text" rows="20" value={{text}} onInput={{binding}}></textarea>
</div>`;

const value = (key: Key, segment: string, v: unknown): DehydratedCel =>
  ({ key, celType: "ValueCel", metadata: { key, segment }, v } as unknown as DehydratedCel);

/** Build the notepad application segment: the text cel + the view that renders
 *  and writes it. Pure data (no `_fn`), so the host hydrates it directly. */
export const buildNotepad = (
  opts: BuildNotepadOpts = {},
): 甲骨 & { version: string; role: "application"; dependencies: Key[] } => {
  const segment = opts.segment ?? "notepad";
  const cels: DehydratedCel[] = [
    value("notepad.text", segment, opts.text ?? ""),
    value("notepad.mount", segment, opts.mount ?? "#notepad"),
    value("notepad.path", segment, opts.path ?? "notepad.txt"),
    // The controlled-input affordance: a plastron-dom event binding read as a
    // value in the onInput slot. `set` + `extract:"value"` makes the painter
    // write event.target.value straight into notepad.text — no action fn.
    value("notepad.input-binding", segment, { set: "notepad.text", extract: "value" }),
    {
      key: "notepad.view",
      celType: "FormulaCel",
      metadata: {
        key: "notepad.view",
        segment,
        parser: "html-template",
        schema: "render-spec",
        channel: ["plastron-dom.paint"],
        inputMap: {
          text: "notepad.text",
          mount: "notepad.mount",
          binding: "notepad.input-binding",
        },
      },
      f: NOTEPAD_VIEW,
    },
  ];
  return {
    name: segment,
    version: "0.0.1",
    role: "application",
    dependencies: ["html-template-parser", "plastron-dom"],
    cels,
  };
};

// ── runtime persistence actions ─────────────────────────────────────────────
//
// Save/load are async fs round-trips, so they can't be value formulas (no
// await). They're registered as locked native dispatch cels the Save/Load
// buttons reach via `(dispatch notepad.save)`. Installed at runtime against
// the live file-store rather than bundled, keeping the app segment pure data.

const noteText = (state: State): string => (state.cels.get("notepad.text")?.v as string) ?? "";
const notePath = (state: State): string => (state.cels.get("notepad.path")?.v as string) ?? "notepad.txt";

/** Register notepad.save / notepad.load against the live file-store. Idempotent
 *  re-registration is fine (the cels are locked but unchanged in behavior). */
export const installNotepadActions = async (
  state: State, opts: { segment?: string } = {},
): Promise<State> => {
  const register = resolveFn(state, "registerLambda")!;
  const segment = opts.segment ?? "notepad";

  const save: Fn = async (st: State) => {
    const writeText = resolveFn(st, "fs.writeText");
    if (writeText) await writeText(notePath(st), noteText(st));
    return st;
  };

  const load: Fn = async (st: State) => {
    const readText = resolveFn(st, "fs.readText");
    const exists = resolveFn(st, "fs.exists");
    const set = resolveFn(st, "set");
    if (!readText || !set) return st;
    const path = notePath(st);
    // Loading a note that was never saved is a no-op, not an error.
    if (exists && !(await exists(path))) return st;
    await set(st, "notepad.text", await readText(path));
    return st;
  };

  await register(state, { key: "notepad.save", segment, kind: "native", locked: true, fn: save });
  await register(state, { key: "notepad.load", segment, kind: "native", locked: true, fn: load });
  return state;
};
