// New "highly advanced" tools: zip/unzip, QR, PDF/Word creation, spreadsheets,
// OCR, drawing images from scratch, text-to-speech, and website screenshots.
// Each real package (adm-zip, qrcode, pdf-lib, docx, xlsx, tesseract.js,
// @napi-rs/canvas, node-gtts, fluent-ffmpeg, playwright) is swapped for a
// small stub so the TOOL's own logic (sandboxing, validation, approvals,
// file naming) is verified without needing the heavy native packages
// installed in this environment — the same pattern used for sharp/obfuscator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveTools } from '../src/tools/archive.js';
import { createQrTools } from '../src/tools/qr.js';
import { createDocumentTools } from '../src/tools/documents.js';
import { createSpreadsheetTools } from '../src/tools/spreadsheet.js';
import { createOcrTools } from '../src/tools/ocr.js';
import { createCanvasTools } from '../src/tools/canvas.js';
import { createVoiceTools } from '../src/tools/voice.js';
import { createBrowserTools } from '../src/tools/browser.js';
import { buildTools } from '../src/tools/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-adv-'));
const cfg = () => ({ workspace: tmp() });
const tool = (l, n) => l.find((t) => t.name === n);
const publicLookup = async () => [{ address: '93.184.216.34' }];

test('archive: zip then unzip round-trips real files, stays sandboxed', async () => {
  // real adm-zip-shaped stub backed by actual files, so the round trip is genuine
  class Zip {
    constructor(file) { this.entries = []; if (file) for (const name of fs.readdirSync(path.dirname(file))) {} this.file = file; if (file && fs.existsSync(file)) this.entries = JSON.parse(fs.readFileSync(file, 'utf8')); }
    addLocalFile(p) { this.entries.push({ name: path.basename(p), data: fs.readFileSync(p, 'utf8') }); }
    addLocalFolder(p, base) { for (const f of fs.readdirSync(p)) this.entries.push({ name: path.join(base, f), data: fs.readFileSync(path.join(p, f), 'utf8') }); }
    writeZip(dest) { fs.writeFileSync(dest, JSON.stringify(this.entries)); }
    getEntries() { return this.entries; }
    extractAllTo(dest) { fs.mkdirSync(dest, { recursive: true }); for (const e of this.entries) fs.writeFileSync(path.join(dest, path.basename(e.name)), e.data); }
  }
  const c = cfg();
  const tools = createArchiveTools({ cfg: c, loader: async () => Zip });
  fs.writeFileSync(path.join(c.workspace, 'a.txt'), 'hello'); fs.mkdirSync(path.join(c.workspace, 'docs')); fs.writeFileSync(path.join(c.workspace, 'docs/b.txt'), 'world');
  const zipped = await tool(tools, 'zip_files').handler({ paths: ['a.txt', 'docs'], output: 'out.zip' });
  assert.equal(zipped.output, 'out.zip'); assert.ok(zipped.bytes > 0);
  const un = await tool(tools, 'unzip_file').handler({ path: 'out.zip', into: 'restored' });
  assert.equal(un.files, 2);
  assert.equal(fs.readFileSync(path.join(c.workspace, 'restored', 'a.txt'), 'utf8'), 'hello');
  await assert.rejects(() => tool(tools, 'zip_files').handler({ paths: ['missing.txt'] }), /no such file/);
  await assert.rejects(() => tool(tools, 'zip_files').handler({ paths: ['../../etc'] }), /outside/);
  await assert.rejects(() => tool(tools, 'zip_files').handler({ paths: [] }), /at least one/);
  const broken = createArchiveTools({ cfg: c, loader: async () => { throw new Error('x'); } });
  await assert.rejects(() => tool(broken, 'zip_files').handler({ paths: ['a.txt'] }), /adm-zip/);
});

