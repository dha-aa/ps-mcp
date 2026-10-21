// Schemas shared by several tools.
import * as z from "zod/v4";

/** Most used first: the advertised schema shows the first few as examples. */
export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "soft_light", "color_dodge", "dissolve", "darken", "color_burn", "linear_burn",
  "darker_color", "lighten", "linear_dodge", "lighter_color", "hard_light", "vivid_light", "linear_light", "pin_light", "hard_mix",
  "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity", "pass_through",
] as const;

export const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).describe("[r,g,b] 0-1");

export const docId = z.number().int().describe("Document id (default: the active document)");

export const stops = z
  .array(z.strictObject({ color: rgb, at: z.number().min(0).max(1).optional(), opacity: z.number().min(0).max(100).optional() }))
  .min(2)
  .describe("Gradient stops; at 0-1 (default evenly spaced), opacity 0-100");
