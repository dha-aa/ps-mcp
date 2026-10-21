// Text, selection, colours, export and recording: plugin commands against the fake, and the server tools end to end.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { palette } from "../src/palette.ts";
import { loadPlugin } from "./plugin-harness.ts";

async function rejects(p: Promise<unknown>, code: string): Promise<Record<string, string>> {
  try {
    await p;
  } catch (e) {
    const err = e as Record<string, string>;
    assert.equal(err.code, code, JSON.stringify(err));
    return err;
  }
  assert.fail(`expected ${code}`);
}

function docWith() {
  const p = loadPlugin();
  const d = p.addDoc({ title: "D", width: 1000, height: 500 });
  return { ...p, d };
}

test("set_text creates centred text with Photoshop's own enums and SolidColor", async () => {
  const { plugin, d, state } = docWith();
  const r = await plugin.commands.set_text({ text: "PHOTO\nGRAPHER", font: "Impact", size: 100, color: [1, 1, 1], caps: "all", align: "center", leading: 90, tracking: -10, name: "Title" });
  assert.equal(r.font, "Impact");
  assert.equal(r.size, 100);
  assert.deepEqual(r.color, [1, 1, 1]);
  assert.equal(r.font_substituted, undefined);
  const [l, t, rr, b] = r.bounds;
  assert.ok(Math.abs((l + rr) / 2 - 500) < 0.01 && Math.abs((t + b) / 2 - 250) < 0.01, "centred on the canvas");
  const L = d.layers[0] as unknown as { name: string; textItem: { contents: string } };
  assert.equal(L.name, "Title");
  assert.equal(L.textItem.contents, "PHOTO\rGRAPHER", "line breaks become \\r");
  assert.deepEqual(state.history.slice(0, 2), [`suspend ${d.id} MCP set_text`, "resume 7 commit"]);
});

test("set_text edits an existing layer, moves it, reports a missing font, rejects non-text layers", async () => {
  const { plugin, d } = docWith();
  const made = await plugin.commands.set_text({ text: "Hi", size: 40 });
  const r = await plugin.commands.set_text({ layer_id: made.layer.id, text: "Hello", font: "NoSuchFont-Bold", x: 100, y: 80 });
  assert.match(r.font_substituted, /NoSuchFont-Bold is not installed/);
  assert.equal(r.font, "MyriadPro-Regular");
  assert.ok(Math.abs((r.bounds[0] + r.bounds[2]) / 2 - 100) < 0.01);
  const bg = d.layers.find((l) => l.isBackgroundLayer)!;
  await rejects(plugin.commands.set_text({ layer_id: bg.id, text: "x" }), "BAD_ARGS");
  await rejects(plugin.commands.set_text({ size: 10 }), "BAD_ARGS");
});

test("set_text centres a resized text even though Photoshop reports stale bounds until it moves", async () => {
  const { plugin } = docWith();
  const made = await plugin.commands.set_text({ text: "b'day", size: 330, x: 830, y: 400 });
  const r = await plugin.commands.set_text({ layer_id: made.layer.id, size: 220, x: 822, y: 300 });
  const [l, t, rr, b] = r.bounds;
  assert.ok(Math.abs((l + rr) / 2 - 822) <= 0.5, `centre x ${(l + rr) / 2}`);
  assert.ok(Math.abs((t + b) / 2 - 300) <= 0.5, `centre y ${(t + b) / 2}`);
});

test("find_fonts filters and limits", async () => {
  const { plugin } = docWith();
  const r = await plugin.commands.find_fonts({ query: "imp", limit: 30 });
  assert.deepEqual(r, { total: 1, fonts: [{ postscript: "Impact", family: "Impact", style: "Regular" }] });
});

