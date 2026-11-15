import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createImageTools, resolveSize, parseAspect } from '../src/tools/image.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-img-'));
const tool = (list, n) => list.find((t) => t.name === n);
async function setup() {
  const cfg = { workspace: tmp() };
  const tools = createImageTools({ cfg });
  const left = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const right = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const two = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#000' } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: 200, top: 0 }]).png().toBuffer();
  fs.writeFileSync(path.join(cfg.workspace, 'two.png'), two);                       // 400x200: left red, right blue
  return { cfg, tools, run: (n, i) => tool(tools, n).handler(i, {}) };
}
const pixel = async (file, x, y) => { const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true }); const o = (y * info.width + x) * info.channels; return [...data.slice(o, o + info.channels)]; };
const abs = (cfg, o) => path.join(cfg.workspace, o.output);

test('resolveSize: every way of asking for a size', () => {
  assert.deepEqual(resolveSize({ srcW: 400, srcH: 200, width: 100 }), { w: 100, h: 50 });
  assert.deepEqual(resolveSize({ srcW: 400, srcH: 200, height: 100 }), { w: 200, h: 100 });
  assert.deepEqual(resolveSize({ srcW: 400, srcH: 200, width: 300, height: 300 }), { w: 300, h: 300 });
  assert.deepEqual(resolveSize({ srcW: 400, srcH: 200, scale_percent: 50 }), { w: 200, h: 100 });
  assert.deepEqual(resolveSize({ srcW: 400, srcH: 200, aspect: '1:1', width: 100 }), { w: 100, h: 100 });
  assert.deepEqual(resolveSize({ srcW: 400, srcH: 200, aspect: '9:16', height: 160 }), { w: 90, h: 160 });
  assert.deepEqual(resolveSize({ srcW: 400, srcH: 200, aspect: '1:1' }), { w: 400, h: 400 });
  assert.deepEqual(resolveSize({ srcW: 200, srcH: 400, aspect: '16:9' }), { w: 200, h: 113 });
  assert.equal(parseAspect('4x5'), 0.8);
  assert.throws(() => resolveSize({ srcW: 4, srcH: 4 }), /give a width/);
  assert.throws(() => resolveSize({ srcW: 4, srcH: 4, width: 99999, height: 1 }), /too big/);
  assert.throws(() => resolveSize({ srcW: 4, srcH: 4, width: 16000, height: 16000 }), /too many pixels/);
  assert.throws(() => parseAspect('wide'), /aspect/);
});

test('resize: cover fills the exact size, contain pads, fill stretches, inside keeps shape', async () => {
  const { cfg, run } = await setup();
  const cover = await run('image_resize', { path: 'two.png', width: 100, height: 100 });                     // default for exact size = cover
  assert.deepEqual([cover.width, cover.height, cover.format], [100, 100, 'png']);
  assert.deepEqual((await pixel(abs(cfg, cover), 10, 50)).slice(0, 3), [255, 0, 0]); assert.deepEqual((await pixel(abs(cfg, cover), 90, 50)).slice(0, 3), [0, 0, 255]);

  const contain = await run('image_resize', { path: 'two.png', width: 200, height: 200, fit: 'contain', background: '#00ff00' });
  assert.deepEqual([contain.width, contain.height], [200, 200]);
  assert.deepEqual((await pixel(abs(cfg, contain), 100, 5)).slice(0, 3), [0, 255, 0]);                       // green padding on top
  assert.deepEqual((await pixel(abs(cfg, contain), 20, 100)).slice(0, 3), [255, 0, 0]);                      // picture in the middle band

  const stretch = await run('image_resize', { path: 'two.png', width: 100, height: 300, fit: 'fill' });
  assert.deepEqual([stretch.width, stretch.height], [100, 300]);
  const inside = await run('image_resize', { path: 'two.png', width: 100, height: 100, fit: 'inside' });
  assert.deepEqual([inside.width, inside.height], [100, 50]);
  const pct = await run('image_resize', { path: 'two.png', scale_percent: 150 });
  assert.deepEqual([pct.width, pct.height], [600, 300]);
  const wide = await run('image_resize', { path: 'two.png', aspect: '16:9', width: 320 });
  assert.deepEqual([wide.width, wide.height], [320, 180]);
  const noUp = await run('image_resize', { path: 'two.png', width: 800, no_upscale: true });
  assert.equal(noUp.width, 400);
  assert.ok(fs.existsSync(path.join(cfg.workspace, 'two.png')));                                             // original untouched
  const again = await run('image_resize', { path: 'two.png', width: 100, height: 100 });
  assert.notEqual(again.output, cover.output);                                                                // never overwrites a previous result
});

