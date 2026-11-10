// Her memory searches over every media kind as over text (src/memory/db/recall.ts#search and memory.search): a text form is
// stemmed and embedded once on its `media` row, a media hit is one hit per item with its use count and latest visible use, and
// counts only through a link to a message the reader may see. Words, part of a word, meaning, people, place and time, quotes,
// on a line whose text forms are fully present, partly present or absent, and the owner's required cases: a reused item against
// a person's story, a picture-only day, a re-uploaded file, bounded query plans. Synthetic content; a fake embedder; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { search } from '../src/memory/db/recall.ts';
import { dmContext } from '../src/memory/db/scope.ts';
import {
  ALICE,
  AT,
  BOB,
  BOB_DM,
  BOB_PERSON,
  GENERAL,
  KINDS,
  NOW,
  PRESENCES,
  SETTINGS,
  assertForms as checkForms,
  countOf,
  fixture,
  group,
  itemsOf,
  observeDmLine,
  observeLine,
  recallRig,
  tell,
} from './fixtures/media-memory.ts';
import { MODEL, byMeaning, embedLines, embedWords } from './fixtures/media-memory-embed.ts';
import type { Env, Kind, Presence } from './fixtures/media-memory.ts';
import type { Row } from '../src/memory/db/types.ts';

const PLAN = { forms: [] as Array<string>, who: [] as Array<string>, from: null, to: null };
const IMAGE = KINDS[0];
const asked = (env: Env, plan: Partial<typeof PLAN>, ctx: unknown = group, db: unknown = env.db) =>
  search(db, { ctx, plan: { ...PLAN, ...plan }, now: NOW, settings: SETTINGS });
const mediaFor = (env: Env, form: string, ctx: unknown = group) => asked(env, { forms: [form] }, ctx).mediaHits;
const leadsToLine = (hits: ReadonlyArray<{ latest: { messageId: unknown } }>) =>
  hits.some((hit) => hit.latest.messageId === 'pic');

function assertForms(text: string, kind: Kind, presence: Presence) {
  checkForms(text, kind, presence);
}

async function withLine(kind: Kind, presence: Presence, body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    observeLine(env, kind, presence);
    env.stem();
    await body(env);
  } finally {
    env.done();
  }
}

async function withEnv(body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    await body(env);
  } finally {
    env.done();
  }
}

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    const told = presence !== 'absent';

    test(`word search: a word of a ${kind.name}'s text form ${told ? 'finds' : 'finds nothing on'} its item, ${presence}`, () =>
      withLine(kind, presence, (env) => {
        assert.equal(leadsToLine(mediaFor(env, kind.first.word)), told);
        if (presence === 'part') assert.equal(leadsToLine(mediaFor(env, kind.second.word)), false);
      }));

    test(`part of a word: a fragment of a ${kind.name}'s text form ${told ? 'finds' : 'finds nothing on'} its item, ${presence}`, () =>
      withLine(kind, presence, (env) => {
        const hits = mediaFor(env, kind.first.fragment);
        assert.equal(leadsToLine(hits), told);
        if (told) assert.ok(hits[0].streams.includes('trigram'));
      }));

    test(`meaning: a Russian query ${told ? 'reaches' : 'does not reach'} a ${kind.name} with its English text form, ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        await embedLines(env);
        const hits = search(env.db, { ctx: group, ...byMeaning(kind.first.query) }).mediaHits;
        assert.equal(leadsToLine(hits), told);
        if (told) {
          assert.ok(hits[0].streams.includes('meaning'));
          assert.equal(hits[0].latest.ts, AT, 'the hit leads to its message with its date');
          assert.deepEqual(
            hits[0].messages.map((message) => [message.messageId, message.ts]),
            [['pic', AT]]
          );
        }
      }));

    test(`people: the author's lines show a ${kind.name} with its marker and its text form, ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const text = await recallRig(env).ask({ people: kind.self ? 'Self' : 'Alice' });
        assertForms(text, kind, presence);
      }));

    test(`place and time: a sample of the day shows a ${kind.name} with its marker and its text form, ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const text = await recallRig(env).ask({ when: '2026-11-01', channel: 'c1' });
        assertForms(text, kind, presence);
      }));

    test(`memory.search quotes: a ${kind.name} shows its marker and its text form, ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        // An absent text form has no word to be found by: the time stream shows the same bare line.
        const question = told ? { terms: kind.first.word } : { when: '2026-11-01' };
        const text = await recallRig(env).ask(question);
        assertForms(text, kind, presence);
      }));
  }

  if (kind.name !== 'voice said') {
    test(`a line with two of a ${kind.name} shows two markers and one text form when one is told`, () =>
      withLine(kind, 'part', async (env) => {
        const text = await recallRig(env).ask({ when: '2026-11-01' });
        assert.equal(countOf(text, kind.marker), 2, text);
        assert.equal(countOf(text, itemsOf(kind, 'pic')[0].told), 1, text);
      }));
  }

  test(`audience: a DM's ${kind.name} is found from its DM and never from a group, by word, fragment or meaning`, () =>
    withEnv(async (env) => {
      observeDmLine(env, kind);
      env.stem();
      await embedLines(env);
      const partner = dmContext(BOB_PERSON, 'discord', BOB_DM);
      assert.equal(mediaFor(env, kind.first.word, partner)[0]?.latest.messageId, 'secret', 'its own DM finds it');
      assert.deepEqual(mediaFor(env, kind.first.word), []);
      assert.deepEqual(mediaFor(env, kind.first.fragment), []);
      assert.deepEqual(search(env.db, { ctx: group, ...byMeaning(kind.first.query) }).mediaHits, []);
    }));
}

