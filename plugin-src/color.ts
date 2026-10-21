// Colour data for sample_colors: exact colours at points, and a small RGB thumbnail the server reduces to a palette.

/** Base64 of bytes (UXP has no Buffer). */
function base64(bytes: Uint8Array): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
  }
  return out;
}

commands.sample_points = async (a) => {
  const doc = findDoc(a.document_id);
  for (const p of a.points as number[][]) {
    if (p[0] < 0 || p[1] < 0 || p[0] >= doc.width || p[1] >= doc.height) fail("BAD_ARGS", `Point [${p}] is outside the ${doc.width}x${doc.height} canvas.`);
  }
  return modal("sample_colors", null, async () => {
    const colors: Array<number[] | null> = [];
    for (const p of a.points as number[][]) {
      const c = await doc.sampleColor({ x: p[0], y: p[1] });
      colors.push(c && c.rgb ? [c.rgb.red, c.rgb.green, c.rgb.blue] : null);
    }
    return { colors };
  });
};

commands.thumbnail_pixels = async (a) => {
  const doc = findDoc(a.document_id);
  const layer = a.layer_id !== undefined ? findLayer(doc, a.layer_id) : null;
  const b = layer ? layer.bounds : { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  if (w <= 0 || h <= 0) fail("BAD_ARGS", `Layer ${a.layer_id} has no pixels.`);
  const k = Math.min(1, a.size / Math.max(w, h));
  const opts: Record<string, unknown> = { documentID: doc.id, componentSize: 8, colorSpace: "RGB" };
  if (layer) opts.layerID = layer.id;
  if (k < 1) opts.targetSize = w >= h ? { width: Math.max(1, Math.round(w * k)) } : { height: Math.max(1, Math.round(h * k)) };
  return modal("sample_colors", null, async () => {
    const px = await ps.imaging.getPixels(opts);
    try {
      const data = await px.imageData.getData({ chunky: true });
      return { width: px.imageData.width, height: px.imageData.height, components: px.imageData.components, data: base64(data) };
    } finally {
      px.imageData.dispose();
    }
  });
};
