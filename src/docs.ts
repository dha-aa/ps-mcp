// Adobe's Photoshop UXP reference (github.com/AdobeDocs/uxp-photoshop, Apache-2.0), fetched on demand and cached
// on disk: search by heading / method / text, read a page or one section of it.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PsToolError } from "./errors.ts";

export interface DocsOptions {
  /** GitHub tree listing (JSON with tree[].path). */
  treeUrl: string;
  /** Base URL of the raw files; a page is <rawBase>/<repo path>. */
  rawBase: string;
  dir: string;
  /** How long the page list is trusted before it is fetched again. */
  maxAgeMs?: number;
}

export interface Hit {
  page: string;
  section: string;
  snippet: string;
}

const ROOT = "src/pages/";
/** Pages the search reads in full (Photoshop's API and the UXP modules a plugin calls); the rest of uxp-api
 * (HTML elements, CSS...) is matched by path and read on request. */
const INDEXED = /^(ps-reference|uxp-api\/reference-js\/modules)\//;

/** Markdown from the docs site, made readable: no front matter, HTML or the site's escapes. */
export function clean(md: string): string {
  // The site escapes its own markup (\<span ...\>24.0\</span\>, \<br/\>) and type parameters (Promise\<void\>):
  // version spans first, then real tags, then unescape, so <void> is not taken for a tag.
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\\?<span class="minversion"[^>]*?\\?>([^<\\]*)\\?<\/span\\?>/g, "(min $1)")
    .replace(/\\?<br\s*\/?\\?>/g, "")
    // Only real HTML and the site's MDX components (<HorizontalLine />); keep type parameters (<void>, <Document>).
    .replace(/(^|[^\\`])<\/?(?:HorizontalLine|InlineAlert|CodeBlock|Badge|span|br|div|p|a|img|sup|sub|details|summary|ul|li|ol)(?:\s[^>]*)?\/?>/g, "$1")
    .replace(/\\</g, "<")
    .replace(/\\>/g, ">")
    .replace(/\\([_*[\]])/g, "$1")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x60;/g, "`")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Section {
  title: string;
  /** Heading level (1-6); 0 for text before the first heading. */
  level: number;
  body: string;
}

/** Splits a page into sections at its headings. */
export function sections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { title: "", level: 0, body: "" };
  for (const line of text.split("\n")) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (cur.title || cur.body.trim()) out.push(cur);
      cur = { title: m[2].trim(), level: m[1].length, body: "" };
    } else cur.body += line + "\n";
  }
  if (cur.title || cur.body.trim()) out.push(cur);
  return out;
}

/** A section with its sub-sections (a method with its Parameters table). */
export function sectionText(secs: Section[], i: number): string {
  let text = secs[i].body;
  for (let j = i + 1; j < secs.length && secs[j].level > secs[i].level; j++) text += "#".repeat(secs[j].level) + " " + secs[j].title + "\n" + secs[j].body;
  return text.trim();
}

export class Docs {
  private readonly o: DocsOptions;
  private list: string[] | null = null;

  constructor(o: DocsOptions) {
    this.o = o;
  }

  private async get(url: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "photoshop-mcp" } });
    } catch (e) {
      throw new PsToolError("NETWORK", `Can't reach ${new URL(url).host}: ${(e as Error).message}`, "Check the internet connection; pages read before still work offline.");
    }
    if (res.status === 404) throw new PsToolError("NOT_FOUND", `No such page: ${url}`);
    if (!res.ok) throw new PsToolError("NETWORK", `${new URL(url).host} answered HTTP ${res.status}.`, res.status === 403 ? "GitHub's rate limit: wait an hour, or keep using pages already cached." : undefined);
    return res.text();
  }

  /** Page ids (repo path without src/pages/ and .md), cached for maxAgeMs. */
  async pages(): Promise<string[]> {
    if (this.list) return this.list;
    const file = join(this.o.dir, "pages.json");
    let fresh = false;
    try {
      fresh = Date.now() - statSync(file).mtimeMs < (this.o.maxAgeMs ?? 7 * 86400_000);
    } catch {
      // not cached yet
    }
    if (!fresh) {
      try {
        const tree = JSON.parse(await this.get(this.o.treeUrl)) as { tree: Array<{ path: string; type: string }> };
        const ids = tree.tree
          .filter((t) => t.type === "blob" && t.path.startsWith(ROOT) && t.path.endsWith(".md") && /^(ps-reference|uxp-api)\//.test(t.path.slice(ROOT.length)))
          .map((t) => t.path.slice(ROOT.length, -3));
        mkdirSync(this.o.dir, { recursive: true });
        writeFileSync(file, JSON.stringify(ids));
      } catch (e) {
        // Offline with an old list: use it.
        try {
          statSync(file);
        } catch {
          throw e;
        }
      }
    }
    this.list = JSON.parse(readFileSync(file, "utf8")) as string[];
    return this.list;
  }

  /** One page's cleaned text, from the cache or the network. */
  async page(id: string): Promise<string> {
    const all = await this.pages();
    if (!all.includes(id)) {
      const near = all.filter((p) => p.toLowerCase().includes(id.toLowerCase().split("/").pop()!)).slice(0, 8);
      throw new PsToolError("NOT_FOUND", `No docs page "${id}".`, near.length ? "Did you mean: " + near.join(", ") : "Search with query first.");
    }
    const file = join(this.o.dir, "pages", id + ".md");
    try {
      return readFileSync(file, "utf8");
    } catch {
      const text = clean(await this.get(`${this.o.rawBase}/${ROOT}${id}.md`));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      return text;
    }
  }

  /** Sections whose heading, page path or text match the query words, best first. */
  async search(query: string, limit: number): Promise<Hit[]> {
    const words = query.toLowerCase().split(/[\s.,()/]+/).filter(Boolean);
    if (!words.length) throw new PsToolError("BAD_ARGS", "query is empty.");
    const all = await this.pages();
    const indexed = all.filter((p) => INDEXED.test(p));
    // Read the indexed pages (16 at a time); after the first search they all come from the cache.
    // A page that can't be read is skipped (one 404 must not break search); none at all is an error.
    const texts = new Map<string, string>();
    let firstError: unknown = null;
    for (let i = 0; i < indexed.length; i += 16) {
      await Promise.all(
        indexed.slice(i, i + 16).map(async (p) => {
          try {
            texts.set(p, await this.page(p));
          } catch (e) {
            firstError ??= e;
          }
        }),
      );
    }
    if (!texts.size && firstError) throw firstError;
    const scored: Array<Hit & { score: number }> = [];
    for (const [page, text] of texts) {
      const path = page.toLowerCase();
      for (const s of sections(text)) {
        const head = s.title.toLowerCase();
        const body = s.body.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (head === w) score += 6;
          else if (head.includes(w)) score += 3;
          if (path.includes(w)) score += 2;
          if (body.includes(w)) score += 1;
          else if (!head.includes(w) && !path.includes(w)) score -= 4; // every word should appear somewhere
        }
        if (score > 0) scored.push({ page, section: s.title, snippet: s.body.replace(/\s+/g, " ").trim().slice(0, 160), score });
      }
    }
    // uxp-api pages (not read in full) by path only.
    for (const page of all.filter((p) => !INDEXED.test(p))) {
      const path = page.toLowerCase();
      const n = words.filter((w) => path.includes(w)).length;
      if (n === words.length) scored.push({ page, section: "", snippet: "(UXP API page: read it with page)", score: 2 * n });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.page.localeCompare(b.page))
      .slice(0, limit)
      .map(({ score: _s, ...h }) => h);
  }
}
