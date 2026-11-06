// Bringing the stored media descriptions to the English standard (master plan U.4, U.6; docs/prompt-contract.md). A current
// description whose letters outside quotes are mostly of another script (src/memory/text-standard.ts, the check of U.2) is
// described again in English when its media can still be read, and otherwise translated from its text, and the result is a
// new version through the one writer. The old versions stay as they are. A run is idempotent, and a dry run counts with no
// fetch and no model call. Fakes for the media fetch and the describing role; a real database; synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMediaEnglish, bringMediaToEnglish, createEnglishDesk } from '../src/memory/db/media-english.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import type { EnglishItem } from '../src/memory/db/media-english.ts';
import type { Row } from '../src/memory/db/types.ts';

type Env = ReturnType<typeof fixture>;

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const GREEK = 'Μια γκρίζα γάτα κοιμάται στον καναπέ';
const GREEK_OLD = 'Γκρίζα γάτα σε καναπέ';
const ENGLISH = 'A grey cat sleeps on a sofa';
const SIGN = 'A sign over a door reads "Καλημέρα κόσμε" in green letters';

/**
 * One described item as the store holds it: a `media` row with its current text, the `descriptions` row of its key and one
 * `description_versions` row per text, oldest first, the last one current.
 */
function seed(env: Env, { key, texts, kind = 'image' }: { key: string; texts: Array<string>; kind?: string }): void {
  // The lead: descriptions and their versions reference storage_units(id) through owner_key, so the unit exists first,
  // each with its own key_json, which is unique.
  env.db
    .prepare(
      `INSERT INTO storage_units (id, kind, subject_type, subject_id, key_json) VALUES (?, 'versions', 'place', 'discord:main', ?)`
    )
    .run(
      key,
      JSON.stringify({ kind: 'versions', subject: { type: 'place', id: 'discord:main' }, selector: { itemId: key } })
    );
  env.db
    .prepare(
      `INSERT INTO media (id, kind, native_ref, description, described_at, availability, scope_kind, scope_iface, owner_key)
       VALUES (?, ?, ?, ?, ?, 'present', 'group', 'discord', ?)`
    )
    .run(`media:${key}`, kind, `ref-${key}`, texts.at(-1), new Date(NOW - 86_400_000).toISOString(), key);
  const description = `desc:media:${key}`;
  const last = `${description}:${texts.length}`;
  env.db
    .prepare(
      `INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, current_version, owner_key)
       VALUES (?, 'media', ?, 'description', 'group', 'discord', ?, ?)`
    )
    .run(description, `ref-${key}`, last, key);
  texts.forEach((text, index) => {
    env.db
      .prepare(
        `INSERT INTO description_versions (id, description_id, text, written_at, origin, extra, position, owner_key)
         VALUES (?, ?, ?, ?, 'media', ?, ?, ?)`
      )
      .run(
        `${description}:${index + 1}`,
        description,
        text,
        new Date(NOW - 86_400_000 * (texts.length - index)).toISOString(),
        JSON.stringify({ entry: { text, ts: NOW - 86_400_000 * (texts.length - index) } }),
        index + 1,
        key
      );
  });
}

/** What the store holds of a key: the current text, the text of the media row and every version in order. */
function held(env: Env, key: string) {
  const versions = env.db
    .prepare('SELECT id, text FROM description_versions WHERE owner_key = ? ORDER BY position')
    .all(key) as Array<{ id: string; text: string }>;
  const current = env.db
    .prepare(
      'SELECT v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version WHERE d.owner_key = ?'
    )
    .get(key) as { text: string };
  const media = env.db.prepare('SELECT description FROM media WHERE owner_key = ?').get(key) as { description: string };
  return { versions: versions.map((row) => row.text), current: current.text, media: media.description };
}

/** The two ports of the describing role and the media fetch, scripted, noting what they were asked. */
function ports(over: {
  readable?: (item: EnglishItem) => boolean | 'throws';
  redescribed?: (item: EnglishItem) => string | null;
  translated?: (item: EnglishItem) => string | null;
}) {
  const calls = { fetched: Array<string>(), redescribed: Array<string>(), translated: Array<string>() };
  return {
    calls,
    fetchMedia: (item: EnglishItem) => {
      calls.fetched.push(item.ownerKey);
      const readable = over.readable?.(item) ?? true;
      if (readable === 'throws') return Promise.reject(new Error('network'));
      return Promise.resolve(
        readable ? { readable: true as const, media: { bytes: 1 } } : { readable: false as const }
      );
    },
    redescribe: (item: EnglishItem) => {
      calls.redescribed.push(item.ownerKey);
      return Promise.resolve(over.redescribed ? over.redescribed(item) : ENGLISH);
    },
    translate: (item: EnglishItem) => {
      calls.translated.push(item.ownerKey);
      return Promise.resolve(over.translated ? over.translated(item) : ENGLISH);
    },
  };
}

