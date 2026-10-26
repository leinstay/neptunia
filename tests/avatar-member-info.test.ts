// The avatar queue (src/memory/avatar-queue.js) finds members and their pictures through the interface's `memberInfo`
// read: one member of the community, with the hash and the address of their avatar, or null when they are not a member.
// A scan offers every profiled member with the answer; the queue then describes each new avatar once from the address
// the answer carried. Fakes for the store, the model and the image download; the interface is the fake adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Reads } from '../src/interface/reads.ts';
import { COMMUNITY, SELF_ID, member, rig } from './fixtures/reads-rig.ts';

type Profile = { id: string; names: Array<string>; avatar?: unknown };
type Queue = {
  scan: (guildId: string) => Promise<{ profiles: number; queued: number; gone: number }>;
  tick: () => Promise<string>;
  pending: () => Array<string>;
};
type Deps = {
  hot: { config: object; prompts: object };
  store: {
    getUser: (guildId: string, id: string) => Profile | null;
    listUserProfiles: (guildId: string) => Array<Profile>;
    setAvatar: (guildId: string, id: string, avatar: object) => Profile | null;
  };
  llm: { complete: (messages: unknown, options: unknown) => Promise<{ text: string }>; capLeft: () => number };
  imageFetcher: { fetchAsDataUrl: (url: string, options: unknown) => Promise<{ dataUrl: string } | null> };
  state: { data: Record<string, unknown>; markDirty: () => void };
  getGuildId: () => string | null;
  selfId: () => string | null;
  reads: Reads;
  now: () => number;
  log: { info: () => void; warn: () => void; error: () => void };
};
type Module = { createAvatarQueue: (deps: Deps) => Queue };

const { createAvatarQueue } = (await import('../src/memory/avatar-queue.js')) as unknown as Module;

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const HASH = 'a1b2c3';
const URL_OF_U1 = 'https://cdn.example/avatars/u1/a1b2c3.png?size=256';

function setup(options: { reads?: ReadonlyArray<string>; profiles?: Array<Profile> } = {}) {
  const world = rig(options.reads === undefined ? {} : { reads: options.reads });
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
        models: { base: { vision: 'v/model' } },
      },
      prompts: { avatar: 'Describe the avatar in at most {{maxChars}} characters.' },
    },
    store: {
      getUser: (guildId, id) => (guildId === COMMUNITY ? (profiles.get(id) ?? null) : null),
      listUserProfiles: (guildId) => (guildId === COMMUNITY ? [...profiles.values()] : []),
      setAvatar(_guildId, id, avatar) {
        written.push({ id, avatar });
        return profiles.get(id) ?? null;
      },
    },
    llm: {
      capLeft: () => 100,
      complete: (messages) => {
        requests.push(messages);
        return Promise.resolve({ text: 'a scarf-wearing fox' });
      },
    },
    imageFetcher: {
      fetchAsDataUrl: (url) => {
        fetched.push(url);
        return Promise.resolve({ dataUrl: 'data:image/png;base64,ZmFrZQ==' });
      },
    },
    state: { data: {}, markDirty() {} },
    getGuildId: () => COMMUNITY,
    selfId: () => SELF_ID,
    reads: world.reads,
    now: () => NOW,
    log: { info() {}, warn() {}, error() {} },
  });
  return { ...world, queue, written, fetched, requests };
}

test('asks the interface for each profiled member of the community and queues the one whose avatar changed', async () => {
  const { queue, fake, requests, asked } = setup();
  fake.seedMember(COMMUNITY, member('u1', 'Eleni', { avatar: { hash: HASH, url: URL_OF_U1, largeUrl: null } }));
  const counts = await queue.scan(COMMUNITY);
  assert.deepEqual(counts, { profiles: 1, queued: 1, gone: 0 });
  assert.deepEqual(queue.pending(), ['u1']);
  assert.deepEqual(requests, []);
  assert.deepEqual(asked('memberInfo'), [{ communityId: COMMUNITY, memberId: 'u1' }]);
});

test('counts a profiled person the interface does not know as a member as gone', async () => {
  const { queue, asked } = setup();
  assert.deepEqual(await queue.scan(COMMUNITY), { profiles: 1, queued: 0, gone: 1 });
  assert.deepEqual(queue.pending(), []);
  assert.deepEqual(asked('memberInfo'), [{ communityId: COMMUNITY, memberId: 'u1' }]);
});

test('counts every profiled person as gone, with no round trip, when the interface does not offer the read', async () => {
  const { queue, asked } = setup({ reads: ['messages.fetch'] });
  assert.deepEqual(await queue.scan(COMMUNITY), { profiles: 1, queued: 0, gone: 1 });
  assert.deepEqual(asked('memberInfo'), []);
});

test('leaves out an automated member', async () => {
  const { queue, fake } = setup();
  fake.seedMember(
    COMMUNITY,
    member('u1', 'Birthdays', { bot: true, avatar: { hash: HASH, url: URL_OF_U1, largeUrl: null } })
  );
  assert.deepEqual(await queue.scan(COMMUNITY), { profiles: 1, queued: 0, gone: 0 });
});

test('stores the default avatar of a member who has no picture, without a request', async () => {
  const { queue, fake, written, fetched } = setup();
  fake.seedMember(COMMUNITY, member('u1', 'Eleni'));
  await queue.scan(COMMUNITY);
  assert.equal(await queue.tick(), 'idle');
  assert.deepEqual(written, [{ id: 'u1', avatar: { hash: null, default: true } }]);
  assert.deepEqual(fetched, []);
});

test('describes a new avatar once, from the address the interface gave and under the hash it gave', async () => {
  const { queue, fake, written, fetched, requests } = setup();
  fake.seedMember(COMMUNITY, member('u1', 'Eleni', { avatar: { hash: HASH, url: URL_OF_U1, largeUrl: null } }));
  await queue.scan(COMMUNITY);
  assert.equal(await queue.tick(), 'described');
  assert.deepEqual(fetched, [URL_OF_U1]);
  assert.equal(requests.length, 1);
  assert.equal(written.length, 1);
  assert.deepEqual([written[0]?.id, (written[0]?.avatar as { hash: string; text: string }).hash], ['u1', HASH]);
});
