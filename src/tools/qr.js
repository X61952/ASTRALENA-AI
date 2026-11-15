// Generates a QR code image (uses the "qrcode" package — bundled).
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

export function createQrTools({ cfg, loader = async () => (await import('qrcode')).default }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p);

  return [{
    name: 'generate_qr',
    description: 'Make a QR code image (for a link, wifi details, text...) and save it as a PNG in the workspace. Send it with send_file.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, output: { type: 'string' }, size: { type: 'integer', description: 'pixels, default 400' } }, required: ['text'] },
    handler: async (i) => {
      const text = String(i.text || '');
      if (!text) throw new Error('nothing to encode');
      if (text.length > 2000) throw new Error('that is too long for a QR code');
      let QR; try { QR = await loader(); } catch { throw new Error('QR codes need the "qrcode" package (run: npm install)'); }
      const dir = safePath('qr'); fs.mkdirSync(dir, { recursive: true });
      const dest = i.output ? safePath(i.output) : path.join(dir, `qr-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await QR.toFile(dest, text, { width: Math.min(Math.max(Number(i.size) || 400, 100), 2000), margin: 1 });
      return { output: rel(dest) };
    },
  }];
}
