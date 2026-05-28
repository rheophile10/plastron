import { useEffect, useMemo, useState } from "react";
import {
  createInitialState, type Fn, type Segment, type State,
} from "../../../plastron/src/index.js";
import {
  installDomSchemas, VNODE_SCHEMA_KEY,
  el, text, inputBind, type VNode,
} from "../../../segments/plastron-dom/src/index.js";
import { PlastronHost } from "../../../adapters/plastron-react-host/src/PlastronHost.js";
import type { Content, ContentDraft } from "./api/types.js";

// ============================================================================
// <PlastronCMS> — the headline component.
//
// Surface unchanged:
//   editMode  — true: editor UI; false: rendered view
//   content   — full Content row from the API
//   onSave    — called with a ContentDraft on explicit save
//
// What's inside (post-migration):
//   - One plastron State per content row, hydrated from `content.blocks`.
//   - Body editor + rendered view are painted by plastron-dom through
//     <PlastronHost>. This is the "graft plastron-dom into a React
//     parent" pathway: React owns the surrounding chrome (title, desc,
//     save button); plastron paints the body region.
//   - Title and description ride React useState. They're scalar form
//     fields with no downstream graph consumers — reactivity buys
//     nothing, so they stay in the React chrome (DESIGN.md "First
//     design rule").
//
// Cels:
//   • body     — value cel (string). Lives in the "content" segment so
//                dehydrate round-trips it as part of Content.blocks.
//   • editMode — value cel (boolean). Mirrors the React prop via the
//                useEffect below; the lambda branches on it.
//   • bodyTree — vnode lambda cel. In edit mode emits a controlled
//                <textarea> wired via inputBind("body", body); in view
//                mode emits a paragraph render of the body string.
//
// editMode + bodyTree live in a "view" segment so they're filtered out
// of the persisted draft (we ship only the "content" segment).
//
// Deliberately uses no plastron-archive code — the in-DB form of a
// content row is JSONB-shaped (plain Segment[] JSON), not zipped.
// ============================================================================

interface Props {
  editMode: boolean;
  content: Content;
  onSave: (draft: ContentDraft) => void | Promise<void>;
}

const CONTENT_SEGMENT_KEY = "content";
const VIEW_SEGMENT_KEY = "view";

// Render lambda — the body region's vnode tree. Pure function of
// (body, editMode). The painter routes input events back to the body
// cel through inputBind, closing the loop without a custom dispatcher.
const renderBody: Fn = (
  { body, editMode }: { body: string; editMode: boolean },
): VNode =>
  editMode
    ? el("div", { class: "plastron-cms__field" },
        el("label", null,
          text("Body"),
          el("textarea", { rows: 16, ...inputBind("body", body) }),
        ),
      )
    : el("div", { class: "plastron-cms__body" },
        ...body.split(/\n\n+/).map((para) =>
          el("p", null, text(para))),
      );

const buildViewSegment = (initialEditMode: boolean): Segment => ({
  key: VIEW_SEGMENT_KEY,
  cels: [
    { key: "editMode", v: initialEditMode, segment: VIEW_SEGMENT_KEY },
    {
      key: "bodyTree",
      segment: VIEW_SEGMENT_KEY,
      l: "renderBody",
      inputMap: { body: "body", editMode: "editMode" },
      schema: VNODE_SCHEMA_KEY,
    },
  ],
  fnMetaData: {
    renderBody: {
      key: "renderBody",
      arity: 1,
      source: renderBody.toString(),
    },
  },
});

const buildState = (content: Content, initialEditMode: boolean): State => {
  const state = createInitialState();
  // Register vnodeSchema + its isChanged/diff fns BEFORE hydrate so
  // auto-wire materializes _isChanged / _diffFn on bodyTree at hydrate
  // time. PlastronHost.installDom would re-register idempotently later,
  // but by then the cel is already inflated without the schema wiring.
  installDomSchemas(state);

  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  hydrate(
    state,
    [...content.blocks, buildViewSegment(initialEditMode)],
    [new Map([["renderBody", renderBody]])],
  );
  // Prime the cascade so bodyTree has a value before PlastronHost
  // mounts — the host drains once on mount, but the patch cel needs a
  // tree value to diff against.
  void runCycle(state);
  return state;
};

export const PlastronCMS = ({ editMode, content, onSave }: Props): React.ReactElement => {
  // Rebuild the plastron State whenever the content id changes — fresh
  // graph per row. PlastronHost's effect re-attaches on `state` change,
  // so swapping is safe.
  const state = useMemo(
    () => buildState(content, editMode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content.id],
  );

  // Scalar columns ride React state. They're displayed in the editor
  // chrome (title/description fields) and bundled into onSave's draft.
  const [title, setTitle] = useState(content.title);
  const [description, setDescription] = useState(content.description ?? "");
  const [saving, setSaving] = useState(false);

  // Resync scalar fields when the underlying content changes (route
  // change, save round-trip, etc.).
  useEffect(() => {
    setTitle(content.title);
    setDescription(content.description ?? "");
  }, [content.id, content.title, content.description]);

  // Mirror the editMode prop into the cel so the bodyTree lambda
  // re-fires and the painted region swaps shape. On the first render
  // the cel already has the right value (set during buildState); this
  // effect handles subsequent prop flips without rebuilding state.
  useEffect(() => {
    const set = state.fns.get("set") as Fn;
    void set(state, "editMode", editMode);
  }, [state, editMode]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      const dehydrate = state.fns.get("dehydrate") as Fn;
      const segments = dehydrate(state) as Content["blocks"];
      // Persist only the content segment — view/editMode are UI state,
      // not part of the row. dehydrate filters core/stats already.
      const userSegments = segments.filter((s) => s.key === CONTENT_SEGMENT_KEY);
      const draft: ContentDraft = {
        title,
        slug: content.slug,
        description: description.trim() === "" ? null : description,
        blocks: userSegments,
        css: content.css,
      };
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`plastron-cms plastron-cms--${editMode ? "edit" : "view"}`}>
      {editMode ? (
        <>
          <div className="plastron-cms__field">
            <label>
              Title
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
            </label>
          </div>
          <div className="plastron-cms__field">
            <label>
              Description
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
              />
            </label>
          </div>
        </>
      ) : (
        <>
          <h1>{title}</h1>
          {description.trim() !== "" && (
            <p className="plastron-cms__description">{description}</p>
          )}
        </>
      )}
      <PlastronHost state={state} cel="bodyTree" />
      {editMode && (
        <div className="plastron-cms__actions">
          <button type="button" onClick={() => { void handleSave(); }} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
};
