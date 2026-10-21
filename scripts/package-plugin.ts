// Packs plugin/ (manifest, panel, built js, icons) into dist/photoshop-mcp-<version>.ccx, the zip format Creative
// Cloud installs plugins from. Run after npm run build: npm run package.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(readFileSync(root + "package.json", "utf8")).version as string;
if (!existsSync(root + "plugin/js/main.js")) {
  console.error("plugin/js/main.js is missing: run npm run build first.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(root + "plugin/manifest.json", "utf8")) as { version: string };
if (manifest.version !== version) {
  console.error(`plugin/manifest.json is ${manifest.version}, package.json ${version}.`);
  process.exit(1);
}
mkdirSync(root + "dist", { recursive: true });
const out = `${root}dist/photoshop-mcp-${version}.ccx`;
rmSync(out, { force: true });
// The manifest must sit at the root of the archive.
execFileSync("zip", ["-qr", "-X", out, "manifest.json", "index.html", "js/main.js", "icons"], { cwd: root + "plugin", stdio: "inherit" });
console.error(`wrote ${out}`);
