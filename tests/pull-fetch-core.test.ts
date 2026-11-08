// Tests for src/behavior/pull-fetch.ts: the rails a read of another conversation must pass before anything is read, each
// with its skip code. The conversations are held by the fake interface; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SnowflakeUtil } from 'discord.js';
import type { Audience, ConversationInfo, Permissions } from '../src/protocol/adapter.ts';
import { checkPull } from '../src/behavior/pull-fetch.ts';
import { isReadable, takeSnapshot } from '../src/behavior/snapshot.ts';
import { useSelf, world } from './fixtures/turn-world.ts';
import type { Raw } from './fixtures/turn-world.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
// The owner's example: the conversation's last message was at 10:00 two days ago.
const LAST = Date.UTC(2026, 9, 3, 10, 0, 0);

const GUILD_ID = '700000000000000000';
const SELF_ID = '710000000000000001';
const MEMBER = { zoe: '730000000000000001', iason: '730000000000000002' };
const MIRROR_ID = '740000000000000009';
const MAIN_ID = '750000000000000001';

useSelf(SELF_ID);

type Config = Parameters<typeof checkPull>[0]['config'];

/** The live config with the shipped `context.pull` / `elsewhere` values. */
function config({
  pull = {},
  features = {},
  bot = {},
}: { pull?: Record<string, unknown>; features?: Record<string, unknown>; bot?: Record<string, unknown> } = {}): Config {
  return {
    features: { mediaDescriptions: true, channelPull: true, elsewhere: true, ...features },
    bot: { dryRunChannelId: '', ...bot },
    context: {
      pull: {
        windowMinutes: 60,
        minMessages: 5,
        maxMessages: 60,
        maxPictures: 10,
        maxNewDescriptions: 8,
        describeTimeoutMs: 15000,
        scanMessages: 20,
        maxChannels: 1,
        maxAgeDays: 0,
        sameAudience: true,
        ...pull,
      },
    },
    elsewhere: { settleSeconds: 90, settleMaxSeconds: 300, rememberPings: 20, pingMaxAgeDays: 7 },
    media: { embedTextChars: 200, video: { sites: [] } },
  };
}

type MessageSpec = { ts: number; content?: string; authorId?: string; images?: Array<string>; mentionsSelf?: boolean };

/** A discord.js-shaped message of conversation `id` written at `spec.ts`, with a real snowflake id. */
function rawMessage(id: string, name: string, spec: MessageSpec): Raw {
  const { ts, content = 'καλημέρα σε όλους', authorId = MEMBER.zoe, images = [], mentionsSelf = false } = spec;
  return {
    id: SnowflakeUtil.generate({ timestamp: ts }).toString(),
    placeId: id,
    channel: { name },
    guild: { id: GUILD_ID },
    author: { id: authorId, bot: false, globalName: 'Zoé', username: 'zoe' },
    member: { displayName: 'Zoé' },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(
      images.map((imageId) => [
        imageId,
        {
          id: imageId,
          contentType: 'image/png',
          name: `${imageId}.png`,
          url: `https://cdn.example/${imageId}.png`,
          size: 1000,
        },
      ])
    ),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
    mentions: { users: new Map(mentionsSelf ? [[SELF_ID, { id: SELF_ID }]] : []) },
  };
}

type Held = {
  id: string;
  info: ConversationInfo;
  /** The message ids in the order of their time. */
  ids: Array<string>;
  idAt(ts: number): string;
  /** The reads made of this conversation since the scene was set, in order: a page query, or a message id. */
  calls(): Array<unknown>;
  /** Makes `calls` start from now. */
  mark(): void;
};

/** A conversation of the community with its history; `fail` makes every history read of it fail. */
function addChannel({
  id,
  name = id,
  messages = [],
  permissions = {},
  kind,
  audience: held,
  viewers,
  fail = false,
}: {
  id: string;
  name?: string;
  messages?: ReadonlyArray<MessageSpec>;
  permissions?: Partial<Permissions>;
  kind?: ConversationInfo['kind'];
  audience?: Audience;
  viewers?: Record<string, boolean>;
  fail?: boolean;
}): Held {
  const ordered = [...messages].sort((a, b) => a.ts - b.ts);
  const raws = ordered.map((spec) => rawMessage(id, name, spec));
  const handle = world().channel({
    id,
    name,
    placeId: GUILD_ID,
    permissions,
    ...(kind === undefined ? {} : { kind }),
    ...(held === undefined ? {} : { audience: held }),
    ...(viewers === undefined ? {} : { viewers }),
    lastMessageAt: ordered.at(-1)?.ts ?? null,
    historyMessages: raws,
  });
  if (fail) handle.failHistory();
  const ids = raws.map((raw) => String(raw.id));
  let since = world().port.calls.length;
  return {
    id,
    info: handle.info,
    ids,
    idAt(ts) {
      const at = ordered.findIndex((spec) => spec.ts === ts);
      return ids[at] ?? '';
    },
    calls() {
      return world()
        .port.calls.slice(since)
        .flatMap((call) => {
          if ((call.args[0] as { conversationId?: string } | undefined)?.conversationId !== id) return [];
          if (call.op === 'history') return [call.args[1]];
          if (call.op === 'fetchMessages') return call.args[1];
          return [];
        });
    },
    mark() {
      since = world().port.calls.length;
    },
  };
}

