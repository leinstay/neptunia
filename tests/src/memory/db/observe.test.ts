// The observation envelope (schema v8, src/memory/db/observe.ts), and how the memory session's batch names the author
// of an observed line. Fixtures for three interfaces nobody wires yet: Twitter (the persona's post, replies, a
// mention of them; a stranger's quote tweet stays out unless the caller passes it), an imageboard (thread
// tokens, a post-number-only board, display names, a site-wide id, a reset token) and Telegram (a DM and a group).
// Synthetic text only; the ids and handles are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path, { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { MemoryHandle, Db, Row } from '../../../../src/memory/db/types.ts';
import { OBSERVATION_VERSION, checkEnvelope, observe, OBSERVE_CODES } from '../../../../src/memory/db/observe.ts';
import type { Envelope, ObserveResult } from '../../../../src/memory/db/observe.ts';
import { audienceWhere, dmContext, groupContext, internalContext } from '../../../../src/memory/db/scope.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { wrongly, sqlOf, present } from '../../../fixtures/loose-types.ts';
import type { UntypedDb } from '../../../fixtures/loose-types.ts';
import { toEvent } from '../../../fixtures/sdk-shaped.ts';
import { validateEvent } from '../../../../src/protocol/index.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { CHANNEL, GUILD, MEMBER } from '../../../fixtures/memory-db/datadir.ts';
import { personMembers } from '../../../../src/memory/db/person-links.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { fixture } from '../../../fixtures/memory-db-recall.ts';
import { lineEvent, deliver, channelInfo, until } from '../../../fixtures/core-over-fake.ts';
import { startCore } from '../../../../src/core.ts';
import { addClient } from '../../../../src/setup/clients.ts';
import { createKeyStore } from '../../../../src/keys/store.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { start as startFake } from '../../../../scripts/lib/fake-interface.ts';
import { connectSocket } from '../../../../src/protocol/wire.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { search, window } from '../../../../src/memory/db/recall.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { batchOf, scopesOf } from '../../../../src/memory/db/session.ts';
import type { SweepScope } from '../../../../src/memory/db/session.ts';
import { CLI_AUDIENCE, CLI_PLACE, OWNER } from '../../../fixtures/memory-audit-production.ts';
import '../../../../src/tools/operations/index.ts';
import { topPlaceSpelled } from '../../../../src/memory/db/ids.ts';

/** What `observe` answers for a stored message: the ids it assigned and the author's account. */
type Observed = {
  ok: boolean;
  sourceId: string;
  placeId: string;
  audienceId: string;
  author: { account: string };
};
const observed = (...args: Parameters<typeof observe>) => wrongly<Observed>(observe(...args));

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const at = (minutes: number) => new Date(Date.parse('2026-10-24T10:00:00.000Z') + minutes * 60_000).toISOString();
const opts = { now: () => NOW, log: quiet };
const count = (db: UntypedDb, sql: string, ...params: Array<unknown>) => db.prepare(sql).get(...params).n;

const TABLES = [
  'sources',
  'accounts',
  'places',
  'participants',
  'people',
  'external_keys',
  'source_relations',
  'audiences',
  'authorities',
  'interfaces',
  'connections',
  'participant_links',
  'account_person_links',
  'decisions',
];
const sizes = (db: UntypedDb) =>
  Object.fromEntries(TABLES.map((table) => [table, count(db, `SELECT COUNT(*) AS n FROM "${table}"`)]));

function fresh() {
  return openMemoryDb(':memory:');
}

/** A minted meta-person id: `person:` and a uuid, never an interface and a native id. */
const UUID_PERSON = /^person:[0-9a-f]{8}-[0-9a-f]{4}-/;

/** The person an account's columns name, as text. */
const linkedPerson = (handle: MemoryHandle, account: string): string =>
  String(dbOf(handle).prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id);

// ---------- Twitter ----------

const tweet = (key: string, over = {}) => ({
  v: OBSERVATION_VERSION,
  iface: 'twitter',
  authority: 'twitter/global',
  connection: 'conn:twitter:her',
  native: { kind: 'tweet', key, revision: 0 },
  place: {
    authority: 'twitter/global',
    key: 'chat:9001',
    kind: 'discussion',
    chat: 'group',
    title: 'a thread',
  },
  author: { kind: 'self', key: 'her-handle', display: 'Her' },
  occurredAt: at(0),
  observedAt: at(1),
  text: `tweet ${key}`,
  relations: [],
  ...over,
});

