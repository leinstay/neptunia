// Tests for src/memory/avatar-queue.ts: which member is queued on a hash change, the default avatar without a request,
// the throttled queue on an injected clock and the scan. The first part uses fakes for the store, the model, the image
// download and the interface's reads. The second part finds members and their pictures through the interface's
// `memberInfo` read on the fake adapter: one member of the root, with the hash and the address of their avatar, or null
// when they are not a member. A scan offers every profiled member with the answer, and the queue then describes each
// new avatar once from the address the answer carried. No network, no real data/.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAvatar } from '../../../src/memory/avatars.ts';
import { createAvatarQueue } from '../../../src/memory/avatar-queue.ts';
import { VISION_MAX_BYTES } from '../../../src/media/fetch-image.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import type { Reads } from '../../../src/interface/reads.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { ROOT as RIG_ROOT, SELF_ID, member, rig } from '../../fixtures/reads-rig.ts';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT as REPO_ROOT } from '../../fixtures/source-tree.ts';
import { joinLabels } from '../../../src/config/labels.ts';
import { deepMerge } from '../../../src/config.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { labels as contractLabels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { loose } from '../../fixtures/as-options.ts';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const ROOT = 'g1';
const SELF = 'self-1';
const PROMPT = 'Describe the avatar in at most {{maxChars}} characters.';
// The fake holds only the part of the real object that the code under test reads, so it is cast once, here.
const fakeOf = <T>(value: object): T => value as T;

const DOWNLOAD = { dataUrl: 'data:image/png;base64,ZmFrZQ==', bytes: 4, contentType: 'image/png' };

function clock(start = NOW) {
  let t = start;
  const now = () => t;
  now.advance = (ms: number) => {
    t += ms;
  };
  return now;
}

