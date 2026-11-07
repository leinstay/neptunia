// She keeps knowing her diary once `diary.placeId` is only a seed (stage 3 design, section 5): with an enabled `selfreflection`
// mirror on a place and no `diary.placeId` in the config, an ordinary turn treats that place as her diary the way it
// treats the configured channel. A reply's `<memory>` marks every mirrored place it shows with
// `labels.memory.selfreflection`, and a turn in it keeps no participation. Real turn runner, real store over a memory
// database, fake interface, scripted model. Synthetic text only.
import { placeOfCommunity } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { GUILD, replyTurn } from './fixtures/selfreflection-awareness.ts';
import { labels } from './fixtures/labels.ts';

/** The entry of the place named `name` in `<memory>`'s `<places>`: from its heading to the next blank line. */
function placeEntryOf(request: unknown, name: string): string {
  const user = (request as Array<{ content: unknown }>)[1]?.content;
  const places = /<places>\n([\s\S]*?)\n<\/places>/.exec(userText(user))?.[1] ?? '';
  const entry = places.split('\n\n').find((one) => new RegExp(`&gt; ${name} \\(`).test(one.split('\n')[0] ?? ''));
  assert.ok(entry, `<memory> shows ${name}`);
  return entry;
}

const marked = (entry: string): boolean => entry.split('\n').includes(labels.memory.selfreflection);

// Slice 4: "a turn marks the mirrored place as her diary in <server>, byte for byte as diary.placeId did" asserted the
// recorded `<server>` block, which a reply on the frame no longer has. The mark moved to the place's `<memory>` entry.
test('a reply marks the mirrored place as her diary in <memory>, and no other place', async () => {
  // Bug: the mirror is read but the mark is lost with `<server>`, so she speaks of her own diary as a stranger's room.
  const { request } = await replyTurn({ here: 'c1', mirrors: ['d1'] });
  assert.deepEqual(
    ['journal', 'notes', 'general'].map((name) => marked(placeEntryOf(request, name))),
    [true, false, false]
  );
});

test('a turn in the mirrored place keeps no participation there', async () => {
  const { store } = await replyTurn({ here: 'd1', mirrors: ['d1'] });
  // The store is JS; its participation unit holds the episodes of every channel.
  const episodes = (
    store.getParticipation(placeOfCommunity(store, GUILD, 'fake')) as { episodes: Array<{ placeId: string }> }
  ).episodes;
  assert.deepEqual(
    episodes.filter((episode) => episode.placeId === 'd1'),
    []
  );
});

// She cannot write in a mirror place at all (stage 3 design, section 9): the refusal, the event that opens no turn and
// the publisher that still writes there are tests/selfreflection-mirror-guard.test.ts.

// Slice 4: on the frame the places of a reply are `<memory>`'s, so the mark is asserted there instead of in `<server>`.
test('with two mirrors both places carry the diary mark in <memory>', async () => {
  const { request } = await replyTurn({ here: 'c1', mirrors: ['d1', 'd2'] });
  assert.deepEqual(
    ['journal', 'notes', 'general'].map((name) => marked(placeEntryOf(request, name))),
    [true, true, false]
  );
});
