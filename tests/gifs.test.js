// The GIF library: pure collection/ranking (src/memory/gifs.js), its storage
// in gifs.json (src/memory/store.js), the live pipeline that feeds it
// (src/memory/update.js#observe), the <gif> tag (src/llm/parse.js) and the
// poster (src/behavior/turn.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { collectGifItems, findGif, markOwnGif, mergeGifs, normalizeGifs, rankGifs, resetGifCounts } from '../src/memory/gifs.js';
import { createStore } from '../src/memory/store.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { parseOutput } from '../src/llm/parse.js';
import { createTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordAdapter, createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const TENOR = 'https://tenor.com/view/cat-dance-123';
const GIPHY = 'https://giphy.com/gifs/wave-abc';

function gifLink(id, url = TENOR, title = 'Chat qui danse') {
  return { id, kind: 'gif', site: 'Tenor', title, text: '', thumbnailUrl: 'https://media.tenor.com/x.png', url };
}

function gifAttachment(id, name = 'réaction.gif') {
  return { id, kind: 'gif', name, url: `https://cdn.discordapp.com/attachments/c1/${id}/${name}?ex=1`, size: 10, durationSec: null };
}

function msg(overrides = {}) {
  return {
    id: 'm1',
    channelId: 'c1',
    channelName: 'general',
    authorId: '1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: '',
    ts: T0,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    ...overrides,
  };
}

function withStore(fn) {
  const dir = tempDir('nep-');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(createStore({ dataDir: dir }), dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

// --- pure collection ---------------------------------------------------------

test('collectGifItems: gif embeds and gif attachments, the message\'s own then its forwards', () => {
  const items = collectGifItems(
    msg({
      id: 'm7',
      channelId: 'c3',
      attachments: [gifAttachment('a1'), { id: 'a2', kind: 'image', name: 'p.png', url: 'https://cdn/p.png' }],
      links: [gifLink('m7#e0'), { id: 'link:1', kind: 'link', site: 'example.org', title: 'Page', url: 'https://example.org' }],
      forwarded: [{ content: '', attachments: [gifAttachment('fa1', 'ωμέγα.gif')], links: [gifLink('fwd#e0', GIPHY, '')] }],
    }),
  );
  assert.deepEqual(items, [
    { key: 'a1', kind: 'attachment', url: gifAttachment('a1').url, name: 'réaction.gif', itemId: 'a1', messageId: 'm7', channelId: 'c3' },
    { key: 'm7#e0', kind: 'link', url: TENOR, site: 'Tenor', name: 'Chat qui danse', itemId: 'm7#e0', messageId: 'm7', channelId: 'c3' },
    { key: 'fa1', kind: 'attachment', url: gifAttachment('fa1', 'ωμέγα.gif').url, name: 'ωμέγα.gif', itemId: 'fa1', messageId: 'm7', channelId: 'c3' },
    { key: 'fwd#e0', kind: 'link', url: GIPHY, site: 'Tenor', itemId: 'fwd#e0', messageId: 'm7', channelId: 'c3' },
  ]);
});

test('collectGifItems: a gif embed of a Discord CDN link is not a library item (its signed URL expires)', () => {
  const cdn = 'https://cdn.discordapp.com/attachments/1/2/loop.gif?ex=1&is=2&hm=3';
  const items = collectGifItems(msg({ links: [gifLink('m1#e0', cdn), gifLink('m1#e1', 'https://klipy.com/gifs/dancing-cat')] }));
  assert.deepEqual(items.map((item) => item.url), ['https://klipy.com/gifs/dancing-cat']);
});

test('collectGifItems: items without a url or an id are skipped; no message -> []', () => {
  assert.deepEqual(collectGifItems(msg({ links: [{ ...gifLink('e0'), url: null }], attachments: [{ ...gifAttachment('a1'), id: null }] })), []);
  assert.deepEqual(collectGifItems(null), []);
});

// --- pure merge and ranking --------------------------------------------------

test('mergeGifs: members only, one count per gif per message, handles assigned once', () => {
  const { gifs, counted } = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1'), gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + 1, self: true, attachments: [gifAttachment('a9')] }),
    msg({ id: 'm3', ts: T0 + 2, bot: true, links: [gifLink('m3#e0')] }),
    msg({ id: 'm4', ts: T0 + 3, links: [gifLink('m4#e0')] }),
  ]);
  assert.equal(counted, 2);
  assert.equal(gifs.nextId, 3);
  assert.deepEqual(Object.keys(gifs.entries), ['a1', 'm4#e0']);
  assert.equal(gifs.entries.a1.id, 'g1');
  assert.equal(gifs.entries.a1.count, 1);
  assert.equal(gifs.entries['m4#e0'].id, 'g2');
  assert.equal(gifs.entries['m4#e0'].firstSeen, T0 + 3);
  assert.equal(gifs.backfill, null);
});

test('mergeGifs: handles are stable across merges; a reposted link counts on its first entry', () => {
  const first = mergeGifs(undefined, [msg({ id: 'm1', ts: T0, links: [gifLink('m1#e0')] })]).gifs;
  const second = mergeGifs(first, [
    msg({ id: 'm2', channelId: 'c2', ts: T0 + DAY, links: [gifLink('m2#e0')] }),
    msg({ id: 'm3', ts: T0 + 2 * DAY, links: [gifLink('m3#e0', GIPHY)] }),
  ]).gifs;
  assert.deepEqual(Object.keys(second.entries).sort(), ['m1#e0', 'm3#e0']);
  const tenor = second.entries['m1#e0'];
  assert.equal(tenor.id, 'g1');
  assert.equal(tenor.count, 2);
  assert.equal(tenor.last, T0 + DAY);
  assert.equal(tenor.firstSeen, T0);
  assert.equal(tenor.messageId, 'm2');
  assert.equal(tenor.channelId, 'c2');
  assert.equal(second.entries['m3#e0'].id, 'g2');
  assert.equal(first.entries['m1#e0'].count, 1, 'the input is never mutated');
});

test('mergeGifs: an older use counts but never moves last or the message pointer back', () => {
  const first = mergeGifs(undefined, [msg({ id: 'm5', ts: T0 + DAY, attachments: [gifAttachment('a1')] })]).gifs;
  const second = mergeGifs(first, [msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] })]).gifs;
  assert.equal(second.entries.a1.count, 2);
  assert.equal(second.entries.a1.last, T0 + DAY);
  assert.equal(second.entries.a1.messageId, 'm5');
  assert.equal(second.entries.a1.firstSeen, T0);
});

