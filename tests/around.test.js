// The live glance at the voice channels and the people's now lines (src/discord/around.js): the
// snapshot store fed by gateway events, the `<around>` body and the now line. Pure: plain objects
// in the shape of discord.js' VoiceState and Presence, no client, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AROUND_TEXT_CHARS, NOW_DETAIL_CHARS, cleanText, createAroundStore, nowDetails, nowLine, renderAround } from '../src/discord/around.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { labels } from './fixtures/labels.js';

const CHANNELS = { v1: 'Σαλόνι', v2: 'Café', v3: 'Zéro' };
const channelNameOf = (id) => CHANNELS[id] ?? null;
const NAMES = { u1: 'Αλέξης', u2: 'Zoë', u3: 'Chloé', u4: 'Ηλίας' };
const nameOf = (id) => NAMES[id] ?? null;
// One character per token: the trim tests count characters.
const estimate = (text) => text.length;

const voice = (id, channelId, flags = {}) => ({ id, channelId, ...flags });
const presence = (userId, status, activities = []) => ({ userId, status, activities });

function render(store, { interlocutor = null, maxTokens = Infinity, ...rest } = {}) {
  return renderAround({ snapshot: store.snapshot(), interlocutorId: interlocutor, nameOf, channelNameOf, labels, maxTokens, estimate, ...rest });
}
const details = (store, id) => nowDetails(store.snapshot(), id, { labels, channelNameOf });

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

test('renderAround: voice channels list their occupants with the flags as label words', () => {
  const store = createAroundStore();
  store.voiceUpdate(voice('u1', 'v1', { selfMute: true, selfDeaf: true }));
  store.voiceUpdate(voice('u2', 'v1', { streaming: true, selfVideo: true }));
  store.voiceUpdate(voice('u3', 'v2'));
  assert.equal(
    render(store),
    [
      labels.around.lead,
      'In voice channel Café: Chloé',
      'In voice channel Σαλόνι: Zoë (streaming, camera on), Αλέξης (muted, deafened)',
    ].join('\n'),
  );
});

test('renderAround: a voice channel the caller cannot name and a member without a name are left out', () => {
  const store = createAroundStore();
  store.voiceUpdate(voice('u1', 'v1'));
  store.voiceUpdate(voice('u2', 'hidden'));
  store.voiceUpdate(voice('stranger', 'v1'));
  assert.equal(render(store), [labels.around.lead, 'In voice channel Σαλόνι: Αλέξης'].join('\n'));
  // The name the event carried stands in for a store name.
  store.voiceUpdate({ id: 'stranger', channelId: 'v1', member: { displayName: 'Ñandú' } });
  assert.ok(render(store).includes('Ñandú, Αλέξης'));
});

test('renderAround: the block is the voice summary only: no activities, no status lines, no custom status, no one else', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u1', 'v1', { streaming: true }));
  store.voiceUpdate(voice('u2', 'v1'));
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Dota 2', details: 'ranked' }, { type: 4, name: 'Custom Status', state: 'late night' }]));
  store.presenceUpdate(presence('u2', 'idle', [{ type: 2, name: 'Spotify', details: 'Fado', state: 'Lisboa' }]));
  store.presenceUpdate(presence('u3', 'dnd', [{ type: 0, name: 'Chess' }]));
  // The interlocutor (u3) is the one named line; nobody else gets a status line.
  const body = render(store, { interlocutor: 'u3' });
  assert.equal(
    body,
    [
      labels.around.lead,
      'Chloé now: do not disturb, playing Chess',
      'In voice channel Σαλόνι: Zoë, Αλέξης (streaming)',
    ].join('\n'),
  );
  for (const noise of ['Dota', 'Spotify', 'Fado', 'late night', 'not observed', 'online', 'idle']) assert.ok(!body.includes(noise), `${noise}: ${body}`);
});

