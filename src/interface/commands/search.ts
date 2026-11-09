// `/search`: quick search's targeted settings, written to the persona's settings file like setup writes them. Its route is
// its chain `models.routes.search`, set with `/model set search <key>/<model>` and checked with `/keys check search`;
// `/search model <id>` puts another model on each route of that chain. Deep search through the scout is a separate
// agent and these commands do not touch it. Reading a known page stays on whatever quick search is set to. Quick search
// has no built-in engine or route: it is off until `/search engine` or setup chooses one. Called by
// src/interface/commands/console.ts and the setup's services step (src/setup/services.ts).

import { readConfig } from '../../config.ts';
import { localConfigPath } from '../../config/files.ts';
import { SEARCH_ROLE, searchModel } from '../../llm/roles.ts';
import { isRefusal, parseRouteText, readRoute } from '../../llm/route-text.ts';
import type { Route } from '../../llm/route-text.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../../tools/operations/shared.ts';
import { objOf } from '../../tools/types.ts';

const ENGINES: ReadonlyArray<string> = ['openrouter', 'brave', 'exa'];

function write(dataDir: string, key: string, value: unknown): void {
  const file = localConfigPath(dataDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['web', 'quickSearch', key], value));
}

/** The `search` chain the settings file holds, records the reader refuses left out. */
function searchChain(dataDir: string): Array<Route> {
  const chain = objOf(objOf(readLocalConfig(localConfigPath(dataDir))).models).routes;
  const own: unknown = objOf(chain)[SEARCH_ROLE];
  return Array.isArray(own)
    ? own.map((one) => readRoute(SEARCH_ROLE, one)).filter((route): route is Route => !isRefusal(route))
    : [];
}

function writeChain(dataDir: string, chain: ReadonlyArray<Route>): void {
  const file = localConfigPath(dataDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['models', 'routes', SEARCH_ROLE], chain));
}

/**
 * The `search` chain of one route read from `text`, `<key>/<model>`, written with no check: setup's answer, which
 * `/keys check search` proves later. A route that does not read, or names a key `names` lacks, writes nothing.
 */
export function setSearchRoute(
  dataDir: string,
  text: string,
  names: ReadonlyArray<string>
): { ok: true } | { ok: false; reason: string } {
  const route = parseRouteText(SEARCH_ROLE, text);
  if (isRefusal(route)) return { ok: false, reason: route.reason };
  if (route.via === 'api' && !names.includes(route.key))
    return { ok: false, reason: `keys.json holds no key named ${route.key}` };
  writeChain(dataDir, [route]);
  return { ok: true };
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
    case 'search.model': {
      if (word === '') return { text: 'name a model id', status: 'invalid' };
      const chain = searchChain(dataDir);
      if (chain.length === 0)
        return { text: 'quick search has no route yet: /model set search <key>/<model>', status: 'invalid' };
      writeChain(
        dataDir,
        chain.map((route) => ({ ...route, model: word }))
      );
      return { text: `quick search uses the model ${word}; check it with /keys check search`, status: 'ok' };
    }
    default: {
      const config =
        rootDir === undefined
          ? readLocalConfig(localConfigPath(dataDir))
          : readConfig(rootDir, { privateDir: dataDir });
      const search = objOf(objOf(config).web).quickSearch;
      const engine = objOf(search).engine;
      const isOn = objOf(search).enabled !== false && typeof engine === 'string' && engine !== '';
      return {
        text: `quick search is ${isOn ? 'on' : 'off'}, engine ${typeof engine === 'string' ? engine : 'unset'}, model ${searchModel(config) ?? 'unset'}`,
        status: 'ok',
      };
    }
  }
}
