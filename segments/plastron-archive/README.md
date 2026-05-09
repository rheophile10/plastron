# `plastron-archive`

Read and write plastron documents as `.甲` files — a zip wrapping a
[xit](https://github.com/) repository whose working tree holds
pretty-printed JSON segments. Every export is a commit, so a `.甲` file
carries its full history without needing an outer git repo.

## File format

A `.甲` archive is a standard ZIP. Inside, you'll find both the working
tree and the xit repo internals:

```
oracle.甲
├── manifest.json            ← table of contents
├── segments/
│   ├── default.json         ← one Segment per file
│   ├── plastromancy.json
│   └── 甲骨.json
└── .xit/                    ← xit repo internals (commits, refs, objects)
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
`cels`, and (optionally) `fnMetaData`, `schemas`, `schemaMetadata`. The
on-disk order matches `manifest.segments`, which is also the order
`hydrate` consumes them in.

JSON is indented two spaces by default so segment files diff cleanly
on their own. `.xit/` is opaque — read it through the `Archive` API,
not by hand.

## Usage

`plastron-archive` is a thin layer over `xit-wasm`'s `Archive`. Compose
with the kernel's `dehydrate` / `hydrate` at the call site.

### Export

```ts
import { exportArchive } from "plastron-archive";
import { readFile, writeFile } from "node:fs/promises";

const segments = state.fns.get("dehydrate")!(state) as Segment[];

// First export — fresh repo.
const bytes = await exportArchive(segments, { message: "initial oracle" });
await writeFile("oracle.甲", bytes);

// Subsequent export — pass the previous bytes to extend history.
const previous = await readFile("oracle.甲");
const next = await exportArchive(segments, {
  previous,
  message: "added 甲骨 segment",
  author: "Ian <ian@example.com>",
});
await writeFile("oracle.甲", next);
```

### Import

```ts
import { importArchive } from "plastron-archive";
import { readFile } from "node:fs/promises";
import { createInitialState } from "plastron";

const bytes = await readFile("oracle.甲");
const { manifest, segments, archive } = await importArchive(bytes);

const state = createInitialState();
state.fns.get("hydrate")!(state, segments, [myFns]);
await state.fns.get("runCycle")!(state);

// `archive` is the live xit handle — see "History" below.
// Call `archive.close()` if you hold on to it.
```

## API

```ts
exportArchive(
  segments: Segment[],
  options?: ExportOptions,
): Promise<Uint8Array>

interface ExportOptions {
  createdAt?: string;       // ISO-8601, default: now
  jsonIndent?: number;      // JSON.stringify space arg, default: 2
  previous?: Uint8Array;    // bytes of a previous .甲 to extend; without
                            // it, a fresh repo is initialized
  message?: string;         // commit message; default: timestamped
  author?: string;          // "Name <email>"; default: plastron <plastron@local>
}

importArchive(bytes: Uint8Array): Promise<{
  manifest: ArchiveManifest;
  segments: Segment[];      // in manifest.segments order
  archive: Archive;         // live xit handle — call .close() when done
}>
```

Segment keys are used as filenames. The exporter rejects keys
containing `/`, `\`, NUL, or a leading dot.

## History, branching, merging

The `archive` returned by `importArchive` is a real version-controlled
repo. Power users can:

```ts
const { archive } = await importArchive(bytes);

await archive.log({ limit: 10 });        // recent commits
await archive.branch("experiment");
await archive.checkout("experiment");
// ... edit segments + commit ...
await archive.merge("experiment");

const updated = await archive.toBytes(); // serialize back to .甲
await archive.close();
```

For one-off exports, `exportArchive(segments, { previous })` is enough —
it opens, writes, commits, and closes for you.

## Why a xit-backed zip

A canonical JSON blob would diff cleanly but accretes no history; a
plain zip-of-JSONs would inspect easily but throws history away on
every save. Wrapping a xit repo gives both:

- **History without an outer VCS.** A `.甲` distributed by email or
  attached to an issue still carries every commit it ever had.
- **Per-segment diffs.** The working tree files (`segments/*.json`)
  are still readable JSON; tooling like `jq` and JSON Schema validators
  see them individually.
- **Branch and merge.** Try a what-if scenario as a branch on the same
  document; merge if it works out.

Trade-off: the unzipped tree includes `.xit/` repo internals. Editing a
segment file by hand and re-zipping technically works (xit picks up the
edit on the next `Archive.open` + `commit`), but the supported workflow
is to go through `importArchive` → mutate → `exportArchive`.