// ---------- one store of a text form ----------

test("a text form is stemmed on its media row: the message's stems and text stay what was written", () =>
  withLine(IMAGE, 'full', (env) => {
    const row = env.db.prepare('SELECT text, stems FROM sources WHERE native_id = ?').get('pic');
    assert.equal(row?.text, '');
    assert.ok(!((row?.stems as string | null) ?? '').includes(IMAGE.first.word));
  }));

test('a text form told after the line was observed is found at once, by a word and by a fragment', () =>
  withEnv((env) => {
    observeLine(env, IMAGE, 'absent');
    env.stem();
    assert.equal(leadsToLine(mediaFor(env, IMAGE.first.word)), false);
    tell(env, IMAGE, itemsOf(IMAGE, 'pic')[0]);
    assert.equal(leadsToLine(mediaFor(env, IMAGE.first.word)), true, 'by a word');
    assert.equal(leadsToLine(mediaFor(env, IMAGE.first.fragment)), true, 'by a fragment');
  }));

/** One line more that shows the same item: another message with the same native reference. */
function reuse(env: Env, native: string, at: number, ref: string, chat?: Row, author?: Row): void {
  const kind: Kind = {
    ...IMAGE,
    message: () => ({ attachments: [{ id: ref, kind: 'image', name: 'p.png', url: 'https://x.invalid/p.png' }] }),
  };
  observeLine(env, kind, 'absent', {
    native,
    at,
    ...(chat ? { chat } : {}),
    ...(author ? { author } : {}),
  });
}

test('an item linked from three messages is one hit with three uses, and its latest', () =>
  withEnv((env) => {
    reuse(env, 'm1', AT, 'same');
    reuse(env, 'm2', AT + 60_000, 'same');
    reuse(env, 'm3', AT + 120_000, 'same');
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse' });
    env.stem();
    const hits = mediaFor(env, 'lighthouse');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].uses, 3);
    assert.deepEqual([hits[0].latest.messageId, hits[0].latest.ts], ['m3', AT + 120_000]);
  }));

test('an item linked from three messages is embedded once', () =>
  withEnv(async (env) => {
    reuse(env, 'm1', AT, 'same');
    reuse(env, 'm2', AT + 60_000, 'same');
    reuse(env, 'm3', AT + 120_000, 'same');
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse' });
    const { asked: texts, embedded } = await embedLines(env);
    assert.equal(embedded, 1);
    assert.deepEqual(texts, ['a lighthouse']);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM vectors').get()?.n, 1);
    assert.equal((await embedLines(env)).embedded, 0, 'nothing changed: no request');
  }));

