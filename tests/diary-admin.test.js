// Tests for the diary's owner commands (src/admin.js: diary.set / show / off / post), the option
// readers of src/discord/commands.js and the history backfill (src/behavior/diary.js#backfillDiary).
// Discord, the store and the diary scheduler are fakes; config.local.json lives in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { createAdmin } from '../src/admin.js';
import { backfillDiary } from '../src/behavior/diary.js';
import { buildCommandTree, commandKeys, createInteractionHandler } from '../src/discord/commands.js';
import { labels } from './fixtures/labels.js';

const SELF = 'self1';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-diary-admin-'));
}

function readLocal(rootDir) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8'));
}

function makeHot(rootDir, diary = {}) {
  return {
    config: {
      bot: { owners: ['42'], timezone: 'UTC' },
      llm: { model: 'x/y', maxRequestsPerDay: 300 },
      media: { embedTextChars: 200, video: { sites: [] } },
      diary: {
        channelId: '',
        historyPosts: 150,
        gistChars: 200,
        kinds: { thought: 2, news: 0, status: 3 },
        ...diary,
      },
    },
    prompts: { labels },
    promptSources: {},
    rootDir,
    reloadConfigCalls: 0,
    reloadConfig() {
      this.reloadConfigCalls += 1;
      return true;
    },
    reloadPrompts: () => true,
  };
}

function makeStore(initialPosts = []) {
  let posts = initialPosts;
  return {
    state: { data: {} },
    setCalls: [],
    getDiary: () => ({ posts: structuredClone(posts), updatedAt: 0 }),
    setDiaryPosts(guildId, next) {
      this.setCalls.push([guildId, next]);
      posts = next;
    },
  };
}

/** A discord.js-shaped message of the persona or someone else; `images` adds picture attachments. */
function rawMessage(id, ts, text, { author = SELF, images = 0 } = {}) {
  return {
    id,
    channelId: 'd1',
    author: { id: author, bot: author === SELF },
    cleanContent: text,
    content: text,
    createdTimestamp: ts,
    attachments: new Map(
      Array.from({ length: images }, (_, i) => [`a${i}`, { id: `a${i}`, contentType: 'image/png', name: 'p.png', url: 'u', size: 1 }]),
    ),
    embeds: [],
    stickers: new Map(),
  };
}

function makeChannel({ id = 'd1', allow = ['view', 'send', 'attach', 'history'], messages = [] } = {}) {
  const flags = new Set();
  if (allow.includes('send')) flags.add(PermissionFlagsBits.SendMessages);
  if (allow.includes('attach')) flags.add(PermissionFlagsBits.AttachFiles);
  if (allow.includes('history')) flags.add(PermissionFlagsBits.ReadMessageHistory);
  const me = { id: SELF };
  return {
    id,
    viewable: allow.includes('view'),
    guild: { members: { me } },
    permissionsFor: () => ({ has: (flag) => flags.has(flag) }),
    messages: { fetch: async () => new Map(messages.map((m) => [m.id, m])) },
  };
}

