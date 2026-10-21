// Looks: apply_filter, add_fill, add_adjustment, set_style.
import * as z from "zod/v4";
import type { ToolRegistry } from "./registry.ts";
import { BLEND_MODES, docId, rgb, stops } from "./schemas.ts";

const above = z.number().int().optional().describe("Put the new layer above this one (default: above the selected layer)");

export function registerLookTools(r: ToolRegistry): void {
  r.bridged(
    "apply_filter",
    {
      title: "Apply filter",
      description:
        "Runs a filter on a pixel layer (rasterize: true converts a smart object / text first). Parameters by filter: gaussian_blur radius; motion_blur angle, distance; add_noise amount (%), distribution, monochromatic; high_pass radius; unsharp_mask amount (%), radius, threshold; median / minimum / maximum radius; dust_and_scratches radius, threshold; twirl angle; pinch amount (-100..100); offset horizontal, vertical; sharpen, clouds, despeckle none.",
    },
    z.strictObject({
      document_id: docId.optional(),
      layer_id: z.number().int(),
      filter: z.enum(["gaussian_blur", "motion_blur", "add_noise", "high_pass", "unsharp_mask", "sharpen", "median", "dust_and_scratches", "minimum", "maximum", "twirl", "pinch", "offset", "clouds", "despeckle"]),
      radius: z.number().positive().optional(),
      amount: z.number().optional(),
      angle: z.number().optional(),
      distance: z.number().positive().optional(),
      threshold: z.number().min(0).max(255).optional(),
      distribution: z.enum(["gaussian", "uniform"]).optional(),
      monochromatic: z.boolean().optional(),
      horizontal: z.number().optional(),
      vertical: z.number().optional(),
      rasterize: z.boolean().optional(),
    }),
  );

  r.bridged(
    "add_fill",
    {
      title: "Add fill",
      description:
        "Adds a solid or gradient fill layer, full canvas or shaped (rect / ellipse / polygon: the shape becomes its mask). Gradients: linear / radial / angle / reflected / diamond, angle in degrees (90 = bottom to top), scale %, center [x,y] px. clip: clip to the layer below.",
      destructive: false,
    },
    z.strictObject({
      document_id: docId.optional(),
      type: z.enum(["solid", "gradient"]),
      color: rgb.optional(),
      colors: stops.optional(),
      gradient: z.enum(["linear", "radial", "angle", "reflected", "diamond"]).optional(),
      angle: z.number().optional(),
      scale: z.number().min(1).max(1000).optional(),
      center: z.tuple([z.number(), z.number()]).optional(),
      shape: z.enum(["rect", "ellipse", "polygon"]).optional(),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      points: z.array(z.tuple([z.number(), z.number()])).optional(),
      feather: z.number().min(0).max(1000).optional(),
      name: z.string().min(1).optional(),
      opacity: z.number().min(0).max(100).optional(),
      blend: z.enum(BLEND_MODES).optional(),
      clip: z.boolean().optional(),
      above,
    }),
  );

  r.bridged(
    "add_adjustment",
    {
      title: "Add adjustment",
      description:
        "Adds an adjustment layer (clip: true affects only the layer below). Parameters by type: brightness_contrast brightness, contrast (-100..100); hue_saturation hue, saturation, lightness, colorize; vibrance vibrance, saturation; black_white tint; levels input [black, white], gamma, output; curves points [[in,out]...] 0-255; photo_filter color, density; gradient_map colors; posterize levels; threshold level; invert.",
      destructive: false,
    },
    z.strictObject({
      document_id: docId.optional(),
      type: z.enum(["brightness_contrast", "hue_saturation", "vibrance", "black_white", "levels", "curves", "photo_filter", "gradient_map", "invert", "posterize", "threshold"]),
      brightness: z.number().min(-150).max(150).optional(),
      contrast: z.number().min(-50).max(100).optional(),
      hue: z.number().min(-180).max(180).optional(),
      saturation: z.number().min(-100).max(100).optional(),
      lightness: z.number().min(-100).max(100).optional(),
      colorize: z.boolean().optional(),
      vibrance: z.number().min(-100).max(100).optional(),
      tint: rgb.optional(),
      input: z.tuple([z.number().min(0).max(255), z.number().min(0).max(255)]).optional(),
      gamma: z.number().min(0.1).max(9.99).optional(),
      output: z.tuple([z.number().min(0).max(255), z.number().min(0).max(255)]).optional(),
      points: z.array(z.tuple([z.number().min(0).max(255), z.number().min(0).max(255)])).min(2).optional(),
      color: rgb.optional(),
      density: z.number().min(1).max(100).optional(),
      colors: stops.optional(),
      levels: z.number().int().min(2).max(255).optional(),
      level: z.number().int().min(1).max(255).optional(),
      name: z.string().min(1).optional(),
      opacity: z.number().min(0).max(100).optional(),
      blend: z.enum(BLEND_MODES).optional(),
      clip: z.boolean().optional(),
      above,
    }),
  );

  const effectBlend = z.enum(["normal", "multiply", "screen", "overlay", "soft_light", "color_dodge", "linear_dodge"]);
  const effect = (extra: z.ZodRawShape) =>
    z.union([z.literal(false), z.strictObject({ color: rgb.optional(), opacity: z.number().min(0).max(100).optional(), blend: effectBlend.optional(), ...extra })]).optional();
  const size = z.number().min(0).max(250).optional();
  r.bridged(
    "set_style",
    {
      title: "Set style",
      description:
        "Sets layer effects (layer styles), keeping the others: stroke, drop_shadow, outer_glow, inner_glow, color_overlay. false turns one off; clear: true turns off every effect not given. Sizes in px, angle in degrees.",
    },
    z.strictObject({
      document_id: docId.optional(),
      layer_id: z.number().int(),
      stroke: effect({ size, position: z.enum(["outside", "inside", "center"]).optional() }),
      drop_shadow: effect({ size, distance: z.number().min(0).max(30000).optional(), angle: z.number().optional(), spread: size }),
      outer_glow: effect({ size, spread: size }),
      inner_glow: effect({ size, spread: size }),
      color_overlay: effect({}),
      clear: z.boolean().optional(),
    }),
  );
}
