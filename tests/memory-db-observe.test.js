// The observation envelope and foreign capture (schema v8, src/memory/db/observe.js), and the promotion of an account
// or participant through her session's `people:add`. Fixtures for three interfaces nobody wires yet: Twitter (her post,
// replies, a mention of her; a stranger's quote tweet stays out unless the caller passes it), an imageboard (thread
// tokens, a post-number-only board, display names, a site-wide id, a reset token) and Telegram (a DM and a group).
// Synthetic text only; the ids and handles are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';
import {
  OBSERVATION_VERSION, captureSettings, checkEnvelope, dueWatches, expandBundle, finishWatch, observe, openBundle, scheduleWatches,
} from '../src/memory/db/observe.js';
import { audienceWhere, dmContext, groupContext, groupScope } from '../src/memory/db/scope.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import { batchOf, buildSessionRequest, scopesOf, validateAnswer } from '../src/memory/db/session.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const at = (minutes) => new Date(Date.parse('2026-10-24T10:00:00.000Z') + minutes * 60_000).toISOString();
const opts = { now: () => NOW, log: quiet };
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

const TABLES = ['sources', 'accounts', 'places', 'participants', 'people', 'external_keys', 'source_relations', 'capture_bundles', 'capture_members',
  'capture_events', 'audiences', 'authorities', 'interfaces', 'connections', 'participant_links', 'account_person_links', 'decisions'];
const sizes = (db) => Object.fromEntries(TABLES.map((table) => [table, count(db, `SELECT COUNT(*) AS n FROM "${table}"`)]));

function fresh() {
  return openMemoryDb(':memory:');
}

// ---------- Twitter ----------

const tweet = (key, over = {}) => ({
  v: OBSERVATION_VERSION, iface: 'twitter', authority: 'twitter/global', connection: 'conn:twitter:her',
  native: { kind: 'tweet', key, revision: 0 },
  place: { authority: 'twitter/global', key: 'conversation:9001', kind: 'discussion', conversation: 'group', title: 'a thread' },
  author: { kind: 'self', key: 'her-handle', display: 'Her' },
  occurredAt: at(0), observedAt: at(1), text: `tweet ${key}`, relations: [], ...over,
});

