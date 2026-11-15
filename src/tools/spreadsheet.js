// Reads and creates Excel (.xlsx) and CSV files (uses the "xlsx" package — bundled).
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

export function createSpreadsheetTools({ cfg, loader = async () => (await import('xlsx')).default }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p);
  const load = async () => { try { return await loader(); } catch { throw new Error('spreadsheets need the "xlsx" package (run: npm install)'); } };

  return [
    {
      name: 'read_spreadsheet',
      description: 'Read a .xlsx or .csv file in the workspace. Returns each sheet as rows of objects (first row = column names).',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, max_rows: { type: 'integer', description: 'per sheet, default 200' } }, required: ['path'] },
      handler: async (i) => {
        const XLSX = await load();
        const p = safePath(i.path);
        if (!fs.existsSync(p)) throw new Error(`no such file: ${i.path}`);
        const wb = XLSX.readFile(p);
        const max = Math.min(Number(i.max_rows) || 200, 2000);
        const sheets = {};
        for (const name of wb.SheetNames) sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }).slice(0, max);
        return { sheets };
      },
    },
    {
      name: 'create_spreadsheet',
      description: 'Create a .xlsx file from data (one or more sheets, each an array of row objects with the same keys as columns).',
      input_schema: { type: 'object', properties: { sheets: { type: 'object', description: 'sheet name -> array of row objects' }, output: { type: 'string' } }, required: ['sheets'] },
      handler: async (i) => {
        const XLSX = await load();
        const names = Object.keys(i.sheets || {});
        if (!names.length) throw new Error('give at least one sheet');
        const wb = XLSX.utils.book_new();
        for (const name of names) {
          const rows = i.sheets[name];
          if (!Array.isArray(rows)) throw new Error(`sheet "${name}" must be an array of row objects`);
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31) || 'Sheet1');
        }
        const dest = i.output ? safePath(i.output) : safePath(`sheet-${Date.now()}.xlsx`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        XLSX.writeFile(wb, dest);
        return { output: rel(dest), sheets: names };
      },
    },
  ];
}
