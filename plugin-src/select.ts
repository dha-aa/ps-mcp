// select: make or change the selection (shapes, subject, a layer's pixels), and optionally turn it into a mask.

const MODES = { replace: "REPLACE", add: "EXTEND", subtract: "DIMINISH", intersect: "INTERSECT" } as const;

const SELECTION = { _ref: "channel", _property: "selection" };

commands.select = async (a) => {
  const doc = findDoc(a.document_id);
  const layer = a.layer_id !== undefined ? findLayer(doc, a.layer_id) : null;
  const maskLayer = a.mask_layer_id !== undefined ? findLayer(doc, a.mask_layer_id) : null;
  if ((a.shape === "rect" || a.shape === "ellipse") && !a.bounds) fail("BAD_ARGS", `shape ${a.shape} needs bounds [left, top, right, bottom].`);
  if (a.shape === "polygon" && !(a.points && a.points.length >= 3)) fail("BAD_ARGS", "shape polygon needs at least 3 points.");
  if (a.shape === "layer" && !layer) fail("BAD_ARGS", "shape layer needs layer_id: the layer whose pixels to select.");
  return modal("select", doc, async () => {
    activate(doc);
    const s = doc.selection;
    const mode = ps.constants.SelectionType[MODES[(a.mode ?? "replace") as keyof typeof MODES]];
    const feather = a.feather ?? 0;
    const b = a.bounds ? { left: a.bounds[0], top: a.bounds[1], right: a.bounds[2], bottom: a.bounds[3] } : null;
    switch (a.shape) {
      case "rect":
        await s.selectRectangle(b!, mode, feather, true);
        break;
      case "ellipse":
        await s.selectEllipse(b!, mode, feather, true);
        break;
      case "polygon":
        await s.selectPolygon(a.points.map((p: number[]) => ({ x: p[0], y: p[1] })), mode, feather, true);
        break;
      case "all":
        await s.selectAll();
        break;
      case "none":
        await s.deselect();
        break;
      case "inverse":
        await s.inverse();
        break;
      case "subject":
        // Select Subject has no DOM call; it looks at the target layer unless sampling all layers.
        if (layer) doc.activeLayers = [layer];
        await ps.action.batchPlay([{ _obj: "autoCutout", sampleAllLayers: !layer }], { modalBehavior: "execute" });
        break;
      case "layer":
        await ps.action.batchPlay(
          [{ _obj: "set", _target: [SELECTION], to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "transparencyEnum" }, { _ref: "layer", _id: layer!.id }] } }],
          { modalBehavior: "execute" },
        );
        break;
      case undefined:
        break;
    }
    if (a.expand) await s.expand(a.expand);
    if (a.contract) await s.contract(a.contract);
    if (a.smooth) await s.smooth(a.smooth);
    if (a.shape === undefined && feather) await s.feather(feather);

    const bounds = s.bounds ? box(s.bounds) : null;
    const out: Record<string, unknown> = { selection: bounds };
    if (maskLayer) {
      if (!bounds) fail("BAD_ARGS", "Nothing is selected, so there is no mask to make.", "Select something first (shape, subject or layer).");
      doc.activeLayers = [maskLayer];
      await ps.action.batchPlay(
        [{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }],
        { modalBehavior: "execute" },
      );
      await s.deselect();
      out.mask_on = maskLayer.id;
    }
    return out;
  });
};
