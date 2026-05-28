# plastron-simple-examples/keyboard

A musical keyboard demo — second consumer of plastron's
[`sound` segment](../../plastron-simple/src/甲骨坑/sound.ts), the same
one the [doom example](../doom/README.md) routes engine SFX through.

QWERTY → notes via `sound.play-tone`:

```
| W | E |   | T | Y | U |   | O | P |
| A | S | D | F | G | H | J | K | L | ; |
  C   D   E   F   G   A   B   C5  D5  E5
```

Top row keys (`w e t y u o p`) are the black notes; lower row
(`a s d f g h j k l ;`) are the white notes. The on-screen piano
clicks too. Waveform / volume / octave controls at the top.

## Run

```bash
cd ~/projects/plastron/plastron-simple-examples/keyboard
bun run dev
# → http://localhost:3001
```

Click on the page once to satisfy the browser's autoplay-after-gesture
policy, then play. Same `sound.play-tone` cel is on disk in the kernel
— this app just wires `keydown` → `playTone(state, {freq, type, gain})`.

## What the code shows

Two segments + ~100 lines of `main.ts`:

- `import { createInitialState, resolveFn } from plastron-simple` — boot a state.
- `resolveFn(state, "sound.play-tone")` — grab the cel's runtime fn.
- A note→frequency table (12-TET centered on A4=440).
- A `keydown` listener that calls `playTone(state, {...})` with the
  current waveform/octave/duration.
- A `setCel` write to `sound.master-gain` when the volume slider moves
  (showing kernel cels can be mutated from app code at runtime).

That's it — the segment does the Web Audio plumbing (lazy
`AudioContext`, source/gain/pan node graph, envelope, lifecycle).

## Anchors

- Sound segment source:
  `../../plastron-simple/src/甲骨坑/sound.{ts,json}`
- Sound segment tests:
  `../../plastron-simple/test/sound.test.mjs`
- Doom example (the other consumer):
  `../doom/`
