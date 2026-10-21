// Documents and images: get_document, create_document, open_image, place_image, batch_play, preview.

commands.get_document = async (a) => {
  const all = docs();
  if (!all.length && a.document_id === undefined) return { documents: [] };
  const d = findDoc(a.document_id);
  const parent = a.parent_id !== undefined ? findLayer(d, a.parent_id) : undefined;
  if (parent && !parent.layers) fail("BAD_ARGS", `Layer ${parent.id} is not a group.`);
  const out: Record<string, unknown> = { document: docInfo(d, a.depth ?? Infinity, parent, a.max_layers ?? Infinity) };
  if ((out.document as { layers_not_shown?: number }).layers_not_shown) {
    out.hint = "Not every layer is listed: pass parent_id to list one group, depth to show fewer levels, or a larger max_layers.";
  }
  if (all.length > 1) out.documents = all.map((x) => ({ id: x.id, title: x.title }));
  if (ps.app.activeDocument && ps.app.activeDocument.id !== d.id) out.active_id = ps.app.activeDocument.id;
  return out;
};

commands.create_document = async (a) => {
  const d = await modal("create_document", null, () =>
    ps.app.createDocument({ width: a.width, height: a.height, resolution: a.resolution, name: a.name, mode: "RGBColorMode", fill: a.fill }),
  );
  if (!d) fail("PS_ERROR", "Photoshop did not create the document.");
  return { document: docBrief(d) };
};

commands.open_image = async (a) => {
  const entry = await fileEntry(a.path);
  const d = await modal("open_image", null, () => ps.app.open(entry));
  // Photoshop returns nothing for a file it can't read (seen live with a JPEG macOS opens fine).
  if (!d || typeof d.id !== "number") fail("PS_ERROR", `Photoshop could not open ${a.path}.`, UNREADABLE_HINT);
  return { document: docBrief(d) };
};

const UNREADABLE_HINT = "Photoshop can't read this file. Re-save it as PNG or a standard JPEG (macOS: sips -s format png <file> --out <new>.png) and use the copy.";

/** Every layer id in the document, nested ones included. */
function layerIds(doc: PsDocument): Set<number> {
  const ids = new Set<number>();
  const walk = (ls: PsLayer[]) => ls.forEach((l) => (ids.add(l.id), l.layers && walk(l.layers)));
  walk(doc.layers);
  return ids;
}

commands.place_image = async (a) => {
  const doc = findDoc(a.document_id);
  const entry = await fileEntry(a.path);
  const above = a.above !== undefined ? findLayer(doc, a.above) : null;
  return modal("place_image", doc, async () => {
    activate(doc);
    if (above) doc.activeLayers = [above];
    const before = layerIds(doc);
    const token = uxp.storage.localFileSystem.createSessionToken(entry);
    await play(
      [
        {
          _obj: "placeEvent",
          null: { _path: token, _kind: "local" },
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
        },
      ],
      "place_image",
    );
    // The placed layer is the new one, never just "the selected layer": a file Photoshop can't read places nothing,
    // and the selected layer would then be moved and scaled as if it were the image (seen live).
    const layer = doc.activeLayers.find((l) => !before.has(l.id)) ?? Array.from(layerIds(doc)).filter((id) => !before.has(id)).map((id) => findLayer(doc, id))[0];
    if (!layer) fail("PS_ERROR", `Photoshop did not place ${a.path}: no new layer appeared.`, UNREADABLE_HINT);

    // Size: Photoshop may already have scaled it (preferences, ppi), so compute from what is there now.
    const cur = await placedBox(doc, layer);
    const sw = a.source_width ?? cur.w;
    const sh = a.source_height ?? cur.h;
    let w = sw;
    let h = sh;
    if (a.fit === "stretch") {
      w = doc.width;
      h = doc.height;
    } else if (a.fit === "contain" || a.fit === "cover") {
      const k = (a.fit === "contain" ? Math.min : Math.max)(doc.width / sw, doc.height / sh);
      w = sw * k;
      h = sh * k;
    }
    if (cur.w > 0 && cur.h > 0 && (Math.abs(w - cur.w) > 0.5 || Math.abs(h - cur.h) > 0.5)) {
      // No anchor: Photoshop rejected the forms tried; the translate below centres the layer exactly anyway.
      await layer.scale((w / cur.w) * 100, (h / cur.h) * 100);
    }
    const now = await placedBox(doc, layer);
    const cx = a.x ?? doc.width / 2;
    const cy = a.y ?? doc.height / 2;
    const dx = cx - (now.l + now.w / 2);
    const dy = cy - (now.t + now.h / 2);
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await layer.translate(dx, dy);

    if (a.name !== undefined) layer.name = a.name;
    if (a.opacity !== undefined) layer.opacity = a.opacity;
    if (a.locked === true) layer.allLocked = true;
    const out = await placedBox(doc, layer);
    return {
      layer: { id: layer.id, name: layer.name },
      box: [round(out.l), round(out.t), round(out.l + out.w), round(out.t + out.h)],
      scale: round((out.w / sw) * 100),
    };
  });
};

