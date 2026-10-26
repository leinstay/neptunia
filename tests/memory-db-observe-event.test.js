// Stage 8a (spec 2026-10-24-memory-schema-v7): the Discord interface on the observation path. A discord.js-shaped
// message goes through the adapter (toEvent), the core's mapping (observe-event.js#observationOf) and the envelope
// check, and is written by observe.js; on a database the record's unit writes made from the same lines, observe finds
// the rows they wrote and mints none, and in the live order (observe first, the record later) the record's writes take
// over the rows observe wrote. Synthetic text only (Greek or accented Latin for non-ASCII); the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { toEvent, normalizedOf } from '../interfaces/discord/collect.js';
import { validateEvent } from '../src/protocol/index.js';
import { observationOf } from '../src/memory/db/observe-event.js';
import { checkEnvelope, observe } from '../src/memory/db/observe.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { createMemoryDb } from '../src/memory/db/service.js';
import { slimMessage, toRecordLine } from '../src/memory/index.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir, guildDir, writeJson, writeLines } from './fixtures/memory-db/datadir.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const SELF = '100000000000000009';
const MEMBER2 = '100000000000000002';
const BOT = '100000000000000008';
const DM_CHANNEL = '200000000000000099';
const opts = { now: () => NOW, log: quiet };
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

const NAMES = { [MEMBER]: 'Ada', [MEMBER2]: 'Zoé', [SELF]: 'Her', [BOT]: 'Robot' };

