// End to end without Photoshop: the built server (dist/index.js) over stdio with a real MCP client, and the
// real plugin (plugin/js/main.js, in a vm with the fake Photoshop) connected to it over a real WebSocket.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadPlugin } from "./plugin-harness.ts";
import { pngBytes, writePng } from "./png.ts";

const EXPECTED_TOOLS = ["add_adjustment", "add_fill", "apply_filter", "batch_play", "canvas", "create_document", "export", "find_fonts", "get_document", "history", "layer_ops", "open_image", "place_image", "preview", "record_actions", "sample_colors", "select", "set_layer", "set_style", "set_text", "uxp_docs"];

const root = mkdtempSync(join(tmpdir(), "psmcp-e2e-"));
const home = join(root, "home");
const bridgeDir = join(home, ".photoshop-mcp", "bridges");
const allowed = join(root, "allowed");
mkdirSync(allowed, { recursive: true });
const ref = writePng(join(allowed, "ref.png"), 800, 600);
const outside = writePng(join(root, "outside.png"), 10, 10);

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface Server {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<{ json: any; isError: boolean; content: any[] }>;
  pid: number;
  close(): Promise<void>;
}

async function startServer(env: Record<string, string> = {}): Promise<Server> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...getDefaultEnvironment(),
      PS_MCP_BRIDGE_DIR: bridgeDir,
      PS_MCP_ALLOWED_DIRS: allowed,
      PS_MCP_CONNECT_WAIT_MS: "300",
      // Never reach GitHub from tests.
      PS_MCP_DOCS_TREE_URL: "http://127.0.0.1:9/tree",
      PS_MCP_DOCS_RAW_URL: "http://127.0.0.1:9",
      PS_MCP_DOCS_DIR: join(root, "docs-cache"),
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(transport);
  const pid = transport.pid!;
  // The bridge file is written before stdio is served, so it exists once connected.
  assert.ok(existsSync(join(bridgeDir, `${pid}.json`)), "bridge file written");
  const s: Server = {
    client,
    pid,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { content: any[]; isError?: boolean };
      const text = r.content.find((c) => c.type === "text")?.text ?? "";
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { json, isError: r.isError === true, content: r.content };
    },
    close: () => client.close(),
  };
  cleanups.push(() => client.close().catch(() => {}));
  return s;
}

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function plugin(build?: string) {
  const p = loadPlugin({ home, build });
  cleanups.push(async () => {
    for (const c of p.plugin.conns.values()) c.ws?.close();
  });
  return p;
}

const openConns = (p: ReturnType<typeof plugin>) => [...p.plugin.conns.values()].filter((c) => c.ws && c.ws.readyState === 1).length;

test("tools, schema strictness and BRIDGE_DOWN without Photoshop", async () => {
  const s = await startServer();
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  for (const t of tools) assert.ok(t.title && t.annotations, `${t.name} has title and annotations`);
  assert.equal(tools.find((t) => t.name === "preview")!.annotations!.readOnlyHint, true);

  const down = await s.call("get_document");
  assert.equal(down.isError, true);
  assert.equal(down.json.error.code, "BRIDGE_DOWN");
  assert.match(down.json.error.hint, /Plugins > Photoshop MCP/);

  const unknown = await s.call("get_document", { nope: 1 });
  assert.equal(unknown.isError, true, "unknown keys are rejected");
  assert.equal(unknown.json.error.code, "BAD_ARGS", "in our error format");
  assert.match(unknown.json.error.message, /nope/);
  const listed = JSON.stringify(tools);
  assert.ok(!listed.includes("$schema") && !listed.includes("\"additionalProperties\":false") && !listed.includes("9007199254740991"), "listing is slimmed");
  console.error(`tools/list: ${tools.length} tools, ${listed.length} characters (~${Math.round(listed.length / 3.6)} tokens)`);
  await s.close();
});

