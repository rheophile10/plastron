# multiplane-demo

Disney's multiplane camera, but every parameter is a reactive cel.

A 4-layer scene (sky / mountains / hills / branches) painted into an
HTML5 canvas with parallax compositing. Camera pans, day cycle shifts,
the user scrubs a slider — all driven by the same plastron cel graph.
No frameworks, no scenegraph library, no diff/patch machinery for the
canvas (Canvas 2D is immediate-mode; we just call `drawImage` in z-order
on each frame).

## Run it

```bash
npm install
npm run dev      # vite dev server
```

For the single-file build (one `dist/index.html`, hostable anywhere
static — GH Pages, S3, `file://`):

```bash
npm run build    # → dist/index.html, all JS + CSS inlined
npm run preview  # vite preview to test the bundle locally
```

## Cel graph

```
frame ────────► effectiveFrame ──► camera ──┐
                ▲                            ├─► scene ──► <canvas#scene>
scrubFrame ─────┘                            │
                                             │
lighting ──► palette ──► layers ─────────────┘
                         (offscreen canvases)
```

Source cels (writeable):

| cel          | type                                  | what it is                              |
|--------------|---------------------------------------|------------------------------------------|
| `frame`      | number                                | animation time in ms (auto-ticked by rAF)|
| `scrubFrame` | number \| null                        | user override when scrubbing             |
| `playing`    | boolean                               | rAF loop only writes `frame` when true   |
| `lighting`   | "dawn"\|"noon"\|"evening"\|"night"    | active palette                           |

Derived cels:

| cel              | lambda                            | recomputes when                |
|------------------|-----------------------------------|--------------------------------|
| `effectiveFrame` | `scrubFrame ?? frame`             | frame OR scrubFrame changes    |
| `palette`        | `PALETTES[lighting]`              | lighting changes (rarely)      |
| `layers`         | `buildLayers(W, H, palette)`      | palette changes (4 offscreen canvases rebuilt) |
| `camera`         | sine-wave pan/bob driven by time  | effectiveFrame changes (every frame) |
| `scene`          | composes layers + camera          | layers OR camera changes       |

The canvas channel is bound to `scene`. On every cascade-induced
change, the channel schedules an rAF, calls `renderMultiplane(ctx,
scene)` on the next frame, and one paint commits.

## What's procedural

The four layer images are painted into offscreen canvases at boot
(and on every `lighting` change). It's stylized — gradient sky with a
sun disc, three triangular mountain ranges, two sine-wave hill bands,
and recursive branch silhouettes. **Not Disney-grade art.** The pitch
is the cel graph + parallax math, not the brush.

Anyone can swap the procedural canvases for real painted PNGs by
passing `HTMLImageElement` or `ImageBitmap` as `Drawing.lineArt` —
no plastron code changes.

## Architecture

Three plastron segments compose:

- **plastron-canvas** — the rAF-batched painter channel. Mounts a
  cel onto a `<canvas>` element; calls the user's `draw` fn on each
  cel change.
- **plastron-multiplane** — schemas (`Drawing` / `Layer` / `Scene`)
  + the parallax `renderMultiplane(ctx, scene)` paint function. No
  channel of its own; composes with plastron-canvas.
- **plastron-dom** — the side panel (play/pause + day-cycle buttons
  + scrub slider) AND the live devtools readout are both
  vnode-rendered. Same State, two channels (canvas + dom), two
  rAF schedulers.

The cel graph is the source of truth. The UI dispatches into action
lambdas (`demo:setLighting`, `demo:togglePlaying`, `demo:resetScrub`)
that write to the source cels. The cascade does the rest.

## Reference

The multiplane camera was Disney's signature innovation for animated
features starting in 1937 (*The Old Mill*). The digital re-implementation,
**CAPS** (Computer Animation Production System), shipped on *The
Rescuers Down Under* (1990) and ran through 2004. The data shape —
layered drawings at z-depths with a camera that pans through them — is
what's faithful here. The art is not.