test('twitter: her post opens a bundle, replies join it, a mention of her opens its own; a stranger quote tweet is not stored unless passed', () => {
  const handle = fresh();
  const { db } = handle;
  try {
    const people = count(db, 'SELECT COUNT(*) AS n FROM people');
    const post = observe(handle, tweet('9001', { capture: { role: 'anchor', reason: 'own_line', coverage: { state: 'pending_expansion', before: 0, after: 0, ancestors: 0 } } }), opts);
    assert.equal(post.ok, true, JSON.stringify(post));
    assert.equal(post.replayed, false);
    const row = db.prepare('SELECT kind, author_kind, author_account, author_participant, audience_id, scope_kind, scope_iface, authority_id, native_kind, connection_id, origin FROM sources WHERE id = ?').get(post.sourceId);
    assert.deepEqual({ ...row, author_account: undefined }, {
      kind: 'said', author_kind: 'self', author_account: undefined, author_participant: null, audience_id: 'aud:group:twitter', scope_kind: 'group', scope_iface: 'twitter',
      authority_id: 'twitter/global', native_kind: 'tweet', connection_id: 'conn:twitter:her', origin: 'observation',
    });
    assert.equal(db.prepare('SELECT kind FROM accounts WHERE id = ?').get(row.author_account).kind, 'self');

    const reply = observe(handle, tweet('9002', {
      author: { kind: 'account', key: 'u-77', display: 'Zoé' }, occurredAt: at(5), observedAt: at(6), text: 'a reply to her',
      relations: [{ predicate: 'replies_to', target: { kind: 'tweet', key: '9001' } }],
      capture: { bundle: post.bundleId, role: 'reply', coverage: { state: 'complete', before: 0, after: 0, ancestors: 0 } },
    }), opts);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual({ ...db.prepare('SELECT target_source_id, resolved_at IS NOT NULL AS resolved FROM source_relations WHERE source_id = ?').get(reply.sourceId) }, { target_source_id: post.sourceId, resolved: 1 });
    const stranger = db.prepare('SELECT person_id, kind, names FROM accounts WHERE id = ?').get(reply.author.account);
    assert.deepEqual({ ...stranger }, { person_id: null, kind: 'user', names: '["Zoé"]' }, 'an account, never a person');
    assert.deepEqual(db.prepare('SELECT role FROM capture_members WHERE bundle_id = ? ORDER BY role').all(post.bundleId).map((r) => r.role), ['anchor', 'reply']);
    assert.deepEqual(db.prepare('SELECT kind, json_extract(coverage, \'$.state\') AS state FROM capture_events WHERE bundle_id = ? ORDER BY id').all(post.bundleId).map((r) => ({ ...r })),
      [{ kind: 'initial', state: 'pending_expansion' }, { kind: 'expansion', state: 'complete' }]);

    // A quote tweet by a stranger: the adapter does not pass it, so nothing of it exists.
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sources WHERE native_id = '9003'"), 0);

    // A mention of her in another conversation: captured, with its own bundle; the mention of her handle stays an
    // unresolved relation (an account is never a source).
    const mention = observe(handle, tweet('9100', {
      place: { authority: 'twitter/global', key: 'conversation:9100', kind: 'discussion', conversation: 'group' },
      author: { kind: 'account', key: 'u-88' }, occurredAt: at(30), observedAt: at(31), text: 'hey @her-handle',
      relations: [{ predicate: 'mentions', target: { kind: 'user', key: 'her-handle' } }],
      capture: { role: 'anchor', reason: 'mention', coverage: { state: 'incomplete', gaps: ['ancestors'] } },
    }), opts);
    assert.equal(mention.ok, true, JSON.stringify(mention));
    assert.notEqual(mention.bundleId, post.bundleId);
    assert.equal(db.prepare('SELECT reason FROM capture_bundles WHERE id = ?').get(mention.bundleId).reason, 'mention');
    assert.equal(db.prepare('SELECT target_source_id FROM source_relations WHERE source_id = ?').get(mention.sourceId).target_source_id, null);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM people'), people, 'observing creates no person');

    // The same post again: nothing is written.
    const before = sizes(db);
    const replay = observe(handle, tweet('9001', { capture: { role: 'anchor', reason: 'own_line', coverage: { state: 'complete' } } }), opts);
    assert.deepEqual(replay, { ok: true, replayed: true, sourceId: post.sourceId, written: 0 });
    assert.deepEqual(sizes(db), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// ---------- an imageboard ----------

const SITE = 'imageboard/site:board.example';
const post = (key, author, over = {}) => ({
  v: OBSERVATION_VERSION, iface: 'imageboard', authority: SITE,
  native: { kind: 'post', key, revision: 0 },
  place: { authority: SITE, key: 'thread:100', kind: 'thread', conversation: 'group', title: 'a thread', parent: 'board:b' },
  author, occurredAt: at(Number(key) % 50), observedAt: at(Number(key) % 50 + 1), text: `post ${key}`, ...over,
});
const threadB = { authority: SITE, key: 'thread:200', kind: 'thread', conversation: 'group' };

test('imageboard: thread tokens stay in their thread, post numbers and display names are one participant per post, a site id is an account, a reset token is a new generation', () => {
  const handle = fresh();
  const { db } = handle;
  try {
    const token = { kind: 'participant', token_kind: 'thread_token', key: 'Ab12' };
    const a1 = observe(handle, post('101', token), opts);
    const a2 = observe(handle, post('102', token), opts);
    const b1 = observe(handle, post('201', token, { place: threadB }), opts);
    for (const result of [a1, a2, b1]) assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(a1.author.participant, a2.author.participant, 'one token, one thread: one participant');
    assert.notEqual(a1.author.participant, b1.author.participant, 'the same token in another thread is someone else');
    const p1 = db.prepare('SELECT token_kind, native_token, scope_place_id, continuity, generation FROM participants WHERE id = ?').get(a1.author.participant);
    assert.deepEqual({ ...p1 }, { token_kind: 'thread_token', native_token: 'Ab12', scope_place_id: a1.placeId, continuity: 'provider_asserted', generation: 1 });
    assert.deepEqual({ ...db.prepare('SELECT author_kind, author_account FROM sources WHERE id = ?').get(a1.sourceId) }, { author_kind: 'participant', author_account: null });

    // A reset token: the same string, a new generation, a new participant.
    const reset = observe(handle, post('103', { ...token, generation: 2 }), opts);
    assert.notEqual(reset.author.participant, a1.author.participant);
    assert.equal(db.prepare('SELECT generation FROM participants WHERE id = ?').get(reset.author.participant).generation, 2);

    // A board that shows only post numbers: every post its own participant, never linked.
    const n1 = observe(handle, post('301', { kind: 'participant', token_kind: 'post_number', key: '301' }, { place: threadB }), opts);
    const n2 = observe(handle, post('302', { kind: 'participant', token_kind: 'post_number', key: '302' }, { place: threadB }), opts);
    assert.notEqual(n1.author.participant, n2.author.participant);
    assert.equal(db.prepare('SELECT continuity FROM participants WHERE id = ?').get(n1.author.participant).continuity, 'unknown');
    // Display names only: one participant per post, keyed by the post.
    const d1 = observe(handle, post('401', { kind: 'participant', token_kind: 'display_name', display: 'Anonymous' }), opts);
    const d2 = observe(handle, post('402', { kind: 'participant', token_kind: 'display_name', display: 'Anonymous' }), opts);
    assert.notEqual(d1.author.participant, d2.author.participant, 'the same display name in two posts is two participants');
    assert.deepEqual({ ...db.prepare('SELECT native_token, display, observation_key IS NOT NULL AS keyed FROM participants WHERE id = ?').get(d1.author.participant) }, { native_token: null, display: 'Anonymous', keyed: 1 });
    const none = observe(handle, post('403', { kind: 'participant', token_kind: 'none' }), opts);
    assert.equal(none.ok, true);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM participant_links'), 0, 'nothing links participants');

    // A site-wide stable id is an account of the site, with no person.
    const site = observe(handle, post('501', { kind: 'account', key: 'id:9f3c' }), opts);
    assert.deepEqual({ ...db.prepare('SELECT authority_id, native_key, person_id FROM accounts WHERE id = ?').get(site.author.account) }, { authority_id: SITE, native_key: 'id:9f3c', person_id: null });
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM account_person_links WHERE account_id = ?', site.author.account), 0);
    const again = observe(handle, post('502', { kind: 'account', key: 'id:9f3c' }, { place: threadB }), opts);
    assert.equal(again.author.account, site.author.account, 'a site id is one account across threads');

    // A reply to a post nobody fetched waits; it resolves when the post arrives, and its key stays.
    const replying = observe(handle, post('104', token, { relations: [{ predicate: 'replies_to', target: { kind: 'post', key: '99' } }] }), opts);
    const waiting = db.prepare('SELECT id, target_key, target_source_id FROM source_relations WHERE source_id = ?').get(replying.sourceId);
    assert.equal(waiting.target_source_id, null);
    const relations = count(db, 'SELECT COUNT(*) AS n FROM source_relations');
    const arrived = observe(handle, post('99', { kind: 'participant', token_kind: 'none' }), opts);
    assert.equal(arrived.resolved, 1);
    const resolved = db.prepare('SELECT id, target_key, target_source_id, resolved_at FROM source_relations WHERE source_id = ?').get(replying.sourceId);
    assert.deepEqual([resolved.id, resolved.target_key, resolved.target_source_id], [waiting.id, waiting.target_key, arrived.sourceId]);
    assert.ok(resolved.resolved_at);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM source_relations'), relations);

    // The thread's place: its parent board was never seen, so it is kept by key; its seen window follows the posts.
    const place = db.prepare('SELECT kind, conversation, parent_id, extra, seen_from_at, seen_to_at, owner_file FROM places WHERE id = ?').get(a1.placeId);
    assert.deepEqual({ ...place }, { kind: 'thread', conversation: 'group', parent_id: null, extra: '{"parent":"board:b"}', seen_from_at: at(1), seen_to_at: at(49), owner_file: null });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// ---------- Telegram ----------

const message = (key, place, author, over = {}) => ({
  v: OBSERVATION_VERSION, iface: 'telegram', authority: 'telegram/global', native: { kind: 'message', key, revision: 1 },
  place, author, occurredAt: at(0), observedAt: at(1), text: `message ${key}`, ...over,
});

test('telegram: a DM is its own audience, a group is the interface\'s, an unknown conversation is internal', () => {
  const handle = fresh();
  const { db } = handle;
  try {
    const dmPlace = { authority: 'telegram/global', key: 'chat:555', kind: 'dm', conversation: 'dm', partner: { key: '555', display: 'Ilse' } };
    const dm = observe(handle, message('555:1', dmPlace, { kind: 'account', key: '555', display: 'Ilse' }), opts);
    assert.equal(dm.ok, true, JSON.stringify(dm));
    assert.equal(dm.audienceId, `aud:dm:${dm.placeId}`);
    const place = db.prepare('SELECT conversation, partner_account, partner_person FROM places WHERE id = ?').get(dm.placeId);
    assert.deepEqual({ ...place }, { conversation: 'dm', partner_account: dm.author.account, partner_person: null });
    assert.deepEqual({ ...db.prepare('SELECT kind, iface, place_id FROM audiences WHERE id = ?').get(dm.audienceId) }, { kind: 'dm', iface: 'telegram', place_id: dm.placeId });
    const group = observe(handle, message('-100:7', { authority: 'telegram/global', key: 'chat:-100', kind: 'room', conversation: 'group', title: 'a group' }, { kind: 'account', key: '777' }), opts);
    assert.equal(group.audienceId, 'aud:group:telegram');
    const unknown = observe(handle, message('-200:1', { authority: 'telegram/global', key: 'chat:-200', kind: 'room', conversation: 'channel' }, { kind: 'account', key: '777' }), opts);
    assert.equal(unknown.audienceId, 'aud:internal', 'an unknown conversation fails closed');
    assert.equal(db.prepare('SELECT conversation FROM places WHERE id = ?').get(unknown.placeId).conversation, null);

    const visible = (ctx) => {
      const where = audienceWhere(ctx, 's');
      return db.prepare(`SELECT s.id FROM sources s WHERE ${where.sql} ORDER BY s.id`).all(...where.params).map((row) => row.id);
    };
    assert.deepEqual(visible(groupContext('telegram')), [group.sourceId]);
    assert.deepEqual(visible({ ...dmContext('person:telegram:555', 'telegram', dm.placeId) }).sort(), [dm.sourceId, group.sourceId].sort());
    assert.deepEqual(visible(groupContext('discord')), [], 'another interface sees none of it');
    // The place declared a DM stays one: a later envelope that says otherwise is refused, and writes nothing.
    const before = sizes(db);
    assert.deepEqual(observe(handle, message('555:2', { ...dmPlace, conversation: 'group' }, { kind: 'account', key: '555' }), opts), { ok: false, code: 'CONVERSATION_CONFLICT' });
    assert.deepEqual(sizes(db), before);
  } finally {
    handle.close();
  }
});

test('observe: a malformed envelope is refused with a code and writes nothing; a refusal found while writing rolls back', () => {
  const handle = fresh();
  const { db } = handle;
  try {
    const good = tweet('1');
    const cases = [
      [null, 'BAD_ENVELOPE'],
      [{ ...good, v: 2 }, 'BAD_VERSION'],
      [{ ...good, authority: 'telegram/global' }, 'BAD_AUTHORITY'],
      [{ ...good, native: { kind: 'tweet', key: '1' } }, 'BAD_NATIVE'],
      [{ ...good, place: { ...good.place, kind: 'timeline' } }, 'BAD_PLACE'],
      [{ ...good, author: { kind: 'participant', token_kind: 'thread_token' } }, 'BAD_AUTHOR'],
      [{ ...good, author: { kind: 'person', key: 'x' } }, 'BAD_AUTHOR'],
      [{ ...good, occurredAt: 'yesterday' }, 'BAD_TIME'],
      [{ ...good, text: null }, 'BAD_TEXT'],
      [{ ...good, relations: [{ predicate: 'likes', target: { source: 'x' } }] }, 'BAD_RELATION'],
      [{ ...good, capture: { role: 'reply' } }, 'BAD_CAPTURE'],
      [{ ...good, capture: { role: 'anchor', reason: 'own_line', coverage: { state: 'enough' } } }, 'BAD_COVERAGE'],
      [{ ...good, extra: [1] }, 'BAD_EXTRA'],
    ];
    const before = sizes(db);
    for (const [envelope, code] of cases) {
      assert.equal(checkEnvelope(envelope), code, JSON.stringify(envelope));
      assert.deepEqual(observe(handle, envelope, opts), { ok: false, code });
    }
    assert.deepEqual(sizes(db), before);
    // Valid on its face, refused while writing (the bundle it names does not exist): the source, its account and place
    // are rolled back with it.
    assert.deepEqual(observe(handle, tweet('2', { author: { kind: 'account', key: 'u-1' }, capture: { bundle: 'bundle:none', role: 'reply' } }), opts), { ok: false, code: 'UNKNOWN_BUNDLE' });
    assert.deepEqual(sizes(db), before);
  } finally {
    handle.close();
  }
});

// ---------- capture ----------

test('capture: a bundle grows by expansion past pageLines with truthful coverage; history is append-only; a source keeps two roles', () => {
  const handle = fresh();
  const { db } = handle;
  try {
    const anchor = observe(handle, tweet('1000'), opts);
    const lines = [];
    for (let i = 1; i <= 70; i += 1) lines.push(observe(handle, tweet(String(1000 + i), { author: { kind: 'account', key: `u-${i}` }, occurredAt: at(i), observedAt: at(i) }), opts).sourceId);
    const config = { capture: { pageLines: 60 } };
    const opened = openBundle(handle, { anchor: anchor.sourceId, reason: 'own_line', coverage: { state: 'pending_expansion', before: 0, after: 0 }, ...opts });
    assert.deepEqual([opened.ok, opened.created], [true, true]);
    assert.deepEqual(openBundle(handle, { anchor: anchor.sourceId, reason: 'own_line', coverage: { state: 'complete' }, ...opts }), { ok: true, bundleId: opened.bundleId, created: false });

    const first = expandBundle(handle, opened.bundleId, { sources: lines.map((id) => ({ id, role: 'after' })), coverage: { state: 'complete', after: 70 }, config, ...opts });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.added, 60);
    assert.equal(first.rest.length, 10);
    assert.equal(first.coverage.state, 'pending_expansion', 'a page boundary is never "complete"');
    const second = expandBundle(handle, opened.bundleId, { sources: first.rest, coverage: { state: 'complete', after: 70 }, config, ...opts });
    assert.deepEqual([second.added, second.rest.length, second.coverage.state], [10, 0, 'complete']);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM capture_members WHERE bundle_id = ?', opened.bundleId), 71, 'the bundle grew past pageLines');
    assert.deepEqual(db.prepare("SELECT kind, json_extract(coverage, '$.state') AS state, added FROM capture_events WHERE bundle_id = ? ORDER BY id").all(opened.bundleId).map((r) => ({ ...r })), [
      { kind: 'initial', state: 'pending_expansion', added: 1 },
      { kind: 'expansion', state: 'pending_expansion', added: 60 },
      { kind: 'expansion', state: 'complete', added: 10 },
    ]);
    assert.equal(JSON.parse(db.prepare('SELECT coverage FROM capture_bundles WHERE id = ?').get(opened.bundleId).coverage).state, 'complete');

    // A line that is both a reply to her and a mention of her keeps both roles; adding a role twice adds nothing.
    const both = expandBundle(handle, opened.bundleId, { sources: [{ id: lines[0], role: 'reply' }, { id: lines[0], role: 'mention' }, { id: lines[0], role: 'after' }], coverage: { state: 'complete' }, ...opts });
    assert.equal(both.added, 2);
    assert.deepEqual(db.prepare('SELECT role FROM capture_members WHERE bundle_id = ? AND source_id = ? ORDER BY role').all(opened.bundleId, lines[0]).map((r) => r.role), ['after', 'mention', 'reply']);
    // A provider that could not be read says so; an unknown source refuses the whole step.
    const events = count(db, 'SELECT COUNT(*) AS n FROM capture_events');
    assert.deepEqual(expandBundle(handle, opened.bundleId, { sources: [{ id: lines[1], role: 'reply' }, { id: 'source:missing', role: 'reply' }], coverage: { state: 'complete' }, ...opts }), { ok: false, code: 'UNKNOWN_SOURCE' });
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM capture_events'), events);
    assert.equal(expandBundle(handle, opened.bundleId, { sources: [], coverage: { state: 'provider_unavailable' }, kind: 'watch', ...opts }).coverage.state, 'provider_unavailable');
    assert.throws(() => db.prepare('UPDATE capture_events SET added = 0').run(), /append-only/);
  } finally {
    handle.close();
  }
});

test('capture: watches at 15 min, 2 h and 24 h after the anchor; due ones are listed until they are closed', () => {
  const handle = fresh();
  try {
    assert.deepEqual(captureSettings({}), { ancestors: 2, before: 3, after: 3, pageLines: 60, watch: [15, 120, 1440], watchSameAuthor: 20 });
    const anchor = observe(handle, tweet('2000', { capture: { role: 'anchor', reason: 'own_line', coverage: { state: 'complete' } } }), opts);
    const scheduled = scheduleWatches(handle, anchor.bundleId, null, { log: quiet });
    assert.deepEqual([scheduled.ok, scheduled.scheduled], [true, 3]);
    assert.equal(scheduleWatches(handle, anchor.bundleId, null, { log: quiet }).scheduled, 0, 'scheduled once');
    const due = (minutes) => dueWatches(handle, Date.parse(at(minutes)), { config: { capture: { watchSameAuthor: 5 } } });
    assert.deepEqual(due(10), []);
    const firstDue = due(30);
    assert.deepEqual(firstDue.map((w) => [w.dueAt, w.anchor, w.sameAuthorMax]), [[at(15), anchor.sourceId, 5]]);
    assert.deepEqual(finishWatch(handle, firstDue[0].id, 'unavailable', opts), { ok: true, written: 1 });
    assert.deepEqual(finishWatch(handle, firstDue[0].id, 'fetched', opts), { ok: true, written: 0 }, 'a closed watch stays as it was');
    assert.equal(handle.db.prepare('SELECT outcome FROM capture_watches WHERE id = ?').get(firstDue[0].id).outcome, 'unavailable');
    assert.deepEqual(due(30), []);
    assert.equal(due(180).length, 1);
    assert.equal(due(2000).length, 2);
    assert.deepEqual(finishWatch(handle, firstDue[0].id, 'maybe', opts), { ok: false, code: 'BAD_OUTCOME' });
    assert.deepEqual(scheduleWatches(handle, 'bundle:none', [15], { log: quiet }), { ok: false, code: 'UNKNOWN_BUNDLE' });
  } finally {
    handle.close();
  }
});

// ---------- promotion ----------

test('people:add: the batch carries author handles; the validator keeps a well-formed op and drops the rest by reason', () => {
  const handle = fresh();
  const { db } = handle;
  try {
    const p1 = observe(handle, post('101', { kind: 'participant', token_kind: 'thread_token', key: 'Ab12', display: 'Ab12' }, { occurredAt: at(1), observedAt: at(2) }), opts);
    const p2 = observe(handle, post('501', { kind: 'account', key: 'id:9f3c', display: 'Ilse' }, { occurredAt: at(3), observedAt: at(4) }), opts);
    const scope = scopesOf(db).find((entry) => entry.key === 'group:imageboard');
    assert.ok(scope, 'the imageboard group is a scope');
    const batch = batchOf(db, scope.scope, { cursor: 0, since: null, maxMessages: 50, settleBefore: NOW });
    assert.equal(batch.length, 2);
    const built = buildSessionRequest({ db, scope, batch, config: {}, prompts: { 'memory-session': 'x', labels: {} }, selfName: 'Nep', now: NOW });
    assert.deepEqual([...built.maps.authors.entries()], [
      ['a1', { kind: 'participant', id: p1.author.participant, hasPerson: false }],
      ['a2', { kind: 'account', id: p2.author.account, hasPerson: false }],
    ]);
    assert.ok(built.messages[1].content.includes('[a1] Ab12: post 101'), 'a participant line shows its handle before its display name');

    const maps = { ...built.maps, authors: new Map([...built.maps.authors, ['a3', { kind: 'account', id: 'account:linked', hasPerson: true }]]) };
    const { plan, counts } = validateAnswer({
      people: [
        { op: 'add', subject: 'a1', sources: ['#1'], reason: 'the same voice in two threads' },
        { op: 'add', subject: 'a9', sources: ['#1'], reason: 'r' },
        { op: 'add', subject: 'a3', sources: ['#1'], reason: 'r' },
        { op: 'add', subject: 'a2', sources: ['#2'] },
        { op: 'add', subject: 'a2', sources: ['#7'], reason: 'r' },
        { op: 'merge', subject: 'a2', sources: ['#2'], reason: 'r' },
      ],
    }, { maps, people: built.people });
    assert.deepEqual(plan.people, [{ op: 'add', subjectKind: 'participant', subjectId: p1.author.participant, sources: [p1.sourceId], reason: 'the same voice in two threads' }]);
    assert.deepEqual(counts.dropped, { unknown_subject: 1, has_person: 1, no_reason: 1, unknown_source: 1, bad_op: 1 });
  } finally {
    handle.close();
  }
});

test('people:add in shadow is a proposal only; in apply it mints a tentative person with a proposed link; a second add is refused', () => {
  const handle = fresh();
  const { db } = handle;
  try {
    const p1 = observe(handle, post('101', { kind: 'participant', token_kind: 'thread_token', key: 'Ab12' }), opts);
    const p2 = observe(handle, post('501', { kind: 'account', key: 'id:9f3c' }), opts);
    const people = count(db, 'SELECT COUNT(*) AS n FROM people');
    const plan = (ops) => ({ claims: [], episodes: [], affinity: [], descriptions: [], people: ops });
    const add = (kind, id, source) => ({ op: 'add', subjectKind: kind, subjectId: id, sources: [source], reason: 'seen twice' });
    const runOf = (id) => ({ id, scopeKey: 'group:imageboard', scope: groupScope('imageboard'), startedAt: 'a', finishedAt: 'b', outcome: 'ok', counts: {}, errors: [], batchKey: id });

    const shadow = applyMemoryWrite(handle, { kind: 'session', mode: 'shadow', authority: 'json', run: runOf('run:s'), plan: plan([add('participant', p1.author.participant, p1.sourceId)]), now: NOW });
    assert.equal(shadow.proposed, 1);
    assert.deepEqual({ ...db.prepare("SELECT action, target_kind, target_id FROM decisions WHERE id = 'dec:run:s:1'").get() }, { action: 'proposed:people_add', target_kind: 'participant', target_id: p1.author.participant });
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM people'), people, 'shadow writes no person');

    let n = 0;
    const uuid = () => `00000000-0000-4000-8000-00000000000${(n += 1)}`;
    const applied = applyMemoryWrite(handle, {
      kind: 'session', mode: 'apply', authority: 'db', run: runOf('run:a'), now: NOW, uuid,
      plan: plan([add('participant', p1.author.participant, p1.sourceId), add('account', p2.author.account, p2.sourceId)]),
    });
    assert.equal(applied.people, 2);
    const first = 'person:00000000-0000-4000-8000-000000000001';
    const second = 'person:00000000-0000-4000-8000-000000000002';
    assert.deepEqual({ ...db.prepare('SELECT kind, status FROM people WHERE id = ?').get(first) }, { kind: 'person', status: 'active' });
    assert.deepEqual({ ...db.prepare('SELECT participant_id, account_id, person_id, state, by, evidence_id FROM participant_links').get() },
      { participant_id: p1.author.participant, account_id: null, person_id: first, state: 'proposed', by: 'her', evidence_id: p1.sourceId });
    assert.deepEqual({ ...db.prepare('SELECT person_id, state FROM account_person_links WHERE account_id = ?').get(p2.author.account) }, { person_id: second, state: 'proposed' });
    assert.equal(db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(p2.author.account).person_id, null, 'a proposed link is not the verified projection');
    assert.deepEqual(db.prepare("SELECT action, target_id FROM decisions WHERE id LIKE 'dec:run:a:%' ORDER BY id").all().map((r) => ({ ...r })),
      [{ action: 'people_add', target_id: first }, { action: 'people_add', target_id: second }]);

    const again = applyMemoryWrite(handle, { kind: 'session', mode: 'apply', authority: 'db', run: runOf('run:b'), now: NOW, uuid, plan: plan([add('participant', p1.author.participant, p1.sourceId)]) });
    assert.deepEqual([again.people, again.rejected], [0, 1]);
    assert.equal(db.prepare("SELECT action FROM decisions WHERE id = 'dec:run:b:1'").get().action, 'rejected:has_person');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM people'), people + 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});
