// Tests for src/memory/avatars.js and src/memory/avatar-queue.js: which member is due, the hash change, the default avatar
// without a request, the daily cap, the throttled queue on an injected clock, the stored field's
// normalisation, and the store's write path for it. Fakes only: no network, no real data/.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { avatarHashOf, isAvatarDue, memberView, normalizeAvatar } from '../src/memory/avatars.js';
import { AVATAR_DAILY, createAvatarQueue } from '../src/memory/avatar-queue.js';
import { createStore } from '../src/memory/store.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const GUILD = 'g1';
const SELF = 'self-1';
const PROMPT = 'Describe the avatar in at most {{maxChars}} characters.';
const DOWNLOAD = { dataUrl: 'data:image/png;base64,ZmFrZQ==', bytes: 4, contentType: 'image/png' };

const TMP_ROOT = tempDir('nep-avatars-');
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

function clock(start = NOW) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function fakeHot({ features = {}, avatars = {}, prompts = {} } = {}) {
  return {
    config: {
      features: { avatars: true, ...features },
      avatars: { intervalMs: 20000, maxPerDay: 60, descriptionChars: 200, ...avatars },
      context: { vision: { maxBytes: 1000, fetchTimeoutMs: 500 } },
      media: { maxOutputTokens: 300 },
      models: { base: { vision: 'v/model' } },
    },
    prompts: { avatar: PROMPT, ...prompts },
  };
}

/** An in-memory store with the profile accessors the queue uses. */
function fakeStore(profiles = {}) {
  const users = new Map(Object.entries(profiles).map(([id, profile]) => [id, { id, names: [id], ...profile }]));
  const writes = [];
  return {
    users,
    writes,
    getUser: (guildId, id) => (guildId === GUILD ? users.get(id) ?? null : null),
    listUserProfiles: (guildId) => (guildId === GUILD ? [...users.values()] : []),
    setAvatar(guildId, id, avatar) {
      const profile = users.get(id);
      if (!profile) return null;
      profile.avatar = normalizeAvatar(avatar);
      writes.push({ id, avatar: profile.avatar });
      return profile;
    },
  };
}

function fakeLlm(answer = 'an illustrated fox with a scarf') {
  const calls = [];
  return {
    calls,
    capLeft: () => 100,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      if (answer instanceof Error) throw answer;
      return { text: typeof answer === 'function' ? answer() : answer, usage: null, estimated: 0 };
    },
  };
}

function fakeFetcher(result = DOWNLOAD) {
  const calls = [];
  return {
    calls,
    fetchAsDataUrl: async (url, options) => {
      calls.push({ url, options });
      return result;
    },
  };
}

function fakeState(data = {}) {
  return { data, dirty: 0, markDirty() { this.dirty += 1; } };
}

