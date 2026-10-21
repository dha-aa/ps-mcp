// Looks: apply_filter (Layer.applyX), add_fill (solid / gradient fill layers, optionally shaped),
// add_adjustment (adjustment layers) and set_style (layer effects, merged with what is there).

const rgbDesc = (c: number[]) => ({ _obj: "RGBColor", red: Math.round(c[0] * 255), grain: Math.round(c[1] * 255), blue: Math.round(c[2] * 255) });
const pctDesc = (v: number) => ({ _unit: "percentUnit", _value: v });
const pxDesc = (v: number) => ({ _unit: "pixelsUnit", _value: v });
const blendDesc = (m: string) => ({ _enum: "blendMode", _value: m.replace(/_(\w)/g, (_: string, c: string) => c.toUpperCase()) });

/** Each filter: the Layer method and its arguments from the call's parameters (required ones checked). */
const FILTERS: Record<string, { method: string; need: string[]; args: (a: Args) => unknown[] }> = {
  gaussian_blur: { method: "applyGaussianBlur", need: ["radius"], args: (a) => [a.radius] },
  motion_blur: { method: "applyMotionBlur", need: ["angle", "distance"], args: (a) => [a.angle, a.distance] },
  add_noise: {
    method: "applyAddNoise",
    need: ["amount"],
    args: (a) => [a.amount, ps.constants.NoiseDistribution[a.distribution === "uniform" ? "UNIFORM" : "GAUSSIAN"], a.monochromatic === true],
  },
  high_pass: { method: "applyHighPass", need: ["radius"], args: (a) => [a.radius] },
  unsharp_mask: { method: "applyUnSharpMask", need: ["amount", "radius"], args: (a) => [a.amount, a.radius, a.threshold ?? 0] },
  sharpen: { method: "applySharpen", need: [], args: () => [] },
  median: { method: "applyMedianNoise", need: ["radius"], args: (a) => [a.radius] },
  dust_and_scratches: { method: "applyDustAndScratches", need: ["radius"], args: (a) => [a.radius, a.threshold ?? 0] },
  minimum: { method: "applyMinimum", need: ["radius"], args: (a) => [a.radius] },
  maximum: { method: "applyMaximum", need: ["radius"], args: (a) => [a.radius] },
  twirl: { method: "applyTwirl", need: ["angle"], args: (a) => [a.angle] },
  pinch: { method: "applyPinch", need: ["amount"], args: (a) => [a.amount] },
  offset: { method: "applyOffset", need: ["horizontal", "vertical"], args: (a) => [a.horizontal, a.vertical] },
  clouds: { method: "applyClouds", need: [], args: () => [] },
  despeckle: { method: "applyDespeckle", need: [], args: () => [] },
};

commands.apply_filter = async (a) => {
  const doc = findDoc(a.document_id);
  const layer = findLayer(doc, a.layer_id);
  const f = FILTERS[a.filter];
  if (!f) fail("BAD_ARGS", `Unknown filter ${a.filter}.`, "Valid: " + Object.keys(FILTERS).join(", "));
  const missing = f.need.filter((k) => a[k] === undefined);
  if (missing.length) fail("BAD_ARGS", `${a.filter} needs ${missing.join(", ")}.`);
  if (layer.kind !== "pixel" && a.rasterize !== true) {
    fail("BAD_ARGS", `Layer ${layer.id} is a ${layer.kind} layer; filters need pixels.`, "Pass rasterize: true to rasterize it first (smart object / text become pixels).");
  }
  return modal("apply_filter", doc, async () => {
    // On a smart object Photoshop would make a smart filter without a word: rasterize first and check it worked.
    if (layer.kind !== "pixel") await rasterizeChecked(doc, layer);
    else selectLayer(doc, layer);
    await layer[f.method as `apply${string}`](...f.args(a));
    return { layer: layerBrief(layer), filter: a.filter };
  });
};

