// src/behavior/inner/places.ts: the place index the tick builds from the record's lines. A fake record yields the lines
// the way the record reads the stored rows of an edit from the command line: `said` at the moment she wrote it, then
// the edit as a `seen` line of her account, 93 minutes later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshPlaces } from '../src/behavior/inner/places.ts';
import { innerSettings } from '../src/behavior/inner/settings.ts';
import type { InnerContext } from '../src/behavior/inner/types.ts';

const T0 = Date.parse('2026-11-12T01:00:00Z');
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function line(kind: 'said' | 'seen', revision: number, at: number, by: string | undefined) {
  return {
    kind,
    messageId: 'm1',
    revision,
    occurredAt: iso(at),
    scope: { channel: 'c1' },
    by,
    text: 'the kettle is on',
  };
}

// Guard (green before the fix): when the scan meets both rows of an edited line of hers, the index holds the line once,
// as hers, at the moment she wrote it. The edit's row, which names her account and a later moment, adds nothing.
test('the place index holds her edited line once, as hers, at the moment she said it', async () => {
  const lines = [line('said', 1, T0, undefined), line('seen', 2, T0 + 93 * MINUTE, 'cli:self')];
  const life = {
    placeIndexes: new Map(),
    record: { iterate: () => lines },
    log: { warn() {} },
  } as unknown as InnerContext;
  const index = await refreshPlaces(life, T0 + 120 * MINUTE, innerSettings({}));
  assert.deepEqual(index.places.get('c1')?.lines, [{ id: 'm1', at: T0, by: null, said: true }]);
});
