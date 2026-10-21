// The whole document: canvas (crop, resize, trim, rotate, flatten) and history (list, undo, go to a state).

commands.canvas = async (a) => {
  const doc = findDoc(a.document_id);
  const before = { width: doc.width, height: doc.height };
  return modal("canvas " + a.op, doc, async () => {
    switch (a.op) {
      case "crop":
        if (!a.bounds) fail("BAD_ARGS", "crop needs bounds [left, top, right, bottom].");
        await doc.crop({ left: a.bounds[0], top: a.bounds[1], right: a.bounds[2], bottom: a.bounds[3] });
        break;
      case "resize_image": {
        if (!a.width && !a.height) fail("BAD_ARGS", "resize_image needs width and/or height.");
        // One side given: keep the aspect ratio.
        const w = a.width ?? Math.round((doc.width * a.height) / doc.height);
        const h = a.height ?? Math.round((doc.height * a.width) / doc.width);
        await doc.resizeImage(w, h, a.resolution);
        break;
      }
      case "resize_canvas":
        if (!a.width || !a.height) fail("BAD_ARGS", "resize_canvas needs width and height (it grows or shrinks evenly on all sides).");
        await doc.resizeCanvas(a.width, a.height);
        break;
      case "trim":
        await doc.trim(ps.constants.TrimType.TRANSPARENT, true, true, true, true);
        break;
      case "rotate":
        if (!a.angle) fail("BAD_ARGS", "rotate needs angle (degrees).");
        await doc.rotate(a.angle);
        break;
      case "flatten": {
        const n = doc.layers.length;
        await doc.flatten();
        return { document: docBrief(doc), flattened: n };
      }
      default:
        fail("BAD_ARGS", `Unknown op ${a.op}.`);
    }
    return { document: docBrief(doc), was: before };
  });
};

commands.history = async (a) => {
  const doc = findDoc(a.document_id);
  const states = Array.from(doc.historyStates);
  const cur = states.findIndex((s) => s.id === doc.activeHistoryState.id);
  const list = () => {
    const limit = a.limit ?? 20;
    const from = Math.max(0, states.length - limit);
    return states.slice(from).map((s, i) => (from + i === cur ? { id: s.id, name: s.name, current: true } : { id: s.id, name: s.name }));
  };
  if (a.op === "list") return { states: list(), total: states.length };
  let target = cur;
  if (a.op === "undo") target = cur - (a.steps ?? 1);
  else if (a.op === "redo") target = cur + (a.steps ?? 1);
  else if (a.op === "go") target = states.findIndex((s) => s.id === a.state_id);
  if (target < 0 || target >= states.length) {
    fail("BAD_ARGS", a.op === "go" ? `No history state ${a.state_id}.` : `Can't ${a.op} ${a.steps ?? 1} step(s): ${cur} before and ${states.length - 1 - cur} after the current state.`, "history op list shows the states.");
  }
  // Moving in history needs the modal scope but must not become a history step itself.
  await modal("history", null, async () => {
    doc.activeHistoryState = states[target];
  });
  return { current: { id: states[target].id, name: states[target].name } };
};
