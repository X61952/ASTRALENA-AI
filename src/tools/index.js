// Tool registry: gathers every tool and gives the agent one definitions list
// plus a single run() that executes a tool by name.
import { createWebTools } from './web.js';
import { createFileTools } from './files.js';
import { createShellTools } from './shell.js';
import { createGithubTools } from './github.js';
import { createWebsiteTools } from './website.js';
import { createBrowserTools } from './browser.js';
import { createMiscTools } from './misc.js';
import { createImageTools } from './image.js';
import { createObfuscateTools } from './obfuscate.js';
import { createArchiveTools } from './archive.js';
import { createQrTools } from './qr.js';
import { createDocumentTools } from './documents.js';
import { createSpreadsheetTools } from './spreadsheet.js';
import { createOcrTools } from './ocr.js';
import { createCanvasTools } from './canvas.js';
import { createVoiceTools } from './voice.js';
import { Background } from '../background.js';

export function buildTools(deps) {
  const bg = deps.bg || new Background({ cfg: deps.cfg });
  const all = [
    ...createWebTools(deps),
    ...createBrowserTools(deps),
    ...createFileTools(deps),
    ...createShellTools({ ...deps, bg }),
    ...createImageTools(deps),
    ...createObfuscateTools(deps),
    ...createArchiveTools(deps),
    ...createQrTools(deps),
    ...createDocumentTools(deps),
    ...createSpreadsheetTools(deps),
    ...createOcrTools(deps),
    ...createCanvasTools(deps),
    ...createVoiceTools(deps),
    ...createGithubTools(deps),
    ...createWebsiteTools(deps),
    ...createMiscTools(deps),
  ];
  const byName = new Map(all.map((t) => [t.name, t]));
  return {
    definitions: all.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    names: [...byName.keys()],
    async run(name, input, ctx) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      if (input && input.__parse_error !== undefined) throw new Error('the tool arguments were not valid JSON; send them again as a proper JSON object');
      return tool.handler(input || {}, ctx);
    },
  };
}
