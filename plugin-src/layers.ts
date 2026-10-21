// Layers: set_layer (properties, transform, order) and layer_ops (new, duplicate, delete, group, merge, rasterize).

function layerBrief(l: PsLayer): Record<string, unknown> {
  return { id: l.id, name: l.name, kind: l.kind, bounds: box(l.bounds) };
}

function centreOf(l: PsLayer): { x: number; y: number } {
  const b = l.bounds;
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

commands.set_layer = async (a) => {
  const doc = findDoc(a.document_id);
  const layer = findLayer(doc, a.layer_id);
  const rel = a.above ?? a.below ?? a.into;
  const relLayer = rel !== undefined ? findLayer(doc, rel) : null;
  if (a.into !== undefined && relLayer && relLayer.kind !== "group") fail("BAD_ARGS", `Layer ${rel} is not a group.`);
  if (layer.isBackgroundLayer && (a.x !== undefined || a.y !== undefined || a.dx || a.dy || a.scale || a.rotate || a.order || rel !== undefined)) {
    fail("BAD_ARGS", "The Background layer can't be moved, transformed or reordered.", "Duplicate it (layer_ops duplicate) and change the copy.");
  }
  return modal("set_layer", doc, async () => {
    // Selected first (the lock follows the selection); unlocked before and locked after the other changes,
    // which a locked layer would silently ignore.
    selectLayer(doc, layer);
    if (a.locked === false) layer.allLocked = false;
    if (a.name !== undefined) layer.name = a.name;
    if (a.visible !== undefined) layer.visible = a.visible === true;
    if (a.opacity !== undefined) layer.opacity = a.opacity;
    if (a.fill_opacity !== undefined) layer.fillOpacity = a.fill_opacity;
    if (a.blend !== undefined) layer.blendMode = constant("BlendMode", a.blend) as string;
    if (a.clip !== undefined) layer.isClippingMask = a.clip === true;
    // Transforms keep the layer's centre: Photoshop rejected every anchor value we tried (see CLAUDE.md).
    if (a.scale !== undefined || a.rotate !== undefined || a.flip !== undefined) {
      const c = centreOf(layer);
      if (a.scale !== undefined) {
        const [w, h] = Array.isArray(a.scale) ? a.scale : [a.scale, a.scale];
        await layer.scale(w, h);
      }
      if (a.rotate) await layer.rotate(a.rotate);
      // Photoshop 27.10 has no constants.FlipAxis (the docs list it): flip with Edit > Transform's descriptor.
      if (a.flip) {
        for (const axis of a.flip === "both" ? ["horizontal", "vertical"] : [a.flip]) {
          await play([{ _obj: "flip", _target: [{ _ref: "layer", _id: layer.id }], axis: { _enum: "orientation", _value: axis } }], "set_layer");
        }
      }
      if (a.x === undefined && a.y === undefined) await centreAt(layer, c.x, c.y);
    }
    if (a.x !== undefined || a.y !== undefined) await centreAt(layer, a.x, a.y);
    if (a.dx || a.dy) await layer.translate(a.dx ?? 0, a.dy ?? 0);
    if (a.order === "front") await layer.bringToFront();
    if (a.order === "back") await layer.sendToBack();
    if (relLayer) {
      const place = a.above !== undefined ? "PLACEBEFORE" : a.below !== undefined ? "PLACEAFTER" : "PLACEINSIDE";
      await layer.move(relLayer, ps.constants.ElementPlacement[place as "PLACEBEFORE"]);
    }
    if (a.locked === true) layer.allLocked = true;
    const out = layerBrief(layer);
    if (a.locked !== undefined && layer.allLocked !== (a.locked === true)) fail("PS_ERROR", `Photoshop did not ${a.locked ? "lock" : "unlock"} layer ${layer.id}.`);
    if (layer.allLocked) out.locked = true;
    if (layer.opacity !== 100) out.opacity = round(layer.opacity, 1);
    if (layer.blendMode && layer.blendMode !== "normal") out.blend = layer.blendMode;
    if (!layer.visible) out.visible = false;
    return out;
  });
};

commands.layer_ops = async (a) => {
  const doc = findDoc(a.document_id);
  const ids: number[] = a.layer_ids ?? [];
  const layers = ids.map((id) => findLayer(doc, id));
  const need = (n: number) => {
    if (layers.length < n) fail("BAD_ARGS", `${a.op} needs ${n === 1 ? "a layer" : "at least " + n + " layers"} in layer_ids.`);
  };
  const above = a.above !== undefined ? findLayer(doc, a.above) : null;
  return modal("layer_ops " + a.op, doc, async () => {
    activate(doc);
    if (above) doc.activeLayers = [above];
    switch (a.op) {
      // createPixelLayer / createLayerGroup put the layer on top whatever is selected (seen live): move it.
      case "new_layer": {
        const l = await doc.createPixelLayer({ name: a.name });
        if (above) await l.move(above, ps.constants.ElementPlacement.PLACEBEFORE);
        return { layer: layerBrief(l) };
      }
      case "new_group": {
        const g = await doc.createLayerGroup({ name: a.name });
        if (above) await g.move(above, ps.constants.ElementPlacement.PLACEBEFORE);
        return { layer: layerBrief(g) };
      }
      case "duplicate": {
        need(1);
        const made: unknown[] = [];
        for (const l of layers) {
          const d = await l.duplicate();
          if (a.name !== undefined && layers.length === 1) d.name = a.name;
          made.push(layerBrief(d));
        }
        return { layers: made };
      }
      case "delete": {
        need(1);
        for (const l of layers) await l.delete();
        return { deleted: ids };
      }
      case "group": {
        need(1);
        const g = await doc.groupLayers(layers);
        if (a.name !== undefined) g.name = a.name;
        return { layer: layerBrief(g), grouped: ids };
      }
      case "merge": {
        need(2);
        // Merge the selected layers into the top one (Layer > Merge Layers).
        doc.activeLayers = layers;
        await play([{ _obj: "mergeLayersNew" }], "set_layer");
        const m = doc.activeLayers[0];
        if (a.name !== undefined) m.name = a.name;
        return { layer: layerBrief(m), merged: ids };
      }
      case "rasterize": {
        need(1);
        for (const l of layers) await rasterizeChecked(doc, l);
        return { rasterized: ids };
      }
    }
    return fail("BAD_ARGS", `Unknown op ${a.op}.`);
  });
};
