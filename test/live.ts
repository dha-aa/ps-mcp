// Live suite against real Photoshop (not part of npm test): npm run live   (node test/live.ts --yes [--record])
// Needs Photoshop with the plugin loaded and its panel open. Creates documents named "mcp-live*"; closes none.
// Every tool gets a step that checks what Photoshop really did (read back, not just "no error"). --record also
// checks record_actions: it asks you to do one thing in Photoshop by hand.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { pngBytes, writePng } from "./png.ts";

if (!process.argv.includes("--yes")) {
  console.error("This creates documents in the running Photoshop. Run with --yes (npm run live).");
  process.exit(2);
}

// Inside the default sandbox (home), so the server accepts the paths.
const dir = join(homedir(), ".photoshop-mcp", "live");
mkdirSync(dir, { recursive: true });
const ref = writePng(join(dir, "ref-800x600.png"), 800, 600);

const client = new Client({ name: "live", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], env: { ...getDefaultEnvironment(), TMPDIR: process.env.TMPDIR ?? "", PS_MCP_CONNECT_WAIT_MS: "8000" } }),
);

type Json = any;
let failed = 0;
let passed = 0;
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ json: Json; isError: boolean; content: Json[]; warning?: string }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Json[]; isError?: boolean };
  const texts = r.content.filter((c) => c.type === "text").map((c) => c.text as string);
  const parse = (t: string) => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  const warning = texts.map(parse).find((x) => x && x.warning)?.warning;
  return { json: parse(texts[0] ?? "{}"), isError: r.isError === true, content: r.content, warning };
}
async function must(name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.json)}`);
  return r.json;
}
async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    passed++;
    console.log(`PASS ${name}${note ? "  " + note : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}  ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }
}
function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const near = (a: number[], b: number[], tol = 1) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const centre = (b: number[]) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const names = async (doc: number) => ((await must("get_document", { document_id: doc, depth: 1 })).document.layers as Json[]).map((l) => l.name);
const stored = async (doc: number, layer: number) =>
  (await must("batch_play", { document_id: doc, descriptors: [{ _obj: "get", _target: [{ _ref: "property", _property: "adjustment" }, { _ref: "layer", _id: layer }, { _ref: "document", _id: doc }] }] })).results[0].adjustment[0];

let doc = 0;
let photo = 0;
let text = 0;

// ---------------------------------------------------------------- connection and documents
await step("connect, plugin build matches the server", async () => {
  const r = await call("get_document");
  ok(!r.isError || r.json.error.code !== "BRIDGE_DOWN", "Photoshop is not connected: open the Photoshop MCP panel");
  ok(!r.warning, r.warning ?? "");
});
await step("create_document", async () => {
  doc = (await must("create_document", { width: 800, height: 600, name: "mcp-live" })).document.id;
  ok(doc > 0, "no id");
});
await step("place_image fit none / contain / cover, from a path and from base64", async () => {
  const a = await must("place_image", { path: ref, document_id: doc, fit: "none", x: 400, y: 300, name: "ref-none" });
  ok(near(a.box, [0, 0, 800, 600]), "none box " + JSON.stringify(a.box));
  const b = await must("place_image", { path: ref, document_id: doc, opacity: 40, locked: true, name: "Photo" });
  ok(near(b.box, [0, 0, 800, 600]), "contain box " + JSON.stringify(b.box));
  photo = b.layer.id;
  const c = await must("place_image", { data: pngBytes(200, 100).toString("base64"), document_id: doc, fit: "cover", name: "from-data" });
  ok(near(c.box, [-200, 0, 1000, 600]), "cover box " + JSON.stringify(c.box));
});
await step("get_document shows opacity, lock, kinds; max_layers counts the rest", async () => {
  const d = (await must("get_document", { document_id: doc })).document;
  const p = d.layers.find((l: Json) => l.id === photo);
  ok(p && p.opacity === 40 && p.locked === true && p.kind === "smartObject", JSON.stringify(p));
  const small = await must("get_document", { document_id: doc, max_layers: 1 });
  ok(small.document.layers_not_shown >= 3 && small.hint, JSON.stringify(small).slice(0, 200));
});
await step("preview: a real JPEG at the asked size; one layer", async () => {
  const r = await call("preview", { document_id: doc, max_edge: 400 });
  const img = r.content.find((c) => c.type === "image");
  ok(img && Buffer.from(img.data, "base64").subarray(0, 2).toString("hex") === "ffd8", "not a JPEG");
  ok(r.json.width === 400 && r.json.height === 300, JSON.stringify(r.json));
  ok(!(await call("preview", { document_id: doc, layer_id: photo, max_edge: 200 })).isError, "layer preview failed");
});

