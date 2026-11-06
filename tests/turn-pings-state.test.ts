// What a turn hands the interface when it posts, given the ping state of the people the message concerns
// (store.getPings, src/behavior/turn.ts through src/turn/act.ts). A message concerns the author of the line it replies
// to and every member it names with an exact @handle; a reply to nobody and a text that names nobody concern no one.
// `mentions.notify` is true only when the message concerns someone and every one of them has the state `on`. A member
// with `off` is never in `users` and never gets `repliedUser`, whatever the other states are. A member with no state
// leaves `notify` unset, so the interface switch decides. A private chat has no ping state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf } from '../src/behavior/handles.ts';
import { freshWorld } from './fixtures/turn-world.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import {
  NOW,
  fakeClient,
  fakeHot,
  fakeLlm,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from './fixtures/turn-kit.ts';
import { createDiscordAdapter, createDiscordInterface } from '../interfaces/discord/index.ts';
import type { Mentions } from '../src/protocol/index.ts';

const DISCORD = createDiscordInterface().capabilities;
// The mention handles of the two authors of the chat below: Alice's line is the trigger, Bob's the older line.
const ALICE = `@${handleOf('u1')}`;
const BOB = `@${handleOf('u2')}`;

type State = 'on' | 'off';

/** fakeStore with the states of the members of g1, handed out by `getPings` alone. */
function storeWith(states: Record<string, State>) {
  const store = fakeStore();
  const asked: Array<[string, string]> = [];
  Object.assign(store, {
    getPings: (placeId: string, accountId: string): State | null => {
      asked.push([placeId, accountId]);
      return states[accountId] ?? null;
    },
  });
  return { store, asked };
}

/** One reply turn in c1: Bob's older line, then Alice's trigger. The mentions of the one message she sent. */
async function mentionsOfAnswer(states: Record<string, State>, answer: string, dm = false): Promise<Mentions> {
  const world = freshWorld();
  const bob = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'ola' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [bob, raw], ...(dm ? { dm: true } : {}) });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: fakeHot({}),
    store: storeWith(states).store,
    llm: fakeLlm(answer),
    calibrator: identityCalibrator(),
    client: fakeClient(),
  });
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');
  const sends = world.port.calls.filter((call) => call.op === 'send');
  assert.equal(sends.length, 1);
  return (sends[0]?.args[1] as { mentions?: Mentions }).mentions ?? { users: [], repliedUser: false };
}

const notifies = (mentions: Mentions): boolean => mentions.notify === true;

test('a reply to a member with on notifies: notify is true and the reply ping is requested', async () => {
  // Bug: the turn never says the member asked for pings, and the silent switch of the interface wins over them.
  const mentions = await mentionsOfAnswer({ u1: 'on' }, `<msg reply="#2">ναι</msg>`);
  assert.equal(notifies(mentions), true);
  assert.equal(mentions.repliedUser, true);
  assert.deepEqual(mentions.users, []);
});

test('a named member with on notifies when the message replies to nobody', async () => {
  // Bug: only the replied author is counted as concerned, and a mention alone cannot carry the member's wish.
  const mentions = await mentionsOfAnswer({ u2: 'on' }, `<msg>${BOB} ναι</msg>`);
  assert.equal(notifies(mentions), true);
  assert.deepEqual(mentions.users, ['u2']);
});

test('every concerned member with on: the replied author and a named member together notify', async () => {
  // Bug: the turn counts only the first concerned member, and a pair who both chose on gets a silent message.
  const mentions = await mentionsOfAnswer({ u1: 'on', u2: 'on' }, `<msg reply="#2">${BOB} ναι</msg>`);
  assert.equal(notifies(mentions), true);
  assert.deepEqual(mentions.users, ['u2']);
  assert.equal(mentions.repliedUser, true);
});

test('a concerned member with no state keeps notify off even when the other one has on', async () => {
  // Bug: one `on` is enough to drop the flag, and a member who never chose is pinged because of someone else.
  const mentions = await mentionsOfAnswer({ u1: 'on' }, `<msg reply="#2">${BOB} ναι</msg>`);
  assert.equal(notifies(mentions), false);
  assert.deepEqual(mentions.users, ['u2'], 'the named member is still named, the switch decides whether it notifies');
});

test('a concerned member with off is never pinged and the message does not notify, whoever else is on', async () => {
  // Bug: an `on` beside an `off` drops the flag, and the member who turned pings off is pinged by a message to two.
  const mentions = await mentionsOfAnswer({ u1: 'on', u2: 'off' }, `<msg reply="#2">${BOB} ναι</msg>`);
  assert.equal(notifies(mentions), false);
  assert.deepEqual(mentions.users, [], 'Bob is left out of users');
  assert.equal(mentions.repliedUser, true, 'Alice has on and is still replied to with a ping');
});

test('a replied author with off gets no reply ping, with the other member on', async () => {
  // Bug: the reply ping is decided by the named members alone, and the member with off is pinged by the reply.
  const mentions = await mentionsOfAnswer({ u1: 'off', u2: 'on' }, `<msg reply="#2">${BOB} ναι</msg>`);
  assert.equal(notifies(mentions), false);
  assert.equal(mentions.repliedUser, false);
  assert.deepEqual(mentions.users, ['u2']);
});

test('a message that concerns nobody does not notify, however many members have a state', async () => {
  // Bug: "every concerned member is on" is true of an empty set, and a plain message in a silent server pings the channel.
  const mentions = await mentionsOfAnswer({ u1: 'on', u2: 'on' }, `<msg>ναι</msg>`);
  assert.equal(notifies(mentions), false);
  assert.deepEqual(mentions.users, []);
});

test('with nobody holding a state the mentions are as before and notify is unset', async () => {
  // Bug: the new field is set for everyone, and the interface switch no longer decides.
  const mentions = await mentionsOfAnswer({}, `<msg reply="#2">${ALICE} ${BOB} ναι</msg>`);
  assert.equal(notifies(mentions), false);
  assert.deepEqual(mentions.users, ['u1', 'u2']);
  assert.equal(mentions.repliedUser, true);
});

test('a private chat has no ping state: a reply there does not notify through it', async () => {
  // Bug: the state of a member in a server decides the DM, and an `off` or `on` there leaks across places.
  const mentions = await mentionsOfAnswer({ u1: 'on' }, `<msg reply="#2">ναι</msg>`, true);
  assert.equal(notifies(mentions), false);
});
