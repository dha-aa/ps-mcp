// A fake Photoshop + UXP for the plugin, modelling what the real one does that matters to us:
// - changes outside core.executeAsModal throw (like Photoshop); a busy modal state throws {number: 9}
// - placeEvent may shrink a large image to fit the canvas ("Resize Image During Place"), centred
// - a placed layer's bounds exclude transparent margins; smartObjectMore.transform is the full image box
// - suspendHistory/resumeHistory are recorded so tests can check one undo step per command
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { imageSize } from "image-size";

export interface Box {
  l: number;
  t: number;
  w: number;
  h: number;
}

export interface FakeLayer {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  allLocked: boolean;
  isBackgroundLayer: boolean;
  layers: FakeLayer[] | null;
  /** Full box (smart-object transform); bounds are this inset by `margin`. */
  box: Box;
  margin: number;
  readonly bounds: { left: number; top: number; right: number; bottom: number };
  readonly boundsNoEffects: { left: number; top: number; right: number; bottom: number };
  scale(pw: number, ph: number, anchor?: string): Promise<void>;
  translate(dx: number, dy: number): Promise<void>;
  /** The rest of the Layer API the plugin uses (see layer() below). */
  [k: string]: any;
}

export interface FakeDoc {
  id: number;
  title: string;
  path: string;
  width: number;
  height: number;
  resolution: number;
  mode: string;
  bitsPerChannel: string;
  saved: boolean;
  layers: FakeLayer[];
  activeLayers: FakeLayer[];
  /** Selection (null: none), layer masks by layer id, the rest of the Document API used by the plugin. */
  selection: any;
  masks: Record<number, number[]>;
  createTextLayer: any;
  sampleColor: any;
  saveAs: any;
  /** crop, resizeImage, groupLayers, historyStates... (see attachDocApi). */
  [k: string]: any;
}

export interface FakeState {
  docs: FakeDoc[];
  active: FakeDoc | null;
  inModal: boolean;
  /** Another plugin or a dialog holds the modal state. */
  busy: boolean;
  resizeOnPlace: boolean;
  /** Transparent margin (px) of every placed image, to test the transform path. */
  placeMargin: number;
  history: string[];
  calls: string[];
  /** Delay inside every modal command (ms), to test timeouts and queueing. */
  modalDelayMs: number;
  /** A layer method ("scale", "translate") that throws, to test rollback. */
  failOn: string;
  /** The colour of every document at (x, y), 0-255. */
  colorAt: (x: number, y: number) => [number, number, number];
  fonts: string[];
  listeners: Map<string, Set<(e: string, d: unknown) => void>>;
  saved: Array<{ path: string; format: string; asCopy: boolean; options: unknown }>;
}