test('mergeGifs: past storeMax the lowest-ranked are evicted and their handles never reused', () => {
  let gifs = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + DAY, attachments: [gifAttachment('a2')] }),
    msg({ id: 'm3', ts: T0 + DAY, attachments: [gifAttachment('a2')] }),
  ]).gifs;
  gifs = mergeGifs(gifs, [msg({ id: 'm4', ts: T0 + 2 * DAY, attachments: [gifAttachment('a3')] })], { storeMax: 2, halfLifeDays: 30 }).gifs;
  assert.deepEqual(Object.keys(gifs.entries).sort(), ['a2', 'a3']);
  gifs = mergeGifs(gifs, [msg({ id: 'm5', ts: T0 + 3 * DAY, attachments: [gifAttachment('a4')] })]).gifs;
  assert.equal(gifs.entries.a4.id, 'g4');
});

test('rankGifs: count and recency, best first; findGif by handle', () => {
  const { gifs } = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm3', ts: T0 + DAY, links: [gifLink('m3#e0')] }),
  ]);
  assert.deepEqual(rankGifs(gifs, 30).map((entry) => entry.key), ['a1', 'm3#e0']);
  assert.deepEqual(rankGifs(gifs, 0.01).map((entry) => entry.key), ['m3#e0', 'a1']);
  assert.equal('weight' in rankGifs(gifs, 30)[0], false);
  assert.equal(findGif(gifs, 'G2').key, 'm3#e0');
  assert.equal(findGif(gifs, 'g99'), null);
  assert.equal(findGif(gifs, 'cat'), null);
});

test('resetGifCounts: every entry kept with count 0, handles, last and nextId untouched; never mutates', () => {
  const { gifs } = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + DAY, links: [gifLink('m2#e0')] }),
  ]);
  const reset = resetGifCounts({ ...gifs, backfill: { at: '2026-09-30T00:00:00.000Z', channels: 1, messages: 2 } });
  assert.deepEqual(Object.keys(reset.entries), ['a1', 'm2#e0']);
  assert.deepEqual(Object.values(reset.entries).map((entry) => entry.count), [0, 0]);
  assert.equal(reset.entries.a1.id, 'g1');
  assert.equal(reset.entries['m2#e0'].id, 'g2');
  assert.equal(reset.entries['m2#e0'].last, T0 + DAY);
  assert.equal(reset.nextId, 3);
  assert.equal(reset.backfill.at, '2026-09-30T00:00:00.000Z');
  assert.equal(gifs.entries.a1.count, 1, 'the input is never mutated');
  assert.deepEqual(resetGifCounts(null), { nextId: 1, entries: {}, backfill: null });
});