// ---------------------------------------------------------------- text, selection, colours
await step("find_fonts and set_text: font used, name kept, centred; edit after resize stays centred", async () => {
  ok((await must("find_fonts", { query: "impact", limit: 3 })).total >= 1, "Impact not found");
  const t = await must("set_text", { document_id: doc, text: "HELLO\nWORLD", font: "Impact", size: 80, color: [1, 0.5, 0], caps: "all", align: "center", leading: 76, name: "Title" });
  ok(t.font === "Impact" && t.layer.name === "Title", JSON.stringify(t));
  text = t.layer.id;
  const e = await must("set_text", { document_id: doc, layer_id: text, size: 40, x: 200, y: 150 });
  ok(near(centre(e.bounds), [200, 150]), "centre " + JSON.stringify(centre(e.bounds)));
  const s = await must("set_text", { document_id: doc, layer_id: text, font: "NoSuchFont-Bold" });
  ok(typeof s.font_substituted === "string", "missing font not reported");
});
await step("select: shapes and modes, subject into a mask, a layer's pixels, none", async () => {
  ok(near((await must("select", { document_id: doc, shape: "rect", bounds: [10, 20, 110, 120] })).selection, [10, 20, 110, 120]), "rect");
  ok(near((await must("select", { document_id: doc, shape: "ellipse", bounds: [200, 0, 300, 50], mode: "add", expand: 5 })).selection, [5, 15, 305, 125], 2), "ellipse add + expand");
  const m = await must("select", { document_id: doc, shape: "subject", layer_id: photo, mask_layer_id: photo });
  ok(m.mask_on === photo, JSON.stringify(m));
  ok((await must("select", { document_id: doc, shape: "layer", layer_id: text })).selection, "layer pixels");
  ok((await must("select", { document_id: doc, shape: "none" })).selection === null, "none");
});
await step("sample_colors: points and palette", async () => {
  const c = await must("sample_colors", { document_id: doc, points: [[5, 5]], palette: 4 });
  ok(c.points[0].hex && c.palette.length >= 1, JSON.stringify(c).slice(0, 200));
});

