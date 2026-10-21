#!/usr/bin/env node
// Entry: start the bridge Photoshop connects to, then serve MCP on stdio.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WsBridge } from "./bridge.ts";
import { BRIDGE_DIR, CONNECT_WAIT_MS, PLUGIN_BUILD, TIMEOUT_MS, VERSION } from "./config.ts";
import { createServer } from "./server.ts";

const log = (msg: string) => process.stderr.write(`[photoshop-mcp] ${msg}\n`);

const bridge = await WsBridge.start({ dir: BRIDGE_DIR, version: VERSION, build: PLUGIN_BUILD, timeoutMs: TIMEOUT_MS, connectWaitMs: CONNECT_WAIT_MS, log });
log(`v${VERSION} waiting for Photoshop on 127.0.0.1:${bridge.port} (${bridge.file})`);

const handle = serveStdio(() => createServer(bridge).server);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await handle.close().catch(() => {});
  await bridge.close();
  process.exit(0);
}
process.stdin.on("end", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("exit", () => bridge.removeFileSync());
