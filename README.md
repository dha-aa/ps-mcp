# photoshop-mcp

An MCP server that lets an MCP client (Claude Code, Claude Desktop) work in a live Adobe Photoshop: open or place
reference images, build documents and check the result with previews.

```
MCP client --stdio--> server (src/, Node) <--WebSocket 127.0.0.1 + token-- UXP plugin in Photoshop (plugin/)
```

A UXP plugin can only make outgoing connections, so the server listens and the plugin connects to it. Each server
writes `~/.photoshop-mcp/bridges/<pid>.json` (port + token, mode 0600). The plugin checks that folder every 2 s and
connects to every server it finds, so several Claude sessions can share one Photoshop. Commands run one at a time,
because Photoshop has one modal state. Every change runs in `executeAsModal` as one history step (one undo).

Status: **0.4.0.** Tested against a fake Photoshop (`npm test`) that models the quirks found live; checked live in
Photoshop 27.10 up to slice 1 (see `docs/roadmap.md`).

## Setup

Needs Node 22.18+ and Photoshop 25.10+ (tested target: Photoshop 2026 / 27.x).

```bash
npm install
npm run build
```

Load the plugin (once):

1. Photoshop: **Settings > Plugins > Enable Developer Mode**, then restart Photoshop.
2. Open **Adobe UXP Developer Tools**: **Add Plugin** > choose `plugin/manifest.json` > **Load**.
   Accept the prompt for full file access (needed to read the bridge folder and your images).
3. In Photoshop: **Plugins > Photoshop MCP**. The panel shows "Connected to 1 MCP server" once a server runs.

Register the server with Claude Code:

```bash
claude mcp add photoshop -- node /absolute/path/to/photoshop-mcp/dist/index.js
```

After changing `plugin-src/`, run `npm run build` and press **Reload** in UXP Developer Tools.

## Tools

| Group | Tool | What it does |
|---|---|---|
| Documents | `get_document` | Open documents, and one document's size, mode and layer tree (ids, kinds, bounds). Defaults left out. |
| | `create_document` | New RGB document (width, height, resolution, white / black / transparent). |
| | `open_image` | Open an image file (or base64 data) as its own document. |
| | `place_image` | Place an image as a smart-object layer: `fit` contain / cover / stretch / none, centre `x,y`, `name`, `opacity`, `locked`. |
| | `preview` | JPEG of the document or one layer, shrunk to `max_edge`, to compare with a reference. |
| | `export` | Save as PNG / JPEG / PSD / GIF (sandboxed path, no overwrite unless asked, waits for the file). |
| Text | `set_text` | Create or edit text: font, size, colour, alignment, tracking, leading, caps, centre. Reports a substituted font. |
| | `find_fonts` | Installed fonts and their PostScript names. |
| Selection | `select` | Rect / ellipse / polygon / all / none / inverse / subject / a layer's pixels; add / subtract / intersect; expand, contract, smooth, feather; make a layer mask from it. |
| Colour | `sample_colors` | Colours at points and a palette of the main colours with their share. |
| Layers | `set_layer` | Name, visibility, opacity, fill, blend mode, lock, clipping; move, scale, rotate, flip about the centre; stacking order. |
| | `layer_ops` | New layer / group, duplicate, delete, group, merge, rasterize. |
| Document | `canvas` | Crop, resize image (aspect kept), resize canvas, trim, rotate, flatten. |
| | `history` | List states, undo / redo, go to a state. |
| Looks | `apply_filter` | Gaussian / motion blur, noise, high pass, unsharp mask, sharpen, median, dust & scratches, min / max, twirl, pinch, offset, clouds, despeckle. |
| | `add_fill` | Solid or gradient fill layer, full canvas or shaped (rect / ellipse / polygon becomes its mask). |
| | `add_adjustment` | Brightness / contrast, hue / saturation, vibrance, black & white, levels, curves, photo filter, gradient map, invert, posterize, threshold. |
| | `set_style` | Stroke, drop shadow, outer / inner glow, colour overlay; keeps the other effects. |
| Anything else | `batch_play` | Photoshop action descriptors, as one undo step. |
| | `record_actions` | Record what the user does by hand, as descriptors to replay with `batch_play`. |
| | `uxp_docs` | Search and read Adobe's Photoshop UXP reference (cached on disk; the only tool that uses the network). |

Errors are `{error:{code,message,hint}}` (arguments that fail the schema come back as the MCP SDK's own
validation text). `code` is one of `NOT_FOUND`, `BAD_ARGS`, `PS_ERROR`, `BUSY`
(Photoshop is in a dialog or modal tool), `BRIDGE_DOWN`, `TIMEOUT`, `FORBIDDEN` or `UNSUPPORTED`.

### Reference images

An image you paste into the chat is visible to the model, but its bytes don't reach the server. Give the file's
path instead ("place ~/Desktop/ref.png"), or the client can pass base64 as `data`. Typical flow:
`open_image` (or `create_document` at the reference's size), then `place_image` with `opacity: 40, locked: true`,
build over it, and `preview` to compare.

## Settings

| Variable | Default | |
|---|---|---|
| `PS_MCP_ALLOWED_DIRS` | home + temp | Folders path arguments may point into (`:`-separated). |
| `PS_MCP_TIMEOUT_MS` | 60000 | Per-command limit in Photoshop. |
| `PS_MCP_CONNECT_WAIT_MS` | 4000 | How long a call waits for the plugin to connect. |
| `PS_MCP_BRIDGE_DIR` | `~/.photoshop-mcp/bridges` | Tests only: the plugin always reads the default. |
| `PS_MCP_DOCS_DIR` | `~/.photoshop-mcp/docs` | `uxp_docs` cache (`PS_MCP_DOCS_TREE_URL` / `PS_MCP_DOCS_RAW_URL` point it elsewhere). |

## Development

```bash
npm test          # build, then test/*.test.ts (no Photoshop needed)
npm run typecheck # server, plugin and tests
node test/live.ts --yes  # against real Photoshop (plugin loaded, panel open); creates documents
```

- `test/plugin.test.ts`: the built plugin's commands in a vm against `test/fake-ps.ts`. The fake models the real
  constraints: changes outside `executeAsModal` throw, a busy modal state throws `{number: 9}`, Photoshop may
  shrink an image on place, and layer bounds exclude transparent margins.
- `test/e2e.test.ts`: the built server over stdio with a real MCP client, plus the real plugin over a real
  WebSocket. Covers sandboxing, base64 uploads, timeouts that drop unstarted commands, disconnects, bad tokens,
  two servers at once and stale bridge files.
