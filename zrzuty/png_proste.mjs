// Minimalny dekoder i koder PNG (zlib, bez bibliotek) do wstępnej obróbki klatek przed OCR.
import zlib from "node:zlib";

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Dekoduje PNG (8 bit, RGB/RGBA/szarość, bez przeplotu) do {w, h, data: RGBA}. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("to nie jest PNG");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bitDepth = body[8]; colorType = body[9]; interlace = body[12]; }
    else if (type === "IDAT") idat.push(body); else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 6].includes(colorType)) throw new Error(`nieobsługiwany PNG (bity ${bitDepth}, typ ${colorType}, przeplot ${interlace})`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat)); const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0, b = y ? px[dst - stride + i] : 0, c = y && i >= bpp ? px[dst - stride + i - bpp] : 0, x = raw[src + i];
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[dst + i] = v & 255;
    }
  }
  const data = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    if (bpp === 4) px.copy(data, p * 4, p * 4, p * 4 + 4);
    else if (bpp === 3) { data[p * 4] = px[p * 3]; data[p * 4 + 1] = px[p * 3 + 1]; data[p * 4 + 2] = px[p * 3 + 2]; data[p * 4 + 3] = 255; }
    else { data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = px[p]; data[p * 4 + 3] = 255; }
  }
  return { w, h, data };
}

/** Koduje RGBA do PNG. */
export function encodePng({ w, h, data }) {
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type, "ascii"), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb)); return Buffer.concat([len, tb, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Dodaje jednolity margines (OCR gubi tekst przyklejony do krawędzi obrazu). */
export function dodajMargines({ w, h, data }, px, kolor) {
  const W = w + 2 * px, H = h + 2 * px, out = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) { out[p * 4] = kolor; out[p * 4 + 1] = kolor; out[p * 4 + 2] = kolor; out[p * 4 + 3] = 255; }
  for (let y = 0; y < h; y++) data.copy(out, ((y + px) * W + px) * 4, y * w * 4, (y + 1) * w * 4);
  return { w: W, h: H, data: out };
}

/**
 * Wersja do OCR: biały tekst (także na niebieskim i szarym dymku) staje się czarny na białym tle, reszta biała. Duże jasne plamy (jasne fragmenty zdjęć: ściany, niebo)
 * są odrzucane jako nie-tekst (składowa wyższa niż 70 px albo większa niż 3500 px), żeby nie zakłócały czytania sąsiednich linii. Obraz powiększony 2x, z marginesem.
 */
export function binarizujBialyTekst({ w, h, data }, skala = 2) {
  const m = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) { const i = p * 4, lo = Math.min(data[i], data[i + 1], data[i + 2]), hi = Math.max(data[i], data[i + 1], data[i + 2]); m[p] = lo >= 185 && hi - lo <= 45 ? 1 : 0; }
  const seen = new Uint8Array(w * h), st = new Int32Array(w * h);
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!m[s0] || seen[s0]) continue;
    const comp = []; let sp = 0, y0 = h, y1 = 0; st[sp++] = s0; seen[s0] = 1;
    while (sp) { const p = st[--sp]; comp.push(p); const px = p % w, py = (p / w) | 0; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; st[sp++] = p - 1; } if (px < w - 1 && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; st[sp++] = p + 1; }
      if (py > 0 && m[p - w] && !seen[p - w]) { seen[p - w] = 1; st[sp++] = p - w; } if (py < h - 1 && m[p + w] && !seen[p + w]) { seen[p + w] = 1; st[sp++] = p + w; } }
    if (y1 - y0 + 1 > 70 || comp.length > 3500) for (const p of comp) m[p] = 0;
  }
  const W = w * skala, H = h * skala, out = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!m[Math.floor(y / skala) * w + Math.floor(x / skala)]) continue; const o = (y * W + x) * 4; out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; }
  return dodajMargines({ w: W, h: H, data: out }, 40, 255);
}
