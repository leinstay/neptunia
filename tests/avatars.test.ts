// Tests for src/memory/avatars.ts and src/memory/avatar-queue.ts: which member is due, the hash change, the default avatar
// without a request, the throttled queue on an injected clock, the stored field's
// normalisation, and the store's write path for it. Fakes only: no network, no real data/.
import { accountOf } from '../src/memory/addresses.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isAvatarDue, normalizeAvatar } from '../src/memory/avatars.ts';
import { createAvatarQueue } from '../src/memory/avatar-queue.ts';
import { VISION_MAX_BYTES } from '../src/media/fetch-image.ts';
import { createStore } from '../src/memory/store.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemory, unitFile } from './fixtures/memory-db/service.ts';
import type { Untyped } from '../src/tools/types.ts';
import type { Reads } from '../src/interface/reads.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const GUILD = 'g1';
const SELF = 'self-1';
const PROMPT = 'Describe the avatar in at most {{maxChars}} characters.';
// The fake holds only the part of the real object that the code under test reads, so it is cast once, here.
const fakeOf = <T>(value: object): T => value as T;

const DOWNLOAD = { dataUrl: 'data:image/png;base64,ZmFrZQ==', bytes: 4, contentType: 'image/png' };

const TMP_ROOT = tempDir('nep-avatars-');
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

function clock(start = NOW) {
  let t = start;
  const now = () => t;
  now.advance = (ms: number) => {
    t += ms;
  };
  return now;
}

// PR 7d: the switch is code, the daily cap is gone and the interval (20 s), the description length (200) and the
// download bound are constants, so the hot config holds only the keys that are still settings.
function fakeHot({ prompts = {} } = {}) {
  return {
    config: {
      context: { vision: { fetchTimeoutMs: 500 } },
      media: { maxOutputTokens: 300 },
      models: { base: { vision: 'v/model' } },
    },
    prompts: { avatar: PROMPT, ...prompts },
  };
}

/** An in-memory store with the profile accessors the queue uses. */
type Rec = Record<string, Untyped>;
type Member = { id: string; bot: boolean; hash: string | null; url: string | null };

function fakeStore(profiles: Record<string, Untyped> = {}) {
  const users = new Map<string, Rec>(
    Object.entries(profiles).map(([id, profile]) => [id, { id, names: [id], ...profile }])
  );
  const writes: Array<Rec> = [];
  return {
    users,
    writes,
    getUser: (id: string) => users.get(id) ?? null,
    listUserProfiles: () => [...users.values()],
    setAvatar(id: string, avatar: Untyped) {
      const profile = users.get(id);
      if (!profile) return null;
      profile.avatar = normalizeAvatar(avatar);
      writes.push({ id, avatar: profile.avatar });
      return profile;
    },
  };
}

// A profile of the fake store; a missing one reads as an empty record, so the assertion on its avatar fails.
const profileOf = (store: ReturnType<typeof fakeStore>, id: string): Rec => store.users.get(id) ?? {};

function fakeLlm(answer: string | Error | (() => string) = 'an illustrated fox with a scarf') {
  const calls: Array<{ messages: Array<Rec>; options: Rec }> = [];
  return {
    calls,
    capLeft: () => 100,
    complete: (messages: Array<Rec>, options: Rec) => {
      calls.push({ messages, options });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ text: typeof answer === 'function' ? answer() : answer, usage: null, estimated: 0 });
    },
  };
}

function fakeFetcher(result: typeof DOWNLOAD | null = DOWNLOAD) {
  const calls: Array<{ url: string; options: Rec }> = [];
  return {
    calls,
    fetchAsDataUrl: (url: string, options: Rec) => {
      calls.push({ url, options });
      return Promise.resolve(result);
    },
  };
}

function fakeState(data = {}) {
  return {
    data,
    dirty: 0,
    markDirty() {
      this.dirty += 1;
    },
  };
}