test('mergeGifs: a reset entry seen again keeps its handle and counts afresh', () => {
  const first = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0, attachments: [gifAttachment('a1')] }),
  ]).gifs;
  const { gifs, counted } = mergeGifs(resetGifCounts(first), [msg({ id: 'm7', channelId: 'c2', ts: T0 + DAY, attachments: [gifAttachment('a1')] })]);
  assert.equal(counted, 1);
  assert.equal(gifs.entries.a1.id, 'g1');
  assert.equal(gifs.entries.a1.count, 1);
  assert.equal(gifs.entries.a1.last, T0 + DAY);
  assert.equal(gifs.entries.a1.messageId, 'm7');
  assert.equal(gifs.entries.a1.channelId, 'c2');
  assert.equal(gifs.nextId, 2, 'no new handle');
});

test('mergeGifs: a reset link entry is matched by url under a new embed id and keeps its handle', () => {
  const first = mergeGifs(undefined, [msg({ id: 'm1', ts: T0, links: [gifLink('m1#e0')] })]).gifs;
  const { gifs } = mergeGifs(resetGifCounts(first), [msg({ id: 'm9', ts: T0 + DAY, links: [gifLink('m9#e0')] })]);
  assert.deepEqual(Object.keys(gifs.entries), ['m1#e0']);
  assert.equal(gifs.entries['m1#e0'].id, 'g1');
  assert.equal(gifs.entries['m1#e0'].count, 1);
  assert.equal(gifs.entries['m1#e0'].messageId, 'm9');
  assert.equal(gifs.nextId, 2);
});

test('rankGifs: a GIF posted once yesterday outranks one posted seven times three years ago', () => {
  const now = T0 + 3 * 365 * DAY;
  const oldPosts = Array.from({ length: 7 }, (_, i) => msg({ id: `o${i}`, ts: T0 + i * DAY, attachments: [gifAttachment('old')] }));
  const { gifs } = mergeGifs(undefined, [...oldPosts, msg({ id: 'n1', ts: now - DAY, attachments: [gifAttachment('new')] })]);
  assert.equal(gifs.entries.old.count, 7);
  assert.equal(gifs.entries.new.count, 1);
  assert.deepEqual(rankGifs(gifs, 30).map((entry) => entry.key), ['new', 'old']);
});

test('rankGifs: a zero count ranks below any positive count, however recent', () => {
  const old = mergeGifs(undefined, [msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] })]).gifs;
  const recent = mergeGifs(old, [msg({ id: 'm2', ts: T0 + 400 * DAY, attachments: [gifAttachment('a2')] })]).gifs;
  const library = { ...recent, entries: { ...recent.entries, a2: { ...recent.entries.a2, count: 0 } } };
  assert.deepEqual(rankGifs(library, 30).map((entry) => entry.key), ['a1', 'a2']);
  assert.deepEqual(rankGifs(library, 0.01).map((entry) => entry.key), ['a1', 'a2']);
  assert.deepEqual(rankGifs(library).map((entry) => entry.key), ['a1', 'a2']);
});

test('mergeGifs: past storeMax zero-count entries are evicted first, handles never reused', () => {
  const first = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0 + 5 * DAY, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + 6 * DAY, attachments: [gifAttachment('a2')] }),
  ]).gifs;
  const { gifs } = mergeGifs(
    resetGifCounts(first),
    [
      msg({ id: 'm3', ts: T0, attachments: [gifAttachment('a3')] }),
      msg({ id: 'm4', ts: T0 + DAY, attachments: [gifAttachment('a1')] }),
    ],
    { storeMax: 2, halfLifeDays: 30 },
  );
  assert.deepEqual(Object.keys(gifs.entries).sort(), ['a1', 'a3'], 'the zero-count a2 goes, though its last is the newest');
  assert.equal(gifs.entries.a1.id, 'g1');
  assert.equal(gifs.entries.a3.id, 'g3');
  const again = mergeGifs(gifs, [msg({ id: 'm5', ts: T0 + 7 * DAY, attachments: [gifAttachment('a2')] })]).gifs;
  assert.equal(again.entries.a2.id, 'g4', 'an evicted handle is never reused');
});

