#!/usr/bin/env node
/**
 * Monster Territory app-icon pipeline.
 *
 * Rasterises the icon design — a rounded hexagon tile in a deep indigo-to-violet
 * gradient carrying a one-eyed amber monster — straight to RGBA pixels and hand
 * encodes the PNG container (IHDR / IDAT / IEND with real CRC32s).
 *
 * Why no canvas/sharp/jimp: the icons change roughly never, but a native image
 * dependency would have to be installed, compiled and audited on every machine
 * and CI runner that touches this repo. The design is a handful of analytic
 * shapes, so evaluating them per sub-sample is both cheaper and fully
 * reproducible — the committed PNGs are byte-identical on any Node 22 host.
 *
 *   node scripts/generate-icons.mjs
 *
 * The generated files under public/icons are committed; re-run this after
 * changing the design and commit the result.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../public/icons/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/* ------------------------------------------------------------------ colour */

/**
 * Everything is composited in linear light. Blending gradients and antialiased
 * edges in gamma-encoded sRGB darkens them visibly, which on a 192px icon shows
 * up as muddy fringing around the monster.
 */
const PALETTE = {
  backdrop: '#140f2b', // matches manifest background_color
  tileTop: '#241a5e',
  tileMid: '#5b3fc4',
  tileBottom: '#8a63f5',
  rim: '#c3b0ff',
  gloss: '#ffffff',
  glow: '#a58bff',
  shadow: '#0d0920',
  bodyTop: '#ffd071',
  bodyBottom: '#ef8f2c',
  sclera: '#fff6e4',
  pupil: '#17102f',
  spark: '#ffffff',
};

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel) {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function hexToLinear(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [
    srgbToLinear(((value >> 16) & 0xff) / 255),
    srgbToLinear(((value >> 8) & 0xff) / 255),
    srgbToLinear((value & 0xff) / 255),
  ];
}

const LINEAR = Object.fromEntries(
  Object.entries(PALETTE).map(([name, hex]) => [name, hexToLinear(hex)]),
);

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/* ------------------------------------------------ signed distance functions */

/**
 * Every shape returns a signed distance in the unit design space (negative
 * inside). Coverage then comes from a linear ramp one pixel wide, which on top
 * of 4x4 supersampling is enough to keep even the hexagon's shallow corners
 * free of stair-stepping.
 */
function coverage(distance, feather) {
  return clamp(0.5 - distance / feather, 0, 1);
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function sdEllipse(px, py, cx, cy, rx, ry) {
  // Normalised-space distance scaled back by the smaller radius: not exact for
  // eccentric ellipses, but this one is only a soft contact shadow.
  const nx = (px - cx) / rx;
  const ny = (py - cy) / ry;
  return (Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
}

function sdRoundedBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCapsule(px, py, ax, ay, bx, by, r) {
  const ex = bx - ax;
  const ey = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
  return Math.hypot(wx - ex * t, wy - ey * t) - r;
}

/**
 * Round-capped arc symmetric about the downward axis — the monster's smile.
 * `halfSpan` is the half angle in radians measured from straight down.
 */
function sdArc(px, py, cx, cy, radius, halfThickness, halfSpan) {
  const x = Math.abs(px - cx);
  const y = py - cy;
  if (Math.atan2(x, y) <= halfSpan) return Math.abs(Math.hypot(x, y) - radius) - halfThickness;
  const ex = radius * Math.sin(halfSpan);
  const ey = radius * Math.cos(halfSpan);
  return Math.hypot(x - ex, y - ey) - halfThickness;
}

/**
 * Exact signed distance to a simple polygon: nearest point over all edges for
 * the magnitude, crossing-number parity for the sign.
 */
function sdPolygon(px, py, points) {
  const n = points.length;
  let best = (px - points[0][0]) ** 2 + (py - points[0][1]) ** 2;
  let sign = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [vix, viy] = points[i];
    const [vjx, vjy] = points[j];
    const ex = vjx - vix;
    const ey = vjy - viy;
    const wx = px - vix;
    const wy = py - viy;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t;
    const by = wy - ey * t;
    best = Math.min(best, bx * bx + by * by);
    const c1 = py >= viy;
    const c2 = py < vjy;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
  }
  return sign * Math.sqrt(best);
}

/* ------------------------------------------------------------- the design */

/** All coordinates live in a unit square, y pointing down. */
const DESIGN = {
  hex: { cx: 0.5, cy: 0.5, radius: 0.5, corner: 0.075 },
  rimWidth: 0.017,
  glow: { cx: 0.5, cy: 0.555, radius: 0.42, strength: 0.22 },
  shadow: { cx: 0.5, cy: 0.784, rx: 0.168, ry: 0.032, strength: 0.42 },
  body: { cx: 0.5, cy: 0.58, hx: 0.205, hy: 0.19, r: 0.165 },
  feet: { base: 0.748, amp: 0.021, period: 0.205 },
  antenna: { rootX: 0.432, rootY: 0.44, tipX: 0.372, tipY: 0.318, stem: 0.021, bulb: 0.043 },
  eye: { cx: 0.5, cy: 0.537, r: 0.098 },
  pupil: { cx: 0.5, cy: 0.548, r: 0.047 },
  spark: { cx: 0.4665, cy: 0.5115, r: 0.0215 },
  mouth: { cx: 0.5, cy: 0.618, r: 0.074, halfThickness: 0.0135, halfSpan: (58 * Math.PI) / 180 },
  gradient: { ax: 0.16, ay: 0.03, bx: 0.84, by: 0.97 },
};

/** Pointy-top hexagon: a vertex at 12 o'clock reads as a game tile. */
function hexagonVertices(radius) {
  const { cx, cy } = DESIGN.hex;
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (-90 + i * 60) * (Math.PI / 180);
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

// A rounded hexagon is the hexagon inset by the corner radius and then offset
// back out by it. Insetting a regular polygon by `r` is a uniform scale about
// the centre in the ratio of the apothems.
const HEX_APOTHEM = DESIGN.hex.radius * Math.cos(Math.PI / 6);
const HEX_INSET_SCALE = (HEX_APOTHEM - DESIGN.hex.corner) / HEX_APOTHEM;
const HEX_INSET_VERTICES = hexagonVertices(DESIGN.hex.radius * HEX_INSET_SCALE);

function sdTile(px, py) {
  return sdPolygon(px, py, HEX_INSET_VERTICES) - DESIGN.hex.corner;
}

function tileColour(u, v) {
  const { ax, ay, bx, by } = DESIGN.gradient;
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return t < 0.55
    ? mix(LINEAR.tileTop, LINEAR.tileMid, t / 0.55)
    : mix(LINEAR.tileMid, LINEAR.tileBottom, (t - 0.55) / 0.45);
}

function bodyColour(v) {
  const { cy, hy } = DESIGN.body;
  const t = clamp((v - (cy - hy)) / (2 * hy), 0, 1);
  return mix(LINEAR.bodyTop, LINEAR.bodyBottom, t);
}

/** Union of the blob (trimmed by the wavy feet) with both antennae. */
function sdMonster(u, v) {
  const { body, feet, antenna } = DESIGN;
  const blob = sdRoundedBox(u, v, body.cx, body.cy, body.hx, body.hy, body.r);
  const footLine = feet.base + feet.amp * Math.cos(((u - 0.5) * 2 * Math.PI) / feet.period);
  let d = Math.max(blob, v - footLine);
  for (const side of [-1, 1]) {
    const rootX = 0.5 + side * (0.5 - antenna.rootX);
    const tipX = 0.5 + side * (0.5 - antenna.tipX);
    d = Math.min(d, sdCapsule(u, v, rootX, antenna.rootY, tipX, antenna.tipY, antenna.stem));
    d = Math.min(d, sdCircle(u, v, tipX, antenna.tipY, antenna.bulb));
  }
  return d;
}

/** Source-over blend of a straight-alpha linear colour onto a premultiplied accumulator. */
function blend(acc, colour, alpha) {
  if (alpha <= 0) return;
  const a = alpha > 1 ? 1 : alpha;
  const keep = 1 - a;
  acc[0] = colour[0] * a + acc[0] * keep;
  acc[1] = colour[1] * a + acc[1] * keep;
  acc[2] = colour[2] * a + acc[2] * keep;
  acc[3] = a + acc[3] * keep;
}

/**
 * Paints one sample of the artwork into `acc`. `feather` is the antialiasing
 * width expressed in unit-space, i.e. roughly one device pixel.
 */
function shadeArtwork(acc, u, v, feather) {
  const tile = sdTile(u, v);
  const inTile = coverage(tile, feather);
  if (inTile <= 0) return;

  blend(acc, tileColour(u, v), inTile);

  // Light from above: a soft sheen across the top third gives the flat tile a
  // little dimensionality at 192px without reading as a separate shape.
  const sheen = clamp((0.46 - v) / 0.4, 0, 1);
  blend(acc, LINEAR.gloss, inTile * 0.15 * sheen * sheen);

  // Inner rim, brighter at the top edge for the same reason.
  const rim = clamp((DESIGN.rimWidth + tile) / DESIGN.rimWidth, 0, 1);
  blend(acc, LINEAR.rim, inTile * 0.5 * rim * rim * (1 - 0.55 * v));

  const { glow, shadow, eye, pupil, spark, mouth } = DESIGN;
  const halo = 1 - clamp(Math.hypot(u - glow.cx, v - glow.cy) / glow.radius, 0, 1);
  blend(acc, LINEAR.glow, inTile * glow.strength * halo * halo);

  const contact = coverage(sdEllipse(u, v, shadow.cx, shadow.cy, shadow.rx, shadow.ry), 0.06);
  blend(acc, LINEAR.shadow, inTile * shadow.strength * contact);

  blend(acc, bodyColour(v), inTile * coverage(sdMonster(u, v), feather));
  blend(
    acc,
    LINEAR.pupil,
    inTile * coverage(sdArc(u, v, mouth.cx, mouth.cy, mouth.r, mouth.halfThickness, mouth.halfSpan), feather),
  );
  blend(acc, LINEAR.sclera, inTile * coverage(sdCircle(u, v, eye.cx, eye.cy, eye.r), feather));
  blend(acc, LINEAR.pupil, inTile * coverage(sdCircle(u, v, pupil.cx, pupil.cy, pupil.r), feather));
  blend(acc, LINEAR.spark, inTile * 0.92 * coverage(sdCircle(u, v, spark.cx, spark.cy, spark.r), feather));
}

/* ------------------------------------------------------------- rasteriser */

const SUPERSAMPLE = 4;

/**
 * `opaque` paints the full canvas with the backdrop first — required for
 * maskable icons (the launcher crops to an arbitrary shape) and for the Apple
 * touch icon (iOS composites transparency onto black). `artFraction` shrinks
 * the artwork towards the centre; maskable icons use 0.76, comfortably inside
 * the 80% safe zone the spec guarantees will survive any mask.
 */
function renderIcon(size, { opaque = false, artFraction = 1 } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const box = size * artFraction;
  const origin = (size - box) / 2;
  const feather = 1.15 / box;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const acc = new Float64Array(4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          acc[0] = 0;
          acc[1] = 0;
          acc[2] = 0;
          acc[3] = 0;

          if (opaque) blend(acc, LINEAR.backdrop, 1);

          const u = (px + (sx + 0.5) / SUPERSAMPLE - origin) / box;
          const v = (py + (sy + 0.5) / SUPERSAMPLE - origin) / box;
          if (u > -0.05 && u < 1.05 && v > -0.05 && v < 1.05) shadeArtwork(acc, u, v, feather);

          r += acc[0];
          g += acc[1];
          b += acc[2];
          a += acc[3];
        }
      }

      const alpha = a / samples;
      const offset = (py * size + px) * 4;
      if (alpha > 0) {
        // Un-premultiply before gamma encoding, otherwise partly covered edge
        // pixels come out too dark.
        pixels[offset] = Math.round(clamp(linearToSrgb(r / samples / alpha), 0, 1) * 255);
        pixels[offset + 1] = Math.round(clamp(linearToSrgb(g / samples / alpha), 0, 1) * 255);
        pixels[offset + 2] = Math.round(clamp(linearToSrgb(b / samples / alpha), 0, 1) * 255);
      }
      pixels[offset + 3] = Math.round(clamp(alpha, 0, 1) * 255);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------ PNG encoding */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Per-scanline adaptive filtering using the sum-of-absolute-differences
 * heuristic from the PNG spec: for smooth gradients Paeth/Up win by a wide
 * margin, and picking per row rather than globally roughly halves the payload.
 */
function filterScanlines(pixels, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * (stride + 1));
  const prior = Buffer.alloc(stride);
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));

  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const scores = new Array(5).fill(0);

    for (let i = 0; i < stride; i += 1) {
      const raw = row[i];
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prior[i];
      const upLeft = i >= bpp ? prior[i - bpp] : 0;

      candidates[0][i] = raw;
      candidates[1][i] = (raw - left) & 0xff;
      candidates[2][i] = (raw - up) & 0xff;
      candidates[3][i] = (raw - ((left + up) >> 1)) & 0xff;
      candidates[4][i] = (raw - paeth(left, up, upLeft)) & 0xff;

      for (let f = 0; f < 5; f += 1) {
        const value = candidates[f][i];
        scores[f] += value < 128 ? value : 256 - value;
      }
    }

    let best = 0;
    for (let f = 1; f < 5; f += 1) if (scores[f] < scores[best]) best = f;

    const target = y * (stride + 1);
    out[target] = best;
    candidates[best].copy(out, target + 1);
    row.copy(prior);
  }

  return out;
}

