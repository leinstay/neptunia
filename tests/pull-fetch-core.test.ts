// Tests for src/behavior/pull-fetch.ts: fetching another conversation for a turn's <channel_view> over the interface's
// listing and reads -- the rails before any read (each with its skip code), the one page cut to the window that ends at
// the conversation's newest message, the routed trigger and the earlier calls of the ring, the ring's marks, the
// captions (cache first, fresh ones only for a turn certain to run, in parallel, under a timeout; a top-up for a pull
// made before the turn was certain), the failure paths and the logs. The conversations are held by the fake interface;
// the describer and the timers are fakes; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SnowflakeUtil } from 'discord.js';
import type { Audience, ConversationInfo, Permissions } from '../src/protocol/adapter.ts';
import { captionPulled, checkPull, fetchPull } from '../src/behavior/pull-fetch.ts';
import type { PulledChannel } from '../src/behavior/pull-fetch.ts';
import { historyLines } from '../src/behavior/lines.ts';
import type { Line } from '../src/behavior/lines.ts';
import { audienceAllows, isReadable, takeSnapshot } from '../src/behavior/snapshot.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { refTo, useSelf, world } from './fixtures/turn-world.ts';
import type { Raw } from './fixtures/turn-world.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
// The owner's example: the conversation's last message was at 10:00 two days ago.
const LAST = Date.UTC(2026, 9, 3, 10, 0, 0);

const GUILD_ID = '700000000000000000';
const SELF_ID = '710000000000000001';
const ROLE = { regular: '720000000000000001', muted: '720000000000000002' };
const MEMBER = { zoe: '730000000000000001', iason: '730000000000000002' };
const MIRROR_ID = '740000000000000009';
const MAIN_ID = '750000000000000001';

useSelf(SELF_ID);

type Config = Parameters<typeof checkPull>[0]['config'];
type Log = Record<string, unknown>;
type Result = { pulled: PulledChannel | null; skip: string | null };

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

/** The audience of everyone in the community, less what `over` changes. */
function audience(over: Partial<Audience> = {}): Audience {
  return {
    everyone: true,
    groups: [],
    groupAllow: [],
    groupDeny: [],
    memberAllow: [],
    memberDeny: [],
    memberGroups: {},
    ...over,
  };
}

type MessageSpec = { ts: number; content?: string; authorId?: string; images?: Array<string>; mentionsSelf?: boolean };

