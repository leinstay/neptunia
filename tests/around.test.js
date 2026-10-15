// The live glance at the voice channels and the people's statuses (src/discord/around.js): the
// snapshot store fed by gateway events and the pieces of a `<people_now>` row (the live part,
// the block's notices, the people in voice, the row itself). Pure: plain objects in the shape of
// discord.js' VoiceState and Presence, no client, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AROUND_TEXT_CHARS, NOW_DETAIL_CHARS, cleanText, createAroundStore, liveDetails, liveNotices, nowRow, voiceOccupants } from '../src/discord/around.js';
import { labels } from './fixtures/labels.js';

const CHANNELS = { v1: 'Σαλόνι', v2: 'Café', v3: 'Zéro' };
const channelNameOf = (id) => CHANNELS[id] ?? null;
const NAMES = { u1: 'Αλέξης', u2: 'Zoë', u3: 'Chloé', u4: 'Ηλίας' };
const nameOf = (id) => NAMES[id] ?? null;

const voice = (id, channelId, flags = {}) => ({ id, channelId, ...flags });
const presence = (userId, status, activities = []) => ({ userId, status, activities });

const details = (store, id) => liveDetails(store.snapshot(), id, { labels, channelNameOf });

test('around store: a voice join, a flag change, a move and a leave keep one record per member', () => {
  const store = createAroundStore();
  store.voiceUpdate(voice('u1', 'v1'));
  store.voiceUpdate(voice('u2', 'v1', { selfMute: true }));
  assert.equal(store.snapshot().voice.size, 2);
  assert.equal(store.snapshot().voice.get('u2').muted, true);
  // A flag change in the same channel replaces the record.
  store.voiceUpdate(voice('u2', 'v1', { selfDeaf: true, streaming: true }));
  const changed = store.snapshot().voice.get('u2');
  assert.deepEqual([changed.muted, changed.deafened, changed.streaming, changed.camera], [false, true, true, false]);
  // A server mute counts as muted, a camera as camera.
  store.voiceUpdate(voice('u2', 'v2', { serverMute: true, selfVideo: true }));
  const moved = store.snapshot().voice.get('u2');
  assert.deepEqual([moved.channelId, moved.muted, moved.camera], ['v2', true, true]);
  // Leaving removes the member.
  store.voiceUpdate(voice('u2', null));
  assert.equal(store.snapshot().voice.has('u2'), false);
  assert.equal(store.snapshot().voice.size, 1);
  assert.deepEqual(store.counts(), { voice: 1, presence: 0, stale: false });
});

test('around store: the snapshot is a copy a renderer cannot change', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u1', 'v1'));
  store.presenceUpdate(presence('u1', 'online'));
  const snapshot = store.snapshot();
  snapshot.voice.clear();
  snapshot.presence.clear();
  assert.equal(store.snapshot().voice.size, 1);
  assert.equal(store.snapshot().presence.size, 1);
});

test('around store: a presence update replaces the status and the activities and never keeps a custom status', () => {
  const store = createAroundStore({ presences: true });
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess', details: 'blitz', state: 'round 2' }, { type: 4, name: 'Custom Status', state: 'back soon' }]));
  const first = store.snapshot().presence.get('u1');
  assert.equal(first.status, 'online');
  assert.deepEqual(first.activities, [{ type: 0, name: 'Chess', details: 'blitz', state: 'round 2' }]);
  assert.ok(!('custom' in first), 'no custom status field');
  assert.ok(!JSON.stringify(first).includes('back soon'), 'the custom status text is not kept');
  store.presenceUpdate(presence('u1', 'idle', []));
  const second = store.snapshot().presence.get('u1');
  assert.deepEqual([second.status, second.activities], ['idle', []]);
  // A status Discord does not define stays unknown, never offline.
  store.presenceUpdate(presence('u2', 'invisible'));
  assert.equal(store.snapshot().presence.get('u2').status, 'unknown');
});

test('around store: with the presences intent off a presence is ignored and a seed adds none', () => {
  const store = createAroundStore({ presences: false });
  store.presenceUpdate(presence('u1', 'online'));
  store.seedPresence([presence('u2', 'dnd')]);
  assert.equal(store.snapshot().presence.size, 0);
  assert.equal(store.snapshot().presences, false);
});

test('around store: a seed replaces what was held; stale and fresh are explicit', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u1', 'v1'));
  store.seedVoice([voice('u2', 'v2'), voice('u3', null)]);
  assert.deepEqual([...store.snapshot().voice.keys()], ['u2']);
  store.seedPresence([presence('u3', 'online')]);
  assert.deepEqual([...store.snapshot().presence.keys()], ['u3']);
  assert.equal(store.snapshot().stale, false);
  store.markStale();
  assert.equal(store.snapshot().stale, true);
  store.markFresh();
  assert.equal(store.snapshot().stale, false);
});