test('resize: circle and rounded shapes have transparent corners; jpeg is upgraded to png', async () => {
  const { cfg, run } = await setup();
  const circle = await run('image_resize', { path: 'two.png', width: 200, height: 200, shape: 'circle', format: 'jpg' });
  assert.equal(circle.format, 'png'); assert.match(circle.note, /transparent/);
  assert.equal((await pixel(abs(cfg, circle), 2, 2))[3], 0);                                                 // corner transparent
  assert.equal((await pixel(abs(cfg, circle), 100, 100))[3], 255);                                           // centre opaque
  const rounded = await run('image_resize', { path: 'two.png', width: 200, height: 200, shape: 'rounded', radius: '25%', format: 'webp' });
  assert.equal(rounded.format, 'webp'); assert.equal((await pixel(abs(cfg, rounded), 0, 0))[3], 0); assert.equal((await pixel(abs(cfg, rounded), 100, 0))[3], 255);
  await assert.rejects(() => run('image_resize', { path: 'two.png', width: 10, shape: 'star' }), /shape must be/);
});

test('crop: exact box, percentages, aspect ratio with gravity, trim, circle, bounds', async () => {
  const { cfg, run } = await setup();
  const box = await run('image_crop', { path: 'two.png', left: 0, top: 0, width: 200, height: 200 });
  assert.deepEqual([box.width, box.height], [200, 200]); assert.deepEqual((await pixel(abs(cfg, box), 100, 100)).slice(0, 3), [255, 0, 0]);
  const pct = await run('image_crop', { path: 'two.png', left: 50, top: 0, width: 50, height: 100, unit: 'percent' });
  assert.deepEqual([pct.width, pct.height], [200, 200]); assert.deepEqual((await pixel(abs(cfg, pct), 100, 100)).slice(0, 3), [0, 0, 255]);
  const sq = await run('image_crop', { path: 'two.png', aspect: '1:1', gravity: 'east' });
  assert.deepEqual([sq.width, sq.height], [200, 200]); assert.deepEqual((await pixel(abs(cfg, sq), 100, 100)).slice(0, 3), [0, 0, 255]);   // east = the blue half
  const west = await run('image_crop', { path: 'two.png', aspect: '1:1', gravity: 'west' });
  assert.deepEqual((await pixel(abs(cfg, west), 100, 100)).slice(0, 3), [255, 0, 0]);
  const centre = await run('image_crop', { path: 'two.png', aspect: '2:1' });
  assert.deepEqual([centre.width, centre.height], [400, 200]);
  const tall = await run('image_crop', { path: 'two.png', aspect: '9:16', gravity: 'attention' });
  assert.equal(tall.height, 200); assert.equal(tall.width, 113);
  const avatar = await run('image_crop', { path: 'two.png', aspect: '1:1', shape: 'circle' });
  assert.equal(avatar.format, 'png'); assert.equal((await pixel(abs(cfg, avatar), 1, 1))[3], 0);
  await assert.rejects(() => run('image_crop', { path: 'two.png', left: 300, top: 0, width: 200, height: 100 }), /outside the image \(it is 400x200\)/);
  await assert.rejects(() => run('image_crop', { path: 'two.png' }), /give left/);
  // trim: a red square on a white canvas -> just the square
  const pad = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } }).composite([{ input: await sharp({ create: { width: 100, height: 60, channels: 3, background: '#ff0000' } }).png().toBuffer(), left: 80, top: 120 }]).png().toBuffer();
  fs.writeFileSync(path.join(cfg.workspace, 'pad.png'), pad);
  const trimmed = await run('image_crop', { path: 'pad.png', trim: true });
  assert.deepEqual([trimmed.width, trimmed.height], [100, 60]);
});