/** A discord.js-shaped message of conversation `id` written at `spec.ts`, with a real snowflake id. */
function rawMessage(id: string, name: string, spec: MessageSpec): Raw {
  const { ts, content = 'καλημέρα σε όλους', authorId = MEMBER.zoe, images = [], mentionsSelf = false } = spec;
  return {
    id: SnowflakeUtil.generate({ timestamp: ts }).toString(),
    channelId: id,
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
    guildId: GUILD_ID,
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

/** Message specs every `stepMinutes` from `fromTs` to `toTs` inclusive. */
function burst(
  fromTs: number,
  toTs: number,
  stepMinutes: number,
  extra: Partial<MessageSpec> = {}
): Array<MessageSpec> {
  const out: Array<MessageSpec> = [];
  for (let ts = fromTs; ts <= toTs; ts += stepMinutes * MIN) out.push({ ts, ...extra });
  return out;
}

/** The line of message `id` of `channel`, as the conversation holds it now. */
async function lineById(channel: Held, id: string): Promise<Line> {
  const lines = await historyLines(world().reads, refTo(channel), { limit: 100 });
  const line = lines.find((one) => one.id === id);
  if (line === undefined) throw new Error(`no message ${id}`);
  return line;
}

type Ring = NonNullable<Parameters<typeof fetchPull>[0]['pings']>[number];

function ringEntry(channel: Held, id: string, ts: number, answeredAt?: number, skippedAt?: number): Ring {
  return {
    messageId: id,
    channelId: channel.id,
    ts,
    ...(answeredAt === undefined ? {} : { answeredAt }),
    ...(skippedAt === undefined ? {} : { skippedAt }),
  };
}

type DescriberFake = {
  calls: {
    cached: Array<{ guildId: string | null; ids: Array<string> }>;
    many: Array<{ guildId: string | null; ids: Array<string>; options: { maxNew: number } }>;
  };
  pending: Array<{ id: string; settle(text: string | null): void }>;
  cachedDescriptions(guildId: string | null, items: ReadonlyArray<{ itemId: string }>): Map<string, string>;
  describeMany(
    guildId: string | null,
    items: ReadonlyArray<{ itemId: string }>,
    options: { maxNew: number }
  ): Promise<{ descriptions: Map<string, string>; newCount: number }>;
};

/**
 * A describer fake: `cached` item id -> caption already in the cache; `fresh` item id -> caption a request returns at
 * once; a request for an id in `fail` rejects. With `deferred`, every describeMany call waits until the test settles it.
 */
function fakeDescriber({
  cached = {},
  fresh = {},
  fail = [],
  deferred = false,
}: {
  cached?: Record<string, string>;
  fresh?: Record<string, string>;
  fail?: Array<string>;
  deferred?: boolean;
} = {}): DescriberFake {
  const calls: DescriberFake['calls'] = { cached: [], many: [] };
  const pending: DescriberFake['pending'] = [];
  return {
    calls,
    pending,
    cachedDescriptions(guildId, items) {
      calls.cached.push({ guildId, ids: items.map((item) => item.itemId) });
      return new Map(
        items.flatMap((item) => {
          const text = cached[item.itemId];
          return text === undefined ? [] : [[item.itemId, text] as [string, string]];
        })
      );
    },
    describeMany(guildId, items, options) {
      calls.many.push({ guildId, ids: items.map((item) => item.itemId), options });
      const id = items[0]?.itemId ?? '';
      if (fail.includes(id)) return Promise.reject(new Error('provider unavailable'));
      const answer = (text: string | null | undefined) => ({
        descriptions: new Map<string, string>(text ? [[id, text]] : []),
        newCount: text ? 1 : 0,
      });
      if (!deferred) return Promise.resolve(answer(fresh[id]));
      return new Promise((resolve) => pending.push({ id, settle: (text) => resolve(answer(text)) }));
    },
  };
}

type FakeTimer = { fn: () => void; ms: number; unrefed: boolean; cleared: boolean; unref(): void };

/** Timers whose timeout fires only when the test says so. */
function manualTimers() {
  const set: Array<FakeTimer> = [];
  return {
    set,
    timers: {
      set: (fn: () => void, ms: number): FakeTimer => {
        const timer: FakeTimer = {
          fn,
          ms,
          unrefed: false,
          cleared: false,
          unref() {
            this.unrefed = true;
          },
        };
        set.push(timer);
        return timer;
      },
      clear: (timer: unknown) => {
        if (timer) (timer as FakeTimer).cleared = true;
      },
    },
  };
}

/**
 * Makes the page of history serve only the messages written at or after `fromTs` (an older message is then off the
 * page, as in a busy conversation), while a read by id still finds any message.
 */
function servePageFrom(fromTs: number): void {
  world().intercept('history', async (_args, original) => {
    const answer = (await original()) as { status: string; events: Array<{ message: { at: number } }> };
    if (answer.status !== 'ok') return answer;
    return { ...answer, events: answer.events.filter((event) => event.message.at >= fromTs) };
  });
}

/** Wait until `predicate` holds, a macrotask at a time. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(predicate(), true, 'the condition never held');
}

const later = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The pulled record of a result that must have one. */
function pulledOf(result: Result): PulledChannel {
  if (result.pulled === null) throw new Error(`nothing pulled: ${result.skip}`);
  return result.pulled;
}

function logged(logs: ReadonlyArray<object>, msg: string): Log {
  const found = (logs as ReadonlyArray<Log>).find((entry) => entry.msg === msg);
  if (found === undefined) throw new Error(`no log ${msg}`);
  return found;
}

function loggedAll(logs: ReadonlyArray<object>, msg: string): Array<Log> {
  return (logs as ReadonlyArray<Log>).filter((entry) => entry.msg === msg);
}

type PullOver = Partial<Parameters<typeof fetchPull>[0]> & { viewers?: Array<string> };

/** fetchPull with the usual arguments over the world; `over` replaces any of them. */
async function pull(channelId: string, over: PullOver = {}): Promise<Result> {
  const { viewers = [], ...rest } = over;
  const snapshot = rest.snapshot ?? (await takeSnapshot(world().reads, GUILD_ID, viewers));
  return fetchPull({
    reads: world().reads,
    guildId: GUILD_ID,
    channelId,
    destination: snapshot?.get(MAIN_ID) ?? null,
    reason: 'mention',
    config: config(),
    now: NOW,
    ...rest,
    snapshot,
  });
}

/** The listing of the community now. */
async function listing(viewers: Array<string> = []) {
  const snapshot = await takeSnapshot(world().reads, GUILD_ID, viewers);
  if (snapshot === null) throw new Error('the world gave no listing');
  return snapshot;
}

// ---- the window ------------------------------------------------------------------

// The core asks the interface for the page it needs, `min(100, max(maxMessages, minMessages) + 1)` messages (61 with the
// shipped settings); the platform's own request is the interface's business.
test("fetchPull ends the window at the conversation's newest message", async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000001',
    name: 'ημερολόγιο',
    messages: [{ ts: LAST - 180 * MIN }, { ts: LAST - 150 * MIN }, ...burst(LAST - 60 * MIN, LAST, 10)],
  });
  const { result, logs } = await withCapturedLogs(() => pull(diary.id));
  const pulled = pulledOf(result);
  assert.equal(result.skip, null);
  assert.deepEqual(Object.keys(result).sort(), ['pulled', 'skip'], 'the record and the skip code, no platform object');
  assert.deepEqual(
    pulled.messages.map((m) => m.ts),
    burst(LAST - 60 * MIN, LAST, 10).map((spec) => spec.ts),
    'every message of 9:00-10:00 two days ago, nothing older, nothing measured from now'
  );
  assert.equal(pulled.olderNotShown, true);
  assert.equal(pulled.messages.at(-1)?.id, diary.idAt(LAST));
  assert.equal(pulled.channelId, diary.id);
  assert.equal(pulled.channelName, 'ημερολόγιο');
  assert.equal(pulled.reason, 'mention');
  assert.deepEqual(diary.calls(), [{ limit: 61 }], 'one page, no anchor');
  const line = logged(logs, 'pull: channel');
  assert.equal(line.messages, 7);
  assert.equal(line.source, diary.id);
  assert.equal(line.channel, MAIN_ID);
});

// An anchor is read by id first, then the page before it: the interface has no "ending at" query.
test('fetchPull ends the window at an explicit anchor', async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000002',
    messages: [...burst(LAST - 300 * MIN, LAST - 120 * MIN, 20), ...burst(LAST - 30 * MIN, LAST, 10)],
  });
  const anchorId = diary.idAt(LAST - 120 * MIN);
  const cfg = config({ pull: { minMessages: 2 } });
  const pulled = pulledOf(
    (await withCapturedLogs(() => pull(diary.id, { anchorId, reason: 'recall', config: cfg }))).result
  );
  assert.deepEqual(
    pulled.messages.map((m) => m.ts),
    [LAST - 180 * MIN, LAST - 160 * MIN, LAST - 140 * MIN, LAST - 120 * MIN],
    'the hour before the anchor, nothing after it'
  );
  assert.equal(pulled.olderNotShown, true);
  assert.equal(pulled.messages.at(-1)?.id, anchorId);
  assert.deepEqual(diary.calls(), [anchorId, { limit: 60, before: anchorId }], 'the anchor, then the page before it');
});

test('fetchPull reads an earlier page just before the oldest message shown last time', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000011', messages: burst(LAST - 300 * MIN, LAST, 10) });
  const beforeId = diary.idAt(LAST - 60 * MIN);
  const { result, logs } = await withCapturedLogs(() =>
    pull(diary.id, { reason: 'route', direction: 'earlier', beforeId })
  );
  const pulled = pulledOf(result);
  assert.equal(result.skip, null);
  assert.deepEqual(diary.calls(), [{ before: beforeId, limit: 61 }], 'one page before the oldest message shown');
  assert.deepEqual(
    pulled.messages.map((m) => m.ts),
    burst(LAST - 130 * MIN, LAST - 70 * MIN, 10).map((spec) => spec.ts),
    'the hour before the last view, nothing of it and nothing newer'
  );
  assert.equal(pulled.olderNotShown, true);
  const line = logged(logs, 'pull: channel');
  assert.equal(line.direction, 'earlier');
  assert.equal(line.beforeId, true, 'only whether there was an id, never the id');
  assert.equal('pullDirection' in line, false);
  assert.equal(JSON.stringify(logs).includes(beforeId), false, 'the id itself is not logged');
});

