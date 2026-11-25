// The corpus of a harness run (scripts/lib/harness-corpus.ts): one turn per line as `<group> <turnId>`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCorpus } from '../../../scripts/lib/harness-corpus.ts';

test('reads each line as a group and a turn id, skipping blank lines', () => {
  assert.deepEqual(readCorpus('reply:mention t-1\n\ninner:heartbeat t-2\n'), [
    { group: 'reply:mention', turnId: 't-1' },
    { group: 'inner:heartbeat', turnId: 't-2' },
  ]);
});

test('refuses a line that is not a group and a turn id, naming its number', () => {
  // Catches: a corpus line with a stray word silently replayed as the wrong turn.
  assert.throws(() => readCorpus('reply t-1\nreply t-2 extra\n'), /line 2/);
});