test('qr: writes a png, validates input, explains a missing package', async () => {
  const c = cfg();
  const written = [];
  const tools = createQrTools({ cfg: c, loader: async () => ({ toFile: async (dest, text, opts) => { written.push({ dest, text, opts }); fs.writeFileSync(dest, 'PNGDATA'); } }) });
  const r = await tool(tools, 'generate_qr').handler({ text: 'https://codex-ai.site', size: 300 });
  assert.match(r.output, /^qr\/qr-\d+\.png$/); assert.equal(written[0].text, 'https://codex-ai.site'); assert.equal(written[0].opts.width, 300);
  assert.equal(fs.readFileSync(path.join(c.workspace, r.output), 'utf8'), 'PNGDATA');
  await assert.rejects(() => tool(tools, 'generate_qr').handler({ text: '' }), /nothing to encode/);
  await assert.rejects(() => tool(tools, 'generate_qr').handler({ text: 'x'.repeat(3000) }), /too long/);
  await assert.rejects(() => tool(createQrTools({ cfg: c, loader: async () => { throw new Error('x'); } }), 'generate_qr').handler({ text: 'hi' }), /"qrcode" package/);
});

test('documents: create_pdf and create_docx produce real files via the real APIs they call', async () => {
  const c = cfg();
  const pages = []; const Pdf = { PDFDocument: { create: async () => ({ addPage: (s) => { const p = { s, calls: [] }; pages.push(p); return { drawText: (t, o) => p.calls.push([t, o]) }; }, embedFont: async () => 'FONT', getPageCount: () => pages.length, save: async () => Buffer.from('PDFBYTES') }) }, StandardFonts: { Helvetica: 'H', HelveticaBold: 'HB' }, rgb: () => 'RGB' };
  const docTools = createDocumentTools({ cfg: c, pdfLoader: async () => Pdf });
  const pdf = await tool(docTools, 'create_pdf').handler({ title: 'Report', body: 'Line one\n\nLine two is a bit longer '.repeat(5) });
  assert.match(pdf.output, /\.pdf$/); assert.ok(pdf.pages >= 1);
  assert.equal(fs.readFileSync(path.join(c.workspace, pdf.output), 'utf8'), 'PDFBYTES');
  const built = []; const Docx = { Document: class { constructor(o) { built.push(o); } }, Packer: { toBuffer: async () => Buffer.from('DOCXBYTES') }, Paragraph: class { constructor(o) { this.o = o; } }, HeadingLevel: { TITLE: 'T', HEADING_1: 'H1' } };
  const docTools2 = createDocumentTools({ cfg: c, docxLoader: async () => Docx });
  const word = await tool(docTools2, 'create_docx').handler({ title: 'Notes', sections: [{ heading: 'Intro', body: 'hello\nworld' }] });
  assert.match(word.output, /\.docx$/); assert.ok(built[0].sections[0].children.length >= 4);
  assert.equal(fs.readFileSync(path.join(c.workspace, word.output), 'utf8'), 'DOCXBYTES');
  await assert.rejects(() => tool(docTools2, 'create_docx').handler({ sections: [] }), /at least one section/);
  await assert.rejects(() => tool(createDocumentTools({ cfg: c, pdfLoader: async () => { throw new Error('x'); } }), 'create_pdf').handler({ body: 'x' }), /"pdf-lib"/);
});

