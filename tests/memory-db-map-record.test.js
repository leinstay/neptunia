// Round trips of src/memory/db/map/record.js: one record line <-> one `sources` row, through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mapper from '../src/memory/db/map/record.js';
import { assertRoundTrip, generated, plain, roundTrip } from './fixtures/memory-db/roundtrip.js';

const REL = 'record/2026-10/2026-10-20.jsonl';
const PRIVATE_REL = 'private/100000000000000001/record/2026-10/2026-10-20.jsonl';
const CHANNEL = '200000000000000001';
const GUILD = '300000000000000001';

const seen = () => ({
  v: 1,
  id: 'rec-1',
  kind: 'seen',
  messageId: '400000000000000001',
  revision: 1,
  occurredAt: '2026-10-20T10:00:00.000Z',
  recordedAt: '2026-10-20T10:00:01.000Z',
  guildId: GUILD,
  scope: { channel: CHANNEL },
  by: '100000000000000001',
  replyTo: null,
  text: 'Καλημέρα, café on the corner',
  media: ['image'],
  mentions: ['100000000000000002'],
  direct: true,
  participants: ['100000000000000001', '100000000000000002'],
  sourceMessageIds: ['400000000000000001'],
  origin: 'live',
  links: [{ id: 'l1', url: 'https://example.test/a', title: 'A', description: 'B', site: 'example' }],
});

test('a seen line becomes one sources row whose columns hold the fields', () => {
  const line = seen();
  const rows = assertRoundTrip(mapper, REL, line, { position: 3 });
  assert.equal(rows.sources.length, 1);
  const row = rows.sources[0];
  assert.equal(row.id, 'src:discord:400000000000000001:1:seen');
  assert.equal(row.kind, 'seen');
  assert.equal(row.iface, 'discord');
  assert.equal(row.native_id, '400000000000000001');
  assert.equal(row.revision, 1);
  assert.equal(row.place_id, `discord:channel:${CHANNEL}`);
  assert.equal(row.author_account, 'discord:100000000000000001');
  assert.equal(row.reply_to, null);
  assert.equal(row.occurred_at, line.occurredAt);
  assert.equal(row.recorded_at, line.recordedAt);
  assert.equal(row.text, line.text);
  assert.equal(row.media, '["image"]');
  assert.equal(row.mentions, '["100000000000000002"]');
  assert.equal(row.direct, 1);
  assert.equal(row.origin, 'live');
  assert.deepEqual([row.scope_kind, row.scope_iface, row.scope_dm], ['group', 'discord', null]);
  assert.equal(row.owner_file, REL);
  assert.equal(row.position, 3);
});

test('extra holds only the fields no column names', () => {
  const rows = assertRoundTrip(mapper, REL, seen());
  const extra = JSON.parse(rows.sources[0].extra);
  assert.deepEqual(Object.keys(extra).sort(), ['guildId', 'id', 'links', 'participants', 'sourceMessageIds', 'v', '$null'].sort());
  assert.deepEqual(extra.$null, ['replyTo']);
});

test('null stays null and absent stays absent', () => {
  const withNull = seen();
  const without = seen();
  delete without.replyTo;
  delete without.links;
  const a = roundTrip(mapper, REL, withNull);
  const b = roundTrip(mapper, REL, without);
  assert.ok(Object.hasOwn(a.back, 'replyTo') && a.back.replyTo === null);
  assert.ok(!Object.hasOwn(b.back, 'replyTo'));
  assert.ok(!Object.hasOwn(b.back, 'links'));
  assert.deepEqual(b.back, without);
});

test('numbers stay numbers, empty strings and empty lists stay as they are', () => {
  const line = { ...seen(), revision: 0, text: '', media: [], mentions: [], direct: false };
  const { back } = roundTrip(mapper, REL, line);
  assert.strictEqual(back.revision, 0);
  assert.strictEqual(back.text, '');
  assert.deepEqual(back.media, []);
  assert.strictEqual(back.direct, false);
  assert.deepEqual(back, line);
});