function fakeLog() {
  const entries = [];
  const push = (level) => (msg, meta) => entries.push({ level, msg, ...meta });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function view(id, hash, extra = {}) {
  return { id, bot: false, hash, url: hash ? `https://cdn.example/avatars/${id}/${hash}.png?size=256` : null, ...extra };
}

function setup({ profiles = { u1: {} }, hot = fakeHot(), llm = fakeLlm(), imageFetcher = fakeFetcher(), state = fakeState(), now = clock(), members = {}, paused = false } = {}) {
  const store = fakeStore(profiles);
  const log = fakeLog();
  const queue = createAvatarQueue({
    hot,
    store,
    llm,
    imageFetcher,
    state,
    now,
    log,
    getGuildId: () => GUILD,
    selfId: () => SELF,
    paused: () => paused,
    resolveMember: async (guildId, id) => members[id] ?? null,
  });
  return { queue, store, llm, imageFetcher, state, now, log, hot };
}

// ---- pure parts -------------------------------------------------------------------------

test('avatarHashOf: the server avatar wins, then the account avatar, else null', () => {
  assert.equal(avatarHashOf({ memberAvatar: 'srv', userAvatar: 'acc' }), 'srv');
  assert.equal(avatarHashOf({ memberAvatar: null, userAvatar: 'acc' }), 'acc');
  assert.equal(avatarHashOf({ memberAvatar: '', userAvatar: '' }), null);
  assert.equal(avatarHashOf({}), null);
});

test('memberView: a guild member as the queue sees it, a static 256 px PNG url only with a hash', () => {
  const asked = [];
  const member = {
    avatar: null,
    user: { id: 'u1', bot: false, avatar: 'a_anim' },
    displayAvatarURL: (options) => {
      asked.push(options);
      return 'https://cdn.example/a.png';
    },
  };
  assert.deepEqual(memberView(member), { id: 'u1', bot: false, hash: 'a_anim', url: 'https://cdn.example/a.png' });
  assert.deepEqual(asked, [{ extension: 'png', size: 256, forceStatic: true }]);
  const plain = memberView({ avatar: null, user: { id: 'u2', bot: true, avatar: null }, displayAvatarURL: () => 'x' });
  assert.deepEqual(plain, { id: 'u2', bot: true, hash: null, url: null });
  assert.equal(memberView(null), null);
  assert.equal(memberView({ user: {} }), null);
  // A throwing url builder never escapes.
  assert.deepEqual(memberView({ avatar: 's', user: { id: 'u3', avatar: null }, displayAvatarURL: () => { throw new Error('boom'); } }), { id: 'u3', bot: false, hash: 's', url: null });
});

test('normalizeAvatar: a described avatar, the default one, anything else is no field', () => {
  assert.deepEqual(normalizeAvatar({ hash: 'h1', text: ' a  red\nfox ', describedAt: '2026-10-15T12:00:00.000Z', extra: 1 }), {
    hash: 'h1',
    text: 'a red fox',
    describedAt: '2026-10-15T12:00:00.000Z',
  });
  assert.deepEqual(normalizeAvatar({ hash: null, default: true }), { hash: null, default: true });
  assert.deepEqual(normalizeAvatar({ hash: 'h1', text: 'fox', describedAt: 'not a date' }), { hash: 'h1', text: 'fox', describedAt: null });
  for (const broken of [null, 'fox', [], {}, { hash: 'h1' }, { hash: 'h1', text: '   ' }, { hash: '', text: 'fox' }, { hash: null }, { default: 'yes' }]) {
    assert.equal(normalizeAvatar(broken), null, JSON.stringify(broken));
  }
});

test('isAvatarDue: nothing stored or another hash is due; the same hash or the default again is not', () => {
  const described = { hash: 'h1', text: 'fox', describedAt: null };
  assert.equal(isAvatarDue(undefined, 'h1'), true);
  assert.equal(isAvatarDue(undefined, null), true);
  assert.equal(isAvatarDue(described, 'h1'), false);
  assert.equal(isAvatarDue(described, 'h2'), true);
  assert.equal(isAvatarDue(described, null), true);
  assert.equal(isAvatarDue({ hash: null, default: true }, null), false);
  assert.equal(isAvatarDue({ hash: null, default: true }, 'h1'), true);
  assert.equal(isAvatarDue({ hash: 'h1' }, 'h1'), true, 'a broken stored field is described again');
});

// ---- offer: who is queued ---------------------------------------------------------------

test('offer: only a profiled member of the served guild, never a bot or the persona, and only on a hash change', () => {
  const { queue, store } = setup({ profiles: { u1: {}, u2: { avatar: { hash: 'h2', text: 'cat', describedAt: null } }, [SELF]: {}, b1: {} } });
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'queued');
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'queued', 'the same offer again keeps one item');
  assert.equal(queue.offer(GUILD, view('u2', 'h2')), 'current');
  assert.equal(queue.offer(GUILD, view('u2', 'h3')), 'queued');
  assert.equal(queue.offer(GUILD, view('nobody', 'h4')), 'no-profile');
  assert.equal(queue.offer(GUILD, view(SELF, 'h5')), 'self');
  assert.equal(queue.offer(GUILD, view('b1', 'h6', { bot: true })), 'bot');
  assert.equal(queue.offer('other', view('u1', 'h1')), 'other-guild');
  assert.equal(queue.offer(GUILD, null), 'invalid');
  assert.deepEqual(queue.pending(), ['u1', 'u2']);
  assert.equal(store.writes.length, 0, 'an offer never writes');
});

