// Text: set_text creates a text layer (no layer_id) or edits one; find_fonts looks up PostScript names.

const CAPS = { normal: "NORMAL", all: "ALLCAPS", small: "SMALLCAPS" } as const;
const ALIGN = { left: "LEFT", center: "CENTER", right: "RIGHT" } as const;

function solidColor(c: number[]): PsSolidColor {
  const s = new ps.app.SolidColor();
  s.rgb.red = Math.round(c[0] * 255);
  s.rgb.green = Math.round(c[1] * 255);
  s.rgb.blue = Math.round(c[2] * 255);
  return s;
}

function rgb01(c: { red: number; green: number; blue: number } | undefined): number[] | undefined {
  return c ? [round(c.red / 255, 1000), round(c.green / 255, 1000), round(c.blue / 255, 1000)] : undefined;
}

function textInfo(layer: PsLayer): Record<string, unknown> {
  const t = layer.textItem;
  const cs = t.characterStyle;
  return {
    layer: { id: layer.id, name: layer.name },
    bounds: box(layer.bounds),
    font: cs.font,
    size: round(cs.size),
    color: rgb01(cs.color && cs.color.rgb),
  };
}

commands.set_text = async (a) => {
  const doc = findDoc(a.document_id);
  const existing = a.layer_id !== undefined ? findLayer(doc, a.layer_id) : null;
  if (existing && existing.kind !== "text") fail("BAD_ARGS", `Layer ${existing.id} is a ${existing.kind} layer, not text.`, "Omit layer_id to make a new text layer.");
  if (!existing && a.text === undefined) fail("BAD_ARGS", "text is required for a new text layer.");
  const above = !existing && a.above !== undefined ? findLayer(doc, a.above) : null;
  return modal("set_text", doc, async () => {
    activate(doc);
    if (above) doc.activeLayers = [above];
    const contents = a.text === undefined ? undefined : String(a.text).replace(/\r?\n/g, "\r");
    let layer = existing;
    if (!layer) {
      layer = await doc.createTextLayer({
        name: a.name,
        contents: contents!,
        fontName: a.font,
        fontSize: a.size,
        textColor: a.color ? solidColor(a.color) : undefined,
      });
      if (!layer) fail("PS_ERROR", "Photoshop did not create the text layer.");
      // Photoshop ignores createTextLayer's name (it names text after its contents).
      if (a.name !== undefined) layer.name = a.name;
    } else {
      if (contents !== undefined) layer.textItem.contents = contents;
      if (a.name !== undefined) layer.name = a.name;
    }
    // Style after contents: new contents can take the first character's style.
    const t = layer.textItem;
    const cs = t.characterStyle;
    if (existing && a.font !== undefined) cs.font = a.font;
    if (existing && a.size !== undefined) cs.size = a.size;
    if (existing && a.color) cs.color = solidColor(a.color);
    if (a.tracking !== undefined) cs.tracking = a.tracking;
    if (a.leading !== undefined) {
      cs.useAutoLeading = false;
      cs.leading = a.leading;
    }
    if (a.caps !== undefined) cs.capitalization = ps.constants.TextCase[CAPS[a.caps as keyof typeof CAPS]];
    if (a.faux_bold !== undefined) cs.fauxBold = a.faux_bold === true;
    if (a.faux_italic !== undefined) cs.fauxItalic = a.faux_italic === true;
    if (a.align !== undefined) t.paragraphStyle.justification = ps.constants.Justification[ALIGN[a.align as keyof typeof ALIGN]];
    const x = a.x ?? (existing ? undefined : doc.width / 2);
    const y = a.y ?? (existing ? undefined : doc.height / 2);
    await centreAt(layer, x, y);
    const out = textInfo(layer);
    // A missing font is silently replaced: say so, the model can't see it otherwise.
    if (a.font !== undefined && out.font !== a.font) out.font_substituted = `${a.font} is not installed; Photoshop used ${out.font}. find_fonts lists installed fonts.`;
    return out;
  });
};

commands.find_fonts = async (a) => {
  const q = String(a.query || "").toLowerCase();
  const all = Array.from(ps.app.fonts);
  const hits = all.filter((f) => !q || f.name.toLowerCase().indexOf(q) >= 0 || f.postScriptName.toLowerCase().indexOf(q) >= 0 || f.family.toLowerCase().indexOf(q) >= 0);
  const limit = a.limit ?? 30;
  return {
    total: hits.length,
    fonts: hits.slice(0, limit).map((f) => ({ postscript: f.postScriptName, family: f.family, style: f.style })),
  };
};
