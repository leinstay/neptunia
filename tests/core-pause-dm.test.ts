// A line that arrives while paused (src/behavior/core-pause.ts) is judged by its own chat: a core with no home
// root still observes the owner's chat and a served group, and a direct chat's record names no root it does
// not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeWhilePaused } from '../src/behavior/core-pause.ts';
import type { PausedDeps } from '../src/behavior/core-pause.ts';

type Observed = { direct: boolean; where: { placeId?: string | null; privateAccountId?: string } };

async function observe(
  event: object,
  home: string | null,
  served: ReadonlyArray<string> = []
): Promise<Array<Observed>> {
  const seen: Array<Observed> = [];
  const deps: PausedDeps = {
    hot: {},
    sharedPlaceOf: (chat: never) => {
      const { rootId, id } = chat as { rootId: string | null; id: string };
      return rootId ?? id;
    },
    isServed: (id) => typeof id === 'string' && served.includes(id),
    selfIdOf: () => 'self',
    observeLine: (_event, direct, where) => {
      seen.push({ direct, where });
      return Promise.resolve();
    },
  };
  await observeWhilePaused(event, deps);
  return seen;
}

const line = (iface: string, chat: object, author = 'u1'): object => ({
  kind: 'message.received',
  iface,
  chat,
  message: { id: 'm1', author: { id: author, name: 'Eleni', self: false, bot: false } },
  addressing: { mentioned: false },
});
const OWNER_CHAT = line('cli', { id: 'cli:dm:owner', kind: 'dm', rootId: null, partnerId: 'owner' }, 'owner');

test('the owner chat is observed while paused on a core with no root', async () => {
  // Bug: the home root is required before the line's kind is looked at, so the owner's words are lost.
  const seen = await observe(OWNER_CHAT, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.direct, true);
  // A private chat is its own place.
  assert.equal(seen[0]?.where.placeId, 'cli:dm:owner');
});

test('the owner chat while paused does not take the home root of an interface', async () => {
  // Bug: the owner's private line is recorded under a root the chat has nothing to do with.
  const seen = await observe(OWNER_CHAT, 'home-of-first');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.where.placeId, 'cli:dm:owner');
});

test('a group line of a served root is observed under it while the core has no home root', async () => {
  // Bug: a second interface's root is unobserved during a pause when no home root resolved.
  const group = line('other', { id: 'c1', kind: 'channel', rootId: 'g3' });
  const seen = await observe(group, null, ['g3']);
  assert.deepEqual(seen, [{ direct: false, where: { placeId: 'g3' } }]);
});