// The switch is code, and the interval (20 s), the description length (200) and the download bound are constants,
// so the hot config holds only the keys that are settings.
function fakeHot({ prompts = {} } = {}) {
  return {
    config: {
      context: { vision: { fetchTimeoutMs: 500 } },
      media: { maxOutputTokens: 300 },
      models: { routes: chainsOf({ vision: 'v/model' }) },
    },
    prompts: { 'describe/avatar': PROMPT, ...prompts },
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

/** The stored description of u1's avatar, or undefined when none is stored. */
function avatarText(store: ReturnType<typeof fakeStore>): unknown {
  const avatar: unknown = profileOf(store, 'u1').avatar;
  return avatar && typeof avatar === 'object' && 'text' in avatar ? avatar.text : undefined;
}

/** The summarizer as the avatar describer calls it: a picture's description over its limit, retold once. */
type AvatarSummarize = (text: string, options: { maxChars: number; kind: 'picture' }) => Promise<string>;

function setup({
  profiles = { u1: {} } as Record<string, Untyped>,
  hot = fakeHot(),
  llm = fakeLlm(),
  imageFetcher = fakeFetcher(),
  state = fakeState(),
  now = clock(),
  members = {},
  paused = false,
  summarize = null as AvatarSummarize | null,
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
    isServedRoot: (id: unknown) => id === ROOT,
    servedPlaces: () => [ROOT],
    selfId: () => SELF,
    paused: () => paused,
    reads: readsOf(members),
    ...(summarize ? { summarize } : {}),
  });
  return { queue, store, llm, imageFetcher, state, now, log, hot };
}

// ---- offer: who is queued ---------------------------------------------------------------

// A bot is a person to the persona, so a bot's avatar is offered like a member's.
test('offer: only a profiled member of the served root, never the persona, and only on a hash change', () => {
  const { queue, store } = setup({
    profiles: { u1: {}, u2: { avatar: { hash: 'h2', text: 'cat', describedAt: null } }, [SELF]: {}, b1: {} },
  });
  assert.equal(queue.offer(ROOT, view('u1', 'h1')), 'queued');
  assert.equal(queue.offer(ROOT, view('u1', 'h1')), 'queued', 'the same offer again keeps one item');
  assert.equal(queue.offer(ROOT, view('u2', 'h2')), 'current');
  assert.equal(queue.offer(ROOT, view('u2', 'h3')), 'queued');
  assert.equal(queue.offer(ROOT, view('nobody', 'h4')), 'no-profile');
  assert.equal(queue.offer(ROOT, view(SELF, 'h5')), 'self');
  assert.equal(queue.offer(ROOT, view('b1', 'h6', { bot: true })), 'queued');
  assert.equal(queue.offer('other', view('u1', 'h1')), 'other-place');
  assert.equal(queue.offer(ROOT, null), 'invalid');
  assert.deepEqual(queue.pending(), ['u1', 'u2', 'b1']);
  assert.equal(store.writes.length, 0, 'an offer never writes');
});

test('offer: with the prompt missing nothing is queued', () => {
  const { queue } = setup({ hot: fakeHot({ prompts: { 'describe/avatar': '' } }) });
  assert.equal(queue.offer(ROOT, view('u1', 'h1')), 'off');
  assert.deepEqual(queue.pending(), []);
});

test('offer: a store that throws never escapes into the gateway handler', () => {
  const { queue, store } = setup();
  store.getUser = () => {
    throw new Error('disk');
  };
  assert.equal(queue.offer(ROOT, view('u1', 'h1')), 'error');
});

// ---- tick: the default avatar, the request, the throttle --------------------------------

test('tick: a default avatar is stored without any request or download', async () => {
  const { queue, store, llm, imageFetcher, log } = setup();
  queue.offer(ROOT, view('u1', null));
  assert.equal(await queue.tick(), 'idle');
  assert.deepEqual(profileOf(store, 'u1').avatar, { hash: null, default: true });
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: described' && entry.default === true));
});

// No text the persona reads is cut silently.
test('tick: one vision request on purpose avatar, the prompt filled, the whole answer stored on one line when it fits', async () => {
  const { queue, store, llm, imageFetcher, log } = setup({ llm: fakeLlm('a fox in a red scarf\nsecond line') });
  queue.offer(ROOT, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'described');
  assert.equal(imageFetcher.calls.length, 1);
  const firstFetch = imageFetcher.calls[0];
  assert.deepEqual(firstFetch.options, { maxBytes: VISION_MAX_BYTES, timeoutMs: 500 });
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
  assert.equal(stored.text, 'a fox in a red scarf second line');
  assert.equal(stored.describedAt, new Date(NOW).toISOString());
  // Counts and codes only: never the text or the url.
  const described = log.entries.find((entry) => entry.msg === 'avatars: described');
  assert.ok(described);
  assert.ok(!JSON.stringify(log.entries).includes('fox'));
  assert.ok(!JSON.stringify(log.entries).includes('cdn.example'));
});

// No text the persona reads is cut silently.
test('tick: an answer over 200 characters goes to summarize once as a picture and its answer is stored', async () => {
  const long = `a fox in a red scarf ${'and more '.repeat(40)}`;
  const calls: Array<{ text: string; options: { maxChars: number; kind: 'picture' } }> = [];
  const summarize: AvatarSummarize = (text, options) => {
    calls.push({ text, options });
    return Promise.resolve('a fox in a red scarf');
  };
  const { queue, store } = setup({ llm: fakeLlm(long), summarize });
  queue.offer(ROOT, view('u1', 'h1'));
  await queue.tick();
  assert.deepEqual(
    calls.map((one) => one.options),
    [{ maxChars: 200, kind: 'picture' }]
  );
  assert.equal(avatarText(store), 'a fox in a red scarf');
});

// No text the persona reads is cut silently.
test('tick: a summary still over 200 characters is stored whole', async () => {
  const still = `a fox in a red scarf ${'and still more '.repeat(30)}`.trim();
  const { queue, store } = setup({
    llm: fakeLlm(`a fox ${'and more '.repeat(40)}`),
    summarize: () => Promise.resolve(still),
  });
  queue.offer(ROOT, view('u1', 'h1'));
  await queue.tick();
  assert.equal(avatarText(store), still);
});

test('tick: one request at a time, 20 s apart on the injected clock', async () => {
  const now = clock();
  const { queue, llm } = setup({ profiles: { u1: {}, u2: {}, u3: {} }, now });
  for (const id of ['u1', 'u2', 'u3']) queue.offer(ROOT, view(id, `h-${id}`));
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
  queue.offer(ROOT, view('u1', 'h1'));
  queue.offer(ROOT, view('u2', 'h2'));
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
  queue.offer(ROOT, view('u1', 'h1'));
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
  queue.offer(ROOT, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'failed');
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: skipped' && entry.reason === 'llm-error'));
  assert.equal(profileOf(store, 'u1').avatar, undefined);
  assert.equal(queue.offer(ROOT, view('u1', 'h1')), 'failed', 'a message from the member does not retry it');
  assert.equal(await queue.tick(), 'idle');
  assert.equal(llm.calls.length, 1);
  // A new avatar is a new version: offered at once.
  assert.equal(queue.offer(ROOT, view('u1', 'h9')), 'queued');
  // The next scan retries the failed version (the member's avatar is h1 again by then).
  await queue.scan(ROOT);
  assert.deepEqual(queue.pending(), ['u1']);
  now.advance(20_000);
  assert.equal(await queue.tick(), 'failed');
  assert.equal(llm.calls.length, 2);
});

test('tick: a failed download is no request', async () => {
  const { queue, llm, log } = setup({ imageFetcher: fakeFetcher(null) });
  queue.offer(ROOT, view('u1', 'h1'));
  assert.equal(await queue.tick(), 'failed');
  assert.equal(llm.calls.length, 0);
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: skipped' && entry.reason === 'download'));
});

test('tick: an item whose profile went or whose avatar is current by now is dropped without a request', async () => {
  const { queue, store, llm } = setup({ profiles: { u1: {}, u2: {} } });
  queue.offer(ROOT, view('u1', 'h1'));
  queue.offer(ROOT, view('u2', 'h2'));
  store.users.delete('u1');
  profileOf(store, 'u2').avatar = { hash: 'h2', text: 'cat', describedAt: null };
  assert.equal(await queue.tick(), 'idle');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(queue.pending(), []);
});

test('tick: paused it does nothing', async () => {
  const paused = setup({ paused: true });
  paused.queue.offer(ROOT, view('u1', 'h1'));
  assert.equal(await paused.queue.tick(), 'paused');
  const pausedLlm = paused.llm;
  assert.equal(pausedLlm.calls.length, 0);
});

// ---- the scan ---------------------------------------------------------------------------

// A bot is a person to the persona, so a bot whose avatar differs is queued like a member.
test('scan: every profiled member whose avatar differs is queued, a bot too; the persona and members gone are not', async () => {
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
  const counts = await queue.scan(ROOT);
  assert.deepEqual(queue.pending(), ['u1', 'u3', 'b1']);
  assert.deepEqual(counts, { profiles: 6, queued: 3, gone: 1 });
  assert.ok(log.entries.some((entry) => entry.msg === 'avatars: scanned' && entry.queued === 3));
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
    isServedRoot: (id: unknown) => id === ROOT,
    servedPlaces: () => [ROOT],
    selfId: () => SELF,
    paused: () => false,
    reads: readsOf({ u1: 'failed', u2: view('u2', 'h2') }, resolved),
  });
  const counts = await failing.scan(ROOT);
  assert.deepEqual(resolved, ['u1', 'u2']);
  assert.deepEqual(failing.pending(), ['u2']);
  assert.equal(counts.gone, 1);
  assert.deepEqual(queue.pending(), []);
});