/** The public main conversation the persona speaks in. */
function mainChannel(): Held {
  return addChannel({ id: MAIN_ID, name: 'agora', messages: [{ ts: NOW - MIN }] });
}

/** A private chat with `partnerId`. */
function privateChat(partnerId: string | null = null): ConversationInfo {
  return world().channel({ id: '790000000000000001', dm: true, partnerId }).info;
}

/** The listing of the community now. */
async function listing(viewers: Array<string> = []) {
  const snapshot = await takeSnapshot(world().reads, GUILD_ID, viewers);
  if (snapshot === null) throw new Error('the world gave no listing');
  return snapshot;
}

test('checkPull checks the rails without a request and gives the conversation when they pass', async () => {
  const main = mainChannel();
  const selfreflection = addChannel({
    id: '760000000000000046',
    permissions: { send: false },
    messages: [{ ts: LAST }],
  });
  const snapshot = await listing();
  const check = (placeId: string, destination: ConversationInfo | null, cfg: Config = config()) =>
    checkPull({ snapshot, placeId, destination, config: cfg, now: NOW });
  assert.equal(check(selfreflection.id, main.info).channel?.id, selfreflection.id);
  assert.equal(check(selfreflection.id, main.info).skip, null);
  assert.deepEqual(check(selfreflection.id, null), { channel: null, skip: 'audience' });
  assert.deepEqual(check('', main.info), { channel: null, skip: 'not-found' }, 'no id is not found');
  const railOff = config({ pull: { sameAudience: false } });
  assert.deepEqual(
    check(selfreflection.id, privateChat(), railOff),
    { channel: null, skip: 'private-chat' },
    'a private chat without a partner never pulls, even with the audience rail off'
  );
  assert.equal(check(selfreflection.id, null, railOff).channel?.id, selfreflection.id);
  assert.deepEqual(selfreflection.calls(), []);
});

test('checkPull lets a private chat with its partner pass what the partner can view and refuses the rest as audience', async () => {
  const open = addChannel({
    id: '760000000000000050',
    permissions: { send: false },
    messages: [{ ts: LAST }],
    viewers: { [MEMBER.iason]: true },
  });
  const closed = addChannel({ id: '760000000000000051', messages: [{ ts: LAST }], viewers: { [MEMBER.iason]: false } });
  const dm = privateChat(MEMBER.iason);
  const snapshot = await listing([MEMBER.iason]);
  const check = (
    placeId: string,
    over: { destination?: ConversationInfo; partnerId?: string | null; cfg?: Config } = {}
  ) =>
    checkPull({
      snapshot,
      placeId,
      destination: over.destination ?? dm,
      partnerId: over.partnerId === undefined ? MEMBER.iason : over.partnerId,
      config: over.cfg ?? config(),
      now: NOW,
    });
  assert.equal(check(open.id).channel?.id, open.id);
  assert.deepEqual(check(closed.id), { channel: null, skip: 'audience' });
  assert.deepEqual(
    check(closed.id, { cfg: config({ pull: { sameAudience: false } }) }),
    { channel: null, skip: 'audience' },
    'the partner rule holds with the audience rail off'
  );
  assert.deepEqual(check(open.id, { partnerId: null }), { channel: null, skip: 'private-chat' });
  assert.deepEqual(check('760000000000000059'), { channel: null, skip: 'not-found' });
});

test('checkPull refuses exactly the conversations isReadable refuses', async () => {
  const main = mainChannel();
  const bot = { dryRunChannelId: MIRROR_ID };
  const held = [
    addChannel({ id: '760000000000000091', messages: [{ ts: LAST }] }),
    addChannel({ id: '760000000000000092', kind: 'thread', messages: [{ ts: LAST }] }),
    addChannel({ id: '760000000000000093', permissions: { read: false }, messages: [{ ts: LAST }] }),
    addChannel({ id: '760000000000000094', messages: [{ ts: LAST }] }),
    addChannel({ id: MIRROR_ID, messages: [{ ts: LAST }] }),
  ];
  const snapshot = await listing();
  const readableCodes = new Set(['thread', 'dry-run-channel', 'not-readable']);
  for (const channel of held) {
    const { skip } = checkPull({
      snapshot,
      placeId: channel.id,
      destination: main.info,
      config: config({ bot }),
      now: NOW,
    });
    const entry = snapshot.get(channel.id);
    if (entry === null) throw new Error(`${channel.id} is not listed`);
    assert.equal(skip !== null && readableCodes.has(skip), !isReadable(entry), `${channel.id}: ${skip}`);
  }
});
