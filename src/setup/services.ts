// The services step of `neptunia setup` (src/setup/run.ts): the optional YouTube Data API key, offered with the link
// that says how to get one. The other service keys belong to quick search and are set with `/keys service`.

import { SERVICES, writeService } from '../keys/services.ts';
import { serviceCredential } from '../keys/file.ts';

export type ServicesStepDeps = {
  ask: (question: string, offered: string | null, options?: { secret: boolean }) => Promise<string>;
};

export async function servicesStep(
  { dataDir }: { dataDir: string },
  { ask }: ServicesStepDeps
): Promise<{ state: 'done' | 'already'; detail: string }> {
  if (serviceCredential(dataDir, 'youtube') !== null) return { state: 'already', detail: 'the YouTube key is set' };
  const answer = (await ask(`${SERVICES.youtube}. Optional, empty skips it:`, null, { secret: true })).trim();
  if (answer === '') return { state: 'already', detail: 'no YouTube key; /keys service set youtube adds it later' };
  writeService(dataDir, 'youtube', answer);
  return { state: 'done', detail: 'the YouTube key is stored' };
}
