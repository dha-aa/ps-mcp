// Documents and images: inspect, create, open, place, preview.
import * as z from "zod/v4";
import { ALLOWED_DIRS, TEMP_DIR } from "../config.ts";
import { PsToolError } from "../errors.ts";
import { imageFromData, imageFromPath, type ImageFile } from "../images.ts";
import { WithImages, type ToolRegistry } from "./registry.ts";

const docId = z.number().int().describe("Document id from get_document (default: the active document)");
const imagePath = z.string().min(1).describe("Absolute path of an image file");
const imageData = z.string().min(1).describe("Base64 image bytes or a data: URL, when there is no file on disk");

function oneImage(a: { path?: string; data?: string }): Promise<ImageFile> | ImageFile {
  if ((a.path === undefined) === (a.data === undefined)) {
    throw new PsToolError("BAD_ARGS", "Pass exactly one of path or data.", "path for a file on disk, data for base64 bytes.");
  }
  return a.path !== undefined ? imageFromPath(a.path, ALLOWED_DIRS) : imageFromData(a.data!, TEMP_DIR);
}

export function registerDocumentTools(r: ToolRegistry): void {
  r.bridged(
    "get_document",
    {
      title: "Get document",
      description:
        "The open documents and one document's size, resolution, mode and layer tree (top first; ids, kinds, bounds [left,top,right,bottom] px). Defaults are left out: visible, opacity 100, blend normal, unlocked.",
      readOnly: true,
      idempotent: true,
      tooLargeHint: "The layer tree is too large: pass depth to show fewer levels.",
    },
    z.strictObject({
      document_id: docId.optional(),
      depth: z.number().int().min(1).optional().describe("Levels of the layer tree to show (default all)"),
    }),
  );

  r.bridged(
    "create_document",
    {
      title: "Create document",
      description: "Creates a new RGB document and makes it active. To match a reference image's size, open_image it or pass its width and height.",
      destructive: false,
    },
    z.strictObject({
      width: z.number().int().min(1).max(300000).describe("Pixels"),
      height: z.number().int().min(1).max(300000).describe("Pixels"),
      resolution: z.number().min(1).max(10000).default(72).describe("Pixels per inch"),
      name: z.string().min(1).optional(),
      fill: z.enum(["white", "black", "transparent"]).default("white"),
    }),
  );

  r.bridged(
    "open_image",
    {
      title: "Open image",
      description: "Opens an image file (or base64 data) as its own document, e.g. a reference to inspect or sample. To add it to an existing document, use place_image.",
      destructive: false,
    },
    z.strictObject({ path: imagePath.optional(), data: imageData.optional() }),
    async (a) => {
      const img = await oneImage(a);
      return { path: img.path };
    },
  );

  r.bridged(
    "place_image",
    {
      title: "Place image",
      description:
        "Places an image file (or base64 data) into a document as a smart-object layer above the selected layer, sized by fit, centred on x,y. A locked, semi-transparent reference layer to build over: opacity 30-50, locked true.",
    },
    z.strictObject({
      path: imagePath.optional(),
      data: imageData.optional(),
      document_id: docId.optional(),
      fit: z
        .enum(["contain", "cover", "stretch", "none"])
        .default("contain")
        .describe("contain: whole image inside the canvas; cover: fills the canvas, cropped; stretch: exactly the canvas; none: the image's own pixel size"),
      x: z.number().optional().describe("Centre x in px (default: canvas centre)"),
      y: z.number().optional().describe("Centre y in px (default: canvas centre)"),
      name: z.string().min(1).optional(),
      opacity: z.number().min(0).max(100).optional(),
      locked: z.boolean().optional(),
    }),
    async (a) => {
      const img = await oneImage(a);
      const { data: _data, ...rest } = a;
      return { ...rest, path: img.path, source_width: img.width, source_height: img.height };
    },
  );

  r.tool(
    "preview",
    {
      title: "Preview",
      description:
        "A JPEG of a document as composited (or of one layer alone), to check the work or compare it with a reference. Costs tokens: keep max_edge small unless detail matters.",
      readOnly: true,
      idempotent: true,
    },
    z.strictObject({
      document_id: docId.optional(),
      layer_id: z.number().int().optional().describe("Show only this layer"),
      max_edge: z.number().int().min(64).max(2048).default(1024).describe("Longest side of the image in px"),
    }),
    async (a, signal) => {
      const r2 = (await r.call("preview", a, signal)) as { data: string; width: number; height: number; [k: string]: unknown };
      const { data, ...info } = r2;
      return new WithImages(info, [{ data, mimeType: "image/jpeg" }]);
    },
  );
}
