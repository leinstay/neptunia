// `/search`: quick search's targeted settings, written to the persona's settings file like setup writes them. Its model
// requests go out on the analyzer, whose routes `/model` sets and `/keys check analyzer` checks. Deep search through the
// scout is a separate agent and these commands do not touch it. Reading a known page stays on whatever quick search is
// set to. Quick search has no built-in engine: it is off until `/search engine` or setup chooses one. Called by
// src/interface/commands/console.ts and the setup's services step (src/setup/services.ts).

import { readConfig } from '../../config.ts';
import { localConfigPath } from '../../config/files.ts';
import { roleModel } from '../../llm/roles.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../../tools/operations/shared.ts';
import { objOf } from '../../tools/types.ts';

const ENGINES: ReadonlyArray<string> = ['openrouter', 'brave', 'exa'];

function write(dataDir: string, key: string, value: unknown): void {
  const file = localConfigPath(dataDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['web', 'quickSearch', key], value));
}

/** Runs one `/search` command. `rootDir` holds the engine's defaults the status line falls back on. */
export function searchCommand(
  dataDir: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  rootDir?: string
): { text: string; status: string } {
  const word = typeof args.name === 'string' ? args.name : '';
  switch (name) {
    case 'search.enable':
      write(dataDir, 'enabled', true);
      return {
        text: 'quick search may run once an engine is chosen; /search status says where it stands',
        status: 'ok',
      };
    case 'search.disable':
      write(dataDir, 'enabled', false);
      return { text: 'quick search is off; reading a known page stays', status: 'ok' };
    case 'search.engine':
      if (!ENGINES.includes(word)) return { text: `use one of ${ENGINES.join(', ')}`, status: 'invalid' };
      write(dataDir, 'engine', word);
      return { text: `quick search uses ${word}`, status: 'ok' };
    default: {
      const config =
        rootDir === undefined
          ? readLocalConfig(localConfigPath(dataDir))
          : readConfig(rootDir, { privateDir: dataDir });
      const search = objOf(objOf(config).web).quickSearch;
      const engine = objOf(search).engine;
      const isOn = objOf(search).enabled !== false && typeof engine === 'string' && engine !== '';
      return {
        text: `quick search is ${isOn ? 'on' : 'off'}, engine ${typeof engine === 'string' ? engine : 'unset'}, model ${roleModel(config, 'analyzer', 'search-summary') ?? 'unset'}`,
        status: 'ok',
      };
    }
  }
}
