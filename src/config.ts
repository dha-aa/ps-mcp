// Every setting the server reads from the environment, in one place.
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION = pkg.version;

/** Where each running server writes `<pid>.json` ({port, token}); the plugin reads this folder to find servers. */
export const BRIDGE_DIR = process.env.PS_MCP_BRIDGE_DIR || join(homedir(), ".photoshop-mcp", "bridges");

/** Folders path arguments may point into (default: home and the temp folder). */
export const ALLOWED_DIRS = (process.env.PS_MCP_ALLOWED_DIRS || [homedir(), tmpdir()].join(delimiter))
  .split(delimiter)
  .filter(Boolean)
  .map((d) => resolve(d));

/** How long one command may run in Photoshop before the server gives up on it. */
export const TIMEOUT_MS = Number(process.env.PS_MCP_TIMEOUT_MS) || 60_000;

/** How long a call waits for the plugin to (re)connect before failing with BRIDGE_DOWN. */
export const CONNECT_WAIT_MS = Number(process.env.PS_MCP_CONNECT_WAIT_MS) || 4_000;

/** Text results longer than this are replaced by an error (they would flood the model's context). */
export const CHARACTER_LIMIT = 25_000;

/** The plugin build this server ships with (plugin/js/build.json); a different one in Photoshop means a missed reload. */
export const PLUGIN_BUILD: string | undefined = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../plugin/js/build.json", import.meta.url), "utf8")) as { build?: string }).build;
  } catch {
    return undefined;
  }
})();

/** Adobe's Photoshop UXP reference (AdobeDocs/uxp-photoshop): page list, raw pages, local cache. */
export const DOCS = {
  treeUrl: process.env.PS_MCP_DOCS_TREE_URL || "https://api.github.com/repos/AdobeDocs/uxp-photoshop/git/trees/main?recursive=1",
  rawBase: process.env.PS_MCP_DOCS_RAW_URL || "https://raw.githubusercontent.com/AdobeDocs/uxp-photoshop/main",
  dir: process.env.PS_MCP_DOCS_DIR || join(homedir(), ".photoshop-mcp", "docs"),
};

/** Folder for images the server writes itself (base64 uploads). */
export const TEMP_DIR = join(tmpdir(), "photoshop-mcp");