/** Replaces every "_path" (checked by the server) with the session token Photoshop needs; a file that doesn't exist yet
 * (a save target) gets a new entry. */
async function tokenizePaths(v: unknown): Promise<unknown> {
  if (Array.isArray(v)) return Promise.all(v.map(tokenizePaths));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "_path" && typeof x === "string") {
      let entry: unknown;
      try {
        entry = await uxp.storage.localFileSystem.getEntryWithUrl("file:" + x);
      } catch {
        try {
          entry = await uxp.storage.localFileSystem.createEntryWithUrl("file:" + x, { overwrite: false });
        } catch (e) {
          fail("NOT_FOUND", `Photoshop can't use ${x}: ${toErr(e).message}`, "The folder must exist.");
        }
      }
      out[k] = uxp.storage.localFileSystem.createSessionToken(entry);
    } else out[k] = await tokenizePaths(x);
  }
  return out;
}

commands.batch_play = async (a) => {
  const doc = a.document_id !== undefined ? findDoc(a.document_id) : ps.app.activeDocument;
  return modal("batch_play", doc, async () => {
    if (doc) activate(doc);
    const r = await play((await tokenizePaths(a.descriptors)) as object[], "batch_play");
    // Photoshop echoes each descriptor back; keep only what is new: "get" results and ids of layers made.
    const out: Record<string, unknown> = { ran: r.length };
    const gets: unknown[] = [];
    const ids: number[] = [];
    r.forEach((x, i) => {
      if (a.descriptors[i] && a.descriptors[i]._obj === "get") gets.push(x);
      // "make" gives a number; ignore the arrays "select" echoes back.
      if (x && typeof x.layerID === "number" && a.descriptors[i] && a.descriptors[i]._obj !== "select") ids.push(x.layerID);
    });
    if (gets.length) out.results = gets;
    if (ids.length) out.layer_ids = ids;
    return out;
  });
};

commands.preview = async (a) => {
  const doc = findDoc(a.document_id);
  const layer = a.layer_id !== undefined ? findLayer(doc, a.layer_id) : null;
  const b = layer ? layer.bounds : { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  if (w <= 0 || h <= 0) fail("BAD_ARGS", `Layer ${a.layer_id} has no pixels to show.`);
  const k = Math.min(1, a.max_edge / Math.max(w, h));
  const opts: Record<string, unknown> = { documentID: doc.id, componentSize: 8, applyAlpha: true, colorSpace: "RGB" };
  if (layer) opts.layerID = layer.id;
  if (k < 1) opts.targetSize = w >= h ? { width: Math.max(1, Math.round(w * k)) } : { height: Math.max(1, Math.round(h * k)) };
  return modal("preview", null, async () => {
    const px = await ps.imaging.getPixels(opts);
    try {
      const data = await ps.imaging.encodeImageData({ imageData: px.imageData, base64: true });
      const out: Record<string, unknown> = { width: px.imageData.width, height: px.imageData.height, data };
      if (k < 1) out.scale = round(k * 100);
      if (layer) out.bounds = box(px.sourceBounds);
      return out;
    } finally {
      px.imageData.dispose();
    }
  });
};
