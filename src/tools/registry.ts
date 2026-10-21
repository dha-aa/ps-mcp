// Registers tools with one result and error format: compact JSON text, {error:{code,message,hint}} on failure,
// every MCP annotation set, oversized results replaced by an error.
import type { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import type { Bridge } from "../bridge.ts";
import { CHARACTER_LIMIT } from "../config.ts";
import { PsToolError, toErrorBody } from "../errors.ts";

export interface Image {
  data: string;
  mimeType: string;
}

/** A result with images: `value` becomes the text block, each image an image block after it. */
export class WithImages {
  readonly value: unknown;
  readonly images: Image[];
  constructor(value: unknown, images: Image[]) {
    this.value = value;
    this.images = images;
  }
}

export interface ToolMeta {
  title: string;
  description: string;
  readOnly?: boolean;
  /** Defaults to true for tools that aren't read-only. */
  destructive?: boolean;
  idempotent?: boolean;
  /** Reaches the network (only uxp_docs). */
  openWorld?: boolean;
  /** What to do when the result is too large. */
  tooLargeHint?: string;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface Result {
  content: Content[];
  isError?: boolean;
  [k: string]: unknown;
}

export function errorResult(e: unknown): Result {
  return { content: [{ type: "text", text: JSON.stringify({ error: toErrorBody(e) }) }], isError: true };
}

export function okResult(out: unknown, hint: string, readOnly: boolean): Result {
  const value = out instanceof WithImages ? out.value : out;
  let text = value === undefined ? "{}" : JSON.stringify(value);
  if (text.length > CHARACTER_LIMIT) {
    // A change that already happened must not look like a failure, or it gets retried and done twice.
    if (!readOnly) text = JSON.stringify({ done: true, note: `The command ran; its result (${text.length} characters) is too large to show.` });
    else return errorResult(new PsToolError("BAD_ARGS", `Result too large (${text.length} characters, limit ${CHARACTER_LIMIT}).`, hint));
  }
  const content: Content[] = [{ type: "text", text }];
  if (out instanceof WithImages) for (const im of out.images) content.push({ type: "image", data: im.data, mimeType: im.mimeType });
  return { content };
}

export class ToolRegistry {
  readonly names: string[] = [];
  private readonly server: McpServer;
  private readonly bridge: Bridge;

  constructor(server: McpServer, bridge: Bridge) {
    this.server = server;
    this.bridge = bridge;
  }

  /** A tool with server-side logic. */
  tool<S extends z.ZodObject>(name: string, meta: ToolMeta, schema: S, run: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>): void {
    this.names.push(name);
    const readOnly = meta.readOnly === true;
    this.server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: schema,
        annotations: {
          title: meta.title,
          readOnlyHint: readOnly,
          destructiveHint: readOnly ? false : meta.destructive !== false,
          idempotentHint: meta.idempotent === true,
          openWorldHint: meta.openWorld === true,
        },
      },
      (async (args: z.infer<S>, ctx: { mcpReq: { signal: AbortSignal } }) => {
        try {
          return this.warn(okResult(await run(args, ctx.mcpReq.signal), meta.tooLargeHint ?? "Ask for less (filters or a smaller scope).", readOnly));
        } catch (e) {
          return this.warn(errorResult(e));
        }
      }) as never,
    );
  }

  /** A tool that forwards its (prepared) arguments to the plugin command of the same name. */
  /** Adds the bridge's warning (an outdated plugin) to a result, where the model sees it. */
  private warn(r: Result): Result {
    const w = this.bridge.warning();
    if (w) r.content.push({ type: "text", text: JSON.stringify({ warning: w }) });
    return r;
  }

  bridged<S extends z.ZodObject>(
    name: string,
    meta: ToolMeta,
    schema: S,
    prepare: (args: z.infer<S>) => unknown | Promise<unknown> = (a) => a,
  ): void {
    this.tool(name, meta, schema, async (args, signal) => this.bridge.call(name, await prepare(args), { signal }));
  }

  call(cmd: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.bridge.call(cmd, args, { signal });
  }
}
