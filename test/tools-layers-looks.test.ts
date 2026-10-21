// Layers, canvas, history, filters, fills, adjustments and styles: plugin commands against the fake Photoshop.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "./plugin-harness.ts";
import { writePng } from "./png.ts";

const pngDir = mkdtempSync(join(tmpdir(), "psmcp-layers-"));
const writePngIn = (name: string) => writePng(join(pngDir, name), 20, 20);

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

function setup() {
  const p = loadPlugin();
  const a = p.layer({ name: "A", box: { l: 100, t: 100, w: 200, h: 100 } });
  const b = p.layer({ name: "B", box: { l: 0, t: 0, w: 50, h: 50 } });
  const d = p.addDoc({ title: "D", width: 1000, height: 800 });
  d.layers.unshift(a, b);
  return { ...p, d, a, b, bg: d.layers[2] };
}

const centre = (bounds: number[]) => [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];

test("set_layer: properties with Photoshop's own blend constants; strings are not accepted by the fake", async () => {
  const { plugin, a } = setup();
  const r = await plugin.commands.set_layer({ layer_id: a.id, name: "Hero", opacity: 40, fill_opacity: 70, blend: "soft_light", visible: false, locked: true, clip: true });
  assert.deepEqual([a.name, a.opacity, a.fillOpacity, a.blendMode, a.visible, a.allLocked, a.isClippingMask], ["Hero", 40, 70, "softLight", false, true, true]);
  assert.equal(r.blend, "softLight");
  assert.equal(r.opacity, 40);
  await rejects(plugin.commands.set_layer({ layer_id: a.id, blend: "sparkly" }), "BAD_ARGS");
});

test("set_layer unlocks a layer that is not selected (the lock follows the selection) before other changes", async () => {
  const { plugin, d, a, b } = setup();
  d.activeLayers = [a];
  await plugin.commands.set_layer({ layer_id: a.id, locked: true });
  d.activeLayers = [b]; // another layer selected, as after a merge
  const r = await plugin.commands.set_layer({ layer_id: a.id, locked: false, opacity: 30 });
  assert.equal(a.allLocked, false, "unlocked");
  assert.equal(a.opacity, 30, "and the opacity applied (a locked layer ignores it)");
  assert.equal(r.locked, undefined);
  const l = await plugin.commands.set_layer({ layer_id: a.id, opacity: 60, locked: true });
  assert.deepEqual([a.opacity, a.allLocked, l.locked], [60, true, true], "opacity before the lock");
});

test("apply_filter rasterizes a locked smart object for real instead of making a smart filter", async () => {
  const { plugin, d, b, layer } = setup();
  const so = layer({ name: "Smart", kind: "smartObject", box: { l: 0, t: 0, w: 10, h: 10 } });
  d.layers.unshift(so);
  d.activeLayers = [so];
  await plugin.commands.set_layer({ layer_id: so.id, locked: true });
  d.activeLayers = [b];
  const r = await plugin.commands.apply_filter({ layer_id: so.id, filter: "gaussian_blur", radius: 2, rasterize: true });
  assert.equal(r.layer.kind, "pixel");
  assert.equal(so.smartFilters, undefined, "no smart filter");
  assert.deepEqual(so.filters, ["applyGaussianBlur [2]"]);
});

test("set_layer clip: no change when it already is as asked (Photoshop throws on that)", async () => {
  const { plugin, a } = setup();
  await plugin.commands.set_layer({ layer_id: a.id, clip: false });
  await plugin.commands.set_layer({ layer_id: a.id, clip: true });
  await plugin.commands.set_layer({ layer_id: a.id, clip: true });
  assert.equal(a.isClippingMask, true);
});

test("place_image above a given layer", async () => {
  const { plugin, d, a, b } = setup();
  d.activeLayers = [a];
  const r = await plugin.commands.place_image({ path: writePngIn("p.png"), fit: "none", above: b.id, source_width: 20, source_height: 20 });
  assert.equal(d.layers[d.layers.findIndex((l) => l.id === b.id) - 1].id, r.layer.id);
});

