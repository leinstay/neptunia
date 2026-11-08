// A turn on the command line (a private chat of the owner, which has no `<channel_directory>`) in which she reads a
// channel by a name she guessed: the places she is told about are the channels the owner's account can view, judged by
// the pull rail against the snapshot of the served root. A private channel and another person's private chat
// stay out of the answer. Labels carry markers (`labels.tools.tools.place`), so the test checks which places were
// listed, never their wording. Synthetic names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin } from '../src/admin.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
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
} from './fixtures/turn-harness.ts';
import { freshWorld, useIface, world } from './fixtures/turn-world.ts';

// The world's interface is the command line's: the chat of the owner's chat answers `cli` as its interface.
useIface('cli');

const withPlaceLabels = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...labels.tools.tools,
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
  assert.ok(told.includes('LINE-MARK c2 herbs') && told.includes('LINE-MARK c1 general'), told);
  assert.equal(told.includes('staff room'), false, 'a private channel stays out');
  assert.equal(told.includes('someone elses chat'), false, "another person's private chat stays out");
});
