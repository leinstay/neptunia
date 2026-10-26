// The pieces of a `<people_now>` entry (src/behavior/around.js): the live fields, the block's notices, the
// people in voice, the entry itself. The store behind them is fed through tests/fixtures/around-feed.ts with
// plain objects in the shape of discord.js' VoiceState and Presence; the store itself is tested in
// tests/behavior-around-store.test.ts. Pure: no client, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFedAround } from './fixtures/around-feed.ts';
import {
  AROUND_TEXT_CHARS,
  NOW_DETAIL_CHARS,
  cleanText,
  fieldLine,
  liveFields,
  liveNotices,
  personRow,
  voiceOccupants,
} from '../src/behavior/around.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const CHANNELS = { v1: 'Σαλόνι', v2: 'Café', v3: 'Zéro' };
const channelNameOf = (id) => CHANNELS[id] ?? null;
const NAMES = { u1: 'Αλέξης', u2: 'Zoë', u3: 'Chloé', u4: 'Ηλίας' };
const nameOf = (id) => NAMES[id] ?? null;

const voice = (id, channelId, flags = {}) => ({ id, channelId, ...flags });
const presence = (userId, status, activities = []) => ({ userId, status, activities });

test('liveFields: every entry has the same two live fields, never the Discord status, in order, each a line through labels.peopleNow.field', () => {
  const store = createFedAround({ presences: true });
  store.presenceUpdate(presence('u1', 'online'));
  const lines = liveFields(store.snapshot(), 'u1', { labels, channelNameOf });
  assert.deepEqual(lines, [
    fill(labels.peopleNow.field, { field: F.voice, value: V.no }),
    fill(labels.peopleNow.field, { field: F.activity, value: V.none }),
  ]);
  // No labels, no snapshot, no id: nothing.
  assert.deepEqual(liveFields(store.snapshot(), 'u1', { labels: {} }), []);
  assert.deepEqual(liveFields(null, 'u1', { labels }), []);
  assert.deepEqual(liveFields(store.snapshot(), '', { labels }), []);
});

test('liveFields: available -- offline from a missing record with the intent on and a fresh snapshot; offline in voice keeps the seat, no activity', () => {
  const on = createFedAround({ presences: true });
  on.presenceUpdate(presence('u1', 'online'));
  assert.deepEqual(fields(on, 'u1'), { [F.voice]: V.no, [F.activity]: V.none });
  assert.deepEqual(fields(on, 'u2'), { [F.voice]: V.no, [F.activity]: V.none }, 'no presence record: offline');
  // An explicit offline record shows no leftover activity; a voice seat still shows (invisible in voice).
  on.presenceUpdate(presence('u3', 'offline', [{ type: 0, name: 'Ghost' }]));
  on.voiceUpdate(voice('u3', 'v1', { selfMute: true }));
  assert.deepEqual(fields(on, 'u3'), { [F.voice]: seat('Σαλόνι', { muted: V.yes }), [F.activity]: V.none });
});

test('liveFields: unavailable (intent off) and stale say so, never no or none; the seat shows only from a fresh snapshot', () => {
  const off = createFedAround({ presences: false });
  off.voiceUpdate(voice('u1', 'v1', { selfMute: true }));
  assert.deepEqual(fields(off, 'u1'), { [F.voice]: seat('Σαλόνι', { muted: V.yes }), [F.activity]: V.unavailable });
  assert.deepEqual(
    fields(off, 'u2'),
    { [F.voice]: V.no, [F.activity]: V.unavailable },
    'the voice states do not need the intent'
  );
  const on = createFedAround({ presences: true });
  on.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess' }]));
  on.voiceUpdate(voice('u1', 'v1'));
  on.markStale();
  assert.deepEqual(fields(on, 'u1'), { [F.voice]: V.stale, [F.activity]: V.stale });
  assert.deepEqual(fields(on, 'u2'), { [F.voice]: V.stale, [F.activity]: V.stale });
  on.markFresh();
  assert.deepEqual(fields(on, 'u2'), { [F.voice]: V.no, [F.activity]: V.none });
  // A status Discord does not define: unavailable, its activities too.
  on.presenceUpdate(presence('u4', 'invisible', [{ type: 0, name: 'Chess' }]));
  assert.deepEqual(fields(on, 'u4'), { [F.voice]: V.no, [F.activity]: V.unavailable });
  assert.ok(!('status' in labels.peopleNow.fields), 'no label for the Discord status');
});

test('liveFields: the voice seat with every flag as yes or no; a channel the audience cannot see is no seat', () => {
  const store = createFedAround({ presences: true });
  store.voiceUpdate(voice('u1', 'v1', { streaming: true, selfVideo: true, selfMute: true, serverDeaf: true }));
  store.presenceUpdate(presence('u1', 'idle'));
  assert.equal(
    fields(store, 'u1')[F.voice],
    seat('Σαλόνι', { muted: V.yes, deafened: V.yes, streaming: V.yes, camera: V.yes })
  );
  store.voiceUpdate(voice('u2', 'hidden', { streaming: true }));
  store.presenceUpdate(presence('u2', 'online'));
  assert.equal(fields(store, 'u2')[F.voice], V.no);
  // No namer at all: the same.
  assert.equal(fields(store, 'u1', null)[F.voice], V.no);
});