test('edit / convert / compress / sticker / info, EXIF rotation, sandboxing', async () => {
  const { cfg, run, tools } = await setup();
  const info = await run('image_info', { path: 'two.png' });
  assert.deepEqual([info.width, info.height, info.format, info.aspect], [400, 200, 'png', 2]);
  const rot = await run('image_edit', { path: 'two.png', rotate: 90 });
  assert.deepEqual([rot.width, rot.height], [200, 400]);
  const odd = await run('image_edit', { path: 'two.png', rotate: 30 });
  assert.ok(odd.width > 400); assert.equal(odd.format, 'png');
  const mirror = await run('image_edit', { path: 'two.png', flop: true });
  assert.deepEqual((await pixel(abs(cfg, mirror), 10, 100)).slice(0, 3), [0, 0, 255]);
  const grey = await run('image_edit', { path: 'two.png', grayscale: true, blur: 2, sharpen: true, brightness: 1.1, saturation: 0.8 });
  assert.ok(grey.bytes > 0);
  const jpg = await run('image_convert', { path: 'two.png', format: 'jpg', quality: 80 });
  assert.equal(jpg.format, 'jpeg'); assert.match(jpg.output, /\.jpg$/);

  // a noisy photo-like image so compression has something to do
  const noise = Buffer.alloc(1200 * 800 * 3); for (let k = 0; k < noise.length; k++) noise[k] = (k * 2654435761) >>> 24;
  fs.writeFileSync(path.join(cfg.workspace, 'photo.jpg'), await sharp(noise, { raw: { width: 1200, height: 800, channels: 3 } }).jpeg({ quality: 95 }).toBuffer());
  const before = fs.statSync(path.join(cfg.workspace, 'photo.jpg')).size;
  const small = await run('image_compress', { path: 'photo.jpg', max_kb: 100 });
  assert.ok(before > 300 * 1024 && small.bytes <= 100 * 1024, `${before} -> ${small.bytes}`);
  await assert.rejects(() => run('image_compress', { path: 'photo.jpg', max_kb: 1 }), /at least 2/);

  const sticker = await run('image_sticker', { path: 'two.png', shape: 'rounded' });
  assert.deepEqual([sticker.width, sticker.height, sticker.format], [512, 512, 'webp']); assert.ok(sticker.bytes <= 100 * 1024);
  let sent; await tool(tools, 'send_sticker').handler({ path: sticker.output }, { sendSticker: async (p) => { sent = path.basename(p); } });
  assert.match(sent, /\.webp$/);
  await assert.rejects(() => run('send_sticker', { path: 'two.png' }), /must be \.webp/);

  // phone photos carry an EXIF "rotate me" flag: the result must look upright
  const exif = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#0f0' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  fs.writeFileSync(path.join(cfg.workspace, 'phone.jpg'), exif);
  assert.deepEqual([(await run('image_info', { path: 'phone.jpg' })).width, (await run('image_info', { path: 'phone.jpg' })).height], [100, 200]);
  const fixed = await run('image_resize', { path: 'phone.jpg', width: 50 });
  assert.deepEqual([fixed.width, fixed.height], [50, 100]);

  await assert.rejects(() => run('image_resize', { path: '../../etc/passwd', width: 10 }), /outside/);
  await assert.rejects(() => run('image_resize', { path: 'missing.png', width: 10 }), /no such image/);
  fs.writeFileSync(path.join(cfg.workspace, 'fake.png'), 'not an image');
  await assert.rejects(() => run('image_resize', { path: 'fake.png', width: 10 }));
  await assert.rejects(() => run('image_resize', { path: 'two.png', width: 10, output: '../escape.png' }), /outside/);
  const named = await run('image_resize', { path: 'two.png', width: 40, output: 'out/small.webp' });
  assert.equal(named.output, path.join('out', 'small.webp')); assert.equal(named.format, 'webp');
});

test('explicit jpg of a transparent picture fills the see-through parts with white', async () => {
  const { cfg, run } = await setup();
  fs.writeFileSync(path.join(cfg.workspace, 'logo.png'), await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
  const jpg = await run('image_convert', { path: 'logo.png', format: 'jpg' });
  assert.equal(jpg.format, 'jpeg'); assert.match(jpg.note, /filled with white/);
  assert.deepEqual((await pixel(abs(cfg, jpg), 5, 5)).slice(0, 3).map((v) => (v > 250 ? 255 : v)), [255, 255, 255]);
  const keep = await run('image_resize', { path: 'logo.png', width: 20 });                      // no format asked: stays png, stays transparent
  assert.equal(keep.format, 'png'); assert.equal((await pixel(abs(cfg, keep), 5, 5))[3], 0);
});

test('image tools explain themselves when sharp is missing', async () => {
  const t = createImageTools({ cfg: { workspace: tmp() }, sharpLoader: async () => { throw new Error('no'); } });
  await assert.rejects(() => tool(t, 'image_info').handler({ path: 'x.png' }), /sharp/);
});
