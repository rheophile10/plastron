# plastron-simple-examples/sheets

Standalone version of the plastron-OS sheets app. Reuses
`buildSheetsApp` + `setupFileToolbar` from `../plastron-os/`; bun's
bundler pulls them in.

```bash
bun run dev
# → http://localhost:3003
```

Click a cell, type a formula like `=A1*2` in the formula bar (or `=B2*C2`,
`=SUM(B2:B5)`), press Enter or click ✓. The kernel's `infix` parser
resolves A1-style refs to sibling sheet-cell keys and auto-wires them
into the reactive graph.

The Save/Load buttons in the file toolbar use `segment-store`
(OPFS in browser).

## Anchors

- buildSheetsApp:    `../plastron-os/sheets.ts`
- file-toolbar:      `../plastron-os/file-toolbar.ts`
- Kernel sheet segment: `../../plastron-simple/src/甲骨坑/sheet.{ts,json}`