test('fetchPull falls back to the newest page and says so when an earlier page has no previous view', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000012', messages: burst(LAST - 300 * MIN, LAST, 10) });
  const { result, logs } = await withCapturedLogs(() =>
    pull(diary.id, { reason: 'route', direction: 'earlier', beforeId: null })
  );
  assert.deepEqual(diary.calls(), [{ limit: 61 }], 'the newest page, as a plain pull');
  assert.equal(pulledOf(result).messages.at(-1)?.id, diary.idAt(LAST));
  const line = logged(logs, 'pull: channel');
  assert.equal(line.direction, 'earlier');
  assert.equal(line.beforeId, false);
  assert.equal(line.pullDirection, 'earlier-no-previous');
});

test('fetchPull logs no direction for a plain pull and ignores a stray beforeId', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000013', messages: burst(LAST - 300 * MIN, LAST, 10) });
  const beforeId = diary.idAt(LAST - 60 * MIN);
  const { result, logs } = await withCapturedLogs(() => pull(diary.id, { beforeId }));
  assert.deepEqual(diary.calls(), [{ limit: 61 }]);
  assert.equal(pulledOf(result).messages.at(-1)?.id, diary.idAt(LAST));
  const line = logged(logs, 'pull: channel');
  assert.equal(line.direction, null);
  assert.equal('beforeId' in line || 'pullDirection' in line, false);
});

test('fetchPull skips as empty when nothing is before the previous view and as failed when the earlier page fails', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000014', messages: burst(LAST - 30 * MIN, LAST, 10) });
  const first = diary.idAt(LAST - 30 * MIN);
  const empty = await withCapturedLogs(() =>
    pull(diary.id, { reason: 'route', direction: 'earlier', beforeId: first })
  );
  assert.equal(empty.result.skip, 'empty');
  const broken = addChannel({ id: '760000000000000015', messages: burst(LAST - 30 * MIN, LAST, 10), fail: true });
  const failed = await withCapturedLogs(() =>
    pull(broken.id, { reason: 'route', direction: 'earlier', beforeId: first })
  );
  assert.equal(failed.result.skip, 'fetch-failed');
});

test('fetchPull does not find a malformed anchor and refuses an anchor older than a positive maxAgeDays', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000005', messages: [{ ts: NOW - 40 * DAY }, { ts: NOW - DAY }] });
  const oldId = diary.idAt(NOW - 40 * DAY);
  const { result } = await withCapturedLogs(async () => [
    await pull(diary.id, { anchorId: 'ημέρα' }),
    await pull(diary.id, { anchorId: oldId, config: config({ pull: { maxAgeDays: 30 } }) }),
    await pull(diary.id, { anchorId: oldId }),
  ]);
  assert.equal(result[0]?.skip, 'not-found');
  assert.equal(result[1]?.skip, 'too-old');
  assert.deepEqual(
    result[2]?.pulled?.messages.map((m) => m.id),
    [oldId],
    'maxAgeDays 0: no age limit'
  );
  // The anchors are read by id (three times); only the last pull read a page, the too-old anchor read none.
  assert.equal(diary.calls().filter((call) => typeof call === 'object').length, 1, 'only the last pull read a page');
});

test('fetchPull gives readOnly from the permissions of the conversation', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000003', permissions: { send: false }, messages: [{ ts: LAST }] });
  const talk = addChannel({ id: '760000000000000004', permissions: { react: false }, messages: [{ ts: LAST }] });
  const { result } = await withCapturedLogs(async () => [await pull(diary.id), await pull(talk.id)]);
  assert.equal(result[0]?.pulled?.readOnly, true);
  assert.equal(result[1]?.pulled?.readOnly, false);
});

// ---- skips ------------------------------------------------------------------------

// A category is no conversation of the listing, so there is no `not-text` skip: it would be `not-found`.
test('fetchPull skips an unknown, thread or unreadable conversation with its reason', async () => {
  mainChannel();
  const thread = addChannel({ id: '760000000000000011', kind: 'thread', messages: [{ ts: LAST }] });
  const hidden = addChannel({ id: '760000000000000012', permissions: { read: false }, messages: [{ ts: LAST }] });
  const cfg = config();
  const cases: Array<[string, string]> = [
    ['760000000000000099', 'not-found'],
    [thread.id, 'thread'],
    [hidden.id, 'not-readable'],
  ];
  for (const [channelId, code] of cases) {
    const { result, logs } = await withCapturedLogs(() => pull(channelId, { config: cfg }));
    assert.deepEqual(result, { pulled: null, skip: code }, code);
    const line = logged(logs, 'pull: skipped');
    assert.deepEqual(
      { channel: line.channel, source: line.source, reason: line.reason, pullReason: line.pullReason },
      { channel: MAIN_ID, source: channelId, reason: code, pullReason: 'mention' }
    );
  }
  for (const held of [thread, hidden]) assert.deepEqual(held.calls(), [], 'nothing read');
});

test('fetchPull skips the dry-run conversation with its own reason', async () => {
  mainChannel();
  const mirror = addChannel({ id: MIRROR_ID, messages: [{ ts: LAST }] });
  const { result, logs } = await withCapturedLogs(() =>
    pull(MIRROR_ID, { config: config({ bot: { dryRunChannelId: MIRROR_ID } }) })
  );
  assert.deepEqual(result, { pulled: null, skip: 'dry-run-channel' });
  assert.equal(logged(logs, 'pull: skipped').reason, 'dry-run-channel');
  assert.deepEqual(mirror.calls(), []);
});

test('fetchPull gives their own skip codes for an empty conversation and a failed read', async () => {
  mainChannel();
  const empty = addChannel({ id: '760000000000000021' });
  const broken = addChannel({ id: '760000000000000022', fail: true, messages: [{ ts: LAST }] });
  const { result, logs } = await withCapturedLogs(async () => [await pull(empty.id), await pull(broken.id)]);
  assert.deepEqual(result[0], { pulled: null, skip: 'empty' });
  assert.deepEqual(result[1], { pulled: null, skip: 'fetch-failed' });
  assert.deepEqual(
    loggedAll(logs, 'pull: skipped').map((entry) => entry.reason),
    ['empty', 'fetch-failed']
  );
});