/** Selects the shape (rect / ellipse / polygon) so the next fill layer is masked to it. */
async function selectShape(doc: PsDocument, a: Args): Promise<void> {
  const s = doc.selection;
  const mode = ps.constants.SelectionType.REPLACE;
  const b = a.bounds ? { left: a.bounds[0], top: a.bounds[1], right: a.bounds[2], bottom: a.bounds[3] } : null;
  if (a.shape === "rect") await s.selectRectangle(b!, mode, a.feather ?? 0, true);
  else if (a.shape === "ellipse") await s.selectEllipse(b!, mode, a.feather ?? 0, true);
  else await s.selectPolygon(a.points.map((p: number[]) => ({ x: p[0], y: p[1] })), mode, a.feather ?? 0, true);
}

function gradientDesc(a: Args, name: string): object {
  const stops: Array<{ color: number[]; at?: number; opacity?: number }> = a.colors;
  const at = (s: { at?: number }, i: number) => Math.round((s.at ?? i / Math.max(1, stops.length - 1)) * 4096);
  const g: Record<string, unknown> = {
    _obj: "gradientLayer",
    type: { _enum: "gradientType", _value: a.gradient ?? "linear" },
    angle: { _unit: "angleUnit", _value: a.angle ?? 90 },
    scale: pctDesc(a.scale ?? 100),
    gradient: {
      _obj: "gradientClassEvent",
      name,
      gradientForm: { _enum: "gradientForm", _value: "customStops" },
      interfaceIconFrameDimmed: 4096,
      colors: stops.map((s, i) => ({ _obj: "colorStop", color: rgbDesc(s.color), type: { _enum: "colorStopType", _value: "userStop" }, location: at(s, i), midpoint: 50 })),
      transparency: stops.map((s, i) => ({ _obj: "transferSpec", opacity: pctDesc(s.opacity ?? 100), location: at(s, i), midpoint: 50 })),
    },
  };
  if (a.center) g.offset = { _obj: "paint", horizontal: pctDesc(((a.center[0] - a.doc_w / 2) / a.doc_w) * 100), vertical: pctDesc(((a.center[1] - a.doc_h / 2) / a.doc_h) * 100) };
  return g;
}

commands.add_fill = async (a) => {
  const doc = findDoc(a.document_id);
  if (a.type === "solid" && !a.color) fail("BAD_ARGS", "A solid fill needs color.");
  if (a.type === "gradient" && !(a.colors && a.colors.length >= 2)) fail("BAD_ARGS", "A gradient needs at least 2 colors.");
  if ((a.shape === "rect" || a.shape === "ellipse") && !a.bounds) fail("BAD_ARGS", `shape ${a.shape} needs bounds.`);
  if (a.shape === "polygon" && !(a.points && a.points.length >= 3)) fail("BAD_ARGS", "shape polygon needs at least 3 points.");
  const above = a.above !== undefined ? findLayer(doc, a.above) : null;
  return modal("add_fill", doc, async () => {
    activate(doc);
    if (above) doc.activeLayers = [above];
    if (a.shape) await selectShape(doc, a);
    const name = a.name ?? (a.type === "solid" ? "Fill" : "Gradient");
    const type = a.type === "solid" ? { _obj: "solidColorLayer", color: rgbDesc(a.color) } : gradientDesc({ ...a, doc_w: doc.width, doc_h: doc.height }, name);
    const using: Record<string, unknown> = { _obj: "contentLayer", name, type };
    if (a.clip === true) using.group = true;
    // A fill layer made with an active selection takes it as its mask (seen live).
    await ps.action.batchPlay([{ _obj: "make", _target: [{ _ref: "contentLayer" }], using }], { modalBehavior: "execute" });
    if (a.shape) await doc.selection.deselect();
    const layer = doc.activeLayers[0];
    if (a.opacity !== undefined) layer.opacity = a.opacity;
    if (a.blend !== undefined) layer.blendMode = constant("BlendMode", a.blend) as string;
    return { layer: layerBrief(layer) };
  });
};