test('normalizeGifs: garbage in -> the empty library; broken entries dropped; bad handles reassigned', () => {
  assert.deepEqual(normalizeGifs(null), { nextId: 1, entries: {}, backfill: null });
  assert.deepEqual(normalizeGifs([1, 2]), { nextId: 1, entries: {}, backfill: null });
  const out = normalizeGifs({
    nextId: 2,
    entries: {
      a: { id: 'g5', kind: 'link', url: TENOR, count: 2, last: T0 },
      b: { id: 'g5', kind: 'attachment', url: 'https://cdn/x.gif', count: 1 },
      c: { id: 'g1', kind: 'video', url: TENOR, count: 1 },
      d: { id: 'g2', kind: 'link', url: '', count: 1 },
      e: { id: 'g3', kind: 'link', url: GIPHY, count: -1 },
      z: { id: 'g4', kind: 'link', url: GIPHY, count: 0, last: T0 },
      f: 'nope',
    },
    backfill: { at: '2026-09-30T00:00:00.000Z', channels: 2.7, messages: -1 },
  });
  assert.deepEqual(Object.keys(out.entries), ['a', 'b', 'z']);
  assert.equal(out.entries.z.count, 0, 'a reset entry (count 0) is kept');
  assert.equal(out.entries.z.id, 'g4');
  assert.equal(out.entries.a.id, 'g5');
  assert.equal(out.entries.a.itemId, 'a');
  assert.equal(out.entries.a.firstSeen, T0);
  assert.equal(out.entries.b.id, 'g6');
  assert.equal(out.entries.b.last, 0);
  assert.equal(out.nextId, 7);
  assert.deepEqual(out.backfill, { at: '2026-09-30T00:00:00.000Z', channels: 2, messages: 0 });
});

// --- storage -----------------------------------------------------------------

test('store.recordGifs: persists gifs.json; getGifs/findGif read it back after a restart', () => {
  withStore((store, dir) => {
    assert.deepEqual(store.getGifs('g1'), { nextId: 1, entries: {}, backfill: null });
    assert.equal(store.recordGifs('g1', [msg({ self: true, links: [gifLink('m1#e0')] })]), 0);
    store.flush();
    assert.equal(fs.existsSync(path.join(dir, 'guilds', 'g1', 'gifs.json')), false, 'nothing counted, nothing written');

    assert.equal(store.recordGifs('g1', [msg({ links: [gifLink('m1#e0')] })], { storeMax: 300 }), 1);
    store.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', 'g1', 'gifs.json'), 'utf8'));
    assert.equal(onDisk.nextId, 2);
    assert.equal(onDisk.entries['m1#e0'].id, 'g1');

    const reopened = createStore({ dataDir: dir });
    assert.equal(reopened.findGif('g1', 'g1').url, TENOR);
    assert.equal(reopened.findGif('g1', 'g2'), null);
  });
});

test('store.getGifs: a hand-broken file is normalised on read, never wiped on disk by reading', () => {
  withStore((store, dir) => {
    const file = path.join(dir, 'guilds', 'g1', 'gifs.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = { entries: { a: { kind: 'link', url: TENOR, count: 3, last: T0 } } };
    fs.writeFileSync(file, JSON.stringify(raw));
    const gifs = store.getGifs('g1');
    assert.equal(gifs.entries.a.id, 'g1');
    assert.equal(gifs.nextId, 2);
    store.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), raw);
  });
});

test('markOwnGif: stamps ownLast and counts ownUses on the entry; an unknown key changes nothing; never mutates', () => {
  const { gifs } = mergeGifs(null, [msg({ links: [gifLink('m1#e0')] })]);
  const once = markOwnGif(gifs, 'm1#e0', T0 + DAY);
  assert.equal(once.marked, true);
  assert.equal(once.gifs.entries['m1#e0'].ownLast, T0 + DAY);
  assert.equal(once.gifs.entries['m1#e0'].ownUses, 1);
  assert.equal(once.gifs.entries['m1#e0'].count, 1, 'the members\' count is not touched');
  assert.equal('ownLast' in gifs.entries['m1#e0'], false);
  const twice = markOwnGif(once.gifs, 'm1#e0', T0 + 2 * DAY);
  assert.equal(twice.gifs.entries['m1#e0'].ownLast, T0 + 2 * DAY);
  assert.equal(twice.gifs.entries['m1#e0'].ownUses, 2);
  const unknown = markOwnGif(gifs, 'nope', T0);
  assert.equal(unknown.marked, false);
  assert.deepEqual(unknown.gifs, normalizeGifs(gifs));
});

