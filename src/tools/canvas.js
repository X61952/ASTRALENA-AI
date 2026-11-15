// Draws a brand-new image from scratch: background, text, simple shapes.
// Uses "@napi-rs/canvas" — bundled, same family as sharp (no system libs).
// For editing an EXISTING image (resize/crop/etc), use the image_* tools instead.
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

const ALIGN = { left: 'left', center: 'center', right: 'right' };

export function createCanvasTools({ cfg, loader = async () => (await import('@napi-rs/canvas')) }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p);

  return [{
    name: 'create_image',
    description: 'Draw a brand-new image: a solid or two-colour gradient background, lines of text (own size/colour/alignment each), and simple shapes (rectangles, circles, lines). Good for banners, cards, quote images, simple graphics. For photos, use the image_* tools instead.',
    input_schema: { type: 'object', properties: {
      width: { type: 'integer', description: 'default 1200' }, height: { type: 'integer', description: 'default 630' },
      background: { type: 'string', description: 'colour, e.g. #1e1e2e' }, gradient_to: { type: 'string', description: 'optional second colour, makes a top-to-bottom gradient' },
      texts: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, color: { type: 'string' }, align: { type: 'string', enum: ['left', 'center', 'right'] }, bold: { type: 'boolean' } }, required: ['text', 'x', 'y'] } },
      shapes: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['rect', 'circle', 'line'] }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, radius: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, color: { type: 'string' } }, required: ['type'] } },
      output: { type: 'string' },
    } },
    handler: async (i) => {
      let C; try { C = await loader(); } catch { throw new Error('drawing images needs the "@napi-rs/canvas" package (run: npm install)'); }
      const w = Math.min(Math.max(Number(i.width) || 1200, 50), 4000);
      const h = Math.min(Math.max(Number(i.height) || 630, 50), 4000);
      const canvas = C.createCanvas(w, h); const ctx = canvas.getContext('2d');

      if (i.gradient_to) { const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, i.background || '#111111'); g.addColorStop(1, i.gradient_to); ctx.fillStyle = g; }
      else ctx.fillStyle = i.background || '#111111';
      ctx.fillRect(0, 0, w, h);

      for (const s of i.shapes || []) {
        ctx.fillStyle = s.color || '#ffffff'; ctx.strokeStyle = s.color || '#ffffff';
        if (s.type === 'rect') ctx.fillRect(s.x || 0, s.y || 0, s.width || 100, s.height || 100);
        else if (s.type === 'circle') { ctx.beginPath(); ctx.arc(s.x || 0, s.y || 0, s.radius || 50, 0, Math.PI * 2); ctx.fill(); }
        else if (s.type === 'line') { ctx.lineWidth = s.width || 2; ctx.beginPath(); ctx.moveTo(s.x || 0, s.y || 0); ctx.lineTo(s.x2 || 0, s.y2 || 0); ctx.stroke(); }
      }
      for (const t of i.texts || []) {
        const size = t.size || 32;
        ctx.font = `${t.bold ? 'bold ' : ''}${size}px sans-serif`;
        ctx.fillStyle = t.color || '#ffffff';
        ctx.textAlign = ALIGN[t.align] || 'left';
        ctx.fillText(String(t.text).slice(0, 300), t.x, t.y);
      }
      const dest = i.output ? safePath(i.output) : safePath(`canvas-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await canvas.encode('png'));
      return { output: rel(dest), width: w, height: h };
    },
  }];
}
