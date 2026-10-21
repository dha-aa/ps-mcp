// batch_play: Photoshop's own action descriptors, for anything the other tools don't cover.
import * as z from "zod/v4";
import type { ToolRegistry } from "./registry.ts";

export function registerActionTools(r: ToolRegistry): void {
  r.bridged(
    "batch_play",
    {
      title: "Batch play",
      description:
        "Runs Photoshop action descriptors (action.batchPlay, the format Alchemist / Copy As JavaScript records) on a document, as one undo step; returns the count run, results of get descriptors and ids of layers made. For anything the other tools don't do: select subject, masks, adjustments, layer styles, text, fills, filters. Fails as a whole: on error nothing is kept.",
    },
    z.strictObject({
      descriptors: z.array(z.record(z.string(), z.unknown())).min(1).describe('e.g. [{"_obj":"autoCutout","sampleAllLayers":false}]'),
      document_id: z.number().int().optional().describe("Document to run on (default: the active one)"),
    }),
  );
}
