// Creates PDF and Word (.docx) documents from scratch (uses "pdf-lib" and
// "docx" — bundled). For reading an existing PDF, use read_pdf instead.
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

export function createDocumentTools({ cfg, pdfLoader = async () => import('pdf-lib'), docxLoader = async () => import('docx') }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p);
  const wrap = (text, max = 95) => String(text).split('\n').flatMap((line) => {
    const words = line.split(' '); const out = []; let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length > max) { out.push(cur.trim()); cur = w; } else cur += ' ' + w; }
    out.push(cur.trim()); return out.length ? out : [''];
  });

  return [
    {
      name: 'create_pdf',
      description: 'Create a simple PDF from a title and body text (plain text, paragraphs separated by blank lines). Good for reports, letters, simple documents. For complex layouts use html/markdown and convert with run_shell instead.',
      input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, output: { type: 'string' } }, required: ['body'] },
      handler: async (i) => {
        let PDFLib; try { PDFLib = await pdfLoader(); } catch { throw new Error('PDFs need the "pdf-lib" package (run: npm install)'); }
        const { PDFDocument, StandardFonts, rgb } = PDFLib;
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const bold = await doc.embedFont(StandardFonts.HelveticaBold);
        const margin = 50; const pageSize = [595, 842]; let page = doc.addPage(pageSize); let y = pageSize[1] - margin;
        const newPage = () => { page = doc.addPage(pageSize); y = pageSize[1] - margin; };
        if (i.title) { page.drawText(String(i.title).slice(0, 120), { x: margin, y, size: 18, font: bold, color: rgb(0, 0, 0) }); y -= 30; }
        for (const line of wrap(i.body || '')) {
          if (y < margin) newPage();
          page.drawText(line, { x: margin, y, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
          y -= 15;
        }
        const dest = i.output ? safePath(i.output) : safePath(`doc-${Date.now()}.pdf`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, await doc.save());
        return { output: rel(dest), pages: doc.getPageCount() };
      },
    },
    {
      name: 'create_docx',
      description: 'Create a Word (.docx) document from a title and sections (each with a heading and body text).',
      input_schema: { type: 'object', properties: { title: { type: 'string' }, sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['body'] } }, output: { type: 'string' } }, required: ['sections'] },
      handler: async (i) => {
        let D; try { D = await docxLoader(); } catch { throw new Error('Word documents need the "docx" package (run: npm install)'); }
        const { Document, Packer, Paragraph, HeadingLevel } = D;
        if (!Array.isArray(i.sections) || !i.sections.length) throw new Error('give at least one section');
        const children = [];
        if (i.title) children.push(new Paragraph({ text: String(i.title).slice(0, 200), heading: HeadingLevel.TITLE }));
        for (const s of i.sections) {
          if (s.heading) children.push(new Paragraph({ text: String(s.heading).slice(0, 200), heading: HeadingLevel.HEADING_1 }));
          for (const line of String(s.body || '').split('\n')) children.push(new Paragraph(line));
        }
        const doc = new Document({ sections: [{ children }] });
        const dest = i.output ? safePath(i.output) : safePath(`doc-${Date.now()}.docx`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, await Packer.toBuffer(doc));
        return { output: rel(dest) };
      },
    },
  ];
}
