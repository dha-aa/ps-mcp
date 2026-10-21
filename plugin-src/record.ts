// record_actions: listen to what the user does in Photoshop and hand back each step as a batchPlay descriptor,
// so the model can replay or adapt it with batch_play instead of guessing descriptors.

/** Action events from Adobe's event-code table (ps-reference/media/eventcodes.md, Apache-2.0), plus ones it
 * misses that we have seen live (fill, autoCutout, hide, rasterizeLayer...). */
const RECORD_EVENTS = [
  "$Avrg", "$BacL", "$ColE", "$DrfC", "$Fbrs", "$FilE", "$HsbP", "$Jpto", "3DTransform", "NTSC", "accentedEdges",
  "add", "addNoise", "addTo", "align", "all", "angledStrokes", "applyImageEvent", "applyStyle", "assert",
  "autoCutout", "basRelief", "batch", "batchFromDroplet", "blurEvent", "blurMethod", "border", "brightnessEvent",
  "canvasSize", "centerCropMarks", "chalkCharcoal", "channelMixer", "charcoal", "chrome", "clearEvent", "close",
  "clouds", "colorBalance", "colorHalftone", "colorPalette", "colorRange", "contract", "convertMode", "copyEffects",
  "copyEvent", "copyMerged", "copyToLayer", "craquelure", "createDroplet", "crop", "crosshatch", "crystallize",
  "curves", "custom", "cut", "cutToLayer", "darkStrokes", "deInterlace", "definePattern", "defringe", "delete",
  "desaturate", "deselect", "despeckle", "diffuse", "diffuseGlow", "disableLayerFX", "displace", "distort", "draw",
  "dryBrush", "duplicate", "dustAndScratches", "emboss", "equalize", "exchange", "expand", "export", "extrude",
  "facet", "fade", "feather", "fill", "filmGrain", "filter", "findEdges", "flattenImage", "flip", "fragment",
  "fresco", "gaussianBlur", "get", "glass", "glowingEdges", "gradientClassEvent", "gradientMapEvent", "grain",
  "graphicPen", "groupEvent", "groupLayersEvent", "grow", "halftoneScreen", "hide", "highPass", "hueSaturation",
  "imageSize", "import", "inkOutlines", "interfaceIconFrameDimmed", "interfaceWhite", "inverse", "invert",
  "layerEffects", "lensFlare", "levels", "lightingEffects", "link", "make", "maximum", "median", "mergeLayers",
  "mergeLayersNew", "mergeSpotChannel", "mergeVisible", "mezzotint", "minimum", "mosaic", "mosaicPlugin",
  "motionBlur", "move", "moveTo", "neonGlow", "newPlacedLayer", "next", "notePaper", "notify", "oceanRipple",
  "offset", "open", "paint", "paintDaubs", "paletteKnife", "paste", "pasteEffects", "pasteInto", "pasteOutside",
  "patchwork", "photocopy", "pinch", "placeEvent", "placedLayerEditContents", "plaster", "plasticWrap", "play",
  "pointillize", "polar", "posterEdges", "posterization", "previous", "print", "profileToProfile", "purge", "quit",
  "radialBlur", "rasterize", "rasterizeLayer", "rasterizeTypeLayer", "removeBlackMatte", "removeLayerMask",
  "removeWhiteMatte", "rename", "replaceColor", "reset", "reticulation", "revert", "ripple", "rotateEventEnum",
  "roughPastels", "save", "select", "selectiveColor", "separationSetup", "set", "setd", "sharpen", "sharpenEdges",
  "sharpenMore", "shear", "show", "similar", "smartBlur", "smoothness", "smudgeStick", "solarize", "spatter",
  "spherize", "splitChannels", "sponge", "stainedGlass", "stamp", "stop", "stroke", "subtract", "subtractFrom",
  "sumie", "takeMergedSnapshot", "takeSnapshot", "textureFile", "texturizer", "thresholdClassEvent", "tiles",
  "tornEdges", "traceContour", "transform", "trap", "twirl", "underpainting", "undoEvent", "ungroup",
  "ungroupLayersEvent", "unlink", "unsharpMask", "variations", "wait", "waterPaper", "watercolor", "wave", "wind",
  "zigZag",
];

const RECORD_LIMIT = 200;

let recording: { steps: Array<{ event: string; descriptor: unknown }>; dropped: number; failed: string[] } | null = null;

function onRecordedEvent(event: string, descriptor: unknown): void {
  // Our own commands also fire events: leave them out.
  if (!recording || running) return;
  if (recording.steps.length >= RECORD_LIMIT) {
    recording.dropped++;
    return;
  }
  recording.steps.push({ event, descriptor });
}

/** Subscribes one event at a time: an event name this Photoshop doesn't know must not stop the rest. */
async function listenAll(on: boolean): Promise<string[]> {
  const failed: string[] = [];
  for (const e of RECORD_EVENTS) {
    try {
      if (on) await ps.action.addNotificationListener([e], onRecordedEvent);
      else await ps.action.removeNotificationListener([e], onRecordedEvent);
    } catch {
      failed.push(e);
    }
  }
  return failed;
}

commands.record_actions = async (a) => {
  if (a.action === "start") {
    const fresh = !recording;
    recording = { steps: [], dropped: 0, failed: fresh ? await listenAll(true) : recording!.failed };
    return { recording: true, events: RECORD_EVENTS.length - recording.failed.length };
  }
  if (!recording) fail("BAD_ARGS", "Not recording.", "Call record_actions with action start, let the user work in Photoshop, then stop.");
  const r = recording;
  if (a.action === "stop") {
    recording = null;
    await listenAll(false);
  }
  const out: Record<string, unknown> = { recording: a.action !== "stop", steps: r.steps };
  if (a.action === "peek") out.steps = r.steps.slice();
  if (r.dropped) out.dropped = r.dropped;
  return out;
};
