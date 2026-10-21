// What the model sees of the tools, made cheaper: tool definitions are sent with every request. zod still
// validates the full schemas; only the advertised JSON Schema is slimmed. And the SDK's own input-validation
// errors are rewritten into the {error:{code,message,hint}} format every other error uses.
import type { McpServer } from "@modelcontextprotocol/server";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Drops what carries no information for the model; collapses tuples of one type to typed arrays. */
export function slimSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(slimSchema);
  if (!isObj(s)) return s;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "$schema") continue;
    if (k === "additionalProperties" && v === false) continue; // zod rejects unknown keys anyway
    // Ranges stay in zod (a value out of range gets an error naming it); units are in the server instructions.
    if (k === "minimum" || k === "maximum" || k === "exclusiveMinimum" || k === "exclusiveMaximum") continue;
    out[k] = slimSchema(v);
  }
  // [r,g,b] and [x,y] tuples: one item schema instead of one per position.
  const pre = out.prefixItems;
  if (Array.isArray(pre) && pre.length && pre.every((p) => isObj(p) && p.type === (pre[0] as Json).type && !p.enum)) {
    delete out.prefixItems;
    out.items = { type: (pre[0] as Json).type };
    // A described tuple ("[r,g,b] 0-1", "[left, top, right, bottom]") already says its length.
    if (typeof out.description !== "string") {
      out.minItems = pre.length;
      out.maxItems = pre.length;
    }
  }
  if ("const" in out && out.type) delete out.type;
  // Long enums (blend modes): a few examples instead of every name; zod's error lists them all when one is wrong.
  if (Array.isArray(out.enum) && out.enum.length > 16) {
    const examples = out.enum.slice(0, 6).join(", ");
    out.description = [out.description, `one of ${out.enum.length} names, e.g. ${examples}`].filter(Boolean).join("; ");
    delete out.enum;
  }
  // The instructions say document_id defaults to the active document: no need to repeat it 20 times.
  if (isObj(out.properties) && isObj(out.properties.document_id)) delete (out.properties.document_id as Json).description;
  return out;
}

export function slimToolList(result: unknown): unknown {
  if (!isObj(result) || !Array.isArray(result.tools)) return result;
  return {
    ...result,
    tools: result.tools.map((t: Json) => {
      const tool: Json = { ...t, inputSchema: slimSchema(t.inputSchema) };
      if (isObj(t.annotations)) {
        const { title: _title, ...rest } = t.annotations; // the tool's own title says it
        tool.annotations = rest;
      }
      return tool;
    }),
  };
}

const VALIDATION = /^(?:MCP error -?\d+: )?Input validation error: Invalid arguments for tool (\S+): ([\s\S]*)$/;

/** Rewrites the SDK's "Input validation error: ..." text result into a BAD_ARGS error body. */
export function adaptCallResult(result: unknown): unknown {
  if (!isObj(result) || result.isError !== true || !Array.isArray(result.content)) return result;
  const first = result.content[0] as Json | undefined;
  const m = first && typeof first.text === "string" ? VALIDATION.exec(first.text) : null;
  if (!m) return result;
  let detail = m[2].trim();
  try {
    // zod 4 reports issues as JSON: keep "path: message" per issue.
    const issues = JSON.parse(detail) as Array<{ path?: unknown[]; message?: string }>;
    if (Array.isArray(issues)) detail = issues.map((i) => `${(i.path ?? []).join(".") || "(arguments)"}: ${i.message}`).join("; ");
  } catch {
    // already plain text
  }
  const body = { code: "BAD_ARGS", message: `Invalid arguments for ${m[1]}: ${detail}`, hint: "Check the tool's input schema: names, types and ranges; unknown keys are rejected." };
  return { ...result, content: [{ type: "text", text: JSON.stringify({ error: body }) }, ...result.content.slice(1)] };
}

/** Wraps the SDK's tools/list and tools/call handlers. Call right after new McpServer(), before registering tools
 * (McpServer installs both handlers when the first tool is registered). */
export function adaptToolHandlers(server: McpServer): void {
  const inner = server.server as unknown as { setRequestHandler: (method: string, handler: (...a: unknown[]) => unknown) => void };
  const set = inner.setRequestHandler.bind(inner);
  inner.setRequestHandler = (method, handler) => {
    if (method === "tools/list") return set(method, async (...a: unknown[]) => slimToolList(await handler(...a)));
    if (method === "tools/call") return set(method, async (...a: unknown[]) => adaptCallResult(await handler(...a)));
    return set(method, handler);
  };
}
