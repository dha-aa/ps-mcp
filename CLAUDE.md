# CLAUDE.md

MCP server driving a live Photoshop through a UXP plugin. Architecture, setup and tools: `README.md`.

## Commands

```bash
npm run build     # src/ -> dist/ (server), plugin-src/ -> plugin/js/main.js (plugin)
npm test          # build + node --test test/*.test.ts
npm run typecheck
```

## Layout

- `src/index.ts` entry · `src/server.ts` `createServer(bridge)` + `SERVER_INSTRUCTIONS` · `src/config.ts` env vars ·
  `src/errors.ts` `PsToolError` · `src/bridge.ts` `WsBridge` (listens, writes the bridge file, pending map, timeouts
  send `cancel`, warns when the plugin build differs from `plugin/js/build.json`) · `src/sandbox.ts` ·
  `src/images.ts` (path or base64 -> file + size) · `src/palette.ts` (k-means) · `src/docs.ts` (UXP docs cache/search).
- `src/tools/registry.ts` `ToolRegistry.bridged` / `.tool` (annotations, compact JSON, 25k cap, error format,
  `WithImages`). Tools by group in `src/tools/`: `document`, `actions`, `edit` (text, select, colours, export, record),
  `layers` (set_layer, layer_ops, canvas, history), `looks` (filters, fills, adjustments, styles), `docs`; shared
  schemas in `schemas.ts`. MCP SDK **v2** (`@modelcontextprotocol/server`, `zod/v4`); every schema is a
  `z.strictObject` (a static test checks).
- `plugin-src/*.ts` the plugin: script files with no imports, compiled to `build/plugin/` and joined in `MODULES`
  order (`scripts/build-plugin.ts`, which also stamps `PLUGIN_BUILD`) into `plugin/js/main.js`. `core.ts` first
  (helpers, `modal`, `fail`, `constant`, `centreAt`, the `commands` table), `bridge.ts` last. `env.d.ts` declares
  only the UXP / Photoshop APIs used; `test/fake-ps.ts` fakes exactly those. `plugin/` is what UXP Developer Tools
  loads (`js/` is generated and gitignored).
- `src/slim.ts`: the advertised tool list is slimmed (zod still validates in full) and SDK validation errors become
  BAD_ARGS; it wraps the SDK's tools/list and tools/call handlers (`adaptToolHandlers`).
- Tests: `test/tools-document.test.ts`, `tools-edit.test.ts`, `tools-layers-looks.test.ts` (commands in a vm via
  `test/plugin-harness.ts`), `e2e.test.ts` (built server over stdio + real plugin over WebSocket), `docs.test.ts`,
  `slim.test.ts`, `registry.test.ts`, `static.test.ts`. Real Photoshop: `npm run live` (`test/live.ts`, every tool,
  with read-backs) and `scripts/call.ts` (ad-hoc steps). `npm run check-api` checks `env.d.ts` against the docs.

## Rules

- Adding a tool: a schema in `src/tools/`, a command of the same name in `plugin-src/`, tests, `EXPECTED_TOOLS` in
  `test/e2e.test.ts`, a step in `test/live.ts`, the README table and a CHANGELOG line.
- Watch the token cost: `npm test` prints the size of tools/list. Share schemas (`src/tools/schemas.ts`), keep
  descriptions short, never repeat in a description what the schema says.
- Every batchPlay goes through `play(descriptors, what)`; every Photoshop change goes through `modal(name, doc, fn)` (executeAsModal + one history step, rolled back on
  error). Reads stay outside it.
- Photoshop enums are always `ps.constants.X` values (`constant(group, name)`), never strings.
- Plugin errors are `fail(code, message, hint)`; `toErr` maps Photoshop's errors (`number 9` -> `BUSY`).
- Path arguments are checked on the server (`assertAllowed`) before they reach the plugin.
- Results leave out defaults; destructive results say what went (`deleted`, `flattened`, `merged`).
- One version in `package.json`, `plugin/manifest.json` and `PLUGIN_VERSION` (static test). Bump it when the plugin
  changes so the panel shows which build runs.
- When real Photoshop behaves differently from `test/fake-ps.ts`, fix the fake first, then the code; check a fix with
  a mutation (the test must fail without it).
- A green `npm test` does not prove it works in Photoshop: run `npm run live` before calling a change done.
- `batch_play` file references go through the sandbox (`checkDescriptorPaths`) and become session tokens in the plugin.

## Photoshop quirks (found live, PS 27.10 / UXP 9.4)

- `Layer.scale(w, h, anchor)` rejects every anchor tried (`"middleCenter"`, `constants.AnchorPosition.MIDDLECENTER`):
  scale without one, then `translate` to the exact centre.
- batchPlay echoes each descriptor back: `batch_play` keeps only `get` results and ids of layers made.
- batchPlay does NOT throw when a descriptor fails: it returns `{_obj: "error", message, result}` in its place.
  Every call goes through `play()` (core.ts), which fails on it; never call `ps.action.batchPlay` directly.
- Duplicating a layer that has clipped layers above it can leave them unclipped (seen live): re-check `clip`.
- Select Subject on a photo of leaves on black selects the whole layer; Blend If (`blendRange`) drops dark pixels.
- `createTextLayer` ignores `name` and names the layer after its contents: set `layer.name` afterwards.
- A fill / gradient layer made while a selection is active gets it as its mask (shapes: select, then make the layer).
- UXP Developer Tools' Reload only picks up builds made before it; the server compares `plugin/js/build.json` with
  the plugin's hello and warns in every result. Turn on Watch in UDT while developing.
- The sandbox's temp folder is the server's `os.tmpdir()` (macOS `/var/folders/...`), not `/private/tmp`.
- After a text change (size, contents) a layer's `bounds` stay stale until it moves: `centreAt` re-reads and corrects.
- Docs pages escape markup (`\<span ...\>`, `\<br/\>`) and wrap types as `` `<void>` ``: `clean()` (src/docs.ts) handles both.
- `constants.FlipAxis` does not exist (the docs list it): flip with the `flip` action descriptor (`set_layer`).
- `Document.historyStates` / `activeHistoryState` answer for the ACTIVE document, whichever document they are read
  from: `history` activates its document first, or undo would act on another document.
- `createPixelLayer` / `createLayerGroup` put the new layer on top whatever is selected (`createTextLayer` and fill
  layers follow the selection): `layer_ops` moves it when `above` is given.
- Selection bounds are clipped to the canvas.
- `layer.allLocked` only takes effect on the SELECTED layer (otherwise silently nothing); a locked layer silently
  ignores opacity and is not rasterized; a filter on a smart object becomes a smart filter without an error.
  Commands that change a layer call `selectLayer` first; `rasterizeChecked` verifies the result.
- A file Photoshop can't read (an Unsplash JPEG macOS opens fine) is placed as nothing and opened as undefined,
  with no error: `place_image` finds its layer by new id, `open_image` checks the document; re-saving fixes it.
- A new pixel layer / group goes inside the selected group (on top of it), else on top of the document.
- New layers go above the selected layer; a layer moved down stays selected, so later layers land under what is
  above it. Tools that make layers take `above`; the server instructions tell the model.
- Adjustment descriptors (levels, curves, hue/sat, brightness/contrast, black & white) store exactly what
  `add_adjustment` sends (read back live with batch_play `get`).
