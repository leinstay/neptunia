// Which places a read call may name or be told about (src/behavior/readable-places.ts#readablePlaces). The rule is the
// pull rail's (`checkPull`): a channel the persona can read whose audience the destination's viewers all share, and in
// a private chat or on the command line one its partner can view. A channel a reader may not see is never matched and
// never listed. Synthetic names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import { readablePlaces } from '../../../src/behavior/readable-places.ts';
import { snapshotOf } from '../../../src/behavior/snapshot.ts';
import { channel, privateChannel } from '../../fixtures/reads-rig.ts';
import { createAdmin } from '../../../src/admin.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { labels } from '../../fixtures/labels.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import {
  DISCORD,
  NOW,
  appended,
  contentText,
  createTurnRunner,
  fakeStore,
  hotWith,
  normalizedTrigger,
  personaGrants,
  sequenceLlm,
} from '../../fixtures/turn-harness.ts';
import { freshWorld, useIface, world } from '../../fixtures/turn-world.ts';

const OWNER = 'u-owner';
const OTHER = 'u-other';
const CONFIG = { context: { pull: { sameAudience: true } } };

const general = channel('c1', { name: '💬 general' });
const herbs = channel('c2', { name: '🌿 herbs' });
const staff = privateChannel('c3', ['u-mod']);
const blind = channel('c4', { name: 'blind', permissions: { read: false, send: false, attach: false, react: false } });
const named = (info: ChatInfo, name: string): ChatInfo => ({ ...info, name });

/** A private chat of `partner`, the shape of the destination of a DM turn. */
function dmOf(partner: string): ChatInfo {
  return channel('d1', { kind: 'dm', rootId: null, chatType: 'dm', name: 'dm', partnerId: partner, audience: null });
}

/** The same listing seen by `viewer`: `viewers` says which channel the viewer can open. */
function listing(viewer: string): ReadonlyArray<ChatInfo> {
  return [
    { ...general, viewers: { [viewer]: true } },
    { ...herbs, viewers: { [viewer]: true } },
    { ...named(staff, 'staff room'), viewers: { [viewer]: false } },
    { ...blind, viewers: { [viewer]: true } },
    // Another person's private chat, which the persona has open and the viewer does not.
    {
      ...dmOf(OTHER),
      id: 'd2',
      name: 'dm with someone else',
      viewers: { [viewer]: false, [OTHER]: true },
    },
  ];
}

const namesOf = (places: ReadonlyArray<{ name: string }>): Array<string> => places.map((place) => place.name).sort();

test('in a group lists the channels the persona reads and everyone there can see, and no private one', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({ snapshot, destination: general, config: CONFIG });
  assert.deepEqual(namesOf(places), ['🌿 herbs', '💬 general']);
});

test('in a group never lists the private channel, a channel the persona cannot read or a private chat', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const ids = readablePlaces({ snapshot, destination: general, config: CONFIG }).map((place) => place.id);
  for (const hidden of ['c3', 'c4', 'd2']) assert.equal(ids.includes(hidden), false, hidden);
});

test('carries the handle of the request for each place that has one', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({
    snapshot,
    destination: general,
    config: CONFIG,
    handles: new Map([['cg2', 'c2']]),
  });
  assert.equal(places.find((place) => place.id === 'c2')?.handle, 'cg2');
  assert.equal(places.find((place) => place.id === 'c1')?.handle, null);
});

test('in a private chat lists the channels its partner can view and nothing else', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({ snapshot, destination: dmOf(OWNER), partnerId: OWNER, config: CONFIG });
  assert.deepEqual(namesOf(places), ['🌿 herbs', '💬 general']);
});

test('in a private chat never lists the private channel or the private chat of another person', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const ids = readablePlaces({ snapshot, destination: dmOf(OWNER), partnerId: OWNER, config: CONFIG }).map(
    (place) => place.id
  );
  assert.equal(ids.includes('c3'), false, 'the staff room, closed to this partner');
  assert.equal(ids.includes('d2'), false, "another person's private chat");
});

test('in a private chat judges by the partner: a channel closed to this partner stays hidden though the persona reads it', () => {
  const closedToOther = snapshotOf('g1', { chats: listing(OTHER), groups: [] });
  const places = readablePlaces({
    snapshot: closedToOther,
    destination: dmOf(OWNER),
    partnerId: OWNER,
    config: CONFIG,
  });
  assert.deepEqual(places, [], 'the listing has no view of the owner, so no channel is shown to the owner');
});