test("twitter: the persona's post, a reply to it and a mention of them are stored; a stranger quote tweet is not stored unless passed", () => {
  const handle = fresh();
  const db = sqlOf(handle);
  try {
    const people = count(db, 'SELECT COUNT(*) AS n FROM people');
    const post = observe(handle, tweet('9001'), opts);
    assert.equal(post.ok, true, JSON.stringify(post));
    assert.equal(post.replayed, false);
    const row = db
      .prepare(
        'SELECT kind, author_kind, author_account, author_participant, audience_id, scope_kind, scope_iface, authority_id, native_kind, connection_id, origin FROM sources WHERE id = ?'
      )
      .get(post.sourceId);
    assert.deepEqual(
      { ...row, author_account: undefined },
      {
        kind: 'said',
        author_kind: 'self',
        author_account: undefined,
        author_participant: null,
        audience_id: 'aud:group:twitter',
        scope_kind: 'group',
        scope_iface: 'twitter',
        authority_id: 'twitter/global',
        native_kind: 'tweet',
        connection_id: 'conn:twitter:her',
        origin: 'observation',
      }
    );
    assert.equal(db.prepare('SELECT kind FROM accounts WHERE id = ?').get(row.author_account).kind, 'self');

    const reply = observed(
      handle,
      tweet('9002', {
        author: { kind: 'account', key: 'u-77', display: 'Zoé' },
        occurredAt: at(5),
        observedAt: at(6),
        text: 'a reply to her',
        relations: [{ predicate: 'replies_to', target: { kind: 'tweet', key: '9001' } }],
      }),
      opts
    );
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(
      {
        ...db
          .prepare(
            'SELECT target_source_id, resolved_at IS NOT NULL AS resolved FROM source_relations WHERE source_id = ?'
          )
          .get(reply.sourceId),
      },
      { target_source_id: post.sourceId, resolved: 1 }
    );
    // Every account seen for the first time gets a meta-person of its own, so the stranger's account is linked to a new
    // `person:<uuid>` rather than to none.
    const stranger = db.prepare('SELECT kind, names FROM accounts WHERE id = ?').get(reply.author.account);
    assert.deepEqual({ ...stranger }, { kind: 'user', names: '["Zoé"]' });
    assert.match(linkedPerson(handle, reply.author.account), UUID_PERSON, 'an account under a meta-person of its own');
    // A quote tweet by a stranger: the adapter does not pass it, so nothing of it exists.
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sources WHERE native_id = '9003'"), 0);

    // A mention of the persona in another chat: stored, and the mention of their handle stays an unresolved relation
    // (an account is never a source).
    const mention = observe(
      handle,
      tweet('9100', {
        place: { authority: 'twitter/global', key: 'chat:9100', kind: 'discussion', chat: 'group' },
        author: { kind: 'account', key: 'u-88' },
        occurredAt: at(30),
        observedAt: at(31),
        text: 'hey @her-handle',
        relations: [{ predicate: 'mentions', target: { kind: 'user', key: 'her-handle' } }],
      }),
      opts
    );
    assert.equal(mention.ok, true, JSON.stringify(mention));
    assert.equal(
      db.prepare('SELECT target_source_id FROM source_relations WHERE source_id = ?').get(mention.sourceId)
        .target_source_id,
      null
    );
    // Each of the two strangers' accounts gets a meta-person of its own.
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM people'), people + 2, 'one meta-person per new account');

    // The same post again: nothing is written.
    const before = sizes(db);
    const replay = observe(handle, tweet('9001'), opts);
    assert.deepEqual(replay, { ok: true, replayed: true, sourceId: post.sourceId, written: 0 });
    assert.deepEqual(sizes(db), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// ---------- an imageboard ----------

const SITE = 'imageboard/site:board.example';
const post = (key: string, author: Record<string, Untyped>, over = {}) => ({
  v: OBSERVATION_VERSION,
  iface: 'imageboard',
  authority: SITE,
  native: { kind: 'post', key, revision: 0 },
  place: {
    authority: SITE,
    key: 'thread:100',
    kind: 'thread',
    chat: 'group',
    title: 'a thread',
    parent: 'board:b',
  },
  author,
  occurredAt: at(Number(key) % 50),
  observedAt: at((Number(key) % 50) + 1),
  text: `post ${key}`,
  ...over,
});
const threadB = { authority: SITE, key: 'thread:200', kind: 'thread', chat: 'group' };

test('imageboard: a site id is an account, a reply waits for its post, and the thread place follows its posts', () => {
  const handle = fresh();
  const db = sqlOf(handle);
  try {
    // A site-wide stable id is an account of the site. A stable mark is a real account and gets its meta-person by the
    // general rule, so it holds one verified link instead of none.
    const site = observed(handle, post('501', { kind: 'account', key: 'id:9f3c' }), opts);
    assert.deepEqual(
      { ...db.prepare('SELECT authority_id, native_key FROM accounts WHERE id = ?').get(site.author.account) },
      { authority_id: SITE, native_key: 'id:9f3c' }
    );
    assert.match(linkedPerson(handle, site.author.account), UUID_PERSON);
    assert.equal(
      count(db, 'SELECT COUNT(*) AS n FROM account_person_links WHERE account_id = ?', site.author.account),
      1
    );
    const again = observed(handle, post('502', { kind: 'account', key: 'id:9f3c' }, { place: threadB }), opts);
    assert.equal(again.author.account, site.author.account, 'a site id is one account across threads');

    // A reply to a post nobody fetched waits; it resolves when the post arrives, and its key stays.
    const replying = observe(
      handle,
      post(
        '104',
        { kind: 'account', key: 'id:9f3c' },
        { relations: [{ predicate: 'replies_to', target: { kind: 'post', key: '99' } }] }
      ),
      opts
    );
    const waiting = db
      .prepare('SELECT id, target_key, target_source_id FROM source_relations WHERE source_id = ?')
      .get(replying.sourceId);
    assert.equal(waiting.target_source_id, null);
    const relations = count(db, 'SELECT COUNT(*) AS n FROM source_relations');
    const arrived = observe(handle, post('99', { kind: 'account', key: 'id:7a1d' }), opts);
    assert.equal(arrived.resolved, 1);
    const resolved = db
      .prepare('SELECT id, target_key, target_source_id, resolved_at FROM source_relations WHERE source_id = ?')
      .get(replying.sourceId);
    assert.deepEqual(
      [resolved.id, resolved.target_key, resolved.target_source_id],
      [waiting.id, waiting.target_key, arrived.sourceId]
    );
    assert.ok(resolved.resolved_at);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM source_relations'), relations);

    // The thread's place: its seen window follows the posts.
    // A declared parent creates its place row even when no message was seen there, so the link is a real `parent_id`
    // and `extra` stays empty.
    const board = db.prepare("SELECT id FROM places WHERE native_key = 'board:b'").get() as { id: string };
    const place = db
      .prepare('SELECT kind, chat, parent_id, extra, seen_from_at, seen_to_at FROM places WHERE id = ?')
      .get(site.placeId);
    assert.deepEqual(
      { ...place },
      {
        kind: 'thread',
        chat: 'group',
        parent_id: board.id,
        extra: null,
        seen_from_at: at(1),
        seen_to_at: at(49),
      }
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// ---------- Telegram ----------

const message = (key: string, place: Record<string, Untyped>, author: Record<string, Untyped>, over = {}) => ({
  v: OBSERVATION_VERSION,
  iface: 'telegram',
  authority: 'telegram/global',
  native: { kind: 'message', key, revision: 1 },
  place,
  author,
  occurredAt: at(0),
  observedAt: at(1),
  text: `message ${key}`,
  ...over,
});

test("telegram: a DM is its own audience, a group is the interface's, an unknown chat is internal", () => {
  const handle = fresh();
  const db = sqlOf(handle);
  try {
    const dmPlace = {
      authority: 'telegram/global',
      key: 'chat:555',
      kind: 'dm',
      chat: 'dm',
      partner: { key: '555', display: 'Ilse' },
    };
    const dm = observed(handle, message('555:1', dmPlace, { kind: 'account', key: '555', display: 'Ilse' }), opts);
    assert.equal(dm.ok, true, JSON.stringify(dm));
    assert.equal(dm.audienceId, `aud:dm:${dm.placeId}`);
    // The partner's new account gets a meta-person, and the DM names it as its partner.
    const place = db.prepare('SELECT chat, partner_account, partner_person FROM places WHERE id = ?').get(dm.placeId);
    const partnerPerson = linkedPerson(handle, dm.author.account);
    assert.match(partnerPerson, UUID_PERSON);
    assert.deepEqual({ ...place }, { chat: 'dm', partner_account: dm.author.account, partner_person: partnerPerson });
    assert.deepEqual(
      { ...db.prepare('SELECT kind, iface, place_id FROM audiences WHERE id = ?').get(dm.audienceId) },
      { kind: 'dm', iface: 'telegram', place_id: dm.placeId }
    );
    const group = observe(
      handle,
      message(
        '-100:7',
        { authority: 'telegram/global', key: 'chat:-100', kind: 'room', chat: 'group', title: 'a group' },
        { kind: 'account', key: '777' }
      ),
      opts
    );
    assert.equal(group.audienceId, 'aud:group:telegram');
    const unknown = observe(
      handle,
      message(
        '-200:1',
        { authority: 'telegram/global', key: 'chat:-200', kind: 'room', chat: 'channel' },
        { kind: 'account', key: '777' }
      ),
      opts
    );
    assert.equal(unknown.audienceId, 'aud:internal', 'an unknown chat fails closed');
    assert.equal(db.prepare('SELECT chat FROM places WHERE id = ?').get(unknown.placeId).chat, null);

    const visible = (ctx: Record<string, Untyped>) => {
      const where = audienceWhere(ctx, 's');
      return db
        .prepare(`SELECT s.id FROM sources s WHERE ${where.sql} ORDER BY s.id`)
        .all(...where.params)
        .map((row) => row.id);
    };
    assert.deepEqual(visible(groupContext('telegram')), [group.sourceId]);
    assert.deepEqual(
      visible({ ...dmContext('person:telegram:555', 'telegram', dm.placeId) }).sort(),
      [dm.sourceId, group.sourceId].sort()
    );
    // Policy 2 admits group evidence across interfaces while keeping DM and internal evidence private.
    assert.deepEqual(visible(groupContext('discord')), [group.sourceId]);
    // The place declared a DM stays one: a later envelope that says otherwise is refused, and writes nothing.
    const before = sizes(db);
    assert.deepEqual(
      observe(handle, message('555:2', { ...dmPlace, chat: 'group' }, { kind: 'account', key: '555' }), opts),
      { ok: false, code: 'CONVERSATION_CONFLICT' }
    );
    assert.deepEqual(sizes(db), before);
  } finally {
    handle.close();
  }
});

test('observe: a malformed envelope is refused with a code and writes nothing; a refusal found while writing rolls back', () => {
  const handle = fresh();
  const db = sqlOf(handle);
  try {
    const good = tweet('1');
    const cases = [
      [null, 'BAD_ENVELOPE'],
      [{ ...good, v: 2 }, 'BAD_VERSION'],
      [{ ...good, authority: 'telegram/global' }, 'BAD_AUTHORITY'],
      [{ ...good, native: { kind: 'tweet', key: '1' } }, 'BAD_NATIVE'],
      [{ ...good, place: { ...good.place, kind: 'timeline' } }, 'BAD_PLACE'],
      [{ ...good, author: { kind: 'participant', token_kind: 'thread_token', key: 'Ab12' } }, 'BAD_AUTHOR'],
      [{ ...good, author: { kind: 'person', key: 'x' } }, 'BAD_AUTHOR'],
      [{ ...good, occurredAt: 'yesterday' }, 'BAD_TIME'],
      [{ ...good, text: null }, 'BAD_TEXT'],
      [{ ...good, relations: [{ predicate: 'likes', target: { source: 'x' } }] }, 'BAD_RELATION'],
      [{ ...good, extra: [1] }, 'BAD_EXTRA'],
    ];
    db.prepare("INSERT INTO interfaces (id, name, contract) VALUES ('elsewhere', 'elsewhere', 1)").run();
    db.prepare("INSERT INTO connections (id, iface) VALUES ('conn:elsewhere', 'elsewhere')").run();
    const before = sizes(db);
    for (const [envelope, code] of cases) {
      assert.equal(checkEnvelope(envelope), code, JSON.stringify(envelope));
      assert.deepEqual(observe(handle, envelope, opts), { ok: false, code });
    }
    assert.deepEqual(sizes(db), before);
    // Valid on its face, refused while writing (its connection is stored for another interface): the interface and
    // the authorities written before the refusal are rolled back with it.
    assert.deepEqual(observe(handle, tweet('2', { connection: 'conn:elsewhere' }), opts), {
      ok: false,
      code: 'BAD_CONNECTION',
    });
    assert.deepEqual(sizes(db), before);
  } finally {
    handle.close();
  }
});

// ---------- session batch ----------

test('an envelope that still carries a capture writes its line and no bundle', () => {
  // Bug: an adapter of an older release that sends `capture` would grow the bundle tables no code reads.
  const handle = fresh();
  const db = sqlOf(handle);
  try {
    const result = observe(
      handle,
      tweet('9300', { capture: { role: 'anchor', reason: 'own_line', coverage: { state: 'complete' } } }),
      opts
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal('bundleId' in result, false);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sources WHERE id = ?', String(result.sourceId)), 1);
  } finally {
    handle.close();
  }
});

// ---------- media of a line ----------

/** One media item of an envelope with a platform reference and nothing told of it. */
const item = (kind: string, nativeRef: string) => ({
  kind,
  nativeRef,
  availability: 'unknown',
  description: null,
  origin: null,
  extra: {},
});

/** The media ids a line links, in position order. */
const linkedMedia = (db: UntypedDb, sourceId: string): Array<unknown> =>
  db
    .prepare("SELECT media_id FROM media_links WHERE owner_kind = 'source' AND owner_id = ? ORDER BY position")
    .all(sourceId)
    .map((row: Record<string, unknown>) => row.media_id);

test('stores one link for a media a line names twice', () => {
  // Bug: five uses of one custom emoji in a message become five links to the same media row.
  const handle = fresh();
  const db = sqlOf(handle);
  const emoji = item('emoji', 'e-501');
  const done = observed(handle, tweet('9501', { media: [emoji, item('emoji', 'e-502'), emoji] }), opts);
  assert.deepEqual(linkedMedia(db, done.sourceId), ['media:twitter:e-501', 'media:twitter:e-502']);
});

test('adds no link when a stored line is observed again with the same items', () => {
  // Bug: a replay writes the same items again and the line ends up holding each media twice.
  const handle = fresh();
  const db = sqlOf(handle);
  const media = [item('sticker', 's-601'), item('emoji', 'e-601')];
  const done = observed(handle, tweet('9601', { media }), opts);
  observe(handle, tweet('9601', { media }), opts);
  assert.deepEqual(linkedMedia(db, done.sourceId), ['media:twitter:s-601', 'media:twitter:e-601']);
});

test('a stored line observed again at the same revision gains the emoji and sticker it lacks and keeps its link card', () => {
  // One link per media of a line, and a line read again only gains what it lacks.
  // Bug: the replay writes by position, so the new emoji takes the card's place and the card the platform no longer
  // shows is unlinked.
  const handle = fresh();
  const db = sqlOf(handle);
  const done = observed(handle, tweet('9701', { media: [item('link', 'https://example.org/a')] }), opts);
  const replay = observe(handle, tweet('9701', { media: [item('emoji', 'e-701'), item('sticker', 's-701')] }), opts);
  assert.equal(replay.replayed, true);
  assert.deepEqual(linkedMedia(db, done.sourceId), [
    'media:twitter:https://example.org/a',
    'media:twitter:e-701',
    'media:twitter:s-701',
  ]);
  assert.equal(db.prepare('SELECT text FROM sources WHERE id = ?').get(done.sourceId).text, 'tweet 9701');
});

test('an edit at a higher revision holds only the media of the edited message', () => {
  // Bug: the only-adds rule of a replay leaks into an edit, so the edited line keeps a card the edit removed.
  const handle = fresh();
  const db = sqlOf(handle);
  observe(handle, tweet('9801', { media: [item('link', 'https://example.org/b'), item('emoji', 'e-801')] }), opts);
  const edited = tweet('9801', { media: [item('emoji', 'e-801')], text: 'tweet 9801, edited' });
  const done = observed(handle, { ...edited, native: { kind: 'tweet', key: '9801', revision: 1 } }, opts);
  assert.deepEqual(linkedMedia(db, done.sourceId), ['media:twitter:e-801']);
});

// The envelope check of an observation made from a discord.js-shaped message. Synthetic text only; the ids are made up.
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const EVENT_SELF = '100000000000000009';
const MEMBER2 = '100000000000000002';
const BOT = '100000000000000008';

const NAMES: Record<string, string> = { [MEMBER]: 'Ada', [MEMBER2]: 'Zoé', [EVENT_SELF]: 'Her', [BOT]: 'Robot' };

function channelOf({
  id = CHANNEL,
  name = 'γενικά',
  thread = false,
  type,
  recipientId,
  parentId,
}: { id?: string; name?: string; thread?: boolean; type?: number; recipientId?: string; parentId?: string } = {}) {
  return {
    id,
    name,
    isThread: () => thread,
    messages: { cache: new Map() },
    ...(type === undefined ? {} : { type }),
    ...(recipientId ? { recipientId } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

/** A discord.js message, shaped just enough for the adapter. */
function discordMessage({
  id,
  channel = channelOf(),
  author = MEMBER,
  content,
  at,
  replyTo = null,
  mentions = [],
  guild = true,
  editedAt = null,
}: {
  id: string;
  channel?: ReturnType<typeof channelOf>;
  author?: string;
  content: string;
  at: number;
  replyTo?: string | null;
  mentions?: Array<string>;
  guild?: boolean;
  editedAt?: number | null;
}) {
  return {
    id,
    placeId: channel.id,
    channel,
    guild: guild ? { id: GUILD } : null,
    chatId: guild ? GUILD : null,
    author: { id: author, bot: author === BOT, globalName: NAMES[author], username: NAMES[author] },
    member: { displayName: NAMES[author] },
    content,
    cleanContent: content,
    createdTimestamp: at,
    editedTimestamp: editedAt,
    reference: replyTo ? { messageId: replyTo } : null,
    mentions: { users: new Map(mentions.map((user) => [user, { id: user }])) },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
  };
}

const eventOf = (raw: Record<string, Untyped>, options = {}) => {
  const event = toEvent(raw, EVENT_SELF, options);
  assert.deepEqual(validateEvent(event), { ok: true });
  return event;
};

// ---------- the envelope round trip ----------

test('checkEnvelope: a revision may be left out only by an edit; mentions, direct and the account kind are checked', () => {
  const base = observationOf(eventOf(discordMessage({ id: 'm-1', content: 'x', at: T0 })), { selfId: EVENT_SELF });
  assert.equal(checkEnvelope(base), null);
  assert.equal(checkEnvelope({ ...base, native: { ...present(base).native, revision: undefined } }), 'BAD_NATIVE');
  assert.equal(
    checkEnvelope({ ...base, edited: true, native: { ...present(base).native, revision: undefined } }),
    null
  );
  assert.equal(checkEnvelope({ ...base, edited: 'yes' }), 'BAD_NATIVE');
  assert.equal(checkEnvelope({ ...base, mentions: [''] }), 'BAD_RELATION');
  assert.equal(checkEnvelope({ ...base, direct: 1 }), 'BAD_ENVELOPE');
  assert.equal(checkEnvelope({ ...base, author: { ...present(base).author, account_kind: 'robot' } }), 'BAD_AUTHOR');
});

// What an adapter declares about a place beyond its id: the authority it belongs to and the place that contains it, of
// any kind and at any depth. `kind` says what sort of chat it is and containment says where it sits: a channel in
// a category stays a channel. Discord's objects end inside its adapter (interfaces/discord/collect.ts).

const PARENTS_NOW = Date.parse('2026-11-05T12:00:00Z');

function eventIn(chat: Record<string, unknown>, id = 'm1'): Record<string, unknown> {
  return {
    kind: 'message.received',
    iface: 'other',
    at: PARENTS_NOW,
    id: `other:message:${id}`,
    chat,
    message: {
      id,
      author: { id: 'u1', name: 'Eleni', self: false, bot: false },
      content: 'hello',
      at: PARENTS_NOW,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

test('a chain of parents is stored place by place, whatever order they are seen in', () => {
  // A category is no place.
  // Bug: a parent no message was seen in has no row and an earlier child keeps no link, so the chain stops at the thread.
  const handle = openMemoryDb(':memory:');
  try {
    const quiet = { info() {}, warn() {}, error() {} };
    const stored = (chat: Record<string, unknown>, id: string): void => {
      const envelope = observationOf(eventIn(chat, id));
      const result = observe(handle, envelope, { now: () => PARENTS_NOW, log: quiet });
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    stored({ id: 't1', kind: 'thread', chatType: 'thread', parentId: 'c1' }, 'm1');
    stored({ id: 'c1', kind: 'channel', chatType: 'channel', parentId: 'g1', parentKind: 'server' }, 'm2');
    const rows = dbOf(handle).prepare('SELECT id, native_key, parent_id FROM places').all() as Array<{
      id: string;
      native_key: string | null;
      parent_id: string | null;
    }>;
    const walked: Array<string | null> = [];
    let at = rows.find((row) => row.native_key === 'thread:t1');
    while (at !== undefined && walked.length < 6) {
      walked.push(at.native_key);
      const parent: string | null = at.parent_id;
      at = rows.find((row) => row.id === parent);
    }
    assert.deepEqual(walked, ['thread:t1', 'channel:c1', 'server:g1']);
  } finally {
    handle.close();
  }
});

test('a DM observed with no root stores no root place', () => {
  // Bug: a home root is made up for a DM, and it appears as a parent or a guild row in memory.
  const handle = openMemoryDb(':memory:');
  try {
    const envelope = observationOf(
      eventIn({ id: 'd1', kind: 'dm', chatType: 'dm', rootId: null, partnerId: 'u1', authorityId: 'other/x' })
    );
    assert.equal(envelope?.authority, 'other/x');
    assert.equal(envelope?.place.parent, undefined);
    observe(handle, envelope, { now: () => PARENTS_NOW, log: { info() {}, warn() {}, error() {} } });
    const parents = dbOf(handle).prepare("SELECT parent_id FROM places WHERE kind = 'dm'").all();
    assert.deepEqual(
      parents.map((row) => row.parent_id),
      [null]
    );
  } finally {
    handle.close();
  }
});

// The persona's own account is theirs on every interface: the observation links it to `person:self` the moment it is
// seen, by the author being the persona and never by a name. Real temporary databases, synthetic ids only.

const SELF_PERSON = 'person:self';
const AT = Date.parse('2026-11-05T10:00:00Z');

function withDb(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(path.join(tempDir('nep-self-'), 'memory.db'));
  try {
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

/** One line in a channel of `iface`, by the account `author` under the name `name`, seen with the persona's id being `selfId`. */
function line(
  handle: MemoryHandle,
  iface: string,
  { id, author, name, selfId }: { id: string; author: string; name: string; selfId: string | null }
): void {
  const envelope = observationOf(
    {
      kind: 'message.received',
      iface,
      at: AT,
      chat: { id: 'room', kind: 'channel', chatType: 'channel' },
      message: { id, at: AT, content: 'a synthetic line', author: { id: author, name } },
    },
    { selfId, connection: `conn:${iface}` }
  );
  assert.ok(envelope, 'the event is an observable line');
  observe(handle, envelope, { now: () => AT });
}

const accountOf = (db: Db, iface: string, native: string) =>
  db.prepare('SELECT id, person_id, link, kind FROM accounts WHERE iface = ? AND native_key = ?').get(iface, native);

for (const iface of ['discord', 'telegram', 'matrix']) {
  test(`the persona's account on ${iface} is linked to their person the moment it is first seen`, () => {
    // Bug: the persona's accounts stay unlinked, so "who is this" has no answer for their own lines and any later code
    // treats them as an unknown person, on an interface nobody wired by hand above all.
    withDb((handle, db) => {
      line(handle, iface, { id: 'm1', author: 'her-id', name: 'Someone', selfId: 'her-id' });
      const account = accountOf(db, iface, 'her-id');
      assert.equal(account?.person_id, SELF_PERSON);
      assert.equal(account?.link, 'verified');
      assert.deepEqual(
        db
          .prepare('SELECT person_id, state FROM account_person_links WHERE account_id = ? AND valid_to_at IS NULL')
          .all(account?.id)
          .map((row) => ({ ...row })),
        [{ person_id: SELF_PERSON, state: 'verified' }]
      );
      assert.equal(
        db.prepare('SELECT kind FROM people WHERE id = ?').get(SELF_PERSON)?.kind,
        'self',
        'a raw install has the persona'
      );
    });
  });
}

test("an account first seen as anyone links to the persona's person once its author turns out to be the persona", () => {
  // Bug: a line observed before the interface told the persona's id leaves the account a user, and the kind's update
  // skips the link.
  withDb((handle, db) => {
    line(handle, 'discord', { id: 'm1', author: 'her-id', name: 'Someone', selfId: null });
    // An account seen as anyone first gets a meta-person of its own, never the persona's person.
    assert.match(String(accountOf(db, 'discord', 'her-id')?.person_id), /^person:[0-9a-f]{8}-/);
    line(handle, 'discord', { id: 'm2', author: 'her-id', name: 'Someone', selfId: 'her-id' });
    assert.equal(accountOf(db, 'discord', 'her-id')?.person_id, SELF_PERSON);
  });
});

test("a stranger under the persona's name stays a stranger, and all their accounts read as one person", () => {
  // Bug: the link goes by a name match, so anyone who renames themselves after the persona becomes the persona.
  withDb((handle, db) => {
    line(handle, 'discord', { id: 'm1', author: 'her-id', name: 'Same Name', selfId: 'her-id' });
    line(handle, 'telegram', { id: 'm2', author: 'her-other-id', name: 'Other Name', selfId: 'her-other-id' });
    line(handle, 'discord', { id: 'm3', author: 'stranger', name: 'Same Name', selfId: 'her-id' });
    // The stranger's account has a meta-person of its own, which is not the persona's.
    assert.match(String(accountOf(db, 'discord', 'stranger')?.person_id), /^person:[0-9a-f]{8}-/);
    assert.deepEqual(
      personMembers(db, SELF_PERSON, { ownerMergesOnly: true })
        .accounts.map((account) => account.id)
        .sort(),
      [accountOf(db, 'discord', 'her-id')?.id, accountOf(db, 'telegram', 'her-other-id')?.id].sort()
    );
    assert.equal(accountOf(db, 'discord', 'her-id')?.person_id, SELF_PERSON);
  });
});

// Exact stored source handles and verified native locators use synthetic SQLite evidence.

const DAY = 86400000;
const HANDLES_NOW = Date.parse('2026-10-24T12:00:00.000Z');

function storedObservation(
  env: ReturnType<typeof fixture>,
  {
    key,
    room,
    iface = 'other',
    authority = `${iface}/${room}`,
    text = 'το κουνέλι',
    at = HANDLES_NOW - DAY,
    privatePlace = false,
    revision = 1,
  }: {
    key: string;
    room: string;
    iface?: string;
    authority?: string;
    text?: string;
    at?: number;
    privatePlace?: boolean;
    revision?: number;
  }
) {
  const envelope: Envelope = {
    v: 1,
    iface,
    authority,
    native: { kind: 'message', key, revision },
    place: {
      authority,
      key: room,
      kind: privatePlace ? 'dm' : 'room',
      chat: privatePlace ? 'dm' : 'group',
      ...(privatePlace ? { partner: { key: 'private-partner' } } : {}),
    },
    author: { kind: 'account', key: 'author-42' },
    occurredAt: new Date(at).toISOString(),
    observedAt: new Date(HANDLES_NOW).toISOString(),
    text,
  };
  const result = observe(env.handle, envelope, { now: () => HANDLES_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string') throw new Error('source identity missing');
  const row = env.db.prepare('SELECT place_id, revision FROM sources WHERE id = ?').get(result.sourceId);
  const placeId = row?.place_id;
  if (typeof placeId !== 'string') throw new Error('stored place missing');
  // A stored ref carries its source row's revision, which a quoted line's handle keeps (turn/handles.ts#targetOfSource).
  return { sourceId: result.sourceId, placeId, iface, revision: Number(row?.revision) };
}

test('stored source handles retain one observation identity when a repeated tuple names a different place', () => {
  const env = fixture();
  try {
    const first = storedObservation(env, { key: 'stable-key', authority: 'other/shared', room: 'first-room' });
    const repeated = storedObservation(env, { key: 'stable-key', authority: 'other/shared', room: 'second-room' });
    assert.equal(repeated.sourceId, first.sourceId);
    assert.equal(
      env.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE native_id = ?').get('stable-key')?.count,
      1
    );
  } finally {
    env.done();
  }
});

function locatorEvent(id: string, chatId: string, offset = 0) {
  const event = lineEvent({
    id,
    chatId,
    authorId: 'partner-42',
    text: `το κουνέλι ${id}`,
    at: HANDLES_NOW - DAY - offset,
  });
  event.chat = { id: chatId, kind: 'dm', rootId: null, partnerId: 'partner-42' };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid protocol fixture was refused');
  return envelope;
}

for (const invalid of [
  { label: 'empty chat', iface: 'fake', chatId: '', messageId: 'invalid-locator' },
  { label: 'NUL message', iface: 'fake', chatId: 'actual-dm', messageId: 'invalid\0locator' },
  { label: 'mismatched interface', iface: 'other', chatId: 'actual-dm', messageId: 'invalid-locator' },
]) {
  test(`stored source locator validation refuses ${invalid.label} without writing a source`, () => {
    const env = fixture();
    try {
      const envelope = locatorEvent('invalid-locator', 'actual-dm');
      envelope.messageLocator = {
        v: 1,
        origin: 'protocol-message',
        iface: invalid.iface,
        chatId: invalid.chatId,
        messageId: invalid.messageId,
      };
      const result = observe(env.handle, envelope, { now: () => HANDLES_NOW });
      assert.equal(result.ok, false);
      assert.equal(result.code, OBSERVE_CODES.BAD_NATIVE);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM sources').get()?.count, 0);
    } finally {
      env.done();
    }
  });
}

// Two interfaces connected to one core at once, as units: the same native chat, member and root ids on
// both, and several roots on one. Nothing calls a provider: the model is a function that answers every request.

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const ANSWER = 'γεια σου';
const SELF = { id: 'self-id', name: 'Nova' };

type Running = Awaited<ReturnType<typeof startFake>>;

async function withTwoInterfaces(
  body: (rig: { fake: Running; other: Running; requests: Array<unknown>; dataDir: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ti-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', owners: ['u1'], placeId: 'g1' },
      dm: { enabled: true },
      private: { minAffinity: 0 },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 2000 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  for (const name of ['fake', 'other']) {
    addClient(dataDir, name, { kind: 'interface', iface: name, permissions: [] });
  }
  const requests: Array<unknown> = [];
  const core = await startCore({
    paths: { rootDir: REPO, privateDir: dataDir, dataDir },
    env: {},
    interfaces: [],
    llm: {
      complete: (messages: unknown) => {
        requests.push(messages);
        return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
      },
    },
    embedder: { embed: () => Promise.resolve([]) },
  });
  const started: Array<Running> = [];
  const connect = async (name: string, roots: ReadonlyArray<{ id: string; name: string }>) => {
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const running = await startFake(
      {
        connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
        token: readFileSync(join(dataDir, 'clients', `${name}.token`), 'utf8').trim(),
        dataDir: join(dataDir, 'interfaces', name),
        env: {},
        config: () => ({}),
        onConfigChange: () => () => {},
        log,
      },
      { adapter: createFakeAdapter({ iface: name, selfId: SELF.id }), self: SELF, roots }
    );
    started.push(running);
    return running;
  };
  try {
    const fake = await connect('fake', [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' },
    ]);
    const other = await connect('other', [{ id: 'g3', name: 'Gamma' }]);
    await body({ fake, other, requests, dataDir });
  } finally {
    for (const running of started) await running.stop();
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a DM on the second interface is answered there and kept in that account own DM scope', async () => {
  // Bug: the turn's memory context names the home interface, so the DM lands in a person nobody can read it back as.
  await withCapturedLogs(async () => {
    await withTwoInterfaces(async ({ other, dataDir }) => {
      other.adapter.seedChat({ ...channelInfo('c1'), rootId: 'g3', iface: 'other' });
      other.adapter.seedMember('g3', { id: 'u1', name: 'Eleni' } as Parameters<Running['adapter']['seedMember']>[1]);
      const first = deliver(other.adapter, { id: 'm1', text: 'Nova, hello', at: Date.now(), mention: true });
      await other.emit({ ...first, iface: 'other', chat: { ...first.chat, rootId: 'g3' } });
      await until(() => other.adapter.messagesIn('c1').some((message) => message.authorId === SELF.id));

      other.adapter.seedChat({
        ...channelInfo('d1'),
        kind: 'dm',
        rootId: null,
        partnerId: 'u1',
        iface: 'other',
      });
      const direct = deliver(other.adapter, { chatId: 'd1', id: 'm2', text: 'hello', at: Date.now() });
      await other.emit({
        ...direct,
        iface: 'other',
        chat: { id: 'd1', kind: 'dm', rootId: null, partnerId: 'u1', name: 'Eleni' },
      });
      await until(() => other.adapter.messagesIn('d1').some((message) => message.authorId === SELF.id));
      const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
      try {
        const rows = (handle.db as { prepare(sql: string): { all(): Array<{ audience_id: string }> } })
          .prepare(`SELECT DISTINCT audience_id FROM sources WHERE scope_kind = 'dm'`)
          .all();
        assert.deepEqual(
          rows.map((row) => row.audience_id),
          ['aud:dm:other:dm:u1']
        );
      } finally {
        handle.close();
      }
    });
  });
});

// The normalized-message writer and its family catalog, using synthetic envelopes and SQLite only.

const WORKER_NOW = Date.parse('2026-10-24T12:00:00Z');
const workerQuiet = { debug() {}, info() {}, warn() {}, error() {} };
const options = { now: () => WORKER_NOW, log: workerQuiet };

function envelope(chatId = 'room-a', text = 'Original evidence', edited = false): Envelope {
  const mapped = observationOf({
    iface: 'synthetic',
    at: WORKER_NOW,
    edit: edited,
    chat: { id: chatId, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: WORKER_NOW - 60000, content: text, author: { id: 'member' } },
  });
  assert.ok(mapped);
  return { ...mapped, messageChat: { id: chatId, chatType: 'channel' } };
}

function sourceId(result: ObserveResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (typeof result.sourceId !== 'string') throw new Error('successful observation has no source ID');
  return result.sourceId;
}

function rows(db: Db, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

test('generic observation retains tuple identity when a replay changes its place', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const firstEnvelope = envelope();
    const first = sourceId(observe(handle, firstEnvelope, options));
    const changed = { ...firstEnvelope, place: { ...firstEnvelope.place, key: 'channel:room-b' } };
    assert.equal(sourceId(observe(handle, changed, options)), first);
    assert.equal(rows(dbOf(handle), 'sources').length, 1);
  } finally {
    handle.close();
  }
});

// Exact stored source handles and verified native locators use synthetic SQLite evidence.

const HANDLES_DAY = 86400000;
const HANDLES_NOW2 = Date.parse('2026-10-24T12:00:00.000Z');
const group = groupContext('discord');
const run = (
  env: ReturnType<typeof fixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = group
) => search(env.db, { ctx, plan: { forms, who: [], from: null, to: null, ...given }, now: HANDLES_NOW2, ...rest });

function handlesLocatorEvent(id: string, chatId: string, offset = 0) {
  const event = lineEvent({
    id,
    chatId,
    authorId: 'partner-42',
    text: `το κουνέλι ${id}`,
    at: HANDLES_NOW2 - HANDLES_DAY - offset,
  });
  event.chat = { id: chatId, kind: 'dm', rootId: null, partnerId: 'partner-42' };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid protocol fixture was refused');
  return envelope;
}

test('stored source locator metadata cannot be issued by generic observation extra fields', () => {
  const env = fixture();
  try {
    const envelope: Envelope = {
      v: 1,
      iface: 'other',
      authority: 'other/generic',
      native: { kind: 'message', key: 'generic:room:42', revision: 1 },
      place: { authority: 'other/generic', key: 'opaque-room', kind: 'room', chat: 'group' },
      author: { kind: 'account', key: 'author-42' },
      occurredAt: new Date(HANDLES_NOW2 - HANDLES_DAY).toISOString(),
      observedAt: new Date(HANDLES_NOW2).toISOString(),
      text: 'το κουνέλι spoof-marker',
      extra: {
        $messageLocator: {
          v: 1,
          origin: 'protocol-message',
          iface: 'other',
          chatId: 'forged-room',
          messageId: 'forged-message',
        },
      },
    };
    const source = observe(env.handle, envelope, { now: () => HANDLES_NOW2 });
    assert.equal(source.ok, true);
    env.stem();
    const found = run(env, ['κουνέλι']);
    const message = found.windows.flatMap((one) => one.messages).find((one) => one.content.includes('spoof-marker'));
    assert.equal(message?.stored?.sourceId, source.sourceId);
    assert.equal(message?.stored?.native, undefined);
    const guessed = window(env.db, {
      ctx: group,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'other', chatId: 'forged-room', messageId: 'forged-message' },
      },
    });
    assert.equal(guessed.unknown, true);
    assert.deepEqual(guessed.windows, []);
  } finally {
    env.done();
  }
});

test('stored source locator replay cannot replace the first verified chat', () => {
  const env = fixture();
  try {
    const first = observe(env.handle, handlesLocatorEvent('replayed-message', 'first-dm'), { now: () => HANDLES_NOW2 });
    const replay = observe(env.handle, handlesLocatorEvent('replayed-message', 'second-dm'), {
      now: () => HANDLES_NOW2,
    });
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.sourceId, first.sourceId);
    env.stem();
    const found = run(env, ['κουνέλι'], {}, internalContext());
    const message = found.windows.flatMap((one) => one.messages).find((one) => one.id === 'replayed-message');
    assert.deepEqual(message?.stored?.native, {
      iface: 'fake',
      chatId: 'first-dm',
      messageId: 'replayed-message',
    });
    const redirected = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'second-dm', messageId: 'replayed-message' },
      },
    });
    assert.equal(redirected.unknown, true);
  } finally {
    env.done();
  }
});

// The memory database service (src/memory/db/service.ts): the open and the writer lock, the shutdown, the per-turn
// record, the session writes and the status line. Synthetic data directories only; the clock and the loop are injected.

type LogFn = (message: string, fields?: object) => unknown;

function logs(): { out: Array<Record<string, unknown>>; info: LogFn; warn: LogFn; error: LogFn; debug?: LogFn } {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

// The owner's command line, as its interface names it (src/protocol/identity.ts#nativeAuthorityOf: `cli/local`).
const CONSOLE_CHAT = 'cli:dm:owner';
const CONSOLE_AT = Date.UTC(2026, 10, 10, 21, 40, 0);
const CONSOLE_WORDS = 'το φανάρι στο λιμάνι';

/** A line of the command line as its interface hands it, from the persona (`self`) or from the owner. */
function consoleEvent(id: string, at: number, self: boolean) {
  return {
    iface: 'cli',
    at,
    chat: { id: CONSOLE_CHAT, kind: 'dm', chatType: 'dm', partnerId: 'owner', rootId: null },
    message: { id, at, content: CONSOLE_WORDS, author: { id: self ? 'self' : 'owner', self } },
  };
}

function consoleEnvelope(id: string, at: number, self: boolean) {
  const envelope = observationOf(consoleEvent(id, at, self), { selfId: 'self' });
  if (!envelope) throw new Error('the synthetic event was refused');
  return envelope;
}

test("the persona's command line line recorded before its echo is observed again once their account sits under cli/local", async () => {
  // Bug: the record writes the family of the persona's line under `cli/global`
  // (src/memory/db/record-lines.ts), the persona's account `cli:self` sits under `cli/local`, and the history read observes the line
  // again. The replay fills the persona's account (observe.ts#fillOwnAuthor), looks it up under the family's `cli/global`, misses,
  // and inserts `cli:self` a second time: `UNIQUE constraint failed: accounts.id`, ERR_SQLITE_ERROR on every retry.
  const log = logs();
  const memory = await openTestMemory({ iface: () => 'cli', now: () => CONSOLE_AT + 60_000, log });
  try {
    // The persona's echo of an earlier line makes their account of the command line under its native authority.
    const echoed = await memory.memoryDb.observeMessage(consoleEnvelope('said-0', CONSOLE_AT - 60_000, true), {
      placeId: CONSOLE_CHAT,
    });
    assert.equal((echoed as { ok?: unknown } | null)?.ok, true, "the scene makes the persona's account");
    // The persona's next line reaches the record before any echo, as a turn's journal writes it.
    const line = toRecordLine(
      {
        id: 'said-1',
        placeId: CONSOLE_CHAT,
        content: CONSOLE_WORDS,
        ts: CONSOLE_AT,
        replyToId: null,
        mentionedAccountIds: [],
      },
      { kind: 'said', now: () => CONSOLE_AT, turnId: 't-1', opId: 'op-1' }
    );
    await createRecord({ ...memory, now: () => CONSOLE_AT }).append(CONSOLE_CHAT, [line], {});
    // The next turn's history read hands the same line to the observation (src/pipeline/keep-lines.ts).
    const replayed = await memory.memoryDb.observeMessage(consoleEnvelope('said-1', CONSOLE_AT, true), {
      placeId: CONSOLE_CHAT,
    });
    assert.deepEqual(
      log.out.filter((entry) => entry.message === 'memory db: observe failed'),
      [],
      'the replay fails no statement'
    );
    assert.equal((replayed as { ok?: unknown } | null)?.ok, true);
    const db = memory.memoryDb.database();
    const authors = db?.prepare("SELECT author_account FROM sources WHERE kind = 'said' ORDER BY occurred_at").all();
    assert.deepEqual(
      authors?.map((row) => row.author_account),
      ['cli:self', 'cli:self'],
      "both of the persona's lines name their one account"
    );
    assert.equal(db?.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'self' AND iface = 'cli'").get()?.n, 1);
  } finally {
    await memory.close();
  }
});

// One DM place is one scope: whatever values its rows carry in `scope_dm`, a memory session sweeps it once, from one cursor,
// and no line is read twice or left unread. The values come from history (a line seen before the account was linked, the
// importer's spelling of the command line, the owner's person on new lines); a link made later must not fork the DM again.
// Synthetic ids and text only. The scopes and batches are read through the exports of `session.ts`, as the sweep reads them.

const cliScopes = (db: Db): Array<SweepScope> =>
  scopesOf(db, { audienceColumn: true }).filter((one) => one.scope.scope_iface === 'cli');

/** The ids of the lines the sweep would read for `scope` after `cursor`, in the order it reads them. */
const batchIds = (db: Db, sweep: SweepScope, cursor: number): Array<string> =>
  batchOf(db, sweep.scope, {
    cursor,
    since: null,
    maxMessages: 1000,
    settleBefore: Number.POSITIVE_INFINITY,
    audienceId: sweep.audienceId ?? null,
  }).map((line) => String(line.id));

test('an account linked after its first lines does not fork the DM: every row of the place takes the partner', () => {
  // Bug: `linkOwnerAccount` re-points the place to the owner's person and nothing rewrites the rows already stored, so
  // the lines before the link keep one `scope_dm` and the lines after it carry another.
  const file = path.join(tempDir('nep-dm-link-later-'), 'memory.db');
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    const line = (n: number, link: boolean) => {
      const at = Date.parse('2026-11-05T10:00:00Z') + n * 60_000;
      const envelope = observationOf(
        {
          kind: 'message.received',
          iface: 'cli',
          at,
          chat: { id: CLI_PLACE, kind: 'dm', chatType: 'dm', partnerId: 'owner' },
          message: { id: `line-${n}`, at, content: 'a synthetic line', author: { id: 'owner', name: 'owner' } },
        },
        { connection: 'conn:cli', direct: true }
      );
      assert.ok(envelope);
      const given = link ? { ...envelope, consoleOwner: { person: OWNER, listed: [] } } : envelope;
      const stored = observe(handle, given, { now: () => at });
      assert.equal(stored.ok, true);
    };
    line(1, false);
    const before = db.prepare("SELECT scope_dm FROM sources WHERE place_id = ? AND kind = 'seen'").all(CLI_PLACE);
    assert.equal(before.length, 1);
    assert.notEqual(before[0]?.scope_dm, OWNER, 'the first line was stored before the account was linked');
    db.prepare(
      `INSERT INTO day (id, at, what, place_id, scope_kind, scope_iface, scope_dm, audience_id)
       VALUES ('day:before-link', '2026-11-05T10:00:30.000Z', 'turn', ?, 'dm', 'cli', ?, ?)`
    ).run(CLI_PLACE, before[0]?.scope_dm ?? null, CLI_AUDIENCE);

    line(2, true);
    line(3, true);

    assert.deepEqual(
      db
        .prepare("SELECT DISTINCT scope_dm FROM sources WHERE place_id = ? AND kind = 'seen'")
        .all(CLI_PLACE)
        .map((row) => ({ ...row })),
      [{ scope_dm: OWNER }],
      'the lines before and after the link share one scope_dm'
    );
    assert.deepEqual(
      db
        .prepare("SELECT scope_dm, audience_id FROM day WHERE id = 'day:before-link'")
        .all()
        .map((row) => ({ ...row })),
      [{ scope_dm: OWNER, audience_id: CLI_AUDIENCE }],
      'a derived row of the DM follows, and keeps its audience'
    );
    const scopes = cliScopes(db);
    assert.equal(scopes.length, 1);
    assert.equal(batchIds(db, scopes[0], 0).length, 3, 'all three lines are read, once');
  } finally {
    handle.close();
  }
});

// The address of a direct chat is the interface's: the core stores the chat id a `message.received` carries on the
// place (`places.native_id`), for a direct chat as for a channel, and hands it back as it is for every read of the
// place. A direct chat whose place holds no address yet is opened once through the `dm.chat` read and the answer is
// stored through the one writer. A read that fails tells the persona the interface's code. Real temporary databases, the fake
// interface, synthetic names.

const CHAT_NOW = Date.parse('2026-11-02T10:00:00.000Z');
const chatQuiet = { info() {}, warn() {}, error() {} };
const PARTNER = '777';
const DM_CHAT = 'dm-chat-41';

function dmEvent(chatId: string, id: string): Record<string, unknown> {
  return {
    kind: 'message.received',
    iface: 'other',
    at: CHAT_NOW,
    id: `other:message:${id}`,
    chat: { id: chatId, kind: 'dm', chatType: 'dm', partnerId: PARTNER, rootId: null },
    message: {
      id,
      author: { id: PARTNER, name: 'Orestis', self: false, bot: false },
      content: 'γεια',
      at: CHAT_NOW,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

function dmAddresses(events: ReadonlyArray<Record<string, unknown>>): Array<unknown> {
  const handle = openMemoryDb(':memory:');
  try {
    for (const event of events) {
      const result = observe(handle, observationOf(event), { now: () => CHAT_NOW, log: chatQuiet });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    return dbOf(handle)
      .prepare("SELECT native_id FROM places WHERE kind = 'dm'")
      .all()
      .map((row) => row.native_id);
  } finally {
    handle.close();
  }
}

test('a direct message stores the chat id the interface gave as its place address', () => {
  // Bug: the core keyed a direct chat by its partner and dropped the chat's address, so no read could reach the chat.
  assert.deepEqual(dmAddresses([dmEvent(DM_CHAT, 'm1')]), [DM_CHAT]);
});

test('a direct chat stored without an address takes it from its next message', () => {
  // Bug: a direct chat observed before addresses were stored keeps none for good.
  const handle = openMemoryDb(':memory:');
  try {
    observe(handle, observationOf(dmEvent(DM_CHAT, 'm1')), { now: () => CHAT_NOW, log: chatQuiet });
    dbOf(handle).prepare("UPDATE places SET native_id = NULL WHERE kind = 'dm'").run();
    observe(handle, observationOf(dmEvent(DM_CHAT, 'm2')), { now: () => CHAT_NOW, log: chatQuiet });
    const rows = dbOf(handle).prepare("SELECT native_id FROM places WHERE kind = 'dm'").all();
    assert.deepEqual(
      rows.map((row) => row.native_id),
      [DM_CHAT]
    );
  } finally {
    handle.close();
  }
});

// The other order of one send: the record line lands before the interface's echo of the same message. The two must
// still be one `sources` row, and that row must read as the one the echo-first order leaves. Synthetic data only.

const FIRST_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = FIRST_NOW - 60_000;
const IFACE = 'synthetic';
const ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, ROOT);
const ROOM = 'room-a';
const SELF_ID = 'her-account';
const FIRST_MEMBER = 'member-account';
const WORDS = 'τα κλειδιά στο συρτάρι';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function observeLine(
  memory: Memory,
  {
    id = 'sent-1',
    author = SELF_ID,
    at = SENT,
    replyToId,
  }: { id?: string; author?: string; at?: number; replyToId?: string } = {}
): Promise<string> {
  const event = {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: ROOT },
    addressing: { mentionedAccountIds: [] },
    message: {
      id,
      at,
      content: WORDS,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
  const envelope = observationOf(event, { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

async function recordSent(memory: Memory): Promise<void> {
  const line = toRecordLine(
    { id: 'sent-1', placeId: ROOM, content: WORDS, ts: SENT, replyToId: null, mentionedAccountIds: [] },
    { kind: 'said', now: () => FIRST_NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => FIRST_NOW }).append(TOP, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

const saidRows = (db: Db): Array<Row> => db.prepare("SELECT * FROM sources WHERE kind = 'said' ORDER BY rowid").all();

async function withOrder(
  order: 'record-first' | 'echo-first',
  run: (memory: Memory, db: Db) => Promise<void> | void
): Promise<void> {
  const memory = await openTestMemory({ now: () => FIRST_NOW, iface: () => IFACE });
  try {
    if (order === 'record-first') {
      await recordSent(memory);
      await observeLine(memory);
    } else {
      await observeLine(memory);
      await recordSent(memory);
    }
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test("a line recorded before its echo names the persona's account as its author", async () => {
  // Bug: the echo is a replay that leaves the row alone, so the persona's line keeps no author account.
  await withOrder('record-first', (_memory, db) => {
    const account = db.prepare('SELECT id FROM accounts WHERE native_key = ?').get(SELF_ID);
    const row = saidRows(db)[0];
    assert.equal(row?.author_kind, 'self');
    assert.equal(row?.author_account, account?.id);
  });
});

test("a member reply to a line recorded before its echo points at the row with the persona's turn", async () => {
  // Bug: the reply resolves its target through the family and misses a row keyed by anything else.
  await withOrder('record-first', async (memory, db) => {
    const reply = await observeLine(memory, {
      id: 'reply-1',
      author: FIRST_MEMBER,
      at: SENT + 1000,
      replyToId: 'sent-1',
    });
    const target = db
      .prepare(
        `SELECT t.turn_id FROM source_relations r JOIN sources t ON t.id = r.target_source_id
         WHERE r.source_id = ? AND r.predicate = 'replies_to'`
      )
      .get(reply);
    assert.equal(target?.turn_id, 't-1');
  });
});

// One sent line, one `sources` row. The interface echoes the persona's own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.

const SINGLE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SINGLE_SENT = SINGLE_NOW - 60_000;
const SINGLE_MEMBER = 'member-account';
const SINGLE_WORDS = 'κουνέλι στον κήπο';

/** The `message.received` event of a line: the persona's when `author` is their id, as the interface delivers their own echo. */
function singleLineEvent({
  id = 'sent-1',
  author = SELF_ID,
  at = SINGLE_SENT,
  text = SINGLE_WORDS,
  replyToId,
  mentionedAccountIds = [],
}: {
  id?: string;
  author?: string;
  at?: number;
  text?: string;
  replyToId?: string;
  mentionedAccountIds?: Array<string>;
} = {}) {
  return {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: ROOT },
    addressing: { mentionedAccountIds },
    message: {
      id,
      at,
      content: text,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

async function singleObserveLine(memory: Memory, options: Parameters<typeof singleLineEvent>[0] = {}): Promise<string> {
  const envelope = observationOf(singleLineEvent(options), { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

/** The record line of the persona's send, as recordSaid builds it, appended with no descriptor as every said writer does. */
async function singleRecordSent(
  memory: Memory,
  { mentionedAccountIds = [] }: { mentionedAccountIds?: Array<string> } = {}
) {
  const line = toRecordLine(
    { id: 'sent-1', placeId: ROOM, content: SINGLE_WORDS, ts: SINGLE_SENT, replyToId: null, mentionedAccountIds },
    { kind: 'said', now: () => SINGLE_NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => SINGLE_NOW }).append(TOP, [line], {});
}

async function withEchoedLine(run: (memory: Memory, db: Db) => Promise<void> | void): Promise<void> {
  const memory = await openTestMemory({ now: () => SINGLE_NOW, iface: () => IFACE });
  try {
    await singleObserveLine(memory);
    await singleRecordSent(memory);
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test("a member reply to the persona's echoed line points at the row that carries their turn", async () => {
  // Bug: the reply resolves to the echo's row, so the turn's row looks unanswered.
  await withEchoedLine(async (memory, db) => {
    const reply = await singleObserveLine(memory, {
      id: 'reply-1',
      author: SINGLE_MEMBER,
      at: SINGLE_SENT + 1000,
      replyToId: 'sent-1',
    });
    const target = db
      .prepare(
        `SELECT t.turn_id FROM source_relations r JOIN sources t ON t.id = r.target_source_id
         WHERE r.source_id = ? AND r.predicate = 'replies_to'`
      )
      .get(reply);
    assert.equal(target?.turn_id, 't-1');
  });
});