function fakeLog() {
  const entries: Array<Rec> = [];
  const push = (level: string) => (msg: string, meta?: object) => entries.push({ level, msg, ...meta });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function view(id: string, hash: Untyped, extra = {}) {
  return {
    id,
    bot: false,
    hash,
    url: hash ? `https://cdn.example/avatars/${id}/${hash}.png?size=256` : null,
    ...extra,
  };
}

/**
 * The core's reads over `members` (id -> view): `memberInfo` answers the member and their avatar, or a member who is not one.
 */
function readsOf(members: Record<string, Member | 'failed'>, asked: Array<string> = []) {
  return fakeOf<Reads>({
    memberInfo: ({ accountId }: { accountId: string }) => {
      asked.push(accountId);
      const found = members[accountId];
      if (found === 'failed') return Promise.resolve(null);
      return Promise.resolve({
        member: found
          ? {
              id: found.id,
              name: null,
              bot: found.bot,
              groupIds: [],
              avatar: { hash: found.hash, url: found.url, largeUrl: null },
            }
          : null,
      });
    },
  });
}

function setup({
  profiles = { u1: {} } as Record<string, Untyped>,
  hot = fakeHot(),
  llm = fakeLlm(),
  imageFetcher = fakeFetcher(),
  state = fakeState(),
  now = clock(),
  members = {},
  paused = false,
} = {}) {
  const store = fakeStore(profiles);
  const log = fakeLog();
  const queue = createAvatarQueue({
    hot,
    store,
    llm,
    imageFetcher,
    // @ts-expect-error: createAvatarQueue takes no `state` dependency, so the key is ignored
    state,
    now,
    log,
    isServedCommunity: (id: unknown) => id === GUILD,
    servedPlaces: () => [GUILD],
    selfId: () => SELF,
    paused: () => paused,
    reads: readsOf(members),
  });
  return { queue, store, llm, imageFetcher, state, now, log, hot };
}

// ---- pure parts -------------------------------------------------------------------------

test('normalizeAvatar: a described avatar, the default one, anything else is no field', () => {
  assert.deepEqual(
    normalizeAvatar({ hash: 'h1', text: ' a  red\nfox ', describedAt: '2026-10-15T12:00:00.000Z', extra: 1 }),
    {
      hash: 'h1',
      text: 'a red fox',
      describedAt: '2026-10-15T12:00:00.000Z',
    }
  );
  assert.deepEqual(normalizeAvatar({ hash: null, default: true }), { hash: null, default: true });
  assert.deepEqual(normalizeAvatar({ hash: 'h1', text: 'fox', describedAt: 'not a date' }), {
    hash: 'h1',
    text: 'fox',
    describedAt: null,
  });
  for (const broken of [
    null,
    'fox',
    [],
    {},
    { hash: 'h1' },
    { hash: 'h1', text: '   ' },
    { hash: '', text: 'fox' },
    { hash: null },
    { default: 'yes' },
  ]) {
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
  const { queue, store } = setup({
    profiles: { u1: {}, u2: { avatar: { hash: 'h2', text: 'cat', describedAt: null } }, [SELF]: {}, b1: {} },
  });
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'queued');
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'queued', 'the same offer again keeps one item');
  assert.equal(queue.offer(GUILD, view('u2', 'h2')), 'current');
  assert.equal(queue.offer(GUILD, view('u2', 'h3')), 'queued');
  assert.equal(queue.offer(GUILD, view('nobody', 'h4')), 'no-profile');
  assert.equal(queue.offer(GUILD, view(SELF, 'h5')), 'self');
  assert.equal(queue.offer(GUILD, view('b1', 'h6', { bot: true })), 'bot');
  assert.equal(queue.offer('other', view('u1', 'h1')), 'other-place');
  assert.equal(queue.offer(GUILD, null), 'invalid');
  assert.deepEqual(queue.pending(), ['u1', 'u2']);
  assert.equal(store.writes.length, 0, 'an offer never writes');
});

test('offer: with the prompt missing nothing is queued', () => {
  const { queue } = setup({ hot: fakeHot({ prompts: { avatar: '' } }) });
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'off');
  assert.deepEqual(queue.pending(), []);
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
  assert.deepEqual(profileOf(store, 'u1').avatar, { hash: null, default: true });
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: described' && entry.default === true));
});

