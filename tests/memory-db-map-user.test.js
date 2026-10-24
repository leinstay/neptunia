// Round trips of src/memory/db/map/user.js and private.js: a member's public profile and private layer <-> rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as user from '../src/memory/db/map/user.js';
import * as privateLayer from '../src/memory/db/map/private.js';
import { assertRoundTrip, generated, plain, roundTrip } from './fixtures/memory-db/roundtrip.js';

const ID = '100000000000000001';
const REL = `users/${ID}.json`;
const PRIVATE_REL = `private/${ID}.json`;
const CTX = { guildId: '300000000000000001' };
const PERSON = `person:discord:${ID}`;

const profile = () => ({
  id: ID,
  names: ['Αλέξης', 'Zoë'],
  firstSeen: '2026-09-01T10:00:00.000Z',
  lastSeen: '2026-10-20T10:00:00.000Z',
  messageCount: 120,
  character: 'Warm and quick to joke.',
  interests: [
    { topic: 'chess', note: 'plays blitz', weight: 3, firstSeen: '2026-09-01', lastSeen: '2026-10-01', itemId: 'int-1', recordedAt: '2026-09-02T00:00:00.000Z' },
    { topic: 'gardening', note: '', weight: 1, firstSeen: '2026-09-05', lastSeen: '2026-09-05' },
  ],
  style: 'Short lines.',
  details: [
    { id: 1, text: 'has a cat', weight: 2, firstSeen: '2026-09-01', lastSeen: '2026-10-02', itemId: 'det-1' },
    { id: 2, text: 'works nights', weight: 1, firstSeen: '2026-09-03', lastSeen: '2026-09-03', recordedAt: '2026-09-03T00:00:00.000Z' },
  ],
  detailsSeq: 2,
  aliases: [{ name: 'Alex', weight: 2, firstSeen: '2026-09-01', lastSeen: '2026-09-09', itemId: 'al-1' }, { name: 'Lexi', weight: 1, firstSeen: '2026-09-01', lastSeen: '2026-09-01' }],
  relationship: 'Friendly regular.',
  relationshipScore: 20,
  relationshipWrittenAt: '2026-10-01T00:00:00.000Z',
  affinity: {
    score: 20,
    reason: 'kind',
    history: [
      { ts: '2026-09-10T00:00:00.000Z', delta: 5, appliedDelta: 5, score: 5, reason: 'first', itemId: 'aff-1' },
      { ts: '2026-09-11T00:00:00.000Z', delta: 20, appliedDelta: 15, score: 20, reason: 'second' },
    ],
    decayedAt: '2026-10-01T00:00:00.000Z',
  },
  episodes: [
    { date: '2026-10-01', what: 'told a joke', quote: 'q', feeling: 'amused', weight: 2, addedAt: '2026-10-01T10:00:00.000Z', itemId: 'ep-1' },
    { date: '2026-10-02', what: 'went quiet', quote: '', feeling: 'worried', weight: 1, addedAt: '2026-10-02T10:00:00.000Z' },
  ],
  updatedAt: null,
  addressedAs: { 'ένα όνομα': { score: 2, last: '2026-10-01' }, Plain: { score: 1, last: '2026-10-02' } },
  avatar: { hash: null, text: 'a blue circle', describedAt: '2026-09-02T00:00:00.000Z', default: true },
  realName: { name: 'A', from: 'said', to: null, itemId: 'rn-1', recordedAt: '2026-09-02T00:00:00.000Z' },
  closed: [{ kind: 'detail', id: 9, text: 'was in school', weight: 1, firstSeen: '2026-09-01', lastSeen: '2026-09-02', validTo: '2026-10-01', supersededBy: 'det-1', itemId: 'cl-1' }],
  portraitAttemptAt: null,
  portraitRefreshedAt: '2026-10-10T00:00:00.000Z',
  portraitMessageCount: 100,
  portraitDueAt: '2026-10-30T00:00:00.000Z',
});

