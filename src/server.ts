// createServer(bridge): one McpServer with every tool registered.
import { McpServer } from "@modelcontextprotocol/server";
import type { Bridge } from "./bridge.ts";
import { VERSION } from "./config.ts";
import { adaptToolHandlers } from "./slim.ts";
import { registerActionTools } from "./tools/actions.ts";
import { registerDocsTools } from "./tools/docs.ts";
import { registerDocumentTools } from "./tools/document.ts";
import { registerEditTools } from "./tools/edit.ts";
import { registerLayerTools } from "./tools/layers.ts";
import { registerLookTools } from "./tools/looks.ts";
import { ToolRegistry } from "./tools/registry.ts";

export const SERVER_INSTRUCTIONS = `Controls a live Adobe Photoshop through its MCP panel (Plugins > Photoshop MCP).
Start with get_document: it lists open documents and the active one's layer tree (ids, kinds, bounds). document_id defaults to the active document.
Stacking: a new layer goes above the selected layer, which is the last one made or changed (moving a layer down
keeps it selected); pass above: <layer id> to place it, and check the order in get_document.
Units: pixels, x right and y down from the canvas's top-left; opacity 0-100; colours [r,g,b] 0-1. Layers and documents by numeric id.
Reference images: an image shown in the chat does not reach this server. Use its file path (place_image / open_image path), or pass base64 bytes as data. To recreate a reference: open_image it or create_document at its size, place it as a locked layer at low opacity to build over, then compare with preview often.
Errors are {error:{code,message,hint}}: follow the hint.`;

export function createServer(bridge: Bridge): { server: McpServer; tools: string[] } {
  const server = new McpServer({ name: "photoshop-mcp", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  adaptToolHandlers(server);
  const r = new ToolRegistry(server, bridge);
  registerDocumentTools(r);
  registerActionTools(r);
  registerEditTools(r);
  registerLayerTools(r);
  registerLookTools(r);
  registerDocsTools(r);
  return { server, tools: r.names };
}