test('a changed text form replaces the vector of its row', () =>
  withEnv(async (env) => {
    reuse(env, 'm1', AT, 'same');
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse' });
    await embedLines(env);
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse and a walrus' });
    assert.deepEqual((await embedLines(env)).asked, ['a lighthouse and a walrus']);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM vectors').get()?.n, 1);
  }));

test('a media-only message has no vector of its own, and a bare item no vector at all', () =>
  withEnv(async (env) => {
    observeLine(env, IMAGE, 'part');
    await embedLines(env);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE source_rowid IS NOT NULL').get()?.n, 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM vectors').get()?.n, 1, 'the told item, not the bare one');
  }));

test('a reader sees the uses it may see: a DM use is no count and no date for a group', () =>
  withEnv(async (env) => {
    reuse(env, 'public', AT, 'same');
    reuse(
      env,
      'private',
      AT + 60_000,
      'same',
      { id: 'dm-bob', kind: 'dm', chatType: 'dm', partnerId: BOB },
      {
        id: BOB,
        name: 'Bob',
      }
    );
    // Corrected by the implementer: the DM line is put under Bob as a person, as observeDmLine does, and his DM also reads
    // the group's use, so his reader sees two uses, the latest his own.
    env.db.prepare("UPDATE sources SET scope_dm = ?, audience_id = NULL WHERE native_id = 'private'").run(BOB_PERSON);
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse' });
    env.stem();
    await embedLines(env);
    const [word] = mediaFor(env, 'lighthouse');
    assert.deepEqual([word.uses, word.latest.messageId, word.latest.ts], [1, 'public', AT]);
    const [meant] = search(env.db, { ctx: group, ...byMeaning('маяк') }).mediaHits;
    assert.deepEqual([meant.uses, meant.latest.messageId], [1, 'public']);
    assert.ok(!JSON.stringify(word.messages).includes('private'));
    const [own] = mediaFor(env, 'lighthouse', dmContext(BOB_PERSON, 'discord', BOB_DM));
    assert.deepEqual([own.uses, own.latest.messageId], [2, 'private']);
  }));

test('a retired or deleted use stops counting, and an item with no use left is no hit', () =>
  withEnv((env) => {
    reuse(env, 'm1', AT, 'same');
    reuse(env, 'm2', AT + 60_000, 'same');
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse' });
    env.stem();
    env.deleted('m2', AT + 120_000);
    const [left] = mediaFor(env, 'lighthouse');
    assert.deepEqual([left.uses, left.latest.messageId], [1, 'm1']);
    env.deleted('m1', AT + 180_000);
    assert.deepEqual(mediaFor(env, 'lighthouse'), []);
  }));

// ---------- the owner's required cases ----------

