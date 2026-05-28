# plastron-simple-examples/notepad

Standalone demo of `buildNotepad` — a plastron app in 15 lines of `main.ts`.

```bash
bun run dev
# → http://localhost:3002
```

Type in the textarea — every keystroke writes the `notepad.text`
ValueCel through plastron-dom's declarative `input-binding`. No app-side
handler code; the binding does it.

Same factory the plastron-OS notepad app uses (it overlays a custom view
+ file toolbar; standalone uses the factory's default view).

## Code structure

```ts
const seg = buildNotepad({ mount: "#notepad", text: "..." });
await hydrate(state, [seg], [manifest]);
precompute(state); await precomputeOptional(state);
setPainter(state, createPainter(state));
await runCycle(state);
await drain(state, "plastron-dom.paint");
```

That's the whole app.

## Anchors

- Factory:    `../../plastron-simple/src/甲骨坑/notepad/build.ts`
- Plastron-OS version (toolbar + persistence): `../plastron-os/browser-main.ts`
