// The plugin's commands against the fake Photoshop (test/fake-ps.ts), run from the built plugin/js/main.js.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlugin } from "./plugin-harness.ts";
import { writePng } from "./png.ts";

const dir = mkdtempSync(join(tmpdir(), "psmcp-plugin-"));
const wide = writePng(join(dir, "wide.png"), 4000, 2000);
const small = writePng(join(dir, "small.png"), 200, 100);

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

test("get_document: no document, then defaults left out and the tree shown", async () => {
  const { plugin, addDoc, layer } = loadPlugin();
  assert.deepEqual(await plugin.commands.get_document({}), { documents: [] });
  await rejects(plugin.commands.get_document({ document_id: 5 }), "NOT_FOUND");

  const g = layer({ name: "Group", kind: "group", blendMode: "passThrough", box: { l: 0, t: 0, w: 10, h: 10 } });
  g.layers = [layer({ name: "Inner", opacity: 50, blendMode: "multiply", box: { l: 1, t: 2, w: 3, h: 4 } })];
  const d = addDoc({ title: "A", width: 100, height: 50, layers: [g, layer({ name: "Hidden", visible: false, box: { l: 0, t: 0, w: 1, h: 1 } })] });
  const r = await plugin.commands.get_document({});
  assert.deepEqual(r.document.layers[0], {
    id: g.id,
    name: "Group",
    kind: "group",
    bounds: [0, 0, 10, 10],
    layers: [{ id: g.layers[0].id, name: "Inner", kind: "pixel", opacity: 50, blend: "multiply", bounds: [1, 2, 4, 6] }],
  });
  assert.equal(r.document.layers[1].visible, false);
  assert.equal(r.document.unsaved, true);
  assert.equal(r.document.mode, undefined, "RGB is the default and left out");
  assert.equal(r.documents, undefined, "one document: no list");

  const shallow = await plugin.commands.get_document({ depth: 1 });
  assert.equal(shallow.document.layers[0].layers, undefined);
  assert.equal(shallow.document.layers[0].layer_count, 1);

  const d2 = addDoc({ title: "B", width: 10, height: 10 });
  const both = await plugin.commands.get_document({ document_id: d.id });
  assert.deepEqual(both.documents.map((x: { id: number }) => x.id), [d.id, d2.id]);
  assert.equal(both.active_id, d2.id);
});

test("create_document runs in a modal scope and passes fill", async () => {
  const { plugin, state } = loadPlugin();
  const r = await plugin.commands.create_document({ width: 1080, height: 1920, resolution: 72, fill: "transparent" });
  assert.deepEqual(r.document, { id: r.document.id, title: "Untitled-1", width: 1080, height: 1920, resolution: 72 });
  assert.ok(state.calls.includes("createDocument 1080x1920 transparent"));
});

test("busy Photoshop gives BUSY with a hint", async () => {
  const { plugin, state } = loadPlugin();
  state.busy = true;
  const e = await rejects(plugin.commands.create_document({ width: 10, height: 10, resolution: 72, fill: "white" }), "BUSY");
  assert.match(e.hint, /dialog/);
});

test("a change made outside executeAsModal is PS_ERROR, not BUSY", async () => {
  const { plugin, addDoc } = loadPlugin();
  const d = addDoc({ title: "A", width: 10, height: 10 });
  const L = d.layers[0] as unknown as { name: string };
  const e = await plugin.toErr((() => {
    try {
      L.name = "x";
    } catch (err) {
      return err;
    }
  })());
  assert.equal(e.code, "PS_ERROR");
});

test("open_image opens the file; a missing file is NOT_FOUND", async () => {
  const { plugin } = loadPlugin();
  const r = await plugin.commands.open_image({ path: small });
  assert.equal(r.document.width, 200);
  assert.equal(r.document.title, "small.png");
  await rejects(plugin.commands.open_image({ path: join(dir, "nope.png") }), "NOT_FOUND");
});

for (const [fit, expect] of [
  ["contain", [0, 250, 1000, 750]],
  ["cover", [-500, 0, 1500, 1000]],
  ["stretch", [0, 0, 1000, 1000]],
  ["none", [-1500, -500, 2500, 1500]],
] as const) {
  test(`place_image fit ${fit}, after Photoshop's own resize on place`, async () => {
    const { plugin, addDoc, state } = loadPlugin();
    const d = addDoc({ title: "Canvas", width: 1000, height: 1000 });
    state.placeMargin = 100; // bounds exclude transparent edges; the transform must be used
    const r = await plugin.commands.place_image({ path: wide, fit, source_width: 4000, source_height: 2000 });
    assert.deepEqual(r.box, expect);
    assert.equal(d.layers[0].id, r.layer.id, "placed on top");
    assert.equal(d.layers[0].kind, "smartObject");
    assert.deepEqual(state.history, [`suspend ${d.id} MCP place_image`, "resume 7 commit"], "one undo step");
  });
}