test('lists nothing in a private chat with no partner', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  assert.deepEqual(readablePlaces({ snapshot, destination: dmOf(OWNER), partnerId: null, config: CONFIG }), []);
});

test('lists nothing when there is no snapshot of the root', () => {
  assert.deepEqual(readablePlaces({ snapshot: null, destination: general, config: CONFIG }), []);
});

test('on the command line lists the channels the owner can view, never a closed one or a private chat', () => {
  const cli: ChatInfo = { ...dmOf(OWNER), id: 'cli:dm:owner', iface: 'cli', name: 'owner' };
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const places = readablePlaces({ snapshot, destination: cli, partnerId: OWNER, config: CONFIG });
  assert.deepEqual(namesOf(places), ['🌿 herbs', '💬 general']);
});

// The world's interface is the command line's: the chat of the owner's chat answers `cli` as its interface.
useIface('cli');

const toolLabels = labels.tools;
const withPlaceLabels = {
  ...labels,
  tools: {
    ...toolLabels,
    tools: {
      ...toolLabels.tools,
      place: {
        several: 'SEVERAL-MARK {given} {count}',
        none: 'NONE-MARK {given}',
        line: 'LINE-MARK {ref} {name}',
        more: 'MORE-MARK {count}',
      },
    },
  },
};

/** The owner's account on the root's interface, who the command line reads as (the turn runner's `ownerAccount`). */
const OWNER_ACCOUNT = 'u1';

const STRANGER = 'u9';

async function readFromCli(channel: string): Promise<string> {
  const hot = hotWith({
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['conversation.read']),
  });
  Object.assign(hot.prompts, { labels: withPlaceLabels });
  freshWorld();
  const viewable = { [OWNER_ACCOUNT]: true };
  const closed = { [OWNER_ACCOUNT]: false };
  world().channel({ id: 'c1', name: 'general', placeId: 'g1', viewers: viewable });
  world().channel({ id: 'c2', name: 'herbs', placeId: 'g1', viewers: viewable });
  world().channel({ id: 'c3', name: 'staff room', placeId: 'g1', public: false, viewers: closed });
  world().channel({ id: 'd2', dm: true, partnerId: STRANGER, extra: { name: 'someone elses chat' }, viewers: closed });
  const raw = {
    id: 'm1',
    placeId: 'cli:dm:owner',
    channelId: 'cli:dm:owner',
    author: { id: 'owner', bot: false, globalName: 'Owner', username: 'owner' },
    member: { displayName: 'Owner' },
    cleanContent: 'what is in the herb channel',
    createdTimestamp: NOW - 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
  const cli = world().channel({
    id: 'cli:dm:owner',
    dm: true,
    partnerId: 'owner',
    historyMessages: [raw],
    extra: { name: 'owner' },
  });
  const store = fakeStore();
  const port = world().port;
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client: { user: { id: 'self-id', username: 'Bot' } },
    isServedRoot: (id: unknown) => id === 'g1',
    reads: world().adopt(port),
    port,
  });
  const llm = sequenceLlm([toolAnswer('', [call('conversation.read', { place: channel })]), '<skip/>']);
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (value: number) => value, observe: () => {} },
    client: { user: { id: 'self-id', username: 'Bot' } },
    now: () => NOW,
    port,
    skills: skillRegistry(),
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    ownerAccount: () => OWNER_ACCOUNT,
  });
  await turns.runTurn({
    channel: cli,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  return appended(llm, 1)
    .filter((message) => message.role === 'tool')
    .map((message) => contentText(message.content))
    .join('\n');
}

test('on the command line a read of an unknown name lists the channels the owner can view and no other', async () => {
  const told = await readFromCli('memes');
  assert.ok(told.includes('NONE-MARK memes'), told);
  // A choice is `#handle name`, or its name once when this request gives it no
  // handle, and never its place id.
  for (const [name, id] of [
    ['herbs', 'c2'],
    ['general', 'c1'],
  ]) {
    const line = told.split('\n').find((one) => one.startsWith('LINE-MARK') && one.includes(name)) ?? '';
    assert.equal(line.split(name).length - 1, 1, line);
    assert.equal(new RegExp(`\\b${id}\\b`).test(line), false, line);
  }
  assert.equal(told.includes('staff room'), false, 'a private channel stays out');
  assert.equal(told.includes('someone elses chat'), false, "another person's private chat stays out");
});