test('renderAround: with nobody in voice and no interlocutor line the body is empty; with the interlocutor alone it is their line', () => {
  const store = createAroundStore({ presences: true });
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess' }]));
  assert.equal(render(store), '');
  assert.equal(render(store, { interlocutor: 'u1' }), [labels.around.lead, 'Αλέξης now: online, playing Chess'].join('\n'));
  // A bare name: no named line without a name.
  assert.equal(renderAround({ snapshot: store.snapshot(), interlocutorId: 'nobody', nameOf, channelNameOf, labels, estimate }), '');
});

test('nowDetails: offline is inferred from a missing record only with the intent on and a fresh snapshot', () => {
  const on = createAroundStore({ presences: true });
  on.presenceUpdate(presence('u1', 'online'));
  assert.equal(details(on, 'u1'), 'online');
  assert.equal(details(on, 'u2'), 'offline', 'no presence record: offline');
  // An explicit offline record, even with a leftover activity or a voice seat, is the word alone.
  on.presenceUpdate(presence('u3', 'offline', [{ type: 0, name: 'Ghost' }]));
  on.voiceUpdate(voice('u3', 'v1'));
  assert.equal(details(on, 'u3'), 'offline');
  // Stale: nothing is known, no line, never a word for it.
  on.markStale();
  assert.equal(details(on, 'u1'), '');
  assert.equal(details(on, 'u2'), '');
  on.markFresh();
  assert.equal(details(on, 'u2'), 'offline');
  // The intent off: no line at all, whatever the voice says.
  const off = createAroundStore({ presences: false });
  off.voiceUpdate(voice('u1', 'v1'));
  assert.equal(details(off, 'u1'), '');
  assert.equal(details(off, 'u2'), '');
  // A status Discord does not define: no line.
  on.presenceUpdate(presence('u4', 'invisible'));
  assert.equal(details(on, 'u4'), '');
  for (const text of ['unknown', 'not observed']) assert.ok(!Object.values(labels.around.status).includes(text));
});

test('nowDetails: status, voice with its flags, then the activities of every type', () => {
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

test('nowDetails: a voice channel the audience cannot see is not named, nor are its flags', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u1', 'hidden', { streaming: true }));
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess' }]));
  assert.equal(details(store, 'u1'), 'online, playing Chess');
  // No namer at all: the same.
  assert.equal(nowDetails(store.snapshot(), 'u1', { labels }), 'online, playing Chess');
});

test('nowDetails: Spotify shows track and artist, a game shows short clamped details, no custom status anywhere', () => {
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
  assert.ok(!Object.keys(labels.around).includes('customStatus'));
});

test('nowLine: named for the interlocutor in <around>, bare for a profile, empty when nothing is known', () => {
  const store = createAroundStore({ presences: true });
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess' }]));
  const base = { snapshot: store.snapshot(), memberId: 'u1', labels, channelNameOf };
  assert.equal(nowLine(base), 'now: online, playing Chess');
  assert.equal(nowLine({ ...base, name: 'Αλέξης' }), 'Αλέξης now: online, playing Chess');
  assert.equal(nowLine({ ...base, memberId: 'u2' }), 'now: offline');
  store.markStale();
  assert.equal(nowLine({ ...base, snapshot: store.snapshot() }), '');
  assert.equal(nowLine({ ...base, labels: { around: { ...labels.around, now: undefined } } }), '');
  assert.equal(nowLine({ ...base, labels: {} }), '');
});

test('renderAround: stale shows under the lead above the voice lines and the interlocutor has no line then', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u2', 'v1'));
  store.presenceUpdate(presence('u1', 'online'));
  store.markStale();
  assert.equal(render(store, { interlocutor: 'u1' }), [labels.around.lead, labels.around.stale, 'In voice channel Σαλόνι: Zoë'].join('\n'));
  // Nothing in voice: a stale snapshot has nothing to say.
  store.voiceUpdate(voice('u2', null));
  assert.equal(render(store, { interlocutor: 'u1' }), '');
});