test('an edit is its own source and the persona\'s own line carries the turn and operation ids', () => {
  const edit = { ...seen(), revision: 2, text: 'edited' };
  assert.equal(roundTrip(mapper, REL, edit).rows.sources[0].id, 'src:discord:400000000000000001:2:seen');
  const said = { ...seen(), id: 'rec-2', kind: 'said', turnId: 'turn-1', opId: null, by: '100000000000000009' };
  const { rows, back } = roundTrip(mapper, REL, said);
  assert.equal(rows.sources[0].id, 'src:discord:400000000000000001:1:said');
  assert.equal(rows.sources[0].turn_id, 'turn-1');
  assert.equal(rows.sources[0].op_id, null);
  assert.deepEqual(back, said);
});

test('a deleted line has no revision, text or author and still round trips', () => {
  const line = {
    v: 1, id: 'rec-3', kind: 'deleted', messageId: '400000000000000002', occurredAt: '2026-10-20T11:00:00.000Z',
    recordedAt: '2026-10-20T11:00:00.000Z', guildId: GUILD, scope: { channel: CHANNEL }, participants: [], sourceMessageIds: ['400000000000000002'], origin: 'live',
  };
  const { rows, back } = roundTrip(mapper, REL, line);
  assert.equal(rows.sources[0].id, 'src:discord:400000000000000002:deleted:rec-3');
  assert.equal(rows.sources[0].revision, null);
  assert.deepEqual(back, line);
});

test('a felt line has its own id, no message, and a user scope', () => {
  const line = {
    v: 1, id: 'rec-4', kind: 'felt', occurredAt: '2026-10-20T12:00:00.000Z', recordedAt: '2026-10-20T12:00:00.000Z', guildId: GUILD,
    scope: { user: '100000000000000001' }, participants: ['100000000000000001'], sourceMessageIds: [], origin: 'live',
    feltId: 'felt-1', itemId: 'ep-1', revisionId: 'rev-1',
  };
  const { rows, back } = roundTrip(mapper, REL, line);
  assert.equal(rows.sources[0].id, 'src:discord:none:felt:rec-4');
  assert.deepEqual([rows.sources[0].scope_kind, rows.sources[0].scope_dm], ['dm', 'person:discord:100000000000000001']);
  assert.equal(rows.sources[0].place_id, null);
  assert.deepEqual(back, line);
});

test('a line of a private layer is a DM source of that member and keeps its channel id', () => {
  const line = { ...seen(), scope: { channel: '200000000000000099' } };
  const { rows, back } = roundTrip(mapper, PRIVATE_REL, line);
  const row = rows.sources[0];
  assert.deepEqual([row.scope_kind, row.scope_dm], ['dm', 'person:discord:100000000000000001']);
  assert.equal(row.place_id, 'discord:dm:100000000000000001');
  assert.deepEqual(back, line);
});

test('scopes the columns cannot rebuild are kept whole', () => {
  for (const scope of [{ guild: true }, {}, { channel: CHANNEL, user: '100000000000000001' }, { channel: 5 }, { other: 1 }]) {
    const line = { ...seen(), scope };
    assert.deepEqual(roundTrip(mapper, REL, line).back, line, JSON.stringify(scope));
  }
  const noScope = seen();
  delete noScope.scope;
  assert.deepEqual(roundTrip(mapper, REL, noScope).back, noScope);
});

test('a field of an unexpected type, or an unknown field, survives', () => {
  const line = { ...seen(), text: 5, revision: '2', direct: 'yes', media: 'image', unknownField: { deep: [1, null, 'x'] } };
  assert.deepEqual(roundTrip(mapper, REL, line).back, line);
});

test('the generated fixtures with every key path of the live record round trip', () => {
  for (const [index, line] of generated('record').entries()) {
    assertRoundTrip(mapper, REL, plain(line), {}, `generated record ${index}`);
  }
});