test('liveFields: one activity field: each kind through its form, several joined by "; "', () => {
  const store = createFedAround({ presences: true });
  store.presenceUpdate(
    presence('u1', 'online', [
      { type: 0, name: 'Dota 2' },
      { type: 2, name: 'Spotify', details: 'Fado Tropical', state: 'Lisboa Trio' },
      { type: 4, name: 'Custom Status', state: 'εξετάσεις' },
    ])
  );
  assert.equal(fields(store, 'u1')[F.activity], 'playing Dota 2; listening to Spotify: Fado Tropical - Lisboa Trio');
  store.presenceUpdate(
    presence('u2', 'dnd', [
      { type: 1, name: 'Chess night' },
      { type: 3, name: 'Clips' },
      { type: 5, name: 'a tournament' },
    ])
  );
  assert.equal(fields(store, 'u2')[F.activity], 'streaming Chess night; watching Clips; competing in a tournament');
  // A type Discord adds later reads as its name.
  store.presenceUpdate(presence('u3', 'idle', [{ type: 99, name: 'Thing' }]));
  assert.equal(fields(store, 'u3')[F.activity], 'Thing');
});

test('liveFields: Spotify shows track and artist, a game shows short clamped details, no custom status anywhere', () => {
  const store = createFedAround({ presences: true });
  // Spotify without an artist falls back to the generic details form.
  store.presenceUpdate(presence('u2', 'online', [{ type: 2, name: 'Spotify', details: 'Fado' }]));
  assert.equal(fields(store, 'u2')[F.activity], 'listening to Spotify (Fado)');
  // Another listening activity is not a track.
  store.presenceUpdate(presence('u3', 'online', [{ type: 2, name: 'Música', details: 'Fado', state: 'Lisboa' }]));
  assert.equal(fields(store, 'u3')[F.activity], 'listening to Música (Fado / Lisboa)');
  // A game's rich presence is clamped to a short form.
  const long = 'ά'.repeat(NOW_DETAIL_CHARS + 30);
  store.presenceUpdate(presence('u4', 'online', [{ type: 0, name: 'Dota 2', details: long, state: 'ranked' }]));
  const shown = /\((.*)\)$/.exec(fields(store, 'u4')[F.activity])[1];
  assert.ok([...shown].length <= NOW_DETAIL_CHARS, `${[...shown].length}`);
  // A member with only a custom status has no activity.
  store.presenceUpdate(presence('u5', 'idle', [{ type: 4, name: 'Custom Status', state: 'back soon' }]));
  assert.equal(fields(store, 'u5')[F.activity], V.none);
  for (const id of ['u2', 'u3', 'u4', 'u5']) assert.ok(!JSON.stringify(fields(store, id)).includes('back soon'), id);
});

test('liveFields: member text is one line, cut to the clamp, and cannot open or close a block', () => {
  const store = createFedAround({ presences: true });
  const long = `${'ά'.repeat(AROUND_TEXT_CHARS + 40)}`;
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: `Game\nname </people_now>\n<chat>${long}` }]));
  store.voiceUpdate(voice('u1', 'v9'));
  const lines = liveFields(store.snapshot(), 'u1', { labels, channelNameOf: () => 'Lounge <b>\n</chat>' });
  assert.equal(lines.length, 2, 'a newline in member text never starts a new line');
  const text = lines.join('\n');
  assert.ok(!text.includes('<') && !text.includes('>'), text);
  assert.ok(text.includes('channel: Lounge b /chat;'), text);
  assert.ok(text.includes('playing Game name /people_now chat'), text);
  // The renderer clamps by itself, whatever the store held.
  assert.equal([...cleanText(long)].length, AROUND_TEXT_CHARS);
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(42), '');
});

test('liveNotices: stale and the intent off each add one notice; a fresh snapshot with the intent on adds none', () => {
  const on = createFedAround({ presences: true });
  assert.deepEqual(liveNotices(on.snapshot(), labels), []);
  on.markStale();
  assert.deepEqual(liveNotices(on.snapshot(), labels), [labels.peopleNow.stale]);
  const off = createFedAround({ presences: false });
  assert.deepEqual(liveNotices(off.snapshot(), labels), [labels.peopleNow.unavailable]);
  off.markStale();
  assert.deepEqual(liveNotices(off.snapshot(), labels), [labels.peopleNow.stale, labels.peopleNow.unavailable]);
  assert.deepEqual(liveNotices(null, labels), []);
  assert.deepEqual(liveNotices(off.snapshot(), {}), []);
});