function makeAdmin({ diary, channel = makeChannel(), store = makeStore(), hotDiary } = {}) {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir, hotDiary);
  const client = { user: { id: SELF }, channels: { fetch: async (id) => (id === channel.id ? channel : null) } };
  const admin = createAdmin({ hot, store, client, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1', diary });
  return { admin, hot, store, rootDir };
}

const owner = { userId: '42' };

test('diary set: refuses a channel without attach permission', async () => {
  const { admin, rootDir, store } = makeAdmin({ channel: makeChannel({ allow: ['view', 'send', 'history'] }) });
  await assert.rejects(() => admin.run('diary.set', { channelId: 'd1' }, owner), /attach/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false, 'nothing written');
  assert.equal(store.setCalls.length, 0);
});

test('diary set: refuses a channel the bot cannot send in or cannot see', async () => {
  for (const allow of [['view', 'attach', 'history'], ['send', 'attach', 'history']]) {
    const { admin, rootDir } = makeAdmin({ channel: makeChannel({ allow }) });
    await assert.rejects(() => admin.run('diary.set', { channelId: 'd1' }, owner), /cannot/);
    assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
  }
});

test('diary set: refuses an unknown channel', async () => {
  const { admin } = makeAdmin();
  await assert.rejects(() => admin.run('diary.set', { channelId: 'nope' }, owner), /no channel/);
});

test('diary set: writes diary.channelId to config.local.json and backfills an empty history', async () => {
  const channel = makeChannel({
    messages: [
      rawMessage('m3', 3000, 'third'),
      rawMessage('m1', 1000, 'first post'),
      rawMessage('m2', 2000, 'someone else', { author: 'u9' }),
    ],
  });
  const diary = { status: () => ({ channelId: 'd1', day: '2026-09-20', slots: [Date.UTC(2026, 8, 20, 18, 30)], done: [] }) };
  const { admin, rootDir, store, hot } = makeAdmin({ channel, diary });
  const reply = await admin.run('diary.set', { channelId: 'd1' }, owner);
  assert.deepEqual(readLocal(rootDir), { diary: { channelId: 'd1' } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.equal(store.setCalls.length, 1);
  assert.deepEqual(store.getDiary('g1').posts.map((p) => p.gist), ['first post', 'third']);
  assert.match(reply, /d1/);
  assert.match(reply, /2 posts/);
  assert.match(reply, /18:30/, 'today\'s plan');
});

test('diary set: keeps a non-empty history and reports zero backfilled', async () => {
  const store = makeStore([{ at: 1, kind: 'thought', gist: 'x', picture: null, messageIds: ['m0'], search: null }]);
  const { admin } = makeAdmin({ store, channel: makeChannel({ messages: [rawMessage('m1', 1000, 'a')] }) });
  const reply = await admin.run('diary.set', { channelId: 'd1' }, owner);
  assert.equal(store.setCalls.length, 0);
  assert.match(reply, /0 posts/);
});

test('diary set: refused while paused', async () => {
  const store = makeStore();
  store.state.data.paused = true;
  const { admin, rootDir } = makeAdmin({ store });
  await assert.rejects(() => admin.run('diary.set', { channelId: 'd1' }, owner), /paused/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('diary show: prints the channel, today\'s slots in local time, counts and the history size', async () => {
  const store = makeStore([{ at: 1, kind: null, gist: 'x', picture: null, messageIds: [], search: null }]);
  const slots = [Date.UTC(2026, 8, 20, 9, 5), Date.UTC(2026, 8, 20, 18, 30)];
  const diary = { status: () => ({ channelId: 'd1', day: '2026-09-20', slots, done: [slots[0]], posts: 1, pictures: 0, history: 1 }) };
  const { admin } = makeAdmin({ store, diary, hotDiary: { channelId: 'd1' } });
  const reply = await admin.run('diary.show', {}, owner);
  assert.match(reply, /d1/);
  assert.match(reply, /09:05 done/);
  assert.match(reply, /18:30(?! done)/);
  assert.match(reply, /posts today: 1/);
  assert.match(reply, /pictures today: 0/);
  assert.match(reply, /history: 1/);
});

test('diary show: prints the hunger of each window and the quiet streak', async () => {
  const diary = { status: () => ({ channelId: 'd1', day: '2026-09-20', slots: [], done: [], hunger: [0, 1, 2], quietStreak: 1, posts: 0, pictures: 0, history: 0 }) };
  const { admin } = makeAdmin({ diary, hotDiary: { channelId: 'd1' } });
  const reply = await admin.run('diary.show', {}, owner);
  assert.match(reply, /hunger: 0\/1\/2 \(quiet streak 1\)/);
});

test('diary show: without a running diary prints the channel and the history size only', async () => {
  const { admin } = makeAdmin({ hotDiary: { channelId: 'd1' } });
  const reply = await admin.run('diary.show', {}, owner);
  assert.match(reply, /d1/);
  assert.match(reply, /history: 0/);
  const off = await makeAdmin().admin.run('diary.show', {}, owner);
  assert.match(off, /off/);
});

test('diary off: clears the key and keeps diary.json', async () => {
  const store = makeStore([{ at: 1, kind: null, gist: 'x', picture: null, messageIds: [], search: null }]);
  const { admin, rootDir } = makeAdmin({ store, hotDiary: { channelId: 'd1' } });
  fs.writeFileSync(path.join(rootDir, 'config.local.json'), JSON.stringify({ diary: { channelId: 'd1' }, llm: { model: 'a/b' } }));
  await admin.run('diary.off', {}, owner);
  assert.deepEqual(readLocal(rootDir), { llm: { model: 'a/b' } });
  assert.equal(store.getDiary('g1').posts.length, 1);
  assert.equal(store.setCalls.length, 0);
});

test('diary post: forces one post with the kind and reports the outcome', async () => {
  const calls = [];
  const diary = { force: async (args) => { calls.push(args); return 'spoke'; }, status: () => ({}) };
  const { admin } = makeAdmin({ diary });
  const reply = await admin.run('diary.post', { kind: 'thought' }, owner);
  assert.deepEqual(calls, [{ kind: 'thought' }]);
  assert.match(reply, /spoke/);
  await admin.run('diary.post', {}, owner);
  assert.deepEqual(calls[1], { kind: undefined });
});

test('diary post: passes the topic to force', async () => {
  const calls = [];
  const diary = { force: async (args) => { calls.push(args); return 'spoke'; } };
  const { admin } = makeAdmin({ diary });
  await admin.run('diary.post', { kind: 'thought', topic: '  le marché du dimanche  ' }, owner);
  await admin.run('diary.post', { topic: 'ένα ταξίδι' }, owner);
  assert.deepEqual(calls, [
    { kind: 'thought', topic: 'le marché du dimanche' },
    { kind: undefined, topic: 'ένα ταξίδι' },
  ]);
});

test('diary post: an empty topic is none', async () => {
  const calls = [];
  const diary = { force: async (args) => { calls.push(args); return 'spoke'; } };
  const { admin } = makeAdmin({ diary });
  await admin.run('diary.post', { kind: 'thought', topic: '   ' }, owner);
  await admin.run('diary.post', { topic: '' }, owner);
  assert.deepEqual(calls, [{ kind: 'thought' }, { kind: undefined }]);
});

test('diary post: an unknown kind or one with weight 0 is refused with the list of kinds', async () => {
  const calls = [];
  const diary = { force: async (args) => { calls.push(args); return 'spoke'; } };
  const { admin } = makeAdmin({ diary });
  for (const kind of ['nope', 'news']) {
    await assert.rejects(() => admin.run('diary.post', { kind }, owner), /thought, status/);
  }
  assert.equal(calls.length, 0);
});

test('diary post: a cap refusal names the limit and the counts', async () => {
  const outcomes = [
    { outcome: 'refused', reason: 'cap', limit: { key: 'diary.maxPerDay', used: 3, cap: 3 } },
    { outcome: 'refused', limit: { key: 'llm.maxRequestsPerDay', used: 500, cap: 500 } },
    { outcome: 'not-now', reason: 'no-channel' },
  ];
  const diary = { force: async () => outcomes.shift() };
  const { admin } = makeAdmin({ diary });
  // A post that did not go out is no success: the same line, as a failure with its code.
  await assert.rejects(() => admin.run('diary.post', { kind: 'thought' }, owner), { message: 'diary post thought: refused (diary.maxPerDay 3/3)', code: 'daily-cap' });
  await assert.rejects(() => admin.run('diary.post', {}, owner), { message: 'diary post: refused (llm.maxRequestsPerDay 500/500)', code: 'daily-cap' });
  await assert.rejects(() => admin.run('diary.post', {}, owner), { message: 'diary post: not-now (no-channel)', code: 'not-configured' });
});

test('diary post: a pictures refusal names the closed cap, else the reason', async () => {
  const outcomes = [
    { outcome: 'refused', reason: 'pictures', limit: { key: 'diary.maxPicturesPerDay', used: 2, cap: 2 } },
    { outcome: 'refused', reason: 'pictures', limit: null },
  ];
  const diary = { force: async () => outcomes.shift() };
  const { admin } = makeAdmin({ diary });
  await assert.rejects(() => admin.run('diary.post', { kind: 'thought' }, owner), { message: 'diary post thought: refused (diary.maxPicturesPerDay 2/2)', code: 'daily-cap' });
  await assert.rejects(() => admin.run('diary.post', { kind: 'thought' }, owner), { message: 'diary post thought: refused (pictures)', code: 'refused' });
});

test('diary post: without a running diary it says so', async () => {
  const { admin } = makeAdmin();
  await assert.rejects(() => admin.run('diary.post', {}, owner), { message: 'diary not running', code: 'not-configured' });
});

test('diary commands: the tree has the group and every key is known to the dispatcher', () => {
  const { keys, groups } = commandKeys();
  assert.ok(groups.has('diary'));
  for (const key of ['diary.set', 'diary.show', 'diary.off', 'diary.post']) assert.ok(keys.has(key), key);
  const group = JSON.stringify(buildCommandTree('nep'));
  assert.match(group, /"name":"diary"/);
});

test('backfillDiary: keeps only the persona\'s messages, oldest first, and skips a non-empty history', async () => {
  const store = makeStore();
  const history = [
    { id: 'm1', ts: 1000, self: true, content: 'first\n  post', attachments: [] },
    { id: 'm2', ts: 2000, self: false, content: 'other', attachments: [] },
    { id: 'm3', ts: 3000, self: true, content: 'pic', attachments: [{ kind: 'image' }] },
  ];
  const seen = [];
  const fetchHistoryImpl = async (channel, options) => {
    seen.push(options);
    return history;
  };
  const config = makeHot('x').config;
  const count = await backfillDiary({ store, channel: {}, guildId: 'g1', selfId: SELF, config, labels, fetchHistoryImpl });
  assert.equal(count, 2);
  assert.equal(seen[0].limit, 150);
  assert.equal(seen[0].selfId, SELF);
  const posts = store.getDiary('g1').posts;
  assert.deepEqual(posts.map((p) => [p.at, p.kind, p.gist, p.picture, p.messageIds]), [
    [1000, null, 'first post', null, ['m1']],
    [3000, null, 'pic', labels.diary.pictureUnknown, ['m3']],
  ]);
  assert.equal(await backfillDiary({ store, channel: {}, guildId: 'g1', selfId: SELF, config, labels, fetchHistoryImpl }), 0);
  assert.equal(seen.length, 1, 'a non-empty history is not even fetched');
});

test('diary commands: the options reach admin.runCommand as channelId and kind', async () => {
  const runCalls = [];
  const admin = {
    isAllowed: () => true,
    runCommand: async (key, args) => {
      runCalls.push([key, args]);
      return { status: 'ok', code: 'ok', summary: 'ok', data: null };
    },
  };
  const hot = { config: { bot: { commandName: 'nep', owners: ['42'] }, features: {} } };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });
  const interaction = (subcommand, values) => ({
    guildId: 'g1',
    channelId: 'c1',
    user: { id: '42' },
    commandName: 'nep',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    options: {
      getSubcommandGroup: () => 'diary',
      getSubcommand: () => subcommand,
      getChannel: (name) => values[name] ?? null,
      getString: (name) => values[name] ?? null,
    },
    deferReply: async () => {},
    reply: async () => {},
    editReply: async () => {},
    followUp: async () => {},
  });
  await handler(interaction('set', { channel: { id: 'd1' } }));
  await handler(interaction('post', { kind: 'news' }));
  await handler(interaction('post', {}));
  await handler(interaction('post', { topic: 'la pluie' }));
  await handler(interaction('show', {}));
  assert.deepEqual(runCalls, [
    ['diary.set', { channelId: 'd1' }],
    ['diary.post', { kind: 'news' }],
    ['diary.post', { kind: undefined }],
    ['diary.post', { kind: undefined, topic: 'la pluie' }],
    ['diary.show', {}],
  ]);
});
