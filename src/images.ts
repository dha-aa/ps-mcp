// Image inputs: a file path (sandboxed) or base64 data (written to TEMP_DIR first, since Photoshop opens files).
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageSize } from "image-size";
import { imageSizeFromFile } from "image-size/fromFile";
import { PsToolError } from "./errors.ts";
import { assertAllowed } from "./sandbox.ts";

export interface ImageFile {
  path: string;
  /** Pixel size as Photoshop shows it (EXIF rotation applied); absent when the format isn't recognised. */
  width?: number;
  height?: number;
  type?: string;
}

const EXT: Record<string, string> = { jpg: "jpg", png: "png", gif: "gif", webp: "webp", tiff: "tif", psd: "psd", bmp: "bmp", heif: "heic" };

function upright(r: { width: number; height: number; orientation?: number; type?: string }) {
  const swap = r.orientation !== undefined && r.orientation >= 5 && r.orientation <= 8;
  return { width: swap ? r.height : r.width, height: swap ? r.width : r.height, type: r.type };
}

/** Checks a path argument and reads the image's size. */
export async function imageFromPath(path: string, allowed: string[]): Promise<ImageFile> {
  const abs = assertAllowed(path, allowed);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new PsToolError("NOT_FOUND", `No file at ${abs}`, "Check the path; it must be absolute and the file must exist.");
  }
  if (!st.isFile()) throw new PsToolError("BAD_ARGS", `${abs} is a folder, not an image file.`);
  try {
    return { path: abs, ...upright(await imageSizeFromFile(abs)) };
  } catch {
    // Photoshop opens more formats than image-size knows (RAW, PDF, EPS...): let it try.
    return { path: abs };
  }
}

/** Decodes base64 (or a data: URL), checks it is an image and writes it to dir. Same bytes reuse one file. */
export function imageFromData(data: string, dir: string): ImageFile {
  const b64 = data.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) {
    throw new PsToolError("BAD_ARGS", "data is not base64.", "Pass the image file's bytes as base64, or a data:image/...;base64, URL.");
  }
  const buf = Buffer.from(b64, "base64");
  let info;
  try {
    info = upright(imageSize(buf));
  } catch {
    throw new PsToolError("BAD_ARGS", "data is not an image Photoshop can open (PNG, JPEG, GIF, WebP, TIFF, PSD, BMP).", "Pass a file path instead if the file is on disk.");
  }
  mkdirSync(dir, { recursive: true });
  const name = createHash("sha256").update(buf).digest("hex").slice(0, 16) + "." + (EXT[info.type ?? ""] ?? info.type);
  const path = join(dir, name);
  writeFileSync(path, buf);
  return { path, ...info };
}
