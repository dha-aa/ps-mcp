// Runs tool calls through the built server, like an MCP client would: node scripts/call.ts steps.json [--keep-going]
// steps.json: [{"tool": "get_document", "args": {...}, "save": "/abs/preview.jpg"}, ...]. Stops at the first error
// unless --keep-going (then every step runs and the exit code says whether any failed). --full prints whole results.
// "save" writes a result's image to a file. Args may use "$N.path" to reuse step N's result (1-based).
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

interface Step {
  tool: string;
  args?: Record<string, unknown>;
  save?: string;
}

const steps = JSON.parse(readFileSync(process.argv[2], "utf8")) as Step[];
const client = new Client({ name: "call", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env: { ...getDefaultEnvironment(), TMPDIR: process.env.TMPDIR ?? "", PS_MCP_CONNECT_WAIT_MS: "8000" },
  }),
);

const results: unknown[] = [];
function resolveRefs(v: unknown): unknown {
  if (typeof v === "string") {
    const m = /^\$(\d+)\.(.+)$/.exec(v);
    if (!m) return v;
    let cur: any = results[Number(m[1]) - 1];
    for (const k of m[2].split(".")) cur = cur?.[k];
    return cur;
  }
  if (Array.isArray(v)) return v.map(resolveRefs);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x)]));
  return v;
}

let code = 0;
for (const [i, s] of steps.entries()) {
  const r = (await client.callTool({ name: s.tool, arguments: resolveRefs(s.args ?? {}) as Record<string, unknown> })) as {
    content: Array<{ type: string; text?: string; data?: string }>;
    isError?: boolean;
  };
  const text = r.content.find((c) => c.type === "text")?.text ?? "{}";
  const img = r.content.find((c) => c.type === "image");
  if (img && s.save) writeFileSync(s.save, Buffer.from(img.data!, "base64"));
  console.log(`${i + 1}. ${s.tool} ${r.isError ? "ERROR " : ""}${text.length > 1500 && !process.argv.includes("--full") ? text.slice(0, 1500) + "..." : text}${img && s.save ? " -> " + s.save : ""}`);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // the SDK's own validation errors are plain text
  }
  results.push(parsed);
  if (r.isError) {
    code = 1;
    if (!process.argv.includes("--keep-going")) break;
  }
}
await client.close();
process.exit(code);
