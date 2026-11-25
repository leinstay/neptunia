// The mapping of an event to an observation. A discord.js-shaped message goes through the adapter (toEvent), the
// core's mapping (`observationOf`) and the envelope check, and is written by `observe`. An adapter's declared authority
// and containing place reach the observed place. Synthetic text only (Greek or accented Latin for non-ASCII); the ids
// are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { toEvent } from '../../../fixtures/sdk-shaped.ts';
import { validateEvent } from '../../../../src/protocol/index.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { checkEnvelope, observe } from '../../../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { CHANNEL, GUILD, MEMBER } from '../../../fixtures/memory-db/datadir.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { wrongly, present, sqlOf } from '../../../fixtures/loose-types.ts';
import { accountNodeOf } from '../../../../src/memory/db/person-links.ts';
import { nativeAuthorityOf } from '../../../../src/protocol/identity.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const SELF = '100000000000000009';
const MEMBER2 = '100000000000000002';
const BOT = '100000000000000008';
const DM_CHANNEL = '200000000000000099';
const opts = { now: () => NOW, log: quiet };

const NAMES: Record<string, string> = { [MEMBER]: 'Ada', [MEMBER2]: 'Zoé', [SELF]: 'Her', [BOT]: 'Robot' };

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
  const event = toEvent(raw, SELF, options);
  assert.deepEqual(validateEvent(event), { ok: true });
  return event;
};

const dmChannel = () => channelOf({ id: DM_CHANNEL, name: wrongly(null), type: ChannelType.DM, recipientId: MEMBER });

// ---------- the envelope round trip ----------

