// The advertised tool list is slimmed (zod still validates the full schemas) and SDK validation errors use our format.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { adaptCallResult, slimSchema, slimToolList } from "../src/slim.ts";

test("slimSchema drops what carries no information and collapses tuples and long enums", () => {
  const s = slimSchema({
    $schema: "x",
    type: "object",
    additionalProperties: false,
    properties: {
      document_id: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991, description: "Document id" },
      opacity: { type: "number", minimum: 0, maximum: 100 },
      color: { type: "array", description: "[r,g,b] 0-1", prefixItems: [{ type: "number", minimum: 0 }, { type: "number" }, { type: "number" }] },
      at: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] },
      mixed: { type: "array", prefixItems: [{ type: "number" }, { type: "string" }] },
      off: { type: "boolean", const: false },
      blend: { type: "string", enum: Array.from({ length: 20 }, (_, i) => "m" + i) },
      shape: { type: "string", enum: ["rect", "ellipse"] },
    },
  }) as { properties: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  assert.equal(s.$schema, undefined);
  assert.equal(s.additionalProperties, undefined);
  assert.deepEqual(s.properties.document_id, { type: "integer" }, "description and safe-integer bounds gone");
  assert.deepEqual(s.properties.opacity, { type: "number" });
  assert.deepEqual(s.properties.color, { type: "array", description: "[r,g,b] 0-1", items: { type: "number" } });
  assert.deepEqual(s.properties.at, { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 });
  assert.ok(Array.isArray(s.properties.mixed.prefixItems), "mixed tuples stay");
  assert.deepEqual(s.properties.off, { const: false });
  assert.equal(s.properties.blend.enum, undefined);
  assert.match(String(s.properties.blend.description), /one of 20 names, e\.g\. m0, m1/);
  assert.deepEqual(s.properties.shape.enum, ["rect", "ellipse"], "short enums stay");
});

test("slimToolList keeps the tool and drops the duplicated annotation title", () => {
  const r = slimToolList({ tools: [{ name: "t", title: "T", description: "d", inputSchema: { type: "object", $schema: "x" }, annotations: { title: "T", readOnlyHint: true } }] }) as {
    tools: Array<Record<string, unknown>>;
  };
  assert.deepEqual(r.tools[0], { name: "t", title: "T", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
});

test("adaptCallResult turns the SDK's validation text into BAD_ARGS and leaves other results alone", () => {
  const sdk = { isError: true, content: [{ type: "text", text: 'Input validation error: Invalid arguments for tool set_layer: [{"path":["opacity"],"message":"Too big"},{"path":[],"message":"Unrecognized key: \\"x\\""}]' }] };
  const r = adaptCallResult(sdk) as { content: Array<{ text: string }> };
  const e = JSON.parse(r.content[0].text).error;
  assert.equal(e.code, "BAD_ARGS");
  assert.equal(e.message, 'Invalid arguments for set_layer: opacity: Too big; (arguments): Unrecognized key: "x"');
  assert.ok(e.hint);
  const plain = adaptCallResult({ isError: true, content: [{ type: "text", text: "Input validation error: Invalid arguments for tool x: bad thing" }] }) as { content: Array<{ text: string }> };
  assert.equal(JSON.parse(plain.content[0].text).error.message, "Invalid arguments for x: bad thing");
  const ours = { isError: true, content: [{ type: "text", text: '{"error":{"code":"NOT_FOUND","message":"m"}}' }] };
  assert.equal(adaptCallResult(ours), ours);
  const ok = { content: [{ type: "text", text: "{}" }] };
  assert.equal(adaptCallResult(ok), ok);
});
