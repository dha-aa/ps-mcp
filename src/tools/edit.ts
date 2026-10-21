// Text, selection, colour sampling, export and action recording.
import { existsSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import * as z from "zod/v4";
import { ALLOWED_DIRS } from "../config.ts";
import { PsToolError } from "../errors.ts";
import { palette, toSwatch } from "../palette.ts";
import { assertAllowed } from "../sandbox.ts";
import type { ToolRegistry } from "./registry.ts";

const docId = z.number().int().describe("Document id (default: the active document)");
const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).describe("[r,g,b] 0-1");
const point = z.tuple([z.number(), z.number()]);

export function registerEditTools(r: ToolRegistry): void {
  r.bridged(
    "set_text",
    {
      title: "Set text",
      description:
        "Creates a text layer (no layer_id) or edits one. Font is a PostScript name (find_fonts); size in px at 72 ppi. x,y place the centre of the text (new text: canvas centre). Line breaks with \\n. Returns the font actually used: a missing font is replaced by Photoshop.",
    },
    z.strictObject({
      document_id: docId.optional(),
      layer_id: z.number().int().optional().describe("Text layer to edit"),
      above: z.number().int().optional().describe("New text: put it above this layer (default: above the selected layer)"),
      text: z.string().optional(),
      font: z.string().min(1).optional(),
      size: z.number().min(0.1).max(5000).optional(),
      color: rgb.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      tracking: z.number().min(-1000).max(1000).optional().describe("1/1000 em"),
      leading: z.number().min(0).max(5000).optional().describe("Line spacing in px"),
      caps: z.enum(["normal", "all", "small"]).optional(),
      faux_bold: z.boolean().optional(),
      faux_italic: z.boolean().optional(),
      name: z.string().min(1).optional(),
    }),
  );

  r.bridged(
    "find_fonts",
    { title: "Find fonts", description: "Installed fonts matching a query (name, family or PostScript name), with the PostScript names set_text takes.", readOnly: true, idempotent: true },
    z.strictObject({ query: z.string().optional(), limit: z.number().int().min(1).max(200).default(30) }),
  );

  r.bridged(
    "select",
    {
      title: "Select",
      description:
        "Makes or changes the selection: a shape, all / none / inverse, subject (Select Subject, on layer_id or all layers) or layer (a layer's pixels). Then expand / contract / smooth / feather it, and with mask_layer_id turn it into that layer's mask (the selection is then dropped). Returns the selection's bounds (null: nothing selected).",
    },
    z.strictObject({
      document_id: docId.optional(),
      shape: z.enum(["rect", "ellipse", "polygon", "all", "none", "inverse", "subject", "layer"]).optional(),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("[left, top, right, bottom] px for rect / ellipse"),
      points: z.array(point).optional().describe("[[x,y], ...] for polygon"),
      mode: z.enum(["replace", "add", "subtract", "intersect"]).optional(),
      layer_id: z.number().int().optional().describe("Layer for subject / layer"),
      feather: z.number().min(0).max(1000).optional(),
      expand: z.number().int().min(1).max(500).optional(),
      contract: z.number().int().min(1).max(500).optional(),
      smooth: z.number().int().min(1).max(500).optional(),
      mask_layer_id: z.number().int().optional().describe("Make the selection this layer's mask"),
    }),
  );

  r.tool(
    "sample_colors",
    {
      title: "Sample colors",
      description:
        "Colours of a document or layer, e.g. to match a reference: exact colours at points, and/or a palette of its main colours with their share of the image. Open a reference with open_image to sample it.",
      readOnly: true,
      idempotent: true,
    },
    z.strictObject({
      document_id: docId.optional(),
      layer_id: z.number().int().optional().describe("Palette of this layer only"),
      points: z.array(point).max(50).optional().describe("[[x,y], ...] px"),
      palette: z.number().int().min(1).max(16).optional().describe("Number of main colours (default 6 when no points)"),
    }),
    async (a, signal) => {
      const out: Record<string, unknown> = {};
      if (a.points) {
        const res = (await r.call("sample_points", { document_id: a.document_id, points: a.points }, signal)) as { colors: Array<number[] | null> };
        out.points = res.colors.map((c, i) => ({ at: a.points![i], ...(c ? toSwatch(c) : { rgb: null }) }));
      }
      const k = a.palette ?? (a.points ? 0 : 6);
      if (k) {
        const px = (await r.call("thumbnail_pixels", { document_id: a.document_id, layer_id: a.layer_id, size: 96 }, signal)) as {
          data: string;
          components: number;
        };
        out.palette = palette(new Uint8Array(Buffer.from(px.data, "base64")), px.components, k);
      }
      return out;
    },
  );

  r.tool(
    "export",
    {
      title: "Export",
      description: "Saves a document as PNG, JPEG, PSD or GIF (format from the extension unless given). By default a copy, so the open document keeps its own file.",
      destructive: true,
    },
    z.strictObject({
      document_id: docId.optional(),
      path: z.string().min(1).describe("Absolute output path"),
      format: z.enum(["png", "jpg", "psd", "gif"]).optional(),
      quality: z.number().int().min(0).max(12).optional().describe("JPEG quality (default 10)"),
      as_copy: z.boolean().default(true),
      overwrite: z.boolean().default(false),
    }),
    async (a, signal) => {
      const path = assertAllowed(a.path, ALLOWED_DIRS);
      const ext = extname(path).slice(1).toLowerCase().replace("jpeg", "jpg");
      const format = a.format ?? (["png", "jpg", "psd", "gif"].includes(ext) ? (ext as "png") : undefined);
      if (!format) throw new PsToolError("BAD_ARGS", `Can't tell the format from "${extname(path)}".`, "Use .png, .jpg, .psd or .gif, or pass format.");
      if (!existsSync(dirname(path))) throw new PsToolError("NOT_FOUND", `Folder ${dirname(path)} does not exist.`);
      if (existsSync(path) && !a.overwrite) throw new PsToolError("EXISTS", `${path} already exists.`, "Pass overwrite: true to replace it, or choose another name.");
      await r.call("export", { document_id: a.document_id, path, format, quality: a.quality, as_copy: a.as_copy }, signal);
      // Photoshop can return before the file is complete: wait until it exists and stops growing.
      let last = -1;
      for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((res) => setTimeout(res, 150))) {
        const size = existsSync(path) ? statSync(path).size : -1;
        if (size > 0 && size === last) return { path, format, bytes: size };
        last = size;
      }
      throw new PsToolError("PS_ERROR", `Photoshop reported saving ${path}, but the file did not appear.`, "Check Photoshop for a dialog, then retry.");
    },
  );

  r.bridged(
    "record_actions",
    {
      title: "Record actions",
      description:
        "Records what the user does in Photoshop as batchPlay descriptors: start, let the user do the step by hand, then stop (or peek) to get them. Replay or adapt them with batch_play. Our own tool calls are not recorded.",
      destructive: false,
    },
    z.strictObject({ action: z.enum(["start", "stop", "peek"]) }),
  );
}
