// Live check against real Photoshop (not part of npm test): node test/live.ts --yes
// Needs the plugin loaded (UXP Developer Tools) and its panel open. Creates documents; closes none.
// Each step prints PASS/FAIL; the steps check exactly what the fake (test/fake-ps.ts) assumes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { pngBytes, writePng } from "./png.ts";

if (!process.argv.includes("--yes")) {
  console.error("This creates documents in the running Photoshop. Run with --yes.");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "psmcp-live-"));
const ref = writePng(join(dir, "ref-800x600.png"), 800, 600);

const client = new Client({ name: "live", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...getDefaultEnvironment(), TMPDIR: tmpdir(), PS_MCP_CONNECT_WAIT_MS: "8000" } }),
);

let failed = 0;
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
  const text = r.content.find((c) => c.type === "text")?.text ?? "{}";
  return { json: JSON.parse(text), isError: r.isError === true, content: r.content };
}
async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    console.log(`PASS ${name}${note ? "  " + note : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}  ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }
}
function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const near = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1);

let docId = 0;
let refLayer = 0;

await step("connect + get_document (WebSocket, fs.readdir, os.homedir)", async () => {
  const r = await call("get_document");
  ok(!r.isError, JSON.stringify(r.json));
  return `${(r.json.documents ?? []).length || (r.json.document ? 1 : 0)} open`;
});

await step("create_document 1000x1000 white", async () => {
  const r = await call("create_document", { width: 1000, height: 1000, name: "mcp-live" });
  ok(!r.isError, JSON.stringify(r.json));
  docId = r.json.document.id;
  ok(r.json.document.width === 1000 && r.json.document.height === 1000, JSON.stringify(r.json));
});

await step("create_document transparent", async () => {
  const r = await call("create_document", { width: 300, height: 200, fill: "transparent", name: "mcp-live-transparent" });
  ok(!r.isError, JSON.stringify(r.json));
});

await step("place_image fit none (placeEvent, session token, transform, translate)", async () => {
  const r = await call("place_image", { path: ref, document_id: docId, fit: "none", x: 400, y: 300, name: "ref-none" });
  ok(!r.isError, JSON.stringify(r.json));
  ok(near(r.json.box, [0, 0, 800, 600]), "box " + JSON.stringify(r.json.box));
  return JSON.stringify(r.json);
});

await step("place_image fit contain, opacity 40, locked (scale middleCenter)", async () => {
  const r = await call("place_image", { path: ref, document_id: docId, opacity: 40, locked: true, name: "ref-contain" });
  ok(!r.isError, JSON.stringify(r.json));
  ok(near(r.json.box, [0, 125, 1000, 875]), "box " + JSON.stringify(r.json.box));
  refLayer = r.json.layer.id;
  return JSON.stringify(r.json);
});

await step("place_image from base64 data, fit cover", async () => {
  const r = await call("place_image", { data: pngBytes(200, 100).toString("base64"), document_id: docId, fit: "cover" });
  ok(!r.isError, JSON.stringify(r.json));
  ok(near(r.json.box, [-500, 0, 1500, 1000]), "box " + JSON.stringify(r.json.box));
});

await step("get_document shows the layers with opacity and lock", async () => {
  const r = await call("get_document", { document_id: docId });
  ok(!r.isError, JSON.stringify(r.json));
  const L = r.json.document.layers.find((l: { id: number }) => l.id === refLayer);
  ok(L && L.opacity === 40 && L.locked === true && L.kind === "smartObject", JSON.stringify(L));
  return r.json.document.layers.map((l: { name: string }) => l.name).join(", ");
});

await step("preview document (getPixels, encodeImageData JPEG)", async () => {
  const r = await call("preview", { document_id: docId, max_edge: 512 });
  ok(!r.isError, JSON.stringify(r.json));
  const img = r.content.find((c) => c.type === "image");
  ok(img && img.data && Buffer.from(img.data, "base64").subarray(0, 2).toString("hex") === "ffd8", "not a JPEG");
  ok(r.json.width === 512 && r.json.height === 512, JSON.stringify(r.json));
});

await step("preview one layer", async () => {
  const r = await call("preview", { document_id: docId, layer_id: refLayer, max_edge: 256 });
  ok(!r.isError, JSON.stringify(r.json));
  return JSON.stringify(r.json);
});

await step("open_image", async () => {
  const r = await call("open_image", { path: ref });
  ok(!r.isError && r.json.document.width === 800 && r.json.document.height === 600, JSON.stringify(r.json));
});

await step("one undo step per place_image (check by hand: Edit > Undo removes one whole place)", async () => "manual");

await client.close();
console.log(failed ? `${failed} step(s) failed` : "all steps passed");
process.exit(failed ? 1 : 0);