test("set_layer: scale and rotate keep the centre (Photoshop's own anchor can't be trusted); x,y and dx,dy move", async () => {
  const { plugin, a } = setup();
  const before = centre([a.bounds.left, a.bounds.top, a.bounds.right, a.bounds.bottom]);
  const r = await plugin.commands.set_layer({ layer_id: a.id, scale: 50, rotate: 90, flip: "horizontal" });
  assert.deepEqual(centre(r.bounds), before);
  assert.equal(r.bounds[2] - r.bounds[0], 50, "100 tall at 50% is 50 wide after a quarter turn");
  const moved = await plugin.commands.set_layer({ layer_id: a.id, x: 500, y: 400 });
  assert.deepEqual(centre(moved.bounds), [500, 400]);
  const nudged = await plugin.commands.set_layer({ layer_id: a.id, dx: 10, dy: -5 });
  assert.deepEqual(centre(nudged.bounds), [510, 395]);
  const both = await plugin.commands.set_layer({ layer_id: a.id, scale: [200, 100], x: 100, y: 100 });
  assert.deepEqual(centre(both.bounds), [100, 100], "scale then the given centre");
});

test("set_layer: stacking order and the Background layer", async () => {
  const { plugin, d, a, b, bg } = setup();
  await plugin.commands.set_layer({ layer_id: b.id, order: "front" });
  assert.deepEqual(d.layers.map((l) => l.name), ["B", "A", "Background"]);
  await plugin.commands.set_layer({ layer_id: b.id, order: "back" });
  assert.deepEqual(d.layers.map((l) => l.name), ["A", "B", "Background"], "back stays above the Background layer");
  await plugin.commands.set_layer({ layer_id: b.id, above: a.id });
  assert.deepEqual(d.layers.map((l) => l.name), ["B", "A", "Background"]);
  await plugin.commands.set_layer({ layer_id: b.id, below: a.id });
  assert.deepEqual(d.layers.map((l) => l.name), ["A", "B", "Background"]);
  await rejects(plugin.commands.set_layer({ layer_id: b.id, into: a.id }), "BAD_ARGS");
  const e = await rejects(plugin.commands.set_layer({ layer_id: bg.id, x: 5 }), "BAD_ARGS");
  assert.match(e.hint, /Duplicate/);
  await rejects(plugin.commands.set_layer({ layer_id: 9999, opacity: 5 }), "NOT_FOUND");
});

test("layer_ops: new, duplicate, group, merge, rasterize, delete, and their errors", async () => {
  const { plugin, d, a, b } = setup();
  const n = await plugin.commands.layer_ops({ op: "new_layer", name: "Paint" });
  assert.equal(n.layer.name, "Paint");
  const g0 = await plugin.commands.layer_ops({ op: "new_group", name: "Empty" });
  assert.equal(g0.layer.kind, "group");
  const dup = await plugin.commands.layer_ops({ op: "duplicate", layer_ids: [a.id], name: "A2" });
  assert.equal(dup.layers[0].name, "A2");
  const g = await plugin.commands.layer_ops({ op: "group", layer_ids: [a.id, b.id], name: "Pair" });
  assert.deepEqual(g.grouped, [a.id, b.id]);
  assert.equal(d.layers.find((l) => l.name === "Pair")!.layers!.length, 2);
  const m = await plugin.commands.layer_ops({ op: "merge", layer_ids: [n.layer.id, dup.layers[0].id], name: "Merged" });
  assert.deepEqual(m.merged, [n.layer.id, dup.layers[0].id]);
  assert.equal(m.layer.name, "Merged");
  await rejects(plugin.commands.layer_ops({ op: "merge", layer_ids: [a.id] }), "BAD_ARGS");
  await rejects(plugin.commands.layer_ops({ op: "duplicate" }), "BAD_ARGS");
  const del = await plugin.commands.layer_ops({ op: "delete", layer_ids: [m.layer.id] });
  assert.deepEqual(del.deleted, [m.layer.id], "the result says what was removed");
  assert.ok(!d.layers.some((l) => l.id === m.layer.id));
});

