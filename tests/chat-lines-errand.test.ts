// The recent lines an errand agent is given (src/memory/db/chat-lines.ts#errandRecentLines): the channel's newest
// stored lines, oldest first, each with its author and its text as the other readers of stored lines render it. A
// custom emoji or a sticker stands under its stable name, and the legend `<media>` before the lines says what each one
// is. Every other media item carries its kind's marker with its text form. Synthetic lines on a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOfPerson } from '../src/memory/db/direct-chats.ts';
import { errandRecentLines } from '../src/memory/db/chat-lines.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import {
  ALICE,
  GENERAL,
  KINDS,
  LABELS,
  PRESENCES,
  assertForms,
  fixture,
  itemsOf,
  observeLine,
} from './fixtures/media-memory.ts';

// Bug (second production audit, N2): an errand's recent lines held `:e23:` with no legend, a sticker's description
// with no name, and every media description joined after the text with a space, with no kind and no boundary.
for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    test(`errand lines: a ${kind.name} shows its marker and its text form, ${presence}`, () => {
      const env = fixture();
      try {
        observeLine(env, kind, presence);
        fillEnvAudiences(env);
        const lines = errandRecentLines(env.db, GENERAL, 5, { selfName: 'Self', labels: LABELS });
        assert.equal(lines.length, 1);
        assertForms(lines.map((line) => line.text).join('\n'), kind, presence);
      } finally {
        env.done();
      }
    });
  }
}

test('errand lines: a line of hers carries her name and a line of a member the name the member wrote under', () => {
  // Bug: a reworked reader loses who said what, and the agent reads her words as a member's.
  const env = fixture();
  try {
    observeLine(env, KINDS[0], 'full', { native: 'theirs', at: Date.parse('2026-11-01T10:00:00.000Z') });
    const voiceSaid = KINDS.find((kind) => kind.self);
    assert.ok(voiceSaid);
    observeLine(env, voiceSaid, 'full', { native: 'hers', at: Date.parse('2026-11-01T10:01:00.000Z') });
    fillEnvAudiences(env);
    const lines = errandRecentLines(env.db, GENERAL, 5, { selfName: 'Self', labels: LABELS });
    assert.deepEqual(
      lines.map((line) => line.author),
      ['Alice', 'Self']
    );
  } finally {
    env.done();
  }
});

test('errand lines: a picture she made shows the made mark and the people it shows by handle', () => {
  // Bug: the agent reads her drawing as anyone's picture and cannot tell who is in it.
  const env = fixture();
  try {
    observeLine(env, KINDS[0], 'full');
    const alice = String(env.db.prepare('SELECT person_id FROM accounts WHERE native_id = ?').get(ALICE)?.person_id);
    env.db
      .prepare("UPDATE media SET extra = json_set(extra, '$.made', 'self', '$.depicts', json(?)) WHERE native_ref = ?")
      .run(JSON.stringify(['person:self', alice]), itemsOf(KINDS[0], 'pic')[0].id);
    fillEnvAudiences(env);
    const labels = {
      ...LABELS,
      transcript: {
        ...LABELS.transcript,
        mediaMade: '[MADE]',
        mediaDepicts: '[SHOWS {names}]',
        mediaDepictsSelf: 'HERSELF',
      },
    };
    const text = errandRecentLines(env.db, GENERAL, 5, { selfName: 'Self', labels })
      .map((line) => line.text)
      .join('\n');
    assert.ok(text.includes('[MADE]'), text);
    // The owner's ruling (2026-11-18): a person is written by the handle she can pass to a tool, never by a name.
    assert.ok(text.includes(`[SHOWS HERSELF, @${handleOfPerson(alice)}]`), text);
  } finally {
    env.done();
  }
});