test('fetchPull skips a conversation quieter than maxAgeDays and pulls it whatever its age with maxAgeDays 0', async () => {
  mainChannel();
  const old = addChannel({
    id: '760000000000000031',
    messages: burst(NOW - 280 * DAY, NOW - 280 * DAY + 30 * MIN, 10),
  });
  const { result } = await withCapturedLogs(async () => [
    await pull(old.id, { config: config({ pull: { maxAgeDays: 30 } }) }),
    await pull(old.id, { config: config({ pull: { maxAgeDays: 0 } }) }),
  ]);
  assert.deepEqual(result[0], { pulled: null, skip: 'too-old' });
  assert.equal(old.calls().length, 1, 'only the second pull read: the too-old refusal made no read');
  assert.equal(result[1]?.skip, null);
  assert.equal(result[1]?.pulled?.messages.length, 4);
});

// ---- the audience rail ----------------------------------------------------------

test('fetchPull lets the audience rail block a narrower source', async () => {
  mainChannel();
  const narrow = addChannel({
    id: '760000000000000041',
    audience: audience({ everyone: false, groups: [ROLE.regular] }),
    messages: [{ ts: LAST }],
  });
  const { result, logs } = await withCapturedLogs(() => pull(narrow.id));
  assert.deepEqual(result, { pulled: null, skip: 'audience' });
  assert.equal(logged(logs, 'pull: skipped').reason, 'audience');
  assert.deepEqual(narrow.calls(), []);
});

test('fetchPull blocks a source that a role is denied on although everyone can view it', async () => {
  mainChannel();
  const source = addChannel({
    id: '760000000000000042',
    audience: audience({ groupDeny: [ROLE.muted] }),
    messages: [{ ts: LAST }],
  });
  const { result } = await withCapturedLogs(() => pull(source.id));
  assert.equal(result.skip, 'audience', 'members of the muted role see the main channel but not the source');
});

test('audienceAllows passes the same audience and refuses a narrower source or no destination unless the rail is off', () => {
  const main = mainChannel();
  const open = addChannel({ id: '760000000000000044' });
  const narrow = addChannel({ id: '760000000000000045', audience: audience({ memberDeny: [MEMBER.zoe] }) });
  assert.equal(audienceAllows(main.info, open.info, config()), true);
  assert.equal(audienceAllows(main.info, narrow.info, config()), false, 'a member denied on the source only');
  assert.equal(audienceAllows(null, open.info, config()), false, 'no destination never qualifies');
  assert.equal(audienceAllows(main.info, narrow.info, config({ pull: { sameAudience: false } })), true);
  assert.equal(audienceAllows(null, narrow.info, config({ pull: { sameAudience: false } })), true);
});

test('checkPull checks the rails without a request and gives the conversation when they pass', async () => {
  const main = mainChannel();
  const diary = addChannel({ id: '760000000000000046', permissions: { send: false }, messages: [{ ts: LAST }] });
  const snapshot = await listing();
  const check = (channelId: string, destination: ConversationInfo | null, cfg: Config = config()) =>
    checkPull({ snapshot, channelId, destination, config: cfg, now: NOW });
  assert.equal(check(diary.id, main.info).channel?.id, diary.id);
  assert.equal(check(diary.id, main.info).skip, null);
  assert.deepEqual(check(diary.id, null), { channel: null, skip: 'audience' });
  assert.deepEqual(check('', main.info), { channel: null, skip: 'not-found' }, 'no id is not found');
  const railOff = config({ pull: { sameAudience: false } });
  assert.deepEqual(
    check(diary.id, privateChat(), railOff),
    { channel: null, skip: 'private-chat' },
    'a private chat without a partner never pulls, even with the audience rail off'
  );
  assert.equal(check(diary.id, null, railOff).channel?.id, diary.id);
  assert.deepEqual(diary.calls(), []);
});

test('audienceAllows lets a private chat in on exactly the sources its partner can view, whatever the audience rail', () => {
  const open = addChannel({ id: '760000000000000047', viewers: { [MEMBER.iason]: true, [MEMBER.zoe]: true } });
  const closed = addChannel({ id: '760000000000000048', viewers: { [MEMBER.iason]: false, [MEMBER.zoe]: true } });
  const named = addChannel({ id: '760000000000000049', viewers: { [MEMBER.iason]: true, [MEMBER.zoe]: false } });
  const dm = privateChat();
  for (const rail of [config(), config({ pull: { sameAudience: false } })]) {
    const allows = (source: Held, partnerId: string | null) =>
      audienceAllows(dm, withViewers(source.info), rail, { partnerId });
    assert.equal(allows(open, MEMBER.iason), true);
    assert.equal(allows(closed, MEMBER.zoe), true, 'her role views it');
    assert.equal(allows(closed, MEMBER.iason), false, 'he holds no role that views it');
    assert.equal(allows(named, MEMBER.zoe), false, 'denied by name');
    assert.equal(allows(named, MEMBER.iason), true);
    assert.equal(allows(open, null), false, 'no partner never qualifies');
  }
});

/** The listing's entry of a conversation, which carries who of the named viewers can see it. */
function withViewers(info: ConversationInfo): ConversationInfo {
  return info;
}

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
    channelId: string,
    over: { destination?: ConversationInfo; partnerId?: string | null; cfg?: Config } = {}
  ) =>
    checkPull({
      snapshot,
      channelId,
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

test('fetchPull in a private chat reads a conversation the partner can view and nothing of one they cannot', async () => {
  const open = addChannel({
    id: '760000000000000052',
    messages: burst(NOW - 30 * MIN, NOW - 10 * MIN, 10),
    viewers: { [MEMBER.iason]: true },
  });
  const closed = addChannel({ id: '760000000000000053', messages: [{ ts: LAST }], viewers: { [MEMBER.iason]: false } });
  const dm = privateChat(MEMBER.iason);
  const { result } = await withCapturedLogs(async () => [
    await pull(open.id, { destination: dm, partnerId: MEMBER.iason, viewers: [MEMBER.iason] }),
    await pull(closed.id, { destination: dm, partnerId: MEMBER.iason, viewers: [MEMBER.iason] }),
    await pull(open.id, { destination: dm, viewers: [MEMBER.iason] }),
  ]);
  assert.equal(result[0]?.skip, null);
  assert.equal(result[0]?.pulled?.channelId, open.id);
  assert.equal(result[0]?.pulled?.messages.length, 3);
  assert.deepEqual(result[1], { pulled: null, skip: 'audience' });
  assert.deepEqual(closed.calls(), []);
  assert.deepEqual(result[2], { pulled: null, skip: 'private-chat' });
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
      channelId: channel.id,
      destination: main.info,
      config: config({ bot }),
      now: NOW,
    });
    const entry = snapshot.get(channel.id);
    if (entry === null) throw new Error(`${channel.id} is not listed`);
    assert.equal(skip !== null && readableCodes.has(skip), !isReadable(entry, bot), `${channel.id}: ${skip}`);
  }
});