test("canvas: crop, resize (aspect kept), canvas size, trim, rotate, flatten; missing values are BAD_ARGS", async () => {
  const { plugin, d, state } = setup();
  assert.deepEqual((await plugin.commands.canvas({ op: "crop", bounds: [0, 0, 500, 400] })).document.width, 500);
  const r = await plugin.commands.canvas({ op: "resize_image", width: 250 });
  assert.deepEqual([r.document.width, r.document.height], [250, 200]);
  assert.deepEqual(r.was, { width: 500, height: 400 });
  assert.deepEqual((await plugin.commands.canvas({ op: "resize_canvas", width: 300, height: 300 })).document.height, 300);
  await plugin.commands.canvas({ op: "trim" });
  assert.ok(state.calls.some((c) => c.startsWith("trim")));
  await plugin.commands.canvas({ op: "rotate", angle: 90 });
  const f = await plugin.commands.canvas({ op: "flatten" });
  assert.equal(f.flattened, 3, "the result says how many layers were flattened");
  assert.equal(d.layers.length, 1);
  await rejects(plugin.commands.canvas({ op: "crop" }), "BAD_ARGS");
  await rejects(plugin.commands.canvas({ op: "resize_image" }), "BAD_ARGS");
  await rejects(plugin.commands.canvas({ op: "resize_canvas", width: 5 }), "BAD_ARGS");
  await rejects(plugin.commands.canvas({ op: "rotate" }), "BAD_ARGS");
});

test("history: each command is one state; undo, redo and go move through them", async () => {
  const { plugin, a } = setup();
  await plugin.commands.set_layer({ layer_id: a.id, opacity: 50 });
  await plugin.commands.set_layer({ layer_id: a.id, opacity: 20 });
  const l = await plugin.commands.history({ op: "list" });
  assert.deepEqual(l.states.map((s: { name: string }) => s.name), ["Open", "MCP set_layer", "MCP set_layer"]);
  assert.equal(l.states[2].current, true);
  const u = await plugin.commands.history({ op: "undo", steps: 2 });
  assert.equal(u.current.name, "Open");
  assert.equal((await plugin.commands.history({ op: "redo" })).current.id, l.states[1].id);
  assert.equal((await plugin.commands.history({ op: "go", state_id: l.states[2].id })).current.id, l.states[2].id);
  await rejects(plugin.commands.history({ op: "undo", steps: 5 }), "BAD_ARGS");
  await rejects(plugin.commands.history({ op: "go", state_id: 1 }), "BAD_ARGS");
  assert.equal((await plugin.commands.history({ op: "list" })).states.length, 3, "moving in history adds no state");
});

test("history acts on its own document even when another one is active (Photoshop answers for the active one)", async () => {
  const { plugin, a, d, addDoc, state } = setup();
  await plugin.commands.set_layer({ layer_id: a.id, opacity: 50 });
  const other = addDoc({ title: "Other", width: 10, height: 10 }); // now the active document
  assert.equal(state.active, other);
  const l = await plugin.commands.history({ document_id: d.id, op: "list" });
  assert.deepEqual(l.states.map((s: { name: string }) => s.name), ["Open", "MCP set_layer"]);
  await plugin.commands.history({ document_id: d.id, op: "undo" });
  assert.equal(d.ownActive.name, "Open", "undo happened in D");
  assert.equal(other.ownActive.name, "Open", "and not in the other document");
});

test("set_layer flip goes through Photoshop's flip descriptor (no constants.FlipAxis in Photoshop 27.10)", async () => {
  const { plugin, a, state } = setup();
  await plugin.commands.set_layer({ layer_id: a.id, flip: "both" });
  assert.deepEqual(state.calls.filter((c) => c.startsWith("flip")), ["flip horizontal", "flip vertical"]);
});