export function fakePhotoshop() {
  let nextId = 1;
  const state: FakeState = {
    docs: [],
    active: null,
    inModal: false,
    busy: false,
    resizeOnPlace: true,
    placeMargin: 0,
    history: [],
    calls: [],
    modalDelayMs: 0,
    failOn: "",
    colorAt: (x: number) => (x < 50 ? [255, 0, 0] : [0, 0, 255]),
    fonts: ["MyriadPro-Regular", "Impact", "ArialMT"],
    listeners: new Map(),
    saved: [],
  };
  const needModal = (what: string) => {
    if (!state.inModal) throw new Error(`${what}: this function is only available in a modal execution context (executeAsModal)`);
  };

  function layer(o: Partial<FakeLayer> & { name: string; box: Box }): FakeLayer {
    const v: Record<string, unknown> = { name: o.name, opacity: o.opacity ?? 100, allLocked: o.allLocked ?? false };
    const L: FakeLayer & { native?: { w: number; h: number } } = {
      id: nextId++,
      kind: "pixel",
      visible: true,
      blendMode: "normal",
      isBackgroundLayer: false,
      layers: null,
      margin: 0,
      ...o,
      get name() {
        return v.name as string;
      },
      set name(x: string) {
        needModal("name");
        v.name = x;
      },
      get opacity() {
        return v.opacity as number;
      },
      set opacity(x: number) {
        needModal("opacity");
        if (v.allLocked) return; // live: silently ignored on a locked layer
        v.opacity = x;
      },
      get allLocked() {
        return v.allLocked as boolean;
      },
      set allLocked(x: boolean) {
        needModal("allLocked");
        // Live (PS 27.10): only takes effect when this layer is the selected one; otherwise silently nothing.
        const doc = state.docs.find((dd) => contains(dd.layers, L as unknown as FakeLayer));
        if (doc && doc.activeLayers[0] !== (L as unknown as FakeLayer)) return;
        v.allLocked = x;
      },
      get bounds() {
        const b = L.box;
        const m = L.margin * (b.w / (L.native?.w ?? b.w));
        return { left: b.l + m, top: b.t + m, right: b.l + b.w - m, bottom: b.t + b.h - m };
      },
      get boundsNoEffects() {
        return L.bounds;
      },
      native: undefined,
      async scale(pw: number, ph: number, anchor?: string) {
        needModal("scale");
        if (anchor !== undefined && !Object.values(ANCHORS).includes(anchor)) {
          throw new Error(`Invalid value of '${anchor}' for the type 'Constants.AnchorPosition'.`);
        }
        if (state.failOn === "scale") throw new Error("scale failed");
        state.calls.push(`scale ${pw.toFixed(2)} ${ph.toFixed(2)}`);
        // Without an anchor this fake scales from the top-left, so the plugin must not rely on the anchor.
        const b = L.box;
        const w = (b.w * pw) / 100;
        const h = (b.h * ph) / 100;
        L.box = anchor === ANCHORS.MIDDLECENTER ? { l: b.l + (b.w - w) / 2, t: b.t + (b.h - h) / 2, w, h } : { l: b.l, t: b.t, w, h };
      },
      async translate(dx: number, dy: number) {
        needModal("translate");
        if (state.failOn === "translate") throw new Error("translate failed");
        state.calls.push(`translate ${dx.toFixed(2)} ${dy.toFixed(2)}`);
        L.box = { ...L.box, l: L.box.l + dx, t: L.box.t + dy };
      },
      fillOpacity: 100,
      isClippingMask: false,
      effects: null as Record<string, any> | null,
      // Rotation turns about the top-left in this fake, so the plugin must restore the centre itself.
      async rotate(angle: number) {
        needModal("rotate");
        state.calls.push(`rotate ${angle}`);
        if (Math.abs(angle) % 180 === 90) L.box = { l: L.box.l, t: L.box.t, w: L.box.h, h: L.box.w };
      },
      async flip() {
        throw new Error("Cannot read properties of undefined (FlipAxis)");
      },
      async move(rel: FakeLayer, placement: unknown) {
        needModal("move");
        isConst(CONSTANTS.ElementPlacement, placement, "Constants.ElementPlacement");
        const doc = docOf(L);
        const p = (placement as { k: string }).k;
        doc.layers.splice(doc.layers.indexOf(L), 1);
        if (p === "PLACEINSIDE") (rel.layers ??= []).unshift(L);
        else doc.layers.splice(doc.layers.indexOf(rel) + (p === "PLACEAFTER" ? 1 : 0), 0, L);
      },
      async bringToFront() {
        needModal("bringToFront");
        const doc = docOf(L);
        doc.layers.splice(doc.layers.indexOf(L), 1);
        doc.layers.unshift(L);
      },
      async sendToBack() {
        needModal("sendToBack");
        const doc = docOf(L);
        doc.layers.splice(doc.layers.indexOf(L), 1);
        const bg = doc.layers.findIndex((x) => x.isBackgroundLayer);
        doc.layers.splice(bg < 0 ? doc.layers.length : bg, 0, L);
      },
      async duplicate() {
        needModal("duplicate");
        const doc = docOf(L);
        const d = layer({ name: L.name + " copy", kind: L.kind, box: { ...L.box } });
        doc.layers.splice(doc.layers.indexOf(L), 0, d);
        return d;
      },
      async delete() {
        needModal("delete");
        const doc = docOf(L);
        doc.layers.splice(doc.layers.indexOf(L), 1);
      },
      async rasterize(type: unknown) {
        needModal("rasterize");
        isConst(CONSTANTS.RasterizeType, type, "Constants.RasterizeType");
        if (L.allLocked) return; // live: a locked layer is silently left as it is
        L.kind = "pixel";
      },
      filters: [] as string[],
    };
    // Every Layer.applyX filter: pixel layers only (Photoshop: "not currently available" otherwise).
    for (const m of ["applyGaussianBlur", "applyMotionBlur", "applyAddNoise", "applyHighPass", "applyUnSharpMask", "applySharpen", "applyMedianNoise",
      "applyDustAndScratches", "applyMinimum", "applyMaximum", "applyTwirl", "applyPinch", "applyOffset", "applyClouds", "applyDespeckle"]) {
      (L as unknown as Record<string, unknown>)[m] = async (...args: unknown[]) => {
        needModal(m);
        // Live: on a smart object the filter becomes a smart filter (no error); text etc. refuse.
        if (L.kind === "smartObject") {
          (L as unknown as { smartFilters: string[] }).smartFilters = [...((L as unknown as { smartFilters?: string[] }).smartFilters ?? []), m];
          return;
        }
        if (L.kind !== "pixel") throw new Error(`The command "${m}" is not currently available.`);
        if (m === "applyAddNoise") isConst(CONSTANTS.NoiseDistribution, args[1], "Constants.NoiseDistribution");
        (L as unknown as { filters: string[] }).filters.push(m + " " + JSON.stringify(args.filter((x) => typeof x !== "object")));
      };
    }
    const blendDesc = Object.getOwnPropertyDescriptor(L, "blendMode");
    let blendValue = (blendDesc && blendDesc.value) ?? "normal";
    Object.defineProperty(L, "blendMode", {
      get: () => blendValue,
      set: (v: string) => {
        needModal("blendMode");
        isConst(CONSTANTS.BlendMode, v, "Constants.BlendMode");
        blendValue = v;
      },
    });
    return L;
  }

  const contains = (ls: FakeLayer[], L: FakeLayer): boolean => ls.some((x) => x === L || (!!x.layers && contains(x.layers, L)));
  const docOf = (L: FakeLayer): FakeDoc => {
    const d = state.docs.find((x) => contains(x.layers, L));
    if (!d) throw new Error("layer is not in a document");
    return d;
  };
  const isConst = (group: Record<string, unknown>, v: unknown, what: string) => {
    if (!Object.values(group).includes(v)) throw new Error(`Invalid value of '${String(v)}' for the type '${what}'.`);
  };
  const unionBox = (a: number[] | null, b: number[]) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b);

  /** A text layer's box: ~0.55 em per character, one em per line, centred on (cx, cy). */
  function textBox(contents: string, size: number, cx: number, cy: number): Box {
    const lines = contents.split("\r");
    const w = Math.max(...lines.map((l) => l.length)) * size * 0.55;
    const h = lines.length * size;
    return { l: cx - w / 2, t: cy - h / 2, w, h };
  }

  function textLayer(doc: FakeDoc, o: { name?: string; contents: string; fontName?: string; fontSize?: number; textColor?: unknown }): FakeLayer {
    // Live (PS 27.10): the name option is ignored; a text layer is named after its contents.
    const L = layer({ name: o.contents.replace(/\r/g, " ").slice(0, 30), kind: "text", box: textBox(o.contents, o.fontSize ?? 12, doc.width / 2, doc.height / 2) });
    let contents = o.contents;
    const style: Record<string, unknown> = { font: state.fonts.includes(o.fontName ?? "") ? o.fontName : "MyriadPro-Regular", size: o.fontSize ?? 12, color: o.textColor ?? solid(0, 0, 0) };
    // Live (PS 27.10): after a size or contents change the reported bounds stay stale until the layer moves.
    // The real box keeps its left / top (point text grows from its origin).
    const resize = () => {
      const c = L.box;
      const n = textBox(contents, style.size as number, 0, 0);
      const fresh = { l: c.l, t: c.t, w: n.w, h: n.h };
      const stale = { ...c };
      L.box = fresh;
      staleBox = stale;
    };
    let staleBox: Box | null = null;
    const realBounds = Object.getOwnPropertyDescriptor(L, "bounds")!.get!;
    Object.defineProperty(L, "bounds", {
      get() {
        if (!staleBox) return realBounds.call(L);
        return { left: staleBox.l, top: staleBox.t, right: staleBox.l + staleBox.w, bottom: staleBox.t + staleBox.h };
      },
    });
    const realTranslate = L.translate;
    L.translate = async (dx: number, dy: number) => {
      staleBox = null;
      await realTranslate(dx, dy);
    };
    const characterStyle = {
      get font() { return style.font as string; },
      set font(v: string) { needModal("font"); style.font = state.fonts.includes(v) ? v : "MyriadPro-Regular"; },
      get size() { return style.size as number; },
      set size(v: number) { needModal("size"); style.size = v; resize(); },
      get color() { return style.color; },
      set color(v: unknown) { needModal("color"); if (!(v instanceof SolidColor)) throw new Error("color must be a SolidColor"); style.color = v; },
      set tracking(v: number) { needModal("tracking"); style.tracking = v; },
      get tracking() { return style.tracking as number; },
      set useAutoLeading(v: boolean) { needModal("useAutoLeading"); style.useAutoLeading = v; },
      set leading(v: number) { needModal("leading"); if (style.useAutoLeading !== false) throw new Error("leading needs useAutoLeading false"); style.leading = v; },
      get leading() { return style.leading as number; },
      set capitalization(v: unknown) { needModal("capitalization"); isConst(CONSTANTS.TextCase, v, "Constants.TextCase"); style.capitalization = v; },
      get capitalization() { return style.capitalization; },
      set fauxBold(v: boolean) { needModal("fauxBold"); style.fauxBold = v; },
      set fauxItalic(v: boolean) { needModal("fauxItalic"); style.fauxItalic = v; },
    };
    const paragraphStyle = {
      set justification(v: unknown) { needModal("justification"); isConst(CONSTANTS.Justification, v, "Constants.Justification"); style.justification = v; },
      get justification() { return style.justification; },
    };
    (L as unknown as { textItem: unknown }).textItem = {
      get contents() { return contents; },
      set contents(v: string) { needModal("contents"); contents = v; resize(); },
      characterStyle,
      paragraphStyle,
      style,
    };
    return L;
  }

  function attachDocApi(d: FakeDoc): void {
    d.masks = {};
    let sel: number[] | null = null;
    const apply = (b: number[], mode: unknown) => {
      isConst(CONSTANTS.SelectionType, mode, "Constants.SelectionType");
      if (mode === CONSTANTS.SelectionType.EXTEND) sel = unionBox(sel, b);
      else if (mode === CONSTANTS.SelectionType.INTERSECT && sel) sel = [Math.max(sel[0], b[0]), Math.max(sel[1], b[1]), Math.min(sel[2], b[2]), Math.min(sel[3], b[3])];
      else if (mode === CONSTANTS.SelectionType.DIMINISH) sel = sel; // area shrinks; bounds may not
      else sel = b;
    };
    const op = (name: string, fn: () => void) => async (..._: unknown[]) => {
      needModal("selection." + name);
      state.calls.push("selection." + name);
      fn();
    };
    d.selection = {
      get bounds() {
        return sel ? { left: sel[0], top: sel[1], right: sel[2], bottom: sel[3] } : null;
      },
      set _box(b: number[] | null) { sel = b; },
      async selectRectangle(b: { left: number; top: number; right: number; bottom: number }, mode: unknown) {
        needModal("selectRectangle");
        apply([b.left, b.top, b.right, b.bottom], mode);
      },
      async selectEllipse(b: { left: number; top: number; right: number; bottom: number }, mode: unknown) {
        needModal("selectEllipse");
        apply([b.left, b.top, b.right, b.bottom], mode);
      },
      async selectPolygon(pts: Array<{ x: number; y: number }>, mode: unknown) {
        needModal("selectPolygon");
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        apply([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], mode);
      },
      selectAll: op("selectAll", () => (sel = [0, 0, d.width, d.height])),
      deselect: op("deselect", () => (sel = null)),
      inverse: op("inverse", () => (sel = sel ? [0, 0, d.width, d.height] : null)),
      expand: async (n: number) => { needModal("expand"); if (sel) sel = [sel[0] - n, sel[1] - n, sel[2] + n, sel[3] + n]; },
      contract: async (n: number) => { needModal("contract"); if (sel) sel = [sel[0] + n, sel[1] + n, sel[2] - n, sel[3] - n]; },
      feather: op("feather", () => {}),
      smooth: op("smooth", () => {}),
    };
    d.createTextLayer = async (o: { name?: string; contents: string; fontName?: string; fontSize?: number; textColor?: unknown; position?: unknown }) => {
      needModal("createTextLayer");
      if (o.textColor !== undefined && !(o.textColor instanceof SolidColor)) throw new Error("textColor must be a SolidColor");
      const L = textLayer(d, o);
      d.layers.splice(Math.max(0, d.activeLayers[0] ? d.layers.indexOf(d.activeLayers[0]) : 0), 0, L);
      d.activeLayers = [L];
      return L;
    };
    d.sampleColor = async (p: { x: number; y: number }) => {
      const [red, green, blue] = state.colorAt(p.x, p.y);
      return { rgb: { red, green, blue } };
    };
    const save = (format: string) => async (entry: { nativePath: string }, options: unknown, asCopy: boolean) => {
      needModal("saveAs." + format);
      if (!entry || !entry.nativePath) throw new Error("saveAs needs a File entry");
      writeFileSync(entry.nativePath, Buffer.from(`fake ${format} of ${d.title}`));
      state.saved.push({ path: entry.nativePath, format, asCopy, options });
    };
    d.saveAs = { png: save("png"), jpg: save("jpg"), psd: save("psd"), gif: save("gif") };
    const docOp = (name: string, fn: (...a: any[]) => void) => async (...a: any[]) => {
      needModal(name);
      state.calls.push(name + " " + JSON.stringify(a.filter((x) => typeof x !== "object" || Array.isArray(x) || (x && "left" in x))));
      fn(...a);
    };
    d.crop = docOp("crop", (b: { left: number; top: number; right: number; bottom: number }) => {
      d.width = b.right - b.left;
      d.height = b.bottom - b.top;
    });
    d.resizeImage = docOp("resizeImage", (w: number, h: number) => {
      d.width = w;
      d.height = h;
    });
    d.resizeCanvas = docOp("resizeCanvas", (w: number, h: number) => {
      d.width = w;
      d.height = h;
    });
    d.trim = docOp("trim", (t: unknown) => isConst(CONSTANTS.TrimType, t, "Constants.TrimType"));
    d.rotate = docOp("rotate", (angle: number) => {
      if (Math.abs(angle) % 180 === 90) [d.width, d.height] = [d.height, d.width];
    });
    d.flatten = docOp("flatten", () => {
      d.layers = [layer({ name: "Background", isBackgroundLayer: true, box: { l: 0, t: 0, w: d.width, h: d.height } })];
    });
    d.groupLayers = async (ls: FakeLayer[]) => {
      needModal("groupLayers");
      const g = layer({ name: "Group 1", kind: "group", box: { l: 0, t: 0, w: d.width, h: d.height } });
      g.layers = ls;
      const at = Math.min(...ls.map((x) => d.layers.indexOf(x)));
      d.layers = d.layers.filter((x) => !ls.includes(x));
      d.layers.splice(at, 0, g);
      return g;
    };
    d.createPixelLayer = async (o: { name?: string }) => {
      needModal("createPixelLayer");
      // Live (PS 27.10): a new pixel layer goes on top, or on top inside the selected group.
      const L = layer({ name: o.name ?? "Layer 1", box: { l: 0, t: 0, w: 0, h: 0 } });
      const sel = d.activeLayers[0];
      if (sel && sel.kind === "group") (sel.layers ??= []).unshift(L);
      else d.layers.unshift(L);
      d.activeLayers = [L];
      return L;
    };
    d.createLayerGroup = async (o: { name?: string }) => {
      needModal("createLayerGroup");
      const L = layer({ name: o.name ?? "Group 1", kind: "group", box: { l: 0, t: 0, w: 0, h: 0 } });
      L.layers = [];
      d.layers.unshift(L); // like createPixelLayer: on top
      d.activeLayers = [L];
      return L;
    };
    // Live (PS 27.10): historyStates and activeHistoryState answer for the ACTIVE document, whichever document
    // they are read from. The real states live in ownStates.
    d.ownStates = [{ id: nextId++, name: "Open", snapshot: false }];
    d.ownActive = d.ownStates[0];
    Object.defineProperty(d, "historyStates", { get: () => (state.active ?? d).ownStates });
    Object.defineProperty(d, "activeHistoryState", {
      get: () => (state.active ?? d).ownActive,
      set: (s: { id: number }) => {
        needModal("activeHistoryState");
        const doc = state.active ?? d;
        const found = doc.ownStates.find((x: { id: number }) => x.id === s.id);
        if (!found) throw new Error("no such history state");
        doc.ownActive = found;
      },
    });
    /** A committed history step (called by the fake resumeHistory). */
    d.commitState = (name: string) => {
      const s = { id: nextId++, name, snapshot: false };
      d.ownStates = d.ownStates.slice(0, d.ownStates.indexOf(d.ownActive) + 1).concat([s]);
      d.ownActive = s;
    };
  }

  function addDoc(o: { title: string; width: number; height: number; resolution?: number; path?: string; layers?: FakeLayer[] }): FakeDoc {
    const d = {
      id: nextId++,
      title: o.title,
      path: o.path ?? "",
      width: o.width,
      height: o.height,
      resolution: o.resolution ?? 72,
      mode: "RGBColorMode",
      bitsPerChannel: "bitDepth8",
      saved: !!o.path,
      layers: o.layers ?? [layer({ name: "Background", isBackgroundLayer: true, allLocked: false, box: { l: 0, t: 0, w: o.width, h: o.height } })],
      activeLayers: [] as FakeLayer[],
    } as FakeDoc;
    d.activeLayers = [d.layers[0]];
    attachDocApi(d);
    state.docs.push(d);
    state.active = d;
    return d;
  }

  const tokens = new Map<string, string>();
  let tok = 0;
  const sizeOf = (path: string) => imageSize(readFileSync(path));

  const photoshop = {
    constants: CONSTANTS,
    app: {
      SolidColor,
      get fonts() {
        return state.fonts.map((f) => ({ name: f, postScriptName: f, family: f.replace(/-.*/, ""), style: "Regular" }));
      },
      get documents() {
        return state.docs;
      },
      get activeDocument() {
        return state.active;
      },
      set activeDocument(d: FakeDoc | null) {
        state.active = d;
      },
      version: "27.10.0",
      async createDocument(o: { width: number; height: number; resolution: number; name?: string; fill: string }) {
        needModal("createDocument");
        state.calls.push(`createDocument ${o.width}x${o.height} ${o.fill}`);
        const box = { l: 0, t: 0, w: o.width, h: o.height };
        const layers = o.fill === "transparent" ? [layer({ name: "Layer 1", box })] : undefined;
        return addDoc({ title: o.name ?? "Untitled-1", width: o.width, height: o.height, resolution: o.resolution, layers });
      },
      async open(entry: { nativePath: string }) {
        needModal("open");
        if (/unreadable/.test(entry.nativePath)) return undefined; // live: a file Photoshop can't read opens nothing
        const s = sizeOf(entry.nativePath);
        return addDoc({ title: entry.nativePath.split("/").pop()!, width: s.width, height: s.height, path: entry.nativePath });
      },
    },
    core: {
      async executeAsModal<T>(fn: (ctx: object) => Promise<T>, o: { commandName: string }): Promise<T> {
        if (state.busy || state.inModal) {
          const e = new Error("host is in a modal state") as Error & { number: number };
          e.number = 9;
          throw e;
        }
        state.inModal = true;
        state.calls.push("modal " + o.commandName);
        let suspended: { documentID: number; name: string } | null = null;
        const ctx = {
          isCancelled: false,
          hostControl: {
            async suspendHistory(h: { documentID: number; name: string }) {
              state.history.push(`suspend ${h.documentID} ${h.name}`);
              suspended = h;
              return 7;
            },
            async resumeHistory(id: number, commit?: boolean) {
              state.history.push(`resume ${id} ${commit === false ? "rollback" : "commit"}`);
              const doc = suspended && state.docs.find((x) => x.id === suspended!.documentID);
              if (doc && commit !== false) doc.commitState(suspended!.name);
              suspended = null;
            },
          },
        };
        try {
          if (state.modalDelayMs) await new Promise((r) => setTimeout(r, state.modalDelayMs));
          return await fn(ctx);
        } finally {
          state.inModal = false;
        }
      },
    },
    action: {
      async addNotificationListener(events: string[], fn: (e: string, d: unknown) => void) {
        for (const e of events) {
          if (e === "nosuchevent") throw new Error("unknown event");
          if (!state.listeners.has(e)) state.listeners.set(e, new Set());
          state.listeners.get(e)!.add(fn);
        }
      },
      async removeNotificationListener(events: string[], fn: (e: string, d: unknown) => void) {
        for (const e of events) state.listeners.get(e)?.delete(fn);
      },
      async batchPlay(ds: Array<Record<string, any>>) {
        const out: Array<Record<string, unknown>> = [];
        for (const d of ds) {
          if (d._obj === "placeEvent") {
            needModal("placeEvent");
            const doc = state.active!;
            const path = tokens.get(d.null._path);
            if (!path) throw new Error("invalid session token");
            if (/unreadable/.test(path)) {
              out.push({}); // live: a file Photoshop can't read places nothing, without an error
              continue;
            }
            const s = sizeOf(path);
            let w = s.width;
            let h = s.height;
            if (state.resizeOnPlace && (w > doc.width || h > doc.height)) {
              const k = Math.min(doc.width / w, doc.height / h);
              w *= k;
              h *= k;
            }
            const L = layer({ name: path.split("/").pop()!.replace(/\.\w+$/, ""), kind: "smartObject", box: { l: (doc.width - w) / 2, t: (doc.height - h) / 2, w, h } });
            (L as FakeLayer & { native?: { w: number; h: number } }).native = { w: s.width, h: s.height };
            L.margin = state.placeMargin;
            const at = doc.activeLayers[0] ? doc.layers.indexOf(doc.activeLayers[0]) : 0;
            doc.layers.splice(Math.max(0, at), 0, L);
            doc.activeLayers = [L];
            out.push({});
          } else if (d._obj === "autoCutout") {
            needModal("autoCutout");
            const doc = state.active!;
            const L = d.sampleAllLayers ? null : doc.activeLayers[0];
            const b = L ? L.bounds : { left: 0, top: 0, right: doc.width, bottom: doc.height };
            // Select Subject finds a subject inside the layer: the middle half of its bounds.
            const w = b.right - b.left;
            const h = b.bottom - b.top;
            doc.selection._box = [b.left + w / 4, b.top + h / 4, b.right - w / 4, b.bottom];
            out.push({ ...d });
          } else if (d._obj === "set" && d.to && Array.isArray(d.to._ref)) {
            needModal("select transparency");
            const doc = state.active!;
            const id = d.to._ref[1]._id;
            const L = doc.layers.find((x) => x.id === id);
            if (!L) throw new Error("no such layer");
            const b = L.bounds;
            doc.selection._box = [b.left, b.top, b.right, b.bottom];
            out.push({ ...d });
          } else if (d._obj === "make" && d._target && (d._target[0]._ref === "contentLayer" || d._target[0]._ref === "adjustmentLayer")) {
            needModal("make " + d._target[0]._ref);
            const doc = state.active!;
            const t = d.using.type._obj as string;
            const kind = t === "solidColorLayer" ? "solidColor" : t === "gradientLayer" ? "gradientFill" : t;
            const L = layer({ name: d.using.name ?? kind, kind, box: { l: 0, t: 0, w: doc.width, h: doc.height } });
            L.descriptor = JSON.parse(JSON.stringify(d.using));
            L.isClippingMask = d.using.group === true;
            const at = doc.activeLayers[0] ? doc.layers.indexOf(doc.activeLayers[0]) : 0;
            doc.layers.splice(Math.max(0, at), 0, L);
            const sel = doc.selection.bounds;
            if (sel) doc.masks[L.id] = [sel.left, sel.top, sel.right, sel.bottom];
            doc.activeLayers = [L];
            out.push({ ...d, layerID: L.id });
          } else if (d._obj === "flip") {
            needModal("flip");
            const L = state.docs.flatMap((x) => x.layers).find((x) => x.id === d._target[0]._id);
            if (!L) throw new Error("no such layer");
            if (d.axis?._enum !== "orientation" || !["horizontal", "vertical"].includes(d.axis._value)) throw new Error("bad flip axis");
            state.calls.push("flip " + d.axis._value);
            out.push({});
          } else if (d._obj === "mergeLayersNew") {
            needModal("mergeLayersNew");
            const doc = state.active!;
            const [top, ...rest] = doc.activeLayers;
            if (!rest.length) throw new Error("Merge Layers is not currently available");
            doc.layers = doc.layers.filter((x) => !rest.includes(x));
            top.name = top.name + " (merged)";
            doc.activeLayers = [top];
            out.push({});
          } else if (d._obj === "set" && d._target && d._target[0]._property === "layerEffects") {
            needModal("set layerEffects");
            const L = state.docs.flatMap((x) => x.layers).find((x) => x.id === d._target[1]._id);
            if (!L) throw new Error("no such layer");
            L.effects = JSON.parse(JSON.stringify(d.to));
            out.push({});
          } else if (d._obj === "make" && d.at && d.at._value === "mask") {
            needModal("make mask");
            const doc = state.active!;
            const b = doc.selection.bounds;
            if (!b) throw new Error("Make is not currently available");
            doc.masks[doc.activeLayers[0].id] = [b.left, b.top, b.right, b.bottom];
            out.push({ ...d });
          } else if (d._obj === "get") {
            const id = d._target[0]._id;
            const L = state.docs.flatMap((x) => x.layers).find((x) => x.id === id);
            if (!L) throw new Error("no such layer");
            const b = L.box;
            const got: Record<string, unknown> = L.kind === "smartObject" ? { smartObjectMore: { transform: [b.l, b.t, b.l + b.w, b.t, b.l + b.w, b.t + b.h, b.l, b.t + b.h] } } : {};
            if (L.effects) got.layerEffects = L.effects;
            out.push(got);
          } else {
            if (d._obj === "fail") throw new Error("descriptor failed");
            const paths = JSON.stringify(d).match(/"_path":"[^"]*"/g);
            if (paths) state.calls.push("batchPlay paths " + paths.join(","));
            state.calls.push("batchPlay " + d._obj);
            out.push(d._obj === "make" ? { _obj: "make", layerID: 42 } : { ...d });
          }
        }
        return out;
      },
    },
    imaging: {
      async getPixels(o: { documentID: number; layerID?: number; targetSize?: { width?: number; height?: number } }) {
        state.calls.push("getPixels " + JSON.stringify(o));
        const doc = state.docs.find((d) => d.id === o.documentID)!;
        const L = o.layerID !== undefined ? doc.layers.find((l) => l.id === o.layerID)! : null;
        const b = L ? L.bounds : { left: 0, top: 0, right: doc.width, bottom: doc.height };
        const w = b.right - b.left;
        const h = b.bottom - b.top;
        let k = 1;
        if (o.targetSize?.width) k = o.targetSize.width / w;
        else if (o.targetSize?.height) k = o.targetSize.height / h;
        const W = Math.round(w * k);
        const H = Math.round(h * k);
        const comps = L ? 4 : 3;
        return {
          imageData: {
            width: W,
            height: H,
            components: comps,
            async getData() {
              const out = new Uint8Array(W * H * comps);
              for (let y = 0; y < H; y++)
                for (let x = 0; x < W; x++) {
                  const c = state.colorAt(b.left + x / k, b.top + y / k);
                  out.set(comps === 4 ? [...c, 255] : c, (y * W + x) * comps);
                }
              return out;
            },
            dispose() {},
          },
          sourceBounds: b,
        };
      },
      async encodeImageData() {
        return TINY_JPEG;
      },
    },
  };

  const uxp = {
    storage: {
      localFileSystem: {
        async getEntryWithUrl(url: string) {
          const p = url.replace(/^file:/, "");
          if (!existsSync(p) || !statSync(p).isFile()) throw new Error("Could not find an entry of 'file:" + p + "'");
          return { nativePath: p };
        },
        async createEntryWithUrl(url: string, o: { overwrite: boolean }) {
          const p = url.replace(/^file:/, "");
          if (!existsSync(dirname(p))) throw new Error("Could not create entry: parent folder does not exist");
          if (existsSync(p) && !o.overwrite) throw new Error("File already exists");
          return { nativePath: p };
        },
        createSessionToken(entry: { nativePath: string }) {
          const t = "tok" + ++tok;
          tokens.set(t, entry.nativePath);
          return t;
        },
      },
    },
  };

  const fs = {
    readdir: (p: string) => readdir(p.replace(/^file:/, "")),
    readFile: (p: string) => readFile(p.replace(/^file:/, ""), "utf8"),
  };

  /** What Photoshop does when the user acts by hand: notify listeners. */
  const emit = (event: string, descriptor: unknown) => {
    for (const fn of state.listeners.get(event) ?? []) fn(event, descriptor);
  };

  return { photoshop, uxp, fs, state, layer, addDoc, emit };
}