test('tick: one vision request on purpose avatar, the prompt filled, one clamped line stored', async () => {
  const long = `a fox in a red scarf ${'and more '.repeat(40)}\nsecond line`;
  const { queue, store, llm, imageFetcher, log } = setup({ llm: fakeLlm(long) });
  queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'described');
  assert.equal(imageFetcher.calls.length, 1);
  assert.deepEqual(imageFetcher.calls[0].options, { maxBytes: VISION_MAX_BYTES, timeoutMs: 500 });
  assert.equal(llm.calls.length, 1);
  const [{ messages, options }] = llm.calls;
  assert.equal(messages[0].content, 'Describe the avatar in at most 200 characters.');
  assert.deepEqual(messages[1].content, [{ type: 'image_url', image_url: { url: DOWNLOAD.dataUrl } }]);
  assert.equal(options.model, 'v/model');
  assert.equal(options.role, 'vision');
  assert.equal(options.purpose, 'avatar');
  assert.equal(options.countAgainstDailyCap, true);
  const stored = profileOf(store, 'u1').avatar as { hash: string; text: string; describedAt: string };
  assert.equal(stored.hash, 'h1');
  assert.ok(stored.text.startsWith('a fox in a red scarf'));
  assert.ok(Array.from(stored.text).length <= 200, stored.text);
  assert.ok(!stored.text.includes('second line'));
  assert.equal(stored.describedAt, new Date(NOW).toISOString());
  // Counts and codes only: never the text or the url.
  const described = log.entries.find((entry) => entry.msg === 'avatars: described');
  assert.ok(described);
  assert.ok(!JSON.stringify(log.entries).includes('fox'));
  assert.ok(!JSON.stringify(log.entries).includes('cdn.example'));
});

test('tick: one request at a time, 20 s apart on the injected clock', async () => {
  const now = clock();
  const { queue, llm } = setup({ profiles: { u1: {}, u2: {}, u3: {} }, now });
  for (const id of ['u1', 'u2', 'u3']) queue.offer(GUILD, view(id, `h-${id}`));
  assert.equal(await queue.tick(), 'described');
  assert.equal(await queue.tick(), 'wait');
  now.advance(19_999);
  assert.equal(await queue.tick(), 'wait');
  now.advance(1);
  assert.equal(await queue.tick(), 'described');
  assert.equal(llm.calls.length, 2);
});

