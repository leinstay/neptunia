// The media kinds of the media memory tests, each with a line as an interface reports it and a text form told through the one
// writer into `media` (src/memory/db/media-store.ts): fully present, partly present or absent. A Russian word stands
// for each English retelling, which only the fake embedder's concepts can bridge. `shape` gives a kind's items the native
// references of another interface. Synthetic content on a temp database; no model, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecall } from '../../src/behavior/recall-run.ts';
import { snapshotOf } from '../../src/behavior/snapshot.ts';
import { channelPlaceId, dmPlaceId, personId } from '../../src/memory/db/ids.ts';
import { observationOf } from '../../src/memory/db/observe-event.ts';
import { observe } from '../../src/memory/db/observe.ts';
import { dbSettings } from '../../src/memory/db/recall.ts';
import { insertRows } from '../../src/memory/db/rows.ts';
import { dmScope, groupContext, groupScope } from '../../src/memory/db/scope.ts';
import { tellMedia } from '../../src/memory/db/media-store.ts';
import type { MediaOrigin } from '../../src/memory/db/media-store.ts';
import { runMemorySearch } from '../../src/tools/tools.ts';
import { fillEnvAudiences } from './memory-db/audiences.ts';
import { fixture } from './memory-db-recall.ts';
import { labels } from './labels.ts';
import { channel as channelInfo } from './reads-rig.ts';
import type { Row } from '../../src/memory/db/types.ts';

