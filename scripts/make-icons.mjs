#!/usr/bin/env node
// Generates extension/icons/icon{16,48,128}.png as a rounded square
// with a blue→purple gradient matching sidepanel.css's .dot color.
// Uses only Node built-ins (no deps). Replace the PNGs with your own
// design anytime — the filenames/sizes are the only contract.

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../extension/icons");
mkdirSync(OUT_DIR, { recursive: true });

// --- CRC32 (IEEE) ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, data, crcBytes]);
}

function makePng(size, pixelsFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // Each scanline: filter byte (0 = None) + size*4 RGBA bytes
  const rawData = Buffer.alloc(size * 4 * size + size);
  let off = 0;
  for (let y = 0; y < size; y++) {
    rawData[off++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelsFn(x, y, size);
      rawData[off++] = r;
      rawData[off++] = g;
      rawData[off++] = b;
      rawData[off++] = a;
    }
  }
  const idat = deflateSync(rawData, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- pixel function --------------------------------------------------------
// Rounded square with diagonal gradient (#4285f4 → #9b72cb), plus a subtle
// inset highlight to give the icon some depth.

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

const START = [66, 133, 244]; // #4285f4
const END = [155, 114, 203]; // #9b72cb

function pixelFn(x, y, size) {
  const pad = size * 0.08;
  const radius = size * 0.22;
  const inside = isInsideRoundedSquare(x + 0.5, y + 0.5, pad, size - pad, radius);
  if (!inside) return [0, 0, 0, 0]; // transparent

  // Diagonal gradient t ∈ [0,1]
  const t = Math.max(0, Math.min(1, (x + y) / (2 * (size - 1))));
  const r = lerp(START[0], END[0], t);
  const g = lerp(START[1], END[1], t);
  const b = lerp(START[2], END[2], t);

  // Subtle radial highlight top-left for depth.
  const hx = size * 0.32, hy = size * 0.28, hr = size * 0.55;
  const d = Math.hypot(x - hx, y - hy);
  const hl = Math.max(0, 1 - d / hr);
  const mix = hl * 0.18;
  const rr = Math.min(255, lerp(r, 255, mix));
  const gg = Math.min(255, lerp(g, 255, mix));
  const bb = Math.min(255, lerp(b, 255, mix));

  return [rr, gg, bb, 255];
}

function isInsideRoundedSquare(x, y, min, max, r) {
  if (x < min || x > max || y < min || y > max) return false;
  // Corner check
  const inLeft = x < min + r;
  const inRight = x > max - r;
  const inTop = y < min + r;
  const inBottom = y > max - r;
  if ((inLeft || inRight) && (inTop || inBottom)) {
    const cx = inLeft ? min + r : max - r;
    const cy = inTop ? min + r : max - r;
    const d = Math.hypot(x - cx, y - cy);
    return d <= r;
  }
  return true;
}

// --- write -----------------------------------------------------------------

for (const size of [16, 48, 128]) {
  const png = makePng(size, pixelFn);
  const path = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}
