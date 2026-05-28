# plastron-simple-examples/web-editor

Standalone demo of `buildWebEditor`. Edit a spec on the left; the right
side hydrates it as a child segment in real time.

```bash
bun run dev
# → http://localhost:3005
```

Try editing the JSON spec — the preview re-renders on each keystroke.
COUNTER_EXAMPLE is the default starter; swap to `WEATHER_EXAMPLE` in
`main.ts` (already imported and commented out) to see the alternate.

## Anchors

- Factory:                  `../../plastron-simple/src/甲骨坑/web-editor/build.ts`
- Examples (counter/weather): same dir
