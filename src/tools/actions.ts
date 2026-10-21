// batch_play: Photoshop's own action descriptors, for anything the other tools don't cover.
import * as z from "zod/v4";
import { ALLOWED_DIRS } from "../config.ts";
import { PsToolError } from "../errors.ts";
import { assertAllowed } from "../sandbox.ts";
import type { ToolRegistry } from "./registry.ts";

/** Every "_path" in the descriptors must be an absolute path inside the allowed folders (the plugin turns each into
 * the session token Photoshop needs). Without this, batch_play could open or save files anywhere. */
export function checkDescriptorPaths(v: unknown, at = "descriptors"): number {
  let n = 0;
  if (Array.isArray(v)) v.forEach((x, i) => (n += checkDescriptorPaths(x, `${at}[${i}]`)));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "_path") {
        if (typeof x !== "string") throw new PsToolError("BAD_ARGS", `${at}._path must be a string path.`);
        assertAllowed(x, ALLOWED_DIRS);
        n++;
      } else n += checkDescriptorPaths(x, `${at}.${k}`);
    }
  }
  return n;
}

export function registerActionTools(r: ToolRegistry): void {
  r.bridged(
    "batch_play",
    {
      title: "Batch play",
      description:
        'Runs Photoshop action descriptors (action.batchPlay, the format Alchemist / Copy As JavaScript records) on a document, as one undo step; returns the count run, results of get descriptors and ids of layers made. For anything the other tools don\'t do. File references: {"_path": "/absolute/path", "_kind": "local"}, inside the allowed folders. Fails as a whole: on error nothing is kept. uxp_docs and record_actions show descriptors.',
    },
    z.strictObject({
      descriptors: z.array(z.record(z.string(), z.unknown())).min(1).describe('e.g. [{"_obj":"autoCutout","sampleAllLayers":false}]'),
      document_id: z.number().int().optional(),
    }),
    (a) => {
      checkDescriptorPaths(a.descriptors);
      return a;
    },
  );
}