test("select: shapes and modes, modifiers, subject, layer pixels, mask from selection", async () => {
  const { plugin, d, layer } = docWith();
  assert.deepEqual((await plugin.commands.select({ shape: "rect", bounds: [10, 20, 110, 120] })).selection, [10, 20, 110, 120]);
  assert.deepEqual((await plugin.commands.select({ shape: "ellipse", bounds: [200, 0, 300, 50], mode: "add" })).selection, [10, 0, 300, 120]);
  assert.deepEqual((await plugin.commands.select({ expand: 5 })).selection, [5, -5, 305, 125]);
  assert.deepEqual((await plugin.commands.select({ shape: "polygon", points: [[0, 0], [50, 10], [20, 60]] })).selection, [0, 0, 50, 60]);
  assert.equal((await plugin.commands.select({ shape: "none" })).selection, null);

  const photo = layer({ name: "Photo", box: { l: 100, t: 100, w: 400, h: 400 } });
  d.layers.unshift(photo);
  const subj = await plugin.commands.select({ shape: "subject", layer_id: photo.id, mask_layer_id: photo.id });
  assert.equal(subj.mask_on, photo.id);
  assert.deepEqual(d.masks[photo.id], [200, 200, 400, 500], "mask from Select Subject on that layer");
  assert.equal(d.selection.bounds, null, "selection dropped after making the mask");

  assert.deepEqual((await plugin.commands.select({ shape: "layer", layer_id: photo.id })).selection, [100, 100, 500, 500]);

  await rejects(plugin.commands.select({ shape: "rect" }), "BAD_ARGS");
  await rejects(plugin.commands.select({ shape: "polygon", points: [[0, 0]] }), "BAD_ARGS");
  await rejects(plugin.commands.select({ shape: "layer" }), "BAD_ARGS");
  await plugin.commands.select({ shape: "none" });
  await rejects(plugin.commands.select({ mask_layer_id: photo.id }), "BAD_ARGS");
});

test("sample_points and thumbnail pixels", async () => {
  const { plugin } = docWith();
  assert.deepEqual((await plugin.commands.sample_points({ points: [[10, 10], [900, 10]] })).colors, [[255, 0, 0], [0, 0, 255]]);
  await rejects(plugin.commands.sample_points({ points: [[1000, 0]] }), "BAD_ARGS");
  const t = await plugin.commands.thumbnail_pixels({ size: 100 });
  assert.deepEqual([t.width, t.height, t.components], [100, 50, 3]);
  const bytes = Buffer.from(t.data, "base64");
  assert.equal(bytes.length, 100 * 50 * 3, "base64 round-trips");
  assert.deepEqual([...bytes.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...bytes.subarray(bytes.length - 3)], [0, 0, 255]);
});

test("palette: main colours by share, ignores transparent pixels, handles fewer colours than asked", () => {
  const px: number[] = [];
  for (let i = 0; i < 70; i++) px.push(250, 10, 10);
  for (let i = 0; i < 30; i++) px.push(10, 10, 240);
  const p = palette(new Uint8Array(px), 3, 4);
  assert.equal(p.length, 2);
  assert.deepEqual(p.map((s) => s.hex), ["#fa0a0a", "#0a0af0"]);
  assert.deepEqual(p.map((s) => s.share), [0.7, 0.3]);
  const rgba = new Uint8Array([255, 255, 255, 0, 0, 255, 0, 255]);
  assert.deepEqual(palette(rgba, 4, 3).map((s) => s.hex), ["#00ff00"]);
  assert.deepEqual(palette(new Uint8Array([]), 3, 3), []);
});

test("export: saves through a File entry, as a copy by default", async () => {
  const { plugin, state } = docWith();
  const dir = mkdtempSync(join(tmpdir(), "psmcp-export-"));
  const r = await plugin.commands.export({ path: join(dir, "a.jpg"), format: "jpg", quality: 8 });
  assert.equal(r.format, "jpg");
  assert.ok(existsSync(join(dir, "a.jpg")));
  assert.deepEqual(JSON.parse(JSON.stringify(state.saved[0])), { path: join(dir, "a.jpg"), format: "jpg", asCopy: true, options: { quality: 8 } });
  await rejects(plugin.commands.export({ path: join(dir, "nope", "a.png"), format: "png" }), "NOT_FOUND");
});

test("record_actions: user steps recorded, our own commands not, stop unsubscribes", async () => {
  const { plugin, emit, state } = docWith();
  await rejects(plugin.commands.record_actions({ action: "stop" }), "BAD_ARGS");
  const s = await plugin.commands.record_actions({ action: "start" });
  assert.ok(s.events > 200);
  emit("make", { _obj: "make", new: { _class: "layer" } });
  emit("gaussianBlur", { _obj: "gaussianBlur", radius: { _unit: "pixelsUnit", _value: 4 } });
  const peek = await plugin.commands.record_actions({ action: "peek" });
  assert.equal(peek.steps.length, 2);
  assert.equal(peek.recording, true);
  const out = await plugin.commands.record_actions({ action: "stop" });
  assert.deepEqual(out.steps.map((x: { event: string }) => x.event), ["make", "gaussianBlur"]);
  assert.equal(out.recording, false);
  emit("make", {});
  assert.equal([...state.listeners.values()].reduce((n, set) => n + set.size, 0), 0, "all listeners removed");
});
