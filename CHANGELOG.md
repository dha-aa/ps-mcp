# Changelog

## 0.5.0

- The advertised tool list is slimmed (~9.1k -> ~6.0k tokens per request); zod still validates the full schemas.
- Schema errors come back as `{error:{code:"BAD_ARGS",message,hint}}` like every other error.
- `batch_play`: every `_path` must be inside the allowed folders; the plugin turns it into a session token, so
  saving and opening through descriptors works inside the sandbox only.
- `get_document`: `max_layers` (default 300; the rest are counted) and `parent_id` for big PSDs.
- Minimum Photoshop 26.9 (setting `activeLayers` needs it); tested on 27.10.
- `npm run live` checks every tool against real Photoshop (`--record` adds record_actions);
  `npm run check-api` checks the declared API against Adobe's reference; `npm run package` builds a `.ccx`.
- LICENSE (MIT), CI workflow, tests named by tool group.

## 0.4.1

- `history` activates its document first: Photoshop answers history for the active document only.
- `set_layer flip` uses the flip action descriptor (`constants.FlipAxis` is missing in Photoshop 27.10).
- `set_text` and new layers / groups take `above`; the instructions explain where new layers go.

## 0.4.0

- Layers: `set_layer`, `layer_ops`. Document: `canvas`, `history`. Looks: `apply_filter`, `add_fill`,
  `add_adjustment`, `set_style`. Docs: `uxp_docs` (Adobe's reference, cached).
- `set_text` re-centres until the stale bounds Photoshop reports after a resize are correct.

## 0.3.0

- `set_text`, `find_fonts`, `select`, `sample_colors`, `export`, `record_actions`.
- Plugin split into files joined at build time, with a build hash: a missed reload is reported in every result.
- `batch_play` returns only new information (Photoshop echoes descriptors); a too-large result from a change says
  it ran.

## 0.2.0

- `batch_play`. `place_image` scales without an anchor (Photoshop rejects every anchor value).

## 0.1.0

- Server, WebSocket bridge, UXP plugin; `get_document`, `create_document`, `open_image`, `place_image`, `preview`.