// ---- the routed trigger and the ring --------------------------------------------

test('fetchPull adds a routed trigger that lies outside the window', async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000051',
    permissions: { send: false },
    messages: [{ ts: LAST - 240 * MIN, mentionsSelf: true }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  // The copy messageCreate handed over, before an edit: the page's copy is shown instead.
  const trigger = { ...(await lineById(diary, diary.ids[0] ?? '')), content: 'πριν από την αλλαγή' };
  diary.mark();
  const pings = [ringEntry(diary, trigger.id, trigger.ts)];
  const pulled = pulledOf((await withCapturedLogs(() => pull(diary.id, { reason: 'routed', trigger, pings }))).result);
  assert.equal(pulled.messages[0]?.id, trigger.id, 'the call comes first, before the window');
  assert.equal(pulled.messages.length, 7);
  assert.notEqual(pulled.messages[0], trigger, "the page's copy, not the given one");
  assert.equal(pulled.messages[0]?.content, 'καλημέρα σε όλους');
  assert.deepEqual(
    [...pulled.earlierPingIds],
    [trigger.id],
    'shown before the window, so the window keeps its own span'
  );
  assert.equal(pulled.pingState.has(trigger.id), false, 'the trigger itself carries no mark');
  assert.deepEqual(diary.calls(), [{ limit: 61 }], 'the page holds the trigger: never read by id');
});

test('fetchPull does not show a routed trigger that was deleted before the pull', async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000054',
    permissions: { send: false },
    messages: [
      { ts: LAST - 240 * MIN, mentionsSelf: true },
      ...burst(LAST - 50 * MIN, LAST, 10),
      { ts: LAST - 25 * MIN, mentionsSelf: true },
    ],
  });
  const olderId = diary.idAt(LAST - 240 * MIN);
  const insideId = diary.idAt(LAST - 25 * MIN);
  const older = await lineById(diary, olderId);
  const inside = await lineById(diary, insideId);
  // Both calls are deleted during the settle wait.
  world().forget(diary.id, insideId);
  world().forget(diary.id, olderId);
  diary.mark();
  const { result, logs } = await withCapturedLogs(async () => [
    await pull(diary.id, { reason: 'routed', trigger: inside }),
    await pull(diary.id, { reason: 'routed', trigger: older }),
  ]);
  assert.deepEqual(result[0], { pulled: null, skip: 'trigger-gone' });
  assert.deepEqual(result[1], { pulled: null, skip: 'trigger-gone' });
  assert.deepEqual(
    diary.calls(),
    [{ limit: 61 }, { limit: 61 }, olderId],
    'a call inside the page span is known gone without a read; one older than the page is asked for once'
  );
  assert.deepEqual(
    loggedAll(logs, 'pull: skipped').map((entry) => [entry.reason, entry.pullReason]),
    [
      ['trigger-gone', 'routed'],
      ['trigger-gone', 'routed'],
    ]
  );
});

test('fetchPull reads by id a routed trigger older than the page and shows it before the window', async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000055',
    permissions: { send: false },
    messages: [{ ts: LAST - 240 * MIN, mentionsSelf: true }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  const trigger = { ...(await lineById(diary, diary.ids[0] ?? '')), content: 'πριν από την αλλαγή' };
  servePageFrom(LAST - 50 * MIN);
  diary.mark();
  const { result } = await withCapturedLogs(() => pull(diary.id, { reason: 'routed', trigger }));
  const pulled = pulledOf(result);
  assert.equal(result.skip, null);
  assert.deepEqual(diary.calls(), [{ limit: 61 }, trigger.id]);
  assert.equal(pulled.messages[0]?.id, trigger.id);
  assert.equal(pulled.messages[0]?.content, 'καλημέρα σε όλους', 'the copy the conversation holds now');
  assert.deepEqual([...pulled.earlierPingIds], [trigger.id]);
  assert.equal(pulled.messages.length, 7);
});

test('fetchPull keeps a trigger of the window once and never lets in a trigger of another conversation', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000052', messages: burst(LAST - 30 * MIN, LAST, 10) });
  const other = addChannel({ id: '760000000000000053', messages: [{ ts: LAST - 300 * MIN }] });
  const inside = await lineById(diary, diary.ids[1] ?? '');
  const foreign = await lineById(other, other.ids[0] ?? '');
  const { result } = await withCapturedLogs(async () => [
    await pull(diary.id, { trigger: inside }),
    await pull(diary.id, { trigger: foreign }),
  ]);
  assert.equal(result[0]?.pulled?.messages.filter((m) => m.id === inside.id).length, 1);
  assert.equal(result[0]?.pulled?.messages.length, 4);
  assert.equal(
    result[1]?.pulled?.messages.some((m) => m.id === foreign.id),
    false
  );
});

test('fetchPull reads an unanswered ring ping outside the window and marks it', async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000061',
    messages: [
      { ts: LAST - 300 * MIN, mentionsSelf: true },
      { ts: LAST - 280 * MIN, mentionsSelf: true },
      { ts: LAST - 260 * MIN, mentionsSelf: true },
      ...burst(LAST - 50 * MIN, LAST, 10),
    ],
  });
  const [unansweredId = '', answeredId = '', skippedId = ''] = diary.ids;
  const ring = [
    ringEntry(diary, unansweredId, LAST - 300 * MIN),
    ringEntry(diary, answeredId, LAST - 280 * MIN, LAST - 270 * MIN),
    ringEntry(diary, skippedId, LAST - 260 * MIN, undefined, LAST - 250 * MIN),
    { messageId: '769999999999999999', channelId: '760000000000000099', ts: LAST - 100 * MIN },
  ];
  // Only the newest page is served, so the call outside it must be read by id.
  servePageFrom(LAST - 50 * MIN);
  const { result, logs } = await withCapturedLogs(() => pull(diary.id, { pings: ring }));
  const pulled = pulledOf(result);
  assert.deepEqual(
    pulled.messages.map((m) => m.id),
    [unansweredId, ...diary.ids.slice(3)]
  );
  assert.deepEqual([...pulled.earlierPingIds], [unansweredId]);
  assert.deepEqual([...pulled.pingState], [[unansweredId, 'unanswered']]);
  assert.equal(diary.calls().includes(unansweredId), true, 'read by id');
  assert.equal(
    diary.calls().includes(answeredId) || diary.calls().includes(skippedId),
    false,
    'answered and skipped calls stay out'
  );
  const line = logged(logs, 'pull: channel');
  assert.deepEqual([line.earlier, line.earlierGone, line.pings], [1, 0, 1]);
});