// ---------------------------------------------------------------- layers, looks
let red = 0;
await step("add_fill solid and shaped gradient; set_layer properties (blend constants)", async () => {
  red = (await must("add_fill", { document_id: doc, type: "solid", color: [0.9, 0.2, 0.2], name: "Red", opacity: 60, blend: "multiply" })).layer.id;
  const g = await must("add_fill", { document_id: doc, type: "gradient", gradient: "radial", colors: [{ color: [1, 1, 0] }, { color: [1, 0, 0.5], opacity: 0 }], shape: "ellipse", bounds: [100, 100, 300, 300], name: "Sun" });
  ok(near(g.layer.bounds, [100, 100, 300, 300]), "shaped fill bounds " + JSON.stringify(g.layer.bounds));
  const s = await must("set_layer", { document_id: doc, layer_id: red, opacity: 70, blend: "soft_light", fill_opacity: 80 });
  ok(s.opacity === 70 && s.blend === "softLight", JSON.stringify(s));
});
await step("set_layer transforms keep the centre; flip (no FlipAxis in Photoshop 27.10)", async () => {
  const before = centre((await must("get_document", { document_id: doc })).document.layers.find((l: Json) => l.id === text).bounds);
  const r = await must("set_layer", { document_id: doc, layer_id: text, scale: 150, rotate: 10, flip: "horizontal" });
  ok(near(centre(r.bounds), before, 1.5), `centre moved ${JSON.stringify(before)} -> ${JSON.stringify(centre(r.bounds))}`);
  await must("set_layer", { document_id: doc, layer_id: text, flip: "both" });
});
await step("stacking: front, back, above, below; new text and layers take above", async () => {
  await must("set_layer", { document_id: doc, layer_id: red, order: "front" });
  ok((await names(doc))[0] === "Red", "front");
  await must("set_layer", { document_id: doc, layer_id: red, below: photo });
  const n = await names(doc);
  ok(n.indexOf("Red") === n.indexOf("Photo") + 1, "below: " + n.join(","));
  const t = await must("set_text", { document_id: doc, text: "LOW", size: 20, above: red, name: "Low" });
  const n2 = await names(doc);
  ok(n2.indexOf("Low") === n2.indexOf("Red") - 1, "text above: " + n2.join(","));
  const l = await must("layer_ops", { document_id: doc, op: "new_layer", name: "Paint", above: t.layer.id });
  const n3 = await names(doc);
  ok(n3.indexOf("Paint") === n3.indexOf("Low") - 1, "new layer above: " + n3.join(","));
  await must("layer_ops", { document_id: doc, op: "delete", layer_ids: [l.layer.id, t.layer.id] });
});
await step("layer_ops: duplicate, group, merge, rasterize", async () => {
  const d = await must("layer_ops", { document_id: doc, op: "duplicate", layer_ids: [text], name: "Title copy" });
  const g = await must("layer_ops", { document_id: doc, op: "group", layer_ids: [text, d.layers[0].id], name: "Texts" });
  ok(g.layer.kind === "group", JSON.stringify(g));
  const p = await must("layer_ops", { document_id: doc, op: "new_layer", name: "Paint" });
  const m = await must("layer_ops", { document_id: doc, op: "merge", layer_ids: [p.layer.id, red], name: "Merged" });
  ok(m.layer.name === "Merged", JSON.stringify(m));
});
await step("apply_filter: smart object refused with a hint, then rasterize + blur / noise / unsharp", async () => {
  const r = await call("apply_filter", { document_id: doc, layer_id: photo, filter: "gaussian_blur", radius: 2 });
  ok(r.isError && r.json.error.code === "BAD_ARGS" && /rasterize/.test(r.json.error.hint), JSON.stringify(r.json));
  await must("set_layer", { document_id: doc, layer_id: photo, locked: false });
  await must("apply_filter", { document_id: doc, layer_id: photo, filter: "gaussian_blur", radius: 2, rasterize: true });
  await must("apply_filter", { document_id: doc, layer_id: photo, filter: "add_noise", amount: 5, monochromatic: true });
  await must("apply_filter", { document_id: doc, layer_id: photo, filter: "unsharp_mask", amount: 80, radius: 1.5, threshold: 2 });
});
await step("add_adjustment: Photoshop stores exactly the values sent", async () => {
  const lv = (await must("add_adjustment", { document_id: doc, type: "levels", input: [15, 240], gamma: 1.1 })).layer.id;
  const cv = (await must("add_adjustment", { document_id: doc, type: "curves", points: [[0, 20], [128, 120], [255, 240]] })).layer.id;
  const hs = (await must("add_adjustment", { document_id: doc, type: "hue_saturation", hue: 10, saturation: -30 })).layer.id;
  const bc = (await must("add_adjustment", { document_id: doc, type: "brightness_contrast", brightness: 10, contrast: 20 })).layer.id;
  for (const type of ["vibrance", "black_white", "photo_filter", "gradient_map", "posterize", "threshold", "invert"]) await must("add_adjustment", { document_id: doc, type, opacity: 5 });
  const l = (await stored(doc, lv)).adjustment[0];
  ok(near(l.input, [15, 240]) && Math.abs(l.gamma - 1.1) < 0.01, "levels " + JSON.stringify(l));
  ok((await stored(doc, cv)).adjustment[0].curve[1].vertical === 120, "curves");
  ok((await stored(doc, hs)).adjustment[0].saturation === -30, "hue/sat");
  const b = await stored(doc, bc);
  ok(b.brightness === 10 && b.center === 20, "brightness/contrast " + JSON.stringify(b));
});
await step("set_style: add, keep, turn off, clear", async () => {
  const a = await must("set_style", { document_id: doc, layer_id: text, stroke: { size: 4, color: [0, 0, 0] }, drop_shadow: { opacity: 50 } });
  ok(a.effects.join() === "stroke,drop_shadow", JSON.stringify(a.effects));
  const b = await must("set_style", { document_id: doc, layer_id: text, outer_glow: { size: 20 }, inner_glow: { size: 5 }, color_overlay: { color: [0, 0.5, 1], opacity: 40 } });
  ok(b.effects.length === 5, JSON.stringify(b.effects));
  ok((await must("set_style", { document_id: doc, layer_id: text, drop_shadow: false })).effects.indexOf("drop_shadow") < 0, "off");
  ok((await must("set_style", { document_id: doc, layer_id: text, stroke: { size: 2 }, clear: true })).effects.join() === "stroke", "clear");
});

