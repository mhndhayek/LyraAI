// Decode the textures packed inside a VRM (a glTF binary) and measure the
// median face-skin colour, entirely in Node — no Python, numpy or Pillow.
// This mirrors tools/measure.py (the committed QA gate) so CI's Node-only
// runners can run the same check the Blender pipeline does by hand.
const zlib = require('node:zlib');

// ---- glTF / VRM ----------------------------------------------------------
// Parse the JSON chunk of a VRM (a glTF binary) so a test can inspect the rig
// and expressions without Blender. Returns the decoded JSON object.
function vrmGltf(buf) {
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  if (magic !== 0x46546c67 || version !== 2) throw new Error('not a glTF binary (VRM)');
  let off = 12;
  while (off < buf.length) {
    const clen = buf.readUInt32LE(off);
    const ctype = buf.readUInt32LE(off + 4);
    if (ctype === 0x4e4f534a) return JSON.parse(buf.subarray(off + 8, off + 8 + clen).toString('utf8'));
    off += 8 + clen;
  }
  throw new Error('no JSON chunk');
}

function vrmImages(buf) {
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  if (magic !== 0x46546c67 || version !== 2) throw new Error('not a glTF binary (VRM)');
  const chunks = {};
  let off = 12;
  while (off < buf.length) {
    const clen = buf.readUInt32LE(off);
    const ctype = buf.readUInt32LE(off + 4);
    chunks[ctype] = buf.subarray(off + 8, off + 8 + clen);
    off += 8 + clen;
  }
  const gltf = JSON.parse(Buffer.from(chunks[0x4e4f534a]).toString('utf8'));
  const bin = chunks[0x004e4942];
  const out = {};
  for (const img of gltf.images || []) {
    const bv = gltf.bufferViews[img.bufferView];
    out[img.name || img.mimeType] = bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength);
  }
  return out;
}

// ---- PNG (8-bit, colour type 2 = RGB, 6 = RGBA) ---------------------------
// VRoid exports every texture as an 8-bit RGB/RGBA PNG, so only those two
// colour types need unfiltering. The IDAT streams are concatenated, so inflate
// them together.
function pngToRgba(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 8;
  const idat = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  let row = 0;
  let prev = null;
  for (let y = 0; y < height; y++) {
    const filter = raw[row];
    const line = raw.subarray(row + 1, row + 1 + stride);
    row += 1 + stride;
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels] : 0;    // left (reconstructed)
      const b = prev ? prev[x] : 0;                        // above
      const c = x >= channels && prev ? prev[x - channels] : 0; // above-left
      const v = line[x];
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        default: { // 4: Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          r = v + pr;
        }
      }
      recon[x] = r & 255;
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = recon[x * channels];
      out[i + 1] = recon[x * channels + 1];
      out[i + 2] = recon[x * channels + 2];
      out[i + 3] = channels === 4 ? recon[x * channels + 3] : 255;
    }
    prev = recon;
  }
  return { data: out, width, height };
}

// ---- colour science (identical to tools/common.py) ------------------------
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn + 1e-9;
  let hh;
  if (mx === r) hh = (((g - b) / d) % 6 + 6) % 6;
  else if (mx === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  return { h: hh * 60, s: (mx - mn) / (mx + 1e-9), v: mx };
}

function isSkin(r, g, b, a) {
  if (a <= 0.5) return false;
  const { h, s, v } = hsv(r, g, b);
  return (h < 45 || h > 340) && s > 0.12 && s < 0.62 && v > 0.25;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Median masked skin colour of a decoded RGBA buffer, in sRGB 0..255.
function medianSkinSrgb(rgba) {
  const rs = [], gs = [], bs = [];
  let px = 0;
  for (let i = 0; i < rgba.data.length; i += 4) {
    const r = rgba.data[i] / 255, g = rgba.data[i + 1] / 255, b = rgba.data[i + 2] / 255, a = rgba.data[i + 3] / 255;
    if (!isSkin(r, g, b, a)) continue;
    px++;
    rs.push(s2l(r));
    gs.push(s2l(g));
    bs.push(s2l(b));
  }
  const med = { r: l2s(median(rs)), g: l2s(median(gs)), b: l2s(median(bs)) };
  return { rgb: [Math.round(med.r * 255), Math.round(med.g * 255), Math.round(med.b * 255)], pixels: px };
}

// The face-skin median of the shipped VRM. Returns {hex, rgb, pixels, pass}.
function measureFaceSkin(vrmPath) {
  const fs = require('node:fs');
  const images = vrmImages(fs.readFileSync(vrmPath));
  const name = 'F00_000_00_Face_00';
  if (!images[name]) throw new Error(`${name} not found in ${vrmPath}`);
  const rgba = pngToRgba(images[name]);
  const { rgb, pixels } = medianSkinSrgb(rgba);
  const target = [0xe1, 0xbd, 0xa2];
  const pass = rgb.every((v, i) => Math.abs(v - target[i]) <= 3);
  const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { hex, rgb, pixels, pass, target };
}

module.exports = { vrmGltf, vrmImages, pngToRgba, medianSkinSrgb, measureFaceSkin, s2l, l2s, hsv, isSkin };
