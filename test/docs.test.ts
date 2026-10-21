// uxp_docs against a local stand-in for GitHub (tree listing + raw pages): search, read, cache, offline, errors.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { clean, Docs, sections, sectionText } from "../src/docs.ts";

const LAYER = `---
title: Layer
---
# Layer
Represents a single layer.

## Methods

### applyGaussianBlur
\\<span class="minversion" style="display: block;"\\>24.0\\</span\\>

\\<br/\\>
<HorizontalLine />
**async** : *Promise*\\<void\\>

Applies the Gaussian Blur filter.

#### Parameters
| \`radius\` | *number* | The radius of the filter in pixels [0.1,250]. |

### applyMotionBlur
Applies the Motion Blur filter.
| \`angle\` | *number* | degrees |
`;
const SELECTION = "# Selection\n\n### feather\nFeathers the selection.\n| `by` | *number* | amount |\n";
const LONG = "# Constants\n" + Array.from({ length: 400 }, (_, i) => `### Enum${i}\n` + "x".repeat(40) + "\n").join("");

let hits = 0;
let status = 200;
const files: Record<string, string> = {
  "/tree": JSON.stringify({
    tree: [
      { path: "src/pages/ps-reference/classes/layer.md", type: "blob" },
      { path: "src/pages/ps-reference/classes/selection.md", type: "blob" },
      { path: "src/pages/ps-reference/modules/constants.md", type: "blob" },
      { path: "src/pages/uxp-api/reference-js/modules/fs.md", type: "blob" },
      { path: "src/pages/guides/intro.md", type: "blob" },
      { path: "README.md", type: "blob" },
    ],
  }),
  "/src/pages/ps-reference/classes/layer.md": LAYER,
  "/src/pages/ps-reference/classes/selection.md": SELECTION,
  "/src/pages/ps-reference/modules/constants.md": LONG,
};
const server: Server = createServer((req, res) => {
  hits++;
  if (status !== 200) return res.writeHead(status).end("no");
  const body = files[req.url ?? ""];
  if (body === undefined) return res.writeHead(404).end("missing");
  res.writeHead(200).end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

const fresh = () => new Docs({ treeUrl: base + "/tree", rawBase: base, dir: mkdtempSync(join(tmpdir(), "psmcp-docs-")) });

test("clean and sections: no front matter, HTML or escapes; split at headings", () => {
  const t = clean(LAYER);
  assert.ok(!t.includes("---") && !t.includes("<span") && !t.includes("\\<"));
  assert.match(t, /\(min 24\.0\)/);
  assert.match(t, /Promise\*<void>/, "type parameters survive");
  const secs = sections(t);
  assert.deepEqual(secs.map((s) => s.title), ["Layer", "Methods", "applyGaussianBlur", "Parameters", "applyMotionBlur"]);
  const g = sectionText(secs, 2);
  assert.match(g, /#### Parameters/, "a method keeps its Parameters table");
  assert.match(g, /radius/);
  assert.doesNotMatch(g, /Motion Blur/, "but not the next method");
});

test("pages lists only reference pages, without src/pages/ and .md", async () => {
  assert.deepEqual(await fresh().pages(), ["ps-reference/classes/layer", "ps-reference/classes/selection", "ps-reference/modules/constants", "uxp-api/reference-js/modules/fs"]);
});

test("search ranks the method heading first; every word must appear; uxp-api pages match by path", async () => {
  const d = fresh();
  const r = await d.search("gaussian blur", 5);
  assert.equal(r[0].section, "applyGaussianBlur");
  assert.equal(r[0].page, "ps-reference/classes/layer");
  assert.match(r[0].snippet, /Gaussian Blur filter/);
  assert.ok(!r.some((h) => h.section === "applyMotionBlur"), "motion blur lacks 'gaussian'");
  assert.equal((await d.search("selection feather", 3))[0].section, "feather");
  assert.equal((await d.search("fs", 3)).find((h) => h.page.startsWith("uxp-api"))?.page, undefined, "an indexed page that 404s is skipped");
  files["/src/pages/uxp-api/reference-js/modules/fs.md"] = "# fs\n\n### readFile\nReads a file.\n";
  files["/tree"] = files["/tree"].replace("]}", ',{"path":"src/pages/uxp-api/reference-js/global-members/html-elements/sp-button.md","type":"blob"}]}');
  const d2 = fresh();
  assert.equal((await d2.search("readFile", 3))[0].page, "uxp-api/reference-js/modules/fs", "UXP modules are searched in full");
  assert.equal((await d2.search("sp-button", 3))[0].page, "uxp-api/reference-js/global-members/html-elements/sp-button", "other UXP pages by path");
  await assert.rejects(d.search("   ", 3), /query is empty/);
});

test("pages are cached: a second Docs on the same folder works with the server gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psmcp-docs-"));
  const a = new Docs({ treeUrl: base + "/tree", rawBase: base, dir });
  await a.page("ps-reference/classes/layer");
  const before = hits;
  const offline = new Docs({ treeUrl: "http://127.0.0.1:9/tree", rawBase: "http://127.0.0.1:9", dir, maxAgeMs: 0 });
  assert.match(await offline.page("ps-reference/classes/layer"), /applyGaussianBlur/, "old page list and cached page used offline");
  assert.equal(hits, before);
  await assert.rejects(offline.page("ps-reference/classes/selection"), (e: { code: string }) => e.code === "NETWORK");
});

test("unknown page gets suggestions; no network and no cache is NETWORK; rate limit says so", async () => {
  const d = fresh();
  await assert.rejects(d.page("layer"), (e: { code: string; hint: string }) => e.code === "NOT_FOUND" && /ps-reference\/classes\/layer/.test(e.hint));
  await assert.rejects(new Docs({ treeUrl: "http://127.0.0.1:9/tree", rawBase: base, dir: mkdtempSync(join(tmpdir(), "psmcp-docs-")) }).pages(), (e: { code: string }) => e.code === "NETWORK");
  status = 403;
  try {
    await assert.rejects(fresh().pages(), (e: { code: string; hint: string }) => e.code === "NETWORK" && /rate limit/.test(e.hint));
  } finally {
    status = 200;
  }
});

export { LONG };