test('fetchPull takes an earlier call that is on the page from it and leaves out an expired or vanished one', async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000062',
    messages: [{ ts: LAST - 9 * DAY }, { ts: LAST - 200 * MIN }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  const [expiredId = '', onPageId = ''] = diary.ids;
  const ring = [
    ringEntry(diary, expiredId, LAST - 9 * DAY),
    ringEntry(diary, onPageId, LAST - 200 * MIN),
    ringEntry(diary, '760000000000000777', LAST - 190 * MIN),
  ];
  const { result, logs } = await withCapturedLogs(() => pull(diary.id, { pings: ring, now: LAST + MIN }));
  const pulled = pulledOf(result);
  assert.deepEqual([...pulled.earlierPingIds], [onPageId]);
  assert.equal(pulled.messages[0]?.id, onPageId);
  assert.equal(diary.calls().includes(onPageId), false, 'no second read for a message the page holds');
  assert.equal(diary.calls().includes(expiredId), false, 'an expired ring entry is not read');
  assert.equal(diary.calls().includes('760000000000000777'), true, 'a deleted call is asked for once and dropped');
  const line = logged(logs, 'pull: channel');
  assert.deepEqual([line.earlier, line.earlierGone], [1, 1], 'the deleted call is counted as gone');
});

test('fetchPull marks the ring calls inside the window as answered, skipped or unanswered', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000063', messages: burst(LAST - 50 * MIN, LAST, 10) });
  const [a = '', b = '', c = ''] = diary.ids;
  const ring = [
    ringEntry(diary, a, LAST - 50 * MIN, LAST - 45 * MIN),
    ringEntry(diary, b, LAST - 40 * MIN, undefined, LAST - 35 * MIN),
    ringEntry(diary, c, LAST - 30 * MIN),
  ];
  const pulled = pulledOf((await withCapturedLogs(() => pull(diary.id, { pings: ring }))).result);
  assert.deepEqual(
    [...pulled.pingState],
    [
      [a, 'answered'],
      [b, 'skipped'],
      [c, 'unanswered'],
    ]
  );
  assert.equal(pulled.earlierPingIds.size, 0);
});

// ---- captions ------------------------------------------------------------------

/** A conversation whose `count` messages in the last half hour before LAST carry one image each, `p1` oldest. */
function pictureChannel(id: string, count: number): Held {
  const messages: Array<MessageSpec> = [];
  for (let i = 1; i <= count; i += 1) messages.push({ ts: LAST - (count - i) * MIN, images: [`p${i}`] });
  return addChannel({ id, messages });
}

test('fetchPull uses cached captions for every picture and fresh ones only within maxPictures and maxNewDescriptions', async () => {
  mainChannel();
  const channel = pictureChannel('760000000000000071', 5);
  const describer = fakeDescriber({
    cached: { p4: 'λεζάντα p4', p1: 'λεζάντα p1' },
    fresh: { p5: 'νέα p5', p3: 'νέα p3' },
  });
  const cfg = config({ pull: { maxPictures: 3, maxNewDescriptions: 1 } });
  const { result, logs } = await withCapturedLogs(() =>
    pull(channel.id, { config: cfg, describer, turnCertain: true })
  );
  const pulled = pulledOf(result);
  assert.deepEqual(
    describer.calls.cached,
    [{ guildId: GUILD_ID, ids: ['p5', 'p4', 'p3', 'p2', 'p1'] }],
    'the cache is asked for every picture'
  );
  assert.deepEqual(describer.calls.many, [{ guildId: GUILD_ID, ids: ['p5'], options: { maxNew: 1 } }]);
  assert.deepEqual([...pulled.descriptions].sort(), [
    ['p1', 'λεζάντα p1'],
    ['p4', 'λεζάντα p4'],
    ['p5', 'νέα p5'],
  ]);
  assert.equal(pulled.picturesNotSeen, 2, 'p3 (no fresh slot left) and p2 (past maxPictures, not cached)');
  const line = logged(logs, 'pull: channel');
  assert.deepEqual(
    {
      pictures: line.pictures,
      cached: line.cached,
      asked: line.asked,
      fresh: line.fresh,
      late: line.late,
      notSeen: line.notSeen,
    },
    { pictures: 5, cached: 2, asked: 1, fresh: 1, late: 0, notSeen: 2 }
  );
});

test('fetchPull uses cached emoji captions and never counts an emoji as a picture', async () => {
  mainChannel();
  const emojiId = '780000000000000001';
  const channel = addChannel({
    id: '760000000000000077',
    messages: [
      { ts: LAST - MIN, images: ['p1'] },
      { ts: LAST, content: `ωραία <:kardia:${emojiId}>` },
    ],
  });
  const describer = fakeDescriber({ cached: { [`emoji:${emojiId}`]: 'λεζάντα emoji' }, fresh: { p1: 'νέα p1' } });
  const { result, logs } = await withCapturedLogs(() => pull(channel.id, { describer, turnCertain: true }));
  const pulled = pulledOf(result);
  assert.equal(pulled.descriptions.get(`emoji:${emojiId}`), 'λεζάντα emoji');
  assert.equal(describer.calls.cached[0]?.ids.includes(`emoji:${emojiId}`), true, 'the cache is asked for the emoji');
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids),
    [['p1']],
    'no fresh request for an emoji'
  );
  assert.equal(pulled.picturesNotSeen, 0);
  const line = logged(logs, 'pull: channel');
  assert.deepEqual(
    [line.pictures, line.cached, line.asked, line.fresh, line.notSeen],
    [1, 0, 1, 1, 0],
    'the emoji is no picture'
  );
});

