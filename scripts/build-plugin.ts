// Joins the compiled plugin files (build/plugin/*.js, from plugin-src/) in MODULES order into one script,
// plugin/js/main.js, wrapped in a closure and stamped with a build hash. Writes plugin/js/build.json so the
// server can tell when Photoshop is running an older build (a reload was missed).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

/** Order matters: core first (helpers, the commands table), bridge last (starts the plugin). */
const MODULES = ["core", "document", "text", "select", "color", "export", "record", "layers", "canvas", "looks", "bridge"];

const root = new URL("../", import.meta.url);
const sources = readdirSync(new URL("plugin-src/", root)).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).map((f) => f.slice(0, -3));
const missing = sources.filter((s) => !MODULES.includes(s));
if (missing.length) {
  console.error(`plugin-src files not in MODULES (scripts/build-plugin.ts): ${missing.join(", ")}`);
  process.exit(1);
}

const body = MODULES.map((m) => `// ---- ${m}\n` + readFileSync(new URL(`build/plugin/${m}.js`, root), "utf8").replace(/^"use strict";\n/, "")).join("\n");
const build = createHash("sha256").update(body).digest("hex").slice(0, 12);
const version = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version as string;
const out = `"use strict";\n(function () {\nconst PLUGIN_BUILD = "${build}";\n${body}\n})();\n`;
mkdirSync(new URL("plugin/js/", root), { recursive: true });
writeFileSync(new URL("plugin/js/main.js", root), out);
writeFileSync(new URL("plugin/js/build.json", root), JSON.stringify({ version, build }) + "\n");
console.error(`plugin/js/main.js ${version} build ${build}`);
