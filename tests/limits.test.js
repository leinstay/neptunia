// Tests for src/behavior/limits.js: the one plain line that says a rail
// refused a directly requested action, reading the limit off an error, and
// the shared posting side (the notice and the dry-run mirror).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  limitNotice,
  limitOf,
  isLimitNotice,
  mirrorDryRun,
  pauseNotice,
  postLimitNotice,
  postPauseNotice,
} from '../src/behavior/limits.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createFakeAdapter } from '../src/interface/fake.js';

const labels = { limits: { notice: 'limit hit: {limit} {used}/{cap}', paused: 'on a break (back soon) [*]' } };

// --- limitNotice ---------------------------------------------------------------

test('limitNotice: fills {limit}, {used} and {cap}', () => {
  const text = limitNotice(labels, { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 });
  assert.equal(text, 'limit hit: llm.maxRequestsPerDay 300/300');
});

test('limitNotice: an empty string when the label is missing', () => {
  const limit = { key: 'image.maxPerDay', used: 50, cap: 50 };
  assert.equal(limitNotice({}, limit), '');
  assert.equal(limitNotice({ limits: {} }, limit), '');
  assert.equal(limitNotice({ limits: { notice: '' } }, limit), '');
  assert.equal(limitNotice(undefined, limit), '');
  assert.equal(limitNotice({ limits: { notice: 42 } }, limit), '');
});

// --- limitOf ---------------------------------------------------------------------

test('limitOf: reads { key, used, cap } off an error carrying them', () => {
  const err = Object.assign(new Error('cap'), { key: 'llm.maxRequestTokens', used: 60000, cap: 50000 });
  assert.deepEqual(limitOf(err), { key: 'llm.maxRequestTokens', used: 60000, cap: 50000 });
});

test('limitOf: null for an error without the fields, or with malformed ones', () => {
  assert.equal(limitOf(new Error('boom')), null);
  assert.equal(limitOf(null), null);
  assert.equal(limitOf(undefined), null);
  assert.equal(limitOf(Object.assign(new Error('x'), { key: '', used: 1, cap: 1 })), null);
  assert.equal(limitOf(Object.assign(new Error('x'), { key: 'llm.maxRequestsPerDay', cap: 1 })), null);
  assert.equal(limitOf(Object.assign(new Error('x'), { key: 'llm.maxRequestsPerDay', used: 1, cap: '1' })), null);
});

// --- isLimitNotice -----------------------------------------------------------------

test('isLimitNotice: true for a line the notice template produced', () => {
  const text = limitNotice(labels, { key: 'private.maxPerUserPerDay', used: 100, cap: 100 });
  assert.equal(isLimitNotice(labels, text), true);
  assert.equal(isLimitNotice(labels, 'limit hit: image.maxPerDay 50/50'), true);
});

test('isLimitNotice: false for ordinary text, a partial match or a notice inside a longer line', () => {
  assert.equal(isLimitNotice(labels, 'καλημέρα'), false);
  assert.equal(isLimitNotice(labels, 'limit hit: '), false);
  assert.equal(isLimitNotice(labels, 'so, limit hit: llm.maxRequestsPerDay 300/300'), false);
  const bracketed = { limits: { notice: '({limit} {used}/{cap})' } };
  assert.equal(isLimitNotice(bracketed, '(llm.maxRequestsPerDay 300/300) and more'), false);
  assert.equal(isLimitNotice(labels, ''), false);
  assert.equal(isLimitNotice(labels, undefined), false);
});

test('isLimitNotice: false when the label is missing or empty', () => {
  const text = 'limit hit: llm.maxRequestsPerDay 300/300';
  assert.equal(isLimitNotice({}, text), false);
  assert.equal(isLimitNotice(undefined, text), false);
  assert.equal(isLimitNotice({ limits: { notice: '' } }, text), false);
  assert.equal(isLimitNotice({ limits: { notice: 42 } }, text), false);
});