/** Links one item to `count` messages by a stranger, in one transaction: rows, not behaviour under test. */
function floodItem(env: Env, count: number) {
  const place = channelPlaceId('discord', 'c1');
  observeLine(env, IMAGE, 'absent', { native: 'seed' });
  tell(env, IMAGE, { id: 'seed-a', told: 'a lighthouse dancing, a reaction gif about a lighthouse' });
  const media = env.db.prepare('SELECT id FROM media WHERE native_ref = ?').get('seed-a')?.id;
  assert.ok(media);
  env.db.exec('BEGIN');
  const source = env.db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, direct,
     scope_kind, scope_iface, audience_id) VALUES (?, 'seen', 'discord', ?, 1, ?, 'discord:u-stranger', ?, ?, '', 0, 'group', 'discord', 'aud:group:discord')`
  );
  const link = env.db.prepare(
    "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, ?)"
  );
  for (let i = 0; i < count; i += 1) {
    const id = `src:discord:flood-${i}:1:seen`;
    const at = new Date(AT - i * 1000).toISOString();
    source.run(id, `flood-${i}`, place, at, at);
    link.run(id, media);
  }
  env.db.exec('COMMIT');
}

const STORY = 'my trip to the lighthouse at the end of the bay was the best week of my life';

test('one item linked 10000 times against one text story, asked by the author, returns the story', () =>
  withEnv(async (env) => {
    floodItem(env, 10_000);
    env.say({ native: 'story', at: AT - 5 * 86_400_000, text: STORY, place: GENERAL, author: ALICE });
    // Corrected by the implementer: the seed line is Alice's, so its observation already made her account and a second insert fails.
    env.stem();
    const found = asked(env, { forms: ['lighthouse'], who: ['Alice'] });
    assert.equal(found.hits[0].messageId, 'story', 'the story comes first');
    assert.equal(found.mediaHits.length, 1, 'the item is one hit');
    assert.ok(found.mediaHits[0].uses > 10_000 - 1, 'with its use count');
    assert.ok(found.mediaHits[0].messages.length <= 20, 'and a few of its messages, never all of them');
    const lines = found.windows.flatMap((window) => window.messages);
    assert.ok(
      lines.filter((line) => String(line.id).startsWith('flood-')).length <= 10,
      'not hundreds of its messages'
    );
    const text = await recallRig(env).ask({ terms: 'lighthouse', people: 'Alice' });
    assert.ok(text.includes(STORY), 'the answer quotes the story');
    assert.ok(countOf(text, 'a reaction gif') <= 1, 'and the item once');
  }));

test('a picture-only day answers from its messages and their media', () =>
  withEnv(async (env) => {
    for (let i = 0; i < 4; i += 1) observeLine(env, IMAGE, 'part', { native: `day-${i}`, at: AT + i * 60_000 });
    env.stem();
    const text = await recallRig(env).ask({ when: '2026-11-01', channel: 'c1' });
    assert.ok(text.includes(IMAGE.first.word) === true, text);
    assert.equal(countOf(text, IMAGE.marker) >= 4, true, 'every picture of the day with its marker');
  }));

test('a Russian question finds an English description, and the hit leads to its messages with dates', () =>
  withEnv(async (env) => {
    reuse(env, 'first', AT, 'same');
    reuse(env, 'later', AT + 86_400_000, 'same');
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse on a cliff' });
    await embedLines(env);
    const [hit] = search(env.db, { ctx: group, ...byMeaning('маяк') }).mediaHits;
    assert.deepEqual(hit.messages.map((message) => [message.messageId, message.ts]).sort(), [
      ['first', AT],
      ['later', AT + 86_400_000],
    ]);
  }));

test('text and pictures answer one question by meaning', () =>
  withEnv(async (env) => {
    reuse(env, 'photo', AT, 'same');
    tell(env, IMAGE, { id: 'same', told: 'a lighthouse on a cliff' });
    env.say({ native: 'words', at: AT + 60_000, text: 'the lighthouse was closed', place: GENERAL });
    env.stem();
    await embedLines(env);
    env.vector('words', [...byMeaning('маяк').vector]);
    const found = search(env.db, { ctx: group, ...byMeaning('маяк') });
    assert.deepEqual(
      found.hits.map((hit) => hit.messageId),
      ['words']
    );
    assert.equal(found.mediaHits[0].latest.messageId, 'photo');
  }));

test('a re-uploaded file with the same bytes groups with its first by sha1', () =>
  withEnv((env) => {
    reuse(env, 'm1', AT, 'upload-1');
    reuse(env, 'm2', AT + 60_000, 'upload-2');
    tell(env, IMAGE, { id: 'upload-1', told: 'a lighthouse' });
    tell(env, IMAGE, { id: 'upload-2', told: 'a lighthouse again' });
    env.db.prepare("UPDATE media SET sha1 = 'same-bytes' WHERE native_ref IN ('upload-1', 'upload-2')").run();
    env.stem();
    const hits = mediaFor(env, 'lighthouse');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].uses, 2);
  }));

test('items never read group by their reference: two references with no bytes stay two hits', () =>
  withEnv((env) => {
    reuse(env, 'm1', AT, 'upload-1');
    reuse(env, 'm2', AT + 60_000, 'upload-2');
    tell(env, IMAGE, { id: 'upload-1', told: 'a lighthouse' });
    tell(env, IMAGE, { id: 'upload-2', told: 'a lighthouse again' });
    env.stem();
    assert.equal(mediaFor(env, 'lighthouse').length, 2);
  }));

test('the same reference on two interfaces is two items', () =>
  withEnv((env) => {
    reuse(env, 'm1', AT, 'same');
    observeLine(
      env,
      {
        ...IMAGE,
        message: () => ({
          attachments: [{ id: 'same', kind: 'image', name: 'p.png', url: 'https://x.invalid/p.png' }],
        }),
      },
      'absent',
      { native: 'm2', iface: 'plainchat', chat: { id: 'room', kind: 'channel', rootId: 'space' } }
    );
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM media WHERE native_ref = 'same'").get()?.n, 2);
  }));

// ---------- bounded ----------

test('a search over 100000 links reads media and its links through indexes', () =>
  withEnv(async (env) => {
    floodItem(env, 100_000);
    env.stem();
    await embedLines(env);
    const statements = new Set<string>();
    const recording = new Proxy(env.db, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            statements.add(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...args: Array<unknown>) => unknown).bind(target) : value;
      },
    });
    const found = search(recording, {
      ctx: group,
      plan: { ...PLAN, forms: ['lighthouse'] },
      now: NOW,
      settings: SETTINGS,
    });
    assert.equal(found.mediaHits[0].uses, 100_001);
    const touching = [...statements].filter((sql) => /\bmedia_links\b/.test(sql));
    assert.ok(touching.length > 0, 'the search reads the links');
    for (const sql of touching) {
      const params = (sql.match(/\?/g) ?? []).map(() => 'x');
      const plan = env.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String(row.detail));
      const scans = plan.filter((detail) => /^SCAN (\w+ AS )?(media_links|media)\b/.test(detail));
      assert.deepEqual(scans, [], `no full scan: ${sql}`);
    }
  }));

// ---------- terms alone are embedded, a picture is found by what it shows ----------

/** A recording embedding call over the fake embedder: it gives `vectorOf(text)` for every text and keeps the texts it was asked. */
function recordingEmbed(vectorOf: (text: string) => Float32Array) {
  const asked: Array<string> = [];
  const embed = (texts: Array<string>) => {
    asked.push(...texts);
    return Promise.resolve(texts.map(vectorOf));
  };
  return { asked, embed };
}

/** A picture whose description is English, its vector queued under the fake model. */
async function pictureWithDescription(env: Env): Promise<{ description: string; sourceId: string }> {
  const sourceId = observeLine(env, IMAGE, 'part');
  env.stem();
  await embedLines(env);
  return { description: itemsOf(IMAGE, 'pic')[0].told, sourceId };
}

test('terms with no question are embedded for the meaning search', () =>
  withEnv(async (env) => {
    await pictureWithDescription(env);
    const { asked, embed } = recordingEmbed(embedWords);
    await recallRig(env, { embed, model: MODEL }).ask({ terms: 'маяк' });
    assert.equal(
      asked.some((text) => text.includes('маяк')),
      true,
      `the embedder received: ${JSON.stringify(asked)}`
    );
  }));

test('a window read by anchor embeds nothing', () =>
  withEnv(async (env) => {
    const { sourceId } = await pictureWithDescription(env);
    env.say({ native: 'before', at: AT - 60_000, text: 'an earlier remark about the harbour', place: GENERAL });
    const { asked, embed } = recordingEmbed(embedWords);
    const text = await recallRig(env, { embed, model: MODEL }).ask({ anchor: '#1' }, { kind: 'source', sourceId });
    assert.ok(text.includes('earlier remark'), 'the lines before the anchor were read');
    assert.deepEqual(asked, []);
  }));

test('terms that share no word with a picture description find its line when the embedder puts them close', () =>
  withEnv(async (env) => {
    const { description } = await pictureWithDescription(env);
    const { embed } = recordingEmbed(() => embedWords(description));
    const text = await recallRig(env, { embed, model: MODEL, minMeaning: 0.5 }).ask({ terms: 'маяк' });
    assert.ok(text.includes(description), text);
  }));

test('terms that share no word with a picture description find nothing when the embedder puts them far', () =>
  withEnv(async (env) => {
    const { description } = await pictureWithDescription(env);
    const { first } = KINDS[4];
    const { embed } = recordingEmbed(() => embedWords(first.word));
    const text = await recallRig(env, { embed, model: MODEL, minMeaning: 0.5 }).ask({ terms: 'маяк' });
    assert.ok(!text.includes(description), text);
  }));