test('liveDetails: offline is inferred from a missing record only with the intent on and a fresh snapshot', () => {
  const on = createAroundStore({ presences: true });
  on.presenceUpdate(presence('u1', 'online'));
  assert.equal(details(on, 'u1'), 'online');
  assert.equal(details(on, 'u2'), 'offline', 'no presence record: offline');
  // An explicit offline record shows no leftover activity; a voice seat still shows (invisible in voice).
  on.presenceUpdate(presence('u3', 'offline', [{ type: 0, name: 'Ghost' }]));
  assert.equal(details(on, 'u3'), 'offline');
  on.voiceUpdate(voice('u3', 'v1'));
  assert.equal(details(on, 'u3'), 'offline, in voice Σαλόνι');
  // Stale: nothing about presence, never a word for it; the voice seat stays.
  on.markStale();
  assert.equal(details(on, 'u1'), '');
  assert.equal(details(on, 'u2'), '');
  assert.equal(details(on, 'u3'), 'in voice Σαλόνι');
  on.markFresh();
  assert.equal(details(on, 'u2'), 'offline');
  // The intent off: no status and no activity, whatever is held; the voice seat shows.
  const off = createAroundStore({ presences: false });
  off.voiceUpdate(voice('u1', 'v1', { selfMute: true }));
  assert.equal(details(off, 'u1'), 'in voice Σαλόνι, muted');
  assert.equal(details(off, 'u2'), '');
  // A status Discord does not define: no status, no activity.
  on.presenceUpdate(presence('u4', 'invisible', [{ type: 0, name: 'Chess' }]));
  assert.equal(details(on, 'u4'), '');
  for (const text of ['unknown', 'not observed']) assert.ok(!Object.values(labels.peopleNow.status).includes(text));
});

test('liveDetails: status, voice with its flags, then the activities of every type', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u1', 'v1', { streaming: true, selfVideo: true, selfMute: true }));
  store.presenceUpdate(
    presence('u1', 'online', [
      { type: 0, name: 'Dota 2' },
      { type: 1, name: 'Chess night' },
      { type: 5, name: 'a tournament' },
    ]),
  );
  assert.equal(details(store, 'u1'), 'online, in voice Σαλόνι, muted, streaming, camera on, playing Dota 2, streaming Chess night, competing in a tournament');
  store.presenceUpdate(presence('u2', 'dnd', [{ type: 3, name: 'Clips' }, { type: 99, name: 'Thing' }]));
  assert.equal(details(store, 'u2'), 'do not disturb, watching Clips, Thing');
  store.presenceUpdate(presence('u3', 'idle'));
  assert.equal(details(store, 'u3'), 'idle');
});

test('liveDetails: a voice channel the audience cannot see is not named, nor are its flags', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u1', 'hidden', { streaming: true }));
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess' }]));
  assert.equal(details(store, 'u1'), 'online, playing Chess');
  // No namer at all: the same.
  assert.equal(liveDetails(store.snapshot(), 'u1', { labels }), 'online, playing Chess');
});

test('liveDetails: Spotify shows track and artist, a game shows short clamped details, no custom status anywhere', () => {
  const store = createAroundStore({ presences: true });
  store.presenceUpdate(presence('u1', 'online', [{ type: 2, name: 'Spotify', details: 'Fado Tropical', state: 'Lisboa Trio' }, { type: 4, name: 'Custom Status', state: 'εξετάσεις' }]));
  assert.equal(details(store, 'u1'), 'online, listening to Spotify: Fado Tropical - Lisboa Trio');
  // Spotify without an artist falls back to the generic details form.
  store.presenceUpdate(presence('u2', 'online', [{ type: 2, name: 'Spotify', details: 'Fado' }]));
  assert.equal(details(store, 'u2'), 'online, listening to Spotify (Fado)');
  // Another listening activity is not a track.
  store.presenceUpdate(presence('u3', 'online', [{ type: 2, name: 'Música', details: 'Fado', state: 'Lisboa' }]));
  assert.equal(details(store, 'u3'), 'online, listening to Música (Fado / Lisboa)');
  // A game's rich presence is clamped to a short form.
  const long = 'ά'.repeat(NOW_DETAIL_CHARS + 30);
  store.presenceUpdate(presence('u4', 'online', [{ type: 0, name: 'Dota 2', details: long, state: 'ranked' }]));
  const shown = /\((.*)\)$/.exec(details(store, 'u4'))[1];
  assert.ok([...shown].length <= NOW_DETAIL_CHARS, `${[...shown].length}`);
  // A member with only a custom status has an empty activity list: just the status.
  store.presenceUpdate(presence('u5', 'idle', [{ type: 4, name: 'Custom Status', state: 'back soon' }]));
  assert.equal(details(store, 'u5'), 'idle');
  for (const id of ['u1', 'u2', 'u3', 'u4', 'u5']) assert.ok(!details(store, id).includes('custom'), id);
  assert.ok(!Object.keys(labels.peopleNow).includes('customStatus'));
});

