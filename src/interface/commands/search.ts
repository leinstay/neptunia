// `/search`: quick search's targeted settings, written to the persona's settings file like setup writes them. Its key is
// bound with `/keys bind search <name>` and checked with `/keys check search`. Deep search through the scout is a
// separate agent and these commands do not touch it. Reading a known page stays on whatever quick search is set to.
// Called by src/interface/commands/console.ts.

import { readConfig } from '../../config.ts';
import { localConfigPath } from '../../config/files.ts';
import { searchModel } from '../../llm/roles.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../../tools/impl/shared.ts';
import { objOf } from '../../tools/types.ts';

const ENGINES: ReadonlyArray<string> = ['openrouter', 'brave', 'exa'];

function write(dataDir: string, key: string, value: unknown): void {
  const file = localConfigPath(dataDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['web', 'search', key], value));
}

/** Runs one `/search` command. `rootDir` holds the engine's defaults the status line falls back on. */
export function searchCommand(
  dataDir: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  rootDir?: string
): { text: string; status: string } {
  const word = typeof args.name === 'string' ? args.name : typeof args.id === 'string' ? args.id : '';
  switch (name) {
    case 'search.enable':
      write(dataDir, 'enabled', true);
      return { text: 'quick search is on', status: 'ok' };
    case 'search.disable':
      write(dataDir, 'enabled', false);
      return { text: 'quick search is off; reading a known page stays', status: 'ok' };
    case 'search.engine':
      if (!ENGINES.includes(word)) return { text: `use one of ${ENGINES.join(', ')}`, status: 'invalid' };
      write(dataDir, 'engine', word);
      return { text: `quick search uses ${word}`, status: 'ok' };
    case 'search.model':
      if (word === '') return { text: 'name a model id', status: 'invalid' };
      write(dataDir, 'model', word);
      return { text: `quick search uses the model ${word}; check it with /keys check search`, status: 'ok' };
    default: {
      const config =
        rootDir === undefined
          ? readLocalConfig(localConfigPath(dataDir))
          : readConfig(rootDir, { privateDir: dataDir });
      const search = objOf(objOf(config).web).search;
      const on = objOf(search).enabled !== false;
      const engine = objOf(search).engine;
      return {
        text: `quick search is ${on ? 'on' : 'off'}, engine ${typeof engine === 'string' ? engine : 'unset'}, model ${searchModel(config)}`,
        status: 'ok',
      };
    }
  }
}
