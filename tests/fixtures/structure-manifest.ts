// The tracked structure manifest (structure.json) as typed entries, for the tests that check a rule of the real file.
import { readFileSync } from 'node:fs';

export type ManifestEntry = { path: string; purpose: string; layer: string; imports: Array<string>; test: string };

export function trackedEntries(): Array<ManifestEntry> {
  const text = readFileSync(new URL('../../structure.json', import.meta.url), 'utf8');
  return (JSON.parse(text) as { entries: Array<ManifestEntry> }).entries;
}
