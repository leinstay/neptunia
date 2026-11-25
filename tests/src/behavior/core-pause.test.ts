// A line that arrives while paused (src/behavior/core-pause.ts) is judged by its own chat: a core with no home
// root still observes the owner's chat and a served group, and a direct chat's record names no root it does
// not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeWhilePaused } from '../../../src/behavior/core-pause.ts';
import type { PausedDeps } from '../../../src/behavior/core-pause.ts';
import {
  ANSWER,
  helloTaken,
  mention,
  postedOnce,
  runCli,
  seenIds,
  settle,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from '../../fixtures/core-units.ts';

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
  const where = seen[0]?.where;
  assert.equal(where?.placeId, 'cli:dm:owner');
});

test('the owner chat while paused does not take the home root of an interface', async () => {
  // Bug: the owner's private line is recorded under a root the chat has nothing to do with.
  const seen = await observe(OWNER_CHAT, 'home-of-first');
  assert.equal(seen.length, 1);
  const where = seen[0]?.where;
  assert.equal(where?.placeId, 'cli:dm:owner');
});

test('a group line of a served root is observed under it while the core has no home root', async () => {
  // Bug: a second interface's root is unobserved during a pause when no home root resolved.
  const group = line('other', { id: 'c1', kind: 'channel', rootId: 'g3' });
  const seen = await observe(group, null, ['g3']);
  assert.deepEqual(seen, [{ direct: false, where: { placeId: 'g3' } }]);
});

test('a paused line of a group is observed by its own chat with no home root reader', async () => {
  // Bug: the pause path needs `getRootId` to tell whether a line is served.
  const seen: Array<{ direct: boolean; where: object }> = [];
  const line = {
    kind: 'message.received',
    iface: 'other',
    chat: { id: 'c1', kind: 'channel', rootId: 'g3' },
    message: { id: 'm1', author: { id: 'u1', name: 'Eleni', self: false, bot: false } },
    addressing: { mentioned: false },
  };
  await observeWhilePaused(line, {
    hot: {},
    isServed: (id) => id === 'g3',
    selfIdOf: () => 'self',
    observeLine: (_event, direct, where) => {
      seen.push({ direct, where });
      return Promise.resolve();
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.direct, false);
  assert.equal('rootId' in (seen[0]?.where ?? {}), false);
});

// The catch-up the resume uses and the pause notice are code, so a call while paused gets the notice, one post
// that is not the persona's answer, and the tests count it among the posts.

// Case 5 of PR D.
test('pause sends the reply already on its way, keeps a message that arrives, and resume starts no turn over it', async () => {
  await withRig({}, async ({ dirs, llm, units, cores, logs }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);

    // The persona's reply to m1 is committed and waits at the interface when the pause comes.
    await unit.ask({ op: 'hold' }, 'done');
    const held = unit.told('held');
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await held;
    const pausing = runCli(dirs, ['-p', '/pause']);
    // The pause reaches the core just after its command line said hello. The short wait after the hello is the one
    // wall-clock bound: a slow run lets the reply go before the pause, which this test then does not catch.
    await until(() => helloTaken(logs, 'cli'), 'the hello of the command line');
    await settle(300);
    await unit.ask({ op: 'release' }, 'done');
    const paused = await pausing;
    assert.equal(paused.code, 0, paused.stderr.slice(-2000));
    assert.deepEqual(await postedOnce(unit, 1), [ANSWER], 'the committed reply went out');

    assert.equal(await (await unit.emit(mention('m2', 'are you still there'))).acked, 'ok');
    const [, notice] = await postedOnce(unit, 2);
    assert.notEqual(notice, ANSWER, 'the pause notice, no answer');
    await settle(600);
    assert.equal(llm.requests.length, 1, 'no turn while paused');
    assert.deepEqual(seenIds(dirs), ['m1', 'm2'], 'the message of the pause is observed');

    const resumed = await runCli(dirs, ['-p', '/resume']);
    assert.equal(resumed.code, 0, resumed.stderr.slice(-2000));
    // There is no catch-up. The kept message stays history, and a resume starts no turn.
    await settle(600);
    assert.equal(llm.requests.length, 1, 'no turn over what arrived while paused');
    assert.deepEqual(await postedOnce(unit, 2), [ANSWER, notice]);
    assert.deepEqual(seenIds(dirs), ['m1', 'm2'], 'the resume observed nothing twice');
  });
});

// Case 6 of PR D.
test('a core restarted while paused stays paused until resume, and the resume starts no turn over what it kept', async () => {
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    const first = await startUnitsCore(dirs, llm);
    cores.push(first);
    const paused = await runCli(dirs, ['-p', '/pause']);
    assert.equal(paused.code, 0, paused.stderr.slice(-2000));
    await first.stop();

    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    const [notice] = await postedOnce(unit, 1);
    assert.notEqual(notice, ANSWER, 'the pause notice, no answer');
    await settle(600);
    assert.equal(llm.requests.length, 0, 'the restarted core is still paused');
    assert.deepEqual(seenIds(dirs), ['m1'], 'the message is observed while paused');

    const resumed = await runCli(dirs, ['-p', '/resume']);
    assert.equal(resumed.code, 0, resumed.stderr.slice(-2000));
    // There is no catch-up. The kept message stays history, and a resume starts no turn.
    await settle(600);
    assert.equal(llm.requests.length, 0, 'no turn over what arrived while paused');
    assert.deepEqual(await unit.posted('c1'), [notice]);
  });
});
