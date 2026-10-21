// Layers and the document: set_layer, layer_ops, canvas, history.
import * as z from "zod/v4";
import type { ToolRegistry } from "./registry.ts";
import { BLEND_MODES } from "./schemas.ts";

const docId = z.number().int().describe("Document id (default: the active document)");

export function registerLayerTools(r: ToolRegistry): void {
  r.bridged(
    "set_layer",
    {
      title: "Set layer",
      description:
        "Changes one layer: name, visibility, opacity, fill opacity, blend mode, lock, clipping mask; moves it (x,y = new centre, or dx,dy), scales (percent), rotates (degrees), flips, all about its centre; reorders it (front / back, above / below another layer, into a group).",
    },
    z.strictObject({
      document_id: docId.optional(),
      layer_id: z.number().int(),
      name: z.string().min(1).optional(),
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(100).optional(),
      fill_opacity: z.number().min(0).max(100).optional(),
      blend: z.enum(BLEND_MODES).optional(),
      locked: z.boolean().optional(),
      clip: z.boolean().optional().describe("Clip to the layer below"),
      x: z.number().optional(),
      y: z.number().optional(),
      dx: z.number().optional(),
      dy: z.number().optional(),
      scale: z.union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive()])]).optional().describe("Percent, or [w%, h%]"),
      rotate: z.number().min(-360).max(360).optional(),
      flip: z.enum(["horizontal", "vertical", "both"]).optional(),
      order: z.enum(["front", "back"]).optional(),
      above: z.number().int().optional().describe("Move just above this layer"),
      below: z.number().int().optional().describe("Move just below this layer"),
      into: z.number().int().optional().describe("Move into this group"),
    }),
  );

  r.bridged(
    "layer_ops",
    {
      title: "Layer operations",
      description:
        "new_layer / new_group (empty, named), duplicate, delete, group (into a new group), merge (2+ layers into one), rasterize (smart objects, text, shapes into pixels). Returns the ids made or removed.",
    },
    z.strictObject({
      document_id: docId.optional(),
      op: z.enum(["new_layer", "new_group", "duplicate", "delete", "group", "merge", "rasterize"]),
      layer_ids: z.array(z.number().int()).optional(),
      name: z.string().min(1).optional(),
      above: z.number().int().optional().describe("new_layer / new_group: put it above this layer (default: above the selected layer)"),
    }),
  );

  r.bridged(
    "canvas",
    {
      title: "Canvas",
      description:
        "Changes the whole document: crop to bounds, resize_image (one side keeps the aspect ratio), resize_canvas (evenly on all sides), trim transparent edges, rotate (degrees), flatten (all layers into one).",
    },
    z.strictObject({
      document_id: docId.optional(),
      op: z.enum(["crop", "resize_image", "resize_canvas", "trim", "rotate", "flatten"]),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("[left, top, right, bottom] for crop"),
      width: z.number().int().min(1).max(300000).optional(),
      height: z.number().int().min(1).max(300000).optional(),
      resolution: z.number().min(1).max(10000).optional(),
      angle: z.number().min(-360).max(360).optional(),
    }),
  );

  r.bridged(
    "history",
    {
      title: "History",
      description: "The document's History panel: list the latest states, undo / redo steps, or go to a state by id. Each tool call is one state.",
      destructive: false,
    },
    z.strictObject({
      document_id: docId.optional(),
      op: z.enum(["list", "undo", "redo", "go"]),
      steps: z.number().int().min(1).max(1000).optional(),
      state_id: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("States to list (latest; default 20)"),
    }),
  );
}