test("new layers go above the selected layer unless above is given (seen live: a moved-down layer stays selected)", async () => {
  const { plugin, d, a, b, bg } = setup();
  d.activeLayers = [b];
  const t1 = await plugin.commands.set_text({ text: "x", size: 10 });
  assert.deepEqual(d.layers.map((l) => l.name), ["A", "x", "B", "Background"], "above the selected layer");
  const t2 = await plugin.commands.set_text({ text: "y", size: 10, above: a.id, name: "Y" });
  assert.deepEqual(d.layers.map((l) => l.name), ["Y", "A", "x", "B", "Background"]);
  const n = await plugin.commands.layer_ops({ op: "new_layer", name: "Low", above: bg.id });
  assert.equal(d.layers[d.layers.length - 2].id, n.layer.id);
  const g = await plugin.commands.layer_ops({ op: "new_group", name: "G", above: t1.layer.id });
  assert.equal(d.layers[d.layers.findIndex((l) => l.id === t1.layer.id) - 1].id, g.layer.id);
  // With the group selected Photoshop would nest the new layer inside it; above puts it where asked.
  d.activeLayers = [d.layers.find((l) => l.id === g.layer.id)!];
  const p = await plugin.commands.layer_ops({ op: "new_layer", name: "P", above: a.id });
  assert.equal(d.layers[d.layers.findIndex((l) => l.id === a.id) - 1].id, p.layer.id, "top level, just above A");
  assert.ok(!d.layers.find((l) => l.id === g.layer.id)!.layers!.some((l) => l.id === p.layer.id), "not inside the group");
  void t2;
});

test("apply_filter: runs on pixels; other kinds need rasterize; required parameters checked", async () => {
  const { plugin, a, d, layer } = setup();
  await plugin.commands.apply_filter({ layer_id: a.id, filter: "gaussian_blur", radius: 4 });
  await plugin.commands.apply_filter({ layer_id: a.id, filter: "add_noise", amount: 6, monochromatic: true });
  assert.deepEqual(a.filters, ["applyGaussianBlur [4]", "applyAddNoise [6,true]"]);
  const so = layer({ name: "Smart", kind: "smartObject", box: { l: 0, t: 0, w: 10, h: 10 } });
  d.layers.unshift(so);
  const e = await rejects(plugin.commands.apply_filter({ layer_id: so.id, filter: "sharpen" }), "BAD_ARGS");
  assert.match(e.hint, /rasterize: true/);
  await plugin.commands.apply_filter({ layer_id: so.id, filter: "sharpen", rasterize: true });
  assert.equal(so.kind, "pixel");
  await rejects(plugin.commands.apply_filter({ layer_id: a.id, filter: "motion_blur", angle: 10 }), "BAD_ARGS");
  await rejects(plugin.commands.apply_filter({ layer_id: a.id, filter: "sparkle" }), "BAD_ARGS");
});