test("place_image: centre at x,y, name, opacity, lock; into a non-active document", async () => {
  const { plugin, addDoc, state } = loadPlugin();
  const target = addDoc({ title: "Target", width: 1000, height: 500 });
  addDoc({ title: "Other", width: 300, height: 300 });
  state.resizeOnPlace = false;
  const r = await plugin.commands.place_image({ path: small, document_id: target.id, fit: "none", x: 100, y: 50, name: "Ref", opacity: 40, locked: true, source_width: 200, source_height: 100 });
  assert.deepEqual(r.box, [0, 0, 200, 100]);
  assert.equal(r.scale, 100);
  const L = target.layers[0];
  assert.deepEqual([L.name, L.opacity, L.allLocked], ["Ref", 40, true]);
  assert.equal(state.active, target);
  assert.ok(!state.calls.some((c) => c.startsWith("scale")), "no scale when the size is already right");
});

test("place_image: a failure rolls the history back; a missing file changes nothing", async () => {
  const { plugin, addDoc, state } = loadPlugin();
  const d = addDoc({ title: "Canvas", width: 100, height: 100 });
  state.failOn = "translate";
  const e = await rejects(plugin.commands.place_image({ path: small, fit: "none", x: 1, y: 1, source_width: 200, source_height: 100 }), "PS_ERROR");
  assert.match(e.message, /translate failed/);
  assert.deepEqual(state.history, [`suspend ${d.id} MCP place_image`, "resume 7 rollback"]);

  state.history.length = 0;
  await rejects(plugin.commands.place_image({ path: join(dir, "missing.png"), fit: "none" }), "NOT_FOUND");
  assert.deepEqual(state.history, [], "caught before any change");
  await rejects(plugin.commands.preview({ layer_id: 99999, max_edge: 100 }), "NOT_FOUND");
});

test("place_image: right size and centre whatever anchor Photoshop scales from", async () => {
  const { plugin, addDoc, state } = loadPlugin();
  addDoc({ title: "Canvas", width: 1000, height: 1000 });
  state.resizeOnPlace = false;
  const r = await plugin.commands.place_image({ path: wide, fit: "contain", x: 300, y: 700, source_width: 4000, source_height: 2000 });
  assert.deepEqual(r.box, [-200, 450, 800, 950]);
  assert.equal(r.scale, 25);
});

test("batch_play: one undo step, results returned, a failing descriptor rolls back", async () => {
  const { plugin, addDoc, state } = loadPlugin();
  const d = addDoc({ title: "A", width: 10, height: 10 });
  const r = await plugin.commands.batch_play({ descriptors: [{ _obj: "autoCutout", big: "x".repeat(100) }, { _obj: "make" }] });
  assert.deepEqual(r, { ran: 2, layer_ids: [42] }, "echoed descriptors are left out");
  const g = await plugin.commands.batch_play({ descriptors: [{ _obj: "get", _target: [{ _ref: "layer", _id: d.layers[0].id }] }] });
  assert.deepEqual(g, { ran: 1, results: [{}] }, "get results are kept");
  assert.deepEqual(state.history.slice(0, 2), [`suspend ${d.id} MCP batch_play`, "resume 7 commit"]);
  state.history.length = 0;
  const e = await rejects(plugin.commands.batch_play({ descriptors: [{ _obj: "make" }, { _obj: "fail" }] }), "PS_ERROR");
  assert.match(e.message, /descriptor failed/);
  assert.deepEqual(state.history, [`suspend ${d.id} MCP batch_play`, "resume 7 rollback"]);
  await rejects(plugin.commands.batch_play({ descriptors: [{ _obj: "make" }], document_id: 999 }), "NOT_FOUND");
});

test("preview: shrinks to max_edge, never enlarges, layer bounds", async () => {
  const { plugin, addDoc, state, layer } = loadPlugin();
  const L = layer({ name: "Box", box: { l: 10, t: 20, w: 300, h: 600 } });
  addDoc({ title: "P", width: 4000, height: 2000, layers: [L] });
  const r = await plugin.commands.preview({ max_edge: 1000 });
  assert.equal(r.width, 1000);
  assert.equal(r.height, 500);
  assert.equal(r.scale, 25);
  assert.ok(typeof r.data === "string" && r.data.length > 10);

  const big = await plugin.commands.preview({ max_edge: 2048, layer_id: L.id });
  assert.equal(big.width, 300, "smaller than max_edge: full size");
  assert.equal(big.scale, undefined);
  assert.deepEqual(big.bounds, [10, 20, 310, 620]);
  assert.ok(!state.calls.find((c) => c.startsWith("getPixels") && c.includes(`"layerID":${L.id}`))!.includes("targetSize"));
});