test("plugin connects, full reference-image flow, errors the model can act on", async () => {
  const s = await startServer();
  const p = plugin();
  await p.plugin.scan();
  await until(() => openConns(p) === 1, "plugin connection");

  const first = await s.call("get_document");
  assert.deepEqual(first.json, { documents: [] });
  assert.equal(first.content.length, 1, "same build: no warning");

  const created = await s.call("create_document", { width: 1000, height: 1000 });
  assert.equal(created.isError, false, JSON.stringify(created.json));
  assert.equal(created.json.document.width, 1000);

  // path: the server reads the size, the plugin places and fits it
  const placed = await s.call("place_image", { path: ref, opacity: 40, locked: true, name: "Reference" });
  assert.equal(placed.isError, false, JSON.stringify(placed.json));
  assert.deepEqual(placed.json.box, [0, 125, 1000, 875]);
  const L = p.state.docs[0].layers[0];
  assert.deepEqual([L.name, L.opacity, L.allLocked], ["Reference", 40, true]);

  // data: written to the temp folder (outside the sandbox is fine: the server wrote it)
  const b64 = pngBytes(50, 20).toString("base64");
  const fromData = await s.call("place_image", { data: "data:image/png;base64," + b64, fit: "none", x: 25, y: 10 });
  assert.equal(fromData.isError, false, JSON.stringify(fromData.json));
  assert.deepEqual(fromData.json.box, [0, 0, 50, 20]);

  const opened = await s.call("open_image", { path: ref });
  assert.equal(opened.json.document.width, 800);

  const prev = await s.call("preview", { document_id: created.json.document.id, max_edge: 500 });
  assert.equal(prev.isError, false, JSON.stringify(prev.json));
  assert.deepEqual(prev.json, { width: 500, height: 500, scale: 50 });
  const img = prev.content.find((c) => c.type === "image");
  assert.equal(img.mimeType, "image/jpeg");
  assert.ok(img.data.length > 10);

  const doc = await s.call("get_document", { document_id: created.json.document.id });
  const layers = doc.json.document.layers;
  assert.deepEqual(layers.map((l: { name: string }) => l.name).slice(1), ["Reference", "Background"]);
  assert.deepEqual([layers[1].opacity, layers[1].locked, layers[1].kind], [40, true, "smartObject"]);

  // errors
  const code = async (args: Record<string, unknown>, tool = "place_image") => (await s.call(tool, args)).json.error?.code;
  assert.equal(await code({ path: outside }), "FORBIDDEN");
  assert.equal(await code({ path: "relative/ref.png" }), "BAD_ARGS");
  assert.equal(await code({ path: join(allowed, "missing.png") }), "NOT_FOUND");
  assert.equal(await code({}), "BAD_ARGS");
  assert.equal(await code({ path: ref, data: b64 }), "BAD_ARGS");
  assert.equal(await code({ data: "not base64!!" }), "BAD_ARGS");
  assert.equal(await code({ data: Buffer.from("hello world").toString("base64") }), "BAD_ARGS");
  assert.equal(await code({ path: ref, document_id: 424242 }), "NOT_FOUND");
  assert.equal(await code({ layer_id: 424242 }, "preview"), "NOT_FOUND");
  p.state.busy = true;
  const busy = await s.call("create_document", { width: 10, height: 10 });
  assert.equal(busy.json.error.code, "BUSY");
  assert.ok(busy.json.error.hint);
  p.state.busy = false;
  await s.close();
});

test("a timed-out command is dropped if it hasn't started; disconnects fail running calls", async () => {
  const s = await startServer({ PS_MCP_TIMEOUT_MS: "400" });
  const p = plugin();
  await p.plugin.scan();
  await until(() => openConns(p) === 1, "plugin connection");
  p.state.modalDelayMs = 800;

  const [a, b] = await Promise.all([
    s.call("create_document", { width: 10, height: 10, name: "A" }),
    s.call("create_document", { width: 10, height: 10, name: "B" }),
  ]);
  assert.equal(a.json.error.code, "TIMEOUT");
  assert.equal(b.json.error.code, "TIMEOUT");
  assert.match(a.json.error.hint, /may still finish: check get_document/);
  // Both timed out at 0.4 s while A ran; B would have started at 0.8 s and ended at 1.6 s.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(p.state.calls.filter((c) => c === "modal MCP: create_document").length, 1, "only A started");
  assert.deepEqual(p.state.docs.map((d) => d.title), ["A"], "B was cancelled before it started");

  // plugin goes away mid-command
  p.state.modalDelayMs = 300;
  const pending = s.call("create_document", { width: 10, height: 10, name: "C" });
  await new Promise((r) => setTimeout(r, 100));
  for (const c of p.plugin.conns.values()) c.ws?.close();
  const r = await pending;
  assert.equal(r.json.error.code, "BRIDGE_DOWN");
  assert.match(r.json.error.message, /disconnected while running create_document/);
  await s.close();
});