test('offer: with the switch not exactly true or the prompt missing nothing is queued', () => {
  for (const hot of [fakeHot({ features: { avatars: 'yes' } }), fakeHot({ features: { avatars: undefined } }), fakeHot({ prompts: { avatar: '' } })]) {
    const { queue } = setup({ hot });
    assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'off');
    assert.deepEqual(queue.pending(), []);
  }
});

test('offer: a store that throws never escapes into the gateway handler', () => {
  const { queue, store } = setup();
  store.getUser = () => {
    throw new Error('disk');
  };
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'error');
});

// ---- tick: the default avatar, the request, the throttle --------------------------------

test('tick: a default avatar is stored without any request or download', async () => {
  const { queue, store, llm, imageFetcher, log } = setup();
  queue.offer(GUILD, view('u1', null));
  assert.equal(await queue.tick(), 'idle');
  assert.deepEqual(store.users.get('u1').avatar, { hash: null, default: true });
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: described' && entry.default === true));
});

test('tick: one vision request on purpose avatar, the prompt filled, one clamped line stored', async () => {
  const long = `a fox in a red scarf ${'and more '.repeat(40)}\nsecond line`;
  const { queue, store, llm, imageFetcher, state, log } = setup({ llm: fakeLlm(long), hot: fakeHot({ avatars: { descriptionChars: 60 } }) });
  queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'described');
  assert.equal(imageFetcher.calls.length, 1);
  assert.deepEqual(imageFetcher.calls[0].options, { maxBytes: 1000, timeoutMs: 500 });
  assert.equal(llm.calls.length, 1);
  const [{ messages, options }] = llm.calls;
  assert.equal(messages[0].content, 'Describe the avatar in at most 60 characters.');
  assert.deepEqual(messages[1].content, [{ type: 'image_url', image_url: { url: DOWNLOAD.dataUrl } }]);
  assert.equal(options.model, 'v/model');
  assert.equal(options.role, 'vision');
  assert.equal(options.purpose, 'avatar');
  assert.equal(options.countAgainstDailyCap, true);
  const stored = store.users.get('u1').avatar;
  assert.equal(stored.hash, 'h1');
  assert.ok(stored.text.startsWith('a fox in a red scarf'));
  assert.ok(Array.from(stored.text).length <= 60, stored.text);
  assert.ok(!stored.text.includes('second line'));
  assert.equal(stored.describedAt, new Date(NOW).toISOString());
  assert.equal(state.data[AVATAR_DAILY.countKey], 1);
  assert.ok(state.dirty > 0);
  // Counts and codes only: never the text or the url.
  const described = log.entries.find((entry) => entry.msg === 'avatars: described');
  assert.ok(described);
  assert.ok(!JSON.stringify(log.entries).includes('fox'));
  assert.ok(!JSON.stringify(log.entries).includes('cdn.example'));
});

test('tick: one request at a time, avatars.intervalMs apart on the injected clock', async () => {
  const now = clock();
  const { queue, llm, hot } = setup({ profiles: { u1: {}, u2: {}, u3: {} }, now });
  for (const id of ['u1', 'u2', 'u3']) queue.offer(GUILD, view(id, `h-${id}`));
  assert.equal(await queue.tick(), 'described');
  assert.equal(await queue.tick(), 'wait');
  now.advance(19_999);
  assert.equal(await queue.tick(), 'wait');
  now.advance(1);
  assert.equal(await queue.tick(), 'described');
  assert.equal(llm.calls.length, 2);
  // The interval is read at the moment of use: a hot change applies at the next tick.
  assert.equal(await queue.tick(), 'wait');
  hot.config.avatars.intervalMs = 5_000;
  now.advance(5_000);
  assert.equal(await queue.tick(), 'described');
  assert.equal(llm.calls.length, 3);
});

test('tick: a second tick while a request runs does not start another', async () => {
  let release;
  const llm = fakeLlm();
  llm.complete = async (messages, options) => {
    llm.calls.push({ messages, options });
    await new Promise((resolve) => {
      release = resolve;
    });
    return { text: 'a fox', usage: null, estimated: 0 };
  };
  const { queue } = setup({ profiles: { u1: {}, u2: {} }, llm });
  queue.offer(GUILD, view('u1', 'h1'));
  queue.offer(GUILD, view('u2', 'h2'));
  const first = queue.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await queue.tick(), 'busy');
  release();
  assert.equal(await first, 'described');
  assert.equal(llm.calls.length, 1);
});