function run(env: Env, given: ReturnType<typeof ports>, over: { dryRun?: boolean } = {}) {
  const written: Array<Row> = [];
  return bringMediaToEnglish({
    db: env.db,
    fetchMedia: given.fetchMedia,
    redescribe: given.redescribe,
    translate: given.translate,
    write: (update: Row) => {
      written.push(update);
      return Promise.resolve(applyMediaEnglish(env.handle, update));
    },
    now: NOW,
    ...over,
  }).then((report) => ({ report, written }));
}

async function withEnv(body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    await body(env);
  } finally {
    env.done();
  }
}

test('describes again in English an off-script description whose media can be read, and keeps the old version', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const given = ports({ readable: () => true });
    const { report } = await run(env, given);
    assert.deepEqual(held(env, 'k1'), { versions: [GREEK, ENGLISH], current: ENGLISH, media: ENGLISH });
    assert.deepEqual([report.redescribed, report.translated, report.unchanged, report.failed], [1, 0, 0, 0]);
    assert.deepEqual([given.calls.redescribed, given.calls.translated], [['k1'], []]);
  }));

test('translates the text of an off-script description whose media is gone, and describes nothing again', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const seen: Array<string> = [];
    const given = ports({
      readable: () => false,
      translated: (item) => {
        seen.push(item.text);
        return ENGLISH;
      },
    });
    const { report } = await run(env, given);
    assert.equal(held(env, 'k1').current, ENGLISH);
    assert.deepEqual([report.redescribed, report.translated, report.failed], [0, 1, 0]);
    assert.deepEqual(seen, [GREEK]);
    assert.deepEqual(given.calls.redescribed, []);
  }));

test('hands the describing role the item with its kind and reference, so it can fetch and tell what it is', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK], kind: 'gif' });
    const items: Array<EnglishItem> = [];
    await run(
      env,
      ports({
        readable: (item) => {
          items.push(item);
          return true;
        },
      })
    );
    assert.deepEqual(
      items.map((item) => [item.ownerKey, item.mediaId, item.kind, item.nativeRef, item.text]),
      [['k1', 'media:k1', 'gif', 'ref-k1', GREEK]]
    );
  }));

test('leaves an English description alone: no fetch, no model call, no new version', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [ENGLISH] });
    const given = ports({});
    const { report, written } = await run(env, given);
    assert.deepEqual(held(env, 'k1').versions, [ENGLISH]);
    assert.deepEqual([report.unchanged, report.redescribed, report.translated, report.failed], [1, 0, 0, 0]);
    assert.deepEqual([given.calls.fetched, given.calls.redescribed, given.calls.translated, written], [[], [], [], []]);
  }));

test('counts an English description with quoted speech in another script as English', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [SIGN] });
    const given = ports({});
    const { report } = await run(env, given);
    assert.equal(report.unchanged, 1);
    assert.deepEqual(given.calls.fetched, []);
  }));

test('a second run changes nothing and asks nothing', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    seed(env, { key: 'k2', texts: [GREEK_OLD] });
    await run(env, ports({ readable: (item) => item.ownerKey === 'k1' }));
    const again = ports({});
    const { report, written } = await run(env, again);
    assert.deepEqual([report.unchanged, report.redescribed, report.translated, report.failed], [2, 0, 0, 0]);
    assert.deepEqual([again.calls.fetched, again.calls.translated, written], [[], [], []]);
    assert.equal(held(env, 'k1').versions.length, 2);
    assert.equal(held(env, 'k2').versions.length, 2);
  }));

test('writes nothing and counts failed when the new description is still off script', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const { report, written } = await run(env, ports({ redescribed: () => GREEK_OLD }));
    assert.deepEqual(held(env, 'k1'), { versions: [GREEK], current: GREEK, media: GREEK });
    assert.deepEqual([report.failed, report.redescribed, written], [1, 0, []]);
  }));

test('writes nothing and counts failed when the describing role answers nothing for a translation', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const { report } = await run(env, ports({ readable: () => false, translated: () => null }));
    assert.deepEqual(held(env, 'k1').versions, [GREEK]);
    assert.deepEqual([report.failed, report.translated], [1, 0]);
  }));

test('a fetch that throws is a failure to retry, never a reason to translate', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const given = ports({ readable: () => 'throws' });
    const { report } = await run(env, given);
    assert.deepEqual(given.calls.translated, []);
    assert.deepEqual(held(env, 'k1').versions, [GREEK]);
    assert.deepEqual([report.failed, report.translated, report.redescribed], [1, 0, 0]);
  }));

test('one failed item does not stop the others', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    seed(env, { key: 'k2', texts: [GREEK_OLD] });
    const { report } = await run(env, ports({ redescribed: (item) => (item.ownerKey === 'k1' ? null : ENGLISH) }));
    assert.equal(held(env, 'k2').current, ENGLISH);
    assert.deepEqual([report.redescribed, report.failed], [1, 1]);
  }));

