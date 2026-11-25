import { test } from 'node:test';
import assert from 'node:assert/strict';

import { opensPrivate } from '../../../src/memory/open-private.ts';
import { ANSWER, ROOT, SELF, channelInfo, lineEvent, until, withFakeCore } from '../../fixtures/core-over-fake.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';

test("opens the persona's private memory when context.memory.openPrivate is true", () => {
  assert.equal(opensPrivate({ context: { memory: { openPrivate: true } } }), true);
});

test("keeps the persona's private memory split when context.memory.openPrivate is anything but true", () => {
  // Bug: a truthy string from a hand-edited config opens every direct chat to every place.
  for (const value of ['true', 1, false, undefined])
    assert.equal(opensPrivate({ context: { memory: { openPrivate: value } } }), false);
  assert.equal(opensPrivate({}), false);
});

// Public turn context, split-chain merging and private journal boundaries.

// `context.memory.openPrivate` over the whole core and the fake interface: Marta (u2) talks to the persona in the direct chat
// d2, where Marta sets an intention, and the next turn runs in the group chat c1 or in Zoe's (u3) direct chat d3.
const OPEN_AT = Date.now() - 60_000;
const DM_LINE = 'ΜΟΝΟ-ΣΤΟ-ΙΔΙΩΤΙΚΟ';
const DM_INTENTION = 'ΠΡΟΘΕΣΗ-ΤΟΥ-ΙΔΙΩΤΙΚΟΥ';

const fakeMember = (id: string, name: string) => ({
  id,
  name,
  bot: false,
  groupIds: [],
  avatar: { hash: null, url: null, largeUrl: null },
});

/** A message of `authorId` in their direct chat `chatId`, as the fake interface delivers it. */
function dmLine(id: string, chatId: string, authorId: string, text: string, at: number) {
  const event = lineEvent({ id, chatId, text, at, authorId, authorName: authorId });
  return { ...event, chat: { id: chatId, kind: 'dm' as const, rootId: null, name: null, partnerId: authorId } };
}

/** The text of the request of the turn that answers `next` after Marta's direct chat, with the switch at `open`. */
async function requestAfterDm(open: boolean, next: 'group' | 'other-dm'): Promise<string> {
  const { result } = await withFakeCore(
    {
      config: {
        bot: { timezone: 'UTC', access: { 'intention.set': { users: [SELF.id] } } },
        dm: { enabled: true },
        private: { minAffinity: -1000 },
        features: { intentions: true },
        context: { memory: { openPrivate: open } },
      },
      answers: [toolAnswer('', [call('intention.set', { text: DM_INTENTION })]), `<msg>${ANSWER}</msg>`],
      seed: (fake) => {
        fake.seedChat(channelInfo('c1'));
        for (const [id, name] of [
          ['u1', 'Eleni'],
          ['u2', 'Marta'],
          ['u3', 'Zoe'],
        ] as const) {
          fake.seedMember(ROOT.id, fakeMember(id, name));
          fake.seedDmChat(id, `d${id.slice(1)}`);
          fake.seedChat({ ...channelInfo(`d${id.slice(1)}`), kind: 'dm', rootId: null, name: null, partnerId: id });
        }
      },
    },
    async (rig) => {
      const send = async (event: ReturnType<typeof lineEvent>) => {
        rig.fake.seedEvent(event);
        await rig.emit(event);
      };
      // Each partner says a line in the group first, so the private gate knows them.
      await send(lineEvent({ id: 'm0', text: 'καλημέρα', at: OPEN_AT, authorId: 'u2', authorName: 'Marta' }));
      await send(lineEvent({ id: 'm1', text: 'γεια', at: OPEN_AT + 100, authorId: 'u3', authorName: 'Zoe' }));
      await send(dmLine('m2', 'd2', 'u2', DM_LINE, OPEN_AT + 1000));
      await until(() => rig.posted('d2').length > 0);
      const seen = rig.requests.length;
      if (next === 'group') await send(lineEvent({ id: 'm3', text: 'εδώ;', at: OPEN_AT + 5000, mention: true }));
      else await send(dmLine('m3', 'd3', 'u3', 'εδώ;', OPEN_AT + 5000));
      await until(() => rig.requests.length > seen);
      return rig.requestText(rig.requests.length - 1);
    }
  );
  return result;
}

test('with context.memory.openPrivate on, a group turn holds a line and an intention of a direct chat; off, neither', async () => {
  // Bug: the switch opens the persona's memory, but the group request is built from reads still split by place.
  const on = await requestAfterDm(true, 'group');
  assert.deepEqual([on.includes(DM_LINE), on.includes(DM_INTENTION)], [true, true]);
  const off = await requestAfterDm(false, 'group');
  assert.deepEqual([off.includes(DM_LINE), off.includes(DM_INTENTION)], [false, false]);
});

test("with context.memory.openPrivate on, a direct chat's turn holds a line of another person's direct chat; off, not", async () => {
  // Bug: the switch opens a group to the persona's direct chats, but one direct chat stays closed to another.
  assert.equal((await requestAfterDm(true, 'other-dm')).includes(DM_LINE), true);
  assert.equal((await requestAfterDm(false, 'other-dm')).includes(DM_LINE), false);
});
