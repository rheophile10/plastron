# plastron-cms

Example CMS app demonstrating the full plastron segment composition.
Articles are zipped plastron States stored in SQLite (browser OPFS or
in-memory). The same content cels render as either web pages
(plastron-dom) or email newsletters (plastron-mjml in an iframe).

## What it shows

- **Articles are plastron States.** Each one is a small graph: content
  cels (title, body), plus a `view` cel running a render lambda. The
  whole State is what's stored, not a baked HTML output.
- **Page vs newsletter is a render lambda choice.** Same content cels
  → different lambda → different output. Editor toggle by article type.
- **The editor surfaces cels directly.** No separate WYSIWYG layer.
  v1 ships a minimal cel grid; promoting to the full plastron-sheet
  is a v2 task.
- **Composition.** plastron-sqlite (storage) + plastron-archive (zip
  format) + plastron-dom (page preview channel) + mjml-browser
  (newsletter compile) + React (chrome) — five+ independent layers
  working together.

## Architecture

```
React shell  (sidebar, route, toolbar, panes)
  │
  ├── SQLite (OPFS via @sqlite.org/sqlite-wasm)
  │     • plastron_archives table (managed by plastron-sqlite)
  │     • articles table (id, slug, title, type, archive blob)
  │     • _plastron_migrations meta
  │
  └── Per-open-article plastron State
        • Loaded by importArchive(blob) from SQLite
        • CelEditor reads/writes content cels
        • DOM channel mounted into preview <div> (page mode)
        • or NewsletterPreview reads view cel + mjml-browser → iframe
```

Routes (hash-based):

- `#/` — list view
- `#/new?type=page` — blank page editor
- `#/new?type=newsletter` — blank newsletter editor
- `#/edit/<id>` — load + edit existing article

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5174 in a modern browser (Chromium / Firefox /
Safari with OPFS support).

## Production build

```sh
npm run build
```

## Known limitations (v1)

- **xit-wasm browser compat.** plastron-archive uses xit-wasm under
  the hood, which currently imports `node:fs/promises`. Vite
  externalizes Node modules for browser → archive save/load will
  surface runtime errors when actually invoked. The app builds and
  the React/SQLite/preview surface works; the archive serialization
  layer needs xit-wasm to ship a browser-clean build (or this app
  needs a fallback codec for browsers). Fixable upstream; not in
  scope for this example.
- **No autosave.** Explicit Save button.
- **No users / auth.** Single-user local app.
- **No real-time collab.** Plastron isn't a CRDT.
- **No media library.** Image cels would store raw bytes (or
  idb-blob handles via plastron-idb); the editor doesn't expose
  upload UI yet.
- **CelEditor is minimal.** Lists each cel with an editable input
  for value cels, read-only display for computed/formula cels. The
  full plastron-sheet UI (grid, formula bar, copy/paste) would need
  adapter code to map article cel keys onto sheet addresses.
- **Newsletter render lambda is hand-written.** Authors can't edit
  the MJML template from the editor (that requires letting users
  edit `cel.f`/`cel.l`, which is a bigger product step).
- **No export / import `.甲` files.** plastron-browser-file-io is
  in master and would integrate easily, but the xit-wasm constraint
  above gates the format work.

## Where to take it next

- Wire `plastron-browser-file-io` for `.甲` export/import once the
  xit-wasm browser path lands.
- Promote the inline render lambdas into editable cels using the
  formula compiler (`l: "f"`, `f: "<S-expression>"`) so authors can
  modify rendering rules from the sheet.
- Build `plastron-blocks` segment with reusable block templates;
  current article boilerplates are inline placeholders.
- Replace `setInterval`-driven NewsletterPreview refresh with a
  proper channel subscription so re-renders happen exactly when
  the view cel changes.
- Multi-user / hosted deployment requires sandboxing user-authored
  lambdas — non-trivial.
