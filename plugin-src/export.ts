// export: Save As PNG / JPEG / PSD / GIF. The server checks the path and that the file appears.

commands.export = async (a) => {
  const doc = findDoc(a.document_id);
  return modal("export", null, async () => {
    let entry: unknown;
    try {
      entry = await uxp.storage.localFileSystem.createEntryWithUrl("file:" + a.path, { overwrite: true });
    } catch (e) {
      fail("NOT_FOUND", `Photoshop can't write ${a.path}: ${toErr(e).message}`, "The folder must exist.");
    }
    const opts: Record<string, unknown> = {};
    if (a.format === "jpg") opts.quality = a.quality ?? 10;
    await doc.saveAs[a.format as "png" | "jpg" | "psd" | "gif"](entry, opts, a.as_copy !== false);
    return { path: a.path, format: a.format };
  });
};