// ---- the interface's memberInfo read ----------------------------------------------------

type Profile = { id: string; names: Array<string>; avatar?: unknown };
const HASH = 'a1b2c3';
const URL_OF_U1 = 'https://cdn.example/avatars/u1/a1b2c3.png?size=256';

function rigSetup(options: { reads?: ReadonlyArray<string>; profiles?: Array<Profile> } = {}) {
  const world = rig(options.reads === undefined ? {} : { reads: options.reads });
  const places = [RIG_ROOT];
  const profiles = new Map((options.profiles ?? [{ id: 'u1', names: ['Eleni'] }]).map((p) => [p.id, p]));
  const written: Array<{ id: string; avatar: object }> = [];
  const fetched: Array<string> = [];
  const requests: Array<unknown> = [];
  const queue = createAvatarQueue({
    hot: {
      config: {
        features: { avatars: true },
        avatars: { intervalMs: 0, maxPerDay: 60, descriptionChars: 200 },
        context: { vision: { maxBytes: 1000, fetchTimeoutMs: 500 } },
        media: { maxOutputTokens: 300 },
        models: { routes: chainsOf({ vision: 'v/model' }) },
      },
      prompts: { 'describe/avatar': 'Describe the avatar in at most {{maxChars}} characters.' },
    },
    store: {
      getUser: (id: string) => profiles.get(id) ?? null,
      listUserProfiles: () => [...profiles.values()],
      setAvatar(id: string, avatar: object) {
        written.push({ id, avatar });
        return profiles.get(id) ?? null;
      },
    },
    llm: {
      capLeft: () => 100,
      complete: (messages: unknown) => {
        requests.push(messages);
        return Promise.resolve({ text: 'a scarf-wearing fox' });
      },
    },
    imageFetcher: {
      fetchAsDataUrl: (url: string) => {
        fetched.push(url);
        return Promise.resolve({ dataUrl: 'data:image/png;base64,ZmFrZQ==' });
      },
    },
    isServedRoot: (id: unknown) => typeof id === 'string' && places.includes(id),
    servedPlaces: () => places,
    selfId: () => SELF_ID,
    reads: world.reads,
    now: () => NOW,
    log: { info() {}, warn() {}, error() {} },
  });
  return { ...world, queue, written, fetched, requests, places };
}