/** Adjustment descriptors (Image > Adjustments), from the call's parameters. */
const ADJUSTMENTS: Record<string, (a: Args) => object> = {
  brightness_contrast: (a) => ({ _obj: "brightnessEvent", brightness: a.brightness ?? 0, center: a.contrast ?? 0, useLegacy: false }),
  hue_saturation: (a) => ({
    _obj: "hueSaturation",
    presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
    colorize: a.colorize === true,
    adjustment: [{ _obj: "hueSatAdjustmentV2", hue: a.hue ?? 0, saturation: a.saturation ?? 0, lightness: a.lightness ?? 0 }],
  }),
  vibrance: (a) => ({ _obj: "vibrance", vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 }),
  black_white: (a) => {
    const d: Record<string, unknown> = { _obj: "blackAndWhite", presetKind: { _enum: "presetKindType", _value: "presetKindDefault" }, red: 40, yellow: 60, grain: 40, cyan: 60, blue: 20, magenta: 80, useTint: !!a.tint };
    if (a.tint) d.tintColor = rgbDesc(a.tint);
    return d;
  },
  levels: (a) => ({
    _obj: "levels",
    presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
    adjustment: [{ _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "composite" }, input: a.input ?? [0, 255], gamma: a.gamma ?? 1, output: a.output ?? [0, 255] }],
  }),
  curves: (a) => ({
    _obj: "curves",
    presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
    adjustment: [{ _obj: "curvesAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "composite" }, curve: (a.points ?? [[0, 0], [255, 255]]).map((p: number[]) => ({ _obj: "paint", horizontal: p[0], vertical: p[1] })) }],
  }),
  photo_filter: (a) => ({ _obj: "photoFilter", color: rgbDesc(a.color ?? [0.93, 0.54, 0.13]), density: a.density ?? 25, preserveLuminosity: true }),
  gradient_map: (a) => ({ _obj: "gradientMapClass", gradient: (gradientDesc({ colors: a.colors ?? [{ color: [0, 0, 0] }, { color: [1, 1, 1] }] }, "Map") as { gradient: object }).gradient, dither: false, reverse: false }),
  invert: () => ({ _obj: "invert" }),
  posterize: (a) => ({ _obj: "posterization", levels: a.levels ?? 4 }),
  threshold: (a) => ({ _obj: "thresholdClassEvent", level: a.level ?? 128 }),
};

commands.add_adjustment = async (a) => {
  const doc = findDoc(a.document_id);
  const make = ADJUSTMENTS[a.type];
  if (!make) fail("BAD_ARGS", `Unknown adjustment ${a.type}.`, "Valid: " + Object.keys(ADJUSTMENTS).join(", "));
  const above = a.above !== undefined ? findLayer(doc, a.above) : null;
  return modal("add_adjustment", doc, async () => {
    activate(doc);
    if (above) doc.activeLayers = [above];
    const using: Record<string, unknown> = { _obj: "adjustmentLayer", type: make(a) };
    if (a.name !== undefined) using.name = a.name;
    if (a.clip === true) using.group = true;
    await ps.action.batchPlay([{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }], using }], { modalBehavior: "execute" });
    const layer = doc.activeLayers[0];
    if (a.opacity !== undefined) layer.opacity = a.opacity;
    if (a.blend !== undefined) layer.blendMode = constant("BlendMode", a.blend) as string;
    return { layer: layerBrief(layer) };
  });
};