function encodePng(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const idat = deflateSync(filterScanlines(pixels, width, height), { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ PNG checking */

/**
 * Minimal decoder used purely as a self-check: a hand-rolled encoder that is
 * never validated is a silent way to ship a file every browser rejects.
 * Verifies the signature, every chunk CRC (IDAT included), the IHDR fields and
 * that the compressed stream unfilters back to the exact pixels we drew.
 */
function inspectPng(buffer, expected) {
  const problems = [];
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) problems.push('bad signature');

  const idatParts = [];
  let header = null;
  let sawIend = false;
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const stored = buffer.readUInt32BE(offset + 8 + length);
    const actual = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (stored !== actual) problems.push(`${type} CRC mismatch`);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colourType: data[9],
      };
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawIend = true;
    }

    offset += 12 + length;
  }

  if (!header) problems.push('missing IHDR');
  if (idatParts.length === 0) problems.push('missing IDAT');
  if (!sawIend) problems.push('missing IEND');
  if (header && (header.width !== expected.width || header.height !== expected.height)) {
    problems.push(`dimensions ${header.width}x${header.height} != ${expected.width}x${expected.height}`);
  }
  if (header && (header.depth !== 8 || header.colourType !== 6)) problems.push('not 8-bit RGBA');

  let opaquePixels = 0;
  if (problems.length === 0) {
    const { width, height } = header;
    const stride = width * 4;
    const raw = inflateSync(Buffer.concat(idatParts));
    if (raw.length !== height * (stride + 1)) {
      problems.push(`inflated ${raw.length} bytes, expected ${height * (stride + 1)}`);
    } else {
      const out = Buffer.alloc(height * stride);
      for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)];
        for (let i = 0; i < stride; i += 1) {
          const value = raw[y * (stride + 1) + 1 + i];
          const left = i >= 4 ? out[y * stride + i - 4] : 0;
          const up = y > 0 ? out[(y - 1) * stride + i] : 0;
          const upLeft = y > 0 && i >= 4 ? out[(y - 1) * stride + i - 4] : 0;
          let restored;
          switch (filter) {
            case 0: restored = value; break;
            case 1: restored = value + left; break;
            case 2: restored = value + up; break;
            case 3: restored = value + ((left + up) >> 1); break;
            case 4: restored = value + paeth(left, up, upLeft); break;
            default: restored = value; problems.push(`unknown filter ${filter}`); break;
          }
          out[y * stride + i] = restored & 0xff;
        }
      }
      if (!out.equals(expected.pixels)) problems.push('round-tripped pixels differ from source');
      for (let i = 3; i < out.length; i += 4) if (out[i] === 255) opaquePixels += 1;
    }
  }

  return { ok: problems.length === 0, problems, header, opaquePixels };
}