test('asks the interface for each profiled member of the root and queues the one whose avatar changed', async () => {
  const { queue, fake, requests, asked } = rigSetup();
  fake.seedMember(RIG_ROOT, member('u1', 'Eleni', { avatar: { hash: HASH, url: URL_OF_U1, largeUrl: null } }));
  const counts = await queue.scan(RIG_ROOT);
  assert.deepEqual(counts, { profiles: 1, queued: 1, gone: 0 });
  assert.deepEqual(queue.pending(), ['u1']);
  assert.deepEqual(requests, []);
  assert.deepEqual(asked('memberInfo'), [{ placeId: RIG_ROOT, accountId: 'u1' }]);
});

test('counts a profiled person the interface does not know as a member as gone', async () => {
  const { queue, asked } = rigSetup();
  assert.deepEqual(await queue.scan(RIG_ROOT), { profiles: 1, queued: 0, gone: 1 });
  assert.deepEqual(queue.pending(), []);
  assert.deepEqual(asked('memberInfo'), [{ placeId: RIG_ROOT, accountId: 'u1' }]);
});

test('counts every profiled person as gone, with no round trip, when the interface does not offer the read', async () => {
  const { queue, asked } = rigSetup({ reads: ['messages.fetch'] });
  assert.deepEqual(await queue.scan(RIG_ROOT), { profiles: 1, queued: 0, gone: 1 });
  assert.deepEqual(asked('memberInfo'), []);
});

// A bot is a person to the persona, so its avatar is queued like a member's.
test('queues the avatar of an automated member like a member', async () => {
  const { queue, fake } = rigSetup();
  fake.seedMember(
    RIG_ROOT,
    member('u1', 'Birthdays', { bot: true, avatar: { hash: HASH, url: URL_OF_U1, largeUrl: null } })
  );
  assert.deepEqual(await queue.scan(RIG_ROOT), { profiles: 1, queued: 1, gone: 0 });
});

test('stores the default avatar of a member who has no picture, without a request', async () => {
  const { queue, fake, written, fetched } = rigSetup();
  fake.seedMember(RIG_ROOT, member('u1', 'Eleni'));
  await queue.scan(RIG_ROOT);
  assert.equal(await queue.tick(), 'idle');
  assert.deepEqual(written, [{ id: 'u1', avatar: { hash: null, default: true } }]);
  assert.deepEqual(fetched, []);
});

test('describes a new avatar once, from the address the interface gave and under the hash it gave', async () => {
  const { queue, fake, written, fetched, requests } = rigSetup();
  fake.seedMember(RIG_ROOT, member('u1', 'Eleni', { avatar: { hash: HASH, url: URL_OF_U1, largeUrl: null } }));
  await queue.scan(RIG_ROOT);
  assert.equal(await queue.tick(), 'described');
  assert.deepEqual(fetched, [URL_OF_U1]);
  assert.equal(requests.length, 1);
  assert.equal(written.length, 1);
  assert.deepEqual([written[0]?.id, (written[0]?.avatar as { hash: string; text: string }).hash], ['u1', HASH]);
});