/** Opaque enum values: the plugin must pass these, not strings it made up (Photoshop rejects "middleCenter"). */
const ANCHORS = { MIDDLECENTER: { _anchor: "MIDDLECENTER" } as unknown as string, TOPLEFT: { _anchor: "TOPLEFT" } as unknown as string };
const enumOf = (name: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, { _enum: name, k }]));
const CONSTANTS = {
  AnchorPosition: ANCHORS,
  TextCase: enumOf("TextCase", ["NORMAL", "ALLCAPS", "SMALLCAPS"]),
  Justification: enumOf("Justification", ["LEFT", "CENTER", "RIGHT"]),
  SelectionType: enumOf("SelectionType", ["REPLACE", "EXTEND", "DIMINISH", "INTERSECT"]),
  // Read back as strings ("multiply", "softLight"), as get_document showed live.
  BlendMode: Object.fromEntries(
    ["normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "darkerColor", "lighten", "screen", "colorDodge", "linearDodge",
     "lighterColor", "overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight", "hardMix", "difference", "exclusion",
     "subtract", "divide", "hue", "saturation", "color", "luminosity", "passThrough"].map((m) => [m.toUpperCase(), m]),
  ),
  // Live (PS 27.10): constants.FlipAxis does not exist, although the docs list it.
  ElementPlacement: enumOf("ElementPlacement", ["PLACEBEFORE", "PLACEAFTER", "PLACEINSIDE", "PLACEATBEGINNING", "PLACEATEND"]),
  RasterizeType: enumOf("RasterizeType", ["ENTIRELAYER"]),
  TrimType: enumOf("TrimType", ["TRANSPARENT", "TOPLEFT", "BOTTOMRIGHT"]),
  NoiseDistribution: enumOf("NoiseDistribution", ["GAUSSIAN", "UNIFORM"]),
};

class SolidColor {
  rgb = { red: 0, green: 0, blue: 0 };
}
const solid = (r: number, g: number, b: number) => Object.assign(new SolidColor(), { rgb: { red: r, green: g, blue: b } });

/** A 1x1 JPEG, base64. */
export const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";