test('normalizeGifs: ownLast/ownUses survive a member\'s use and a recount; bad values are dropped', () => {
  const { gifs } = mergeGifs(null, [msg({ links: [gifLink('m1#e0')] })]);
  const marked = markOwnGif(gifs, 'm1#e0', T0 + DAY).gifs;
  const again = mergeGifs(marked, [msg({ id: 'm2', ts: T0 + 2 * DAY, links: [gifLink('m2#e0')] })]).gifs;
  assert.equal(again.entries['m1#e0'].count, 2);
  assert.equal(again.entries['m1#e0'].ownLast, T0 + DAY);
  assert.equal(again.entries['m1#e0'].ownUses, 1);
  const reset = resetGifCounts(again);
  assert.equal(reset.entries['m1#e0'].ownLast, T0 + DAY);
  assert.equal(reset.entries['m1#e0'].ownUses, 1);
  const broken = normalizeGifs({ entries: { a: { kind: 'link', url: TENOR, count: 1, last: T0, ownLast: 'x', ownUses: -3 } } });
  assert.equal('ownLast' in broken.entries.a, false);
  assert.equal('ownUses' in broken.entries.a, false);
  const fractional = normalizeGifs({ entries: { a: { kind: 'link', url: TENOR, count: 1, last: T0, ownLast: T0, ownUses: 2.7 } } });
  assert.equal(fractional.entries.a.ownUses, 2);
});

test('store.recordOwnGif: persists the stamp; an unknown key writes nothing', () => {
  withStore((store, dir) => {
    assert.equal(store.recordOwnGif('g1', 'm1#e0', T0), false);
    store.flush();
    assert.equal(fs.existsSync(path.join(dir, 'guilds', 'g1', 'gifs.json')), false, 'nothing marked, nothing written');
    store.recordGifs('g1', [msg({ links: [gifLink('m1#e0')] })]);
    assert.equal(store.recordOwnGif('g1', 'm1#e0', T0 + DAY), true);
    store.flush();
    const reopened = createStore({ dataDir: dir });
    const entry = reopened.findGif('g1', 'g1');
    assert.equal(entry.ownLast, T0 + DAY);
    assert.equal(entry.ownUses, 1);
  });
});

// --- the live pipeline -------------------------------------------------------

function hotFor(features = {}, gifs = undefined) {
  return {
    config: {
      bot: { timezone: 'UTC' },
      features,
      context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
      memory: { batchMessages: 4 },
      ...(gifs ? { gifs } : {}),
    },
    prompts: { labels },
  };
}