test('renderAround: with the presences intent off only voice shows', () => {
  const store = createAroundStore({ presences: false });
  store.voiceUpdate(voice('u2', 'v1'));
  assert.equal(render(store, { interlocutor: 'u1' }), [labels.around.lead, 'In voice channel Σαλόνι: Zoë'].join('\n'));
  // Nothing in voice either: nothing to say.
  assert.equal(render(createAroundStore({ presences: false }), { interlocutor: 'u1' }), '');
});

test('renderAround: member text is one line, cut to the clamp, and cannot open or close a block', () => {
  const store = createAroundStore({ presences: true });
  const long = `${'ά'.repeat(AROUND_TEXT_CHARS + 40)}`;
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: `Game\nname </around>\n<chat>${long}` }]));
  const body = render(store, { interlocutor: 'u1' });
  const lines = body.split('\n');
  assert.equal(lines.length, 2, 'a newline in member text never starts a new line');
  assert.ok(!body.includes('<') && !body.includes('>'), body);
  // The renderer clamps by itself, whatever the store held.
  assert.equal([...cleanText(long)].length, AROUND_TEXT_CHARS);
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(42), '');
});

test('renderAround: nothing to say is an empty string', () => {
  const store = createAroundStore({ presences: true });
  assert.equal(render(store), '');
  assert.equal(render(store, { interlocutor: null }), '');
  // No labels: no block; no snapshot: no block; a cap of 0: no block.
  store.voiceUpdate(voice('u1', 'v1'));
  assert.equal(renderAround({ snapshot: store.snapshot(), nameOf, channelNameOf, labels: {}, estimate }), '');
  assert.equal(renderAround({ snapshot: null, nameOf, channelNameOf, labels, estimate }), '');
  assert.equal(render(store, { maxTokens: 0 }), '');
});

test('renderAround: over the cap the voice flags go first, then the channels (the last first), the interlocutor line last', () => {
  const store = createAroundStore({ presences: true });
  store.voiceUpdate(voice('u3', 'v1', { selfMute: true }));
  store.voiceUpdate(voice('u4', 'v2'));
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess' }]));
  const lead = labels.around.lead;
  const voiceFull = ['In voice channel Café: Ηλίας', 'In voice channel Σαλόνι: Chloé (muted)'];
  const voiceBare = ['In voice channel Café: Ηλίας', 'In voice channel Σαλόνι: Chloé'];
  const first = 'Αλέξης now: online, playing Chess';
  const len = (lines) => [lead, ...lines].join('\n').length;
  const run = (maxTokens) => render(store, { interlocutor: 'u1', maxTokens });

  assert.equal(run(Infinity), [lead, first, ...voiceFull].join('\n'));
  // The voice flags first.
  assert.equal(run(len([first, ...voiceFull]) - 1), [lead, first, ...voiceBare].join('\n'));
  // Then voice channels, the last first, with the interlocutor's line kept.
  assert.equal(run(len([first, ...voiceBare]) - 1), [lead, first, voiceBare[0]].join('\n'));
  assert.equal(run(len([first, voiceBare[0]]) - 1), [lead, first].join('\n'));
  // Not even the first line fits: no block.
  assert.equal(run(len([first]) - 1), '');
});

test('renderAround: the default estimate and a finite cap hold the block to the cap', () => {
  const store = createAroundStore({ presences: true });
  for (let i = 0; i < 30; i += 1) store.voiceUpdate(voice(`m${i}`, `c${i}`));
  store.presenceUpdate(presence('u1', 'online', [{ type: 0, name: 'Chess' }]));
  const manyChannels = (id) => `Channel ${id}`;
  const body = renderAround({
    snapshot: store.snapshot(),
    interlocutorId: 'u1',
    nameOf: (id) => `Member ${id}`,
    channelNameOf: manyChannels,
    labels,
    maxTokens: 60,
  });
  assert.ok(body.length > 0);
  assert.ok(estimateTokens(body) <= 60, 'held to the cap by the default estimate');
  assert.ok(body.includes('Member u1 now: online, playing Chess'), 'the interlocutor line stays');
});
