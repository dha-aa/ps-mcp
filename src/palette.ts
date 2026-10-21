// Main colours of an image: k-means on RGB pixels with a deterministic farthest-point start.

export interface Swatch {
  rgb: [number, number, number];
  hex: string;
  share: number;
}

const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

export function toSwatch(c: number[], share?: number): Swatch {
  const s: Swatch = { rgb: [round3(c[0] / 255), round3(c[1] / 255), round3(c[2] / 255)], hex: hex(c), share: 0 };
  if (share === undefined) delete (s as Partial<Swatch>).share;
  else s.share = Math.round(share * 1000) / 1000;
  return s;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** pixels: chunky bytes with `components` per pixel (3 RGB, 4 RGBA: alpha under 128 is ignored). */
export function palette(pixels: Uint8Array, components: number, k: number, iterations = 12): Swatch[] {
  const pts: number[][] = [];
  for (let i = 0; i + 2 < pixels.length; i += components) {
    if (components === 4 && pixels[i + 3] < 128) continue;
    pts.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  if (!pts.length) return [];
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // Start: the mean colour, then repeatedly the pixel farthest from every centre so far.
  const mean = [0, 1, 2].map((j) => pts.reduce((s, p) => s + p[j], 0) / pts.length);
  const centres: number[][] = [mean];
  const near = pts.map((p) => d2(p, mean));
  while (centres.length < k) {
    let best = -1;
    let bi = 0;
    for (let i = 0; i < pts.length; i++) if (near[i] > best) [best, bi] = [near[i], i];
    if (best <= 0) break; // fewer distinct colours than k
    centres.push(pts[bi].slice());
    for (let i = 0; i < pts.length; i++) near[i] = Math.min(near[i], d2(pts[i], pts[bi]));
  }
  const label = new Array<number>(pts.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < pts.length; i++) {
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = d2(pts[i], centres[c]);
        if (d < bd) [bd, label[i]] = [d, c];
      }
    }
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const s = sum[label[i]];
      s[0] += pts[i][0];
      s[1] += pts[i][1];
      s[2] += pts[i][2];
      s[3]++;
    }
    sum.forEach((s, c) => {
      if (s[3]) centres[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
  }
  const count = centres.map(() => 0);
  for (const l of label) count[l]++;
  return centres
    .map((c, i) => ({ c, n: count[i] }))
    .filter((x) => x.n > 0)
    .map((x) => ({ n: x.n, s: toSwatch(x.c, x.n / pts.length) }))
    .sort((a, b) => b.n - a.n || (a.s.hex < b.s.hex ? -1 : 1))
    .map((x) => x.s);
}
