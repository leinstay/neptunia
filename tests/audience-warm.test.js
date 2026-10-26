// Tests for interfaces/discord/audience-warm.js: which member overwrite ids need a
// fetch, the sequential fetch loop and its counts, and the warmer that runs
// it over a fake guild (coalesced runs, members who left not asked again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverwriteType } from 'discord.js';
import { overwriteMemberIds, fetchMembers, createAudienceWarmer } from '../src/interface/discord.js';

/** A channel with permission overwrites `{ id, type }`; `null` for a channel without them (a thread). */
function channel(overwrites) {
  if (overwrites === null) return { id: 'thread' };
  return { permissionOverwrites: { cache: new Map(overwrites.map((o) => [o.id, o])) } };
}

const member = (id) => ({ id, type: OverwriteType.Member });
const role = (id) => ({ id, type: OverwriteType.Role });

/** An error shaped like discord.js's DiscordAPIError. */
function apiError(status, code) {
  return Object.assign(new Error(`api ${status}`), { status, code });
}

test('overwriteMemberIds: member overwrite ids across channels, once each, roles and cached members skipped', () => {
  const channels = [
    channel([role('r1'), member('m1'), member('m2')]),
    channel([member('m2'), member('m3'), role('m4')]),
    channel(null),
    channel([member('cached')]),
  ];
  const cached = new Set(['cached', 'm3']);
  assert.deepEqual(
    overwriteMemberIds(channels, (id) => cached.has(id)),
    ['m1', 'm2']
  );
  assert.deepEqual(
    overwriteMemberIds(new Map([['c', channel([member('m1')])]]).values(), () => false),
    ['m1'],
    'any iterable'
  );
  assert.deepEqual(
    overwriteMemberIds(undefined, () => false),
    []
  );
});

test('fetchMembers: fetches one by one and counts fetched, missing and failed without throwing', async () => {
  const order = [];
  let inFlight = 0;
  const outcomes = {
    a: () => ({ id: 'a' }),
    gone: () => {
      throw apiError(404, 10007);
    },
    unknownUser: () => Promise.reject(apiError(404, 10013)),
    nothing: () => null,
    flaky: () => Promise.reject(apiError(500, 0)),
    broken: () => {
      throw new TypeError('boom');
    },
    b: () => Promise.resolve({ id: 'b' }),
  };
  const fetchMember = async (id) => {
    order.push(id);
    inFlight += 1;
    assert.equal(inFlight, 1, 'sequential');
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await outcomes[id]();
    } finally {
      inFlight -= 1;
    }
  };
  const result = await fetchMembers(Object.keys(outcomes), fetchMember);
  assert.deepEqual(order, Object.keys(outcomes));
  assert.deepEqual(result, { fetched: 2, missing: 3, failed: 2, gone: ['gone', 'unknownUser', 'nothing'] });
  assert.deepEqual(await fetchMembers([], fetchMember), { fetched: 0, missing: 0, failed: 0, gone: [] });
});

/** A guild whose members.fetch caches what it finds, like discord.js. */
function fakeGuild({ channels, known = [], cached = [] }) {
  const cache = new Map(cached.map((id) => [id, { id }]));
  const calls = [];
  return {
    calls,
    guild: {
      id: 'g1',
      channels: { cache: new Map(channels.map((c, i) => [`c${i}`, c])) },
      members: {
        cache,
        fetch: async (id) => {
          calls.push(id);
          await new Promise((resolve) => setImmediate(resolve));
          if (!known.includes(id)) throw apiError(404, 10007);
          const found = { id };
          cache.set(id, found);
          return found;
        },
      },
    },
  };
}

function fakeLogger() {
  const lines = [];
  const add = (level) => (msg, meta) => lines.push({ level, msg, meta });
  return { lines, info: add('info'), warn: add('warn'), error: add('error') };
}

test('createAudienceWarmer: fetches the uncached overwrite members, logs counts, never asks again for one who left', async () => {
  const { guild, calls } = fakeGuild({
    channels: [channel([member('bot1'), member('left'), role('r1'), member('me')])],
    known: ['bot1'],
    cached: ['me'],
  });
  const logger = fakeLogger();
  const warmer = createAudienceWarmer({ getGuild: () => guild, logger });
  await warmer.warm();
  assert.deepEqual(calls, ['bot1', 'left']);
  assert.ok(guild.members.cache.has('bot1'), 'the fetched member is in the cache');
  assert.deepEqual(logger.lines, [
    { level: 'info', msg: 'audience: members warmed', meta: { guildId: 'g1', fetched: 1, missing: 1, failed: 0 } },
  ]);

  await warmer.warm({ quiet: true });
  assert.deepEqual(calls, ['bot1', 'left'], 'cached and departed members are not fetched again');
  assert.equal(logger.lines.length, 1, 'a quiet run with nothing to fetch logs nothing');
  await warmer.warm();
  assert.equal(logger.lines.length, 2, 'a run that is not quiet always logs');
});

test('createAudienceWarmer: overlapping runs coalesce into one more pass, each member fetched once', async () => {
  const { guild, calls } = fakeGuild({ channels: [channel([member('m1'), member('m2')])], known: ['m1', 'm2'] });
  const warmer = createAudienceWarmer({ getGuild: () => guild, logger: fakeLogger() });
  await Promise.all([warmer.warm(), warmer.warm({ quiet: true }), warmer.warm({ quiet: true })]);
  assert.deepEqual(calls, ['m1', 'm2']);
});

test('createAudienceWarmer: no guild or a throwing guild never rejects', async () => {
  const logger = fakeLogger();
  await createAudienceWarmer({ getGuild: () => null, logger }).warm();
  const throwing = {
    id: 'g1',
    channels: {
      cache: {
        values: () => {
          throw new Error('boom');
        },
      },
    },
    members: { cache: new Map() },
  };
  await createAudienceWarmer({ getGuild: () => throwing, logger }).warm();
  assert.deepEqual(
    logger.lines.map((line) => [line.level, line.msg]),
    [['warn', 'audience: members warm failed']]
  );
});