test('older off-script versions of a key stay as history, are counted as superseded and cost no call', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK_OLD, GREEK] });
    const given = ports({});
    const { report } = await run(env, given);
    assert.deepEqual(held(env, 'k1').versions, [GREEK_OLD, GREEK, ENGLISH]);
    assert.deepEqual([report.redescribed, report.superseded], [1, 1]);
    assert.deepEqual(given.calls.redescribed, ['k1']);
  }));

test('a dry run counts the descriptions to fix with no fetch, no model call and no write', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    seed(env, { key: 'k2', texts: [GREEK_OLD] });
    seed(env, { key: 'k3', texts: [ENGLISH] });
    const given = ports({});
    const { report, written } = await run(env, given, { dryRun: true });
    assert.deepEqual(
      [report.toFix, report.unchanged, report.redescribed, report.translated, report.failed],
      [2, 1, 0, 0, 0]
    );
    assert.deepEqual([given.calls.fetched, given.calls.redescribed, given.calls.translated, written], [[], [], [], []]);
    assert.deepEqual(held(env, 'k1').versions, [GREEK]);
  }));

test('an empty store gives a report of zeros', () =>
  withEnv(async (env) => {
    const { report } = await run(env, ports({}));
    assert.deepEqual(
      [report.redescribed, report.translated, report.unchanged, report.failed, report.superseded, report.toFix],
      [0, 0, 0, 0, 0, 0]
    );
  }));

test('the write drops the vector of the item, so the embedding run reads the new text', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    env.db.prepare("INSERT INTO vectors (chunk_key, model, dims) VALUES ('media:media:k1', 'm', 4)").run();
    await run(env, ports({}));
    const left = env.db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE chunk_key = 'media:media:k1'").get() as {
      n: number;
    };
    assert.equal(left.n, 0);
  }));

test('the new version is a media version of the same description with the time of the run and its manner', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const { written } = await run(env, ports({ readable: () => false }));
    assert.equal(written.length, 1);
    assert.equal(written[0]?.how, 'translated');
    const row = env.db
      .prepare(
        "SELECT origin, position, written_at, extra FROM description_versions WHERE owner_key = 'k1' AND position = 2"
      )
      .get() as { origin: string; position: number; written_at: string; extra: string };
    assert.equal(row.origin, 'media');
    assert.equal(row.written_at, new Date(NOW).toISOString());
    // The lead: the entry gets a name, so no name repeats in a row (R.2).
    const { entry } = JSON.parse(row.extra) as { entry: Row };
    assert.deepEqual([entry.text, entry.ts], [ENGLISH, NOW]);
  }));

// ---------- the owner's command ----------

/** The desk over a fake describing role and the fixture's writer, run to its end. */
async function deskRun(env: Env, given: ReturnType<typeof ports>, dryRun: boolean) {
  const kinds: Array<unknown> = [];
  const quiet = { warn: () => undefined };
  const desk = createEnglishDesk({
    database: () => env.db,
    fetchMedia: given.fetchMedia,
    redescribe: given.redescribe,
    translate: given.translate,
    write: (update: Row) => {
      kinds.push(update.kind);
      return Promise.resolve(applyMediaEnglish(env.handle, update));
    },
    now: () => NOW,
    log: quiet,
  });
  const first = await desk.start({ dryRun });
  while (desk.status().state === 'running') await new Promise((resolve) => setImmediate(resolve));
  return { first, last: desk.status(), kinds };
}

test('the desk runs in the background, writes through the writer as a media-english update and holds its counts for status', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const { first, last, kinds } = await deskRun(env, ports({}), false);
    assert.equal(first.state, 'running');
    assert.equal(last.state, 'done');
    assert.equal(last.report?.redescribed, 1);
    assert.deepEqual(kinds, ['media-english']);
  }));

test('the desk answers a dry run at once with the counts and writes nothing', () =>
  withEnv(async (env) => {
    seed(env, { key: 'k1', texts: [GREEK] });
    const { first, kinds } = await deskRun(env, ports({}), true);
    assert.equal(first.state, 'done');
    assert.equal(first.report?.toFix, 1);
    assert.deepEqual(kinds, []);
    assert.deepEqual(held(env, 'k1').versions, [GREEK]);
  }));

test('the desk reports a closed database as failed', async () => {
  const desk = createEnglishDesk({
    database: () => null,
    fetchMedia: () => Promise.resolve({ readable: false as const }),
    redescribe: () => Promise.resolve(null),
    translate: () => Promise.resolve(null),
    write: () => Promise.resolve(),
    now: () => NOW,
    log: { warn: () => undefined },
  });
  // The lead: the answer gets a name, so no name repeats in a row (R.2).
  const answer = await desk.start({ dryRun: false });
  assert.deepEqual([answer.state, answer.code], ['failed', 'DB_CLOSED']);
});
