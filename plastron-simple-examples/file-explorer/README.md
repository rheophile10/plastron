# plastron-simple-examples/file-explorer

Standalone version of the plastron-OS file explorer. Backed by
`segment-store` over OPFS.

```bash
bun run dev
# → http://localhost:3004
```

Empty until you save a document from another standalone app (notepad,
sheets, web-editor). OPFS is shared across same-origin tabs — and same
port means same origin — so the easiest way to see files appear here is
to run notepad on port 3004 too, save a file, then refresh.

Folders + drag-and-drop work; the explorer tracks layout in its own
`fs-tree` user-space.

## Anchors

- Explorer setup: `../plastron-os/file-explorer.ts`
- File toolbar:   `../plastron-os/file-toolbar.ts`
- segment-store:  `../../plastron-simple/src/甲骨坑/segment-store.{ts,json}`
