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
- Tests: `test/plugin.test.ts`, `slice1.test.ts`, `slice2.test.ts` (commands in a vm via `test/plugin-harness.ts`),
  `e2e.test.ts` (built server over stdio + real plugin over WebSocket), `docs.test.ts` (local stand-in for GitHub),
  `registry.test.ts`, `static.test.ts`. `test/live.ts` and `scripts/call.ts` drive real Photoshop.

## Rules

- Adding a tool: a schema in `src/tools/`, a command of the same name in `plugin-src/`, tests, `EXPECTED_TOOLS` in
  `test/e2e.test.ts`, and the README table.
- Every Photoshop change goes through `modal(name, doc, fn)` (executeAsModal + one history step, rolled back on
  error). Reads stay outside it.
- Photoshop enums are always `ps.constants.X` values (`constant(group, name)`), never strings.
- Plugin errors are `fail(code, message, hint)`; `toErr` maps Photoshop's errors (`number 9` -> `BUSY`).
- Path arguments are checked on the server (`assertAllowed`) before they reach the plugin.
- Results leave out defaults; destructive results say what went (`deleted`, `flattened`, `merged`).
- One version in `package.json`, `plugin/manifest.json` and `PLUGIN_VERSION` (static test). Bump it when the plugin
  changes so the panel shows which build runs.
- When real Photoshop behaves differently from `test/fake-ps.ts`, fix the fake first, then the code; check a fix with
  a mutation (the test must fail without it).
- A green `npm test` does not prove it works in Photoshop: run the tool live (`scripts/call.ts`) before calling it done.

## Photoshop quirks (found live, PS 27.10 / UXP 9.4)

- `Layer.scale(w, h, anchor)` rejects every anchor tried (`"middleCenter"`, `constants.AnchorPosition.MIDDLECENTER`):
  scale without one, then `translate` to the exact centre.
- batchPlay echoes each descriptor back: `batch_play` keeps only `get` results and ids of layers made.
- `createTextLayer` ignores `name` and names the layer after its contents: set `layer.name` afterwards.
- A fill / gradient layer made while a selection is active gets it as its mask (shapes: select, then make the layer).
- UXP Developer Tools' Reload only picks up builds made before it; the server compares `plugin/js/build.json` with
  the plugin's hello and warns in every result. Turn on Watch in UDT while developing.
- The sandbox's temp folder is the server's `os.tmpdir()` (macOS `/var/folders/...`), not `/private/tmp`.
- After a text change (size, contents) a layer's `bounds` stay stale until it moves: `centreAt` re-reads and corrects.
- Docs pages escape markup (`\<span ...\>`, `\<br/\>`) and wrap types as `` `<void>` ``: `clean()` (src/docs.ts) handles both.
