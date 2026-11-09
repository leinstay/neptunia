// The services step of `neptunia setup` (src/setup/run.ts): the optional YouTube Data API key, offered with the link
// that says how to get one, then optional quick search. Quick search has no built-in engine, so it is off until the
// owner names one here or with `/search engine`. An empty answer declines each question. An engine goes in only with what
// it needs: the service key of `brave` or `exa`, the route of `openrouter` on a named key of keys.json.

import { searchCommand, setSearchRoute } from '../interface/commands/search.ts';
import { readKeys } from '../keys/file.ts';
import { readLocalConfig } from '../tools/operations/shared.ts';
import { objOf } from '../tools/types.ts';
import { localConfigPath } from '../config/files.ts';
import { SERVICES, writeService } from '../keys/services.ts';
import { serviceCredential } from '../keys/file.ts';

export type ServicesStepDeps = {
  ask: (question: string, offered: string | null, options?: { secret: boolean }) => Promise<string>;
};

type Outcome = { state: 'done' | 'already'; detail: string };

async function youtubeStep(dataDir: string, ask: ServicesStepDeps['ask']): Promise<Outcome> {
  if (serviceCredential(dataDir, 'youtube') !== null) return { state: 'already', detail: 'the YouTube key is set' };
  const answer = (await ask(`${SERVICES.youtube}. Optional, empty skips it:`, null, { secret: true })).trim();
  if (answer === '') return { state: 'already', detail: 'no YouTube key; /keys service set youtube adds it later' };
  writeService(dataDir, 'youtube', answer);
  return { state: 'done', detail: 'the YouTube key is stored' };
}

async function quickSearchStep(dataDir: string, ask: ServicesStepDeps['ask']): Promise<Outcome> {
  const declined: Outcome = { state: 'already', detail: 'quick search is off; /search engine turns it on later' };
  const search = objOf(objOf(readLocalConfig(localConfigPath(dataDir))).web).quickSearch;
  if (typeof objOf(search).engine === 'string') return { state: 'already', detail: 'quick search has its engine' };
  const engine = (
    await ask('Quick search, one engine: openrouter, brave or exa. Optional, empty leaves it off:', null)
  ).trim();
  if (engine === 'openrouter') {
    const text = (await ask('The route of quick search, <key>/<model>. Empty leaves it off:', null)).trim();
    if (text === '') return declined;
    const set = setSearchRoute(dataDir, text, Object.keys(readKeys(dataDir).keys));
    if (!set.ok) return { state: 'already', detail: `quick search is off: ${set.reason}` };
  } else if (engine === 'brave' || engine === 'exa') {
    if (serviceCredential(dataDir, engine) === null) {
      const key = (await ask(`${SERVICES[engine]}. Empty leaves it off:`, null, { secret: true })).trim();
      if (key === '') return declined;
      writeService(dataDir, engine, key);
    }
  } else {
    return declined;
  }
  searchCommand(dataDir, 'search.engine', { name: engine });
  return { state: 'done', detail: `quick search uses ${engine}; /keys check search proves it` };
}

export async function servicesStep(
  { dataDir }: { dataDir: string },
  { ask }: ServicesStepDeps
): Promise<{ state: 'done' | 'already'; detail: string }> {
  const youtube = await youtubeStep(dataDir, ask);
  const search = await quickSearchStep(dataDir, ask);
  return {
    state: youtube.state === 'done' || search.state === 'done' ? 'done' : 'already',
    detail: `${youtube.detail}; ${search.detail}`,
  };
}
