// Shared by every plugin file: Photoshop modules, errors, lookups, modal scope, result shapes.
// The plugin is several script files (no imports) joined in order by scripts/build-plugin.ts into
// plugin/js/main.js; test/plugin-harness.ts runs that same file in a vm with fake Photoshop modules.

const PLUGIN_VERSION = "0.5.0";
const SCAN_MS = 2000;
const RETRY_MS = 10000;

const ps = require("photoshop");
const uxp = require("uxp");
const ufs = require("fs");
const uos = require("os");

// ---------------------------------------------------------------- errors

interface ToolErr {
  code: string;
  message: string;
  hint?: string;
}

function fail(code: string, message: string, hint?: string): never {
  const e: ToolErr = hint ? { code, message, hint } : { code, message };
  throw e;
}

function toErr(e: unknown): ToolErr {
  const o = e as { code?: unknown; message?: unknown; number?: unknown } | null;
  if (o && typeof o.code === "string" && typeof o.message === "string") return o as ToolErr;
  const message = o && typeof o.message === "string" ? o.message : String(e);
  // Only Photoshop being busy is BUSY; "only available in a modal execution context" is our bug, not the user's.
  if ((o && o.number === 9) || /host is in a modal state|is running a modal command/i.test(message)) {
    return { code: "BUSY", message, hint: "Photoshop is in a modal state (a dialog, a text edit or a transform). Finish or cancel it, then retry." };
  }
  return { code: "PS_ERROR", message };
}

// ---------------------------------------------------------------- helpers

const round = (n: number, k = 100) => Math.round(n * k) / k;

function docs(): PsDocument[] {
  return Array.from(ps.app.documents);
}

function findDoc(id: number | undefined): PsDocument {
  if (id === undefined) {
    const d = ps.app.activeDocument;
    if (!d) fail("NOT_FOUND", "No document is open.", "Use create_document or open_image first.");
    return d;
  }
  const d = docs().find((x) => x.id === id);
  if (!d) fail("NOT_FOUND", `No open document has id ${id}.`, "get_document lists the open documents and their ids.");
  return d;
}

function findLayer(doc: PsDocument, id: number): PsLayer {
  const walk = (ls: PsLayer[]): PsLayer | null => {
    for (const l of ls) {
      if (l.id === id) return l;
      const inner = l.layers ? walk(l.layers) : null;
      if (inner) return inner;
    }
    return null;
  };
  const l = walk(doc.layers);
  if (!l) fail("NOT_FOUND", `Document ${doc.id} has no layer with id ${id}.`, "get_document lists the layer ids.");
  return l;
}

/** Makes doc the active document (place and other menu-like actions work on the active one). */
function activate(doc: PsDocument): void {
  if (!ps.app.activeDocument || ps.app.activeDocument.id !== doc.id) ps.app.activeDocument = doc;
}

/** Runs fn in Photoshop's modal scope; with a document, all its changes become one history step (one undo). */
async function modal<T>(name: string, doc: PsDocument | null, fn: (ctx: PsModalContext) => Promise<T>): Promise<T> {
  return ps.core.executeAsModal(
    async (ctx) => {
      if (!doc) return fn(ctx);
      const h = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "MCP " + name });
      try {
        const r = await fn(ctx);
        await ctx.hostControl.resumeHistory(h, true);
        return r;
      } catch (e) {
        await ctx.hostControl.resumeHistory(h, false);
        throw e;
      }
    },
    { commandName: "MCP: " + name, timeOut: 5000 },
  );
}

async function fileEntry(path: string): Promise<unknown> {
  try {
    return await uxp.storage.localFileSystem.getEntryWithUrl("file:" + path);
  } catch (e) {
    return fail("NOT_FOUND", `Photoshop can't read ${path}: ${toErr(e).message}`, "Check the file exists; the plugin needs Full Access to files (accept the prompt when loading it).");
  }
}

function box(b: PsBounds): number[] {
  return [round(b.left), round(b.top), round(b.right), round(b.bottom)];
}

/** Layers still allowed in one listing (get_document max_layers); the ones left out are counted. */
const budget = { left: Infinity, skipped: 0 };

function countLayers(ls: PsLayer[]): number {
  return ls.reduce((n, l) => n + 1 + (l.layers ? countLayers(l.layers) : 0), 0);
}