test('isLimitNotice: regex metacharacters in the label are matched literally', () => {
  const custom = { limits: { notice: '...but nobody came ({limit}, {used}/{cap}) [*+?^$|\\]' } };
  const text = limitNotice(custom, { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 });
  assert.equal(text, '...but nobody came (llm.maxRequestsPerDay, 800/800) [*+?^$|\\]');
  assert.equal(isLimitNotice(custom, text), true);
  assert.equal(
    isLimitNotice(custom, 'abcbut nobody came (llm.maxRequestsPerDay, 800/800) [*+?^$|\\]'),
    false,
    'dots are literal'
  );
  assert.equal(
    isLimitNotice(custom, '...but nobody came llm.maxRequestsPerDay, 800/800 [*+?^$|\\]'),
    false,
    'parentheses are literal'
  );
  assert.equal(
    isLimitNotice(custom, '...but nobody came (llm.maxRequestsPerDay, 800/800) [*+?^$|]'),
    false,
    'the backslash is literal'
  );
});

// --- the pause notice --------------------------------------------------------------

test('pauseNotice: the label as is; an empty string when it is missing, empty or not a string', () => {
  assert.equal(pauseNotice(labels), labels.limits.paused);
  assert.equal(pauseNotice({}), '');
  assert.equal(pauseNotice(undefined), '');
  assert.equal(pauseNotice({ limits: { paused: '' } }), '');
  assert.equal(pauseNotice({ limits: { paused: '   ' } }), '');
  assert.equal(pauseNotice({ limits: { paused: 42 } }), '');
});

test('isLimitNotice: recognises the pause notice literally, alone or without the limit label', () => {
  assert.equal(isLimitNotice(labels, pauseNotice(labels)), true);
  assert.equal(isLimitNotice(labels, `  ${pauseNotice(labels)}\n`), true, 'surrounding whitespace ignored');
  assert.equal(isLimitNotice(labels, `${pauseNotice(labels)} and more`), false);
  assert.equal(isLimitNotice(labels, 'on a break (back soon) [x]'), false, 'metacharacters are literal');
  const pauseOnly = { limits: { paused: labels.limits.paused } };
  assert.equal(isLimitNotice(pauseOnly, labels.limits.paused), true);
  assert.equal(isLimitNotice(pauseOnly, 'limit hit: image.maxPerDay 50/50'), false);
  assert.equal(isLimitNotice({ limits: { notice: labels.limits.notice } }, labels.limits.paused), false);
  assert.equal(isLimitNotice({ limits: { paused: '' } }, ''), false);
});

// --- the posting side ------------------------------------------------------------

// A notice goes out through the adapter's send (the Discord side owns the channel object), so the
// tests read what the fake adapter stored. The channel is only the id and the name the notice needs.
// Earlier tests asserted `channel.send` payloads; the notice no longer touches a channel object.
function noticeChannel({ id = 'c1', name = 'general' } = {}) {
  return { id, name };
}

function noticesIn(port, conversationId = 'c1') {
  return port.messagesIn(conversationId);
}

function mirrorClient() {
  const mirrored = [];
  const fetched = [];
  return {
    mirrored,
    fetched,
    channels: {
      fetch: async (id) => {
        fetched.push(id);
        return { send: async (payload) => mirrored.push(payload) };
      },
    },
  };
}

const LIMIT = { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 };
const LIVE = { features: { dryRun: false }, bot: { dryRunChannelId: 'mirror1' } };

const NO_MENTIONS = { users: [], repliedUser: false };

test('postLimitNotice: one send on the adapter, replying to the trigger, mentioning nobody', async () => {
  const channel = noticeChannel();
  const port = createFakeAdapter();
  const { result, logs } = await withCapturedLogs(() =>
    postLimitNotice({
      channel,
      trigger: { id: 'm1' },
      limit: LIMIT,
      asReply: true,
      labels,
      config: LIVE,
      client: mirrorClient(),
      port,
    })
  );
  assert.equal(result, 'sent');
  assert.deepEqual(
    port.calls.map((call) => call.op),
    ['send']
  );
  const [notice] = noticesIn(port);
  assert.equal(notice.text, 'limit hit: llm.maxRequestsPerDay 300/300');
  assert.deepEqual(notice.replyTo, { iface: 'fake', conversationId: 'c1', messageId: 'm1' });
  assert.deepEqual(notice.mentions, NO_MENTIONS);
  assert.ok(logs.some((l) => l.msg === 'limits: notice sent' && l.key === 'llm.maxRequestsPerDay'));
});

