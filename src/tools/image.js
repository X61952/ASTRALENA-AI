// Image tools (powered by sharp): resize to ANY size or shape, crop (exact box,
// aspect ratio with smart framing, auto-trim), circle / rounded shapes, rotate,
// flip, colour tweaks, convert, compress to a target size, WhatsApp stickers.
// Every file is read from and written to the workspace only; originals are
// never overwritten — each edit saves a new file in images/.
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

const MAX_DIM = 16384;
const MAX_PIXELS = 100_000_000;
const FORMATS = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', tiff: 'tiff', tif: 'tiff' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', tiff: 'tiff' };
const GRAVITY = new Set(['center', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'attention', 'entropy']);

export function parseAspect(a) {
  if (typeof a === 'number' && a > 0) return a;
  const m = String(a || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  if (!m || Number(m[2]) === 0 || Number(m[1]) === 0) throw new Error('aspect must look like 16:9, 1:1 or 4x5');
  return Number(m[1]) / Number(m[2]);
}

// Works out the output size from whatever the request gave: exact width and
// height, one side + keep shape, one side + an aspect ratio, or a percentage.
export function resolveSize({ srcW, srcH, width, height, aspect, scale_percent }) {
  let w = width ? Math.round(Number(width)) : 0;
  let h = height ? Math.round(Number(height)) : 0;
  if (scale_percent) {
    const p = Number(scale_percent);
    if (!(p > 0 && p <= 1600)) throw new Error('scale_percent must be between 1 and 1600');
    w = Math.round(srcW * p / 100); h = Math.round(srcH * p / 100);
  } else if (aspect) {
    const r = parseAspect(aspect);
    if (w && h) { /* explicit both: the aspect is ignored */ }
    else if (w) h = Math.round(w / r);
    else if (h) w = Math.round(h * r);
    else if (r >= 1) { w = srcW; h = Math.round(srcW / r); }
    else { h = srcH; w = Math.round(srcH * r); }
  } else if (w && !h) h = Math.round(srcH * w / srcW);
  else if (h && !w) w = Math.round(srcW * h / srcH);
  if (!(w >= 1 && h >= 1)) throw new Error('give a width and/or height (or scale_percent, or an aspect ratio)');
  if (w > MAX_DIM || h > MAX_DIM) throw new Error(`that is too big (max ${MAX_DIM}px per side)`);
  if (w * h > MAX_PIXELS) throw new Error('that is too many pixels (max 100 megapixels)');
  return { w, h };
}

function maskSvg(shape, w, h, radius) {
  if (shape === 'circle' || shape === 'ellipse') return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff"/></svg>`;
  let r = 0.12 * Math.min(w, h);
  if (radius !== undefined && radius !== null && radius !== '') {
    const m = String(radius).match(/^(\d+(?:\.\d+)?)\s*(%|px)?$/);
    if (!m) throw new Error('radius must be like 24 or 20%');
    r = m[2] === '%' ? Math.min(w, h) * Number(m[1]) / 100 : Number(m[1]);
  }
  r = Math.min(r, Math.min(w, h) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`;
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export function createImageTools({ cfg, sharpLoader = async () => (await import('sharp')).default }) {
  const safePath = createSafePath(cfg.workspace);
  const realRoot = () => fs.realpathSync(cfg.workspace);
  const rel = (p) => path.relative(realRoot(), p);
  let sharpMod;
  const sharp = async () => {
    if (sharpMod) return sharpMod;
    try { sharpMod = await sharpLoader(); } catch { throw new Error('image tools need the "sharp" package (run: npm install)'); }
    return sharpMod;
  };

  async function load(p, S) {
    const file = safePath(p);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`no such image: ${p}`);
    // Bake the EXIF rotation in first, so every later step sees the picture the way a person does.
    const meta = await S(file, { failOn: 'none' }).metadata();
    const { data, info } = await S(file, { failOn: 'none', limitInputPixels: 268_000_000 }).rotate().toBuffer({ resolveWithObject: true });
    return { file, buf: data, w: info.width, h: info.height, format: info.format, hasAlpha: !!meta.hasAlpha };
  }

  function pickFormat(requested, outputPath, srcFormat, needsAlpha) {
    let f = requested ? FORMATS[String(requested).toLowerCase().replace('.', '')] : undefined;
    if (!f && outputPath) f = FORMATS[path.extname(outputPath).slice(1).toLowerCase()];
    if (!f) f = FORMATS[srcFormat] || 'png';
    let note;
    if (needsAlpha && f === 'jpeg') { f = 'png'; note = 'jpeg cannot be transparent, saved as png'; }
    return { format: f, note };
  }

  function outPath(output, srcFile, tag, format) {
    if (output) {
      const p = safePath(output);
      const withExt = path.extname(p) ? p : `${p}.${EXT[format]}`;
      fs.mkdirSync(path.dirname(withExt), { recursive: true });
      return withExt;
    }
    const dir = safePath('images'); fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(srcFile, path.extname(srcFile)).replace(/-(resized|cropped|edited|sticker|compressed|converted).*$/, '');
    let candidate = path.join(dir, `${base}-${tag}.${EXT[format]}`); let n = 2;
    while (fs.existsSync(candidate)) candidate = path.join(dir, `${base}-${tag}-${n++}.${EXT[format]}`);
    return candidate;
  }

  async function save(S, buf, { file, tag, output, format, quality, needsAlpha, srcHasAlpha, srcFormat, flattenBg }) {
    const { format: fmt, note } = pickFormat(format, output, srcFormat, needsAlpha);
    const target = outPath(output, file, tag, fmt);
    const q = quality ? Math.min(Math.max(Number(quality), 1), 100) : undefined;
    const opts = { ...(q ? { quality: q } : {}), ...(fmt === 'png' ? { compressionLevel: 9 } : {}) };
    let pipeline = S(buf); let note2;
    if (fmt === 'jpeg' && srcHasAlpha && !needsAlpha) {          // an explicit .jpg of a picture that has see-through parts
      const st = await S(buf).stats();
      if (st.channels[3] && st.channels[3].min < 255) { pipeline = pipeline.flatten({ background: flattenBg || '#ffffff' }); note2 = 'transparent areas were filled with white (jpg cannot be transparent)'; }
    }
    const out = await pipeline.toFormat(fmt, opts).toBuffer();
    fs.writeFileSync(target, out);
    const meta = await S(out).metadata();
    return { output: rel(target), width: meta.width, height: meta.height, format: fmt, bytes: out.length, ...((note || note2) ? { note: note || note2 } : {}) };
  }

  async function applyShape(S, buf, w, h, shape, radius) {
    if (!shape || shape === 'rect') return { buf, alpha: false };
    if (!['circle', 'ellipse', 'rounded'].includes(shape)) throw new Error('shape must be rect, circle, ellipse or rounded');
    const masked = await S(buf).ensureAlpha().composite([{ input: Buffer.from(maskSvg(shape, w, h, radius)), blend: 'dest-in' }]).png().toBuffer();
    return { buf: masked, alpha: true };
  }

  const common = {
    output: { type: 'string', description: 'optional output path in the workspace (default: images/<name>-<tag>.<ext>)' },
    format: { type: 'string', enum: ['jpg', 'png', 'webp', 'avif', 'tiff'] },
    quality: { type: 'integer', description: '1-100 for jpg/webp/avif' },
  };

  return [
    {
      name: 'image_info',
      description: 'Get an image\'s size, format, transparency and file size.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (i) => {
        const S = await sharp(); const file = safePath(i.path);
        const m = await S(file, { failOn: 'none' }).metadata();
        const swap = m.orientation >= 5;
        return { path: i.path, width: swap ? m.height : m.width, height: swap ? m.width : m.height, format: m.format, hasAlpha: !!m.hasAlpha, bytes: fs.statSync(file).size, aspect: Number(((swap ? m.height : m.width) / (swap ? m.width : m.height)).toFixed(3)) };
      },
    },
    {
      name: 'image_resize',
      description: 'Resize an image to ANY size or shape. Give width and/or height in pixels, or scale_percent, or an aspect ratio (16:9, 1:1, 9:16, 4:5...) with one side. fit: "cover" fills the whole area and crops the overflow (best for exact sizes), "contain" fits everything inside and pads with a background colour, "fill" stretches to the exact size (distorts), "inside"/"outside" keep the shape. shape: circle/ellipse/rounded cuts the result to that outline (transparent corners, saved as png/webp). Saves a NEW file; the original is untouched.',
      input_schema: { type: 'object', properties: {
        path: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, scale_percent: { type: 'number' },
        aspect: { type: 'string', description: 'e.g. 16:9, 1:1, 4:5' },
        fit: { type: 'string', enum: ['cover', 'contain', 'fill', 'inside', 'outside'], description: 'default cover when both sides are fixed, else inside' },
        position: { type: 'string', description: 'which part to keep when cropping: center, north, south, east, west, northeast..., attention (smart: faces/detail), entropy' },
        background: { type: 'string', description: 'padding colour for contain, e.g. white, #000000, transparent (default transparent for png/webp, white for jpg)' },
        shape: { type: 'string', enum: ['rect', 'circle', 'ellipse', 'rounded'] }, radius: { type: 'string', description: 'for rounded: 24 (px) or 20%' },
        no_upscale: { type: 'boolean', description: 'never enlarge beyond the original size' }, ...common }, required: ['path'] },
      handler: async (i) => {
        const S = await sharp(); const img = await load(i.path, S);
        const { w, h } = resolveSize({ srcW: img.w, srcH: img.h, width: i.width, height: i.height, aspect: i.aspect, scale_percent: i.scale_percent });
        const both = !!((i.width && i.height) || i.aspect || i.scale_percent);
        const fit = i.fit || (both && !i.scale_percent ? 'cover' : 'inside');
        const position = i.position && GRAVITY.has(i.position) ? (i.position === 'attention' ? S.strategy.attention : i.position === 'entropy' ? S.strategy.entropy : i.position) : 'centre';
        const wantsAlpha = (i.shape && i.shape !== 'rect') || img.hasAlpha;
        const bg = i.background ? i.background : (fit === 'contain' && !wantsAlpha && !['png', 'webp'].includes(String(i.format || '').toLowerCase()) ? '#ffffff' : TRANSPARENT);
        let resized;
        try {
          resized = await S(img.buf).resize({ width: w, height: h, fit, position, background: bg, withoutEnlargement: !!i.no_upscale, kernel: 'lanczos3' }).toBuffer({ resolveWithObject: true });
        } catch (e) { throw new Error(`could not resize: ${e.message}`); }
        const shaped = await applyShape(S, resized.data, resized.info.width, resized.info.height, i.shape, i.radius);
        const transparentPad = fit === 'contain' && bg === TRANSPARENT;
        return save(S, shaped.buf, { file: img.file, tag: `${resized.info.width}x${resized.info.height}`, output: i.output, format: i.format, quality: i.quality, needsAlpha: shaped.alpha || transparentPad, srcHasAlpha: img.hasAlpha, srcFormat: img.format, flattenBg: typeof bg === 'string' ? bg : undefined });
      },
    },
    {
      name: 'image_crop',
      description: 'Crop an image. Three ways: (1) an exact box: left, top, width, height (pixels, or percentages with unit "percent"); (2) an aspect ratio (1:1, 16:9, 4:5...) taking the largest area of that shape, positioned by gravity (center, north, south, east, west, corners, or "attention" / "entropy" for smart framing around the interesting part); (3) trim: true to cut away plain borders. Optional shape circle/ellipse/rounded for profile pictures. Saves a NEW file.',
      input_schema: { type: 'object', properties: {
        path: { type: 'string' }, left: { type: 'number' }, top: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
        unit: { type: 'string', enum: ['px', 'percent'] }, aspect: { type: 'string' }, gravity: { type: 'string' }, trim: { type: 'boolean' },
        shape: { type: 'string', enum: ['rect', 'circle', 'ellipse', 'rounded'] }, radius: { type: 'string' }, ...common }, required: ['path'] },
      handler: async (i) => {
        const S = await sharp(); const img = await load(i.path, S);
        let buf; let cw; let ch;
        if (i.trim) {
          const t = await S(img.buf).trim({ threshold: 12 }).toBuffer({ resolveWithObject: true });
          buf = t.data; cw = t.info.width; ch = t.info.height;
        } else if (i.aspect && i.left === undefined && i.width === undefined) {
          const r = parseAspect(i.aspect);
          if (r >= img.w / img.h) { cw = img.w; ch = Math.max(1, Math.round(img.w / r)); } else { ch = img.h; cw = Math.max(1, Math.round(img.h * r)); }
          const g = GRAVITY.has(i.gravity) ? i.gravity : 'center';
          if (g === 'attention' || g === 'entropy') {
            buf = await S(img.buf).resize({ width: cw, height: ch, fit: 'cover', position: S.strategy[g] }).toBuffer();
          } else {
            const dx = img.w - cw; const dy = img.h - ch;
            const left = /west/.test(g) ? 0 : /east/.test(g) ? dx : Math.round(dx / 2);
            const top = /north/.test(g) ? 0 : /south/.test(g) ? dy : Math.round(dy / 2);
            buf = await S(img.buf).extract({ left, top, width: cw, height: ch }).toBuffer();
          }
        } else {
          if (i.width === undefined || i.height === undefined) throw new Error('give left/top/width/height, or an aspect ratio, or trim: true');
          const k = i.unit === 'percent';
          const left = Math.round(k ? img.w * (i.left || 0) / 100 : (i.left || 0));
          const top = Math.round(k ? img.h * (i.top || 0) / 100 : (i.top || 0));
          cw = Math.round(k ? img.w * i.width / 100 : i.width); ch = Math.round(k ? img.h * i.height / 100 : i.height);
          if (left < 0 || top < 0 || cw < 1 || ch < 1 || left + cw > img.w || top + ch > img.h) throw new Error(`that box is outside the image (it is ${img.w}x${img.h})`);
          buf = await S(img.buf).extract({ left, top, width: cw, height: ch }).toBuffer();
        }
        const shaped = await applyShape(S, buf, cw, ch, i.shape, i.radius);
        return save(S, shaped.buf, { file: img.file, tag: `cropped-${cw}x${ch}`, output: i.output, format: i.format, quality: i.quality, needsAlpha: shaped.alpha, srcHasAlpha: img.hasAlpha, srcFormat: img.format });
      },
    },
    {
      name: 'image_edit',
      description: 'Rotate (any angle), flip (upside down), flop (mirror), grayscale, blur, sharpen, brighten and saturate an image. Saves a NEW file.',
      input_schema: { type: 'object', properties: {
        path: { type: 'string' }, rotate: { type: 'number', description: 'degrees clockwise, any angle' }, background: { type: 'string', description: 'fill for the corners when rotating by a non-right angle' },
        flip: { type: 'boolean' }, flop: { type: 'boolean' }, grayscale: { type: 'boolean' }, blur: { type: 'number', description: 'sigma 0.3-100' }, sharpen: { type: 'boolean' },
        brightness: { type: 'number', description: '1 = unchanged, 1.2 = 20% brighter' }, saturation: { type: 'number', description: '1 = unchanged, 0 = grey, 1.5 = vivid' }, ...common }, required: ['path'] },
      handler: async (i) => {
        const S = await sharp(); const img = await load(i.path, S);
        let p = S(img.buf);
        if (i.rotate) p = p.rotate(Number(i.rotate), { background: i.background || TRANSPARENT });
        if (i.flip) p = p.flip();
        if (i.flop) p = p.flop();
        if (i.grayscale) p = p.grayscale();
        if (i.blur) p = p.blur(Math.min(Math.max(Number(i.blur), 0.3), 100));
        if (i.sharpen) p = p.sharpen();
        if (i.brightness || i.saturation) p = p.modulate({ ...(i.brightness ? { brightness: Number(i.brightness) } : {}), ...(i.saturation ? { saturation: Number(i.saturation) } : {}) });
        const out = await p.toBuffer();
        const oddAngle = i.rotate && Number(i.rotate) % 90 !== 0 && !i.background;
        return save(S, out, { file: img.file, tag: 'edited', output: i.output, format: i.format, quality: i.quality, needsAlpha: !!oddAngle, srcHasAlpha: img.hasAlpha, srcFormat: img.format });
      },
    },
    {
      name: 'image_convert',
      description: 'Convert an image to another format (jpg, png, webp, avif, tiff).',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, ...common }, required: ['path', 'format'] },
      handler: async (i) => {
        const S = await sharp(); const img = await load(i.path, S);
        return save(S, img.buf, { file: img.file, tag: 'converted', output: i.output, format: i.format, quality: i.quality || 90, needsAlpha: false, srcHasAlpha: img.hasAlpha, srcFormat: img.format });
      },
    },
    {
      name: 'image_compress',
      description: 'Shrink an image\'s FILE size to at most max_kb by lowering quality first and reducing dimensions only if needed. Good for "make it under 200KB".',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, max_kb: { type: 'number' }, ...common }, required: ['path', 'max_kb'] },
      handler: async (i) => {
        const S = await sharp(); const img = await load(i.path, S); const max = Math.round(Number(i.max_kb) * 1024);
        if (!(max >= 2048)) throw new Error('max_kb must be at least 2');
        let { format } = pickFormat(i.format || (img.format === 'png' ? 'webp' : img.format), i.output, img.format, img.hasAlpha);
        if (!['jpeg', 'webp', 'avif'].includes(format)) format = 'webp';
        let work = img.buf; let scale = 1; let best;
        for (let round = 0; round < 10; round++) {
          for (const q of [85, 75, 65, 55, 45, 35, 25]) {
            const out = await S(work).toFormat(format, { quality: q }).toBuffer();
            best = { out, q };
            if (out.length <= max) { const meta = await S(out).metadata(); const target = outPath(i.output, img.file, 'compressed', format); fs.writeFileSync(target, out); return { output: rel(target), width: meta.width, height: meta.height, format, bytes: out.length, quality: q, scaledTo: scale < 1 ? `${Math.round(scale * 100)}%` : undefined }; }
          }
          scale *= 0.8;
          work = await S(img.buf).resize({ width: Math.max(16, Math.round(img.w * scale)) }).toBuffer();
        }
        throw new Error(`could not get it under ${i.max_kb} KB (best was ${(best.out.length / 1024).toFixed(0)} KB)`);
      },
    },
    {
      name: 'image_sticker',
      description: 'Turn an image into a WhatsApp sticker (512x512 webp, transparent padding). Then send it with send_sticker.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, shape: { type: 'string', enum: ['rect', 'circle', 'rounded'] }, fit: { type: 'string', enum: ['contain', 'cover'], description: 'default contain' } }, required: ['path'] },
      handler: async (i) => {
        const S = await sharp(); const img = await load(i.path, S);
        const base = await S(img.buf).resize({ width: 512, height: 512, fit: i.fit || 'contain', background: TRANSPARENT }).toBuffer();
        const shaped = await applyShape(S, base, 512, 512, i.shape, undefined);
        let out; for (const q of [80, 65, 50, 35, 20]) { out = await S(shaped.buf).webp({ quality: q }).toBuffer(); if (out.length <= 100 * 1024) break; }
        const target = outPath(undefined, img.file, 'sticker', 'webp'); fs.writeFileSync(target, out);
        return { output: rel(target), width: 512, height: 512, format: 'webp', bytes: out.length };
      },
    },
    {
      name: 'send_sticker',
      description: 'Send a .webp sticker file from the workspace to codex as a WhatsApp sticker.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (i, ctx) => {
        const p = safePath(i.path);
        if (path.extname(p).toLowerCase() !== '.webp') throw new Error('stickers must be .webp (use image_sticker first)');
        await ctx.sendSticker(p);
        return { sent: rel(p) };
      },
    },
  ];
}