test('fetchPull still uses a cached caption after the eighth fresh one', async () => {
  mainChannel();
  const channel = pictureChannel('760000000000000072', 12);
  const fresh = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i + 1}`, `νέα p${i + 1}`]));
  const describer = fakeDescriber({ cached: { p4: 'λεζάντα p4', p2: 'λεζάντα p2' }, fresh });
  const pulled = pulledOf((await withCapturedLogs(() => pull(channel.id, { describer, turnCertain: true }))).result);
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids[0]),
    ['p12', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5'],
    'eight fresh requests, newest first, one picture each'
  );
  assert.equal(pulled.descriptions.get('p4'), 'λεζάντα p4', 'the ninth picture keeps its cached caption');
  assert.equal(pulled.descriptions.get('p2'), 'λεζάντα p2', 'a picture past maxPictures keeps its cached caption');
  assert.equal(pulled.descriptions.has('p3'), false);
  assert.equal(pulled.picturesNotSeen, 2, 'p3 and p1');
});

test('fetchPull runs fresh captions in parallel and renders a late one blind', async () => {
  mainChannel();
  const channel = pictureChannel('760000000000000073', 3);
  const describer = fakeDescriber({ deferred: true });
  const { set, timers } = manualTimers();
  const { result, logs } = await withCapturedLogs(async () => {
    const running = pull(channel.id, { describer, turnCertain: true, timers });
    await until(() => describer.pending.length === 3);
    assert.equal(set.length, 1, 'one timeout for the whole batch');
    assert.equal(set[0]?.ms, 15000, 'describeTimeoutMs');
    assert.equal(set[0]?.unrefed, true, 'the timer never keeps the process alive');
    describer.pending[0]?.settle('νέα p3');
    describer.pending[1]?.settle('νέα p2');
    await later();
    set[0]?.fn(); // the timeout: p1 is still out
    const done = await running;
    describer.pending[2]?.settle('νέα p1'); // too late for this turn
    await later();
    return done;
  });
  const pulled = pulledOf(result);
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids[0]),
    ['p3', 'p2', 'p1'],
    'all three asked before any answered'
  );
  assert.deepEqual([...pulled.descriptions.keys()].sort(), ['p2', 'p3']);
  assert.equal(pulled.picturesNotSeen, 1);
  const line = logged(logs, 'pull: channel');
  assert.deepEqual([line.asked, line.fresh, line.late], [3, 2, 1]);
});

test('fetchPull uses only cached captions without turnCertain', async () => {
  mainChannel();
  const channel = pictureChannel('760000000000000075', 3);
  const describer = fakeDescriber({ cached: { p2: 'λεζάντα p2' }, fresh: { p1: 'νέα p1', p3: 'νέα p3' } });
  const pulled = pulledOf((await withCapturedLogs(() => pull(channel.id, { describer }))).result);
  assert.deepEqual(describer.calls.many, [], 'no request before the turn is certain to run');
  assert.deepEqual([...pulled.descriptions], [['p2', 'λεζάντα p2']]);
  assert.equal(pulled.picturesNotSeen, 2);
});

test('fetchPull makes no describer call with mediaDescriptions off', async () => {
  mainChannel();
  const channel = pictureChannel('760000000000000076', 2);
  const describer = fakeDescriber({ cached: { p1: 'λεζάντα p1' }, fresh: { p2: 'νέα p2' } });
  const cfg = config({ features: { mediaDescriptions: false } });
  const pulled = pulledOf(
    (await withCapturedLogs(() => pull(channel.id, { config: cfg, describer, turnCertain: true }))).result
  );
  assert.deepEqual(describer.calls, { cached: [], many: [] });
  assert.equal(pulled.descriptions.size, 0);
  assert.equal(pulled.picturesNotSeen, 2);
});

// ---- the caption top-up -----------------------------------------------------------

test('captionPulled makes no read and asks only for uncached pictures within the limits', async () => {
  const main = mainChannel();
  const channel = pictureChannel('760000000000000078', 5);
  const describer = fakeDescriber({ cached: { p4: 'λεζάντα p4' }, fresh: { p5: 'νέα p5', p3: 'νέα p3' } });
  const cfg = config({ pull: { maxPictures: 3, maxNewDescriptions: 1 } });
  const { result, logs } = await withCapturedLogs(async () => {
    const before = pulledOf(await pull(channel.id, { config: cfg, describer }));
    const requests = channel.calls().length;
    const after = await captionPulled(before, { describer, guildId: GUILD_ID, config: cfg, destination: main.info });
    return { before, after, requests };
  });
  const { before, after, requests } = result;
  assert.equal(channel.calls().length, requests, 'no read of the conversation');
  assert.deepEqual(
    describer.calls.many.map((call) => call.ids),
    [['p5']],
    'within maxPictures and maxNewDescriptions'
  );
  assert.deepEqual(
    describer.calls.cached.at(-1)?.ids,
    ['p5', 'p3', 'p2', 'p1'],
    'the cache is asked again, never for a known caption'
  );
  assert.deepEqual([...after.descriptions].sort(), [
    ['p4', 'λεζάντα p4'],
    ['p5', 'νέα p5'],
  ]);
  assert.equal(after.picturesNotSeen, 3);
  assert.equal(after.messages, before.messages, 'the same lines');
  assert.deepEqual(
    [[...before.descriptions], before.picturesNotSeen],
    [[['p4', 'λεζάντα p4']], 4],
    'the given record is not changed'
  );
  const line = logged(logs, 'pull: captions');
  assert.deepEqual(
    { channel: line.channel, source: line.source, pullReason: line.pullReason },
    { channel: main.id, source: channel.id, pullReason: 'mention' }
  );
  assert.deepEqual([line.pictures, line.cached, line.asked, line.fresh, line.late, line.notSeen], [5, 1, 1, 1, 0, 3]);
});

test('captionPulled renders a late caption blind and clears the timer when all arrive in time', async () => {
  mainChannel();
  const channel = pictureChannel('760000000000000079', 2);
  const describer = fakeDescriber({ deferred: true });
  const { set, timers } = manualTimers();
  const { result } = await withCapturedLogs(async () => {
    const pulled = pulledOf(await pull(channel.id, { describer }));
    const late = captionPulled(pulled, { describer, guildId: GUILD_ID, config: config(), timers });
    await until(() => describer.pending.length === 2);
    assert.equal(set[0]?.unrefed, true, 'the timer never keeps the process alive');
    describer.pending[0]?.settle('νέα p2');
    await later();
    set[0]?.fn(); // the timeout: p1 is still out
    const blind = await late;
    describer.pending[1]?.settle('νέα p1'); // too late for this turn
    const inTime = captionPulled(pulled, { describer, guildId: GUILD_ID, config: config(), timers });
    await until(() => describer.pending.length === 4);
    describer.pending[2]?.settle('νέα p2');
    describer.pending[3]?.settle('νέα p1');
    return { blind, inTime: await inTime };
  });
  assert.deepEqual([...result.blind.descriptions.keys()], ['p2']);
  assert.equal(result.blind.picturesNotSeen, 1);
  assert.equal(result.inTime.descriptions.size, 2);
  assert.equal(set.length, 2);
  assert.equal(set[1]?.cleared, true, 'every caption arrived: the timer is cleared');
});

// ---- failure paths ------------------------------------------------------------------

// A history the interface cannot give is what an unreadable page message was: the page fails whole.
test('fetchPull skips with fetch-failed when the page cannot be read', async () => {
  mainChannel();
  const diary = addChannel({ id: '760000000000000082', messages: burst(LAST - 30 * MIN, LAST, 10), fail: true });
  const { result, logs } = await withCapturedLogs(() => pull(diary.id));
  assert.deepEqual(result, { pulled: null, skip: 'fetch-failed' });
  const warn = logged(logs, 'pull: page unreadable');
  assert.deepEqual([warn.level, warn.source, warn.channel], ['warn', diary.id, MAIN_ID]);
  assert.equal(logged(logs, 'pull: skipped').reason, 'fetch-failed');
});

test('fetchPull leaves the other captions in use when one caption request fails', async () => {
  mainChannel();
  const channel = pictureChannel('760000000000000083', 3);
  const describer = fakeDescriber({ fresh: { p1: 'νέα p1', p3: 'νέα p3' }, fail: ['p2'] });
  const { result, logs } = await withCapturedLogs(() => pull(channel.id, { describer, turnCertain: true }));
  const pulled = pulledOf(result);
  assert.equal(result.skip, null);
  assert.deepEqual([...pulled.descriptions.keys()].sort(), ['p1', 'p3']);
  assert.equal(pulled.picturesNotSeen, 1);
  const warn = logged(logs, 'pull: caption failed');
  assert.deepEqual([warn.level, warn.source, warn.channel], ['warn', channel.id, MAIN_ID]);
  const line = logged(logs, 'pull: channel');
  assert.deepEqual([line.asked, line.fresh, line.late], [3, 2, 0], 'a failed request is answered, not late');
});

// The interface answers one read by id as failed; the core does not tell that from a call that is gone, so the earlier
// `pull: call unreadable` warning is not logged: the call is left out and counted as gone.
test('fetchPull leaves out an earlier call that cannot be read and the rest of the pull stands', async () => {
  mainChannel();
  const diary = addChannel({
    id: '760000000000000084',
    messages: [{ ts: LAST - 300 * MIN, mentionsSelf: true }, ...burst(LAST - 50 * MIN, LAST, 10)],
  });
  const callId = diary.ids[0] ?? '';
  const ring = [ringEntry(diary, callId, LAST - 300 * MIN)];
  servePageFrom(LAST - 50 * MIN);
  world().failRead('fetchMessages', diary.id);
  const { result, logs } = await withCapturedLogs(() => pull(diary.id, { pings: ring }));
  const pulled = pulledOf(result);
  assert.equal(result.skip, null);
  assert.equal(diary.calls().includes(callId), true, 'asked for by id');
  assert.equal(pulled.earlierPingIds.size, 0);
  assert.equal(
    pulled.messages.some((m) => m.id === callId),
    false
  );
  assert.equal(pulled.messages.length, 6);
  const line = logged(logs, 'pull: channel');
  assert.deepEqual([line.earlier, line.earlierGone], [0, 1]);
});

// ---- logs ------------------------------------------------------------------------

test('fetchPull logs counts and codes, never message text or captions', async () => {
  mainChannel();
  const channel = addChannel({
    id: '760000000000000081',
    messages: [
      { ts: LAST - MIN, content: 'μυστικό ημερολόγιο', images: ['p1'] },
      { ts: LAST, content: 'café crème' },
    ],
  });
  const describer = fakeDescriber({ fresh: { p1: 'ιδιωτική λεζάντα' } });
  const { logs } = await withCapturedLogs(() => pull(channel.id, { describer, turnCertain: true, reason: 'routed' }));
  const line = logged(logs, 'pull: channel');
  assert.deepEqual(
    Object.keys(line)
      .filter((key) => !['level', 'time', 'msg'].includes(key))
      .sort(),
    [
      'asked',
      'cached',
      'channel',
      'direction',
      'earlier',
      'earlierGone',
      'fresh',
      'late',
      'messages',
      'ms',
      'notSeen',
      'olderNotShown',
      'pictures',
      'pings',
      'pullReason',
      'source',
    ]
  );
  assert.equal(line.pullReason, 'routed', 'why it was pulled: the same field as on pull: skipped');
  assert.equal('reason' in line, false, '`reason` is only ever a skip code');
  assert.equal(Number.isFinite(line.ms), true);
  const text = JSON.stringify(logs);
  for (const secret of ['μυστικό', 'café', 'ιδιωτική']) assert.equal(text.includes(secret), false, secret);
});

test('fetchPull pulls a read-only conversation where only the persona writes and marks its lines self', async () => {
  const main = mainChannel();
  const diary = addChannel({
    id: '760000000000000071',
    name: 'ημερολόγιο',
    permissions: { send: false },
    messages: [
      { ts: LAST - 5 * MIN, authorId: SELF_ID },
      { ts: LAST, authorId: SELF_ID },
    ],
  });
  const snapshot = await listing();
  assert.equal(
    checkPull({ snapshot, channelId: diary.id, destination: main.info, config: config(), now: NOW }).skip,
    null
  );
  const { result } = await withCapturedLogs(() => pull(diary.id));
  const pulled = pulledOf(result);
  assert.equal(result.skip, null);
  assert.equal(pulled.readOnly, true);
  assert.equal(pulled.messages.length, 2);
  assert.equal(
    pulled.messages.every((m) => m.self === true),
    true
  );
});
