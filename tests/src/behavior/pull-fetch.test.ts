// The pull rails (src/behavior/pull-fetch.ts): which chat a turn may pull from toward which place, and `checkPull` over
// the listing of an interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPull } from '../../../src/behavior/pull-fetch.ts';
import { snapshotOf, isReadable, takeSnapshot } from '../../../src/behavior/snapshot.ts';
import { channel as channelInfo } from '../../fixtures/reads-rig.ts';
import { config as recallConfig } from '../../fixtures/recall-run-kit.ts';
import '../../../src/tools/operations/index.ts';
import { SnowflakeUtil } from 'discord.js';
import type { Audience, ChatInfo, Permissions } from '../../../src/protocol/adapter.ts';
import { useSelf, world } from '../../fixtures/turn-world.ts';
import type { Raw } from '../../fixtures/turn-world.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';

const DM_CHAT = 'dm-chat-n1';

// Another partner on the same interface.
const OTHER = 'n2';

// ---- the pull rail and conversation.read ----------------------------------------------------------------------------

const dmInfo = (id: string, partnerId: string) =>
  channelInfo(id, { kind: 'dm', rootId: null, chatType: 'dm', partnerId, audience: null });

test('the pull rail refuses a DM chat toward a group', () => {
  // Bug: a DM in the directory's snapshot passes the rail because the same-audience rule compares no audience.
  const group = channelInfo('c1', { name: 'general' });
  const snapshot = snapshotOf('g1', { chats: [group, dmInfo(DM_CHAT, PARTNER)], groups: [] });
  const verdict = checkPull({
    snapshot,
    placeId: DM_CHAT,
    destination: group,
    partnerId: null,
    config: recallConfig(),
    now: NOW,
  });
  assert.equal(verdict.skip, 'not-readable');
});

test("the pull rail refuses one partner's DM toward another partner's private turn", () => {
  // Bug: the rail's `viewers` is read on a source that has no root.
  const other = dmInfo('dm-other', OTHER);
  const snapshot = snapshotOf('g1', { chats: [dmInfo(DM_CHAT, PARTNER), other], groups: [] });
  const verdict = checkPull({
    snapshot,
    placeId: DM_CHAT,
    destination: other,
    partnerId: OTHER,
    config: recallConfig(),
    now: NOW,
  });
  assert.equal(verdict.skip, 'not-readable');
});

const MIN = 60_000;

const PULL_FETCH_CORE_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

// The example: the chat's last message was at 10:00 two days ago.
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
    media: { video: { sites: [] } },
  };
}

type MessageSpec = { ts: number; content?: string; authorId?: string; images?: Array<string>; mentionsSelf?: boolean };

/** A discord.js-shaped message of chat `id` written at `spec.ts`, with a real snowflake id. */
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
  info: ChatInfo;
  /** The message ids in the order of their time. */
  ids: Array<string>;
  idAt(ts: number): string;
  /** The reads made of this chat since the scene was set, in order: a page query, or a message id. */
  calls(): Array<unknown>;
  /** Makes `calls` start from now. */
  mark(): void;
};

/** A chat of the root with its history; `fail` makes every history read of it fail. */
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
  kind?: ChatInfo['kind'];
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
          if ((call.args[0] as { chatId?: string } | undefined)?.chatId !== id) return [];
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

/** The public main chat the persona speaks in. */
function mainChannel(): Held {
  return addChannel({ id: MAIN_ID, name: 'agora', messages: [{ ts: PULL_FETCH_CORE_NOW - MIN }] });
}

/** A private chat with `partnerId`. */
function dmChat(partnerId: string | null = null): ChatInfo {
  return world().channel({ id: '790000000000000001', dm: true, partnerId }).info;
}

/** The listing of the root now. */
async function listing(viewers: Array<string> = []) {
  const snapshot = await takeSnapshot(world().reads, GUILD_ID, viewers);
  if (snapshot === null) throw new Error('the world gave no listing');
  return snapshot;
}

test('checkPull checks the rails without a request and gives the chat when they pass', async () => {
  const main = mainChannel();
  const diary = addChannel({
    id: '760000000000000046',
    permissions: { send: false },
    messages: [{ ts: LAST }],
  });
  const snapshot = await listing();
  const check = (placeId: string, destination: ChatInfo | null, cfg: Config = config()) =>
    checkPull({ snapshot, placeId, destination, config: cfg, now: PULL_FETCH_CORE_NOW });
  assert.equal(check(diary.id, main.info).channel?.id, diary.id);
  assert.equal(check(diary.id, main.info).skip, null);
  assert.deepEqual(check(diary.id, null), { channel: null, skip: 'audience' });
  assert.deepEqual(check('', main.info), { channel: null, skip: 'not-found' }, 'no id is not found');
  const railOff = config({ pull: { sameAudience: false } });
  assert.deepEqual(
    check(diary.id, dmChat(), railOff),
    { channel: null, skip: 'private-chat' },
    'a private chat without a partner never pulls, even with the audience rail off'
  );
  assert.equal(check(diary.id, null, railOff).channel?.id, diary.id);
  assert.deepEqual(diary.calls(), []);
});

test('checkPull with context.memory.openPrivate on lets a private chat pass a channel whatever its partner can view', async () => {
  // Bug: the switch opens the persona's memory but a direct chat still reads no other chat, with or without its partner.
  const closed = addChannel({ id: '760000000000000052', messages: [{ ts: LAST }], viewers: { [MEMBER.iason]: false } });
  const snapshot = await listing([MEMBER.iason]);
  const opened = config();
  Object.assign(opened.context as object, { memory: { openPrivate: true } });
  const check = (cfg: Config, partnerId: string | null) =>
    checkPull({
      snapshot,
      placeId: closed.id,
      destination: dmChat(MEMBER.iason),
      partnerId,
      config: cfg,
      now: PULL_FETCH_CORE_NOW,
    }).skip;
  assert.equal(check(opened, MEMBER.iason), null);
  assert.equal(check(opened, null), null);
  assert.equal(check(config(), MEMBER.iason), 'audience');
  assert.equal(check(config(), null), 'private-chat');
});

test('checkPull lets a private chat with its partner pass what the partner can view and refuses the rest as audience', async () => {
  const open = addChannel({
    id: '760000000000000050',
    permissions: { send: false },
    messages: [{ ts: LAST }],
    viewers: { [MEMBER.iason]: true },
  });
  const closed = addChannel({ id: '760000000000000051', messages: [{ ts: LAST }], viewers: { [MEMBER.iason]: false } });
  const dm = dmChat(MEMBER.iason);
  const snapshot = await listing([MEMBER.iason]);
  const check = (placeId: string, over: { destination?: ChatInfo; partnerId?: string | null; cfg?: Config } = {}) =>
    checkPull({
      snapshot,
      placeId,
      destination: over.destination ?? dm,
      partnerId: over.partnerId === undefined ? MEMBER.iason : over.partnerId,
      config: over.cfg ?? config(),
      now: PULL_FETCH_CORE_NOW,
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

test('checkPull refuses exactly the chats isReadable refuses', async () => {
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
      now: PULL_FETCH_CORE_NOW,
    });
    const entry = snapshot.get(channel.id);
    if (entry === null) throw new Error(`${channel.id} is not listed`);
    assert.equal(skip !== null && readableCodes.has(skip), !isReadable(entry), `${channel.id}: ${skip}`);
  }
});