test('spreadsheets: write then read back real rows through the real xlsx-shaped API', async () => {
  const c = cfg();
  const books = {};
  const XLSX = {
    utils: { book_new: () => ({ SheetNames: [], Sheets: {} }), json_to_sheet: (rows) => ({ rows }), book_append_sheet: (wb, sheet, name) => { wb.SheetNames.push(name); wb.Sheets[name] = sheet; }, sheet_to_json: (sheet) => sheet.rows },
    writeFile: (wb, dest) => { books[dest] = wb; fs.writeFileSync(dest, 'XLSXBYTES'); },
    readFile: (p) => books[p],
  };
  const tools = createSpreadsheetTools({ cfg: c, loader: async () => XLSX });
  const made = await tool(tools, 'create_spreadsheet').handler({ sheets: { People: [{ name: 'Ada', age: 30 }, { name: 'Bo', age: 25 }] } });
  assert.deepEqual(made.sheets, ['People']);
  const back = await tool(tools, 'read_spreadsheet').handler({ path: made.output });
  assert.deepEqual(back.sheets.People, [{ name: 'Ada', age: 30 }, { name: 'Bo', age: 25 }]);
  await assert.rejects(() => tool(tools, 'create_spreadsheet').handler({ sheets: {} }), /at least one sheet/);
  await assert.rejects(() => tool(tools, 'create_spreadsheet').handler({ sheets: { X: 'not an array' } }), /must be an array/);
  await assert.rejects(() => tool(tools, 'read_spreadsheet').handler({ path: 'missing.xlsx' }), /no such file/);
});

test('ocr: reads text via the real tesseract-shaped API, sandboxed', async () => {
  const c = cfg();
  fs.writeFileSync(path.join(c.workspace, 'scan.png'), 'img');
  const tools = createOcrTools({ cfg: c, loader: async () => ({ recognize: async (p, lang) => ({ data: { text: `read from ${path.basename(p)} in ${lang}  `, confidence: 87.6 } }) }) });
  const r = await tool(tools, 'ocr_image').handler({ path: 'scan.png', language: 'eng' });
  assert.deepEqual([r.text, r.confidence], ['read from scan.png in eng', 88]);
  await assert.rejects(() => tool(tools, 'ocr_image').handler({ path: 'missing.png' }), /no such image/);
  await assert.rejects(() => tool(tools, 'ocr_image').handler({ path: '../../etc/passwd' }), /outside/);
});

test('create_image: draws through the real canvas-shaped 2D API, sandboxed, size clamped', async () => {
  const c = cfg();
  const calls = [];
  const ctx2d = { fillRect: (...a) => calls.push(['fillRect', ...a]), fillText: (...a) => calls.push(['fillText', ...a]), beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, createLinearGradient: () => ({ addColorStop() {} }) };
  const createCanvas = (w, h) => ({ w, h, getContext: () => ctx2d, encode: async () => Buffer.from(`PNG:${w}x${h}`) });
  const tools = createCanvasTools({ cfg: c, loader: async () => ({ createCanvas }) });
  const r = await tool(tools, 'create_image').handler({ width: 500, height: 300, background: '#111', texts: [{ text: 'Hello', x: 10, y: 20, bold: true }], shapes: [{ type: 'rect', x: 0, y: 0, width: 10, height: 10 }, { type: 'circle', x: 5, y: 5, radius: 3 }, { type: 'line', x: 0, y: 0, x2: 10, y2: 10 }] });
  assert.deepEqual([r.width, r.height], [500, 300]); assert.equal(fs.readFileSync(path.join(c.workspace, r.output), 'utf8'), 'PNG:500x300');
  assert.ok(calls.some((c) => c[0] === 'fillText' && c[1] === 'Hello'));
  const clamped = await tool(tools, 'create_image').handler({ width: 99999, height: 1 });
  assert.ok(clamped.width <= 4000);
  await assert.rejects(() => tool(createCanvasTools({ cfg: c, loader: async () => { throw new Error('x'); } }), 'create_image').handler({}), /@napi-rs\/canvas/);
});