test('observationOf: every kind of line goes from toEvent through the envelope check into the database', () => {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  try {
    const write = (raw: Record<string, Untyped>, options = {}, direct = false) => {
      const envelope = observationOf(eventOf(raw, options), { selfId: SELF, direct });
      assert.equal(checkEnvelope(envelope), null, JSON.stringify(envelope));
      const done = observe(handle, envelope, opts);
      assert.equal(done.ok, true, JSON.stringify(done));
      return { envelope, done, row: db.prepare('SELECT * FROM sources WHERE id = ?').get(done.sourceId) };
    };
    const placeOf = (done: Record<string, Untyped>) =>
      db.prepare('SELECT * FROM places WHERE id = ?').get(done.placeId);
    const accountOf = (row: Record<string, Untyped>) =>
      db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.author_account);

    // A channel line: the channel's place, a group line, an account of kind user, the importer's ids.
    const line = write(message({ id: 'm-1', content: 'μια γραμμή', at: T0 }));
    assert.deepEqual(present(line.envelope).native, { kind: 'message', key: 'm-1', subtype: 'seen', revision: 1 });
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
    assert.equal(present(edit.envelope).edited, true);
    assert.equal(present(edit.envelope).native.revision, undefined);
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

    // The persona's own line: author self, subtype said, an account of kind self; an edit of it is a seen line, as the
    // record writes it.
    const personaLine = write(message({ id: 'm-4', author: SELF, content: 'δική μου', at: T0 + 3000 }));
    assert.deepEqual(
      [personaLine.row.kind, personaLine.row.author_kind, accountOf(personaLine.row).kind],
      ['said', 'self', 'self']
    );
    assert.equal(personaLine.done.sourceId, 'src:discord:m-4:1:said');
    const personaEdit = write(
      message({ id: 'm-4', author: SELF, content: 'δική μου, αλλαγμένη', at: T0 + 3000, editedAt: T0 + 4000 }),
      { edit: true, now: () => T0 + 4000 }
    );
    assert.deepEqual([personaEdit.row.kind, personaEdit.row.revision], ['seen', 2]);

    // A one-to-one DM: the partner's place (`dm:<partner>`), its own audience; the partner is an account nobody bound.
    const dm = write(message({ id: 'm-5', channel: dmChannel(), guild: false, content: 'ιδιωτικά', at: T0 + 5000 }));
    const partnerPerson = String(
      dbOf(handle).prepare('SELECT person_id FROM accounts WHERE id = ?').get(`discord:${MEMBER}`)?.person_id
    );
    // The DM carries the chat id the interface gave as its `address`, which the place stores for every read and send.
    assert.deepEqual(present(dm.envelope).place, {
      authority: 'discord/global',
      key: `dm:${MEMBER}`,
      kind: 'dm',
      chat: 'dm',
      address: DM_CHANNEL,
      partner: { key: MEMBER },
    });
    assert.equal(dm.done.placeId, `discord:dm:${MEMBER}`);
    assert.deepEqual(
      {
        chat: placeOf(dm.done).chat,
        partner: placeOf(dm.done).partner_account,
        person: placeOf(dm.done).partner_person,
      },
      // The partner's account has the meta-person its first line gave it, and the DM names it.
      { chat: 'dm', partner: `discord:${MEMBER}`, person: partnerPerson }
    );
    assert.match(partnerPerson, /^person:[0-9a-f]{8}-/);
    assert.equal(dm.row.audience_id, `aud:dm:discord:dm:${MEMBER}`);

    // A group DM: a group chat of its own.
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
      [present(group.envelope).place.key, present(group.envelope).place.kind, present(group.envelope).place.chat],
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
    assert.deepEqual(
      [present(thread.envelope).place.key, present(thread.envelope).place.parent],
      ['thread:th-1', `channel:${CHANNEL}`]
    );
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
          { id: 'm-9', chatId: CHANNEL, placeId: GUILD, partial: true, author: null },
          { edit: true, now: () => T0 }
        )
      ),
      null
    );
    assert.equal(
      observationOf(
        eventOf(
          message({
            id: 'm-10',
            channel: channelOf({ id: 'd-x', name: wrongly(null) }),
            guild: false,
            content: 'x',
            at: T0,
          })
        )
      ),
      null
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
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

const placeOf = (chat: Record<string, unknown>) => observationOf(eventIn(chat))?.place;

test('a declared authority names the observed place, so one native id under two authorities is two places', () => {
  // Bug: the observation hard-codes `<iface>/global`, and two tenants of one interface share a place.
  const room = { id: 'c1', kind: 'channel', rootId: 'g1' };
  assert.equal(observationOf(eventIn({ ...room, authorityId: 'other/tenant-a' }))?.authority, 'other/tenant-a');
  assert.equal(observationOf(eventIn({ ...room, authorityId: 'other/tenant-a' }))?.place.authority, 'other/tenant-a');
  assert.equal(observationOf(eventIn(room))?.authority, 'other/global');
});

test('a channel declares the place that contains it and stays a channel', () => {
  // Bug: only a thread may have a parent, so a server, a category or a workspace above a channel is lost.
  const place = placeOf({ id: 'c1', kind: 'channel', chatType: 'channel', parentId: 'cat1', parentKind: 'category' });
  assert.equal(place?.kind, 'channel');
  assert.equal(place?.chat, 'group');
  assert.equal(place?.parent, 'category:cat1');
});

test('a thread may sit in any kind of place, and one with no declared kind sits in a channel', () => {
  // Bug: the parent key is hard-coded `channel:`, so a thread of a board points at a channel that does not exist.
  const thread = { id: 't1', kind: 'thread', chatType: 'thread', parentId: 'f1' };
  assert.equal(placeOf({ ...thread, parentKind: 'board' })?.parent, 'board:f1');
  assert.equal(placeOf({ ...thread, parentKind: 'board' })?.kind, 'thread');
  assert.equal(placeOf(thread)?.parent, 'channel:f1');
});

test('a group chat may declare a containing place and keeps its kind', () => {
  // Bug: containment is read from the chat kind, so a group inside a workspace is taken for a free-standing one.
  const place = placeOf({ id: 'g1', kind: 'dm', chatType: 'group_dm', parentId: 's1', parentKind: 'workspace' });
  assert.equal(place?.kind, 'group_dm');
  assert.equal(place?.parent, 'workspace:s1');
});

// The normalized-message writer and its family catalog, using synthetic envelopes and SQLite only.

const FAMILIES_NOW = Date.parse('2026-10-24T12:00:00Z');

test('the protocol mapper retains actual DM chat separately from the partner place', () => {
  const mapped = observationOf({
    iface: 'synthetic',
    at: FAMILIES_NOW,
    chat: { id: 'actual-dm', kind: 'dm', chatType: 'dm', partnerId: 'member' },
    message: { id: 'same-message', at: FAMILIES_NOW, content: 'Private evidence', author: { id: 'member' } },
  });
  assert.equal(mapped?.place.key, 'dm:member');
  assert.deepEqual(mapped?.messageChat, { id: 'actual-dm', chatType: 'dm', partnerId: 'member' });
  assert.equal(mapped?.messageLocator?.chatId, 'actual-dm');
});

// The owner's command line belongs to the owner: only the `cli` principal speaks as `iface: 'cli'`, so its account is the owner's
// from the first line, on an install nobody prepared. Each test runs the real core and the real `neptunia` command over
// fresh folders, because the link spans the observation, the writer and the setting. Synthetic ids only.

test('a line of the command line is stored under the authority its address names', () => {
  // Bug: `observationOf` spells `<iface>/global` while every reader asks `nativeAuthorityOf`, so `accountNodeOf` misses.
  const handle = openMemoryDb(path.join(tempDir('nep-cli-authority-'), 'memory.db'));
  try {
    const at = Date.parse('2026-11-05T10:00:00Z');
    const envelope = observationOf(
      {
        kind: 'message.received',
        iface: 'cli',
        at,
        chat: { id: 'cli:dm:owner', kind: 'dm', chatType: 'dm', partnerId: 'owner' },
        message: { id: 'line-1', at, content: 'a synthetic line', author: { id: 'owner', name: 'owner' } },
      },
      { connection: 'conn:cli', direct: true }
    );
    assert.ok(envelope);
    observe(handle, envelope, { now: () => at });
    assert.equal(
      accountNodeOf(dbOf(handle), {
        interfaceId: 'cli',
        authorityId: nativeAuthorityOf('cli'),
        nativeId: 'owner',
        generation: 1,
      }),
      'cli:owner'
    );
  } finally {
    handle.close();
  }
});
