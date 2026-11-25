import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseConfig,
  fakeChannel,
  fakeGuild,
  fakeMessage,
  fakeStore,
  fakeTurns,
  makeHandler,
  mutableNow,
} from '../../fixtures/events-rig.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

useIface('fake');
useSelf('self1');

// ---- participation: a member's line right after the persona's own ----------------------------

/** A store with the participation store, one episode in c1 whose own line is at `ownAt`. */
function participationEventsStore(ownAt: number) {
  let value = {
    nextId: 2,
    episodes: [
      {
        id: 'p1',
        placeId: 'c1',
        continues: null,
        messages: [
          {
            id: 'own1',
            ts: ownAt,
            authorId: 'self1',
            name: 'Ζωή',
            self: true,
            text: 'ναι',
            replyTo: null,
            caption: null,
          },
        ],
      },
    ],
  };
  const writes: Array<Untyped> = [];
  const reads: Array<Untyped> = [];
  return {
    ...fakeStore(),
    writes,
    reads,
    current: () => value,
    getParticipation: () => {
      reads.push(1);
      return structuredClone(value);
    },
    setParticipation: (placeId: string, state: Untyped, opts: Record<string, Untyped>) => {
      writes.push({ placeId, opts });
      value = structuredClone(state);
    },
  };
}

test('onMessage: a member line soon after the persona spoke joins the participation episode of the persona, once', async () => {
  const ownAt = Date.UTC(2026, 9, 10, 12, 0, 0);
  const store = participationEventsStore(ownAt);
  const turns = { ...fakeTurns(), lastPostAt: () => ownAt };
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild);
  const now = mutableNow(ownAt + 60_000);
  const handler = makeHandler({
    store,
    turns,
    now,
    config: baseConfig({ participation: { followMinutes: 10, linesAfter: 1 } }),
  });
  const { logs } = await withCapturedLogs(async () => {
    await handler(
      fakeMessage({
        id: 'f1',
        guild,
        channel,
        placeId: 'c1',
        createdTimestamp: ownAt + 60_000,
        cleanContent: 'ευχαριστώ',
      })
    );
    await handler(
      fakeMessage({
        id: 'f2',
        guild,
        channel,
        placeId: 'c1',
        createdTimestamp: ownAt + 90_000,
        cleanContent: 'και κάτι ακόμα',
      })
    );
  });
  assert.equal(store.writes.length, 1, 'the second line is past linesAfter: nothing changes, nothing is written');
  const firstEpisode = store.current().episodes[0];
  assert.deepEqual(
    firstEpisode.messages.map((m) => m.id),
    ['own1', 'f1']
  );
  const firstEpisode2 = store.current().episodes[0];
  const secondMessage = firstEpisode2.messages[1];
  assert.equal(secondMessage.name, 'User');
  const firstWrite = store.writes[0];
  assert.equal(firstWrite.opts.now, ownAt + 60_000);
  const recorded = logs.filter((l) => l.msg === 'participation: recorded');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].following, true);
  assert.ok(!JSON.stringify(logs).includes('ευχαριστώ'), 'no text in the logs');
});

test('onMessage: no recent own post, a bot or the diary channel never touch the participation store', async () => {
  const ownAt = Date.UTC(2026, 9, 10, 12, 0, 0);
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild);
  const line = (extra = {}) =>
    fakeMessage({ id: 'f1', guild, channel, placeId: 'c1', createdTimestamp: ownAt + 60_000, ...extra });

  const stale = participationEventsStore(ownAt);
  await withCapturedLogs(() =>
    makeHandler({ store: stale, turns: { ...fakeTurns(), lastPostAt: () => ownAt - 3_600_000 } })(line())
  );
  assert.equal(stale.reads.length, 0, 'the persona has not posted here lately: the store is not even read');

  const bot = participationEventsStore(ownAt);
  await withCapturedLogs(() =>
    makeHandler({ store: bot, turns: { ...fakeTurns(), lastPostAt: () => ownAt } })(
      line({ author: { id: 'b9', bot: true, globalName: 'Bot', username: 'bot' } })
    )
  );
  assert.equal(bot.writes.length, 0);

  const diary = participationEventsStore(ownAt);
  await withCapturedLogs(() =>
    makeHandler({
      store: diary,
      turns: { ...fakeTurns(), lastPostAt: () => ownAt },
      config: baseConfig({ diary: { placeId: 'c1' } }),
    })(line())
  );
  assert.equal(diary.writes.length, 0);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['owner1']);