test('postLimitNotice: asReply false (a follow-up) sends without a reply target', async () => {
  const channel = noticeChannel();
  const port = createFakeAdapter();
  await postLimitNotice({
    channel,
    trigger: { id: 'm1' },
    limit: LIMIT,
    asReply: false,
    labels,
    config: LIVE,
    client: mirrorClient(),
    port,
  });
  assert.equal(noticesIn(port).length, 1);
  assert.equal(noticesIn(port)[0].replyTo, null);
});

test('postLimitNotice: a missing label or limit sends nothing', async () => {
  const channel = noticeChannel();
  const port = createFakeAdapter();
  const client = mirrorClient();
  assert.equal(
    await postLimitNotice({
      channel,
      trigger: null,
      limit: LIMIT,
      asReply: true,
      labels: {},
      config: LIVE,
      client,
      port,
    }),
    'none'
  );
  assert.equal(
    await postLimitNotice({ channel, trigger: null, limit: null, asReply: true, labels, config: LIVE, client, port }),
    'none'
  );
  assert.deepEqual(port.calls, []);
});

test('postLimitNotice: in dry-run it is logged and mirrored, never sent; a DM is labelled private, not #null', async () => {
  const channel = noticeChannel({ id: 'dm1', name: null });
  const port = createFakeAdapter();
  const client = mirrorClient();
  const config = { features: { dryRun: true }, bot: { dryRunChannelId: 'mirror1' } };
  const { result, logs } = await withCapturedLogs(() =>
    postLimitNotice({ channel, trigger: { id: 'm1' }, limit: LIMIT, asReply: true, labels, config, client, port })
  );
  assert.equal(result, 'dry-run');
  assert.deepEqual(port.calls, []);
  assert.deepEqual(client.fetched, ['mirror1']);
  assert.equal(client.mirrored[0].content, '[dry-run] private · limit\nlimit hit: llm.maxRequestsPerDay 300/300');
  assert.deepEqual(client.mirrored[0].allowedMentions, { parse: [] });
  const line = logs.find((l) => l.msg === 'dry-run: would notify limit');
  assert.deepEqual([line.channel, line.key, line.used, line.cap], ['dm1', 'llm.maxRequestsPerDay', 300, 300]);
});

test('postLimitNotice: a send the adapter refuses answers failed and is logged, never thrown', async () => {
  const channel = noticeChannel();
  const port = createFakeAdapter();
  port.failNext('send', { status: 'failed', error: { code: 'http-403', retryable: false } });
  const { result, logs } = await withCapturedLogs(() =>
    postLimitNotice({
      channel,
      trigger: { id: 'm1' },
      limit: LIMIT,
      asReply: true,
      labels,
      config: LIVE,
      client: mirrorClient(),
      port,
    })
  );
  assert.equal(result, 'failed');
  assert.deepEqual(
    port.calls.map((call) => call.op),
    ['send']
  );
  assert.equal(noticesIn(port).length, 0);
  assert.ok(logs.some((l) => l.msg === 'limits: notice failed' && l.channel === 'c1'));
});

test('postLimitNotice: an adapter that throws answers failed and does not throw', async () => {
  const attempts = [];
  const port = {
    ...createFakeAdapter(),
    send: async (conversation) => {
      attempts.push(conversation.conversationId);
      throw new Error('socket closed');
    },
  };
  const result = await postLimitNotice({
    channel: noticeChannel(),
    trigger: { id: 'm1' },
    limit: LIMIT,
    asReply: true,
    labels,
    config: LIVE,
    client: mirrorClient(),
    port,
  });
  assert.equal(result, 'failed');
  assert.deepEqual(attempts, ['c1']);
});