function channelOf({ id = CHANNEL, name = 'γενικά', thread = false, type, recipientId, parentId } = {}) {
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
function message({
  id,
  channel = channelOf(),
  author = MEMBER,
  content,
  at,
  replyTo = null,
  mentions = [],
  guild = true,
  editedAt = null,
}) {
  return {
    id,
    channelId: channel.id,
    channel,
    guild: guild ? { id: GUILD } : null,
    guildId: guild ? GUILD : null,
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

const eventOf = (raw, options = {}) => {
  const event = toEvent(raw, SELF, options);
  assert.deepEqual(validateEvent(event), { ok: true });
  return event;
};

const dmChannel = () => channelOf({ id: DM_CHANNEL, name: null, type: ChannelType.DM, recipientId: MEMBER });

/** The lines of the fixture day, as the gateway delivers them, with what the record writes for each. */
function day() {
  const first = message({ id: '400000000000000101', content: 'Καλημέρα σε όλους', at: T0 });
  const reply = message({
    id: '400000000000000102',
    author: MEMBER2,
    content: 'γεια @Ada',
    at: T0 + 30_000,
    replyTo: first.id,
    mentions: [MEMBER],
  });
  const edited = message({ id: first.id, content: 'Καλημέρα σε όλους!', at: T0, editedAt: T0 + 60_000 });
  const hers = message({ id: '400000000000000103', author: SELF, content: 'καλημέρα κι από μένα', at: T0 + 90_000 });
  const dmLine = message({
    id: '400000000000000104',
    channel: dmChannel(),
    guild: false,
    content: 'ένα μυστικό',
    at: T0 + 120_000,
  });
  const dmHers = message({
    id: '400000000000000105',
    channel: dmChannel(),
    author: SELF,
    guild: false,
    content: 'το κρατάω',
    at: T0 + 150_000,
  });
  const events = [
    { event: eventOf(first), direct: false },
    { event: eventOf(reply), direct: false },
    { event: eventOf(edited, { edit: true, previous: first, now: () => T0 + 61_000 }), direct: false },
    { event: eventOf(hers), direct: false },
    { event: eventOf(dmLine), direct: true },
    { event: eventOf(dmHers), direct: false },
  ];
  const stamp = (line) => ({ ...line, guildId: GUILD });
  const seen = (event, { direct = false, revision = 1, replyToAuthorId = null } = {}) =>
    stamp(
      toRecordLine(
        { ...slimMessage(normalizedOf(event), direct), ...(replyToAuthorId ? { replyToAuthorId } : {}) },
        { revision, now: () => event.at + 1000 }
      )
    );
  const said = (event) =>
    stamp(
      toRecordLine(
        {
          id: event.message.id,
          channelId: event.conversation.id,
          content: event.message.content,
          ts: event.message.at,
          replyToId: null,
          mentionedUserIds: [],
        },
        { kind: 'said', now: () => event.message.at + 500, turnId: 'turn-8a' }
      )
    );
  const record = [
    seen(events[0].event),
    seen(events[1].event, { replyToAuthorId: MEMBER }),
    seen(events[2].event, { revision: 2 }),
    said(events[3].event),
  ];
  const privateRecord = [seen(events[4].event, { direct: true }), said(events[5].event)];
  return { events, record, privateRecord };
}

/** A data directory (the shared fixture, a second member) and its database with its units written. */
function imported({ withRecord }) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-8a-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  writeJson(path.join(guildDir(data), 'users', `${MEMBER2}.json`), { id: MEMBER2, names: ['Zoé'] });
  const fixture = day();
  const writeRecord = () => {
    writeLines(path.join(guildDir(data), 'record', '2026-10', '2026-10-24.jsonl'), fixture.record);
    writeLines(
      path.join(guildDir(data), 'private', MEMBER, 'record', '2026-10', '2026-10-24.jsonl'),
      fixture.privateRecord
    );
  };
  if (withRecord) writeRecord();
  const file = path.join(root, 'memory.db');
  const handle = openMemoryDb(file);
  assert.equal(seedUnits(handle, data, { log: quiet, now: () => NOW }).errors, 0);
  return {
    root,
    data,
    file,
    handle,
    fixture,
    writeRecord,
    done: () => {
      try {
        handle.close();
      } catch {
        /* closed */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const ids = (db, table) =>
  db
    .prepare(`SELECT id FROM "${table}" ORDER BY id`)
    .all()
    .map((row) => row.id);
const observeAll = (handle, events) =>
  events.map(({ event, direct }) => {
    const envelope = observationOf(event, { selfId: SELF, direct });
    assert.equal(checkEnvelope(envelope), null);
    const done = observe(handle, envelope, opts);
    assert.equal(done.ok, true, JSON.stringify(done));
    return done;
  });

// ---------- the envelope round trip ----------

test('observationOf: every kind of line goes from toEvent through the envelope check into the database', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    const write = (raw, options = {}, direct = false) => {
      const envelope = observationOf(eventOf(raw, options), { selfId: SELF, direct });
      assert.equal(checkEnvelope(envelope), null, JSON.stringify(envelope));
      const done = observe(handle, envelope, opts);
      assert.equal(done.ok, true, JSON.stringify(done));
      return { envelope, done, row: db.prepare('SELECT * FROM sources WHERE id = ?').get(done.sourceId) };
    };
    const placeOf = (done) => db.prepare('SELECT * FROM places WHERE id = ?').get(done.placeId);
    const accountOf = (row) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.author_account);

    // A channel line: the channel's place, a group line, an account of kind user, the importer's ids.
    const line = write(message({ id: 'm-1', content: 'μια γραμμή', at: T0 }));
    assert.deepEqual(line.envelope.native, { kind: 'message', key: 'm-1', subtype: 'seen', revision: 1 });
    assert.equal(line.done.sourceId, 'src:discord:m-1:1:seen');
    assert.deepEqual({ ...placeOf(line.done) }.native_key, `channel:${CHANNEL}`);
    assert.equal(line.done.placeId, `discord:channel:${CHANNEL}`);
    assert.equal(placeOf(line.done).native_id, CHANNEL);
    assert.equal(line.row.audience_id, 'aud:group:discord');
    assert.deepEqual([accountOf(line.row).id, accountOf(line.row).kind], [`discord:${MEMBER}`, 'user']);
    assert.equal(line.row.occurred_at, new Date(T0).toISOString());

    // A reply with a mention: the reply relation (resolved to the stored line), the mention, the columns.
    const reply = write(
      message({ id: 'm-2', author: MEMBER2, content: 'απάντηση', at: T0 + 1000, replyTo: 'm-1', mentions: [MEMBER] }),
      {},
      true
    );
    assert.equal(reply.row.reply_to, 'm-1');
    assert.equal(reply.row.mentions, JSON.stringify([MEMBER]));
    assert.equal(reply.row.direct, 1);
    const relations = db
      .prepare('SELECT predicate, target_source_id FROM source_relations WHERE source_id = ? ORDER BY predicate')
      .all(reply.done.sourceId)
      .map((r) => ({ ...r }));
    assert.deepEqual(relations, [
      { predicate: 'mentions', target_source_id: null },
      { predicate: 'replies_to', target_source_id: line.done.sourceId },
    ]);

    // An edit: no revision in the envelope; the database gives it the next one, and the same text again is that one.
    const edited = message({ id: 'm-1', content: 'μια γραμμή, διορθωμένη', at: T0, editedAt: T0 + 5000 });
    const edit = write(edited, { edit: true, now: () => T0 + 6000 });
    assert.equal(edit.envelope.edited, true);
    assert.equal(edit.envelope.native.revision, undefined);
    assert.equal(edit.done.sourceId, 'src:discord:m-1:2:seen');
    assert.equal(edit.row.revision, 2);
    const again = observe(
      handle,
      observationOf(eventOf(edited, { edit: true, now: () => T0 + 7000 }), { selfId: SELF }),
      opts
    );
    assert.deepEqual([again.replayed, again.sourceId], [true, edit.done.sourceId]);

    // A bot line: an account of kind bot.
    const bot = write(message({ id: 'm-3', author: BOT, content: 'beep', at: T0 + 2000 }));
    assert.equal(accountOf(bot.row).kind, 'bot');

    // Her own line: author self, subtype said, her account of kind self; an edit of it is a seen line, as the record writes it.
    const hers = write(message({ id: 'm-4', author: SELF, content: 'δική μου', at: T0 + 3000 }));
    assert.deepEqual([hers.row.kind, hers.row.author_kind, accountOf(hers.row).kind], ['said', 'self', 'self']);
    assert.equal(hers.done.sourceId, 'src:discord:m-4:1:said');
    const herEdit = write(
      message({ id: 'm-4', author: SELF, content: 'δική μου, αλλαγμένη', at: T0 + 3000, editedAt: T0 + 4000 }),
      { edit: true, now: () => T0 + 4000 }
    );
    assert.deepEqual([herEdit.row.kind, herEdit.row.revision], ['seen', 2]);

    // A one-to-one DM: the partner's place (`dm:<partner>`), its own audience; the partner is an account nobody linked.
    const dm = write(message({ id: 'm-5', channel: dmChannel(), guild: false, content: 'ιδιωτικά', at: T0 + 5000 }));
    assert.deepEqual(dm.envelope.place, {
      authority: 'discord/global',
      key: `dm:${MEMBER}`,
      kind: 'dm',
      conversation: 'dm',
      partner: { key: MEMBER },
    });
    assert.equal(dm.done.placeId, `discord:dm:${MEMBER}`);
    assert.deepEqual(
      {
        conversation: placeOf(dm.done).conversation,
        partner: placeOf(dm.done).partner_account,
        person: placeOf(dm.done).partner_person,
      },
      { conversation: 'dm', partner: `discord:${MEMBER}`, person: null }
    );
    assert.equal(dm.row.audience_id, `aud:dm:discord:dm:${MEMBER}`);

    // A group DM: a group conversation of its own.
    const group = write(
      message({
        id: 'm-6',
        channel: channelOf({ id: 'gdm-1', name: 'φίλοι', type: ChannelType.GroupDM }),
        guild: false,
        content: 'όλοι μαζί',
        at: T0 + 6000,
      })
    );
    assert.deepEqual(
      [group.envelope.place.key, group.envelope.place.kind, group.envelope.place.conversation],
      ['group_dm:gdm-1', 'group_dm', 'group']
    );
    assert.equal(group.row.audience_id, 'aud:group:discord');

    // A thread: its own place, contained in its channel's.
    const thread = write(
      message({
        id: 'm-7',
        channel: channelOf({ id: 'th-1', name: 'νήμα', thread: true, parentId: CHANNEL }),
        content: 'στο νήμα',
        at: T0 + 7000,
      })
    );
    assert.deepEqual([thread.envelope.place.key, thread.envelope.place.parent], ['thread:th-1', `channel:${CHANNEL}`]);
    assert.equal(placeOf(thread.done).parent_id, `discord:channel:${CHANNEL}`);
    assert.notEqual(thread.done.placeId, `discord:thread:th-1`, 'a thread is no importer spelling');

    // No line: a deletion, a partial edit, a DM whose partner the event does not name.
    assert.equal(
      observationOf(eventOf(message({ id: 'm-8', content: 'x', at: T0 }), { deleted: true, now: () => T0 })),
      null
    );
    assert.equal(
      observationOf(
        eventOf(
          { id: 'm-9', channelId: CHANNEL, guildId: GUILD, partial: true, author: null },
          { edit: true, now: () => T0 }
        )
      ),
      null
    );
    assert.equal(
      observationOf(
        eventOf(
          message({ id: 'm-10', channel: channelOf({ id: 'd-x', name: null }), guild: false, content: 'x', at: T0 })
        )
      ),
      null
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

test('checkEnvelope: a revision may be left out only by an edit; mentions, direct and the account kind are checked', () => {
  const base = observationOf(eventOf(message({ id: 'm-1', content: 'x', at: T0 })), { selfId: SELF });
  assert.equal(checkEnvelope(base), null);
  assert.equal(checkEnvelope({ ...base, native: { ...base.native, revision: undefined } }), 'BAD_NATIVE');
  assert.equal(checkEnvelope({ ...base, edited: true, native: { ...base.native, revision: undefined } }), null);
  assert.equal(checkEnvelope({ ...base, edited: 'yes' }), 'BAD_NATIVE');
  assert.equal(checkEnvelope({ ...base, mentions: [''] }), 'BAD_RELATION');
  assert.equal(checkEnvelope({ ...base, direct: 1 }), 'BAD_ENVELOPE');
  assert.equal(checkEnvelope({ ...base, author: { ...base.author, account_kind: 'robot' } }), 'BAD_AUTHOR');
});

// ---------- the same rows as the record's ----------

test('observe on a database the record wrote from the same lines writes no new place or source', () => {
  const env = imported({ withRecord: true });
  try {
    const { db } = env.handle;
    const before = { places: ids(db, 'places'), accounts: ids(db, 'accounts'), sources: ids(db, 'sources') };
    const done = observeAll(env.handle, env.fixture.events);
    assert.ok(
      done.every((one) => one.replayed === true),
      'every line is the stored one'
    );
    assert.deepEqual(
      done.map((one) => one.sourceId),
      [
        'src:discord:400000000000000101:1:seen',
        'src:discord:400000000000000102:1:seen',
        'src:discord:400000000000000101:2:seen',
        'src:discord:400000000000000103:1:said',
        'src:discord:400000000000000104:1:seen',
        'src:discord:400000000000000105:1:said',
      ]
    );
    assert.deepEqual(ids(db, 'places'), before.places);
    assert.deepEqual(ids(db, 'sources'), before.sources);
    // A stored line is replayed: no account is made for it either.
    assert.deepEqual(ids(db, 'accounts'), before.accounts);
    // The DM line's relations and the reply's mention are the database's own rows; the reply's relation was the record's.
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) AS n FROM source_relations WHERE source_id = 'src:discord:400000000000000102:1:seen' AND predicate = 'replies_to'"
      ),
      1
    );
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) AS n FROM source_relations WHERE source_id = 'src:discord:400000000000000102:1:seen' AND predicate = 'mentions'"
      ),
      1
    );
    // A second pass is a replay through and through.
    const sizes = () =>
      ['sources', 'places', 'accounts', 'source_relations', 'external_keys'].map((table) =>
        count(db, `SELECT COUNT(*) AS n FROM "${table}"`)
      );
    const once = sizes();
    observeAll(env.handle, env.fixture.events);
    assert.deepEqual(sizes(), once);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    env.done();
  }
});

test("the live order: observe first, the record later; the record's writes take the observed rows over and nothing is doubled", () => {
  const env = imported({ withRecord: false });
  try {
    const { db } = env.handle;
    const done = observeAll(env.handle, env.fixture.events);
    assert.ok(done.every((one) => one.replayed === false));
    // The edit was counted by the database: the message's second revision, as the record will write it.
    assert.equal(done[2].sourceId, 'src:discord:400000000000000101:2:seen');
    env.writeRecord();
    assert.equal(seedUnits(env.handle, env.data, { log: quiet, now: () => NOW + 60_000 }).errors, 0);
    const natives = env.fixture.events.map(({ event }) => event.message.id);
    const mine = db
      .prepare(
        `SELECT id, owner_file, origin FROM sources WHERE native_id IN (${natives.map(() => '?').join(', ')}) ORDER BY id`
      )
      .all(...natives)
      .map((row) => ({ ...row }));
    assert.equal(mine.length, env.fixture.record.length + env.fixture.privateRecord.length, 'one row per record line');
    assert.ok(
      mine.every((row) => row.owner_file !== null && row.origin === 'live'),
      JSON.stringify(mine)
    );
    assert.equal(
      count(
        db,
        'SELECT COUNT(*) AS n FROM places WHERE id = ? AND owner_file IS NOT NULL',
        `discord:channel:${CHANNEL}`
      ),
      1
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    env.done();
  }
});

// ---------- through the service ----------

test("service: observe goes through the writer; an edit's revision survives a new service", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-8a-svc-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: {} };
  const start = () => createMemoryDb({ hot, dataDir: data, log: quiet, worker: false, now: () => NOW });
  const envelopeOf = (raw, options) => observationOf(eventOf(raw, options), { selfId: SELF });
  const first = message({ id: 'm-svc', content: 'πρώτη', at: T0 });
  try {
    const one = start();
    await one.tick();
    assert.equal((await one.observe(envelopeOf(first))).sourceId, 'src:discord:m-svc:1:seen');
    const edit = await one.observe(
      envelopeOf(message({ id: 'm-svc', content: 'δεύτερη', at: T0, editedAt: T0 + 1000 }), {
        edit: true,
        now: () => T0 + 1000,
      })
    );
    assert.equal(edit.sourceId, 'src:discord:m-svc:2:seen');
    await one.close();

    const two = start();
    await two.tick();
    const later = await two.observe(
      envelopeOf(message({ id: 'm-svc', content: 'τρίτη', at: T0, editedAt: T0 + 2000 }), {
        edit: true,
        now: () => T0 + 2000,
      })
    );
    assert.equal(later.sourceId, 'src:discord:m-svc:3:seen', 'the count lives in the database');
    assert.equal(await two.observe({ v: 1 }).then((done) => done.code), 'BAD_IFACE');
    await two.close();
    assert.equal(two.observe(envelopeOf(first)), null, 'closed: nothing is written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('service: an observation that comes before the database opens is written once it opens; one just before a shutdown lands before it closes', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-8a-queue-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: {} };
  const service = createMemoryDb({ hot, dataDir: data, log: quiet, worker: false, now: () => NOW });
  const envelopeOf = (raw) => observationOf(eventOf(raw), { selfId: SELF });
  try {
    // the start's catch-up runs before the database opens
    assert.equal(
      service.observe(envelopeOf(message({ id: 'm-early', content: 'early', at: T0 }))),
      null,
      'queued, not written yet'
    );
    await service.tick();
    // a line that arrives while the bot is stopping
    service.observe(envelopeOf(message({ id: 'm-late', content: 'late', at: T0 + 1000 })));
    await service.close();
    const reader = openMemoryDb(path.join(data, 'memory.db'), { readOnly: true });
    try {
      assert.deepEqual(
        reader.db
          .prepare("SELECT native_id FROM sources WHERE native_id IN ('m-early', 'm-late') ORDER BY native_id")
          .all()
          .map((row) => row.native_id),
        ['m-early', 'm-late']
      );
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
