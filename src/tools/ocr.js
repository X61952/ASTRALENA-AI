// Reads text out of an image (OCR, uses "tesseract.js" — bundled, pure JS, no
// system install needed).
import fs from 'node:fs';
import { createSafePath } from './files.js';

export function createOcrTools({ cfg, loader = async () => (await import('tesseract.js')) }) {
  const safePath = createSafePath(cfg.workspace);
  return [{
    name: 'ocr_image',
    description: 'Read text out of an image (a photo of a document, a screenshot, a sign). Works best on clear, reasonably high-resolution images.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, language: { type: 'string', description: 'default eng' } }, required: ['path'] },
    handler: async (i) => {
      const p = safePath(i.path);
      if (!fs.existsSync(p)) throw new Error(`no such image: ${i.path}`);
      let T; try { T = await loader(); } catch { throw new Error('OCR needs the "tesseract.js" package (run: npm install)'); }
      const { data } = await T.recognize(p, i.language || 'eng');
      const text = String(data?.text || '').trim();
      return { text: text.slice(0, 8000), confidence: Math.round(data?.confidence || 0) };
    },
  }];
}
