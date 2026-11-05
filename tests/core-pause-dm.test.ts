// A line that arrives while paused (src/behavior/core-pause.ts) is judged by its own conversation: a core with no home
// community still observes the owner's chat and a served group, and a direct chat's record names no community it does
// not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeWhilePaused } from '../src/behavior/core-pause.ts';
import type { PausedDeps } from '../src/behavior/core-pause.ts';

type Observed = { direct: boolean; where: { guildId?: string | null; privateUserId?: string } };

async function observe(
  event: object,
  home: string | null,
  served: ReadonlyArray<string> = []
): Promise<Array<Observed>> {
  const seen: Array<Observed> = [];
  const deps: PausedDeps = {
    hot: {},
    getGuildId: () => home,
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

const line = (iface: string, conversation: object, author = 'u1'): object => ({
  kind: 'message.received',
  iface,
  conversation,
  message: { id: 'm1', author: { id: author, name: 'Eleni', self: false, bot: false } },
  addressing: { mentioned: false },
});
const OWNER_CHAT = line('cli', { id: 'cli:dm:owner', kind: 'dm', communityId: null, partnerId: 'owner' }, 'owner');

test('the owner chat is observed while paused on a core with no community', async () => {
  // Bug: the home community is required before the line's kind is looked at, so the owner's words are lost.
  const seen = await observe(OWNER_CHAT, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.direct, true);
  assert.equal(seen[0]?.where.privateUserId, 'owner');
  assert.equal(seen[0]?.where.guildId ?? null, null);
});

test('the owner chat while paused does not take the home community of an interface', async () => {
  // Bug: the owner's private line is recorded under a community the chat has nothing to do with.
  const seen = await observe(OWNER_CHAT, 'home-of-first');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.where.guildId ?? null, null);
});

test('a group line of a served community is observed under it while the core has no home community', async () => {
  // Bug: a second interface's community is unobserved during a pause when no home community resolved.
  const group = line('other', { id: 'c1', kind: 'channel', communityId: 'g3' });
  const seen = await observe(group, null, ['g3']);
  assert.deepEqual(seen, [{ direct: false, where: { guildId: 'g3' } }]);
});
