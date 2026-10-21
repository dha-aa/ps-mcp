// Checks that the Photoshop / UXP API the plugin declares (plugin-src/env.d.ts) and the constants it uses still
// exist in Adobe's reference: npm run check-api (uses the uxp_docs cache; fetches what is missing). It catches
// renamed or removed APIs and typos, not APIs the docs list but Photoshop lacks (constants.FlipAxis, see CLAUDE.md).
import { readdirSync, readFileSync } from "node:fs";
import { DOCS } from "../src/config.ts";
import { Docs } from "../src/docs.ts";

const docs = new Docs(DOCS);
const root = new URL("../plugin-src/", import.meta.url);
const env = readFileSync(new URL("env.d.ts", root), "utf8");

/** Interface in env.d.ts -> docs page that documents it. */
const PAGES: Record<string, string> = {
  PsLayer: "ps-reference/classes/layer",
  PsDocument: "ps-reference/classes/document",
  PsSelection: "ps-reference/classes/selection",
  PsTextItem: "ps-reference/classes/textitem",
  PsCharacterStyle: "ps-reference/classes/characterstyle",
};
/** Members we declare that are ours or documented elsewhere. */
const SKIP = new Set(["paragraphStyle"]);

function members(name: string): string[] {
  const m = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(env);
  if (!m) throw new Error(`interface ${name} not found in env.d.ts`);
  return [...m[1].matchAll(/^\s{2}(\w+)\??[(:]/gm)].map((x) => x[1]).filter((n) => !SKIP.has(n));
}

const documented = (text: string, name: string) => new RegExp(`(^#+\\s*${name}\\b|\\|\\s*\`?${name}\`?\\s*\\|)`, "m").test(text);

let missing = 0;
for (const [iface, page] of Object.entries(PAGES)) {
  const text = await docs.page(page);
  for (const n of members(iface)) {
    if (!documented(text, n)) {
      console.log(`MISSING ${iface}.${n} (not in ${page})`);
      missing++;
    }
  }
}

// Constants groups the plugin uses: ps.constants.X and constant("X", ...).
const src = readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).map((f) => readFileSync(new URL(f, root), "utf8")).join("\n");
const groups = new Set([...src.matchAll(/constants\.(\w+)/g), ...src.matchAll(/constant\("(\w+)"/g)].map((m) => m[1]));
const constants = await docs.page("ps-reference/modules/constants");
for (const g of groups) {
  if (!new RegExp(`^#+\\s*${g}\\b`, "m").test(constants)) {
    console.log(`MISSING constants.${g}`);
    missing++;
  }
}
console.log(missing ? `${missing} API name(s) not found in Adobe's reference` : `all ${groups.size} constants groups and declared members found in Adobe's reference`);
process.exit(missing ? 1 : 0);
