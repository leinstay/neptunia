// Module hooks for tests/skills-no-command-table.test.js (loaded with `node --import <this file>`):
// the owner's slash-command tree is taken away from the modules that hold it, so a child process
// can prove the persona's skills do not need it. COMMAND_TABLE (src/tools/impl/catalog.ts) is exported
// empty, and `resolveCommand` (src/tools/impl/index.ts) throws when called. Source text is rewritten as
// it loads; nothing on disk changes. Synchronous in-thread hooks (`module.registerHooks`), which
// replace the deprecated `module.register`.
import { registerHooks } from 'node:module';

const CATALOG = /\/src\/tools\/impl\/catalog\.ts$/;
const OPS_INDEX = /\/src\/tools\/impl\/index\.ts$/;

function load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  const path = url.split('?')[0];
  if (!String(loaded.format).startsWith("module") || (!CATALOG.test(path) && !OPS_INDEX.test(path))) return loaded;
  let source = String(loaded.source);
  if (CATALOG.test(path)) {
    const marker = 'export const COMMAND_TABLE = Object.freeze(';
    if (!source.includes(marker)) throw new Error('no-command-table hooks: COMMAND_TABLE declaration not found');
    source = `${source.replace(marker, 'const COMMAND_TABLE_REAL = Object.freeze(')}\nexport const COMMAND_TABLE = Object.freeze([]);\n`;
  } else {
    const marker = 'export function resolveCommand(';
    if (!source.includes(marker)) throw new Error('no-command-table hooks: resolveCommand declaration not found');
    source = `${source.replace(marker, 'function resolveCommandReal(')}\nexport function resolveCommand(commandKey) { throw new Error(\`resolveCommand called: \${commandKey}\`); }\n`;
  }
  return { ...loaded, source };
}

registerHooks({ load });
