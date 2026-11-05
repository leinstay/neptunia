// How `diagnosticText` (src/behavior/wake.ts) fills `{count}` for a `msgMalformed` diagnostic, which carries three counts
// and no `count` of its own: she must read how many tags were out of place, never zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticText } from '../src/behavior/wake.ts';

const LABELS = { tools: { diagnostics: { msgMalformed: 'out of place: {count}' } } };

test('a msgMalformed diagnostic fills {count} with the sum of its three counts', () => {
  const told = diagnosticText({ kind: 'msgMalformed', nested: 2, unclosed: 1, stray: 3 }, LABELS);
  assert.equal(told, 'out of place: 6');
});

test('a msgMalformed diagnostic kept as a fact of an inner turn fills {count} the same way', () => {
  const told = diagnosticText(
    { kind: 'diagnostic', diagnostic: 'msgMalformed', nested: 1, unclosed: 0, stray: 0 },
    LABELS
  );
  assert.equal(told, 'out of place: 1');
});
