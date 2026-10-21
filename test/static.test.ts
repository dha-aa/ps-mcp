// Things that must agree across files.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("one version in package.json, the plugin manifest and the plugin code", () => {
  const v = JSON.parse(read("package.json")).version;
  assert.equal(JSON.parse(read("plugin/manifest.json")).version, v);
  assert.match(read("plugin-src/core.ts"), new RegExp(`const PLUGIN_VERSION = "${v.replace(/\./g, "\\.")}"`));
});

test("every server schema is strict (unknown keys rejected)", () => {
  for (const f of ["src/tools/document.ts", "src/tools/actions.ts", "src/tools/edit.ts", "src/tools/layers.ts", "src/tools/looks.ts", "src/tools/schemas.ts", "src/tools/docs.ts"]) assert.doesNotMatch(read(f), /\bz\.object\(/, f);
});