test('tick: a second tick while a request runs does not start another', async () => {
  let release: () => void = () => {};
  const llm = fakeLlm();
  llm.complete = async (messages, options) => {
    llm.calls.push({ messages, options });
    await new Promise<void>((resolve) => {
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
  const { queue, llm, store, log } = setup({
    now,
    members,
    llm: fakeLlm(new Error('provider down')),
  });
  queue.offer(GUILD, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'failed');
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: skipped' && entry.reason === 'llm-error'));
  assert.equal(profileOf(store, 'u1').avatar, undefined);
  assert.equal(queue.offer(GUILD, view('u1', 'h1')), 'failed', 'a message from the member does not retry it');
  assert.equal(await queue.tick(), 'idle');
  assert.equal(llm.calls.length, 1);
  // A new avatar is a new version: offered at once.
  assert.equal(queue.offer(GUILD, view('u1', 'h9')), 'queued');
  // The next scan retries the failed version (the member's avatar is h1 again by then).
  await queue.scan(GUILD);
  assert.deepEqual(queue.pending(), ['u1']);
  now.advance(20_000);
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
  profileOf(store, 'u2').avatar = { hash: 'h2', text: 'cat', describedAt: null };
  assert.equal(await queue.tick(), 'idle');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(queue.pending(), []);
});

test('tick: paused it does nothing', async () => {
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
    profiles: {
      u1: {},
      u2: { avatar: { hash: 'h2', text: 'cat', describedAt: null } },
      u3: {},
      b1: {},
      gone: {},
      [SELF]: {},
    },
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
  const { queue, store } = setup({ members, now });
  await queue.tick();
  assert.equal(queue.scansStarted(), 1);
  assert.deepEqual(profileOf(store, 'u1').avatar, { hash: null, default: true });
  now.advance(3_600_000);
  await queue.tick();
  assert.equal(queue.scansStarted(), 1);
  now.advance(23 * 3_600_000);
  await queue.tick();
  assert.equal(queue.scansStarted(), 2);
});

// A read that fails reaches the queue as no answer (src/interface/reads.ts): the member counts as gone.
test('scan: a member whose read fails is counted gone and does not stop the others', async () => {
  const { queue, store } = setup({ profiles: { u1: {}, u2: {} } });
  const resolved: Array<Untyped> = [];
  const failing = createAvatarQueue({
    hot: fakeHot(),
    store,
    llm: fakeLlm(),
    imageFetcher: fakeFetcher(),
    // @ts-expect-error: createAvatarQueue takes no `state` dependency, so the key is ignored
    state: fakeState(),
    now: clock(),
    log: fakeLog(),
    isServedCommunity: (id: unknown) => id === GUILD,
    servedPlaces: () => [GUILD],
    selfId: () => SELF,
    paused: () => false,
    reads: readsOf({ u1: 'failed', u2: view('u2', 'h2') }, resolved),
  });
  const counts = await failing.scan(GUILD);
  assert.deepEqual(resolved, ['u1', 'u2']);
  assert.deepEqual(failing.pending(), ['u2']);
  assert.equal(counts.gone, 1);
  assert.deepEqual(queue.pending(), []);
});

// ---- the store's write path -------------------------------------------------------------

test('store.setAvatar: writes the current avatar only into an existing profile, replaces it, normalised on read', async () => {
  const mem = await openTestMemory({ dataDir: fs.mkdtempSync(path.join(TMP_ROOT, 'store-')) });
  const { dataDir, memoryDb } = mem;
  const store = createStore({ dataDir, memoryDb });
  assert.equal(
    store.setAvatar(accountOf(store, 'u1'), { hash: 'h1', text: 'fox', describedAt: null }),
    null,
    'never creates a profile'
  );
  assert.equal(store.getUser(accountOf(store, 'u1')), null);
  store.touchUser(accountOf(store, 'u1'), 'Ελένη', NOW);
  const before = loose(store.getUser(accountOf(store, 'u1'))).updatedAt;
  store.setAvatar(accountOf(store, 'u1'), { hash: 'h1', text: 'a fox', describedAt: '2026-10-15T12:00:00.000Z' });
  store.setAvatar(accountOf(store, 'u1'), { hash: 'h2', text: 'a cat', describedAt: '2026-10-16T12:00:00.000Z' });
  assert.deepEqual(loose(store.getUser(accountOf(store, 'u1'))).avatar, {
    hash: 'h2',
    text: 'a cat',
    describedAt: '2026-10-16T12:00:00.000Z',
  });
  assert.equal(
    loose(store.getUser(accountOf(store, 'u1'))).updatedAt,
    before,
    'the portrait version stamp is untouched'
  );
  store.setAvatar(accountOf(store, 'u1'), { hash: null, default: true });
  assert.deepEqual(loose(store.getUser(accountOf(store, 'u1'))).avatar, { hash: null, default: true });
  store.flush();
  await store.flushSettled({});
  // A hand-broken field is dropped on read; an absent one stays absent.
  const owner = `guilds/${GUILD}/users/u1.json`;
  // @ts-expect-error: unitFile is null only for a file that was never written, and the test wrote this one
  const raw = JSON.parse(unitFile(memoryDb, owner));
  await memoryDb.writeUnit({ op: 'value', owner, value: { ...raw, avatar: { hash: 'h3' } } });
  const fresh = createStore({ dataDir, memoryDb });
  assert.equal('avatar' in loose(fresh.getUser(accountOf(fresh, 'u1'))), false);
  await mem.close();
});