test('a public profile fans out to people, accounts, a membership, claims, descriptions, episodes and affinity events', () => {
  const rows = assertRoundTrip(user, REL, profile(), CTX);
  const [person] = rows.people;
  assert.deepEqual(
    [person.id, person.kind, person.first_seen_at, person.message_count, person.affinity, person.affinity_reason, person.affinity_decayed_at],
    [PERSON, 'member', '2026-09-01T10:00:00.000Z', 120, 20, 'kind', '2026-10-01T00:00:00.000Z'],
  );
  assert.equal(rows.accounts[0].id, `discord:${ID}`);
  assert.equal(rows.accounts[0].native_id, ID);
  assert.equal(rows.accounts[0].person_id, PERSON);
  assert.deepEqual(JSON.parse(rows.accounts[0].names), ['Αλέξης', 'Zoë']);
  assert.equal(rows.memberships[0].place_id, 'discord:guild:300000000000000001');
  assert.deepEqual(rows.claims.map((c) => c.kind), ['detail', 'detail', 'interest', 'interest', 'alias', 'alias', 'detail']);
  assert.deepEqual(rows.descriptions.map((d) => d.field).sort(), ['character', 'relationship', 'style']);
  assert.equal(rows.episodes.length, 2);
  assert.equal(rows.affinity_events.length, 2);
  for (const table of ['claims', 'episodes', 'descriptions', 'affinity_events']) {
    for (const row of rows[table]) assert.deepEqual([row.scope_kind, row.scope_iface], ['group', 'discord'], table);
  }
});

test('claims: the itemId is the id, the others get a derived one, closed items are historical', () => {
  const { rows, back } = roundTrip(user, REL, profile(), CTX);
  const byText = Object.fromEntries(rows.claims.map((c) => [c.text, c]));
  assert.equal(byText.chess.id, 'int-1');
  assert.match(byText.gardening.id, /^interest:person:discord:\d+:[0-9a-f]{16}$/);
  assert.equal(byText['has a cat'].id, 'det-1');
  assert.equal(byText['has a cat'].weight, 2);
  assert.equal(byText['has a cat'].first_seen_at, '2026-09-01');
  assert.equal(byText['has a cat'].how, 'legacy');
  assert.equal(byText['has a cat'].author, 'import');
  assert.equal(byText['was in school'].truth, 'historical');
  assert.equal(byText['was in school'].valid_to, '2026-10-01');
  assert.equal(byText['was in school'].superseded_by, 'det-1');
  assert.equal(byText['was in school'].kind, 'detail');
  assert.equal(byText.Alex.kind, 'alias');
  assert.ok(!('itemId' in back.interests[1]));
  assert.equal(back.interests[0].itemId, 'int-1');
});

test('a claim without an itemId round trips without gaining one', () => {
  const { back } = roundTrip(user, REL, profile(), CTX);
  assert.ok(!Object.hasOwn(back.details[1], 'itemId'));
  assert.ok(!Object.hasOwn(back.aliases[1], 'itemId'));
  assert.ok(!Object.hasOwn(back.episodes[1], 'itemId'));
});