test('tick: avatars.maxPerDay stops the requests until the UTC day turns, the queue kept', async () => {
  const now = clock();
  const state = fakeState({ [AVATAR_DAILY.dayKey]: '2026-10-15', [AVATAR_DAILY.countKey]: 2 });
  const { queue, llm, log } = setup({ profiles: { u1: {}, u2: {} }, now, state, hot: fakeHot({ avatars: { maxPerDay: 2, intervalMs: 0 } }) });
  queue.offer(GUILD, view('u1', 'h1'));
  queue.offer(GUILD, view('u2', null));
  // The default avatar costs nothing and goes through even with the cap spent.
  assert.equal(await queue.tick(), 'avatar-cap');
  assert.equal(await queue.tick(), 'avatar-cap');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(queue.pending(), ['u1']);
  assert.equal(log.entries.filter((entry) => entry.msg === 'avatars: skipped' && entry.reason === 'avatar-cap').length, 1, 'logged once a day');
  now.advance(12 * 3_600_000);
  assert.equal(await queue.tick(), 'described');
  assert.equal(state.data[AVATAR_DAILY.dayKey], '2026-10-16');
  assert.equal(state.data[AVATAR_DAILY.countKey], 1);
});

test('tick: a missing or broken avatars.maxPerDay refuses (fail closed)', async () => {
  const { queue, llm } = setup({ hot: fakeHot({ avatars: { maxPerDay: 'many' } }) });
  queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'avatar-cap');
  assert.equal(llm.calls.length, 0);
});

test('tick: with llm.maxRequestsPerDay spent nothing is downloaded or sent', async () => {
  const llm = fakeLlm();
  llm.capLeft = () => 0;
  const { queue, imageFetcher } = setup({ llm });
  queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'daily-cap');
  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(queue.pending(), ['u1']);
});

test('tick: a failed one is dropped and offered again only after the next scan, no tight loop', async () => {
  const now = clock();
  const members = { u1: view('u1', 'h1') };
  const { queue, llm, store, log } = setup({ now, members, llm: fakeLlm(new Error('provider down')), hot: fakeHot({ avatars: { intervalMs: 0 } }) });
  queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'failed');
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: skipped' && entry.reason === 'llm-error'));
  assert.equal(store.users.get('u1').avatar, undefined);
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'failed', 'a message from the member does not retry it');
  assert.equal(await queue.tick(), 'idle');
  assert.equal(llm.calls.length, 1);
  // A new avatar is a new version: offered at once.
  assert.equal(queue.offer(GUILD, view('u1', 'h9')), 'queued');
  // The next scan retries the failed version (the member's avatar is h1 again by then).
  await queue.scan(GUILD);
  assert.deepEqual(queue.pending(), ['u1']);
  assert.equal(await queue.tick(), 'failed');
  assert.equal(llm.calls.length, 2);
});

test('tick: a failed download is no request', async () => {
  const { queue, llm, log } = setup({ imageFetcher: fakeFetcher(null) });
  queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'failed');
  assert.equal(llm.calls.length, 0);
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: skipped' && entry.reason === 'download'));
});

test('tick: an item whose profile went or whose avatar is current by now is dropped without a request', async () => {
  const { queue, store, llm } = setup({ profiles: { u1: {}, u2: {} } });
  queue.offer(GUILD, view('u1', 'h1'));
  queue.offer(GUILD, view('u2', 'h2'));
  store.users.delete('u1');
  store.users.get('u2').avatar = { hash: 'h2', text: 'cat', describedAt: null };
  assert.equal(await queue.tick(), 'idle');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(queue.pending(), []);
});

test('tick: off, paused or without a guild it does nothing', async () => {
  const off = setup({ hot: fakeHot({ features: { avatars: false } }) });
  assert.equal(await off.queue.tick(), 'off');
  const paused = setup({ paused: true });
  paused.queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await paused.queue.tick(), 'paused');
  assert.equal(paused.llm.calls.length, 0);
});

// ---- the scan ---------------------------------------------------------------------------

