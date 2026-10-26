import test from 'node:test';
import assert from 'node:assert/strict';
import { historyLines } from '../src/behavior/lines.ts';
import type { ReactorNames } from '../src/behavior/lines.ts';
import { createReactorStore } from '../src/behavior/reactor-store.ts';
import { refTo, useSelf, world } from './fixtures/turn-world.ts';
import type { Raw } from './fixtures/turn-world.ts';

const SELF = '100';
const GUILD = '900';
useSelf(SELF);

/** A discord.js-shaped message of c1 with a reaction cache. */
function message(id: string, authorId: string, ts: number, reactions: Array<Raw> = []): Raw {
  const name = authorId === SELF ? 'Persona' : 'Zoé';
  return {
    id,
    channelId: 'c1',
    channel: { name: 'general' },
    guild: { id: GUILD },
    author: { id: authorId, bot: false, globalName: name, username: 'u' },
    member: { displayName: name },
    cleanContent: `line ${id}`,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
    reactions: { cache: new Map(reactions.map((reaction, i) => [String(i), reaction])) },
  };
}

function namesOf(store: ReturnType<typeof createReactorStore>): ReactorNames {
  return {
    store,
    budgetMs: 2000,
    fetchUsers: 10,
    known: () => null,
    cache: new Map(),
    selfId: SELF,
    communityId: GUILD,
    log: { info() {}, warn() {}, error() {} },
  };
}

test('historyLines gives the newest lines oldest first', async () => {
  world().channel({
    id: 'c1',
    guildId: GUILD,
    historyMessages: [message('1', '7', 1000), message('2', '7', 2000), message('3', '7', 3000)],
  });
  const lines = await historyLines(world().reads, refTo({ id: 'c1' }), { limit: 2 });
  assert.deepEqual(
    lines.map((line) => line.id),
    ['2', '3']
  );
});

test('historyLines throws when the interface cannot read the history', async () => {
  const held = world().channel({ id: 'c1', guildId: GUILD, historyMessages: [message('1', '7', 1000)] });
  held.failHistory();
  await assert.rejects(historyLines(world().reads, refTo({ id: 'c1' }), { limit: 10 }), /history unavailable/);
});

test('historyLines reads the missing reactors of her lines once and names them like authors', async () => {
  const w = world();
  w.channel({
    id: 'c1',
    guildId: GUILD,
    historyMessages: [
      message('1', '7', 1000, [{ emoji: { name: '👍' }, count: 1, me: false }]),
      message('2', SELF, 2000, [{ emoji: { id: null, name: '😂' }, count: 2, me: false }]),
    ],
  });
  w.member(GUILD, { id: '7', name: 'Zoé', bot: false });
  w.member(GUILD, { id: '8', name: 'helperbot', bot: true });
  w.port.seedReactors({ ...refTo({ id: 'c1' }), messageId: '2' }, '😂', ['7', '8']);
  const reactorReads = () => w.port.calls.filter((call) => call.op === 'reactors');
  const store = createReactorStore();
  const lines = await historyLines(w.reads, refTo({ id: 'c1' }), { limit: 10, names: namesOf(store) });
  assert.deepEqual(
    reactorReads().map((call) => call.args[2]),
    [10],
    'the reactors of her one reaction, at most fetchUsers'
  );
  assert.deepEqual(lines[1]?.reactions[0], {
    emoji: '😂',
    count: 2,
    mine: false,
    users: [
      { id: '7', name: 'Zoé', bot: false },
      { id: '8', name: 'helperbot', bot: true },
    ],
  });
  assert.equal(lines[0]?.reactions[0]?.users, undefined, "someone else's line is left as it is");
  await historyLines(w.reads, refTo({ id: 'c1' }), { limit: 10, names: namesOf(store) });
  assert.equal(reactorReads().length, 1, 'once for a message and an emoji');
});

test('historyLines leaves the reactions as counts when no names are asked for', async () => {
  const w = world();
  w.channel({
    id: 'c1',
    guildId: GUILD,
    historyMessages: [message('2', SELF, 2000, [{ emoji: { id: null, name: '😂' }, count: 2, me: false }])],
  });
  const lines = await historyLines(w.reads, refTo({ id: 'c1' }), { limit: 10 });
  assert.equal(lines[0]?.reactions[0]?.users, undefined);
  assert.equal(w.port.calls.filter((call) => call.op === 'reactors').length, 0);
});