test('voice: text-to-speech pipes through the real gtts + ffmpeg-shaped APIs, then sends as a voice note', async () => {
  const c = cfg();
  const writes = [];
  const gttsLoader = async () => (lang) => ({ save: (file, text, cb) => { writes.push({ file, text, lang }); fs.writeFileSync(file, 'MP3BYTES'); cb(null); } });
  const ffmpegLoader = async () => { const fn = (input) => ({ audioCodec() { return this; }, format() { return this; }, on(evt, cb) { if (evt === 'end') this._end = cb; return this; }, save(dest) { fs.writeFileSync(dest, `OGG from ${path.basename(input)}`); this._end(); } }); fn.setFfmpegPath = () => {}; return fn; };
  const tools = createVoiceTools({ cfg: c, gttsLoader, ffmpegLoader });
  const made = await tool(tools, 'text_to_speech').handler({ text: 'hello codex', language: 'en' });
  assert.match(made.output, /^voice\/tts-\d+\.ogg$/);
  assert.equal(fs.readFileSync(path.join(c.workspace, made.output), 'utf8'), 'OGG from tts-' + made.output.match(/\d+/)[0] + '.mp3');
  assert.equal(writes[0].text, 'hello codex'); assert.equal(writes[0].lang, 'en');
  assert.ok(!fs.existsSync(path.join(c.workspace, 'voice', made.output.split('/')[1].replace('.ogg', '.mp3'))));   // the intermediate mp3 is cleaned up
  let sentPath; await tool(tools, 'send_voice_note').handler({ path: made.output }, { sendVoiceNote: async (p) => { sentPath = p; } });
  assert.ok(sentPath.endsWith('.ogg'));
  await assert.rejects(() => tool(tools, 'send_voice_note').handler({ path: 'nope.ogg' }), /no such file/);
  await assert.rejects(() => tool(tools, 'text_to_speech').handler({ text: '' }), /nothing to say/);
  await assert.rejects(() => tool(createVoiceTools({ cfg: c, gttsLoader: async () => { throw new Error('x'); } }), 'text_to_speech').handler({ text: 'hi' }), /"node-gtts"/);
});

test('website_screenshot: a clear wrapper around the browser, full page by default, still refuses private hosts', async () => {
  let got;
  const pw = { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => ({ route: async () => {}, goto: async () => {}, waitForTimeout: async () => {}, title: async () => 'Site', url: () => 'https://codex-ai.site', screenshot: async (o) => { got = o; fs.writeFileSync(o.path, 'PNG'); } }) }), close: async () => {} }) } };
  const tools = createBrowserTools({ cfg: cfg(), importPlaywright: async () => pw, lookup: publicLookup });
  const r = await tool(tools, 'website_screenshot').handler({ url: 'https://codex-ai.site' });
  assert.equal(r.title, 'Site'); assert.match(r.screenshot, /^screenshots\/shot-\d+\.png$/); assert.equal(got.fullPage, true);
  const r2 = await tool(tools, 'website_screenshot').handler({ url: 'https://codex-ai.site', full_page: false });
  assert.equal(got.fullPage, false);
  await assert.rejects(() => tool(tools, 'website_screenshot').handler({ url: 'http://169.254.169.254/' }), /private|internal/);
  assert.ok(tools.find((t) => t.name === 'browser_open'));                                       // the general tool is still there too
});

test('the registry exposes every new tool with a valid schema', () => {
  const dir = tmp();
  const t = buildTools({ cfg: { workspace: dir, dataDir: dir, tz: 'Africa/Lagos', tavilyKey: '', braveKey: '', github: { token: '' }, site: {}, stt: { key: '' } }, memory: { facts: () => ({}), commands: () => ({}), logTask() {}, history: () => [], append() {}, setMeta() {}, meta: () => ({}) }, scheduler: { list: () => [] } });
  for (const n of ['zip_files', 'unzip_file', 'generate_qr', 'create_pdf', 'create_docx', 'read_spreadsheet', 'create_spreadsheet', 'ocr_image', 'create_image', 'text_to_speech', 'send_voice_note', 'website_screenshot', 'browser_open']) assert.ok(t.names.includes(n), n);
  assert.equal(new Set(t.names).size, t.names.length);
  assert.ok(t.names.length >= 58);
  for (const d of t.definitions) assert.ok(d.input_schema.type === 'object' && d.description.length >= 10, d.name);
});
