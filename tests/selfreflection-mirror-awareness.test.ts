// She keeps knowing her diary once `diary.placeId` is only a seed (stage 3 design, section 5): with an enabled `selfreflection`
// mirror on a place and no `diary.placeId` in the config, an ordinary turn treats that place as her diary the way it
// treats the configured channel. A reply's `<memory>` marks every mirrored place it shows with
// `labels.memory.selfreflection`, and a turn in it keeps no participation. Real turn runner, real store over a memory
// database, fake interface, scripted model. Synthetic text only.
import { placeOfRoot } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { ROOT, replyTurn, replyTurns } from './fixtures/selfreflection-awareness.ts';
import { dbOf } from './fixtures/selfreflection-mirror.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { labels } from './fixtures/labels.ts';

/** The entry of the place named `name` in `<memory>`'s `<places>`: from its heading to the next blank line. */
function placeEntryOf(request: unknown, name: string): string {
  const user = (request as Array<{ content: unknown }>)[1]?.content;
  const places = /<places>\n([\s\S]*?)\n<\/places>/.exec(userText(user))?.[1] ?? '';
  // The owner's decision of 2026-11-11 (a place reads in words): the entry's heading holds the name in quotes, no `>`.
  const entry = places.split('\n\n').find((one) => (one.split('\n')[0] ?? '').includes(`"${name}"`));
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
    store.getParticipation(placeOfRoot(store, ROOT, 'fake')) as { episodes: Array<{ placeId: string }> }
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

// The owner, 2026-11-11 (plan 2026-11-10 tools-and-reads, item 14): the entry of a mirror's place says so wherever it is
// rendered, so she stops aiming at it before any refusal. The mark is `labels.memory.selfreflection`, the one `<places>`
// carries, in the result of `memory.read` too.

/** The text of the last tool result a request carries, '' when it carries none. */
function lastResultOf(request: unknown): string {
  const results = (request as Array<{ role: string; content: unknown }>).filter((message) => message.role === 'tool');
  const content = results.at(-1)?.content;
  return typeof content === 'string' ? content : userText(content);
}

/** The request after her `memory.read` of the place named `subject`, in a reply in `c1` with the mirror on `d1`. */
async function afterReadOf(subject: string): Promise<string> {
  const { requests } = await replyTurns({
    here: 'c1',
    mirrors: ['d1'],
    steps: [{ answers: [toolAnswer('<think>x</think>', [call('memory.read', { subject })]), '<msg>γεια</msg>'] }],
  });
  const result = lastResultOf(requests[1]);
  assert.match(result, /<places>/, `memory.read answered with the entry of ${subject}`);
  return result;
}

test('memory.read of the mirrored place carries the diary mark in its entry', async () => {
  // Bug: <places> marks the place as her diary, and her own read of the same place shows it as any room, so she aims an
  // intention or a post at it and is refused there.
  const result = await afterReadOf('journal');
  assert.ok(result.split('\n').includes(labels.memory.selfreflection), result);
});

test('memory.read of a place that is no mirror carries no diary mark', async () => {
  const result = await afterReadOf('notes');
  assert.ok(!result.split('\n').includes(labels.memory.selfreflection), result);
});

test('a place whose mirror is disabled loses the diary mark in <memory> at the next request', async () => {
  const { requests } = await replyTurns({
    here: 'c1',
    mirrors: ['d1'],
    steps: [
      { answers: ['<msg>γεια</msg>'] },
      {
        before: (memoryDb) => {
          dbOf(memoryDb).prepare('UPDATE mirrors SET enabled = 0').run();
        },
        answers: ['<msg>γεια</msg>'],
      },
    ],
  });
  assert.deepEqual(
    [marked(placeEntryOf(requests[0], 'journal')), marked(placeEntryOf(requests[1], 'journal'))],
    [true, false]
  );
});