test("bad token is refused; two servers share one plugin; stale and removed bridge files", async () => {
  // stale file from a dead server: pruned when a server starts
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "999999.json"), JSON.stringify({ pid: 999999, port: 1, token: "x" }));
  const s1 = await startServer();
  assert.ok(!existsSync(join(bridgeDir, "999999.json")), "stale bridge file pruned");
  const s2 = await startServer();

  const info = JSON.parse(readFileSync(join(bridgeDir, `${s1.pid}.json`), "utf8"));
  const refused = await new Promise<string>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=wrong`);
    ws.onopen = () => res("open");
    ws.onerror = () => res("refused");
  });
  assert.equal(refused, "refused");

  const p = plugin();
  await p.plugin.scan();
  await until(() => openConns(p) === 2, "two connections");
  const [r1, r2] = await Promise.all([s1.call("create_document", { width: 5, height: 5, name: "one" }), s2.call("create_document", { width: 5, height: 5, name: "two" })]);
  assert.equal(r1.isError || r2.isError, false);
  assert.deepEqual(p.state.docs.map((d) => d.title).sort(), ["one", "two"]);

  // a server that exits removes its file; the plugin drops that connection on its next scan
  await s1.close();
  await until(() => !existsSync(join(bridgeDir, `${s1.pid}.json`)), "bridge file removed on exit");
  await p.plugin.scan();
  assert.equal(p.plugin.conns.size, 1);
  assert.deepEqual(readdirSync(bridgeDir), [`${s2.pid}.json`]);
  await s2.close();
});

test("an outdated plugin build is reported in every result until it is reloaded", async () => {
  const s = await startServer();
  const p = plugin("0ldbu11d0000");
  await p.plugin.scan();
  await until(() => openConns(p) === 1, "plugin connection");
  const r = await s.call("get_document");
  assert.equal(r.isError, false);
  const w = JSON.parse(r.content[1].text).warning;
  assert.match(w, /older build of the plugin/);
  assert.match(w, /Reload/);
  const bad = await s.call("get_document", { document_id: 1 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[1].text, /older build/, "errors carry it too");
  await s.close();
});

test("slice 1 over the wire: set_text, sample_colors palette and points, export checks", async () => {
  const s = await startServer();
  const p = plugin();
  await p.plugin.scan();
  await until(() => openConns(p) === 1, "plugin connection");
  p.addDoc({ title: "W", width: 100, height: 100 });

  const t = await s.call("set_text", { text: "Hi", font: "Impact", size: 20 });
  assert.equal(t.isError, false, JSON.stringify(t.json));
  assert.equal(t.json.font, "Impact");

  const c = await s.call("sample_colors", { points: [[10, 10], [90, 90]], palette: 2 });
  assert.equal(c.isError, false, JSON.stringify(c.json));
  assert.deepEqual(c.json.points.map((x: { hex: string }) => x.hex), ["#ff0000", "#0000ff"]);
  assert.deepEqual(c.json.points[0].rgb, [1, 0, 0]);
  assert.deepEqual(c.json.palette.map((x: { hex: string; share: number }) => [x.hex, x.share]), [["#0000ff", 0.5], ["#ff0000", 0.5]], "ties sorted by hex");
  const onlyPalette = await s.call("sample_colors", {});
  assert.equal(onlyPalette.json.points, undefined);
  assert.equal(onlyPalette.json.palette.length, 2, "default palette, only 2 colours exist");

  const out = join(allowed, "poster.png");
  const e = await s.call("export", { path: out });
  assert.equal(e.isError, false, JSON.stringify(e.json));
  assert.equal(e.json.format, "png");
  assert.ok(e.json.bytes > 0);
  assert.equal((await s.call("export", { path: out })).json.error.code, "EXISTS");
  assert.equal((await s.call("export", { path: out, overwrite: true })).isError, false);
  assert.equal((await s.call("export", { path: join(root, "outside.png") })).json.error.code, "FORBIDDEN");
  assert.equal((await s.call("export", { path: join(allowed, "x.tiff") })).json.error.code, "BAD_ARGS");
  assert.equal((await s.call("export", { path: join(allowed, "no", "x.png") })).json.error.code, "NOT_FOUND");
  await s.close();
});

test("uxp_docs through the server: arguments checked; no network gives NETWORK with a hint; marked open-world", async () => {
  const s = await startServer();
  const { tools } = await s.client.listTools();
  const t = tools.find((x) => x.name === "uxp_docs")!;
  assert.equal(t.annotations!.openWorldHint, true);
  assert.equal(tools.filter((x) => x.annotations!.openWorldHint).length, 1, "only uxp_docs reaches the network");
  assert.equal((await s.call("uxp_docs", {})).json.error.code, "BAD_ARGS");
  const r = await s.call("uxp_docs", { query: "layer" });
  assert.equal(r.json.error.code, "NETWORK");
  assert.ok(r.json.error.hint);
  await s.close();
});

test("batch_play: file paths are sandboxed on the server and turned into session tokens in the plugin", async () => {
  const s = await startServer();
  const p = plugin();
  await p.plugin.scan();
  await until(() => openConns(p) === 1, "plugin connection");
  p.addDoc({ title: "B", width: 10, height: 10 });
  const out = join(allowed, "saved.psd");
  const ok = await s.call("batch_play", { descriptors: [{ _obj: "save", as: { _obj: "photoshop35Format" }, in: { _path: out, _kind: "local" } }] });
  assert.equal(ok.isError, false, JSON.stringify(ok.json));
  const sent = p.state.calls.find((c) => c.startsWith("batchPlay paths"))!;
  assert.match(sent, /"_path":"tok\d+"/, "the plugin sent a session token, not the path");
  assert.equal((await s.call("batch_play", { descriptors: [{ _obj: "open", null: { _path: outside, _kind: "local" } }] })).json.error.code, "FORBIDDEN");
  assert.equal((await s.call("batch_play", { descriptors: [{ _obj: "open", null: { _path: "rel/x.psd", _kind: "local" } }] })).json.error.code, "BAD_ARGS");
  assert.equal((await s.call("batch_play", { descriptors: [{ _obj: "x", deep: [{ a: { _path: 5 } }] }] })).json.error.code, "BAD_ARGS");
  assert.equal((await s.call("batch_play", { descriptors: [{ _obj: "save", in: { _path: join(allowed, "no", "x.psd") } }] })).json.error.code, "NOT_FOUND");
  await s.close();
});