test('liveDetails: member text is one line, cut to the clamp, and cannot open or close a block', () => {
  const store = createAroundStore({ presences: true });
  const long = `${'ά'.repeat(AROUND_TEXT_CHARS + 40)}`;
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: `Game\nname </people_now>\n<chat>${long}` }]));
  store.voiceUpdate(voice('u1', 'v9'));
  const text = liveDetails(store.snapshot(), 'u1', { labels, channelNameOf: () => 'Lounge <b>\n</chat>' });
  assert.ok(!text.includes('\n'), 'a newline in member text never starts a new line');
  assert.ok(!text.includes('<') && !text.includes('>'), text);
  assert.ok(text.startsWith('online, in voice Lounge b /chat, playing Game name /people_now chat'), text);
  // The renderer clamps by itself, whatever the store held.
  assert.equal([...cleanText(long)].length, AROUND_TEXT_CHARS);
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(42), '');
  // No labels, no snapshot, no id: nothing.
  assert.equal(liveDetails(store.snapshot(), 'u1', { labels: {} }), '');
  assert.equal(liveDetails(null, 'u1', { labels }), '');
  assert.equal(liveDetails(store.snapshot(), '', { labels }), '');
});

test('liveNotices: stale and the intent off each add one notice; a fresh snapshot with the intent on adds none', () => {
  const on = createAroundStore({ presences: true });
  assert.deepEqual(liveNotices(on.snapshot(), labels), []);
  on.markStale();
  assert.deepEqual(liveNotices(on.snapshot(), labels), [labels.peopleNow.stale]);
  const off = createAroundStore({ presences: false });
  assert.deepEqual(liveNotices(off.snapshot(), labels), [labels.peopleNow.unavailable]);
  off.markStale();
  assert.deepEqual(liveNotices(off.snapshot(), labels), [labels.peopleNow.stale, labels.peopleNow.unavailable]);
  assert.deepEqual(liveNotices(null, labels), []);
  assert.deepEqual(liveNotices(off.snapshot(), {}), []);
});

test('voiceOccupants: the members in a voice channel that can be named, by name, without the ones excluded', () => {
  const store = createAroundStore();
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
  assert.deepEqual(voiceOccupants(store.snapshot(), { excludeIds: new Set(['u1', 'u4']), nameOf, channelNameOf }), [{ memberId: 'u2', name: 'Zoë' }]);
  // The name the event carried stands in for a store name.
  store.voiceUpdate({ id: 'stranger', channelId: 'v1', member: { displayName: 'Ñandú' } });
  assert.ok(voiceOccupants(store.snapshot(), { nameOf, channelNameOf }).some((o) => o.memberId === 'stranger' && o.name === 'Ñandú'));
  // No channel namer: nobody can be placed.
  assert.deepEqual(voiceOccupants(store.snapshot(), { nameOf }), []);
});

test('nowRow: handle and name, then the mark and the parts; the mark alone through rowBare; nothing to say is empty', () => {
  assert.equal(nowRow({ handle: 'u1ab', name: 'Zoë', parts: ['online', '', 'attitude: 3'] }, labels), '@u1ab Zoë: online; attitude: 3');
  assert.equal(nowRow({ handle: 'u1ab', name: 'Zoë', mark: ' (M)', parts: ['online'] }, labels), '@u1ab Zoë (M): online');
  assert.equal(nowRow({ handle: 'u1ab', name: 'Zoë', mark: ' (M)' }, labels), '@u1ab Zoë (M)');
  assert.equal(nowRow({ handle: null, name: 'Zoë', parts: ['idle'] }, labels), 'Zoë: idle', 'no handle with the handles off');
  assert.equal(nowRow({ handle: 'u1ab', name: 'Zoë', parts: [] }, labels), '', 'no part, no mark: no row');
  assert.equal(nowRow({ handle: null, name: '', parts: ['idle'] }, labels), '');
  assert.equal(nowRow({ handle: 'u1ab', name: 'Zoë', parts: ['idle'] }, {}), '');
  // The name is member text: one line, no angle brackets; a part with a newline stays on the row.
  assert.equal(nowRow({ handle: 'u1ab', name: 'Zo\n<ë>', parts: ['a\nb'] }, labels), '@u1ab Zo ë: a b');
});
