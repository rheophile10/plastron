import { useEffect, useMemo, useState } from "react";
import {
  createInitialState, type Fn, type State,
} from "../../../plastron/src/index.js";
import type { Content, ContentDraft } from "./api/types.js";

// ============================================================================
// <PlastronCMS> — the headline component.
//
// Surface:
//   editMode  — true: editor UI; false: rendered view
//   content   — full Content row from the API
//   onSave    — called with a ContentDraft on explicit save
//
// What's inside:
//   - One plastron State, hydrated from `content.blocks` on mount /
//     content-id change.
//   - Title and description live as plain React state (they're
//     scalar columns on the row, not cel values).
//   - The body cel lives in the plastron State, mutated via state.fns
//     get/set. Reactive: a future formula cel could derive its value
//     and we'd render the derived result with no UI changes.
//   - Save: dehydrate the State → segments, bundle with the React-side
//     scalar edits, fire onSave.
//
// Deliberately uses no plastron-archive code — the in-DB form of a
// content row is JSONB-shaped (plain Segment[] JSON), not zipped.
// plastron-archive is for "export to file" workflows we haven't built
// here.
// ============================================================================

interface Props {
  editMode: boolean;
  content: Content;
  onSave: (draft: ContentDraft) => void | Promise<void>;
}

const BODY_CEL_KEY = "body";
const CONTENT_SEGMENT_KEY = "content";

const buildState = (content: Content): State => {
  const state = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  // No custom fns to install yet — the body cel is a plain value cel.
  // When we grow formula support, the segment's fnMetaData will declare
  // the lambdas and we'll pass implementations here.
  hydrate(state, content.blocks, []);
  return state;
};

export const PlastronCMS = ({ editMode, content, onSave }: Props): React.ReactElement => {
  // Rebuild the plastron State whenever the content id changes — fresh
  // graph per row. Reusing the previous State across navigation would
  // require explicit flush/re-hydrate; cleaner to start fresh.
  const state = useMemo(() => buildState(content), [content.id]);

  // Scalar columns ride React state. They're displayed in the editor
  // chrome (title/description fields) and bundled into onSave's draft.
  const [title, setTitle] = useState(content.title);
  const [description, setDescription] = useState(content.description ?? "");
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState(false);

  // Resync scalar fields when the underlying content changes (route
  // change, save round-trip, etc.).
  useEffect(() => {
    setTitle(content.title);
    setDescription(content.description ?? "");
  }, [content.id, content.title, content.description]);

  const readBody = (): string => {
    const get = state.fns.get("get") as Fn;
    const v = get(state, BODY_CEL_KEY);
    return typeof v === "string" ? v : "";
  };

  const writeBody = async (next: string): Promise<void> => {
    const set = state.fns.get("set") as Fn;
    await set(state, BODY_CEL_KEY, next);
    setTick((t) => t + 1);
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      const dehydrate = state.fns.get("dehydrate") as Fn;
      const segments = dehydrate(state) as Content["blocks"];
      // Only ship the content segment; dehydrate also emits the core
      // segment plus any config/stats cels, which the host shouldn't
      // see. Filter by key.
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

  // Force-use tick so React's lint doesn't strip it; the value matters
  // only as a re-render trigger for cel reads.
  void tick;

  if (editMode) {
    return (
      <div className="plastron-cms plastron-cms--edit">
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
        <div className="plastron-cms__field">
          <label>
            Body
            <textarea
              rows={16}
              value={readBody()}
              onChange={(e) => { void writeBody(e.currentTarget.value); }}
            />
          </label>
        </div>
        <div className="plastron-cms__actions">
          <button type="button" onClick={() => { void handleSave(); }} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <article className="plastron-cms plastron-cms--view">
      <h1>{title}</h1>
      {description.trim() !== "" && (
        <p className="plastron-cms__description">{description}</p>
      )}
      <div className="plastron-cms__body">
        {readBody()
          .split(/\n\n+/)
          .map((para, i) => (
            <p key={i}>{para}</p>
          ))}
      </div>
    </article>
  );
};
