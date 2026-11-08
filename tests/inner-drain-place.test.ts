// Where the drain (src/behavior/inner/drain.ts) runs an inner turn on the template of the turn frame (plan
// 2026-11-06-turn-frame, slice 5 (a) and (h)): a service has no chat, so the heartbeat runs with
// `chat: null` and no stand-in; an intention runs in its place when it has one and nowhere when it has none; a
// due intention whose place is gone wakes her nowhere with the failure in its wake and keeps the intention. The shape
// the specifier chose: the turn runner is handed `chat: null`, and the code of the failed place travels in the
// wake the turn gets (`inner.wake`), where `<feedback>` reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatWake } from '../src/behavior/inner.ts';
import { CODE } from '../src/tools/codes.ts';
import { NOW, clock, hotWith, intention, setup } from './fixtures/inner-rig.ts';
import type { FakeIntention, SetupOptions } from './fixtures/inner-rig.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { useIface } from './fixtures/turn-world.ts';

useIface('fake');

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** An intention due a minute ago with `destination` as its place, made where no chat was (a heartbeat). */
function placed(id: string, destination: string | null): FakeIntention {
  return wrongly<FakeIntention>({
    ...intention(id),
    destination,
    provenance: { kind: 'self', placeId: null, scope: 'group' },
    origin: 'heartbeat',
  });
}

/** The chat the first turn was handed: null when the key is there and empty, undefined when it is missing. */
function chatOf(params: object | undefined): unknown {
  return params && Object.hasOwn(params, 'chat') ? Reflect.get(params, 'chat') : undefined;
}

test('a heartbeat runs with no chat and no stand-in', async () => {
  // Bug: the heartbeat still rides on a recent room or on the stand-in, and its turn reads that room as a chat.
  clock.t = NOW;
  const run = setup();
  const wake = heartbeatWake(NOW - 60_000);
  assert.deepEqual(run.inner.onWake({ kind: 'inner.wake', at: NOW, id: wake.id, wake }), { status: 'queued' });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  const [params] = calls;
  assert.equal(chatOf(params), null);
  assert.equal(params === undefined ? undefined : Reflect.get(params, 'standIn'), undefined);
});

test('an intention without a place runs with no chat', async () => {
  // Bug: the drain picks a room she spoke in lately, and an intention with no place reads as a reply there.
  clock.t = NOW;
  const run = setup({ records: [placed('i1', null)] });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  assert.equal(chatOf(calls[0]), null);
});

test('a due intention whose place is gone runs nowhere with the failure in its wake, and stays open', async () => {
  // Bug: the wake is dropped and the intention lost, or the drain picks another room on its own.
  clock.t = NOW;
  const records = [placed('i1', 'c9')];
  const run = setup({ records });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  const [params] = calls;
  assert.equal(chatOf(params), null);
  assert.ok(JSON.stringify(params?.inner.wake ?? {}).includes(CODE.UNAVAILABLE), 'the code of the gone place');
  assert.equal(records[0]?.status, 'pending');
});

test("an intention whose place is the command line's chat runs there, found through the command line", async () => {
  // Bug: the drain asks the served interface for `cli:dm:owner`, which knows no such chat, so the turn runs nowhere.
  clock.t = NOW;
  const cliChat = {
    id: 'cli:dm:owner',
    kind: 'dm',
    rootId: null,
    name: 'owner',
    partnerId: 'owner',
    iface: 'cli',
    permissions: { read: true, send: true, attach: true, react: false },
  };
  const client = wrongly<SetupOptions['client']>({
    reads: {
      chatInfo: (chat: { iface: string; chatId: string }) =>
        Promise.resolve(chat.iface === 'cli' && chat.chatId === 'cli:dm:owner' ? { chat: cliChat } : null),
    },
  });
  const hot = wrongly<SetupOptions['hot']>({ config: { ...hotWith().config, dm: { enabled: true } } });
  const run = setup({ records: [placed('i1', 'cli:dm:owner')], client, hot });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  assert.deepEqual(chatOf(calls[0]), { iface: 'cli', chatId: 'cli:dm:owner' });
});

// docs/cli.md under Access: the owner's command line is his own chat and stays open while `dm.enabled` is
// false, so a wake anchored there runs there as his line would.
test("an intention whose place is the command line's chat runs there while direct chats are off", async () => {
  // Bug: the gate let his lines through, yet her reminder in his chat ran nowhere with dm-off.
  clock.t = NOW;
  const cliChat = {
    id: 'cli:dm:owner',
    kind: 'dm',
    rootId: null,
    name: 'owner',
    partnerId: 'owner',
    iface: 'cli',
    permissions: { read: true, send: true, attach: true, react: false },
  };
  const client = wrongly<SetupOptions['client']>({
    reads: {
      chatInfo: (chat: { iface: string; chatId: string }) =>
        Promise.resolve(chat.iface === 'cli' && chat.chatId === 'cli:dm:owner' ? { chat: cliChat } : null),
    },
  });
  const hot = wrongly<SetupOptions['hot']>({ config: { ...hotWith().config, dm: { enabled: false } } });
  const run = setup({ records: [placed('i1', 'cli:dm:owner')], client, hot });
  await run.inner.tick();
  await settle();
  const { calls } = run.turns;
  assert.equal(calls.length, 1);
  assert.deepEqual(chatOf(calls[0]), { iface: 'cli', chatId: 'cli:dm:owner' });
});