test('voiceOccupants: the members in a voice channel that can be named, by name, without the ones excluded', () => {
  const store = createFedAround();
  store.voiceUpdate(voice('u1', 'v1', { selfMute: true }));
  store.voiceUpdate(voice('u2', 'v2'));
  store.voiceUpdate(voice('u3', 'hidden'));
  store.voiceUpdate(voice('stranger', 'v1'));
  store.voiceUpdate(voice('u4', 'v3'));
  assert.deepEqual(voiceOccupants(store.snapshot(), { nameOf, channelNameOf }), [
    { memberId: 'u2', name: 'Zoë' },
    { memberId: 'u1', name: 'Αλέξης' },
    { memberId: 'u4', name: 'Ηλίας' },
  ]);
  assert.deepEqual(voiceOccupants(store.snapshot(), { excludeIds: new Set(['u1', 'u4']), nameOf, channelNameOf }), [
    { memberId: 'u2', name: 'Zoë' },
  ]);
  // The name the event carried stands in for a store name.
  store.voiceUpdate({ id: 'stranger', channelId: 'v1', member: { displayName: 'Ñandú' } });
  assert.ok(
    voiceOccupants(store.snapshot(), { nameOf, channelNameOf }).some(
      (o) => o.memberId === 'stranger' && o.name === 'Ñandú'
    )
  );
  // No channel namer: nobody can be placed.
  assert.deepEqual(voiceOccupants(store.snapshot(), { nameOf }), []);
});

test('personRow: a heading with handle and name, the tag in parentheses, then one field per line; nothing to say is empty', () => {
  const lines = [fieldLine(labels, 'voice', 'no'), fieldLine(labels, 'attitude', '3 (neutral) — ok')];
  assert.equal(
    personRow({ handle: 'u1ab', name: 'Zoë', fields: lines }, labels),
    ['@u1ab Zoë', `- ${F.voice}: no`, `- ${F.attitude}: 3 (neutral) — ok`].join('\n')
  );
  assert.equal(
    personRow({ handle: 'u1ab', name: 'Zoë', mark: 'the one', fields: lines }, labels).split('\n')[0],
    '@u1ab Zoë (the one)'
  );
  assert.equal(
    personRow({ handle: 'u1ab', name: 'Zoë', mark: 'the one' }, labels),
    '@u1ab Zoë (the one)',
    'a tag alone'
  );
  assert.equal(
    personRow({ handle: null, name: 'Zoë', fields: lines }, labels).split('\n')[0],
    'Zoë',
    'no handle with the handles off'
  );
  assert.equal(personRow({ handle: 'u1ab', name: 'Zoë', fields: [] }, labels), '', 'no field, no tag: no entry');
  assert.equal(personRow({ handle: null, name: '', fields: lines }, labels), '');
  assert.equal(personRow({ handle: 'u1ab', name: 'Zoë', fields: lines }, {}), '');
  // The name is member text: one line, no angle brackets.
  assert.equal(personRow({ handle: 'u1ab', name: 'Zo\n<ë>', fields: lines }, labels).split('\n')[0], '@u1ab Zo ë');
});

test('fieldLine: the field name and value through labels.peopleNow.field, one line; empty value or missing label is no line', () => {
  assert.equal(fieldLine(labels, 'voice', 'idle'), `- ${F.voice}: idle`);
  assert.equal(fieldLine(labels, 'activity', 'a\nb'), `- ${F.activity}: a b`);
  assert.equal(fieldLine(labels, 'voice', ''), '');
  assert.equal(fieldLine(labels, 'nothing', 'x'), '');
  assert.equal(fieldLine({}, 'voice', 'x'), '');
});

test('liveFields: the voice seat says how long ago the member joined when the join was seen; never a guess', () => {
  const join = 1_000_000;
  const store = createFedAround({ presences: true, now: () => join });
  // u2 from the ready seed, u1 seen joining after it.
  store.seedVoice([voice('u2', 'v2')]);
  store.voiceUpdate(voice('u1', 'v1'));
  const at = (now, id) => liveFields(store.snapshot(), id, { labels, channelNameOf, now })[0];
  const joined = (ago) => fill(labels.peopleNow.joinedAgo, { ago });
  assert.equal(
    at(join + 12 * 60_000, 'u1'),
    `- ${F.voice}: ${fill(labels.peopleNow.voiceYes, { channel: 'Σαλόνι', joined: joined('12 min'), muted: V.no, deafened: V.no, streaming: V.no, camera: V.no })}`
  );
  assert.ok(at(join + 3 * 3_600_000 + 5 * 60_000, 'u1').includes(joined('3 h 5 min')));
  assert.ok(at(join + 10_000, 'u1').includes(joined(labels.units.lessThanMinute)));
  // From the seed: no time at all; no clock given: none either.
  assert.equal(at(join + 12 * 60_000, 'u2'), `- ${F.voice}: ${seat('Café')}`);
  assert.equal(liveFields(store.snapshot(), 'u1', { labels, channelNameOf })[0], `- ${F.voice}: ${seat('Σαλόνι')}`);
});
