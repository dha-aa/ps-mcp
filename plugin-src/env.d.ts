// The parts of UXP and the Photoshop API the plugin uses (Photoshop 2026 / UXP 8). Kept small on purpose:
// test/plugin.test.ts fakes exactly these.

declare function require(name: "photoshop"): PsModule;
declare function require(name: "uxp"): UxpModule;
declare function require(name: "fs"): UxpFs;
declare function require(name: "os"): { homedir(): string; platform(): string };

interface PsBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width?: number;
  height?: number;
}

interface PsLayer {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  allLocked: boolean;
  isBackgroundLayer: boolean;
  bounds: PsBounds;
  boundsNoEffects: PsBounds;
  layers: PsLayer[] | null;
  textItem: PsTextItem;
  fillOpacity: number;
  isClippingMask: boolean;
  scale(width: number, height: number): Promise<void>;
  rotate(angle: number): Promise<void>;
  flip(axis: unknown): Promise<void>;
  move(relative: PsLayer, placement: unknown): Promise<void>;
  bringToFront(): Promise<void>;
  sendToBack(): Promise<void>;
  duplicate(): Promise<PsLayer>;
  delete(): Promise<void>;
  merge(): Promise<PsLayer>;
  rasterize(type: unknown): Promise<void>;
  [filter: `apply${string}`]: (...args: any[]) => Promise<void>;
  translate(x: number, y: number): Promise<void>;
}

interface PsDocument {
  id: number;
  title: string;
  path: string;
  width: number;
  height: number;
  resolution: number;
  mode: string;
  bitsPerChannel: string;
  saved: boolean;
  layers: PsLayer[];
  activeLayers: PsLayer[];
  selection: PsSelection;
  createTextLayer(o: { name?: string; contents: string; fontName?: string; fontSize?: number; textColor?: unknown; position?: { x: number; y: number } }): Promise<PsLayer | null>;
  sampleColor(p: { x: number; y: number }): Promise<{ rgb?: { red: number; green: number; blue: number } }>;
  saveAs: Record<"png" | "jpg" | "psd" | "gif", (entry: unknown, options: object, asCopy: boolean) => Promise<void>>;
  crop(bounds: object): Promise<void>;
  resizeImage(width?: number, height?: number, resolution?: number): Promise<void>;
  resizeCanvas(width: number, height: number): Promise<void>;
  trim(type: unknown, top?: boolean, left?: boolean, bottom?: boolean, right?: boolean): Promise<void>;
  rotate(angle: number): Promise<void>;
  flatten(): Promise<void>;
  groupLayers(layers: PsLayer[]): Promise<PsLayer>;
  createPixelLayer(o: { name?: string }): Promise<PsLayer>;
  createLayerGroup(o: { name?: string }): Promise<PsLayer>;
  historyStates: ArrayLike<{ id: number; name: string; snapshot: boolean }>;
  activeHistoryState: { id: number; name: string };
}

interface PsSolidColor {
  rgb: { red: number; green: number; blue: number };
}

interface PsCharacterStyle {
  font: string;
  size: number;
  color: PsSolidColor;
  tracking: number;
  leading: number;
  useAutoLeading: boolean;
  capitalization: unknown;
  fauxBold: boolean;
  fauxItalic: boolean;
}

interface PsTextItem {
  contents: string;
  characterStyle: PsCharacterStyle;
  paragraphStyle: { justification: unknown };
}

interface PsSelection {
  bounds: PsBounds | null;
  selectRectangle(b: object, mode?: unknown, feather?: number, antiAlias?: boolean): Promise<void>;
  selectEllipse(b: object, mode?: unknown, feather?: number, antiAlias?: boolean): Promise<void>;
  selectPolygon(points: object[], mode?: unknown, feather?: number, antiAlias?: boolean): Promise<void>;
  selectAll(): Promise<void>;
  deselect(): Promise<void>;
  inverse(): Promise<void>;
  expand(by: number): Promise<void>;
  contract(by: number): Promise<void>;
  feather(by: number): Promise<void>;
  smooth(radius: number): Promise<void>;
}

interface PsImageData {
  width: number;
  height: number;
  components: number;
  getData(o?: { chunky?: boolean }): Promise<Uint8Array>;
  dispose(): void;
}

interface PsModalContext {
  isCancelled: boolean;
  hostControl: {
    suspendHistory(o: { documentID: number; name: string }): Promise<number>;
    resumeHistory(id: number, commit?: boolean): Promise<void>;
  };
}

/** Photoshop's enums: always pass these values, never strings (Photoshop rejected "middleCenter"). */
interface PsConstants {
  TextCase: Record<"NORMAL" | "ALLCAPS" | "SMALLCAPS", unknown>;
  Justification: Record<"LEFT" | "CENTER" | "RIGHT", unknown>;
  SelectionType: Record<"REPLACE" | "EXTEND" | "DIMINISH" | "INTERSECT", unknown>;
  BlendMode: Record<string, unknown>;
  FlipAxis: Record<"HORIZONTAL" | "VERTICAL" | "BOTH", unknown>;
  ElementPlacement: Record<"PLACEBEFORE" | "PLACEAFTER" | "PLACEINSIDE" | "PLACEATBEGINNING" | "PLACEATEND", unknown>;
  RasterizeType: Record<"ENTIRELAYER", unknown>;
  TrimType: Record<"TRANSPARENT" | "TOPLEFT" | "BOTTOMRIGHT", unknown>;
  NoiseDistribution: Record<"GAUSSIAN" | "UNIFORM", unknown>;
}

interface PsModule {
  constants: PsConstants;
  app: {
    SolidColor: new () => PsSolidColor;
    fonts: ArrayLike<{ name: string; postScriptName: string; family: string; style: string }>;
    documents: ArrayLike<PsDocument>;
    activeDocument: PsDocument | null;
    version: string;
    createDocument(o: { width: number; height: number; resolution: number; name?: string; mode: string; fill: string }): Promise<PsDocument | null>;
    open(entry: unknown): Promise<PsDocument>;
  };
  core: {
    executeAsModal<T>(fn: (ctx: PsModalContext) => Promise<T>, o: { commandName: string; timeOut?: number }): Promise<T>;
  };
  action: {
    batchPlay(descriptors: object[], options: object): Promise<Array<Record<string, any>>>;
    addNotificationListener(events: string[], fn: (event: string, descriptor: unknown) => void): Promise<void>;
    removeNotificationListener(events: string[], fn: (event: string, descriptor: unknown) => void): Promise<void>;
  };
  imaging: {
    getPixels(o: object): Promise<{ imageData: PsImageData; sourceBounds: PsBounds }>;
    encodeImageData(o: { imageData: PsImageData; base64: true }): Promise<string>;
  };
}

interface UxpModule {
  storage: {
    localFileSystem: {
      getEntryWithUrl(url: string): Promise<unknown>;
      createEntryWithUrl(url: string, o: { overwrite: boolean }): Promise<unknown>;
      createSessionToken(entry: unknown): string;
    };
  };
}

interface UxpFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, o: { encoding: "utf-8" }): Promise<string>;
}

/** Stamped by scripts/build-plugin.ts: a hash of the joined plugin code. */
declare const PLUGIN_BUILD: string;

/** Set by the test harness: lets test/plugin.test.ts reach the plugin's internals. */
declare var __PS_MCP_TEST__: { [k: string]: unknown } | undefined;