test('the order of an old list comes back by position', () => {
  const value = profile();
  value.details = ['a', 'b', 'c', 'd', 'e'].map((text, index) => ({ id: index + 1, text, weight: 1, firstSeen: 'x', lastSeen: 'y' }));
  const { stored, back } = roundTrip(user, REL, value, CTX);
  stored.claims.reverse();
  assert.deepEqual(user.fromRows(stored, CTX).details.map((d) => d.text), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(back.details, value.details);
});

test('descriptions keep the text as one legacy version and the relationship stamp as its time', () => {
  const { rows } = roundTrip(user, REL, profile(), CTX);
  const relationship = rows.description_versions.find((v) => v.description_id.endsWith(':relationship'));
  assert.equal(relationship.text, 'Friendly regular.');
  assert.equal(relationship.origin, 'legacy');
  assert.equal(relationship.written_at, '2026-10-01T00:00:00.000Z');
  assert.equal(relationship.chars, 17);
  const description = rows.descriptions.find((d) => d.field === 'relationship');
  assert.equal(description.current_version, relationship.id);
});

test('absent lists, texts and objects stay absent; empty ones stay empty', () => {
  const sparse = { id: ID, names: [], firstSeen: 'a', lastSeen: 'b', messageCount: 0, interests: [], details: [], aliases: [], episodes: [], character: '', style: '', relationship: '', affinity: { score: 0, reason: '', history: [], decayedAt: 'c' } };
  assert.deepEqual(roundTrip(user, REL, sparse, CTX).back, sparse);
  const bare = { id: ID };
  const { back } = roundTrip(user, REL, bare, CTX);
  assert.deepEqual(back, bare);
  assert.deepEqual(roundTrip(user, REL, { id: ID, affinity: {} }, CTX).back, { id: ID, affinity: {} });
  assert.deepEqual(roundTrip(user, REL, { id: ID, affinity: null }, CTX).back, { id: ID, affinity: null });
  assert.deepEqual(roundTrip(user, REL, { id: ID, addressedAs: null }, CTX).back, { id: ID, addressedAs: null });
  assert.deepEqual(roundTrip(user, REL, { id: ID, realName: null, avatar: null, names: null }, CTX).back, { id: ID, realName: null, avatar: null, names: null });
});

test('a list or text of an unexpected shape stays whole in the remainder', () => {
  const odd = { id: ID, details: 'text', interests: [1, 2], aliases: ['Alex'], episodes: null, character: 7, style: null, closed: [{ a: 1 }, 'x'] };
  assert.deepEqual(roundTrip(user, REL, odd, CTX).back, odd);
});

test('two items with one itemId, or none and the same fields, still come back apart', () => {
  const value = {
    id: ID,
    details: [{ id: 1, text: 'same', itemId: 'dup' }, { id: 2, text: 'same', itemId: 'dup' }],
    interests: [{ topic: 'x' }, { topic: 'x' }],
  };
  const { rows, back } = roundTrip(user, REL, value, CTX);
  assert.deepEqual(back, value);
  assert.equal(new Set(rows.claims.map((c) => c.id)).size, 4);
});

test('a membership row exists only when the file had addressedAs', () => {
  const { rows } = roundTrip(user, REL, { id: ID }, CTX);
  assert.equal(rows.memberships, undefined);
  const withAddress = roundTrip(user, REL, { id: ID, addressedAs: { x: { score: 1, last: 'y' } } }, CTX).rows;
  assert.equal(JSON.parse(withAddress.memberships[0].addressed_as).x.score, 1);
});

test('the generated fixtures with every key path of the live user files round trip', () => {
  for (const [index, value] of generated('user').entries()) {
    assertRoundTrip(user, `users/${index}.json`, plain(value), CTX, `generated user ${index}`);
  }
});

const layer = () => ({
  relationship: 'Trusted.',
  relationshipScore: 30,
  relationshipWrittenAt: '2026-10-02T00:00:00.000Z',
  interests: [{ topic: 'music', note: 'n', weight: 1, firstSeen: 'a', lastSeen: 'b' }],
  details: [{ id: 1, text: 'secret plan', weight: 1, firstSeen: 'a', lastSeen: 'b', itemId: 'pd-1' }],
  detailsSeq: 1,
  episodes: [{ date: '2026-10-02', what: 'confided', quote: 'q', feeling: 'f', weight: 1, addedAt: '2026-10-02T00:00:00.000Z' }],
  affinity: { score: 10, reason: 'r', history: [{ ts: 't', delta: 1, appliedDelta: 1, score: 1, reason: 'x' }], decayedAt: 'd' },
  firstSeen: 'a',
  lastSeen: 'b',
  replies: { day: '2026-10-02', count: 2, noticedDay: '2026-10-01' },
  buffer: [{ any: 'thing' }],
});

test('a private layer round trips with every row scoped to that member\'s DM and no people row', () => {
  const rows = assertRoundTrip(privateLayer, PRIVATE_REL, layer(), CTX);
  assert.equal(rows.people, undefined);
  assert.equal(rows.accounts, undefined);
  for (const table of ['claims', 'episodes', 'descriptions', 'affinity_events']) {
    assert.ok(rows[table].length > 0, table);
    for (const row of rows[table]) assert.deepEqual([row.scope_kind, row.scope_dm], ['dm', PERSON], table);
  }
  assert.deepEqual(rows.descriptions.map((d) => d.field), ['relationship']);
  assert.deepEqual([rows.operational[0].kind, rows.operational[0].owner], ['private', PERSON]);
});

test('a private layer\'s ids never meet the public profile\'s', () => {
  const value = { details: [{ id: 1, text: 'x' }], episodes: [{ date: 'd', what: 'w' }], affinity: { history: [{ ts: 't' }] }, relationship: 'r' };
  const publicRows = user.toRows(REL, { id: ID, ...value }, CTX);
  const privateRows = privateLayer.toRows(PRIVATE_REL, value, CTX);
  for (const table of ['claims', 'episodes', 'affinity_events', 'descriptions']) {
    const mine = new Set(publicRows[table].map((row) => row.id));
    for (const row of privateRows[table]) assert.ok(!mine.has(row.id), `${table} ${row.id}`);
  }
});

test('private layers that are empty or odd come back as they were', () => {
  for (const value of [{}, { relationship: '', interests: [], details: [], episodes: [] }, { affinity: null, details: 'x', buffer: [] }, { affinity: {} }]) {
    assert.deepEqual(roundTrip(privateLayer, PRIVATE_REL, value, CTX).back, value, JSON.stringify(value));
  }
});

test('the generated fixtures with every key path of the live private files round trip', () => {
  for (const [index, value] of generated('private').entries()) {
    assertRoundTrip(privateLayer, `private/${index}.json`, plain(value), CTX, `generated private ${index}`);
  }
});