export { fixture };
export type Env = ReturnType<typeof fixture>;
export type Scope = ReturnType<typeof groupScope>;
export type Presence = 'full' | 'part' | 'absent';
export const PRESENCES: ReadonlyArray<Presence> = ['full', 'part', 'absent'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')) as Record<string, object>;

export const NOW = Date.parse('2026-11-05T12:00:00.000Z');
export const AT = Date.parse('2026-11-01T10:00:00.000Z');
export const ALICE = 'u-alice';
export const BOB = 'u-bob';
export const HER = 'u-self';
export const GENERAL = channelPlaceId('discord', 'c1');
export const BOB_DM = dmPlaceId('discord', BOB);
export const BOB_PERSON = personId('discord', BOB);
export const BOB_SCOPE = dmScope(BOB_PERSON, 'discord');
export const GROUP_SCOPE = groupScope('discord');
export const group = groupContext('discord');
export const SETTINGS = { ...dbSettings({})!, candidates: 40, minMeaning: 0.5, recordContext: 0, followMessages: 0 };

/**
 * The labels every read of these tests renders with. A retelling form names its kind, and a kind no model can read says
 * so. `voiceDescribed`, `audioDescribed`, `fileUnreadable` and `stickerUnreadable` are the transcript keys this
 * specification adds to the labels contract.
 */
export const UNREADABLE = 'not readable';
export const LABELS = {
  ...labels,
  transcript: {
    ...labels.transcript,
    image: '<image>',
    imageDescribed: '<image: {text}>',
    gif: '<gif {name}>',
    gifDescribed: '<gif: {text}>',
    video: '<video {name}>',
    videoDescribed: '<video still: {text}>',
    videoWatched: '<video: {text}>',
    voice: '<voice>',
    voiceDescribed: '<voice: {text}>',
    audio: '<audio {name}>',
    audioDescribed: '<audio {name}: {text}>',
    sticker: '<sticker {name}>',
    stickerDescribed: '<sticker {name}: {text}>',
    stickerUnreadable: `[sticker: {name}, ${UNREADABLE}]`,
    link: '<link {title}>',
    linkText: '<link {title}: {text}>',
    file: '<file {name}>',
    filePreview: '<file {name}: {text}>',
    fileUnreadable: `[file: {name}, ${UNREADABLE}]`,
    emojiDescribed: '<emoji {name}: {text}>',
  },
};

export type Item = { id: string; told: string };
/** What the native references of a line's items look like on the interface: the identity, or another interface's shape. */
export type Shape = (id: string) => string;
const SAME: Shape = (id) => id;

/** One kind of media: how a line of it arrives, the text form its items take, and the words that find it. */
export type Kind = {
  name: string;
  /** The kind of the closed list a line of it is stored under. */
  stored: string;
  marker: string;
  /** Two retellings: the first is told when the line is partly described, both when it is fully described. */
  first: { word: string; fragment: string; query: string };
  second: { word: string };
  self?: boolean;
  /** The origin of its text form; null for one the interface's event already brings. */
  origin: MediaOrigin | null;
  /** The message fields of a line, given the two items and whether each is told. */
  message(items: [Item, Item], told: [boolean, boolean]): Row;
};

const attachment =
  (kind: string, name: string, extra: Row = {}) =>
  (item: Item): Row => ({
    id: item.id,
    kind,
    name,
    url: `https://cdn.example.invalid/${encodeURIComponent(item.id)}/${name}`,
    ...extra,
  });

function attachmentKind(
  name: string,
  stored: string,
  marker: string,
  origin: MediaOrigin,
  file: (item: Item) => Row,
  words: { word: string; fragment: string; query: string; second: string }
): Kind {
  return {
    name,
    stored,
    marker,
    origin,
    first: { word: words.word, fragment: words.fragment, query: words.query },
    second: { word: words.second },
    message: (items) => ({ attachments: items.map(file) }),
  };
}

/** Every media kind with a text form: image, gif, video, sticker, voice said and received, audio, link embed, text file, emoji. */
export const KINDS: ReadonlyArray<Kind> = [
  attachmentKind('image', 'image', '<image', 'retelling', attachment('image', 'p.png'), {
    word: 'lighthouse',
    fragment: 'ighthou',
    query: 'маяк',
    second: 'walrus',
  }),
  attachmentKind('gif', 'gif', '<gif', 'retelling', attachment('gif', 'g.gif'), {
    word: 'pirouette',
    fragment: 'iroue',
    query: 'пируэт',
    second: 'trombone',
  }),
  attachmentKind('video', 'video', '<video', 'retelling', attachment('video', 'v.mp4', { durationSec: 12 }), {
    word: 'avalanche',
    fragment: 'valanch',
    query: 'лавина',
    second: 'gondola',
  }),
  {
    name: 'sticker',
    stored: 'sticker',
    marker: '<sticker',
    origin: 'retelling',
    first: { word: 'hedgehog', fragment: 'edgeho', query: 'ёжик' },
    second: { word: 'accordion' },
    message: (items) => ({
      stickers: items.map((item) => ({
        id: item.id,
        name: 'wave',
        format: 'png',
        url: `https://cdn.example.invalid/${encodeURIComponent(item.id)}.png`,
      })),
    }),
  },
  attachmentKind(
    'voice received',
    'voice',
    '<voice',
    'transcript',
    attachment('voice', 'voice-message.ogg', { durationSec: 9 }),
    { word: 'mushrooms', fragment: 'ushroo', query: 'грибы', second: 'umbrella' }
  ),
  // Her own voice message: its text form is what she voiced; the second item, an image, stays bare.
  {
    name: 'voice said',
    stored: 'voice',
    marker: '<voice',
    self: true,
    origin: 'voiced',
    first: { word: 'cathedral', fragment: 'athedra', query: 'собор' },
    second: { word: 'unused' },
    message: (items) => ({
      attachments: [
        attachment('voice', 'voice-a.ogg', { durationSec: 9 })(items[0]),
        attachment('image', 'p.png')(items[1]),
      ],
    }),
  },
  attachmentKind('audio', 'audio', '<audio', 'transcript', attachment('audio', 'song.mp3', { durationSec: 180 }), {
    word: 'saxophone',
    fragment: 'axophon',
    query: 'саксофон',
    second: 'windmill',
  }),
  // A link embed brings its own title and text in the event, origin `embed`.
  {
    name: 'link',
    stored: 'link',
    marker: '<link',
    origin: null,
    first: { word: 'observatory', fragment: 'bservator', query: 'обсерватория' },
    second: { word: 'toboggan' },
    message: (items, told) => ({
      links: items.map((item, i) => ({
        id: item.id,
        kind: 'link',
        url: `https://site.example.invalid/${encodeURIComponent(item.id)}`,
        site: 'site.example.invalid',
        title: `page ${i}`,
        text: told[i] ? item.told : '',
        thumbnailUrl: null,
      })),
    }),
  },
  attachmentKind('text file', 'text', '<file', 'preview', attachment('text', 'notes.txt'), {
    word: 'marzipan',
    fragment: 'arzipa',
    query: 'марципан',
    second: 'quokka',
  }),
  {
    name: 'emoji',
    stored: 'emoji',
    marker: '<emoji',
    origin: 'retelling',
    first: { word: 'pelican', fragment: 'elica', query: 'пеликан' },
    second: { word: 'zeppelin' },
    message: (items) => ({
      content: 'look <:blob:1> <:wave:2>',
      emojis: items.map((item, i) => ({
        id: item.id,
        name: i === 0 ? 'blob' : 'wave',
        animated: false,
        url: `https://cdn.example.invalid/${encodeURIComponent(item.id)}.webp`,
      })),
    }),
  },
];

export const kindNamed = (name: string): Kind => {
  const kind = KINDS.find((one) => one.name === name);
  assert.ok(kind, name);
  return kind;
};

export const itemsOf = (kind: Kind, native: string, shape: Shape = SAME): [Item, Item] => [
  { id: shape(`${native}-a`), told: `a retelling with a ${kind.first.word} in it` },
  { id: shape(`${native}-b`), told: `a retelling with a ${kind.second.word} in it` },
];

/** The `message.received` event of a line of `kind`. */
export function eventOf(
  kind: Kind,
  native: string,
  told: [boolean, boolean],
  {
    at = AT,
    iface = 'discord',
    shape = SAME,
    conversation = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' },
    author = kind.self ? { id: HER, self: true, name: 'Self' } : { id: ALICE, name: 'Alice' },
  }: { at?: number; iface?: string; shape?: Shape; conversation?: Row; author?: Row } = {}
): Row {
  return {
    iface,
    at,
    conversation,
    message: {
      id: native,
      at,
      content: '',
      author,
      attachments: [],
      links: [],
      stickers: [],
      ...kind.message(itemsOf(kind, native, shape), told),
    },
  };
}

/** Tells a line's item its text form, as the describer's write and the voice operation do. */
export function tell(env: Env, kind: Kind, item: Item, iface = 'discord'): void {
  if (kind.origin === null) return;
  tellMedia(env.handle, { iface, nativeRef: item.id, description: item.told, origin: kind.origin });
}

/** One observed line of `kind` and its text forms: both told (`full`), the first (`part`), none (`absent`). */
export function observeLine(
  env: Env,
  kind: Kind,
  presence: Presence,
  {
    native = 'pic',
    at = AT,
    iface = 'discord',
    shape = SAME,
    conversation,
    author,
  }: { native?: string; at?: number; iface?: string; shape?: Shape; conversation?: Row; author?: Row } = {}
): string {
  const told: [boolean, boolean] = [presence !== 'absent', presence === 'full' && !kind.self];
  const event = eventOf(kind, native, told, {
    at,
    iface,
    shape,
    ...(conversation ? { conversation } : {}),
    ...(author ? { author } : {}),
  });
  const envelope = observationOf(event, { selfId: HER });
  assert.ok(envelope, 'the synthetic event was refused');
  const written = observe(env.handle, envelope, { now: () => at });
  assert.equal(written.ok, true);
  itemsOf(kind, native, shape).forEach((item, i) => {
    if (told[i]) tell(env, kind, item, iface);
  });
  const row = env.db.prepare('SELECT id FROM sources WHERE native_id = ? ORDER BY rowid LIMIT 1').get(native);
  assert.ok(row);
  return String(row.id);
}

/** A DM line of Bob's, under the audience of Bob as a person, which a `dmContext` of him reads. */
export function observeDmLine(env: Env, kind: Kind, presence: Presence = 'full', native = 'secret'): string {
  const source = observeLine(env, kind, presence, {
    native,
    author: kind.self ? { id: HER, self: true, name: 'Self' } : { id: BOB, name: 'Bob' },
    conversation: { id: 'dm-bob', kind: 'dm', chatType: 'dm', partnerId: BOB },
  });
  env.db.prepare('UPDATE sources SET scope_dm = ?, audience_id = NULL WHERE id = ?').run(BOB_PERSON, source);
  fillEnvAudiences(env);
  return source;
}

/** A media row nothing links yet, its description held: what the describer's cache is after the migration. */
export function heldItem(env: Env, nativeRef: string, description: string, kind = 'image'): void {
  env.db
    .prepare(
      `INSERT INTO media (id, kind, native_ref, description, described_at, availability, scope_kind, scope_iface)
       VALUES (?, ?, ?, ?, ?, 'present', 'group', 'discord')`
    )
    .run(`media:held:${nativeRef}`, kind, nativeRef, description, new Date(AT).toISOString());
}

/** What a read gives of a line's media, without what names the row or belongs to its interface. */
export const neutralRows = (rows: ReadonlyArray<Row>): Array<Row> =>
  rows.map((row) => {
    const { url: _url, ...extra } = (row.extra ?? {}) as Row;
    const kept = Object.entries(row).filter(([key]) => !['mediaId', 'nativeRef', 'extra'].includes(key));
    return { ...Object.fromEntries(kept), extra: { ...extra, url: _url === undefined ? undefined : 'x' } };
  });

/** How many times `part` stands in `text`. */
export const countOf = (text: string, part: string): number => text.split(part).length - 1;

/** A line says what it is and what it holds: its markers, the text form of what was told, nothing of what was not. */
export function assertForms(text: string, kind: Kind, presence: Presence): void {
  assert.ok(text.includes(kind.marker), `the line shows the kind marker ${kind.marker}: ${text.slice(0, 300)}`);
  if (presence === 'absent') assert.ok(!text.includes(kind.first.word), 'no text form is invented');
  else assert.ok(text.includes(kind.first.word), `the line shows its first text form: ${text.slice(0, 300)}`);
  if (presence === 'full' && !kind.self) assert.ok(text.includes(kind.second.word), 'and its second');
  if (presence === 'part') assert.ok(!text.includes(kind.second.word), 'the untold item stays bare');
}

// ---------- the turn's reads ----------

export type Found = { quotes?: Array<{ lines: string }>; excerpts?: Array<unknown>; hidden?: boolean };
export type RecallRig = {
  recall: { window(args: Row): Promise<Found>; prefetch(args: Row): Promise<Found | null> };
  args: Row;
  ask: (question: Row) => Promise<string>;
};

/** The recall runner and `memory.search` over the fixture database, in #general (c1). */
export function recallRig(env: Env): RecallRig {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        { id: GENERAL, iface: 'discord', kind: 'channel', native_id: 'c1', scope_kind: 'group', name: 'general' },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const channel = channelInfo('c1', { name: 'general' });
  const snapshot = snapshotOf('g1', { conversations: [channel], groups: [] });
  const config = {
    ...shipped,
    bot: { ...shipped.bot, timezone: 'UTC' },
    features: { ...shipped.features, meaningSearch: false, recall: true },
  };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
  };
  const reads = {
    searchMessages: () => Promise.resolve({ total: 0, hits: [] }),
    searchMembers: () => Promise.resolve({ members: [] }),
    history: () => Promise.resolve({ events: [], complete: true }),
  };
  const llm = { capLeft: () => 100, complete: () => Promise.resolve({ text: '' }) };
  const created = createRecall({
    reads,
    hot: { config, prompts: { 'recall-summary': 'x', labels: LABELS } },
    store,
    llm,
    now: () => NOW,
    memoryDb: { database: () => env.db },
  } as unknown as Parameters<typeof createRecall>[0]);
  const recall = created as unknown as RecallRig['recall'];
  const args = { placeId: 'g1', snapshot, channel, partnerId: null, selfId: 'self', selfName: 'Self', history: [] };
  const ask = async (question: Row): Promise<string> => {
    const result = await runMemorySearch({
      recall: created,
      store,
      config,
      labels: LABELS,
      placeId: 'g1',
      snapshot,
      channel,
      selfId: 'self',
      selfName: 'Self',
      history: [],
      now: NOW,
      args: question,
    });
    return (result as { data?: { text?: string } }).data?.text ?? '';
  };
  return { recall, args, ask };
}