test("add_fill: solid and gradient layers, shaped by a selection that becomes the mask, then deselected", async () => {
  const { plugin, d, a } = setup();
  const s = await plugin.commands.add_fill({ type: "solid", color: [1, 0, 0], name: "Red", opacity: 50, blend: "multiply" });
  const red = d.layers.find((l) => l.id === s.layer.id)!;
  assert.deepEqual([red.kind, red.opacity, red.blendMode], ["solidColor", 50, "multiply"]);
  assert.deepEqual(red.descriptor.type.color, { _obj: "RGBColor", red: 255, grain: 0, blue: 0 });
  const g = await plugin.commands.add_fill({
    type: "gradient",
    gradient: "radial",
    colors: [{ color: [1, 1, 0] }, { color: [1, 0, 0.5], opacity: 0 }],
    shape: "ellipse",
    bounds: [100, 100, 300, 300],
    center: [200, 200],
    clip: true,
    above: a.id,
  });
  const sun = d.layers.find((l) => l.id === g.layer.id)!;
  assert.equal(sun.kind, "gradientFill");
  assert.deepEqual(d.masks[sun.id], [100, 100, 300, 300], "the shape is its mask");
  assert.equal(d.selection.bounds, null, "selection dropped afterwards");
  assert.equal(sun.isClippingMask, true);
  const grad = sun.descriptor.type.gradient;
  assert.deepEqual(grad.colors.map((c: { location: number }) => c.location), [0, 4096]);
  assert.deepEqual(grad.transparency.map((t: { opacity: { _value: number } }) => t.opacity._value), [100, 0]);
  assert.deepEqual(sun.descriptor.type.offset.horizontal._value, -30, "centre 200 on a 1000 wide canvas");
  await rejects(plugin.commands.add_fill({ type: "solid" }), "BAD_ARGS");
  await rejects(plugin.commands.add_fill({ type: "gradient", colors: [{ color: [0, 0, 0] }] }), "BAD_ARGS");
  await rejects(plugin.commands.add_fill({ type: "solid", color: [0, 0, 0], shape: "rect" }), "BAD_ARGS");
});

test("add_adjustment: builds each descriptor, clips, rejects unknown types", async () => {
  const { plugin, d } = setup();
  for (const [type, extra] of [
    ["brightness_contrast", { brightness: 10, contrast: 20 }],
    ["hue_saturation", { saturation: -100 }],
    ["vibrance", { vibrance: 30 }],
    ["black_white", { tint: [1, 0.8, 0.6] }],
    ["levels", { input: [20, 235], gamma: 1.2 }],
    ["curves", { points: [[0, 20], [128, 120], [255, 240]] }],
    ["photo_filter", { density: 30 }],
    ["gradient_map", { colors: [{ color: [0, 0, 0.2] }, { color: [1, 0.9, 0.7] }] }],
    ["invert", {}],
    ["posterize", { levels: 5 }],
    ["threshold", { level: 100 }],
  ] as const) {
    const r = await plugin.commands.add_adjustment({ type, clip: type === "curves", ...extra });
    const L = d.layers.find((l) => l.id === r.layer.id)!;
    assert.ok(L.descriptor.type._obj, type);
    assert.equal(L.isClippingMask, type === "curves");
  }
  const curves = d.layers.find((l) => l.descriptor && l.descriptor.type._obj === "curves")!;
  assert.deepEqual(curves.descriptor.type.adjustment[0].curve[1], { _obj: "paint", horizontal: 128, vertical: 120 });
  await rejects(plugin.commands.add_adjustment({ type: "glow" }), "BAD_ARGS");
});

test("set_style: adds effects, keeps the others, turns one off, clear turns off the rest", async () => {
  const { plugin, a, bg } = setup();
  const r1 = await plugin.commands.set_style({ layer_id: a.id, stroke: { size: 12, color: [1, 1, 1] }, drop_shadow: { opacity: 40 } });
  assert.deepEqual(r1.effects, ["stroke", "drop_shadow"]);
  assert.equal(a.effects.frameFX.size._value, 12);
  assert.equal(a.effects.frameFX.style._value, "outsideFrame");
  const r2 = await plugin.commands.set_style({ layer_id: a.id, outer_glow: { size: 40, color: [1, 0.6, 0.2] } });
  assert.deepEqual(r2.effects, ["stroke", "drop_shadow", "outer_glow"], "earlier effects kept");
  const r3 = await plugin.commands.set_style({ layer_id: a.id, drop_shadow: false });
  assert.deepEqual(r3.effects, ["stroke", "outer_glow"]);
  const r4 = await plugin.commands.set_style({ layer_id: a.id, color_overlay: { color: [0, 0, 1], opacity: 30 }, clear: true });
  assert.deepEqual(r4.effects, ["color_overlay"]);
  await rejects(plugin.commands.set_style({ layer_id: bg.id, stroke: {} }), "BAD_ARGS");
});