function layerInfo(l: PsLayer, depth: number, maxDepth: number): Record<string, unknown> {
  budget.left--;
  const o: Record<string, unknown> = { id: l.id, name: l.name, kind: l.kind };
  if (!l.visible) o.visible = false;
  if (Math.round(l.opacity) !== 100) o.opacity = round(l.opacity, 1);
  const neutral = l.kind === "group" ? "passThrough" : "normal";
  if (l.blendMode && l.blendMode !== neutral) o.blend = l.blendMode;
  if (l.allLocked) o.locked = true;
  if (l.isBackgroundLayer) o.background = true;
  o.bounds = box(l.bounds);
  if (l.layers) {
    if (depth < maxDepth) o.layers = listLayers(l.layers, depth + 1, maxDepth);
    else o.layer_count = l.layers.length;
  }
  return o;
}

function listLayers(ls: PsLayer[], depth: number, maxDepth: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of ls) {
    if (budget.left <= 0) {
      budget.skipped += 1 + (l.layers ? countLayers(l.layers) : 0);
      continue;
    }
    out.push(layerInfo(l, depth, maxDepth));
  }
  return out;
}

function docBrief(d: PsDocument): Record<string, unknown> {
  return { id: d.id, title: d.title, width: d.width, height: d.height, resolution: d.resolution };
}

function docInfo(d: PsDocument, maxDepth: number, parent?: PsLayer, maxLayers = Infinity): Record<string, unknown> {
  const o = docBrief(d);
  const mode = String(d.mode).replace(/ColorMode$|Mode$/, "");
  if (mode !== "RGB") o.mode = mode;
  const bits = Number(String(d.bitsPerChannel).replace(/\D/g, ""));
  if (bits && bits !== 8) o.bits = bits;
  if (d.path) o.path = d.path;
  if (!d.saved) o.unsaved = true;
  budget.left = maxLayers;
  budget.skipped = 0;
  if (parent) o.parent = { id: parent.id, name: parent.name };
  o.layers = listLayers(parent ? parent.layers ?? [] : d.layers, 1, maxDepth);
  if (budget.skipped) o.layers_not_shown = budget.skipped;
  return o;
}

/** The placed layer's box from its smart-object transform (includes transparent margins), else its bounds. */
async function placedBox(doc: PsDocument, layer: PsLayer): Promise<{ l: number; t: number; w: number; h: number }> {
  try {
    const r = await ps.action.batchPlay(
      [{ _obj: "get", _target: [{ _ref: "layer", _id: layer.id }, { _ref: "document", _id: doc.id }], _options: { dialogOptions: "dontDisplay" } }],
      {},
    );
    const t = r[0] && r[0].smartObjectMore && r[0].smartObjectMore.transform;
    if (Array.isArray(t) && t.length === 8) {
      const xs = [t[0], t[2], t[4], t[6]];
      const ys = [t[1], t[3], t[5], t[7]];
      const l = Math.min(...xs);
      const tp = Math.min(...ys);
      return { l, t: tp, w: Math.max(...xs) - l, h: Math.max(...ys) - tp };
    }
  } catch {
    // fall back to bounds
  }
  const b = layer.boundsNoEffects;
  return { l: b.left, t: b.top, w: b.right - b.left, h: b.bottom - b.top };
}

/** Moves a layer so the centre of its bounds is at (x, y); either may be omitted. After a text change
 * Photoshop can report the old bounds until the layer moves (seen live, PS 27.10), so re-read and correct. */
async function centreAt(layer: PsLayer, x: number | undefined, y: number | undefined): Promise<void> {
  if (x === undefined && y === undefined) return;
  for (let i = 0; i < 4; i++) {
    const b = layer.bounds;
    const dx = x === undefined ? 0 : x - (b.left + b.right) / 2;
    const dy = y === undefined ? 0 : y - (b.top + b.bottom) / 2;
    if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return;
    await layer.translate(dx, dy);
  }
}

/** Photoshop's enum value for a snake_case name (soft_light -> SOFTLIGHT); fails with the valid names. */
function constant(group: keyof PsConstants, name: string): unknown {
  const table = ps.constants[group] as Record<string, unknown> | undefined;
  if (!table) fail("UNSUPPORTED", `This Photoshop has no constants.${group}.`, "Use batch_play for this, and report it: the tool needs updating.");
  const key = String(name).replace(/_/g, "").toUpperCase();
  if (!(key in table)) fail("BAD_ARGS", `Unknown ${group} "${name}".`, "Valid: " + Object.keys(table).map((k) => k.toLowerCase()).join(", "));
  return table[key];
}

// ---------------------------------------------------------------- commands (each file adds its own)

type Args = Record<string, any>;

const commands: Record<string, (a: Args) => Promise<unknown>> = {};