test('observe: a member\'s gif joins the library with its url; the buffer still keeps no url', async () => {
  await withStore(async (store) => {
    const updater = createMemoryUpdater({ hot: hotFor(), store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    const { logs } = await withCapturedLogs(() => updater.observe('g1', msg({ links: [gifLink('m1#e0')] })));
    assert.equal(store.findGif('g1', 'g1').url, TENOR);
    assert.equal('url' in store.getBuffer('g1')[0].links[0], false);
    const line = logs.find((l) => l.msg === 'memory: gifs recorded');
    assert.equal(line.gifs, 1);
    assert.equal(JSON.stringify(line).includes('tenor'), false);
  });
});

test('observe: features.gifs false, a private chat, the persona and paused never feed the library', () => {
  withStore((store) => {
    const off = createMemoryUpdater({ hot: hotFor({ gifs: false }), store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    off.observe('g1', msg({ links: [gifLink('m1#e0')] }));
    const on = createMemoryUpdater({ hot: hotFor(), store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    on.observe('g1', msg({ id: 'm2', links: [gifLink('m2#e0')] }), { private: '1' });
    on.observe('g1', msg({ id: 'm3', self: true, links: [gifLink('m3#e0')] }));
    store.state.data.paused = true;
    on.observe('g1', msg({ id: 'm4', links: [gifLink('m4#e0')] }));
    assert.deepEqual(store.getGifs('g1').entries, {});
  });
});

test('observe: gifs.storeMax caps the library', () => {
  withStore((store) => {
    const updater = createMemoryUpdater({ hot: hotFor({}, { storeMax: 1, halfLifeDays: 30 }), store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    updater.observe('g1', msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }));
    updater.observe('g1', msg({ id: 'm2', ts: T0 + DAY, attachments: [gifAttachment('a2')] }));
    assert.deepEqual(Object.keys(store.getGifs('g1').entries), ['a2']);
  });
});

// --- the <gif> tag -----------------------------------------------------------

test('parseOutput: <gif> with and without reply', () => {
  assert.deepEqual(parseOutput('<gif>g12</gif>').gif, { id: 'g12', replyTo: null });
  assert.deepEqual(parseOutput('<gif reply="#87"> G012 </gif>').gif, { id: 'g12', replyTo: 87 });
});

test('parseOutput: one <gif> per turn -- the first valid one; an invalid body is ignored', () => {
  assert.deepEqual(parseOutput('<gif>cat</gif><gif>g3</gif><gif>g4</gif>').gif, { id: 'g3', replyTo: null });
});

test('parseOutput: a <gif> alone is not silence; an invalid one alone is', () => {
  const alone = parseOutput('<gif>g1</gif>');
  assert.equal(alone.skip, false);
  assert.deepEqual(alone.messages, []);
  const bad = parseOutput('<gif>γάτα</gif>');
  assert.equal(bad.skip, true);
  assert.equal(bad.gif, null);
  assert.deepEqual(bad.messages, []);
});

// --- the poster --------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function rawMessage(id, { attachments = new Map(), messageSnapshots } = {}) {
  return {
    id,
    channelId: 'c1',
    author: { id: 'u1', bot: false, globalName: 'Zoé', username: 'Zoé' },
    member: { displayName: 'Zoé' },
    cleanContent: 'hey',
    createdTimestamp: NOW - 1000,
    reference: null,
    attachments,
    stickers: new Map(),
    ...(messageSnapshots ? { messageSnapshots } : {}),
  };
}

function trigger(raw) {
  return { id: raw.id, channelId: 'c1', authorId: 'u1', authorName: 'Zoé', self: false, bot: false, content: 'hey', ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [] };
}

function fakeChannel({ id = 'c1', historyMessages = [], fetchFails = false } = {}) {
  const sent = [];
  const fetched = [];
  return {
    id,
    name: 'general',
    guild: { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } },
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => {},
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${sent.length}` };
    },
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.map((m) => [m.id, m]));
        fetched.push(arg);
        if (fetchFails) throw new Error('Unknown Message');
        const target = historyMessages.find((m) => m.id === arg);
        if (!target) throw new Error('Unknown Message');
        return target;
      },
    },
    sent,
    fetched,
  };
}

function fakeHot(features = {}, config = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '' },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 0 },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 1, betweenMessagesMs: [0, 0] },
      features: { typingSimulation: false, ...features },
      media: { maxPerTurn: 0, filePreviewChars: 500 },
      ...config,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat.',
      'character-card': 'Terse.',
      format: 'Use tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump in.',
      initiate: 'Start a topic.',
      labels,
    },
  };
}

function fakeLlm(text) {
  return { complete: async () => ({ text, usage: {}, estimated: 10 }) };
}

function calibrator() {
  return { ratio: 1, apply: (n) => n, observe: () => {} };
}

/** A real store seeded with one link gif (g1, from m-old in c1) and one attached gif (g2, from m-att in c2). */
function seedLibrary(store) {
  store.recordGifs('g1', [
    msg({ id: 'm-old', channelId: 'c1', ts: NOW - DAY, links: [gifLink('m-old#e0')] }),
    msg({ id: 'm-att', channelId: 'c2', ts: NOW - DAY, attachments: [gifAttachment('att1')] }),
  ]);
}

async function runGifTurn({ output, features = {}, config = {}, clientChannels = {}, channelOpts = {}, prepare, triggerKind = 'mention' } = {}) {
  return withStore(async (store) => {
    seedLibrary(store);
    if (prepare) prepare(store);
    const raw = rawMessage('m1');
    const channel = fakeChannel({ historyMessages: [raw], ...channelOpts });
    const client = {
      user: { id: 'self-id', username: 'Bot' },
      channels: {
        fetch: async (id) => {
          if (!clientChannels[id]) throw new Error('Unknown Channel');
          return clientChannels[id];
        },
      },
    };
    const turns = createTurnRunner({ discord: DISCORD, createPort: createDiscordAdapter, hot: fakeHot(features, config), store, llm: fakeLlm(output), calibrator: calibrator(), client, now: () => NOW });
    const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: trigger(raw), triggerKind }));
    return { result, logs, channel, state: store.state.data, gifs: store.getGifs('g1') };
  });
}

test('turn <gif>: a link handle sends the stored url after the messages, as a reply', async () => {
  const { result, channel, state } = await runGifTurn({ output: '<msg>ha</msg><gif reply="#1">g1</gif>' });
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[0].content, 'ha');
  assert.equal(channel.sent[1].content, TENOR);
  assert.equal(channel.sent[1].reply.messageReference, 'm1');
  assert.deepEqual(channel.sent[1].allowedMentions, { parse: [] });
  assert.equal(state.gifCount, 1);
  assert.equal(state.gifDay, '2026-09-20');
});

test('turn <gif>: a sent gif stamps ownLast and ownUses on its library entry', async () => {
  const { gifs } = await runGifTurn({ output: '<msg>ha</msg><gif>g1</gif>' });
  assert.equal(gifs.entries['m-old#e0'].ownLast, NOW);
  assert.equal(gifs.entries['m-old#e0'].ownUses, 1);
  assert.equal(gifs.entries['m-old#e0'].count, 1, 'the members\' count is not touched');
  assert.equal('ownLast' in gifs.entries.att1, false);
});

test('turn <gif>: a gif alone is a turn; a follow-up never replies', async () => {
  const withReply = await runGifTurn({ output: '<gif reply="#1">g1</gif>' });
  assert.equal(withReply.result.outcome, 'spoke');
  assert.equal(withReply.channel.sent.length, 1);
  assert.equal(withReply.channel.sent[0].reply.messageReference, 'm1');
  const followUp = await runGifTurn({ output: '<gif reply="#1">g1</gif>', triggerKind: 'followUp' });
  assert.equal(followUp.channel.sent.length, 1);
  assert.equal(followUp.channel.sent[0].reply, undefined);
});

test('turn <gif>: an attachment handle re-fetches its message and sends the fresh url', async () => {
  const fresh = 'https://cdn.discordapp.com/attachments/c2/att1/r%C3%A9action.gif?ex=fresh';
  const original = rawMessage('m-att', { attachments: new Map([['att1', { id: 'att1', url: fresh }]]) });
  const source = fakeChannel({ id: 'c2', historyMessages: [original] });
  const { channel, logs } = await runGifTurn({ output: '<gif>g2</gif>', clientChannels: { c2: source } });
  assert.deepEqual(source.fetched, ['m-att']);
  assert.equal(channel.sent[0].content, fresh);
  const line = logs.find((l) => l.msg === 'turn: gif sent');
  assert.equal(line.fresh, true);
  assert.equal(line.gif, 'g2');
});

test('turn <gif>: an attachment in a forwarded snapshot is found too', async () => {
  const fresh = 'https://cdn.discordapp.com/attachments/c2/att1/x.gif?ex=fwd';
  const snapshots = new Map([['s', { attachments: new Map([['att1', { id: 'att1', url: fresh }]]) }]]);
  const original = rawMessage('m-att', { messageSnapshots: snapshots });
  const source = fakeChannel({ id: 'c2', historyMessages: [original] });
  const { channel } = await runGifTurn({ output: '<gif>g2</gif>', clientChannels: { c2: source } });
  assert.equal(channel.sent[0].content, fresh);
});

test('turn <gif>: a failed re-fetch falls back to the stored url', async () => {
  const { channel, logs, state } = await runGifTurn({ output: '<gif>g2</gif>' });
  assert.equal(channel.sent[0].content, gifAttachment('att1').url);
  assert.ok(logs.find((l) => l.msg === 'turn: gif refetch failed'));
  assert.equal(logs.find((l) => l.msg === 'turn: gif sent').fresh, false);
  assert.equal(state.gifCount, 1);
});

test('turn <gif>: an unknown handle is dropped and logged without a url', async () => {
  const { result, channel, logs } = await runGifTurn({ output: '<msg>ok</msg><gif>g99</gif>' });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(channel.sent.map((p) => p.content), ['ok']);
  const line = logs.find((l) => l.msg === 'turn: gif dropped');
  assert.equal(line.reason, 'unknown');
  const alone = await runGifTurn({ output: '<gif>g99</gif>' });
  assert.equal(alone.result.outcome, 'skip');
  assert.equal(alone.channel.sent.length, 0);
});

test('turn <gif>: features.gifs false ignores the tag', async () => {
  const { result, channel, logs } = await runGifTurn({ output: '<gif>g1</gif>', features: { gifs: false } });
  assert.equal(result.outcome, 'skip');
  assert.equal(channel.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'turn: gif dropped').reason, 'off');
});

test('turn <gif>: gifs.maxPerDay spent today drops it; a new day starts over', async () => {
  const spent = await runGifTurn({
    output: '<gif>g1</gif>',
    config: { gifs: { maxPerDay: 2 } },
    prepare: (store) => Object.assign(store.state.data, { gifDay: '2026-09-20', gifCount: 2 }),
  });
  assert.equal(spent.result.outcome, 'skip');
  assert.equal(spent.channel.sent.length, 0);
  assert.equal(spent.logs.find((l) => l.msg === 'turn: gif dropped').reason, 'daily');

  const yesterday = await runGifTurn({
    output: '<gif>g1</gif>',
    config: { gifs: { maxPerDay: 2 } },
    prepare: (store) => Object.assign(store.state.data, { gifDay: '2026-09-19', gifCount: 2 }),
  });
  assert.equal(yesterday.channel.sent.length, 1);
  assert.equal(yesterday.state.gifDay, '2026-09-20');
  assert.equal(yesterday.state.gifCount, 1);
});

test('turn <gif>: dry-run logs the handle and url, sends nothing, counts nothing', async () => {
  const { result, channel, logs, state } = await runGifTurn({ output: '<gif reply="#1">g1</gif>', features: { dryRun: true } });
  assert.equal(result.dryRun, true);
  assert.equal(channel.sent.length, 0);
  const line = logs.find((l) => l.msg === 'dry-run: would send gif');
  assert.equal(line.gif, 'g1');
  assert.equal(line.url, TENOR);
  assert.equal(line.replyTo, 'm1');
  assert.equal(state.gifCount, undefined);
});

test('turn <gif>: a dry run stamps nothing on the library', async () => {
  const { gifs } = await runGifTurn({ output: '<gif>g1</gif>', features: { dryRun: true } });
  assert.equal('ownLast' in gifs.entries['m-old#e0'], false);
  assert.equal('ownUses' in gifs.entries['m-old#e0'], false);
});

test('turn request: the library reaches the prompt as <gifs> with cached captions, gated by features.gifs', async () => {
  async function requestText(features) {
    return withStore(async (store) => {
      seedLibrary(store);
      store.getMediaCache('g1')['m-old#e0'] = { text: 'a cat dancing', ts: NOW };
      const raw = rawMessage('m1');
      const channel = fakeChannel({ historyMessages: [raw] });
      const seen = [];
      const llm = {
        complete: async (messages) => {
          seen.push(messages);
          return { text: '<skip/>', usage: {}, estimated: 10 };
        },
      };
      const client = { user: { id: 'self-id', username: 'Bot' }, channels: { fetch: async () => { throw new Error('Unknown Channel'); } } };
      const turns = createTurnRunner({ discord: DISCORD, createPort: createDiscordAdapter, hot: fakeHot(features), store, llm, calibrator: calibrator(), client, now: () => NOW });
      await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: trigger(raw), triggerKind: 'mention' }));
      return userText(seen[0][1].content);
    });
  }

  const on = await requestText({});
  // Both entries tie on count and date: their order is sortByRank's, not asserted here.
  const block = /<gifs>\n([\s\S]*?)\n<\/gifs>/.exec(on)[1].split('\n');
  assert.equal(block[0], labels.gifs.header);
  assert.deepEqual(block.slice(1).sort(), ['g1 -- a cat dancing', 'g2']);
  assert.ok(on.includes(labels.senses.gifs));
  const off = await requestText({ gifs: false });
  assert.ok(!off.includes('<gifs>'));
  assert.ok(!off.includes(labels.senses.gifs));
});
