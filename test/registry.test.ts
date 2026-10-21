// Result formatting in the registry.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { okResult } from "../src/tools/registry.ts";

test("too large: an error for reads, 'it ran' for changes (so they aren't retried)", () => {
  const big = { x: "y".repeat(30000) };
  const read = okResult(big, "ask for less", true);
  assert.equal(read.isError, true);
  assert.match(read.content[0].type === "text" ? read.content[0].text : "", /too large/);
  const change = okResult(big, "ask for less", false);
  assert.equal(change.isError, undefined);
  const t = change.content[0].type === "text" ? JSON.parse(change.content[0].text) : null;
  assert.equal(t.done, true);
  assert.match(t.note, /ran/);
});
