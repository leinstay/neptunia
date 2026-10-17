// Tests for interfaces/discord/search.js: Discord's message search, member search
// and the window around a message, over a fake REST client and channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAfter, fetchAround, searchMembers, searchMessages } from '../src/interface/discord.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

/** A guild whose REST client records each GET and answers with `answer(route, query)`. */
function fakeGuild(answer) {
  const calls = [];
  const guild = {
    id: 'g1',
    client: {
      rest: {
        get: async (route, options) => {
          calls.push({ route, query: options.query, signal: options.signal });
          return answer(route, options.query);
        },
      },
    },
  };
  return { guild, calls };
}

const raw = (id, extra = {}) => ({
  id,
  channel_id: 'c1',
  timestamp: '2026-10-01T18:44:00.000Z',
  author: { id: 'u1', username: 'ana', global_name: 'Ána', bot: false, avatar: 'x' },
  content: `κείμενο ${id}`,
  embeds: [],
  ...extra,
});

test('searchMessages: sends the query parameters and flattens the nested hit arrays', async () => {
  const { guild, calls } = fakeGuild(() => ({ total_results: 48, messages: [[raw('m1')], [raw('m2'), raw('m1')], [raw('ctx'), raw('m3', { hit: true })]] }));
  const signal = new AbortController().signal;
  const result = await searchMessages(guild, { content: 'κουνέλι', authorId: 'u9', minId: '100', maxId: '200', offset: 25 }, { signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/guilds/g1/messages/search');
  assert.equal(calls[0].signal, signal);
  assert.deepEqual(Object.fromEntries(calls[0].query), {
    content: 'κουνέλι',
    author_id: 'u9',
    min_id: '100',
    max_id: '200',
    offset: '25',
    limit: '25',
    sort_by: 'timestamp',
    sort_order: 'desc',
  });
  assert.equal(result.total, 48);
  assert.deepEqual(result.hits.map((h) => h.id), ['m1', 'm2', 'm3'], 'de-duplicated; a flagged hit wins over its context');
  assert.deepEqual(result.hits[0], {
    id: 'm1',
    channel_id: 'c1',
    timestamp: '2026-10-01T18:44:00.000Z',
    author: { id: 'u1', username: 'ana', global_name: 'Ána', bot: false },
    content: 'κείμενο m1',
  });
});

test('searchMessages: parameters that are not given are not sent', async () => {
  const { guild, calls } = fakeGuild(() => ({ total_results: 0, messages: [] }));
  assert.deepEqual(await searchMessages(guild, { minId: '5' }), { total: 0, hits: [] });
  assert.deepEqual([...calls[0].query.keys()], ['min_id', 'limit', 'sort_by', 'sort_order']);
});

test('searchMessages: a failing request or an index not ready resolves null and logs no query', async () => {
  const failing = fakeGuild(() => {
    throw Object.assign(new Error('Missing Access'), { status: 403, name: 'DiscordAPIError' });
  });
  const first = await withCapturedLogs(() => searchMessages(failing.guild, { content: 'μυστικό' }));
  assert.equal(first.result, null);
  assert.deepEqual(first.logs.map((l) => [l.msg, l.route, l.status, l.name]), [['search: failed', 'messages', 403, 'DiscordAPIError']]);
  assert.ok(!JSON.stringify(first.logs).includes('μυστικό'));

  const pending = fakeGuild(() => ({ message: 'Index not yet available.', code: 110000, documents_indexed: 0, retry_after: 2 }));
  const second = await withCapturedLogs(() => searchMessages(pending.guild, { content: 'x' }));
  assert.equal(second.result, null);
  assert.equal(second.logs[0].name, 'not-indexed');
});

test('searchMembers: sends the prefix query and limit, returns the members', async () => {
  const { guild, calls } = fakeGuild(() => [
    { nick: null, user: { id: 'u7', username: 'kitezu.', global_name: 'Kitezu', bot: false } },
    { nick: 'Kí', user: { id: 'u8', username: 'kitebot', global_name: null, bot: true } },
    { nick: 'broken' },
  ]);
  const members = await searchMembers(guild, 'kite', 2);
  assert.equal(calls[0].route, '/guilds/g1/members/search');
  assert.deepEqual(Object.fromEntries(calls[0].query), { query: 'kite', limit: '2' });
  assert.deepEqual(members, [
    { id: 'u7', username: 'kitezu.', globalName: 'Kitezu', nick: null, bot: false },
    { id: 'u8', username: 'kitebot', globalName: null, nick: 'Kí', bot: true },
  ]);
});

test('searchMembers: a failing request resolves null', async () => {
  const { guild } = fakeGuild(() => {
    throw new Error('network');
  });
  const { result, logs } = await withCapturedLogs(() => searchMembers(guild, 'kite', 2));
  assert.equal(result, null);
  assert.equal(logs[0].route, 'members');
});

/** A discord.js-shaped message. */
function djsMessage(id, ts) {
  return {
    id,
    channelId: 'c1',
    createdTimestamp: ts,
    cleanContent: `γραμμή ${id}`,
    content: `γραμμή ${id}`,
    author: { id: 'u1', username: 'ana', bot: false },
    member: { displayName: 'Ána' },
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: { users: new Map() },
  };
}

test('fetchAround: asks for the messages around an id and returns them normalized, oldest first', async () => {
  const queries = [];
  const channel = {
    id: 'c1',
    messages: {
      fetch: async (query) => {
        queries.push(query);
        return new Map([
          ['m3', djsMessage('m3', 3000)],
          ['m1', djsMessage('m1', 1000)],
          ['m2', djsMessage('m2', 2000)],
        ]);
      },
    },
  };
  const messages = await fetchAround(channel, 'm2', 16, { selfId: 'self' });
  assert.deepEqual(queries, [{ around: 'm2', limit: 16 }]);
  assert.deepEqual(messages.map((m) => [m.id, m.content, m.authorName]), [['m1', 'γραμμή m1', 'Ána'], ['m2', 'γραμμή m2', 'Ána'], ['m3', 'γραμμή m3', 'Ána']]);
});

test('fetchAround: a failing fetch resolves null', async () => {
  const channel = {
    id: 'c1',
    messages: {
      fetch: async () => {
        throw Object.assign(new Error('Unknown Channel'), { status: 404, name: 'DiscordAPIError' });
      },
    },
  };
  const { result, logs } = await withCapturedLogs(() => fetchAround(channel, 'm2', 16, { selfId: 'self' }));
  assert.equal(result, null);
  assert.deepEqual(logs.map((l) => [l.msg, l.channel, l.status]), [['search: around failed', 'c1', 404]]);
});

test('fetchAfter: asks for the messages after an id and returns them normalized, oldest first', async () => {
  const queries = [];
  const channel = {
    id: 'c1',
    messages: {
      fetch: async (query) => {
        queries.push(query);
        return new Map([
          ['m6', djsMessage('m6', 6000)],
          ['m5', djsMessage('m5', 5000)],
        ]);
      },
    },
  };
  const messages = await fetchAfter(channel, 'm4', 24, { selfId: 'self' });
  assert.deepEqual(queries, [{ after: 'm4', limit: 24 }]);
  assert.deepEqual(messages.map((m) => [m.id, m.content]), [['m5', 'γραμμή m5'], ['m6', 'γραμμή m6']]);
  await fetchAfter(channel, 'm4', 500, { selfId: 'self' });
  assert.equal(queries[1].limit, 100, 'one page at most');
});

test('fetchAfter: a failing fetch resolves null', async () => {
  const channel = {
    id: 'c1',
    messages: {
      fetch: async () => {
        throw Object.assign(new Error('Missing Access'), { status: 403, name: 'DiscordAPIError' });
      },
    },
  };
  const { result, logs } = await withCapturedLogs(() => fetchAfter(channel, 'm4', 24, { selfId: 'self' }));
  assert.equal(result, null);
  assert.deepEqual(logs.map((l) => [l.msg, l.channel, l.status]), [['search: after failed', 'c1', 403]]);
});
