// Round trips of archive.js (claim versions) and versions.js (description versions) through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as archive from '../src/memory/db/map/archive.js';
import * as versions from '../src/memory/db/map/versions.js';
import { assertRoundTrip, roundTrip } from './fixtures/memory-db/roundtrip.js';

const REL = 'archive/2026-10.jsonl';
const entry = (extra = {}) => ({
  v: 1, id: 'ar-1', kind: 'archive', event: 'expired', itemKind: 'recent', itemId: 'rc-1', revisionId: 'rv-1',
  scope: { channel: '200000000000000001' }, participants: ['100000000000000001'], observedAt: { date: '2026-10-01', precision: 'day' },
  lastSeen: null, sourceRefs: [{ channelId: '200000000000000001', messageId: '400000000000000001' }], neutral: null,
  text: { text: 'café at noon' }, weight: 0.5, stored: { id: 4, at: 5, who: [] }, origin: 'live', by: 'archive', occurredAt: '2026-10-01T00:00:00.000Z',
  recordedAt: '2026-10-02T00:00:00.000Z', guildId: '300000000000000001', ...extra,
});

test('an archive line becomes one claim_versions row attached to its item', () => {
  const rows = assertRoundTrip(archive, REL, entry(), { position: 7 });
  assert.equal(rows.claim_versions.length, 1);
  assert.equal(rows.claims, undefined);
  const row = rows.claim_versions[0];
  assert.equal(row.id, 'ar-1');
  assert.equal(row.claim_id, 'rc-1');
  assert.equal(row.revision_id, 'rv-1');
  assert.equal(row.event, 'expired');
  assert.equal(row.by, 'archive');
  assert.equal(row.origin, 'live');
  assert.equal(row.recorded_at, '2026-10-02T00:00:00.000Z');
  assert.equal(row.text, 'café at noon');
  assert.equal(row.position, 7);
  assert.equal(JSON.parse(row.extra).itemKind, 'recent');
});

test('other text shapes, a private layer and odd lines survive', () => {
  assertRoundTrip(archive, REL, entry({ text: { what: 'w', quote: 'q', feeling: 'f' } }));
  assertRoundTrip(archive, REL, entry({ text: { text: 'x', messages: [{ id: '1', ts: 2, authorId: '3', name: 'n', self: false, text: 't', replyTo: null, caption: null }] } }));
  assertRoundTrip(archive, REL, entry({ text: { text: '' } }));
  assertRoundTrip(archive, 'private/100000000000000001/archive/2026-10.jsonl', entry({ scope: { user: '100000000000000001' } }));
  const noId = entry();
  delete noId.id;
  assertRoundTrip(archive, REL, noId, { position: 2 });
  assertRoundTrip(archive, REL, entry({ text: 'plain', unknown: { deep: [null, 1] } }));
  assertRoundTrip(archive, REL, null, { position: 3 });
  assertRoundTrip(archive, REL, 'a string', { position: 4 });
});

test('stubs are made only for items missing from hot memory, once each, never over a hot claim', () => {
  const hot = new Set(['rc-hot']);
  const lines = [entry(), entry({ id: 'ar-2', revisionId: 'rv-2' }), entry({ id: 'ar-3', itemId: 'rc-hot' })];
  const mapping = archive.withStubs({}, REL, lines, hot);
  assert.deepEqual(mapping.claims.map((row) => row.id), ['rc-1']);
  const stub = mapping.claims[0];
  assert.equal(stub.truth, 'historical');
  assert.equal(stub.retired_at, '2026-10-02T00:00:00.000Z');
  assert.equal(stub.kind, 'recent');
  assert.equal(stub.subject_id, 'discord:channel:200000000000000001');
  assert.equal(stub.text, 'café at noon');
  assert.equal(stub.scope_kind, 'group');
  assert.equal(archive.toRows(REL, entry()).claims, undefined);
  assert.equal(archive.toRows(REL, entry(), { hotClaimIds: new Set() }).claims.length, 1);
  assert.equal(archive.toRows(REL, entry(), { hotClaimIds: new Set(['rc-1']) }).claims, undefined);
  const dm = archive.claimStub('private/100000000000000001/archive/2026-10.jsonl', entry({ scope: { user: '100000000000000001' } }));
  assert.deepEqual([dm.scope_kind, dm.scope_dm, dm.subject_id], ['dm', 'person:discord:100000000000000001', 'person:discord:100000000000000001']);
});

const version = (extra = {}) => ({ at: '2026-10-01T00:00:00.000Z', by: 'analyzer', chars: 5, before: 10, after: 5, kept: 3, removed: 7, added: 2, text: 'Καλημέρα', ...extra });

test('a member\'s version file becomes description versions named like the profile mapper names them', () => {
  const file = { relationship: [version({ itemId: 'it-1' }), version({ text: 'later' })], style: [], character: [version({ by: 'owner' })] };
  const rows = assertRoundTrip(versions, 'versions/users/100000000000000001.json', file);
  assert.equal(rows.description_versions.length, 3);
  const [first, second] = rows.description_versions;
  assert.equal(first.id, 'desc:person:discord:100000000000000001:relationship:v0');
  assert.equal(first.description_id, 'desc:person:discord:100000000000000001:relationship');
  assert.equal(first.author, 'analyzer');
  assert.equal(first.written_at, '2026-10-01T00:00:00.000Z');
  assert.equal(first.origin, 'legacy');
  assert.equal(first.kept, 3);
  assert.deepEqual(JSON.parse(first.extra), { before: 10, after: 5, itemId: 'it-1' });
  assert.equal(second.position, 1);
  assert.equal(rows.description_versions[2].description_id, 'desc:person:discord:100000000000000001:character');
});

test('channel, guild and lore version files name their descriptions after their subject', () => {
  const file = { topics: [version()], odd: 'not a list' };
  const channel = assertRoundTrip(versions, 'versions/channels/200000000000000001.json', file);
  assert.equal(channel.description_versions[0].description_id, 'desc:discord:channel:200000000000000001:topics');
  const guild = assertRoundTrip(versions, 'versions/guild/guild.json', { patterns: [version()] }, { guildId: '300000000000000001' });
  assert.equal(guild.description_versions[0].description_id, 'desc:discord:guild:300000000000000001:patterns');
  const lore = assertRoundTrip(versions, 'versions/lore/715474998364.json', { text: [version()] });
  assert.equal(lore.description_versions[0].description_id, 'desc:lore:715474998364:text');
  assertRoundTrip(versions, 'versions/users/1.json', {});
  assertRoundTrip(versions, 'versions/users/1.json', { relationship: [version({ chars: '5', text: 7, extra: 1 })] });
  const { back } = roundTrip(versions, 'versions/users/1.json', { relationship: [] });
  assert.deepEqual(back, { relationship: [] });
});
