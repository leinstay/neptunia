// Tests for the closing journal record of a persona skill call (journalResultOf): a compact,
// count-only summary of what came back -- the posted message's id, the size of the answer, the
// number of rows of a list -- never the content. Pure; no disk, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { journalResultOf } from '../src/behavior/turn.ts';
import { wrongly } from './fixtures/loose-types.ts';

// The tests hand it whole skill results (skill name and status included), of which it reads `ref` and `data`.
const summaryOf = (result: unknown) => journalResultOf(wrongly(result));

test('journalResultOf: a read skill records the size of its text, not the text', () => {
  const summary = summaryOf({ skill: 'memory.journal.read', status: 'ok', data: { text: 'λόγος '.repeat(10) } });
  assert.deepEqual(summary, { chars: 60 });
  assert.ok(!JSON.stringify(summary).includes('λόγος'));
});

test('journalResultOf: a list records its item count next to the size', () => {
  const rows = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const summary = summaryOf({ skill: 'lore.list', status: 'ok', data: { rows } });
  assert.deepEqual(summary, { chars: JSON.stringify(rows).length, items: 3 });
});

test('journalResultOf: a posted message keeps its id, with the size when the call also answered', () => {
  assert.deepEqual(
    summaryOf({ skill: 'message.create', status: 'ok', ref: { messageId: '99', conversationId: '5' } }),
    { messageId: '99' }
  );
  assert.deepEqual(summaryOf({ skill: 'draw.create', status: 'ok', ref: { messageId: '7' }, data: { text: 'done' } }), {
    messageId: '7',
    chars: 4,
  });
});

test('journalResultOf: no data and no ref is an empty record', () => {
  assert.deepEqual(summaryOf({ skill: 'reaction.add', status: 'ok' }), {});
  assert.deepEqual(summaryOf({ skill: 'reaction.add', status: 'ok', data: { text: '' } }), {});
  assert.deepEqual(journalResultOf(null), {});
});