test('scan: every profiled member whose avatar differs is queued; bots, the persona and members gone are not', async () => {
  const members = {
    u1: view('u1', 'h1'),
    u2: view('u2', 'h2'),
    u3: view('u3', null),
    b1: view('b1', 'hb', { bot: true }),
    [SELF]: view(SELF, 'hs'),
  };
  const { queue, log } = setup({
    profiles: { u1: {}, u2: { avatar: { hash: 'h2', text: 'cat', describedAt: null } }, u3: {}, b1: {}, gone: {}, [SELF]: {} },
    members,
  });
  const counts = await queue.scan(GUILD);
  assert.deepEqual(queue.pending(), ['u1', 'u3']);
  assert.deepEqual(counts, { profiles: 6, queued: 2, gone: 1 });
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: scanned' && entry.queued === 2));
});

test('tick: scans on its first run and again a day later, never in between', async () => {
  const now = clock();
  const members = { u1: view('u1', null) };
  const { queue, store, hot } = setup({ members, now });
  await queue.tick();
  assert.equal(queue.scansStarted(), 1);
  assert.deepEqual(store.users.get('u1').avatar, { hash: null, default: true });
  now.advance(3_600_000);
  await queue.tick();
  assert.equal(queue.scansStarted(), 1);
  now.advance(23 * 3_600_000);
  await queue.tick();
  assert.equal(queue.scansStarted(), 2);
  // Off, no scan is started; on again later, the scan is due at once.
  hot.config.features.avatars = false;
  now.advance(25 * 3_600_000);
  await queue.tick();
  assert.equal(queue.scansStarted(), 2);
  hot.config.features.avatars = true;
  await queue.tick();
  assert.equal(queue.scansStarted(), 3);
});

test('scan: a resolver that throws for one member does not stop the others', async () => {
  const { queue, store } = setup({ profiles: { u1: {}, u2: {} } });
  const resolved = [];
  const failing = createAvatarQueue({
    hot: fakeHot(),
    store,
    llm: fakeLlm(),
    imageFetcher: fakeFetcher(),
    state: fakeState(),
    now: clock(),
    log: fakeLog(),
    getGuildId: () => GUILD,
    selfId: () => SELF,
    paused: () => false,
    resolveMember: async (guildId, id) => {
      resolved.push(id);
      if (id === 'u1') throw new Error('rest');
      return view(id, 'h2');
    },
  });
  const counts = await failing.scan(GUILD);
  assert.deepEqual(resolved, ['u1', 'u2']);
  assert.deepEqual(failing.pending(), ['u2']);
  assert.equal(counts.gone, 1);
  assert.deepEqual(queue.pending(), []);
});

// ---- the store's write path -------------------------------------------------------------

test('store.setAvatar: writes the current avatar only into an existing profile, replaces it, normalised on read', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP_ROOT, 'store-'));
  const store = createStore({ dataDir });
  assert.equal(store.setAvatar(GUILD, 'u1', { hash: 'h1', text: 'fox', describedAt: null }), null, 'never creates a profile');
  assert.equal(store.getUser(GUILD, 'u1'), null);
  store.touchUser(GUILD, 'u1', 'Ελένη', NOW);
  const before = store.getUser(GUILD, 'u1').updatedAt;
  store.setAvatar(GUILD, 'u1', { hash: 'h1', text: 'a fox', describedAt: '2026-10-15T12:00:00.000Z' });
  store.setAvatar(GUILD, 'u1', { hash: 'h2', text: 'a cat', describedAt: '2026-10-16T12:00:00.000Z' });
  assert.deepEqual(store.getUser(GUILD, 'u1').avatar, { hash: 'h2', text: 'a cat', describedAt: '2026-10-16T12:00:00.000Z' });
  assert.equal(store.getUser(GUILD, 'u1').updatedAt, before, 'the portrait version stamp is untouched');
  store.setAvatar(GUILD, 'u1', { hash: null, default: true });
  assert.deepEqual(store.getUser(GUILD, 'u1').avatar, { hash: null, default: true });
  store.flush();
  // A hand-broken field is dropped on read; an absent one stays absent.
  const file = path.join(dataDir, 'guilds', GUILD, 'users', 'u1.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, avatar: { hash: 'h3' } }));
  const fresh = createStore({ dataDir });
  assert.equal('avatar' in fresh.getUser(GUILD, 'u1'), false);
});
