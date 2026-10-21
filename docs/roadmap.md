# Roadmap: what the Photoshop UXP API lets us add

**Status (0.4.0):** slices 0-4 built and tested against the fake. Live in Photoshop 27.10: everything up to slice 1
(plus `uxp_docs` against GitHub); slices 2-3 (layers, canvas, history, filters, fills, adjustments, styles) wait
for a live run.

Source: Adobe's Photoshop UXP reference (github.com/AdobeDocs/uxp-photoshop, Apache-2.0), read 2026-10-18 against
Photoshop 27.10. Versions below are the API's minimum Photoshop version from those docs. **The docs are claims, not
facts**: the live run already found two places where Photoshop differed from what we assumed (`Layer.scale` rejected
every anchor value, and batchPlay echoes each descriptor back). Each tool gets a step in `test/live.ts` before it
counts as done, and `test/fake-ps.ts` is corrected first whenever Photoshop disagrees.

## What the poster run showed

Everything beyond placing the photo was hand-written batchPlay JSON recalled from memory: gradient fill, grid and
halftone selections, text layer, Select Subject, mask, desaturate, brightness, stroke and shadow styles, layer
moves. It worked, but each descriptor was a guess that could fail. Two things would help most:

1. **Recording**: the user does something once in Photoshop, and the model gets the exact descriptor back.
2. **DOM-backed tools** for the common operations, so the model calls `set_text` instead of writing a textLayer
   descriptor.

## Proposed tools (about 11, general with options, per the ae-motion rule)

| # | Tool | Covers | API | Min PS |
|---|---|---|---|---|
| 1 | `record_actions` start/stop | Returns descriptors of what the user did in Photoshop (filtered with `eventcodes.md`; our own batch_play calls left out). The safe way to learn any descriptor. | `action.addNotificationListener` | 23.0 |
| 2 | `add_text` / `set_text` | Create and edit text: contents, font, size, colour, tracking, leading, caps, alignment, point/paragraph, warp. | `createTextLayer`, `textItem.characterStyle` / `paragraphStyle` / `warpStyle` | 24.2 |
| 3 | `select` | Rectangle, ellipse, polygon, all, none, inverse, expand / contract / feather / smooth / grow; `subject` (batchPlay `autoCutout`); `to_mask` makes a layer mask from it. | `Selection` class | 25.0 |
| 4 | `sample_colors` | Colours at points, plus a palette of the main colours (from `imaging.getPixels`). For matching a reference. | `sampleColor`, `histogram`, imaging | 24.0 |
| 5 | `set_layer` | Name, visible, opacity, fill opacity, blend mode, locks, clipping mask, move above/below/into group, translate, scale, rotate, flip, skew. | `Layer` properties and methods | 22.5–23.0 |
| 6 | `layer_ops` | Duplicate, delete, group, merge, rasterize, link, bring to front / send to back. | `Layer`, `Document.groupLayers` | 22.5 |
| 7 | `apply_filter` | One tool for the ~40 `Layer.applyX` filters (Gaussian blur, noise, high pass, motion blur, unsharp mask...): name + params. | `Layer.applyX` | 23.0+ |
| 8 | `add_fill` / `set_style` | Solid / gradient fill layers, adjustment layers (levels, curves, B&W, hue/sat...), layer styles (stroke, shadow, glow, overlay). No DOM API exists, so these are batchPlay descriptors proven live, behind a typed schema. | batchPlay | — |
| 9 | `canvas` | Crop, resize image, resize canvas, trim, rotate, change mode, flatten. | `Document` methods | 22.5 |
| 10 | `export` | Save as PNG / JPEG / PSD / GIF (path sandboxed), as a copy or not. | `Document.saveAs.*` | 22.5 |
| 11 | `history` | List history states, undo to a state. | `historyStates`, `activeHistoryState` | 22.5 |

Kept separate, each needing a decision:

- **`generative_upscale`** (27.2): uses Firefly credits and the network. Ask the user before each call;
  `openWorld: true`.
- **`menu_command`** (`core.performMenuCommand`, 22.5): reaches any menu item, but can open a dialog and leave
  Photoshop modal. Off unless enabled, like `run_jsx`.
- **`docs_lookup`**: lets the model read Adobe's UXP reference itself (a class, a method, an event code).
  Bundle the reference as MCP resources (Apache-2.0: keep the notice), or fetch from GitHub on demand
  (`openWorld: true`).
- **No code evaluation.** A `run_script` tool was refused by the permission check; nothing here needs one.

## Harness fixes first

- A reload is invisible while the version stays the same: send a build hash in the plugin's hello, and put a
  "plugin is outdated, reload it" warning in tool results, not only on stderr.
- `batch_play` compaction: `select` returns `layerID` as an array; handle it.
- `test/live.ts` gets a step for each new tool.