test('the daily scan reads every place the interfaces serve, not only the first', async () => {
  // Bug: a member of the second server never gets an avatar, because only the first one is scanned.
  const { fake, asked, queue, places } = rigSetup();
  places.push('g2');
  fake.seedMember('g2', member('u1', 'Eleni', { avatar: { hash: HASH, url: URL_OF_U1, largeUrl: null } }));
  await queue.tick();
  assert.deepEqual(asked('memberInfo'), [
    { placeId: RIG_ROOT, accountId: 'u1' },
    { placeId: 'g2', accountId: 'u1' },
  ]);
});

const PROMPTS = path.join(REPO_ROOT, 'prompts');

const read = (name: string): string => fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');

// The platform and the server are named by the interface's own text. The avatar prompt is read in a chat on any
// interface, so it names no platform and no server.
test('describe/avatar.md names no platform and no server', () => {
  // Bug: a persona on another interface is told it lives on a Discord server.
  assert.deepEqual(read('describe/avatar').match(/\b(?:Discord|servers?)\b/gi) ?? [], []);
});

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];
const shippedCreateAvatarQueue = loose(createAvatarQueue);

// ---- the shipped layer --------------------------------------------------------

const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};
// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof contractLabels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

/** A live view over the shipped layer, the config overridden as given. */
function shippedHot(overrides: Record<string, unknown> = {}) {
  return { config: shippedConfig(overrides), prompts: SHIPPED.prompts };
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = requestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const SHIPPED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const GUILD = '600000000000000001';
const SHIPPED_SELF_ID = '900000000000000001';

/** A fake `llm.complete` recording every request and answering `answer(messages, options)`. */
function recordingLlm(answer: (messages: Array<{ content: unknown }>, options: { purpose?: string }) => unknown) {
  const calls: Array<{ messages: Array<{ content: unknown }>; options: { purpose?: string }; text: string }> = [];
  return {
    calls,
    complete: async (messages: Array<{ content: unknown }>, options: { purpose?: string } = {}) => {
      calls.push({ messages, options, text: requestText(messages) });
      const text = await answer(messages, options);
      return { text, usage: { prompt_tokens: 100, completion_tokens: 10 }, estimated: 100, finishReason: 'stop' };
    },
  };
}

describe('prompts shipped', () => {
  // The chats of the turns, the pipeline and the classifiers are held by a fake interface named `fake`, the
  // persona being `SELF_ID`; the recall runner keeps reading the platform's own objects through the recall bridge.
  // The turn world's interface and self id are module state of the fixture: set for these cases only.
  before(() => {
    useIface('fake');
    useSelf('900000000000000001');
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
  });

  test('createAvatarQueue: the avatar describer fills describe/avatar.md', async () => {
    const hot = shippedHot();
    const profile: { id: string; names: Array<string>; avatar?: { text: string } } = { id: 'u1', names: ['Ελένη'] };
    const store = {
      getUser: (id: string) => (id === 'u1' ? profile : null),
      listUserProfiles: () => [profile],
      setAvatar: (id: string, avatar: unknown) => Object.assign(profile, { avatar }),
    };
    const llm = recordingLlm(() => 'an illustrated fox in a scarf');
    const imageFetcher = {
      fetchAsDataUrl: async () => ({ dataUrl: 'data:image/png;base64,ZmFrZQ==', bytes: 4, contentType: 'image/png' }),
    };
    const state = { data: {}, markDirty() {} };
    const view = { id: 'u1', bot: false, hash: 'h1', url: 'https://cdn.example/avatars/u1/h1.png?size=256' };
    const queue = shippedCreateAvatarQueue({
      hot,
      store,
      llm,
      imageFetcher,
      state,
      isServedRoot: (id: unknown) => id === GUILD,
      servedPlaces: () => [GUILD],
      selfId: () => SHIPPED_SELF_ID,
      // The interface answers `memberInfo` with the member and the hash and address of their avatar.
      reads: {
        memberInfo: async () => ({
          member: {
            id: view.id,
            name: null,
            bot: view.bot,
            groupIds: [],
            avatar: { hash: view.hash, url: view.url, largeUrl: null },
          },
        }),
      },
      now: () => SHIPPED_NOW,
    });
    const { result } = await withCapturedLogs(() => queue.tick());
    assert.equal(result, 'described');
    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    assertFilled(firstCall.messages, { files: LOADS.avatar }, 'avatar');
    assert.equal(profile.avatar!.text, 'an illustrated fox in a scarf');
  });
});
