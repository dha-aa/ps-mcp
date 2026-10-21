// uxp_docs: Adobe's Photoshop UXP reference, so a method, its parameters or an event name can be checked
// instead of guessed.
import * as z from "zod/v4";
import { DOCS } from "../config.ts";
import { Docs, sections, sectionText } from "../docs.ts";
import { PsToolError } from "../errors.ts";
import type { ToolRegistry } from "./registry.ts";

/** Pages longer than this come back as their section list: ask for one section. */
const PAGE_LIMIT = 12_000;

const docs = new Docs(DOCS);

export function registerDocsTools(r: ToolRegistry): void {
  r.tool(
    "uxp_docs",
    {
      title: "UXP docs",
      description:
        "Adobe's Photoshop UXP reference (classes, methods, constants, events, batchPlay; Apache-2.0): search it with query, then read a page, or one section of it (a method name). Check a signature here before writing batch_play descriptors.",
      readOnly: true,
      idempotent: true,
      openWorld: true,
    },
    z.strictObject({
      query: z.string().min(1).optional().describe('e.g. "applyGaussianBlur" or "selection feather"'),
      page: z.string().min(1).optional().describe('Page id from a search, e.g. "ps-reference/classes/layer"'),
      section: z.string().min(1).optional().describe("Heading within the page, e.g. a method name"),
      limit: z.number().int().min(1).max(30).default(8),
    }),
    async (a) => {
      if (!a.query && !a.page) throw new PsToolError("BAD_ARGS", "Pass query to search, or page to read.");
      if (!a.page) return { hits: await docs.search(a.query!, a.limit), source: "github.com/AdobeDocs/uxp-photoshop (Apache-2.0)" };
      const text = await docs.page(a.page);
      const secs = sections(text);
      if (a.section) {
        const want = a.section.toLowerCase();
        let i = secs.findIndex((x) => x.title.toLowerCase() === want);
        if (i < 0) i = secs.findIndex((x) => x.title.toLowerCase().includes(want));
        if (i < 0) throw new PsToolError("NOT_FOUND", `No section "${a.section}" in ${a.page}.`, "Sections: " + secs.map((x) => x.title).filter(Boolean).join(", "));
        return { page: a.page, section: secs[i].title, text: sectionText(secs, i) };
      }
      if (text.length > PAGE_LIMIT) {
        // Only the top headings (a class's methods), not each method's "Parameters".
        const top = Math.min(...secs.filter((x) => x.level >= 2).map((x) => x.level));
        return { page: a.page, note: `Long page (${text.length} characters): read one section.`, sections: secs.filter((x) => x.level > 0 && x.level <= Math.max(top, 3)).map((x) => x.title) };
      }
      return { page: a.page, text };
    },
  );
}