/* ------------------------------------------------------------------- SVG */

/** Design units are 0..1; the favicon uses a 64-unit viewBox for legibility. */
const S = 64;
const u = (value) => Number((value * S).toFixed(3));

function roundedHexPath() {
  const outer = hexagonVertices(DESIGN.hex.radius);
  // Distance from a vertex to each arc tangent point: r / tan(interior/2), and
  // a regular hexagon's interior angle is 120 degrees.
  const inset = DESIGN.hex.corner / Math.tan(Math.PI / 3);
  const toward = (from, to) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const len = Math.hypot(dx, dy);
    return [from[0] + (dx / len) * inset, from[1] + (dy / len) * inset];
  };

  const parts = [];
  for (let i = 0; i < 6; i += 1) {
    const vertex = outer[i];
    const previous = outer[(i + 5) % 6];
    const next = outer[(i + 1) % 6];
    const enter = toward(vertex, previous);
    const exit = toward(vertex, next);
    parts.push(i === 0 ? `M ${u(enter[0])} ${u(enter[1])}` : `L ${u(enter[0])} ${u(enter[1])}`);
    // Vertices run clockwise on screen, so every corner arc sweeps clockwise.
    parts.push(`A ${u(DESIGN.hex.corner)} ${u(DESIGN.hex.corner)} 0 0 1 ${u(exit[0])} ${u(exit[1])}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

function monsterBodyPath() {
  const { body, feet } = DESIGN;
  const left = body.cx - body.hx;
  const right = body.cx + body.hx;
  const cornerY = body.cy - (body.hy - body.r);
  const topY = cornerY - body.r;
  const flatLeft = body.cx - (body.hx - body.r);
  const flatRight = body.cx + (body.hx - body.r);
  const footY = (x) => feet.base + feet.amp * Math.cos(((x - 0.5) * 2 * Math.PI) / feet.period);

  // Cosine half-waves approximated by cubics with controls at a third of the
  // span — visually indistinguishable from the rasterised feet.
  const waveTo = (fromX, toX) => {
    const delta = (toX - fromX) / 3;
    return `C ${u(fromX + delta)} ${u(footY(fromX))} ${u(toX - delta)} ${u(footY(toX))} ${u(toX)} ${u(footY(toX))}`;
  };

  const stops = [right, right - feet.period / 2, right - feet.period, left + feet.period / 2, left];
  const waves = stops.slice(0, -1).map((from, i) => waveTo(from, stops[i + 1])).join(' ');

  return [
    `M ${u(left)} ${u(body.cy + 0.025)}`,
    `L ${u(left)} ${u(cornerY)}`,
    `A ${u(body.r)} ${u(body.r)} 0 0 1 ${u(flatLeft)} ${u(topY)}`,
    `L ${u(flatRight)} ${u(topY)}`,
    `A ${u(body.r)} ${u(body.r)} 0 0 1 ${u(right)} ${u(cornerY)}`,
    `L ${u(right)} ${u(footY(right))}`,
    waves,
    'Z',
  ].join(' ');
}

function faviconSvg() {
  const { antenna, eye, pupil, spark, mouth, shadow, glow, body, gradient } = DESIGN;
  const arcY = mouth.cy + mouth.r * Math.cos(mouth.halfSpan);
  const arcDx = mouth.r * Math.sin(mouth.halfSpan);
  const mirror = (x) => 1 - x;
  const hex = roundedHexPath();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Monster Territory">
  <title>Monster Territory</title>
  <defs>
    <linearGradient id="mt-tile" x1="${u(gradient.ax)}" y1="${u(gradient.ay)}" x2="${u(gradient.bx)}" y2="${u(gradient.by)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PALETTE.tileTop}"/>
      <stop offset="0.55" stop-color="${PALETTE.tileMid}"/>
      <stop offset="1" stop-color="${PALETTE.tileBottom}"/>
    </linearGradient>
    <linearGradient id="mt-sheen" x1="0" y1="${u(0.06)}" x2="0" y2="${u(0.46)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PALETTE.gloss}" stop-opacity="0.15"/>
      <stop offset="0.5" stop-color="${PALETTE.gloss}" stop-opacity="0.038"/>
      <stop offset="1" stop-color="${PALETTE.gloss}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="mt-skin" x1="0" y1="${u(body.cy - body.hy)}" x2="0" y2="${u(body.cy + body.hy)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PALETTE.bodyTop}"/>
      <stop offset="1" stop-color="${PALETTE.bodyBottom}"/>
    </linearGradient>
    <radialGradient id="mt-halo" cx="${u(glow.cx)}" cy="${u(glow.cy)}" r="${u(glow.radius)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PALETTE.glow}" stop-opacity="${glow.strength}"/>
      <stop offset="1" stop-color="${PALETTE.glow}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="mt-clip"><path d="${hex}"/></clipPath>
  </defs>

  <path d="${hex}" fill="url(#mt-tile)"/>
  <g clip-path="url(#mt-clip)">
    <rect x="0" y="0" width="${S}" height="${S}" fill="url(#mt-sheen)"/>
    <rect x="0" y="0" width="${S}" height="${S}" fill="url(#mt-halo)"/>
    <ellipse cx="${u(shadow.cx)}" cy="${u(shadow.cy)}" rx="${u(shadow.rx)}" ry="${u(shadow.ry)}" fill="${PALETTE.shadow}" opacity="${shadow.strength}"/>
    <g stroke="url(#mt-skin)" stroke-linecap="round" stroke-width="${u(antenna.stem * 2)}">
      <line x1="${u(antenna.rootX)}" y1="${u(antenna.rootY)}" x2="${u(antenna.tipX)}" y2="${u(antenna.tipY)}"/>
      <line x1="${u(mirror(antenna.rootX))}" y1="${u(antenna.rootY)}" x2="${u(mirror(antenna.tipX))}" y2="${u(antenna.tipY)}"/>
    </g>
    <circle cx="${u(antenna.tipX)}" cy="${u(antenna.tipY)}" r="${u(antenna.bulb)}" fill="url(#mt-skin)"/>
    <circle cx="${u(mirror(antenna.tipX))}" cy="${u(antenna.tipY)}" r="${u(antenna.bulb)}" fill="url(#mt-skin)"/>
    <path d="${monsterBodyPath()}" fill="url(#mt-skin)"/>
    <path d="M ${u(mouth.cx - arcDx)} ${u(arcY)} A ${u(mouth.r)} ${u(mouth.r)} 0 0 0 ${u(mouth.cx + arcDx)} ${u(arcY)}" fill="none" stroke="${PALETTE.pupil}" stroke-width="${u(mouth.halfThickness * 2)}" stroke-linecap="round"/>
    <circle cx="${u(eye.cx)}" cy="${u(eye.cy)}" r="${u(eye.r)}" fill="${PALETTE.sclera}"/>
    <circle cx="${u(pupil.cx)}" cy="${u(pupil.cy)}" r="${u(pupil.r)}" fill="${PALETTE.pupil}"/>
    <circle cx="${u(spark.cx)}" cy="${u(spark.cy)}" r="${u(spark.r)}" fill="${PALETTE.spark}" opacity="0.92"/>
    <!-- Stroked at double width and clipped, so the rim sits wholly inside the
         tile exactly as it does in the rasterised icons. -->
    <path d="${hex}" fill="none" stroke="${PALETTE.rim}" stroke-opacity="0.4" stroke-width="${u(DESIGN.rimWidth * 2)}"/>
  </g>
</svg>
`;
}

/* ------------------------------------------------------------------- main */

const TARGETS = [
  { file: 'icon-192.png', size: 192, opaque: false, artFraction: 1 },
  { file: 'icon-512.png', size: 512, opaque: false, artFraction: 1 },
  { file: 'icon-maskable-192.png', size: 192, opaque: true, artFraction: 0.76 },
  { file: 'icon-maskable-512.png', size: 512, opaque: true, artFraction: 0.76 },
  // iOS applies a fixed superellipse mask that barely crops, so the artwork can
  // sit much closer to the edge than in a true maskable icon.
  { file: 'apple-touch-icon-180.png', size: 180, opaque: true, artFraction: 0.9 },
];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const rows = [];
  let failed = 0;

  for (const target of TARGETS) {
    const pixels = renderIcon(target.size, {
      opaque: target.opaque,
      artFraction: target.artFraction,
    });
    const png = encodePng(pixels, target.size, target.size);
    const file = path.join(OUT_DIR, target.file);
    writeFileSync(file, png);

    // Re-read from disk rather than checking the in-memory buffer, so a partial
    // or mangled write is caught too.
    const onDisk = readFileSync(file);
    const report = inspectPng(onDisk, { width: target.size, height: target.size, pixels });
    if (!report.ok) failed += 1;

    rows.push({
      file: target.file,
      bytes: onDisk.length,
      dims: report.header ? `${report.header.width}x${report.header.height}` : '?',
      status: report.ok ? 'ok' : `FAIL: ${report.problems.join('; ')}`,
      opaque: report.opaquePixels,
    });
  }

  const svgFile = path.join(OUT_DIR, 'favicon.svg');
  writeFileSync(svgFile, faviconSvg());
  const svgOnDisk = readFileSync(svgFile, 'utf8');
  const svgOk = svgOnDisk.startsWith('<svg') && svgOnDisk.trimEnd().endsWith('</svg>');
  if (!svgOk) failed += 1;

  const width = Math.max(...rows.map((row) => row.file.length), 'favicon.svg'.length);
  console.log('Monster Territory icons -> ' + path.relative(REPO_ROOT, OUT_DIR));
  for (const row of rows) {
    console.log(
      `  ${row.file.padEnd(width)}  ${String(row.bytes).padStart(7)} B  ${row.dims.padStart(7)}  ` +
        `RGBA8  opaque=${row.opaque}  ${row.status}`,
    );
  }
  console.log(
    `  ${'favicon.svg'.padEnd(width)}  ${String(Buffer.byteLength(svgOnDisk)).padStart(7)} B  ` +
      `${'vector'.padStart(7)}  SVG    ${svgOk ? 'ok' : 'FAIL: malformed SVG'}`,
  );

  if (failed > 0) {
    console.error(`\n${failed} icon(s) failed verification.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll icons verified: signature, chunk CRCs, IHDR and pixel round-trip.');
}

main();