/** Layer-effect descriptors from the call's parameters. */
function effectDesc(kind: string, e: Args): [string, object] {
  const base = { enabled: true, present: true, showInDialog: true, mode: blendDesc(e.blend ?? (kind === "drop_shadow" ? "multiply" : kind === "outer_glow" || kind === "inner_glow" ? "screen" : "normal")), opacity: pctDesc(e.opacity ?? (kind === "drop_shadow" ? 50 : 100)) };
  switch (kind) {
    case "stroke":
      return ["frameFX", { _obj: "frameFX", ...base, style: { _enum: "frameStyle", _value: (e.position ?? "outside") + "Frame" }, paintType: { _enum: "frameFill", _value: "solidColor" }, size: pxDesc(e.size ?? 4), color: rgbDesc(e.color ?? [1, 1, 1]) }];
    case "drop_shadow":
      return ["dropShadow", { _obj: "dropShadow", ...base, color: rgbDesc(e.color ?? [0, 0, 0]), useGlobalAngle: false, localLightingAngle: { _unit: "angleUnit", _value: e.angle ?? 90 }, distance: pxDesc(e.distance ?? 8), chokeMatte: pxDesc(e.spread ?? 0), blur: pxDesc(e.size ?? 20), noise: pctDesc(0), antiAlias: false }];
    case "outer_glow":
      return ["outerGlow", { _obj: "outerGlow", ...base, color: rgbDesc(e.color ?? [1, 1, 1]), technique: { _enum: "bevelTechnique", _value: "softMatte" }, chokeMatte: pxDesc(e.spread ?? 0), blur: pxDesc(e.size ?? 30), noise: pctDesc(0), shadingNoise: pctDesc(0), antiAlias: false, inputRange: pctDesc(50) }];
    case "inner_glow":
      return ["innerGlow", { _obj: "innerGlow", ...base, color: rgbDesc(e.color ?? [1, 1, 1]), technique: { _enum: "bevelTechnique", _value: "softMatte" }, innerGlowSource: { _enum: "innerGlowSourceType", _value: "edgeGlow" }, chokeMatte: pxDesc(e.spread ?? 0), blur: pxDesc(e.size ?? 20), noise: pctDesc(0), shadingNoise: pctDesc(0), antiAlias: false, inputRange: pctDesc(50) }];
    default:
      return ["solidFill", { _obj: "solidFill", ...base, color: rgbDesc(e.color ?? [1, 1, 1]) }];
  }
}

const EFFECT_KEYS: Record<string, string> = { stroke: "frameFX", drop_shadow: "dropShadow", outer_glow: "outerGlow", inner_glow: "innerGlow", color_overlay: "solidFill" };

commands.set_style = async (a) => {
  const doc = findDoc(a.document_id);
  const layer = findLayer(doc, a.layer_id);
  if (layer.isBackgroundLayer) fail("BAD_ARGS", "The Background layer can't have layer styles.", "Duplicate it first (layer_ops duplicate).");
  return modal("set_style", doc, async () => {
    activate(doc);
    const got = await ps.action.batchPlay([{ _obj: "get", _target: [{ _ref: "layer", _id: layer.id }] }], { modalBehavior: "execute" });
    const fx: Record<string, any> = { _obj: "layerEffects", scale: pctDesc(100), ...((got[0] && got[0].layerEffects) || {}) };
    const changed: string[] = [];
    for (const kind of Object.keys(EFFECT_KEYS)) {
      const key = EFFECT_KEYS[kind];
      if (a[kind] === undefined) {
        if (a.clear === true && fx[key]) fx[key] = { ...fx[key], enabled: false };
        continue;
      }
      // Newer Photoshop keeps several of an effect in "<key>Multi"; we set exactly one.
      delete fx[key + "Multi"];
      if (a[kind] === false) {
        if (fx[key]) fx[key] = { ...fx[key], enabled: false };
      } else {
        fx[key] = effectDesc(kind, a[kind])[1];
      }
      changed.push(kind);
    }
    await ps.action.batchPlay([{ _obj: "set", _target: [{ _ref: "property", _property: "layerEffects" }, { _ref: "layer", _id: layer.id }], to: fx }], { modalBehavior: "execute" });
    const on = Object.keys(EFFECT_KEYS).filter((k) => fx[EFFECT_KEYS[k]] && fx[EFFECT_KEYS[k]].enabled !== false);
    return { layer: layerBrief(layer), changed, effects: on };
  });
};