test('postPauseNotice: one send of the pause label, replying to the trigger, mentioning nobody, logged with its kind', async () => {
  const channel = noticeChannel();
  const port = createFakeAdapter();
  const { result, logs } = await withCapturedLogs(() =>
    postPauseNotice({
      channel,
      trigger: { id: 'm1' },
      kind: 'mention',
      asReply: true,
      labels,
      config: LIVE,
      client: mirrorClient(),
      port,
    })
  );
  assert.equal(result, 'sent');
  const [notice] = noticesIn(port);
  assert.equal(notice.text, labels.limits.paused);
  assert.deepEqual(notice.replyTo, { iface: 'fake', conversationId: 'c1', messageId: 'm1' });
  assert.deepEqual(notice.mentions, NO_MENTIONS);
  const line = logs.find((l) => l.msg === 'limits: pause notice');
  assert.deepEqual([line.channel, line.kind], ['c1', 'mention']);
});

test('postPauseNotice: asReply false sends without a reply target', async () => {
  const port = createFakeAdapter();
  await postPauseNotice({
    channel: noticeChannel(),
    trigger: { id: 'm1' },
    kind: 'mention',
    asReply: false,
    labels,
    config: LIVE,
    client: mirrorClient(),
    port,
  });
  assert.equal(noticesIn(port)[0].replyTo, null);
});

test('postPauseNotice: a missing label sends nothing', async () => {
  const port = createFakeAdapter();
  const result = await postPauseNotice({
    channel: noticeChannel(),
    trigger: { id: 'm1' },
    kind: 'mention',
    asReply: true,
    labels: { limits: {} },
    config: LIVE,
    client: mirrorClient(),
    port,
  });
  assert.equal(result, 'none');
  assert.deepEqual(port.calls, []);
});

test('postPauseNotice: in dry-run it is mirrored, never sent', async () => {
  const port = createFakeAdapter();
  const client = mirrorClient();
  const config = { features: { dryRun: true }, bot: { dryRunChannelId: 'mirror1' } };
  const { result, logs } = await withCapturedLogs(() =>
    postPauseNotice({
      channel: noticeChannel(),
      trigger: { id: 'm1' },
      kind: 'name',
      asReply: true,
      labels,
      config,
      client,
      port,
    })
  );
  assert.equal(result, 'dry-run');
  assert.deepEqual(port.calls, []);
  assert.equal(client.mirrored.length, 1);
  assert.ok(client.mirrored[0].content.endsWith(`\n${labels.limits.paused}`));
  assert.deepEqual(client.mirrored[0].allowedMentions, { parse: [] });
  assert.ok(!logs.some((l) => l.msg === 'limits: pause notice'), 'nothing was sent');
});

test('postPauseNotice: a send the adapter refuses answers failed, never thrown', async () => {
  const port = createFakeAdapter();
  port.failNext('send', { status: 'failed', error: { code: 'http-403', retryable: false } });
  const result = await postPauseNotice({
    channel: noticeChannel(),
    trigger: { id: 'm1' },
    kind: 'reply',
    asReply: true,
    labels,
    config: LIVE,
    client: mirrorClient(),
    port,
  });
  assert.equal(result, 'failed');
  assert.equal(port.calls.length, 1);
});

test('mirrorDryRun: no id posts nothing; a fetch failure is logged and swallowed', async () => {
  const client = mirrorClient();
  assert.equal(await mirrorDryRun({ client, dryRunChannelId: '', header: 'h', body: 'b' }), false);
  assert.deepEqual(client.fetched, []);

  const broken = {
    channels: {
      fetch: async () => {
        throw new Error('Unknown Channel');
      },
    },
  };
  const { result, logs } = await withCapturedLogs(() =>
    mirrorDryRun({ client: broken, dryRunChannelId: 'gone', header: 'h', body: 'b' })
  );
  assert.equal(result, false);
  assert.ok(logs.some((l) => l.msg === 'dry-run: mirror failed' && l.dryRunChannelId === 'gone'));
});
