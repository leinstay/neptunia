// Module hooks for tests/skills-no-command-table.test.js (loaded with `node --import <this file>`):
// the owner's slash-command tree is taken away from the modules that hold it, so a child process
// can prove the persona's skills do not need it. COMMAND_TABLE (src/ops/catalog.js) is exported
// empty, and `resolveCommand` (src/ops/index.js) throws when called. Source text is rewritten as
// it loads; nothing on disk changes. The same file is the loader (its `load` export runs on the
// hooks thread) and the registration (its top level runs on the main thread).
import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

const CATALOG = /\/src\/ops\/catalog\.js$/;
const OPS_INDEX = /\/src\/ops\/index\.js$/;

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const path = url.split('?')[0];
  if (loaded.format !== 'module' || (!CATALOG.test(path) && !OPS_INDEX.test(path))) return loaded;
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

if (isMainThread) register(import.meta.url);
