// src/turn/journal-notes.ts: the thinks a new turn carries from the earlier turns of its chat (`earlierThinkFor`). A think
// of a turn that ran in a direct chat and posted into a group is carried into that group's next turn only with
// `context.memory.openPrivate` on. A real think store, no journal, no record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinkStore, placeKey } from '../src/behavior/previous-think.ts';
import { createJournalNotes } from '../src/turn/journal-notes.ts';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const GROUP = { id: 'c1', rootId: 'g1' };

/** The think the group's next turn carries, with the setting `open`. */
function carriedInGroup(open: boolean): string | null {
  const thinks = createThinkStore();
  thinks.record({
    turnId: 't1',
    at: NOW - 60_000,
    think: 'ΣΚΕΨΗ-ΑΠΟ-ΙΔΙΩΤΙΚΗ',
    isDm: true,
    ran: placeKey({ chatId: 'd1' }),
    delivered: [placeKey({ chatId: GROUP.id })],
  });
  const notes = createJournalNotes({
    hot: { config: { context: { previousThinks: 1, memory: { openPrivate: open } } } },
    clock: () => NOW,
    journal: null,
    record: null,
    iface: 'fake',
    facts: () => {
      throw new Error('no facts are read here');
    },
    triggerLinks: new Map(),
    callMarks: [],
    postedFromLinks: new Map(),
    thinks,
    readOffPeriods: () => Promise.resolve([]),
    liveChannelName: () => () => null,
  });
  return notes.earlierThinkFor({ channel: GROUP, isDm: false, draft: {}, mode: 'reply' })?.text ?? null;
}

test('a think of a direct chat posted into a group is carried there only with context.memory.openPrivate on', () => {
  // Bug: the switch that opens her memory leaves her own thoughts from a direct chat behind in every group.
  assert.equal(carriedInGroup(false), null);
  assert.equal(carriedInGroup(true), 'ΣΚΕΨΗ-ΑΠΟ-ΙΔΙΩΤΙΚΗ');
});
