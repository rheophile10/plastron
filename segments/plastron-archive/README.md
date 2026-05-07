# `plastron-archive`

Read and write plastron documents as `.甲` files — zip containers
holding pretty-printed JSON. Like `xlsx`, but the archive entries are
JSON instead of XML, so unzipping the file yields a directory you can
read, edit, and re-zip with any tool.

## File format

A `.甲` archive is a standard ZIP file with this layout:

```
oracle.甲
├── manifest.json
└── segments/
    ├── default.json
    ├── plastromancy.json
    └── 甲骨.json
```

`manifest.json` is the table of contents:

```json
{
  "version": 1,
  "format": "application/vnd.plastron.甲",
  "createdAt": "2026-05-07T00:00:00Z",
  "segments": ["default", "plastromancy", "甲骨"]
}
```

Each `segments/<key>.json` is one `Segment` from the kernel — `key`,
`cels`, and (optionally) `fnMetaData`, `schemas`, `schemaMetadata`.
The on-disk order matches `manifest.segments`, which is also the
order `hydrate` should consume them in.

JSON is indented two spaces by default so the unzipped tree diffs
cleanly and reads naturally.

## Usage

Plastron-archive is a pure transform between `Segment[]` and zip
bytes. Compose with the kernel's `dehydrate` / `hydrate` at the call
site.

### Export

```ts
import { exportArchive } from "plastron-archive";
import { writeFile } from "node:fs/promises";

const segments = state.fns.get("dehydrate")!(state) as Segment[];
const bytes = exportArchive(segments);
await writeFile("oracle.甲", bytes);
```

### Import

```ts
import { importArchive } from "plastron-archive";
import { readFile } from "node:fs/promises";
import { createInitialState } from "plastron";

const bytes = await readFile("oracle.甲");
const { manifest, segments } = importArchive(bytes);

const state = createInitialState();
state.fns.get("hydrate")!(state, segments, [myFns]);
await state.fns.get("runCycle")!(state);
```

## API

```ts
exportArchive(segments: Segment[], options?: ExportOptions): Uint8Array

interface ExportOptions {
  createdAt?: string;   // ISO-8601, default: now
  jsonIndent?: number;  // JSON.stringify space arg, default: 2
}

importArchive(bytes: Uint8Array): {
  manifest: ArchiveManifest;
  segments: Segment[];   // in manifest.segments order
}
```

Segment keys are used as filenames. The exporter rejects keys
containing `/`, `\`, NUL, or a leading dot.

## Why a zip, not canonical JSON

A single canonical JSON blob would diff cleanly and round-trip
byte-identically, but it's awkward to inspect or hand-edit, especially
once a document grows past a few segments. Splitting on segment
boundaries means:

- `unzip oracle.甲` produces an editable tree.
- A reviewer can diff a single segment in isolation.
- Tools that don't speak plastron (jq, JSON Schema validators, GitHub's
  diff viewer) work on each file individually.