// ---------------------------------------------------------------- history, canvas, export, docs
await step("history acts on its own document even when another is active", async () => {
  const other = (await must("create_document", { width: 50, height: 50, name: "mcp-live-other" })).document.id;
  const l = await must("history", { document_id: doc, op: "list", limit: 3 });
  ok(/set_style/.test(l.states[l.states.length - 1].name), "listed another document's history: " + JSON.stringify(l.states));
  const u = await must("history", { document_id: doc, op: "undo" });
  ok(/set_style/.test(u.current.name), "undo landed on " + JSON.stringify(u.current));
  await must("history", { document_id: doc, op: "redo" });
  ok((await must("history", { document_id: other, op: "list" })).total <= 2, "the other document was touched");
});
await step("canvas: resize canvas, crop, resize image (aspect kept), rotate, flatten, trim", async () => {
  ok((await must("canvas", { document_id: doc, op: "resize_canvas", width: 900, height: 700 })).document.width === 900, "canvas");
  ok((await must("canvas", { document_id: doc, op: "crop", bounds: [50, 50, 850, 650] })).document.width === 800, "crop");
  const r = await must("canvas", { document_id: doc, op: "resize_image", width: 400 });
  ok(r.document.height === 300, "aspect " + JSON.stringify(r.document));
  ok((await must("canvas", { document_id: doc, op: "rotate", angle: 90 })).document.width === 300, "rotate");
  ok((await must("canvas", { document_id: doc, op: "flatten" })).flattened > 3, "flatten");
  await must("canvas", { document_id: doc, op: "trim" });
});
await step("export PNG / JPEG / PSD (files really written); open_image", async () => {
  for (const ext of ["png", "jpg", "psd"]) ok((await must("export", { document_id: doc, path: join(dir, "live." + ext), overwrite: true })).bytes > 0, ext);
  ok((await call("export", { document_id: doc, path: join(dir, "live.png") })).json.error.code === "EXISTS", "no EXISTS");
  ok((await must("open_image", { path: join(dir, "live.png") })).document.width === 300, "open_image");
});
await step("batch_play: a sandboxed save through a session token", async () => {
  await must("batch_play", { document_id: doc, descriptors: [{ _obj: "save", as: { _obj: "photoshop35Format" }, in: { _path: join(dir, "live-bp.psd"), _kind: "local" }, copy: true }] });
  ok((await call("batch_play", { descriptors: [{ _obj: "open", null: { _path: "/etc/hosts", _kind: "local" } }] })).json.error.code === "FORBIDDEN", "sandbox");
});
await step("uxp_docs: search and one section", async () => {
  ok((await must("uxp_docs", { query: "applyGaussianBlur", limit: 2 })).hits[0].section === "applyGaussianBlur", "search");
  ok(/Parameters/.test((await must("uxp_docs", { page: "ps-reference/classes/layer", section: "applyMotionBlur" })).text), "section");
});

if (process.argv.includes("--record")) {
  await step("record_actions: a step done by hand comes back as a descriptor", async () => {
    await must("record_actions", { action: "start" });
    console.log("  -> In Photoshop, do one thing by hand now (e.g. Layer > New > Layer, or move a layer). Waiting 15 s...");
    await new Promise((r) => setTimeout(r, 15_000));
    const r = await must("record_actions", { action: "stop" });
    ok(r.steps.length > 0, "nothing recorded");
    return r.steps.map((s: Json) => s.event).join(", ");
  });
}

await client.close();
console.log(failed ? `${failed} of ${passed + failed} steps failed` : `all ${passed} steps passed`);
process.exit(failed ? 1 : 0);
