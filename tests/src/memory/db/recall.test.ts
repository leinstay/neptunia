// Tests for src/memory/db/recall.ts.
import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAppendStore } from '../../../../src/memory/append-store.ts';
import { createArchive } from '../../../../src/memory/archive.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { search, window, quotesOf, dbSettings } from '../../../../src/memory/db/recall.ts';
import type { RecallMessage, ResolvedRecallAnchor } from '../../../../src/memory/db/recall.ts';
import {
  groupsContext,
  internalContext,
  dmContext,
  dmScope,
  groupContext,
  groupScope,
} from '../../../../src/memory/db/scope.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, Row, Statement, Rows } from '../../../../src/memory/db/types.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { createVectors } from '../../../../src/memory/vectors.ts';
import '../../../../src/tools/operations/index.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import {
  addAccount,
  addDmPlace,
  addGroupPlace,
  ANNA,
  BORIS_PLACE,
  GROUP_PLACE,
  seedOpaqueWorld,
} from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { fillStems, loadStemmer } from '../../../../src/memory/db/stems.ts';
import {
  fixture,
  observeLine,
  recallRig,
  ALICE,
  AT,
  BOB,
  BOB_DM,
  BOB_PERSON,
  BOB_SCOPE,
  GENERAL,
  LABELS,
  KINDS,
  NOW,
  PRESENCES,
  SETTINGS,
  assertForms as checkForms,
  countOf,
  outsideLegend,
  group,
  itemsOf,
  observeDmLine,
  tell,
} from '../../../fixtures/media-memory.ts';
import type { Env, Kind, Presence, RigEmbed } from '../../../fixtures/media-memory.ts';
import { handleOfPerson } from '../../../../src/memory/db/direct-chats.ts';
import { channelPlaceId, dmPlaceId, messageSourceId, topPlaceSpelled } from '../../../../src/memory/db/ids.ts';
import { MODEL, byMeaning, embedLines, embedWords } from '../../../fixtures/media-memory-embed.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { personId } from '../../../fixtures/memory-db/spelled-ids.ts';
import {
  fixture as attributionFixture,
  fixture as exclusionsFixture,
  fixture as nearnessFixture,
  fixture as handlesFixture,
  dmOfMember,
  fixture as recallFixture,
  personId as recallPersonId,
  storedDmOf,
  storedPersonOf,
  fixture as dayFixture,
} from '../../../fixtures/memory-db-recall.ts';
import { labels } from '../../../fixtures/labels.ts';
import { noMediaNames } from '../../../fixtures/media-namer.ts';
import { observe } from '../../../../src/memory/db/observe.ts';
import type { Envelope } from '../../../../src/memory/db/observe.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { lineEvent } from '../../../fixtures/core-over-fake.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import { recordSourceRow } from '../../../../src/memory/db/record-lines.ts';
import { createRecall } from '../../../../src/behavior/recall-run.ts';
import { snapshotOf } from '../../../../src/behavior/snapshot.ts';
import { channel as channelInfo, privateChannel } from '../../../fixtures/reads-rig.ts';
import { memorySearchText, runMemorySearch } from '../../../../src/tools/tools.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';

// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.
describe('DM lines out of reach', () => {
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
  const SECRET = 'xylophonewhisper';

  // A first-generation DM on the home authority: the place and the person are spelled from the native id.
  const PARTNER = 'n1';
  const PARTNER_ACCOUNT = 'discord:n1';
  const PARTNER_PERSON = 'person:discord:n1';
  const DM = 'discord:dm:n1';
  const DM_CHAT = 'dm-chat-n1';
  // Another partner on the same interface.
  const OTHER = 'n2';
  const OTHER_PERSON = 'person:discord:n2';
  const OTHER_DM = 'discord:dm:n2';
  const GROUP = 'discord:channel:room-1';
  const SERVER = 'discord:server:g1';
  // A partner with the same native id under another authority of the interface: the place's id spells nothing.
  const STRANGER_ACCOUNT = 'account:other-authority';
  const STRANGER_PERSON = 'person:elsewhere';
  const STRANGER_DM = 'place:dm-other-authority';

  /** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  const opened: Array<MemoryDbService> = [];
  after(async () => {
    for (const service of opened) await service.close();
  });

  function seedWorld(db: Db): void {
    addAccount(db, {
      id: PARTNER_ACCOUNT,
      iface: 'discord',
      authority: 'discord/global',
      native: PARTNER,
      person: PARTNER_PERSON,
    });
    addAccount(db, {
      id: 'discord:n2',
      iface: 'discord',
      authority: 'discord/global',
      native: OTHER,
      person: OTHER_PERSON,
    });
    addAccount(db, {
      id: STRANGER_ACCOUNT,
      iface: 'discord',
      authority: 'discord/other',
      native: PARTNER,
      person: STRANGER_PERSON,
    });
    addDmPlace(db, {
      id: DM,
      iface: 'discord',
      authority: 'discord/global',
      account: PARTNER_ACCOUNT,
      person: PARTNER_PERSON,
    });
    addDmPlace(db, {
      id: OTHER_DM,
      iface: 'discord',
      authority: 'discord/global',
      account: 'discord:n2',
      person: OTHER_PERSON,
    });
    addDmPlace(db, {
      id: STRANGER_DM,
      iface: 'discord',
      authority: 'discord/other',
      account: STRANGER_ACCOUNT,
      person: STRANGER_PERSON,
    });
    addGroupPlace(db, GROUP, 'discord', 'discord/global');
    db.prepare(
      `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
    ).run(SERVER);
  }

  function world() {
    const dataDir = tempDir('nep-dm-privacy-');
    const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
    seedWorld(dbOf(seed));
    seed.close();
    const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
    const memoryDb = createMemoryDb({
      hot,
      dataDir,
      log: quiet,
      worker: false,
      iface: () => 'discord',
    });
    memoryDb.tick();
    opened.push(memoryDb);
    const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
    const journal = createJournal({ dataDir, memoryDb, now: () => NOW, log: quiet });
    const record = createRecord({ dataDir, memoryDb, now: () => NOW, log: quiet });
    const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
    const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => NOW, log: quiet });
    const vectors = createVectors({ dataDir, memoryDb, now: () => NOW, log: quiet });
    const store = createStore({ dataDir, archive, memoryDb });
    const contexts = {
      group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
      other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
      partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
      stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
    };
    return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
  }
  type World = ReturnType<typeof world>;

  /** A record line of a chat: what a person said there. */
  const lineSaid = (id: string, chat = DM_CHAT, by = PARTNER) =>
    toRecordLine(
      { id, placeId: chat, authorId: by, authorName: 'Partner', content: `the ${SECRET} plan`, ts: NOW - 60_000 },
      { now: () => NOW }
    );

  /** Everything `search` hands a reader, as text. */
  const searched = (w: World, ctx: unknown) =>
    JSON.stringify(search(w.read(), { ctx, plan: { forms: [SECRET], who: [], from: null, to: null }, now: NOW }));

  // ---- the record, recall and the meaning index -----------------------------------------------------------------------

  test("a group's search with quotes finds nothing of a DM", async () => {
    // Bug: a DM line scoped by its channel falls to the group rule of `whereFor`.
    const w = world();
    await w.record.append(DM, [lineSaid('m-dm')]);
    await settled();
    assert.equal(searched(w, internalContext()).includes(SECRET), true);
    assert.equal(searched(w, w.contexts.group).includes(SECRET), false);
  });

  test("another partner's search finds nothing of a DM", async () => {
    // Bug: widening a DM read by anything but the person shows a stranger's chat.
    const w = world();
    await w.record.append(DM, [lineSaid('m-dm')]);
    await settled();
    assert.equal(searched(w, w.contexts.other).includes(SECRET), false);
  });

  test("the diary's context finds nothing of a DM", async () => {
    // Bug: the diary's entry reads `none` and the groups, and a mislabelled DM line is a group line.
    const w = world();
    await w.record.append(DM, [lineSaid('m-dm')]);
    await settled();
    assert.equal(searched(w, groupsContext()).includes(SECRET), false);
  });

  test("the partner's own search finds their own DM line", async () => {
    // Bug: the same narrowing, on the record.
    const w = world();
    await w.record.append(DM, [lineSaid('m-dm')]);
    await settled();
    assert.equal(searched(w, w.contexts.partner).includes(SECRET), true);
  });

  test('the partner of a DM place that spells nothing finds their own line', async () => {
    // Bug: the mapper writes `aud:dm:<iface>:dm:<native>` while the turn's context names the place it stands in.
    const w = world();
    await w.record.append(STRANGER_DM, [lineSaid('m-dm')]);
    await settled();
    assert.equal(searched(w, w.contexts.stranger).includes(SECRET), true);
  });
});

// The persona sees any attachment the same way in recent messages and in memory: the kind marker and the text form, from one read
// (src/memory/db/media-store.ts#lineMedia). The memory prefetch (src/behavior/recall-run.ts#prefetch), window reads (#window),
// the memory session's source batch (src/memory/db/session.ts#buildSessionRequest), the turn's chat rendering
// (src/format.ts#formatTranscript), the stored lines a task and a chat read (src/memory/db/chat-lines.ts) and
// the owner's browser (src/memory/db/domain-read.ts#domainDetail). Audience holds in each. Synthetic content; no model.

async function withLine(kind: Kind, presence: Presence, body: (env: Env, source: string) => void | Promise<void>) {
  const env = fixture();
  try {
    const source = observeLine(env, kind, presence);
    fillStems(env.db);
    await body(env, source);
  } finally {
    env.done();
  }
}
const fileOf = (name: string) =>
  ({
    name: 'file',
    stored: 'file',
    marker: '[file: ',
    origin: null,
    first: { word: 'zzz', fragment: 'zzz', query: 'zzz' },
    second: { word: 'zzz' },
    message: () => ({ attachments: [{ id: 'z1', kind: 'file', name, url: 'https://x.invalid/z' }] }),
  }) satisfies Kind;
const zipFile = fileOf('backup-2026.zip');

test('a file found by its name: a word of the name finds a line that holds nothing else', () =>
  withLine(zipFile, 'absent', async (env) => {
    const text = await recallRig(env).ask({ terms: 'backup' });
    assert.ok(text.includes('backup-2026.zip'), text);
  }));

// The persona's memory searches over every media kind as over text (src/memory/db/recall.ts#search and memory.search): a text form is
// stemmed and embedded once on its `media` row, a media hit is one hit per item with its use count and latest visible use, and
// counts only through a link to a message the reader may see. Words, part of a word, meaning, people, place and time, quotes,
// on a line whose text forms are fully present, partly present or absent, and the required cases: a reused item against
// a person's story, a picture-only day, a re-uploaded file, bounded query plans. Synthetic content; a fake embedder; no model.

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

async function searchWithLine(kind: Kind, presence: Presence, body: (env: Env) => void | Promise<void>) {
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
      searchWithLine(kind, presence, (env) => {
        assert.equal(leadsToLine(mediaFor(env, kind.first.word)), told);
        if (presence === 'part') assert.equal(leadsToLine(mediaFor(env, kind.second.word)), false);
      }));

    test(`part of a word: a fragment of a ${kind.name}'s text form ${told ? 'finds' : 'finds nothing on'} its item, ${presence}`, () =>
      searchWithLine(kind, presence, (env) => {
        const hits = mediaFor(env, kind.first.fragment);
        assert.equal(leadsToLine(hits), told);
        const [firstHit] = hits;
        if (told) assert.ok(firstHit.streams.includes('trigram'));
      }));

    test(`meaning: a Russian query ${told ? 'reaches' : 'does not reach'} a ${kind.name} with its English text form, ${presence}`, () =>
      searchWithLine(kind, presence, async (env) => {
        await embedLines(env);
        const hits = search(env.db, { ctx: group, ...byMeaning(kind.first.query) }).mediaHits;
        assert.equal(leadsToLine(hits), told);
        if (told) {
          const [firstHit] = hits;
          assert.ok(firstHit.streams.includes('meaning'));
          assert.equal(firstHit.latest.ts, AT, 'the hit leads to its message with its date');
          assert.deepEqual(
            firstHit.messages.map((message) => [message.messageId, message.ts]),
            [['pic', AT]]
          );
        }
      }));

    test(`people: the author's lines show a ${kind.name} with its marker and its text form, ${presence}`, () =>
      searchWithLine(kind, presence, async (env) => {
        const text = await recallRig(env).ask({ people: kind.self ? 'Self' : 'Alice' });
        assertForms(text, kind, presence);
      }));

    test(`place and time: a sample of the day shows a ${kind.name} with its marker and its text form, ${presence}`, () =>
      searchWithLine(kind, presence, async (env) => {
        const text = await recallRig(env).ask({ when: '2026-11-01', channel: 'c1' });
        assertForms(text, kind, presence);
      }));

    test(`memory.search quotes: a ${kind.name} shows its marker and its text form, ${presence}`, () =>
      searchWithLine(kind, presence, async (env) => {
        // An absent text form has no word to be found by: the time stream shows the same bare line.
        const question = told ? { terms: kind.first.word } : { when: '2026-11-01' };
        const text = await recallRig(env).ask(question);
        assertForms(text, kind, presence);
      }));
  }

  if (kind.name !== 'voice said') {
    test(`a line with two of a ${kind.name} shows two markers and one text form when one is told`, () =>
      searchWithLine(kind, 'part', async (env) => {
        const text = await recallRig(env).ask({ when: '2026-11-01' });
        // An emoji's and a sticker's description stands in the legend, the line holds the stable name.
        assert.equal(countOf(outsideLegend(text), kind.marker), 2, text);
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
    const [firstHit] = hits;
    assert.equal(firstHit.uses, 3);
    assert.deepEqual([firstHit.latest.messageId, firstHit.latest.ts], ['m3', AT + 120_000]);
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
    // The DM line is put under Bob as a person, as observeDmLine does, and Bob's DM also reads
    // the group's use, so Bob's reader sees two uses, the latest Bob's own.
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

// ---------- the required cases ----------

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
    // The seed line is Alice's, so its observation already made Alice's account and a second insert fails.
    env.stem();
    const found = asked(env, { forms: ['lighthouse'], who: ['Alice'] });
    const [firstHit] = found.hits;
    assert.equal(firstHit.messageId, 'story', 'the story comes first');
    assert.equal(found.mediaHits.length, 1, 'the item is one hit');
    const [firstMedia] = found.mediaHits;
    assert.ok(firstMedia.uses > 10_000 - 1, 'with its use count');
    assert.ok(firstMedia.messages.length <= 20, 'and a few of its messages, never all of them');
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
    const [firstMedia] = found.mediaHits;
    assert.equal(firstMedia.latest.messageId, 'photo');
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
    const [firstMedia] = found.mediaHits;
    assert.equal(firstMedia.uses, 100_001);
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

// ---------- a search says when nothing is close, and finds the persona's own lines ----------

// The nothing-close line is a marker of these tests' own under `tools.tools.memory.far`, so no tracked wording is asserted.
const FAR_MARK = 'FAR-MARK';
const { tools: toolLabels } = LABELS;
const { tools: toolKinds } = toolLabels;
const FAR_LABELS = {
  ...LABELS,
  tools: { ...toolLabels, tools: { ...toolKinds, memory: { ...toolKinds.memory, far: FAR_MARK } } },
};
/** The vector every query gets: a line stored under it is as close to the question as a line can be. */
const QUERY = [1, 0, 0];
/**
 * A weak line: near enough to the question to come back from the meaning stream, too far to count as a hit by meaning. An
 * orthogonal line never comes back at all (the database drops it), so it could not show the nearest lines that were weak.
 */
const WEAK = [0.45, Math.sqrt(1 - 0.45 ** 2), 0];
const queryEmbed: RigEmbed = (texts) => Promise.resolve(texts.map(() => Float32Array.from(QUERY)));
const HOUR = 3_600_000;

/** One line in a channel of its own, so no neighbour of another line rides along as its context. */
function lineAlone(
  env: Env,
  {
    native,
    text,
    at,
    vector,
    kind = 'seen',
  }: { native: string; text: string; at: number; vector?: Array<number>; kind?: string }
): void {
  const place = channelPlaceId('discord', `room-${native}`);
  env.channel(place, `room-${native}`);
  env.say({ native, at, text, place, kind, author: kind === 'said' ? 'u-self' : ALICE });
  if (vector) env.vector(native, vector);
}

/** The texts of `texts` that stand in `text`, in the order they stand there. */
const shownIn = (text: string, texts: ReadonlyArray<string>): Array<string> =>
  texts.filter((one) => text.includes(one)).sort((a, b) => text.indexOf(a) - text.indexOf(b));

const WEAK_LINES = [
  'a remark on bread',
  'a remark on rain',
  'a remark on shoes',
  'a remark on clocks',
  'a remark on glue',
];

test('opens with the nothing-close line and carries at most 3 lines when every line is far from the terms and no word matches', () =>
  withEnv(async (env) => {
    WEAK_LINES.forEach((text, i) => lineAlone(env, { native: `weak-${i}`, text, at: AT + i * HOUR, vector: WEAK }));
    const text = await recallRig(env, { embed: queryEmbed, model: MODEL, labels: FAR_LABELS }).ask({ terms: 'маяк' });
    const shown = shownIn(text, WEAK_LINES);
    assert.ok(text.includes(FAR_MARK), text);
    assert.ok(shown.length > 0 && shown.length <= 3, `${shown.length} lines: ${text}`);
    assert.ok(text.indexOf(FAR_MARK) < text.indexOf(shown[0] ?? ''), 'the line opens the result, before any quote');
  }));

test('leaves the result as it was when one line passes the bar: no nothing-close line, the hit first, no cut to 3', () =>
  withEnv(async (env) => {
    // A guard: a search with a hit by meaning keeps its answer, so neither the nothing-close line nor its cut to three
    // lines may reach it. The hit is the newest line, first as the answer stands today.
    const close = 'the lamp on the cliff';
    const weak = WEAK_LINES.slice(0, 4);
    weak.forEach((text, i) => lineAlone(env, { native: `weak-${i}`, text, at: AT + i * HOUR, vector: WEAK }));
    lineAlone(env, { native: 'close', text: close, at: AT + 6 * HOUR, vector: QUERY });
    const text = await recallRig(env, { embed: queryEmbed, model: MODEL, labels: FAR_LABELS }).ask({ terms: 'маяк' });
    const shown = shownIn(text, [close, ...weak]);
    assert.ok(!text.includes(FAR_MARK), text);
    assert.deepEqual([shown[0], shown.length], [close, 5], text);
  }));

test("returns only the persona's own lines with mine when their line and another person line both match", () =>
  withEnv(async (env) => {
    lineAlone(env, { native: 'hers', text: 'I flew a kite at noon', at: AT, kind: 'said' });
    lineAlone(env, { native: 'alices', text: 'a kite over the hill', at: AT + HOUR });
    env.stem();
    const text = await recallRig(env).ask({ terms: 'kite', mine: true });
    assert.deepEqual(shownIn(text, ['I flew a kite at noon', 'a kite over the hill']), ['I flew a kite at noon'], text);
  }));

test("returns the persona's lines of a day newest first with mine and when and no words", () =>
  withEnv(async (env) => {
    lineAlone(env, { native: 'early', text: 'my morning line', at: AT, kind: 'said' });
    lineAlone(env, { native: 'late', text: 'my evening line', at: AT + 3 * HOUR, kind: 'said' });
    lineAlone(env, { native: 'alices', text: 'her line that day', at: AT + HOUR });
    lineAlone(env, { native: 'later', text: 'my line of the next day', at: AT + 24 * HOUR, kind: 'said' });
    const text = await recallRig(env).ask({ when: '2026-11-01', mine: true });
    assert.deepEqual(
      shownIn(text, ['my morning line', 'my evening line', 'her line that day', 'my line of the next day']),
      ['my evening line', 'my morning line'],
      text
    );
  }));

test("keeps the audience rule with mine: the persona's line in a chat the context may not read does not come back", () =>
  withEnv(async (env) => {
    // A guard: `mine` must narrow the search the context may read, never read the persona's lines past it.
    env.dmPlace(BOB);
    lineAlone(env, { native: 'open', text: 'a kite in the open', at: AT, kind: 'said' });
    env.say({
      native: 'private',
      at: AT + HOUR,
      text: 'a kite in private',
      place: BOB_DM,
      kind: 'said',
      author: 'u-self',
      scope: BOB_SCOPE,
    });
    env.stem();
    const text = await recallRig(env).ask({ terms: 'kite', mine: true });
    assert.deepEqual(shownIn(text, ['a kite in the open', 'a kite in private']), ['a kite in the open'], text);
  }));

test('a memory search that finds a picture the persona made shows the made mark and the people it shows', () =>
  searchWithLine(IMAGE, 'full', async (env) => {
    // Bug: a search hit on the persona's own drawing reads as anyone's picture, with nobody in it.
    const alice = String(env.db.prepare('SELECT person_id FROM accounts WHERE native_id = ?').get(ALICE)?.person_id);
    env.db
      .prepare("UPDATE media SET extra = json_set(extra, '$.made', 'self', '$.depicts', json(?)) WHERE native_ref = ?")
      .run(JSON.stringify(['person:self', alice]), itemsOf(IMAGE, 'pic')[0].id);
    const labels = {
      ...LABELS,
      transcript: {
        ...LABELS.transcript,
        mediaMade: '[MADE]',
        mediaDepicts: '[SHOWS {names}]',
        mediaDepictsSelf: 'HERSELF',
      },
    };
    const text = await recallRig(env, { labels }).ask({ terms: IMAGE.first.word });
    assert.ok(text.includes(IMAGE.first.word), text);
    assert.ok(text.includes('[MADE]'), text);
    // A person is written by the handle the persona can pass to a tool, never by a name.
    assert.ok(text.includes(`[SHOWS HERSELF, @${handleOfPerson(alice)}]`), text);
  }));

// Recall attribution preserves exact account and place identities across interfaces.

const DAY = 86400000;
const ATTRIBUTION_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ATTRIBUTION_BOB = 'u-bob';
const run = (env: ReturnType<typeof attributionFixture>, forms: Array<string>, options: Record<string, unknown> = {}) =>
  search(env.db, {
    ctx: groupContext('discord'),
    plan: { forms, who: [], from: null, to: null },
    now: ATTRIBUTION_NOW,
    ...options,
  });

function attributionAccount(
  env: ReturnType<typeof attributionFixture>,
  id: string,
  iface: string,
  native: string,
  name: string
) {
  env.db
    .prepare('INSERT INTO accounts (id, iface, native_id, names) VALUES (?, ?, ?, ?)')
    .run(id, iface, native, JSON.stringify([name]));
}

test('search names a foreign author from its exact account despite a primary native-ID collision', () => {
  const env = attributionFixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({
      native: 'foreign-author',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: ATTRIBUTION_NOW - DAY,
      text: 'το κουνέλι',
    });
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author' });
    assert.equal(found.windows.length, 1);
    const [firstWindow] = found.windows;
    const [firstMessage] = firstWindow.messages;
    assert.equal(firstMessage.authorName, 'Foreign stored author');
    assert.equal(firstMessage.authorId, '42');
    const quotes = quotesOf(found.windows, {
      mediaNameOf: noMediaNames,
      render: { labels, timezone: 'UTC' },
      stretchChars: 1500,
    });
    const [firstQuote] = quotes;
    assert.ok(firstQuote.lines.includes('Foreign stored author'));
    assert.equal(firstQuote.lines.includes('Primary profile author'), false);
  } finally {
    env.done();
  }
});

test('search keeps the primary stored author when a foreign account with the same native ID is inserted last', () => {
  const env = attributionFixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({ native: 'primary-author', author: '42', at: ATTRIBUTION_NOW - DAY, text: 'το κουνέλι' });
    env.stem();
    const found = run(env, ['κουνέλι']);
    assert.equal(found.windows.length, 1);
    const [firstWindow] = found.windows;
    const [firstMessage] = firstWindow.messages;
    assert.equal(firstMessage.authorName, 'Primary stored author');
  } finally {
    env.done();
  }
});

test('search resolves an opaque account through its stored native ID and interface', () => {
  const env = attributionFixture();
  try {
    attributionAccount(env, 'account:opaque-731', 'other', '42', 'Opaque stored author');
    const source = env.say({
      native: 'opaque-author',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: ATTRIBUTION_NOW - DAY,
      text: 'το κουνέλι',
    });
    env.db.prepare('UPDATE sources SET author_account = ? WHERE id = ?').run('account:opaque-731', source);
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author' });
    assert.equal(found.windows.length, 1);
    const [firstWindow] = found.windows;
    const [firstMessage] = firstWindow.messages;
    assert.equal(firstMessage.authorName, 'Opaque stored author');
    assert.equal(firstMessage.authorId, '42');
  } finally {
    env.done();
  }
});

test('search keeps same-interface profile author precedence over the stored account name', () => {
  const env = attributionFixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    env.say({ native: 'profile-author', author: '42', at: ATTRIBUTION_NOW - DAY, text: 'το κουνέλι' });
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author' });
    const [firstWindow] = found.windows;
    const [firstMessage] = firstWindow.messages;
    assert.equal(firstMessage.authorName, 'Primary profile author');
  } finally {
    env.done();
  }
});

for (const iface of ['other', 'discord']) {
  test(`search resolves the ${iface} group name without borrowing another interface's native-ID alias`, () => {
    const env = attributionFixture();
    try {
      const place = channelPlaceId(iface, 'room');
      insertRows(env.db, {
        places: [
          { id: place, iface, kind: 'channel', native_id: 'room', scope_kind: 'group', name: 'Stored group name' },
        ],
      });
      env.say({
        native: `place-${iface}`,
        iface,
        place,
        scope: groupScope(iface),
        at: ATTRIBUTION_NOW - DAY,
        text: 'το κουνέλι',
      });
      env.stem();
      const found = run(env, ['κουνέλι'], { channelNameOf: () => 'Primary snapshot group' });
      assert.equal(found.windows.length, 1);
      const [firstWindow] = found.windows;
      assert.equal(firstWindow.channelName, iface === 'discord' ? 'Primary snapshot group' : 'Stored group name');
      const quotes = quotesOf(found.windows, {
        mediaNameOf: noMediaNames,
        render: { labels, timezone: 'UTC' },
        stretchChars: 1500,
      });
      assert.equal(quotes[0].channelName, iface === 'discord' ? 'Primary snapshot group' : 'Stored group name');
    } finally {
      env.done();
    }
  });
}

test('an ordinary DM read hides private place names before callbacks while internal reads retain the stored name', () => {
  const env = attributionFixture();
  try {
    const place = dmPlaceId('discord', ATTRIBUTION_BOB);
    const scope = dmScope(personId('discord', ATTRIBUTION_BOB), 'discord');
    insertRows(env.db, {
      places: [
        {
          id: place,
          iface: 'discord',
          kind: 'dm',
          native_id: ATTRIBUTION_BOB,
          scope_kind: 'dm',
          partner_person: personId('discord', ATTRIBUTION_BOB),
          name: 'Private stored place',
        },
      ],
    });
    env.say({ native: 'private-before', place, scope, at: ATTRIBUTION_NOW - DAY, text: 'το κουνέλι private-before' });
    const anchor = env.say({
      native: 'private-anchor',
      place,
      scope,
      at: ATTRIBUTION_NOW - DAY + 60_000,
      text: 'private-anchor',
    });
    const ordinary = window(env.db, {
      ctx: dmContext(personId('discord', ATTRIBUTION_BOB), 'discord', dmPlaceId('discord', ATTRIBUTION_BOB)),
      anchor,
      move: 'up',
      messages: 1,
      channelNameOf: () => 'Private callback place',
    });
    assert.equal(ordinary.unknown, false);
    const [ordinaryWindow] = ordinary.windows;
    const [ordinaryMessage] = ordinaryWindow.messages;
    assert.equal(ordinaryMessage.content, 'το κουνέλι private-before');
    assert.equal(ordinaryWindow.channelName, null);
    const internal = window(env.db, { ctx: internalContext(), anchor, move: 'up', messages: 1 });
    const [internalWindow] = internal.windows;
    assert.equal(internalWindow.channelName, 'Private stored place');
  } finally {
    env.done();
  }
});

test('a said source retains the supplied persona name instead of an account alias', () => {
  const env = attributionFixture();
  try {
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({
      native: 'self-author',
      kind: 'said',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: ATTRIBUTION_NOW - DAY,
      text: 'το κουνέλι',
    });
    env.stem();
    const found = run(env, ['κουνέλι'], { nameOf: () => 'Primary profile author', selfName: 'Synthetic persona' });
    const [firstWindow] = found.windows;
    const [firstMessage] = firstWindow.messages;
    assert.equal(firstMessage.authorName, 'Synthetic persona');
    assert.equal(firstMessage.self, true);
  } finally {
    env.done();
  }
});

test('a source retains its native author ID after its exact account retires without borrowing a foreign alias', () => {
  const env = attributionFixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({ native: 'retired-author', author: '42', at: ATTRIBUTION_NOW - DAY, text: 'το κουνέλι' });
    env.db
      .prepare('UPDATE accounts SET retired_at = ? WHERE id = ?')
      .run(new Date(ATTRIBUTION_NOW).toISOString(), 'discord:42');
    env.stem();
    const found = run(env, ['κουνέλι']);
    assert.equal(found.windows.length, 1);
    const [firstWindow] = found.windows;
    const [firstMessage] = firstWindow.messages;
    assert.equal(firstMessage.authorId, '42');
    assert.notEqual(firstMessage.authorName, 'Foreign stored author');
  } finally {
    env.done();
  }
});

test('a retired account keeps its native identity without displaying its retired name', () => {
  const env = attributionFixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Retired stored author');
    env.say({ native: 'retired-only', author: '42', at: ATTRIBUTION_NOW - DAY, text: 'το κουνέλι retained evidence' });
    env.db
      .prepare('UPDATE accounts SET retired_at = ? WHERE id = ?')
      .run(new Date(ATTRIBUTION_NOW).toISOString(), 'discord:42');
    env.stem();
    const [firstWindow] = run(env, ['κουνέλι']).windows;
    const [message] = firstWindow.messages;
    assert.equal(message.authorId, '42');
    assert.notEqual(message.authorName, 'Retired stored author');
    assert.equal(message.content, 'το κουνέλι retained evidence');
  } finally {
    env.done();
  }
});

test('a source with no account retains its text and reports no author identity', () => {
  const env = attributionFixture();
  try {
    env.say({
      native: 'missing-account',
      author: 'missing',
      at: ATTRIBUTION_NOW - DAY,
      text: 'το κουνέλι unattributed evidence',
    });
    env.stem();
    const [firstWindow] = run(env, ['κουνέλι']).windows;
    const [message] = firstWindow.messages;
    assert.equal(message.authorId, null);
    assert.equal(message.content, 'το κουνέλι unattributed evidence');
  } finally {
    env.done();
  }
});

for (const snapshot of [false, true]) {
  test(`a named group uses ${snapshot ? 'its native snapshot identity' : 'its stored name without a snapshot callback'}`, () => {
    const env = attributionFixture();
    try {
      const place = channelPlaceId('discord', 'room');
      insertRows(env.db, {
        places: [
          {
            id: place,
            iface: 'discord',
            kind: 'channel',
            native_id: 'room',
            scope_kind: 'group',
            name: 'Stored group',
          },
        ],
      });
      env.say({ native: 'named-group', place, at: ATTRIBUTION_NOW - DAY, text: 'το κουνέλι named group evidence' });
      env.stem();
      const found = run(
        env,
        ['κουνέλι'],
        snapshot ? { channelNameOf: (id: unknown) => (id === 'room' ? 'Snapshot group' : null) } : {}
      );
      const [firstWindow] = found.windows;
      const [firstMessage] = firstWindow.messages;
      assert.equal(firstWindow.channelName, snapshot ? 'Snapshot group' : 'Stored group');
      assert.equal(firstMessage.content, 'το κουνέλι named group evidence');
    } finally {
      env.done();
    }
  });
}

test('a normalized DM place hides its name independently of an allowed source audience', () => {
  const env = attributionFixture();
  try {
    const place = dmPlaceId('discord', ATTRIBUTION_BOB);
    insertRows(env.db, {
      places: [
        {
          id: place,
          iface: 'discord',
          kind: 'dm',
          native_id: ATTRIBUTION_BOB,
          chat: 'dm',
          name: 'Private normalized place',
        },
      ],
    });
    env.say({
      native: 'readable-private-place',
      place,
      at: ATTRIBUTION_NOW - DAY,
      text: 'το κουνέλι allowed evidence',
    });
    env.stem();
    const found = run(env, ['κουνέλι'], { channelNameOf: () => 'Private snapshot place' });
    const [firstWindow] = found.windows;
    const [firstMessage] = firstWindow.messages;
    assert.equal(firstWindow.channelName, null);
    assert.equal(firstMessage.content, 'το κουνέλι allowed evidence');
  } finally {
    env.done();
  }
});

test("quotesOf names each line's author by the handle `handleOf` gives its stored account, never the name or the id", () => {
  // Bug: a memory.search result names its authors by the stored display name, and `(id:…)` in memory mode, so the lines
  // the persona found tie to no entry of <people>. One handle per person, authors by handle.
  const env = attributionFixture();
  try {
    attributionAccount(env, 'discord:42', 'discord', '42', 'Primary stored author');
    attributionAccount(env, 'other:42', 'other', '42', 'Foreign stored author');
    env.say({
      native: 'foreign-author',
      iface: 'other',
      author: '42',
      place: channelPlaceId('other', 'room'),
      scope: groupScope('other'),
      at: ATTRIBUTION_NOW - DAY,
      text: 'το κουνέλι',
    });
    env.stem();
    const found = run(env, ['κουνέλι']);
    const authors = { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' };
    const quotes = quotesOf(found.windows, {
      mediaNameOf: noMediaNames,
      render: { labels: { ...labels, authors }, timezone: 'UTC' },
      stretchChars: 1500,
      handleOf: (message: RecallMessage) =>
        message.stored?.iface === 'other' && message.authorId === '42' ? 'u0th1' : 'uprim',
    });
    const stretch = quotes[0]?.lines ?? '';
    const line = stretch.split('\n').find((one) => one.includes('κουνέλι')) ?? '';
    assert.ok(line.includes('@u0th1'), line);
    assert.equal(/Foreign stored author|Primary stored author|\b42\b/.test(line), false, line);
  } finally {
    env.done();
  }
});

// Scoped exclusions preserve independent SQLite evidence across native message collisions and chat contexts.
const EXCLUSIONS_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const exclusionsGroup = groupContext('discord');
const plan = (forms: Array<string>, extra: Record<string, unknown> = {}) => ({
  forms,
  who: [],
  from: null,
  to: null,
  ...extra,
});
const exclusionsRun = (
  env: ReturnType<typeof exclusionsFixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = exclusionsGroup
) => search(env.db, { ctx, plan: plan(forms, given), now: EXCLUSIONS_NOW, ...rest });

function storedObservation(
  env: ReturnType<typeof exclusionsFixture>,
  {
    key,
    room,
    iface = 'other',
    authority = `${iface}/${room}`,
    text = 'το κουνέλι',
    at = EXCLUSIONS_NOW - DAY,
    privatePlace = false,
    revision = 1,
  }: {
    key: string;
    room: string;
    iface?: string;
    authority?: string;
    text?: string;
    at?: number;
    privatePlace?: boolean;
    revision?: number;
  }
) {
  const envelope: Envelope = {
    v: 1,
    iface,
    authority,
    native: { kind: 'message', key, revision },
    place: {
      authority,
      key: room,
      kind: privatePlace ? 'dm' : 'room',
      chat: privatePlace ? 'dm' : 'group',
      ...(privatePlace ? { partner: { key: 'private-partner' } } : {}),
    },
    author: { kind: 'account', key: 'author-42' },
    occurredAt: new Date(at).toISOString(),
    observedAt: new Date(EXCLUSIONS_NOW).toISOString(),
    text,
  };
  const result = observe(env.handle, envelope, { now: () => EXCLUSIONS_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string') throw new Error('source identity missing');
  const placeId = env.db.prepare('SELECT place_id FROM sources WHERE id = ?').get(result.sourceId)?.place_id;
  if (typeof placeId !== 'string') throw new Error('stored place missing');
  return { sourceId: result.sourceId, placeId, iface };
}

function exclusionSource(
  env: ReturnType<typeof exclusionsFixture>,
  {
    iface = 'fake',
    room,
    id = 'shared-visible',
    marker,
    dm = false,
    offset = 60_000,
    authority = `${iface}/${room}`,
  }: { iface?: string; room: string; id?: string; marker: string; dm?: boolean; offset?: number; authority?: string }
) {
  const event = lineEvent({
    id,
    chatId: room,
    authorId: 'owner-42',
    text: `το κουνέλι ${marker}`,
    at: EXCLUSIONS_NOW - DAY - offset,
  });
  event.iface = iface;
  event.chat = dm
    ? { id: room, kind: 'dm', rootId: null, partnerId: 'owner-42' }
    : { id: room, kind: 'channel', rootId: 'g1', name: room };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid exclusion fixture was refused');
  envelope.authority = authority;
  envelope.place.authority = authority;
  const result = observe(env.handle, envelope, { now: () => EXCLUSIONS_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string' || typeof result.placeId !== 'string')
    throw new Error('exclusion source identity missing');
  return {
    sourceId: result.sourceId,
    placeId: result.placeId,
    iface,
    native: { iface, chatId: room, messageId: id },
  };
}

test('a scoped native exclusion removes only its verified chat from low-level search', () => {
  const env = exclusionsFixture();
  try {
    const own = exclusionSource(env, { room: 'current-room', marker: 'own' });
    const foreign = exclusionSource(env, { iface: 'other', room: 'foreign-room', marker: 'foreign' });
    const nearby = exclusionSource(env, { room: 'different-room', marker: 'different' });
    env.stem();
    const found = exclusionsRun(
      env,
      ['κουνέλι'],
      { exclusions: [{ kind: 'native', locator: own.native }] },
      groupContext('fake')
    );
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [foreign.sourceId, nearby.sourceId].sort());
  } finally {
    env.done();
  }
});

test('an exact opaque source exclusion does not need a verified native locator', () => {
  const env = exclusionsFixture();
  try {
    const own = storedObservation(env, { key: 'opaque-excluded', room: 'opaque-one' });
    const other = storedObservation(env, { key: 'opaque-excluded', room: 'opaque-two' });
    env.stem();
    const found = exclusionsRun(env, ['κουνέλι'], { exclusions: [{ kind: 'source', sourceId: own.sourceId }] });
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [other.sourceId]
    );
  } finally {
    env.done();
  }
});

test('a legacy native exclusion is limited to the unique source in the reader interface', () => {
  const env = exclusionsFixture();
  try {
    exclusionSource(env, { room: 'current-room', marker: 'own' });
    const foreign = exclusionSource(env, { iface: 'other', room: 'foreign-room', marker: 'foreign' });
    env.stem();
    const found = exclusionsRun(env, ['κουνέλι'], { exclude: new Set(['shared-visible']) }, groupContext('fake'));
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [foreign.sourceId]
    );
  } finally {
    env.done();
  }
});

test('an ambiguous legacy native exclusion retains both same-interface chats', () => {
  const env = exclusionsFixture();
  try {
    const first = exclusionSource(env, { room: 'first-room', marker: 'first' });
    const second = exclusionSource(env, { room: 'second-room', marker: 'second' });
    env.stem();
    const found = exclusionsRun(env, ['κουνέλι'], { exclude: new Set(['shared-visible']) }, groupContext('fake'));
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [first.sourceId, second.sourceId].sort());
  } finally {
    env.done();
  }
});

test('an internal reader ignores unqualified legacy native exclusions', () => {
  const env = exclusionsFixture();
  try {
    const source = exclusionSource(env, { room: 'private-room', marker: 'private', dm: true });
    env.stem();
    const found = exclusionsRun(env, ['κουνέλι'], { exclude: new Set(['shared-visible']) }, internalContext());
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [source.sourceId]
    );
  } finally {
    env.done();
  }
});

for (const malformed of [false, true]) {
  test(`explicit ${malformed ? 'malformed' : 'empty'} exclusions never fall back to legacy native exclusions`, () => {
    const env = exclusionsFixture();
    try {
      const source = exclusionSource(env, { room: 'current-room', marker: 'visible' });
      env.stem();
      const exclusions: ReadonlyArray<ResolvedRecallAnchor> = malformed ? [{ kind: 'source', sourceId: '' }] : [];
      const found = exclusionsRun(
        env,
        ['κουνέλι'],
        { exclusions, exclude: new Set(['shared-visible']) },
        groupContext('fake')
      );
      assert.deepEqual(
        found.hits.map((hit) => hit.id),
        [source.sourceId]
      );
    } finally {
      env.done();
    }
  });
}

test('an ambiguous qualified native exclusion retains distinct current stored sources', () => {
  const env = exclusionsFixture();
  try {
    const first = exclusionSource(env, { room: 'shared-room', authority: 'fake/first', marker: 'first' });
    const second = exclusionSource(env, { room: 'shared-room', authority: 'fake/second', marker: 'second' });
    env.stem();
    const found = search(env.db, {
      ctx: groupContext('fake'),
      plan: plan(['κουνέλι']),
      now: EXCLUSIONS_NOW,
      exclusions: [{ kind: 'native', locator: first.native }],
    });
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [first.sourceId, second.sourceId].sort());
  } finally {
    env.done();
  }
});

/**
 * A line of the channel `room` on `fake` saying `το κουνέλι <marker>`, stored under the platform key `key` with the
 * message id `messageId` in its locator, at `revision`.
 */
function lineWithLocator(
  env: ReturnType<typeof exclusionsFixture>,
  {
    room,
    key,
    messageId,
    marker,
    revision = 1,
  }: { room: string; key: string; messageId: string; marker: string; revision?: number }
): string {
  const event = lineEvent({
    id: messageId,
    chatId: room,
    authorId: 'owner-42',
    text: `το κουνέλι ${marker}`,
    at: EXCLUSIONS_NOW - DAY,
  });
  event.iface = 'fake';
  event.chat = { id: room, kind: 'channel', rootId: 'g1', name: room };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid line fixture was refused');
  envelope.native = { ...envelope.native, key, revision };
  envelope.authority = `fake/${room}`;
  envelope.place.authority = `fake/${room}`;
  const result = observe(env.handle, envelope, { now: () => EXCLUSIONS_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string') throw new Error('line source identity missing');
  return result.sourceId;
}

/** `db` with every statement it runs kept as its SQL and parameters. */
function planRecording(db: Db): { db: Db; ran: Array<{ sql: string; params: Array<unknown> }> } {
  const ran: Array<{ sql: string; params: Array<unknown> }> = [];
  const prepare = (sql: string): Statement => {
    const statement = db.prepare(sql);
    const note = (params: Array<unknown>): void => {
      ran.push({ sql, params });
    };
    return {
      get: (...params) => (note(params), statement.get(...params)),
      all: (...params) => (note(params), statement.all(...params)),
      run: (...params) => (note(params), statement.run(...params)),
      iterate: (...params) => (note(params), statement.iterate(...params)),
    };
  };
  return { db: { prepare, exec: (sql) => db.exec(sql) }, ran };
}

/** A read of `sources` that SQLite narrows by the interface alone, or a walk of the whole table. */
const WHOLE_INTERFACE = /^SEARCH s USING (COVERING )?INDEX \w+ \(iface=\?\)$|^SCAN s\b/;

test('a native exclusion is resolved through an index bounded by more than the interface', () => {
  // Catches: a lookup by native id or locator that SQLite narrows by interface only, reading and parsing every line of
  // the interface once per excluded history line.
  const env = exclusionsFixture();
  try {
    const own = exclusionSource(env, { room: 'current-room', marker: 'own' });
    const nearby = exclusionSource(env, { room: 'different-room', marker: 'different' });
    env.stem();
    const { db, ran } = planRecording(env.db);
    const found = search(db, {
      ctx: groupContext('fake'),
      plan: plan(['κουνέλι']),
      now: EXCLUSIONS_NOW,
      exclusions: [{ kind: 'native', locator: own.native }],
    });
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [nearby.sourceId]
    );
    const wide = ran.flatMap(({ sql, params }) =>
      env.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String(row.detail))
        .filter((line) => WHOLE_INTERFACE.test(line))
    );
    assert.deepEqual(wide, []);
  } finally {
    env.done();
  }
});

test('a native exclusion removes a line whose locator names the message id under a different platform key', () => {
  // Catches: a lookup that reads only `native_id` and misses a line found by the message id stored in its locator.
  const env = exclusionsFixture();
  try {
    lineWithLocator(env, { room: 'current-room', key: 'platform-key-1', messageId: 'shared-visible', marker: 'own' });
    const nearby = exclusionSource(env, { room: 'different-room', marker: 'different' });
    env.stem();
    const found = exclusionsRun(
      env,
      ['κουνέλι'],
      {
        exclusions: [
          { kind: 'native', locator: { iface: 'fake', chatId: 'current-room', messageId: 'shared-visible' } },
        ],
      },
      groupContext('fake')
    );
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [nearby.sourceId]
    );
  } finally {
    env.done();
  }
});

test('a native exclusion of an edited line removes its newest revision', () => {
  // Catches: a lookup that drops the current-revision filter, finds both revisions, takes neither as unique and keeps the
  // excluded line in the results.
  const env = exclusionsFixture();
  try {
    exclusionSource(env, { room: 'current-room', marker: 'old' });
    lineWithLocator(env, {
      room: 'current-room',
      key: 'shared-visible',
      messageId: 'shared-visible',
      marker: 'new',
      revision: 2,
    });
    const nearby = exclusionSource(env, { room: 'different-room', marker: 'different' });
    env.stem();
    const found = exclusionsRun(
      env,
      ['κουνέλι'],
      {
        exclusions: [
          { kind: 'native', locator: { iface: 'fake', chatId: 'current-room', messageId: 'shared-visible' } },
        ],
      },
      groupContext('fake')
    );
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [nearby.sourceId]
    );
  } finally {
    env.done();
  }
});

// src/memory/db/recall.ts: proximity breaks a tie of relevance and excludes nothing.

const NEARNESS_NOW = Date.parse('2026-10-24T12:00:00Z');
const NEARNESS_DAY = 86_400_000;

test('an equal hit in the current place comes first, and a stronger hit on another interface keeps its lead', () => {
  // Bug: place proximity excludes a remote hit, or lets a weak local line outrank a better answer from elsewhere.
  const env = nearnessFixture();
  try {
    const here = channelPlaceId('discord', 'here');
    const far = channelPlaceId('other', 'far');
    env.say({
      native: 'far-equal',
      iface: 'other',
      at: NEARNESS_NOW - NEARNESS_DAY,
      text: 'ενα σπιτι',
      place: far,
      scope: groupScope('other'),
    });
    env.say({
      native: 'near-equal',
      at: NEARNESS_NOW - 5 * NEARNESS_DAY,
      text: 'ενα σπιτι',
      place: here,
      scope: groupScope('discord'),
    });
    env.say({
      native: 'far-strong',
      iface: 'other',
      at: NEARNESS_NOW - 9 * NEARNESS_DAY,
      text: 'ενα σπιτι δασκαλου',
      place: far,
      scope: groupScope('other'),
    });
    env.stem();
    fillEnvAudiences(env);
    const found = search(env.db, {
      ctx: { ...groupContext('discord'), audienceColumn: true, destination: here },
      plan: { forms: ['σπιτι', 'δασκαλου'], who: [], from: null, to: null },
      now: NEARNESS_NOW,
      settings: { ...dbSettings({})!, gateShare: 0 },
    });
    assert.deepEqual(
      found.hits.map((hit) => hit.messageId),
      ['far-strong', 'near-equal', 'far-equal']
    );
  } finally {
    env.done();
  }
});

test('an old dated source is still found by its date, and its audience still holds', () => {
  // Bug: a storage move or a short record window silently drops old experience, or age widens who may read it.
  const env = nearnessFixture();
  try {
    const old = NEARNESS_NOW - 400 * NEARNESS_DAY;
    env.say({
      native: 'old-group',
      at: old,
      text: 'ενα σπιτι',
      place: channelPlaceId('discord', 'old'),
      scope: groupScope('discord'),
    });
    env.say({
      native: 'old-private',
      at: old,
      text: 'ενα σπιτι',
      place: dmPlaceId('discord', 'someone'),
      scope: dmScope(personId('discord', 'someone'), 'discord'),
    });
    env.stem();
    fillEnvAudiences(env);
    const found = search(env.db, {
      ctx: { ...groupContext('discord'), audienceColumn: true },
      plan: { forms: ['σπιτι'], who: [], from: old - NEARNESS_DAY, to: old + NEARNESS_DAY },
      now: NEARNESS_NOW,
      settings: { ...dbSettings({})!, gateShare: 0 },
    });
    assert.deepEqual(
      found.hits.map((hit) => hit.messageId),
      ['old-group']
    );
  } finally {
    env.done();
  }
});

// Exact stored source handles and verified native locators use synthetic SQLite evidence.

/**
 * A record row as an older release stored it, with its writer as version step 46 stamped it, and for a private layer
 * the DM place of its partner, which the record's unit context names (storage-context.ts#storageContext).
 */
const recordRows = (rel: string, line: Row): Rows => {
  const partner = /private\/([^/]+)\//.exec(rel)?.[1] ?? null;
  const dmPlace = partner === null ? null : { id: `discord:dm:${partner}`, partnerPerson: null };
  return {
    sources: [
      {
        // The older release's record was Discord's.
        ...recordSourceRow(line, { iface: 'discord', privateAccountId: partner, dmPlace }),
        writer: 'record',
        position: null,
      },
    ],
  };
};
const HANDLES_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const handlesGroup = groupContext('discord');
const handlesRun = (
  env: ReturnType<typeof handlesFixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = handlesGroup
) => search(env.db, { ctx, plan: { forms, who: [], from: null, to: null, ...given }, now: HANDLES_NOW, ...rest });

function handlesStoredObservation(
  env: ReturnType<typeof handlesFixture>,
  {
    key,
    room,
    iface = 'other',
    authority = `${iface}/${room}`,
    text = 'το κουνέλι',
    at = HANDLES_NOW - DAY,
    privatePlace = false,
    revision = 1,
  }: {
    key: string;
    room: string;
    iface?: string;
    authority?: string;
    text?: string;
    at?: number;
    privatePlace?: boolean;
    revision?: number;
  }
) {
  const envelope: Envelope = {
    v: 1,
    iface,
    authority,
    native: { kind: 'message', key, revision },
    place: {
      authority,
      key: room,
      kind: privatePlace ? 'dm' : 'room',
      chat: privatePlace ? 'dm' : 'group',
      ...(privatePlace ? { partner: { key: 'private-partner' } } : {}),
    },
    author: { kind: 'account', key: 'author-42' },
    occurredAt: new Date(at).toISOString(),
    observedAt: new Date(HANDLES_NOW).toISOString(),
    text,
  };
  const result = observe(env.handle, envelope, { now: () => HANDLES_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string') throw new Error('source identity missing');
  const row = env.db.prepare('SELECT place_id, revision FROM sources WHERE id = ?').get(result.sourceId);
  const placeId = row?.place_id;
  if (typeof placeId !== 'string') throw new Error('stored place missing');
  // A stored ref carries its source row's revision, which a quoted line's handle keeps (turn/handles.ts#targetOfSource).
  return { sourceId: result.sourceId, placeId, iface, revision: Number(row?.revision) };
}

for (const secondIface of ['other', 'foreign']) {
  test(`stored source handles preserve both same-native quotes across ${secondIface} place collisions`, () => {
    const env = handlesFixture();
    try {
      const first = handlesStoredObservation(env, {
        key: 'collision-42',
        room: 'room-one',
        text: 'το κουνέλι first-anchor',
      });
      handlesStoredObservation(env, {
        key: 'before-one',
        room: 'room-one',
        at: HANDLES_NOW - DAY - 60_000,
        text: 'first-neighbor',
      });
      const second = handlesStoredObservation(env, {
        key: 'collision-42',
        room: 'room-two',
        iface: secondIface,
        text: 'το κουνέλι second-anchor',
      });
      handlesStoredObservation(env, {
        key: 'before-two',
        room: 'room-two',
        iface: secondIface,
        at: HANDLES_NOW - DAY - 60_000,
        text: 'second-neighbor',
      });
      env.stem();
      const found = handlesRun(env, ['κουνέλι']);
      const messages = found.windows
        .flatMap((one) => one.messages)
        .filter((message) => message.content.includes('anchor'));
      assert.deepEqual(
        messages.map((message) => message.stored?.sourceId).sort(),
        [first.sourceId, second.sourceId].sort()
      );
      const quotes = quotesOf(found.windows, {
        mediaNameOf: noMediaNames,
        render: { labels, timezone: 'UTC' },
        stretchChars: 1500,
      });
      assert.deepEqual(
        quotes
          .flatMap((quote) => quote.entries)
          .filter((entry) => entry.id === 'collision-42')
          .map((entry) => entry.stored)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [first, second].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      );
      for (const [source, neighbor] of [
        [first, 'first-neighbor'],
        [second, 'second-neighbor'],
      ] as const) {
        const expanded = window(env.db, {
          ctx: handlesGroup,
          resolvedAnchor: { kind: 'source', sourceId: source.sourceId },
          move: 'up',
          messages: 1,
        });
        assert.equal(expanded.unknown, false);
        assert.deepEqual(
          expanded.windows.flatMap((one) => one.messages.map((message) => message.content)),
          [neighbor]
        );
      }
    } finally {
      env.done();
    }
  });
}

test('stored source handles fail closed for an ambiguous raw anchor even when only one collision is visible', () => {
  const env = handlesFixture();
  try {
    const hidden = handlesStoredObservation(env, {
      key: 'hidden-first-42',
      room: 'private-room',
      privatePlace: true,
      text: 'hidden-source-marker',
    });
    const visible = handlesStoredObservation(env, {
      key: 'hidden-first-42',
      room: 'visible-room',
      text: 'visible-source-marker',
    });
    handlesStoredObservation(env, {
      key: 'visible-before',
      room: 'visible-room',
      at: HANDLES_NOW - DAY - 60_000,
      text: 'visible-neighbor',
    });
    const raw = window(env.db, { ctx: handlesGroup, anchor: 'hidden-first-42' });
    assert.equal(raw.unknown, true);
    assert.deepEqual(raw.windows, []);
    const exact = window(env.db, {
      ctx: handlesGroup,
      resolvedAnchor: { kind: 'source', sourceId: visible.sourceId },
      move: 'up',
      messages: 1,
    });
    assert.equal(exact.unknown, false);
    const [exactWindow] = exact.windows;
    const [exactMessage] = exactWindow.messages;
    assert.equal(exactMessage.content, 'visible-neighbor');
    const denied = window(env.db, {
      ctx: handlesGroup,
      anchor: visible.sourceId,
      resolvedAnchor: { kind: 'source', sourceId: hidden.sourceId },
    });
    assert.equal(denied.unknown, true);
    assert.deepEqual(denied.windows, []);
  } finally {
    env.done();
  }
});

test('stored source handles resolve opaque exact IDs without falling back to a colliding native namespace', () => {
  const env = handlesFixture();
  try {
    const exact = env.say({ native: 'opaque-native', at: HANDLES_NOW - DAY, text: 'exact-source-marker' });
    env.db.prepare('UPDATE sources SET id = ? WHERE id = ?').run('opaque-source-731', exact);
    env.say({ native: 'opaque-before', at: HANDLES_NOW - DAY - 60_000, text: 'exact-neighbor' });
    handlesStoredObservation(env, { key: 'opaque-source-731', room: 'collision-room', text: 'wrong-source-marker' });
    const raw = window(env.db, { ctx: handlesGroup, anchor: 'opaque-source-731' });
    assert.equal(raw.unknown, true);
    const expanded = window(env.db, {
      ctx: handlesGroup,
      resolvedAnchor: { kind: 'source', sourceId: 'opaque-source-731' },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    const [expandedWindow] = expanded.windows;
    const [expandedMessage] = expandedWindow.messages;
    assert.equal(expandedMessage.content, 'exact-neighbor');
    const missing = window(env.db, {
      ctx: handlesGroup,
      anchor: 'opaque-native',
      resolvedAnchor: { kind: 'source', sourceId: 'missing-source' },
    });
    assert.equal(missing.unknown, true);
    assert.deepEqual(missing.windows, []);
  } finally {
    env.done();
  }
});

test('stored source handles follow a reply parent only in the originating place', () => {
  const env = handlesFixture();
  try {
    handlesStoredObservation(env, {
      key: 'parent-42',
      room: 'wrong-room',
      at: HANDLES_NOW - DAY - 10 * 60_000,
      text: 'foreign-parent-marker',
    });
    handlesStoredObservation(env, {
      key: 'parent-42',
      room: 'reply-room',
      at: HANDLES_NOW - DAY - 10 * 60_000,
      text: 'own-parent-marker',
    });
    const reply = handlesStoredObservation(env, {
      key: 'reply-42',
      room: 'reply-room',
      text: 'το κουνέλι reply-marker',
    });
    env.db.prepare('UPDATE sources SET reply_to = ? WHERE id = ?').run('parent-42', reply.sourceId);
    env.stem();
    const found = handlesRun(env, ['κουνέλι'], {
      settings: { ...dbSettings({})!, recordContext: 0, followMessages: 0 },
    });
    const text = found.windows.flatMap((one) => one.messages.map((message) => message.content));
    assert.ok(text.includes('own-parent-marker'));
    assert.equal(text.includes('foreign-parent-marker'), false);
  } finally {
    env.done();
  }
});

test('stored source handles qualify mapped DM anchors by the actual chat rather than the partner', () => {
  const env = handlesFixture();
  try {
    for (const [id, offset] of [
      ['mapped-before', 60_000],
      ['mapped-anchor', 0],
    ] as const) {
      const event = lineEvent({
        id,
        chatId: 'actual-dm-73',
        authorId: 'partner-42',
        text: `το κουνέλι ${id}`,
        at: HANDLES_NOW - DAY - offset,
      });
      event.chat = { id: 'actual-dm-73', kind: 'dm', rootId: null, partnerId: 'partner-42' };
      const envelope = observationOf(event);
      assert.ok(envelope);
      assert.equal(observe(env.handle, envelope, { now: () => HANDLES_NOW }).ok, true);
    }
    env.stem();
    const ctx = internalContext();
    const found = handlesRun(env, ['κουνέλι'], {}, ctx);
    const anchor = found.windows.flatMap((one) => one.messages).find((message) => message.id === 'mapped-anchor');
    assert.deepEqual(anchor?.stored?.native, {
      iface: 'fake',
      chatId: 'actual-dm-73',
      messageId: 'mapped-anchor',
    });
    const expanded = window(env.db, {
      ctx,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'actual-dm-73', messageId: 'mapped-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    const [expandedWindow] = expanded.windows;
    const [expandedMessage] = expandedWindow.messages;
    assert.equal(expandedMessage.id, 'mapped-before');
    const guessed = window(env.db, {
      ctx,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'partner-42', messageId: 'mapped-anchor' },
      },
    });
    assert.equal(guessed.unknown, true);
  } finally {
    env.done();
  }
});

test('stored source handles qualify legacy DM records using their recorded chat', () => {
  const env = handlesFixture();
  try {
    for (const [messageId, offset] of [
      ['legacy-before', 60_000],
      ['legacy-anchor', 0],
    ] as const) {
      insertRows(
        env.db,
        recordRows('private/partner-42/record/2026-10/2026-10-23.jsonl', {
          v: 1,
          id: `record-${messageId}`,
          kind: 'seen',
          messageId,
          revision: 1,
          occurredAt: new Date(HANDLES_NOW - DAY - offset).toISOString(),
          recordedAt: new Date(HANDLES_NOW).toISOString(),
          placeId: 'g1',
          scope: { channel: 'legacy-dm-73' },
          by: 'partner-42',
          text: `το κουνέλι ${messageId}`,
          origin: 'live',
        })
      );
    }
    env.stem();
    const ctx = internalContext();
    const found = handlesRun(env, ['κουνέλι'], {}, ctx);
    const anchor = found.windows.flatMap((one) => one.messages).find((message) => message.id === 'legacy-anchor');
    assert.deepEqual(anchor?.stored?.native, {
      iface: 'discord',
      chatId: 'legacy-dm-73',
      messageId: 'legacy-anchor',
    });
    const expanded = window(env.db, {
      ctx,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'discord', chatId: 'legacy-dm-73', messageId: 'legacy-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    const [expandedWindow] = expanded.windows;
    const [expandedMessage] = expandedWindow.messages;
    assert.equal(expandedMessage.id, 'legacy-before');
  } finally {
    env.done();
  }
});

test('stored source handles do not turn generic observation keys or opaque places into native locators', () => {
  const env = handlesFixture();
  try {
    const source = handlesStoredObservation(env, {
      key: 'room:42:message:73',
      room: 'opaque-room-731',
      text: 'το κουνέλι generic-marker',
    });
    handlesStoredObservation(env, {
      key: 'generic-before',
      room: 'opaque-room-731',
      at: HANDLES_NOW - DAY - 60_000,
      text: 'generic-neighbor',
    });
    env.stem();
    const found = handlesRun(env, ['κουνέλι']);
    const [firstWindow] = found.windows;
    assert.deepEqual(
      firstWindow.messages.find((message) => message.content.includes('generic-marker'))?.stored,
      source
    );
    const expanded = window(env.db, {
      ctx: handlesGroup,
      resolvedAnchor: { kind: 'source', sourceId: source.sourceId },
      move: 'up',
      messages: 1,
    });
    const [expandedWindow] = expanded.windows;
    const [expandedMessage] = expandedWindow.messages;
    assert.equal(expandedMessage.content, 'generic-neighbor');
    const guessed = window(env.db, {
      ctx: handlesGroup,
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'other', chatId: 'opaque-room-731', messageId: 'room:42:message:73' },
      },
    });
    assert.equal(guessed.unknown, true);
    assert.deepEqual(guessed.windows, []);
  } finally {
    env.done();
  }
});

function locatorEvent(id: string, chatId: string, offset = 0) {
  const event = lineEvent({
    id,
    chatId,
    authorId: 'partner-42',
    text: `το κουνέλι ${id}`,
    at: HANDLES_NOW - DAY - offset,
  });
  event.chat = { id: chatId, kind: 'dm', rootId: null, partnerId: 'partner-42' };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid protocol fixture was refused');
  return envelope;
}

test('stored source locators recognize historic unmarked DM records through their mapper provenance', () => {
  const env = handlesFixture();
  try {
    for (const [messageId, offset] of [
      ['historic-before', 60_000],
      ['historic-anchor', 0],
    ] as const) {
      const rows = recordRows('private/partner-42/record/2026-10/2026-10-23.jsonl', {
        v: 1,
        id: `record-${messageId}`,
        kind: 'seen',
        messageId,
        revision: 1,
        occurredAt: new Date(HANDLES_NOW - DAY - offset).toISOString(),
        recordedAt: new Date(HANDLES_NOW).toISOString(),
        placeId: 'g1',
        scope: { channel: 'historic-dm-73' },
        by: 'partner-42',
        text: `το κουνέλι ${messageId}`,
        origin: 'live',
      });
      for (const source of rows.sources ?? []) {
        if (typeof source.extra !== 'string') throw new Error('record fixture metadata missing');
        const extra = JSON.parse(source.extra) as Record<string, unknown>;
        delete extra.$messageLocator;
        source.extra = JSON.stringify(extra);
      }
      insertRows(env.db, rows);
    }
    env.stem();
    const found = handlesRun(env, ['κουνέλι'], {}, internalContext());
    const message = found.windows.flatMap((one) => one.messages).find((one) => one.id === 'historic-anchor');
    assert.deepEqual(message?.stored?.native, {
      iface: 'discord',
      chatId: 'historic-dm-73',
      messageId: 'historic-anchor',
    });
    const expanded = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'discord', chatId: 'historic-dm-73', messageId: 'historic-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(expanded.unknown, false);
    const [expandedWindow] = expanded.windows;
    const [expandedMessage] = expandedWindow.messages;
    assert.equal(expandedMessage.id, 'historic-before');
  } finally {
    env.done();
  }
});

test('stored source handles keep a current revision when another place has a higher revision of the same native key', () => {
  const env = handlesFixture();
  try {
    const first = handlesStoredObservation(env, {
      key: 'revision-collision',
      room: 'revision-one',
      text: 'το κουνέλι first-revision-place',
    });
    const second = handlesStoredObservation(env, {
      key: 'revision-collision',
      room: 'revision-two',
      revision: 2,
      text: 'το κουνέλι second-revision-place',
    });
    env.stem();
    const found = handlesRun(env, ['κουνέλι']);
    assert.deepEqual(found.hits.map((hit) => hit.id).sort(), [first.sourceId, second.sourceId].sort());
  } finally {
    env.done();
  }
});

test('stored source handles apply a legacy deletion only to its own place despite a colliding native key', () => {
  const env = handlesFixture();
  try {
    const surviving = handlesStoredObservation(env, {
      key: 'deleted-collision',
      room: 'surviving-room',
      iface: 'discord',
      text: 'το κουνέλι surviving-place-marker',
    });
    env.say({ native: 'deleted-collision', at: HANDLES_NOW - DAY, text: 'το κουνέλι deleted-place-marker' });
    const rows = recordRows('record/2026-10/2026-10-24.jsonl', {
      v: 1,
      id: 'legacy-deletion',
      kind: 'deleted',
      messageId: 'deleted-collision',
      occurredAt: new Date(HANDLES_NOW).toISOString(),
      recordedAt: new Date(HANDLES_NOW).toISOString(),
      placeId: 'g1',
      scope: { channel: 'main' },
      participants: [],
      sourceMessageIds: ['deleted-collision'],
      origin: 'live',
    });
    insertRows(env.db, rows);
    // Historic deletion rows predate the observation identity columns.
    env.db.prepare("UPDATE sources SET authority_id = NULL, native_kind = NULL WHERE kind = 'deleted'").run();
    const deletion = env.db.prepare("SELECT authority_id, native_kind FROM sources WHERE kind = 'deleted'").get();
    assert.deepEqual({ ...deletion }, { authority_id: null, native_kind: null });
    env.stem();
    const found = handlesRun(env, ['κουνέλι']);
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      [surviving.sourceId]
    );
    assert.equal(JSON.stringify(found.windows).includes('deleted-place-marker'), false);
  } finally {
    env.done();
  }
});

test('a qualified native window ignores unrelated malformed source metadata without granting it a route', () => {
  const env = handlesFixture();
  try {
    for (const [id, offset] of [
      ['json-before', 60_000],
      ['json-anchor', 0],
    ] as const) {
      assert.equal(observe(env.handle, locatorEvent(id, 'valid-dm', offset), { now: () => HANDLES_NOW }).ok, true);
    }
    const malformed = observe(env.handle, locatorEvent('json-malformed', 'unrelated-dm', 120_000), {
      now: () => HANDLES_NOW,
    });
    assert.equal(malformed.ok, true);
    if (typeof malformed.sourceId !== 'string') throw new Error('malformed-metadata fixture has no source ID');
    env.db.prepare('UPDATE sources SET extra = ? WHERE id = ?').run('{invalid-json', malformed.sourceId);
    const found = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'valid-dm', messageId: 'json-anchor' },
      },
      move: 'up',
      messages: 1,
    });
    assert.equal(found.unknown, false);
    assert.deepEqual(
      found.windows.flatMap((one) => one.messages.map((message) => message.id)),
      ['json-before']
    );
    const unroutable = window(env.db, {
      ctx: internalContext(),
      resolvedAnchor: {
        kind: 'native',
        locator: { iface: 'fake', chatId: 'unrelated-dm', messageId: 'json-malformed' },
      },
    });
    assert.equal(unroutable.unknown, true);
    assert.deepEqual(unroutable.windows, []);
  } finally {
    env.done();
  }
});

test("a window's chat id is the native id its place row holds, whatever the place id spells", () => {
  // Bug: the chat of a window was cut out of the place id, so a place of another interface or with an opaque id named
  // its stored id where an interface expects its own chat id.
  const env = handlesFixture();
  try {
    const stored = handlesStoredObservation(env, {
      key: 'chat-of-row',
      room: 'room-native',
      text: 'το κουνέλι chat-anchor',
    });
    env.stem();
    const result = handlesRun(env, ['κουνέλι'], {}, groupContext('other'));
    const [one] = result.windows;
    const [first] = one?.messages ?? [];
    assert.equal(one?.placeId, 'room-native');
    assert.equal(first?.stored?.placeId, stored.placeId);
  } finally {
    env.done();
  }
});

// Recall over the memory database (src/memory/db/recall.ts), on synthetic Greek and accented Latin text: inflected
// forms, phrases, the trigram fallback, fusion, date ranking, scope filtering with the hidden marker, and window reads
// at the edges and across a hidden line.

// The runner answers more than its types name (the quotes, the hidden marker and the outcome the tests read), so it is
// read through the shape the tests use.
type RecallInput = Parameters<typeof createRecall>[0];
const asRecall = (input: object) =>
  createRecall({ iface: 'discord', mediaNameOf: noMediaNames, ...input } as RecallInput) as unknown as {
    recallRun(args: Record<string, unknown>): Promise<Found>;
    window(args: Record<string, unknown>): Promise<Found>;
    prefetch(args: Record<string, unknown>): Promise<{ status?: string } | null>;
  };

type Found = {
  outcome: { kind: string; degraded?: boolean };
  quotes: Array<{
    channelName: string;
    lines: string;
    entries: Array<{
      id: string;
      message: { authorName: string; attachments: Array<{ id: string; kind: string; name: string }> };
    }>;
  }>;
  hidden: boolean;
};
const RECALL_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MAIN = channelPlaceId('discord', 'main');
const OTHER = channelPlaceId('discord', 'other');
const RECALL_ALICE = 'u-alice';
const RECALL_BOB = 'u-bob';
const CAROL = 'u-carol';
const recallGroup = groupContext('discord');
const ids = (result: { hits: Array<{ messageId: unknown }> }) => result.hits.map((hit) => hit.messageId);
const recallRun = (
  env: ReturnType<typeof recallFixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = recallGroup
) => search(env.db, { ctx, plan: plan(forms, given), now: RECALL_NOW, ...rest });

test('words: an inflected form finds the line with another form of the word, an accent or a case does not matter', () => {
  const env = recallFixture();
  try {
    env.say({ native: 'm1', at: RECALL_NOW - 3 * DAY, text: 'Ο δάσκαλος του σπίτου ήρθε' });
    env.say({ native: 'm2', at: RECALL_NOW - 2 * DAY, text: 'το σπιτος ειναι μεγαλο' });
    env.say({ native: 'm3', at: RECALL_NOW - DAY, text: 'Un café très chaud, des cafés, le CAFÉ du matin' });
    env.say({ native: 'm4', at: RECALL_NOW - DAY, text: 'ούτε λέξη εδώ', place: OTHER });
    env.say({ native: 'm5', at: RECALL_NOW - 4 * DAY, text: 'των σπιτων', place: OTHER });
    env.stem();
    const greek = recallRun(env, ['σπιτοι']);
    assert.deepEqual(ids(greek).sort(), ['m1', 'm2', 'm5']);
    const [greekHit] = greek.hits;
    assert.deepEqual(greekHit.streams, ['words']);
    assert.deepEqual(ids(recallRun(env, ['ΉΡΘΕ'])), ['m1'], 'case and accent do not matter');
    const latin = recallRun(env, ['Cafe']);
    assert.deepEqual(ids(latin), ['m3']);
    assert.equal(latin.windows.length, 1);
    const [latinWindow] = latin.windows;
    assert.ok(latinWindow.messages.some((message) => message.id === 'm3'));
  } finally {
    env.done();
  }
});

test('words: a form of several words is a phrase and matches only the words side by side in order', () => {
  const env = recallFixture();
  try {
    env.say({ native: 'p1', at: RECALL_NOW - 5 * DAY, text: 'το μεγαλο σπιτι του δασκαλου', place: MAIN });
    env.say({ native: 'p2', at: RECALL_NOW - 4 * DAY, text: 'του δασκαλου το σπιτι', place: OTHER });
    env.say({
      native: 'p3',
      at: RECALL_NOW - 3 * DAY,
      text: 'ένα σπιτι και ένας δασκαλος',
      place: channelPlaceId('discord', 'third'),
    });
    env.stem();
    const result = recallRun(env, ['σπιτι του δασκαλου']);
    assert.deepEqual(ids(result), ['p1']);
    const [firstHit] = result.hits;
    assert.equal(firstHit.phrases, 1);
  } finally {
    env.done();
  }
});

test('trigram: a part of a word the stems do not hold is found by its letters, and says so', () => {
  const env = recallFixture();
  try {
    env.say({ native: 't1', at: RECALL_NOW - 2 * DAY, text: 'η παρακαλουσα ηρθε αργα' });
    env.say({ native: 't2', at: RECALL_NOW - DAY, text: 'οι ευχαριστιες μας', place: OTHER });
    env.stem();
    const parts = recallRun(env, ['ρακαλου']);
    assert.deepEqual(ids(parts), ['t1']);
    const [firstHit] = parts.hits;
    assert.deepEqual(firstHit.streams, ['trigram']);
    assert.equal(parts.stats.words, 0);
    // A form the words find is not searched by letters.
    const whole = recallRun(env, ['ευχαριστιες']);
    assert.deepEqual(
      whole.hits.map((hit) => hit.streams),
      [['words']]
    );
    assert.equal(whole.stats.trigram, 0);
    // Under three letters there is no trigram.
    assert.deepEqual(ids(recallRun(env, ['ηρ'])), []);
  } finally {
    env.done();
  }
});

test('fusion: a line found by two streams outranks lines found by one, and every hit says which streams found it', () => {
  const env = recallFixture();
  try {
    const at = RECALL_NOW - 2 * DAY;
    env.say({ native: 'f-words', at, text: 'το σπιτι του δασκαλου', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'f-meaning', at, text: 'τιποτα κοινο', place: channelPlaceId('discord', 'c2') });
    env.say({ native: 'f-both', at, text: 'ο δασκαλος και το σπιτι', place: channelPlaceId('discord', 'c3') });
    env.say({ native: 'f-far', at, text: 'ασχετο κειμενο', place: channelPlaceId('discord', 'c4') });
    env.stem();
    env.vector('f-meaning', [1, 0, 0, 0]);
    env.vector('f-both', [0.9, 0.3, 0, 0]);
    env.vector('f-far', [0, 0, 1, 0]);
    const found = search(env.db, {
      ctx: recallGroup,
      plan: plan(['σπιτι', 'δασκαλου']),
      vector: [1, 0, 0, 0],
      now: RECALL_NOW,
      settings: { ...dbSettings({})!, gateShare: 0, minMeaning: 0.5 },
    });
    assert.deepEqual(ids(found), ['f-both', 'f-words', 'f-meaning']);
    const byId = new Map(found.hits.map((hit) => [hit.messageId, hit]));
    assert.deepEqual(byId.get('f-both')!.streams, ['words', 'meaning']);
    assert.deepEqual(byId.get('f-words')!.streams, ['words']);
    assert.deepEqual(byId.get('f-meaning')!.streams, ['meaning']);
    assert.ok(byId.get('f-both')!.score > byId.get('f-words')!.score);
    assert.ok(byId.get('f-both')!.cosine! > 0.9 && byId.get('f-words')!.cosine === null);
    assert.equal(found.stats.meaning, 2, 'the line under the cosine floor is no meaning hit');
  } finally {
    env.done();
  }
});

test('gate: a hit far below the best is dropped', () => {
  const env = recallFixture();
  try {
    const at = RECALL_NOW - DAY;
    env.say({ native: 'g1', at, text: 'σπιτι', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'g2', at, text: 'ενα ασχετο μηνυμα', place: channelPlaceId('discord', 'c2') });
    env.stem();
    env.vector('g1', [1, 0, 0, 0]);
    env.vector('g2', [0.6, 0.8, 0, 0]);
    const loose = search(env.db, {
      ctx: recallGroup,
      plan: plan(['σπιτι']),
      vector: [1, 0, 0, 0],
      now: RECALL_NOW,
      settings: { ...dbSettings({})!, gateShare: 0, minMeaning: 0 },
    });
    assert.deepEqual(ids(loose).sort(), ['g1', 'g2']);
    const strict = search(env.db, {
      ctx: recallGroup,
      plan: plan(['σπιτι']),
      vector: [1, 0, 0, 0],
      now: RECALL_NOW,
      settings: { ...dbSettings({})!, gateShare: 0.9, minMeaning: 0 },
    });
    assert.deepEqual(ids(strict), ['g1']);
  } finally {
    env.done();
  }
});

test('date ranking: among relevant lines the nearest to the asked range comes first, else the newest', () => {
  const env = recallFixture();
  try {
    const day = (n: number) => RECALL_NOW - n * DAY;
    env.say({ native: 'd-old', at: day(30), text: 'το σπιτι', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'd-mid', at: day(15), text: 'το σπιτι', place: channelPlaceId('discord', 'c2') });
    env.say({ native: 'd-new', at: day(1), text: 'το σπιτι', place: channelPlaceId('discord', 'c3') });
    env.stem();
    assert.deepEqual(ids(recallRun(env, ['σπιτι'])), ['d-new', 'd-mid', 'd-old'], 'no date: toward now');
    const aimed = recallRun(env, ['σπιτι'], { plan: { from: day(33), to: day(27) } });
    assert.deepEqual(ids(aimed), ['d-old'], 'the range bounds the search');
    const wide = recallRun(env, ['σπιτι'], { plan: { from: day(35), to: day(5) } });
    assert.deepEqual(ids(wide), ['d-mid', 'd-old'], 'the middle of the range first');
    const open = recallRun(env, ['σπιτι'], { plan: { from: day(16) } });
    assert.deepEqual(ids(open), ['d-mid', 'd-new'], 'an open range: toward its given end');
    const oldFirst = recallRun(env, ['σπιτι'], { plan: { to: day(29) } });
    assert.deepEqual(ids(oldFirst), ['d-old']);
  } finally {
    env.done();
  }
});

test('people: a member named by the plan locates their lines; a name that is no account is searched as a word', () => {
  const env = recallFixture();
  try {
    env.account(RECALL_ALICE, ['Αλίκη']);
    env.account(RECALL_BOB, ['Βασίλης']);
    env.say({
      native: 'w1',
      at: RECALL_NOW - 2 * DAY,
      text: 'καλημερα σε ολους',
      author: RECALL_ALICE,
      place: channelPlaceId('discord', 'c1'),
    });
    env.say({
      native: 'w2',
      at: RECALL_NOW - DAY,
      text: 'καλησπερα',
      author: RECALL_BOB,
      place: channelPlaceId('discord', 'c2'),
    });
    env.say({
      native: 'w3',
      at: RECALL_NOW - DAY,
      text: 'ο Νικος ηρθε',
      author: RECALL_BOB,
      place: channelPlaceId('discord', 'c3'),
    });
    env.stem();
    const alice = search(env.db, {
      ctx: recallGroup,
      plan: { forms: [], who: ['αλικη'], from: null, to: null },
      now: RECALL_NOW,
    });
    assert.deepEqual(ids(alice), ['w1']);
    const [aliceHit] = alice.hits;
    assert.deepEqual(aliceHit.streams, ['people']);
    const unknown = search(env.db, {
      ctx: recallGroup,
      plan: { forms: [], who: ['νικος'], from: null, to: null },
      now: RECALL_NOW,
    });
    assert.deepEqual(ids(unknown), ['w3']);
  } finally {
    env.done();
  }
});

test("stretches: reply chain, neighbours and the followed chat come with a hit, and the turn's own lines stay out", () => {
  const env = recallFixture();
  try {
    const minute = (n: number) => RECALL_NOW - 3 * DAY + n * 60000;
    for (let i = 0; i < 12; i += 1)
      env.say({
        native: `s${i}`,
        at: minute(i),
        text: i === 6 ? 'το σπιτι του δασκαλου' : `γραμμη ${i}`,
        replyTo: i === 6 ? 's1' : null,
      });
    env.say({ native: 'later', at: minute(12) + 3 * 3600000, text: 'πολυ αργοτερα' });
    env.stem();
    const result = search(env.db, {
      ctx: recallGroup,
      plan: plan(['σπιτι']),
      now: RECALL_NOW,
      settings: { ...dbSettings({})!, recordContext: 2, followMessages: 3, followGapMinutes: 5 },
      exclude: new Set(['s5']),
    });
    assert.equal(result.windows.length, 1);
    const [one] = result.windows;
    assert.deepEqual(
      one.messages.map((message) => message.id),
      ['s1', 's4', 's6', 's7', 's8', 's9', 's10', 's11']
    );
    assert.deepEqual([...one.hitIds], ['s6']);
    assert.equal(one.overlapsChat, true);
    assert.ok(!one.messages.some((message) => message.id === 'later'), 'a long silence ends the followed chat');
    assert.equal(one.placeId, 'main');
  } finally {
    env.done();
  }
});

test('revisions: only the newest revision of a message is searched and shown, a deleted message is gone', () => {
  const env = recallFixture();
  try {
    env.say({ native: 'e1', at: RECALL_NOW - DAY, text: 'παλιο σπιτι', revision: 1 });
    env.say({ native: 'e1', at: RECALL_NOW - DAY, text: 'νεο δασκαλος', revision: 2 });
    env.say({ native: 'e2', at: RECALL_NOW - DAY + 1000, text: 'σβησμενο σπιτι', place: OTHER });
    env.deleted('e2', RECALL_NOW - DAY + 2000);
    env.db.prepare("UPDATE sources SET place_id = ? WHERE native_id = 'e2'").run(MAIN);
    env.stem();
    assert.deepEqual(ids(recallRun(env, ['σπιτι'])), []);
    const now = recallRun(env, ['δασκαλος']);
    assert.deepEqual(ids(now), ['e1']);
    const [nowWindow] = now.windows;
    const [nowMessage] = nowWindow.messages;
    assert.equal(nowMessage.editedAt !== null, true);
  } finally {
    env.done();
  }
});

test('scope: a DM line is never in a group result; the group is told a better match exists, without text or count', () => {
  const env = recallFixture();
  try {
    const secret = 'μυστικο σπιτι του δασκαλου';
    env.say({ native: 'g1', at: RECALL_NOW - 2 * DAY, text: 'ενα σπιτι εδω', place: channelPlaceId('discord', 'c1') });
    env.say({
      native: 'dm1',
      at: RECALL_NOW - DAY,
      text: secret,
      place: dmPlaceId('discord', RECALL_ALICE),
      scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord'),
    });
    env.say({
      native: 'dm2',
      at: RECALL_NOW - DAY,
      text: `${secret} ξανα`,
      place: dmPlaceId('discord', RECALL_ALICE),
      scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord'),
    });
    env.stem();
    const asking = { ...recallGroup, asker: [recallPersonId('discord', RECALL_ALICE)] };
    const result = recallRun(env, ['σπιτι του δασκαλου'], {}, asking);
    assert.equal(result.hidden, true);
    assert.equal(recallRun(env, ['σπιτι του δασκαλου']).hidden, false, 'a context with no asker is told nothing');
    assert.deepEqual(
      ids(result),
      [],
      'the phrase is only in the DM; the lone word of the group does not match the phrase'
    );
    const wide = recallRun(env, ['σπιτι', 'δασκαλου'], {}, asking);
    assert.deepEqual(ids(wide), ['g1']);
    assert.equal(wide.hidden, true);
    const dump = JSON.stringify({ windows: wide.windows, hits: wide.hits, stats: wide.stats });
    assert.ok(!dump.includes('μυστικο') && !dump.includes('dm1') && !dump.includes('dm2'));
    assert.deepEqual(Object.keys(wide.stats).sort(), ['meaning', 'people', 'trigram', 'words']);
    assert.equal(wide.stats.words, 1, 'the DM lines are not counted');
    // The partner of the DM reads it in their DM, and sees no marker.
    const own = search(env.db, {
      ctx: dmOfMember(RECALL_ALICE),
      plan: plan(['σπιτι του δασκαλου']),
      now: RECALL_NOW,
    });
    assert.deepEqual(ids(own).sort(), ['dm1', 'dm2']);
    assert.equal(own.hidden, false);
    // Someone else's DM and the internal context.
    const other = search(env.db, {
      ctx: dmOfMember(RECALL_BOB),
      plan: plan(['σπιτι του δασκαλου']),
      now: RECALL_NOW,
    });
    assert.deepEqual(ids(other), []);
    assert.equal(other.hidden, false, 'only a group is told about a DM');
    const inside = search(env.db, { ctx: internalContext(), plan: plan(['σπιτι του δασκαλου']), now: RECALL_NOW });
    assert.deepEqual(ids(inside).sort(), ['dm1', 'dm2']);
    assert.throws(() => search(env.db, { plan: plan(['σπιτι']), now: RECALL_NOW }), /scope context/);
  } finally {
    env.done();
  }
});

test('scope: no marker when the group has the better match, and the meaning stream stays inside the scope too', () => {
  const env = recallFixture();
  try {
    env.say({ native: 'g1', at: RECALL_NOW - 2 * DAY, text: 'σπιτι δασκαλου', place: channelPlaceId('discord', 'c1') });
    env.say({
      native: 'dm1',
      at: RECALL_NOW - DAY,
      text: 'σπιτι',
      place: dmPlaceId('discord', RECALL_ALICE),
      scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord'),
    });
    env.say({
      native: 'dm2',
      at: RECALL_NOW - DAY,
      text: 'κανενα κοινο',
      place: dmPlaceId('discord', RECALL_ALICE),
      scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord'),
    });
    env.stem();
    env.vector('dm2', [1, 0, 0, 0], { scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord') });
    const result = search(env.db, {
      ctx: recallGroup,
      plan: plan(['σπιτι', 'δασκαλου']),
      vector: [1, 0, 0, 0],
      now: RECALL_NOW,
      settings: { ...dbSettings({})!, gateShare: 0, minMeaning: 0 },
    });
    assert.deepEqual(ids(result), ['g1']);
    assert.equal(result.hidden, false, 'the group line matches more than the DM one');
    assert.equal(result.stats.meaning, 0, 'a DM vector is not scanned for a group');
  } finally {
    env.done();
  }
});

test('window: up and down from an anchor in time order, the anchor left out, edges reported', () => {
  const env = recallFixture();
  try {
    for (let i = 1; i <= 10; i += 1)
      env.say({ native: `w${i}`, at: RECALL_NOW - (11 - i) * 60000, text: `γραμμη ${i}` });
    env.stem();
    const idsOf = (result: { windows: Array<{ messages: Array<{ id: unknown }> }> }) =>
      result.windows.flatMap((one) => one.messages.map((message) => message.id));
    const up = window(env.db, { ctx: recallGroup, anchor: 'w5', move: 'up', messages: 3 });
    assert.deepEqual(idsOf(up), ['w2', 'w3', 'w4']);
    assert.equal(up.stopped, null);
    const down = window(env.db, { ctx: recallGroup, anchor: 'w5', move: 'down', messages: 3 });
    assert.deepEqual(idsOf(down), ['w6', 'w7', 'w8']);
    const top = window(env.db, { ctx: recallGroup, anchor: 'w2', move: 'up', messages: 5 });
    assert.deepEqual(idsOf(top), ['w1']);
    assert.equal(top.stopped, 'edge');
    const none = window(env.db, { ctx: recallGroup, anchor: 'w1', move: 'up', messages: 5 });
    assert.deepEqual(none.windows, []);
    assert.equal(none.stopped, 'edge');
    assert.equal(none.unknown, false);
    const bottom = window(env.db, { ctx: recallGroup, anchor: 'w9', move: 'down', messages: 5 });
    assert.deepEqual(idsOf(bottom), ['w10']);
    assert.equal(bottom.stopped, 'edge');
    // By source id, by minutes: the lines within two minutes before w5.
    const bySource = window(env.db, {
      ctx: recallGroup,
      anchor: messageSourceId('discord', 'w5', 1, 'seen'),
      move: 'up',
      minutes: 2,
    });
    assert.deepEqual(idsOf(bySource), ['w3', 'w4']);
    // Both limits: the smaller wins.
    assert.deepEqual(idsOf(window(env.db, { ctx: recallGroup, anchor: 'w9', move: 'up', minutes: 5, messages: 2 })), [
      'w7',
      'w8',
    ]);
    // An unknown anchor.
    assert.equal(window(env.db, { ctx: recallGroup, anchor: 'nope', move: 'up', messages: 2 }).unknown, true);
    assert.equal(window(env.db, { ctx: recallGroup, anchor: '', move: 'up', messages: 2 }).unknown, true);
    assert.throws(() => window(env.db, { anchor: 'w5', move: 'up' }), /scope context/);
  } finally {
    env.done();
  }
});

test('window: a line the context may not open ends the read there and is never counted or shown', () => {
  const env = recallFixture();
  try {
    for (let i = 1; i <= 8; i += 1) {
      const hiddenLine = i === 4;
      env.say({
        native: `h${i}`,
        at: RECALL_NOW - (9 - i) * 60000,
        text: hiddenLine ? 'κρυφη γραμμη' : `γραμμη ${i}`,
        ...(hiddenLine ? { scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord') } : {}),
      });
    }
    env.stem();
    const idsOf = (result: { windows: Array<{ messages: Array<{ id: unknown }> }> }) =>
      result.windows.flatMap((one) => one.messages.map((message) => message.id));
    const up = window(env.db, { ctx: recallGroup, anchor: 'h6', move: 'up', messages: 5 });
    assert.deepEqual(idsOf(up), ['h5']);
    assert.equal(up.stopped, 'hidden');
    const down = window(env.db, { ctx: recallGroup, anchor: 'h2', move: 'down', messages: 5 });
    assert.deepEqual(idsOf(down), ['h3']);
    assert.equal(down.stopped, 'hidden');
    assert.ok(!JSON.stringify([up, down]).includes('κρυφη'));
    // The partner of that DM reads straight through.
    const through = window(env.db, {
      ctx: dmOfMember(RECALL_ALICE),
      anchor: 'h6',
      move: 'up',
      messages: 5,
    });
    assert.deepEqual(idsOf(through), ['h1', 'h2', 'h3', 'h4', 'h5']);
    // A hidden anchor is unknown, as if it did not exist.
    assert.equal(window(env.db, { ctx: recallGroup, anchor: 'h4', move: 'up', messages: 2 }).unknown, true);
    // A hit's stretch stops at the hidden line too.
    const found = search(env.db, {
      ctx: recallGroup,
      plan: plan(['γραμμη']),
      now: RECALL_NOW,
      limit: 1,
      settings: { ...dbSettings({})!, recordContext: 3 },
    });
    assert.ok(!JSON.stringify(found.windows).includes('κρυφη'));
  } finally {
    env.done();
  }
});

test('quotes: windows become the stretches recall returns, with entries per line', () => {
  const env = recallFixture();
  try {
    env.account(RECALL_ALICE, ['Αλίκη']);
    env.say({ native: 'q1', at: Date.parse('2026-10-20T10:00:00.000Z'), text: 'το σπιτι του δασκαλου' });
    env.say({ native: 'q2', at: Date.parse('2026-10-20T10:01:00.000Z'), text: 'ναι ακριβως', author: RECALL_BOB });
    env.stem();
    const found = recallRun(env, ['σπιτι']);
    const quotes = quotesOf(found.windows, {
      mediaNameOf: noMediaNames,
      render: { labels, timezone: 'UTC', selfName: 'Ζ' },
      stretchChars: 1500,
    });
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].placeId, 'main');
    assert.equal(quotes[0].startTs, Date.parse('2026-10-20T10:00:00.000Z'));
    const [firstQuote] = quotes;
    assert.deepEqual(
      firstQuote.entries.map((entry) => entry.id),
      ['q1', 'q2']
    );
    assert.ok(firstQuote.lines.includes('Αλίκη') && firstQuote.lines.includes('το σπιτι του δασκαλου'));
    assert.deepEqual(quotesOf([], { mediaNameOf: noMediaNames, render: {}, stretchChars: 1500 }), []);
  } finally {
    env.done();
  }
});

// ---------- the runner and the tool over the database ----------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// PR 7c: the shipped settings live in config/config.json.
const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
const { tools: labelTools } = labels.tools;
const withHidden = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: { ...labelTools, memory: { ...labelTools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
  },
};

/**
 * A runner over a fake guild (#general c1, #secret c4 that @everyone cannot see) and the fixture database, whose
 * places rows hold both channels and Bob's DM (`places: false`: none; the runner's place rule reads them).
 */
function runner(
  env: ReturnType<typeof recallFixture>,
  {
    open = true,
    meaning = false,
    embed = null,
    places = true,
  }: {
    open?: boolean;
    meaning?: boolean;
    embed?: ((texts: Array<string>, options: { purpose: string }) => Promise<Array<Float32Array>>) | null;
    places?: boolean;
  } = {}
) {
  // PR 7d: every context reads through `audience_id`, so the rows the fixture wrote carry it.
  fillEnvAudiences(env);
  if (places) {
    insertRows(
      env.db,
      {
        places: [
          {
            id: channelPlaceId('discord', 'c1'),
            iface: 'discord',
            kind: 'channel',
            native_id: 'c1',
            scope_kind: 'group',
            name: 'general',
          },
          {
            id: channelPlaceId('discord', 'c4'),
            iface: 'discord',
            kind: 'channel',
            native_id: 'c4',
            scope_kind: 'group',
            name: 'secret',
          },
          {
            id: dmPlaceId('discord', RECALL_BOB),
            iface: 'discord',
            kind: 'dm',
            native_id: null,
            scope_kind: 'dm',
            partner_person: recallPersonId('discord', RECALL_BOB),
          },
        ],
      },
      { log: { info() {}, debug() {}, warn() {}, error() {} } }
    );
  }
  // #general (c1) and #secret (c4), which the root's everyone cannot view; Bob's private chat is the partner's.
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const dm = channelInfo('dm-bob', { kind: 'dm', rootId: null, chatType: 'dm', partnerId: RECALL_BOB, audience: null });
  const config = structuredClone(SHIPPED);
  config.bot = { ...config.bot, timezone: 'UTC' };
  config.features = { ...config.features, meaningSearch: meaning, recall: true };
  config.models = { ...config.models, routes: { embedding: [{ via: 'api', key: 'main', model: 'test/embedder' }] } };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
    personOfAccount: storedPersonOf,
    dmHomeOf: storedDmOf,
  };
  const llmCalls: Array<Array<unknown>> = [];
  const llm = {
    capLeft: () => 100,
    complete: async (...call: Array<unknown>) => {
      llmCalls.push(call);
      return { text: '' };
    },
  };
  const hot = { config, prompts: { labels: withHidden } };
  const recaller = asRecall({
    hot,
    store,
    llm,
    now: () => RECALL_NOW,
    embed,
    memoryDb: { database: () => (open ? env.db : null) },
  });
  return {
    recaller,
    channel,
    dm,
    hot,
    llmCalls,
    args: {
      placeId: 'g1',
      snapshot,
      channel,
      partnerId: null,
      selfId: 'self',
      selfName: 'Ζωή',
      history: [],
      candidate: { id: 'q', content: 'το σπιτι' },
    },
  };
}

test('memory.search: the hidden marker is one label line, with or without stretches; an anchor makes the call a window read', async () => {
  const quote = {
    placeId: 'c1',
    channelName: 'general',
    startTs: Date.UTC(2026, 9, 20),
    lines: '[10:00] Αλίκη: γεια',
  };
  assert.ok(memorySearchText([quote], { labels: withHidden, hidden: true }).endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.equal(memorySearchText([quote], { labels: withHidden }).includes('ΚΡΥΦΟ-ΣΗΜΑ'), false);
  const none = memorySearchText([], { labels: withHidden, hidden: true });
  const { tools: hiddenTools } = withHidden.tools;
  assert.ok(none.includes(hiddenTools.memory.none) && none.endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.equal(
    memorySearchText([], { labels: { tools: { tools: { memory: { none: 'N' } } } }, hidden: true }),
    'N',
    'a missing label adds nothing'
  );

  const seen: Array<Array<unknown>> = [];
  const recall = {
    available: () => true,
    run: async (call: { server: unknown }) => {
      seen.push(['run', call.server]);
      return { quotes: [quote], hidden: true, outcome: { kind: 'searched', degraded: false, failed: 0, total: 1 } };
    },
    window: async (call: { anchor: string; move: string; messages: number; minutes: number | null }) => {
      seen.push(['window', call.anchor, call.move, call.messages, call.minutes]);
      return call.anchor === 'bad'
        ? { quotes: [], outcome: { kind: 'unknown-anchor' } }
        : { quotes: [quote], outcome: { kind: 'searched' } };
    },
  };
  const base = {
    recall,
    store: { listUserProfiles: () => [] },
    config: { ...SHIPPED, bot: { ...SHIPPED.bot, timezone: 'UTC' } },
    labels: withHidden,
    placeId: 'g1',
    // Changed with the contract: the channel is the chat's info (a root chat has `rootId`).
    channel: { rootId: 'g1' },
    now: RECALL_NOW,
  };
  // The fake recall carries the calls a memory search makes, so each call reads it as the input it stands for.
  const searchWith = (extra: object) =>
    runMemorySearch({ ...base, ...extra } as unknown as Parameters<typeof runMemorySearch>[0]);
  const searched = await searchWith({ args: { question: 'το σπιτι του δασκαλου' } });
  assert.equal(searched.status, 'ok');
  const searchedText = searched.data!.text;
  assert.ok(searchedText.endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  const read = await searchWith({ args: { anchor: 'x2', move: 'down', messages: 3, minutes: 0 } });
  assert.deepEqual([read.status, seen.at(-1)], ['ok', ['window', 'x2', 'down', 3, null]]);
  const readText = read.data!.text;
  assert.ok(!readText.includes('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.deepEqual(seen.filter(([kind]) => kind === 'run').length, 1, 'the window read did not search');
  const up = await searchWith({ args: { anchor: 'x2' } });
  assert.deepEqual([up.status, seen.at(-1)], ['ok', ['window', 'x2', 'up', null, null]]);
  assert.deepEqual(await searchWith({ args: { anchor: 'bad' } }), {
    status: 'invalid',
    code: 'unknown-message',
    reason: 'args.anchor',
  });
  assert.equal(
    (await searchWith({ recall: { available: () => true, run: recall.run }, args: { anchor: 'x2' } })).status,
    'not_configured'
  );
});

test('words: a wide pool is ranked by the distinct terms a line holds; relevance beats recency unless the plan names a date', () => {
  const env = recallFixture();
  try {
    for (let i = 0; i < 12; i += 1)
      env.say({
        native: `w-new-${i}`,
        at: RECALL_NOW - (1 + i / 100) * DAY,
        text: 'σπιτι σπιτι σπιτι',
        place: channelPlaceId('discord', `n${i}`),
      });
    env.say({
      native: 'w-old',
      at: RECALL_NOW - 60 * DAY,
      text: 'το σπιτι, ο δασκαλος και το αυτοκινητο',
      place: channelPlaceId('discord', 'old'),
    });
    env.stem();
    const settings = { ...dbSettings({})!, gateShare: 0, candidates: 3, wordPool: 100 };
    const forms = ['σπιτι', 'δασκαλος', 'αυτοκινητο'];
    const found = recallRun(env, forms, { settings });
    assert.equal(ids(found)[0], 'w-old', 'three distinct terms beat a recent line of one');
    const [firstHit] = found.hits;
    assert.equal(firstHit.terms, 3);
    const one = recallRun(env, forms, { settings, limit: 1 });
    const [oneWindow] = one.windows;
    assert.ok(
      oneWindow.messages.some((message) => message.id === 'w-old'),
      "the one window kept is the best-ranked hit's"
    );
    const aimed = recallRun(env, forms, { settings, plan: { from: RECALL_NOW - 3 * DAY, to: RECALL_NOW } });
    assert.ok(
      ids(aimed).every((id) => (id as string).startsWith('w-new-')),
      'a named date ranks toward it'
    );
  } finally {
    env.done();
  }
});

test('gate: a hit holding the most distinct terms passes even under the share of the best fused score', async () => {
  const { passGate } = await import('../../../../src/memory/db/recall.ts');
  const visible = [
    { id: 'a', score: 0.032 },
    { id: 'b', score: 0.016 },
    { id: 'c', score: 0.012 },
    { id: 'd', score: 0.011 },
  ];
  const held: Record<string, number> = { a: 1, b: 3, c: 1, d: 0 };
  const kept = passGate(visible, (e) => held[e.id], 0.5).map((e) => e.id);
  assert.deepEqual(kept, ['a', 'b']);
  const single = passGate(visible, (e) => ({ a: 1, b: 1, c: 1, d: 0 })[e.id as 'a'], 0.5).map((e) => e.id);
  assert.deepEqual(single, ['a', 'b'], 'one term is no reason to pass the gate');
});

// ---------- the place rule and the order of candidates (fix 2 of the store review) ----------

/** A db whose statements are recorded with every row they return, to prove which text was ever loaded. */
function recording(db: Db) {
  const rows: Array<unknown> = [];
  const wrap = (statement: Statement) => ({
    all: (...args: Array<unknown>) => {
      const out = statement.all(...args);
      rows.push(...out);
      return out;
    },
    get: (...args: Array<unknown>) => {
      const out = statement.get(...args);
      if (out) rows.push(out);
      return out;
    },
    *iterate(...args: Array<unknown>) {
      for (const row of statement.iterate(...args)) {
        rows.push(row);
        yield row;
      }
    },
  });
  return {
    rows,
    db: new Proxy(db, {
      get: (target, key) => (key === 'prepare' ? (sql: string) => wrap(target.prepare(sql)) : Reflect.get(target, key)),
    }),
  };
}

test('place rule: a refused place and a DM never crowd an allowed line out of the candidates', () => {
  const env = recallFixture();
  try {
    for (let i = 0; i < 6; i += 1) {
      env.say({
        native: `refused-${i}`,
        at: RECALL_NOW - DAY,
        text: 'σπιτι σπιτι σπιτι δασκαλου',
        place: channelPlaceId('discord', 'secret'),
      });
      env.say({
        native: `dm-${i}`,
        at: RECALL_NOW - DAY,
        text: 'σπιτι σπιτι σπιτι δασκαλου',
        place: dmPlaceId('discord', RECALL_ALICE),
        scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord'),
      });
    }
    env.say({ native: 'open', at: RECALL_NOW - 5 * DAY, text: 'ενα σπιτι', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const settings = { ...dbSettings({})!, gateShare: 0, candidates: 3, wordPool: 3 };
    const allowPlace = (placeId: string) =>
      placeId !== channelPlaceId('discord', 'secret') && !String(placeId).startsWith('discord:dm:');
    const found = recallRun(env, ['σπιτι'], { settings, allowPlace });
    assert.deepEqual(ids(found), ['open'], 'the word stream picked among the allowed places only');
    assert.equal(found.stats.words, 1);
    // The meaning stream: the refused lines are closer to the question than the allowed one.
    for (let i = 0; i < 6; i += 1) env.vector(`refused-${i}`, [1, 0, 0, 0]);
    env.vector('open', [0.8, 0.6, 0, 0]);
    const meaning = recallRun(env, ['ανυπαρκτο'], {
      settings: { ...settings, minMeaning: 0 },
      allowPlace,
      vector: [1, 0, 0, 0],
    });
    assert.deepEqual(ids(meaning), ['open']);
    assert.equal(meaning.stats.meaning, 1);
    // The people stream.
    env.account(CAROL, ['Μπομπ']);
    for (let i = 0; i < 6; i += 1)
      env.say({
        native: `bob-secret-${i}`,
        at: RECALL_NOW - 60000 * i,
        text: `ξεχωριστο ${i}`,
        place: channelPlaceId('discord', 'secret'),
        author: CAROL,
      });
    env.say({
      native: 'bob-open',
      at: RECALL_NOW - 40 * DAY,
      text: 'κατι αλλο',
      place: channelPlaceId('discord', 'c1'),
      author: CAROL,
    });
    const talk = recallRun(env, [], { settings, allowPlace, plan: { who: ['Μπομπ'] } });
    assert.deepEqual(ids(talk), ['bob-open']);
  } finally {
    env.done();
  }
});

test('meaning: vectors of another model, an older revision with changed text and a deleted line are not matched', () => {
  const env = recallFixture();
  try {
    env.say({ native: 'a', at: RECALL_NOW - DAY, text: 'ενα κειμενο' });
    env.say({ native: 'b', at: RECALL_NOW - DAY, text: 'παλιο κειμενο', revision: 1 });
    env.say({ native: 'b', at: RECALL_NOW - DAY + 1000, text: 'νεο κειμενο', revision: 2 });
    env.say({ native: 'c', at: RECALL_NOW - DAY, text: 'ιδιο κειμενο', revision: 1 });
    env.say({ native: 'c', at: RECALL_NOW - DAY + 1000, text: 'ιδιο κειμενο', revision: 2 });
    env.say({ native: 'd', at: RECALL_NOW - DAY, text: 'διαγραμμενο' });
    env.deleted('d', RECALL_NOW);
    env.stem();
    for (const native of ['a', 'b', 'c', 'd']) env.vector(native, [1, 0, 0, 0]);
    env.db.prepare("UPDATE vectors SET model = 'other/embedder' WHERE item_id = 'a'").run();
    const settings = { ...dbSettings({})!, gateShare: 0, minMeaning: 0 };
    const found = recallRun(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0], model: 'test/embedder' });
    assert.deepEqual(ids(found).sort(), ['c'], 'a: another model; b: its vector is of the old text; d: deleted');
    const any = recallRun(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0] });
    assert.deepEqual(ids(any).sort(), ['a', 'c'], 'no model asked: matched by dims');
    env.db.prepare('UPDATE vectors SET model = NULL').run();
    assert.deepEqual(
      ids(recallRun(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0], model: 'test/embedder' })).sort(),
      ['a', 'c'],
      'a row with no model is taken by its dims'
    );
  } finally {
    env.done();
  }
});

test("hidden marker: only the asker's own DM of this interface; another person's DM, another interface and internal rows give none", () => {
  const env = recallFixture();
  try {
    env.say({
      native: 'own',
      at: RECALL_NOW - DAY,
      text: 'σπιτι δασκαλου μυστικο',
      place: dmPlaceId('discord', RECALL_ALICE),
      scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord'),
    });
    env.say({
      native: 'foreign',
      at: RECALL_NOW - DAY,
      text: 'βιβλιο κοσμου μυστικο',
      place: dmPlaceId('discord', RECALL_BOB),
      scope: dmScope(recallPersonId('discord', RECALL_BOB), 'discord'),
    });
    env.say({
      native: 'abroad',
      at: RECALL_NOW - DAY,
      text: 'παιδι νερου μυστικο',
      place: 'other:dm:x',
      scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'other'),
    });
    env.say({
      native: 'inner',
      at: RECALL_NOW - DAY,
      text: 'δρομος καιρου μυστικο',
      place: dmPlaceId('discord', RECALL_ALICE),
      scope: { scope_kind: 'internal', scope_iface: null, scope_dm: null },
    });
    env.stem();
    // The asker is one id or a list; the context types the list.
    const asked = (forms: Array<string>, asker: string | Array<string>) =>
      recallRun(env, forms, {}, { ...recallGroup, asker: asker as Array<string> }).hidden;
    assert.equal(asked(['σπιτι δασκαλου'], [recallPersonId('discord', RECALL_ALICE)]), true);
    assert.equal(asked(['σπιτι δασκαλου'], recallPersonId('discord', RECALL_ALICE)), true, 'one id or a list');
    assert.equal(asked(['σπιτι δασκαλου'], [recallPersonId('discord', RECALL_BOB)]), false, 'the DM is not theirs');
    assert.equal(
      asked(['σπιτι δασκαλου'], [recallPersonId('discord', RECALL_BOB), recallPersonId('discord', RECALL_ALICE)]),
      true,
      'any of the linked persons'
    );
    assert.equal(asked(['βιβλιο κοσμου'], [recallPersonId('discord', RECALL_ALICE)]), false, "another person's DM");
    assert.equal(asked(['παιδι νερου'], [recallPersonId('discord', RECALL_ALICE)]), false, "another interface's DM");
    assert.equal(asked(['δρομος καιρου'], [recallPersonId('discord', RECALL_ALICE)]), false, 'an internal row');
    assert.equal(asked(['σπιτι δασκαλου'], []), false);
    // Another person's DM ranking above the asker's own does not hide it: the shared word is in both.
    assert.equal(
      asked(['μυστικο'], [recallPersonId('discord', RECALL_ALICE)]),
      true,
      "the asker's DM found past a better-ranked foreign DM"
    );
    assert.equal(asked(['μυστικο'], [recallPersonId('discord', '100000000000000999')]), false, "nobody's DM of theirs");
  } finally {
    env.done();
  }
});

test('window: the text of a line the context may not open is never loaded, at a boundary, an anchor or a reply parent', () => {
  const env = recallFixture();
  try {
    for (let i = 1; i <= 8; i += 1) {
      const hiddenLine = i === 4;
      env.say({
        native: `h${i}`,
        at: RECALL_NOW - (9 - i) * 60000,
        text: hiddenLine ? 'κρυφη γραμμη ΜΥΣΤΙΚΟ' : `γραμμη ${i}`,
        ...(hiddenLine ? { scope: dmScope(recallPersonId('discord', RECALL_ALICE), 'discord') } : {}),
        ...(i === 5 ? { replyTo: 'h4' } : {}),
      });
    }
    env.stem();
    const seen = recording(env.db);
    const leaked = () => JSON.stringify(seen.rows).includes('ΜΥΣΤΙΚΟ');
    window(seen.db, { ctx: recallGroup, anchor: 'h6', move: 'up', messages: 5 });
    window(seen.db, { ctx: recallGroup, anchor: 'h2', move: 'down', messages: 5 });
    window(seen.db, { ctx: recallGroup, anchor: 'h4', move: 'up', messages: 2 });
    window(seen.db, {
      ctx: recallGroup,
      anchor: messageSourceId('discord', 'h4', 1, 'seen'),
      move: 'down',
      messages: 2,
    });
    assert.equal(leaked(), false, 'windows');
    search(seen.db, {
      ctx: recallGroup,
      plan: plan(['γραμμη 5']),
      now: RECALL_NOW,
      settings: { ...dbSettings({})!, recordContext: 3 },
    });
    assert.equal(leaked(), false, "a hit's stretch, its reply parent and its neighbours");
    // Control: the partner of that DM does read it, so the recorder sees the text.
    window(seen.db, { ctx: dmOfMember(RECALL_ALICE), anchor: 'h6', move: 'up', messages: 5 });
    assert.equal(leaked(), true);
  } finally {
    env.done();
  }
});

test('names: an alias claim resolves only through verified accounts and only when the context may see the claim', () => {
  const env = recallFixture();
  try {
    env.account(RECALL_ALICE, ['Αλίκη']);
    env.account(CAROL, ['Μπομπ']);
    env.say({ native: 'a1', at: RECALL_NOW - DAY, text: 'γεια απο την Αλικη', author: RECALL_ALICE });
    env.say({ native: 'b1', at: RECALL_NOW - DAY, text: 'γεια απο τον Μπομπ', author: CAROL });
    env.stem();
    const claim = (id: string, text: string, scope: ReturnType<typeof groupScope>, subject: string) =>
      env.db
        .prepare(
          `INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm)
      VALUES (?, 'person', ?, 'alias', ?, ?, ?, ?)`
        )
        .run(id, subject, text, scope.scope_kind, scope.scope_iface, scope.scope_dm);
    claim('c1', 'Λικα', groupScope('discord'), recallPersonId('discord', RECALL_ALICE));
    claim(
      'c2',
      'Μπομπακι',
      dmScope(recallPersonId('discord', RECALL_ALICE), 'discord'),
      recallPersonId('discord', CAROL)
    );
    const who = (name: string, ctx = recallGroup) =>
      ids(search(env.db, { ctx, plan: plan([], { who: [name] }), now: RECALL_NOW }));
    assert.deepEqual(who('Λικα'), ['a1']);
    assert.deepEqual(who('Μπομπακι'), [], 'a claim of a DM is no alias for the group');
    assert.deepEqual(who('Μπομπακι', dmOfMember(RECALL_ALICE)), ['b1']);
    env.db.prepare("UPDATE accounts SET link = 'pending' WHERE id = ?").run(`discord:${RECALL_ALICE}`);
    assert.deepEqual(who('Λικα'), [], 'an unverified link resolves nothing');
    assert.deepEqual(who('Αλίκη'), ['a1'], "the account's own name still does");
  } finally {
    env.done();
  }
});

test('recall finds another interface group before a candidate cap without exposing closer private matches', () => {
  // Catches filtering foreign groups or filling the candidate budget with inaccessible private evidence.
  const env = recallFixture();
  try {
    for (let i = 0; i < 6; i++)
      env.say({
        native: `private-cross-${i}`,
        at: RECALL_NOW - i * 60_000,
        text: 'σπιτι σπιτι σπιτι δασκαλου',
        place: dmPlaceId('discord', RECALL_BOB),
        scope: dmScope(recallPersonId('discord', RECALL_BOB), 'discord'),
      });
    env.say({
      native: 'foreign-group',
      iface: 'other',
      at: RECALL_NOW - 5 * DAY,
      text: 'ενα σπιτι',
      place: channelPlaceId('other', 'foreign'),
      scope: groupScope('other'),
    });
    env.stem();
    fillEnvAudiences(env);
    const settings = { ...dbSettings({})!, gateShare: 0, candidates: 2, wordPool: 2 };
    for (const ctx of [groupContext('discord'), dmOfMember(RECALL_ALICE)]) {
      const found = search(env.db, {
        ctx: { ...ctx, audienceColumn: true },
        plan: plan(['σπιτι']),
        now: RECALL_NOW,
        settings,
      });
      assert.deepEqual(ids(found), ['foreign-group']);
      assert.equal(found.hidden, false, "another person's private matches do not produce a hint");
    }
    env.vector('foreign-group', [0.8, 0.6, 0, 0], { scope: groupScope('other') });
    for (let i = 0; i < 6; i++)
      env.vector(`private-cross-${i}`, [1, 0, 0, 0], {
        scope: dmScope(recallPersonId('discord', RECALL_BOB), 'discord'),
      });
    fillEnvAudiences(env);
    const meaning = search(env.db, {
      ctx: { ...groupContext('discord'), audienceColumn: true },
      plan: plan(['ανυπαρκτο']),
      now: RECALL_NOW,
      settings: { ...settings, minMeaning: 0 },
      vector: [1, 0, 0, 0],
    });
    assert.deepEqual(ids(meaning), ['foreign-group']);
  } finally {
    env.done();
  }
});

test('an internal window retains stored media without reading captions for a null guild', async () => {
  const env = recallFixture();
  try {
    const { issueContext } = await import('../../../../src/memory/db/scope.ts');
    env.account(RECALL_BOB, ['Benoit']);
    const source = env.say({
      native: 'media-before',
      at: RECALL_NOW - DAY - 60000,
      text: 'Stored picture evidence',
      place: dmPlaceId('discord', RECALL_BOB),
      author: RECALL_BOB,
      scope: dmScope(recallPersonId('discord', RECALL_BOB), 'discord'),
    });
    // The kinds of a line live on its links: one bare item, as the migration leaves an old picture.
    env.db.exec("INSERT INTO media (id, kind, availability) VALUES ('media:bare:b', 'image', 'unknown')");
    env.db.prepare("INSERT INTO media_links VALUES ('source', ?, 0, 'media:bare:b')").run(source);
    env.say({
      native: 'media-anchor',
      at: RECALL_NOW - DAY,
      text: 'Window anchor',
      place: dmPlaceId('discord', RECALL_BOB),
      author: RECALL_BOB,
      scope: dmScope(recallPersonId('discord', RECALL_BOB), 'discord'),
    });
    const s = runner(env);
    let captions = 0;
    const recaller = asRecall({
      hot: s.hot,
      store: {},
      now: () => RECALL_NOW,
      memoryDb: { database: () => env.db },
      describer: {
        cachedDescriptions: () => {
          captions += 1;
          return new Map();
        },
      },
    });
    const found = await recaller.window({
      ...s.args,
      placeId: null,
      snapshot: null,
      channel: s.dm,
      memoryContext: issueContext({ kind: 'internal', newId: () => 'ctx:media-window', now: () => RECALL_NOW }),
      anchor: 'media-anchor',
      move: 'up',
      messages: 1,
    });
    assert.equal(captions, 0);
    assert.equal(found.outcome.kind, 'searched');
    assert.deepEqual(
      found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
      ['media-before']
    );
    const [firstQuote] = found.quotes;
    assert.ok(firstQuote.lines.includes('Stored picture evidence'));
    const [firstEntry] = firstQuote.entries;
    assert.deepEqual(firstEntry.message.attachments, [{ id: 'media-before#m0', kind: 'image', name: 'image' }]);
  } finally {
    env.done();
  }
});

const MINUTE = 60_000;
const EDIT_DELAY = 93 * MINUTE;

/**
 * The line `e` said at minute 1 of a chat of ten lines, `a` before it and `l1` to `l8` after it, and edited 93 minutes
 * later, the edit stored `seen` at the line's moment, as the writer and schema step 67 store it. Returns the moment `e`
 * was written.
 */
function editedLineChat(env: ReturnType<typeof recallFixture>): number {
  const at = RECALL_NOW - DAY;
  env.say({ native: 'a', at, text: 'πρώτη γραμμή', author: RECALL_BOB });
  env.say({ native: 'e', at: at + MINUTE, text: 'παλιο σπιτι', kind: 'said', author: RECALL_ALICE });
  for (let n = 1; n <= 8; n += 1)
    env.say({ native: `l${n}`, at: at + (n + 1) * MINUTE, text: `γραμμή ${n}`, author: RECALL_BOB });
  env.say({ native: 'e', at: at + MINUTE, text: 'νεο σπιτι', revision: 2, author: RECALL_ALICE });
  env.stem();
  return at + MINUTE;
}

// Bug: an edit stored with the moment of the edit placed the line after the lines that came
// later, so a stretch of recall read the chat in the wrong order.
test('recall: a window around a hit that was edited later keeps the hit at the place it was written', () => {
  const env = recallFixture();
  try {
    editedLineChat(env);
    // Two lines each side and no followed chat, so the window holds the hit's neighbours and nothing else.
    const settings = { ...dbSettings({})!, recordContext: 2, followMessages: 0, followGapMinutes: 5 };
    const found = recallRun(env, ['σπιτι'], { settings });
    const [first] = found.windows;
    assert.deepEqual(
      first.messages.map((message) => message.id),
      ['a', 'e', 'l1', 'l2'],
      'the lines written around the first revision, not the ones around the edit'
    );
  } finally {
    env.done();
  }
});

// Bug: the hit's `ts` is the moment of its edit, so the ranking by nearness to a date and the age shown follow the edit.
test('recall: a hit that was edited later is dated by the moment it was written', () => {
  const env = recallFixture();
  try {
    const written = editedLineChat(env);
    const found = recallRun(env, ['σπιτι']);
    assert.deepEqual(
      found.hits.map((hit) => [hit.messageId, hit.ts]),
      [['e', written]]
    );
  } finally {
    env.done();
  }
});

// ---------- the lines around an edited hit, on the place-and-time index ----------

const CHAT_START = RECALL_NOW - DAY;

/** One line of the channel `room` observed the way a chat interface hands it in; `edit` hands it in as an edit of a stored line. */
function recallObserveLine(
  env: ReturnType<typeof recallFixture>,
  key: string,
  at: number,
  text: string,
  edit = false
): void {
  const native = edit
    ? { kind: 'message', key, subtype: 'seen' }
    : { kind: 'message', key, subtype: 'seen', revision: 1 };
  const done = observe(
    env.handle,
    {
      v: 1,
      iface: 'discord',
      authority: 'discord/global',
      native,
      ...(edit ? { edited: true } : {}),
      place: { authority: 'discord/global', key: 'channel:room', kind: 'channel', chat: 'group' },
      author: { kind: 'account', key: RECALL_BOB, account_kind: 'user' },
      occurredAt: new Date(at).toISOString(),
      observedAt: new Date(at).toISOString(),
      text,
      mentions: [],
      direct: false,
      relations: [],
    },
    { now: () => RECALL_NOW }
  );
  assert.equal(done.ok, true);
}

/**
 * `lines` lines of the channel `room` a minute apart, `l0` first, with `l<edited>` saying `παλιο σπιτι` and edited 93 minutes later
 * to `νεο σπιτι`, both through the observation.
 */
function observedChat(env: ReturnType<typeof recallFixture>, lines: number, edited: number): void {
  for (let n = 0; n < lines; n += 1)
    recallObserveLine(env, `l${n}`, CHAT_START + n * MINUTE, n === edited ? 'παλιο σπιτι' : `γραμμή ${n}`);
  recallObserveLine(env, `l${edited}`, CHAT_START + edited * MINUTE + EDIT_DELAY, 'νεο σπιτι', true);
  env.stem();
}

/** The plan lines SQLite gives for each statement that ran. */
const plansOf = (db: Db, ran: ReadonlyArray<{ sql: string; params: Array<unknown> }>): Array<Array<string>> =>
  ran.map(({ sql, params }) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => String(row.detail))
  );

/** A search of a place's rows that `sources_place_time` bounds by a range of `occurred_at`. */
const PLACE_TIME_RANGE = /^SEARCH s USING (COVERING )?INDEX sources_place_time \(place_id=\? AND occurred_at[<>]/;
/** A walk of every row of a place, or of every row of `sources`. */
const WHOLE_PLACE = /^SEARCH s USING (COVERING )?INDEX sources_place_time \(place_id=\?\)$|^SCAN (s|t|sources)\b/;

test('recall: a window paged from a line before an edited line gives it at its place with the new text', () => {
  // Bug (production, 2026-11-12): an edit stored at the moment of the edit made a page of the chat skip the line or put it
  // after the lines written later.
  const env = recallFixture();
  try {
    observedChat(env, 8, 3);
    const down = window(env.db, { ctx: recallGroup, anchor: 'l2', move: 'down', messages: 3 });
    assert.deepEqual(
      down.windows.flatMap((one) => one.messages).map((message) => [message.id, message.content]),
      [
        ['l3', 'νεο σπιτι'],
        ['l4', 'γραμμή 4'],
        ['l5', 'γραμμή 5'],
      ]
    );
  } finally {
    env.done();
  }
});

test('recall: the lines around a hit are read on a range of the place-and-time index, never a walk of the place', () => {
  // Bug (report 2026-11-18-reply-latency): the neighbours read filtered and sorted on the first revision's moment, an
  // expression the index cannot serve, so each call read every line of the place: 7 s of one search in production.
  const env = recallFixture();
  try {
    observedChat(env, 120, 60);
    const { db, ran } = planRecording(env.db);
    const settings = { ...dbSettings({})!, recordContext: 2, followMessages: 0 };
    const found = search(db, { ctx: recallGroup, plan: plan(['σπιτι']), now: RECALL_NOW, settings });
    assert.deepEqual(
      found.windows.flatMap((one) => one.messages).map((message) => message.id),
      ['l58', 'l59', 'l60', 'l61', 'l62']
    );
    const plans = plansOf(env.db, ran);
    assert.equal(plans.filter((one) => one.some((line) => PLACE_TIME_RANGE.test(line))).length > 0, true);
    assert.deepEqual(
      plans.flat().filter((line) => WHOLE_PLACE.test(line)),
      []
    );
  } finally {
    env.done();
  }
});

test('recall: a window paged from an anchor is read on a range of the place-and-time index, never a walk of the place', () => {
  // Bug (report 2026-11-18-reply-latency): the memory window tool runs the same neighbours read within a reply turn.
  const env = recallFixture();
  try {
    observedChat(env, 120, 60);
    const { db, ran } = planRecording(env.db);
    for (const move of ['up', 'down']) window(db, { ctx: recallGroup, anchor: 'l60', move, messages: 3 });
    window(db, { ctx: recallGroup, anchor: 'l60', move: 'down', minutes: 5 });
    const plans = plansOf(env.db, ran);
    assert.equal(plans.filter((one) => one.some((line) => PLACE_TIME_RANGE.test(line))).length >= 3, true);
    assert.deepEqual(
      plans.flat().filter((line) => WHOLE_PLACE.test(line)),
      []
    );
  } finally {
    env.done();
  }
});

// `memory.search` asked by place and day with no word that matched: the place-and-time stream of
// src/memory/db/recall.ts#search (`sampleTime: true`, what the persona's own search passes), the `sampled` answer through
// src/behavior/recall-run.ts and src/tools/tools.ts, and the picture-only lines with their descriptions. Synthetic content
// on real temp databases; no model, no network.
const shippedJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'config', file), 'utf8')) as Record<string, object>;

const DAY_MINUTE = 60000;
const DAY_NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY_START = Date.parse('2026-11-01T00:00:00.000Z');
const DAY_END = Date.parse('2026-11-01T23:59:59.999Z');
const DAY_GENERAL = channelPlaceId('discord', 'c1');
const SECRET = channelPlaceId('discord', 'c4');
const DAY_OTHER = channelPlaceId('discord', 'c9');
const DAY_ALICE = 'u-alice';
const DAY_BOB = 'u-bob';
const dayGroup = groupContext('discord');

/** The stretch settings every test here depends on, named so no test reads a shipped default. */
const DAY_SETTINGS = { ...dbSettings({})!, recordContext: 3, followMessages: 24, followGapMinutes: 5, candidates: 40 };
const SAMPLED_MARK = 'SAMPLED-MARK';
const NONE_MARK = 'NONE-MARK';
const dayToolLabels = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...labelTools,
      memory: { ...labelTools.memory, sampled: SAMPLED_MARK, none: NONE_MARK },
    },
  },
};

type DayEnv = ReturnType<typeof dayFixture>;
type Plan = { forms: Array<string>; who: Array<string>; from: number | null; to: number | null; placeId?: string };

const planOf = (extra: Partial<Plan> = {}): Plan => ({ forms: [], who: [], from: null, to: null, ...extra });
const theDay = (extra: Partial<Plan> = {}): Plan => planOf({ from: DAY_START, to: DAY_END, ...extra });
/** The channels' place rows, as every stored line's place has one: a search finds a named channel by its native id. */
function channelRows(env: DayEnv): void {
  env.channel(DAY_GENERAL, 'c1');
  env.channel(SECRET, 'c4');
  env.channel(DAY_OTHER, 'c9');
}
const sampling = (env: DayEnv, plan: Plan, rest: Record<string, unknown> = {}, ctx: unknown = dayGroup) => {
  channelRows(env);
  return search(env.db, { ctx, plan, now: DAY_NOW, settings: DAY_SETTINGS, sampleTime: true, ...rest });
};
const lineIds = (found: { windows: Array<{ messages: Array<{ id: unknown }> }> }) =>
  found.windows.flatMap((window) => window.messages.map((message) => message.id));
const hitIds = (found: { hits: Array<{ messageId: unknown }> }) => found.hits.map((hit) => hit.messageId);

/** `count` lines spread evenly over a span, each further from the next than a chat's silence. */
function spread(
  env: DayEnv,
  prefix: string,
  {
    from,
    to,
    count,
    place = DAY_GENERAL,
    text = '',
  }: { from: number; to: number; count: number; place?: string; text?: string }
) {
  const step = (to - from) / count;
  for (let i = 0; i < count; i += 1)
    env.say({ native: `${prefix}${i}`, at: Math.round(from + i * step), text: text || `line ${prefix}${i}`, place });
}

/** An image with no text, as the interface reports it, written through the observation path. */
function observePicture(
  env: DayEnv,
  {
    native,
    at,
    channelId = 'c1',
    attachments,
  }: { native: string; at: number; channelId?: string; attachments: Array<{ id: string; kind: string }> }
) {
  const envelope = observationOf({
    iface: 'discord',
    at,
    message: {
      id: native,
      at,
      content: '',
      author: { id: DAY_ALICE },
      attachments: attachments.map((item) => ({ ...item, name: 'p.png', url: 'https://example.invalid/p.png' })),
      links: [],
      stickers: [],
    },
    chat: { id: channelId, kind: 'channel', rootId: 'g1', name: channelId },
  });
  assert.ok(envelope);
  const written = observe(env.handle, envelope, { now: () => at });
  assert.equal(written.ok, true);
}

/** A description of an attachment as the media cache stores it. */
function dayDescribe(
  env: DayEnv,
  attachmentId: string,
  description: string | null,
  {
    scope = groupScope('discord'),
    retired = null,
  }: { scope?: ReturnType<typeof groupScope>; retired?: string | null } = {}
) {
  // The item the observation made holds its description; a cache row of an item not yet observed is one more row.
  const held = env.db
    .prepare(
      `UPDATE media SET description = ?, availability = ?, retired_at = ?, extra = json_set(COALESCE(extra, '{}'), '$.textOrigin', 'retelling')
       WHERE native_ref = ? AND scope_iface IS ?`
    )
    .run(description, description === null ? 'unknown' : 'present', retired, attachmentId, scope.scope_iface);
  assert.equal(Number(held.changes) > 0, true, 'the picture was observed first');
}

/**
 * The runner and the tool over the fixture database: #general (c1), #secret (c4) that the root cannot see, stored as
 * `secret`.
 */
function toolRig(env: DayEnv, { secret: secretId = SECRET }: { secret?: string } = {}) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        { id: DAY_GENERAL, iface: 'discord', kind: 'channel', native_id: 'c1', scope_kind: 'group', name: 'general' },
        { id: secretId, iface: 'discord', kind: 'channel', native_id: 'c4', scope_kind: 'group', name: 'secret' },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const shipped = shippedJson('config.json');
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
  const llmCalls: Array<unknown> = [];
  const reads = {
    history: () => Promise.resolve({ events: [], complete: true }),
  };
  const llm = {
    capLeft: () => 100,
    complete: (...call: Array<unknown>) => {
      llmCalls.push(call);
      return Promise.resolve({ text: '' });
    },
  };
  const recall = createRecall({
    iface: 'discord',
    mediaNameOf: noMediaNames,
    reads,
    hot: { config, prompts: { labels: dayToolLabels } },
    store,
    llm,
    now: () => DAY_NOW,
    memoryDb: { database: () => env.db },
  } as unknown as Parameters<typeof createRecall>[0]);
  const ask = (args: Record<string, unknown>) =>
    runMemorySearch({
      recall,
      store,
      config,
      labels: dayToolLabels,
      placeId: 'g1',
      snapshot,
      channel,
      selfId: 'self',
      selfName: 'Self',
      history: [],
      now: DAY_NOW,
      args,
    });
  return { ask, llmCalls };
}

const textOf = (result: Awaited<ReturnType<typeof runMemorySearch>>) => {
  assert.equal(result.status, 'ok');
  return (result as { data: { text: string } }).data.text;
};

// ---------- the stream ----------

test('a day in a channel with no words is answered from that day, each hit found by the time stream', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    assert.equal(found.sampled, true);
    assert.ok(found.windows.length > 0, 'the day has lines');
    assert.ok(found.hits.length > 0);
    for (const hit of found.hits) assert.deepEqual(hit.streams, ['time']);
  } finally {
    env.done();
  }
});

test('a busy day comes back sampled across its whole span, one window per third under a limit of three', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 222 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    assert.equal(found.windows.length, 3);
    const span = (DAY_END - DAY_START) / 3;
    const thirds = found.windows.map(({ messages }) =>
      Math.min(2, Math.floor((messages[Math.floor(messages.length / 2)].ts - DAY_START) / span))
    );
    assert.deepEqual([...thirds].sort(), [0, 1, 2]);
  } finally {
    env.done();
  }
});

test('a sample stays far under the size of the day it reads', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 222 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    // Each window is at most a hit, its neighbours each side and the chat followed on.
    const most = 3 * (1 + 2 * DAY_SETTINGS.recordContext + DAY_SETTINGS.followMessages);
    assert.ok(lineIds(found).length > 0, 'the day has lines');
    assert.ok(lineIds(found).length <= most, `${lineIds(found).length} lines`);
    assert.ok(found.hits.length <= DAY_SETTINGS.candidates, `${found.hits.length} hits`);
  } finally {
    env.done();
  }
});

test('a limit of one gives one window', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 50 });
    assert.equal(sampling(env, theDay({ placeId: 'c1' }), { limit: 1 }).windows.length, 1);
  } finally {
    env.done();
  }
});

test('the windows of a sample come back newest first, each in time order', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 60 });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 3 });
    assert.equal(found.windows.length, 3);
    const ends = found.windows.map((window) => window.messages.at(-1)!.ts);
    assert.deepEqual(
      ends,
      [...ends].sort((a, b) => b - a)
    );
    for (const window of found.windows) {
      const times = window.messages.map((message) => message.ts);
      assert.deepEqual(
        times,
        [...times].sort((a, b) => a - b)
      );
    }
  } finally {
    env.done();
  }
});

test('a range with fewer lines than the limit gives every line, a range with none gives nothing', () => {
  const env = dayFixture();
  try {
    env.say({ native: 'one', at: DAY_START + 2 * 60 * DAY_MINUTE, text: 'first', place: DAY_GENERAL });
    env.say({ native: 'two', at: DAY_START + 14 * 60 * DAY_MINUTE, text: 'second', place: DAY_GENERAL });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 5 });
    assert.deepEqual(hitIds(found).sort(), ['one', 'two']);
    const empty = sampling(env, planOf({ from: DAY_START + 3 * DAY, to: DAY_END + 3 * DAY, placeId: 'c1' }));
    assert.deepEqual([empty.windows.length, empty.hits.length, empty.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

test('a hit of a sample is inside the range and the channel it named', () => {
  const env = dayFixture();
  try {
    spread(env, 'before', { from: DAY_START - 5 * DAY, to: DAY_START - DAY, count: 40 });
    spread(env, 'in', { from: DAY_START, to: DAY_END, count: 40 });
    spread(env, 'after', { from: DAY_END + DAY, to: DAY_END + 3 * DAY, count: 40 });
    spread(env, 'there', { from: DAY_START, to: DAY_END, count: 40, place: DAY_OTHER });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 4 });
    assert.ok(found.hits.length > 0);
    for (const hit of found.hits) {
      assert.ok(hit.ts >= DAY_START && hit.ts <= DAY_END, String(hit.messageId));
      assert.equal(hit.placeId, DAY_GENERAL);
    }
  } finally {
    env.done();
  }
});

test('a range with one open side stays on its named side', () => {
  const env = dayFixture();
  try {
    spread(env, 'old', { from: DAY_START - 30 * DAY, to: DAY_START, count: 30 });
    spread(env, 'new', { from: DAY_START, to: DAY_START + 30 * DAY, count: 30 });
    const since = sampling(env, planOf({ from: DAY_START, placeId: 'c1' }), { limit: 3 });
    assert.ok(since.hits.length > 0);
    for (const hit of since.hits) assert.ok(hit.ts >= DAY_START, String(hit.messageId));
    const until = sampling(env, planOf({ to: DAY_START - 1, placeId: 'c1' }), { limit: 3 });
    assert.ok(until.hits.length > 0);
    for (const hit of until.hits) assert.ok(hit.ts < DAY_START, String(hit.messageId));
  } finally {
    env.done();
  }
});

test('a channel named with no range is sampled across its whole span, bounded by the limit', () => {
  const env = dayFixture();
  try {
    spread(env, 'c', { from: DAY_START - 300 * DAY, to: DAY_START, count: 300 });
    spread(env, 'there', { from: DAY_START - 300 * DAY, to: DAY_START, count: 30, place: DAY_OTHER });
    const found = sampling(env, planOf({ placeId: 'c1' }), { limit: 2 });
    assert.equal(found.windows.length, 2);
    assert.ok(lineIds(found).every((id) => String(id).startsWith('c')));
    const middle = DAY_START - 150 * DAY;
    const sides = found.windows.map(({ messages }) => messages[0].ts < middle);
    assert.deepEqual([...sides].sort(), [false, true], 'an old stretch and a recent one');
  } finally {
    env.done();
  }
});

test('a range with no channel samples every channel the context may read', () => {
  const env = dayFixture();
  try {
    spread(env, 'a', { from: DAY_START, to: DAY_END, count: 30 });
    spread(env, 'b', { from: DAY_START, to: DAY_END, count: 30, place: DAY_OTHER });
    const found = sampling(env, theDay(), { limit: 5 });
    assert.equal(found.sampled, true);
    assert.ok(found.windows.length > 0);
  } finally {
    env.done();
  }
});

// ---------- when the stream runs ----------

test('words that match nothing still answer from the time stream, with the words kept out of the ranking', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    const found = sampling(env, theDay({ forms: ['ανυπαρκτο'], placeId: 'c1' }), { limit: 2 });
    assert.equal(found.sampled, true);
    assert.equal(found.stats.words, 0);
    assert.ok(found.hits.length > 0);
    for (const hit of found.hits) assert.deepEqual(hit.streams, ['time']);
  } finally {
    env.done();
  }
});

test('one word that matched keeps the answer to the word stream, the rest of the day stays out', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 40 });
    env.say({ native: 'found', at: DAY_START + 720 * DAY_MINUTE + 1, text: 'το ποδηλατο', place: DAY_GENERAL });
    env.stem();
    const found = sampling(env, theDay({ forms: ['ποδηλατο'], placeId: 'c1' }), { limit: 3 });
    assert.deepEqual(hitIds(found), ['found']);
    const [firstHit] = found.hits;
    assert.deepEqual(firstHit.streams, ['words']);
    assert.equal(found.windows.length, 1, 'a word match is not filled up with a sample');
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('a part of a word the letters found keeps the time stream off', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    env.say({ native: 'part', at: DAY_START + 60 * DAY_MINUTE + 1, text: 'η παρακαλουσα', place: DAY_GENERAL });
    const found = sampling(env, theDay({ forms: ['ρακαλου'], placeId: 'c1' }), { limit: 3 });
    assert.deepEqual(hitIds(found), ['part']);
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('a line the meaning stream found keeps the time stream off', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    env.vector('d3', [1, 0, 0, 0]);
    const found = sampling(env, theDay({ forms: ['ανυπαρκτο'], placeId: 'c1' }), {
      limit: 3,
      vector: [1, 0, 0, 0],
      settings: { ...DAY_SETTINGS, minMeaning: 0.5 },
    });
    assert.deepEqual(hitIds(found), ['d3']);
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('a person who spoke that day keeps the time stream off', () => {
  const env = dayFixture();
  try {
    env.account(DAY_ALICE, ['Alice']);
    env.account(DAY_BOB, ['Bob']);
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    env.say({ native: 'bob', at: DAY_START + 60 * DAY_MINUTE + 1, text: 'hello', place: DAY_GENERAL, author: DAY_BOB });
    const found = sampling(env, theDay({ who: ['Bob'], placeId: 'c1' }), { limit: 3 });
    assert.deepEqual(hitIds(found), ['bob']);
    assert.equal(found.sampled, false);
  } finally {
    env.done();
  }
});

test('words that matched only the lines the persona already sees answer nothing, no sample in their place', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 20 });
    const seenId = env.say({
      native: 'seen',
      at: DAY_START + 60 * DAY_MINUTE + 1,
      text: 'το ποδηλατο',
      place: DAY_GENERAL,
    });
    env.stem();
    const found = sampling(env, theDay({ forms: ['ποδηλατο'], placeId: 'c1' }), {
      exclusions: [{ kind: 'source', sourceId: seenId }],
    });
    assert.deepEqual([found.windows.length, found.sampled], [0, false]);
  } finally {
    env.done();
  }
});

test('a plan with no place, no range and no words answers nothing', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, planOf());
    assert.deepEqual([found.windows.length, found.hits.length, found.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

test('words that match nothing with no place and no range answer nothing', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, planOf({ forms: ['ανυπαρκτο'] }));
    assert.deepEqual([found.windows.length, found.hits.length, found.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

// The automatic memory prefetch searches with `to` set and must never get a day's chat when its words miss.
test('a search that did not ask for the time stream stays empty with a range and no match', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = search(env.db, {
      ctx: dayGroup,
      plan: planOf({ forms: ['ανυπαρκτο'], to: DAY_END }),
      now: DAY_NOW,
      settings: DAY_SETTINGS,
    });
    assert.deepEqual([found.windows.length, found.hits.length, found.sampled], [0, 0, false]);
  } finally {
    env.done();
  }
});

// ---------- audience, place rule, retired lines ----------

test("a DM's lines in the range never reach a group, and a range holding only them answers nothing", () => {
  const env = dayFixture();
  try {
    const dm = dmPlaceId('discord', DAY_BOB);
    const scope = dmScope(personId('discord', DAY_BOB), 'discord');
    for (let i = 0; i < 12; i += 1)
      env.say({
        native: `dm${i}`,
        at: DAY_START + i * 60 * DAY_MINUTE,
        text: 'μυστικο',
        place: dm,
        author: DAY_BOB,
        scope,
      });
    const alone = sampling(env, theDay());
    assert.deepEqual([alone.windows.length, alone.hits.length, alone.sampled, alone.hidden], [0, 0, false, false]);
    spread(env, 'g', { from: DAY_START, to: DAY_END, count: 12 });
    const found = sampling(env, theDay(), { limit: 5 });
    assert.ok(found.hits.length > 0);
    const dump = JSON.stringify({ windows: found.windows, hits: found.hits });
    assert.ok(!dump.includes('μυστικο') && !dump.includes('dm1'));
  } finally {
    env.done();
  }
});

test("a DM context reads its own DM's lines and never another person's", () => {
  const env = dayFixture();
  try {
    const mine = dmScope(personId('discord', DAY_BOB), 'discord');
    const theirs = dmScope(personId('discord', DAY_ALICE), 'discord');
    for (let i = 0; i < 6; i += 1) {
      env.say({
        native: `mine${i}`,
        at: DAY_START + i * 60 * DAY_MINUTE,
        text: 'δικο μου',
        place: dmPlaceId('discord', DAY_BOB),
        author: DAY_BOB,
        scope: mine,
      });
      env.say({
        native: `theirs${i}`,
        at: DAY_START + i * 60 * DAY_MINUTE + 1,
        text: 'ξενο',
        place: dmPlaceId('discord', DAY_ALICE),
        scope: theirs,
      });
    }
    const found = sampling(
      env,
      theDay(),
      { limit: 5 },
      dmContext(personId('discord', DAY_BOB), 'discord', dmPlaceId('discord', DAY_BOB))
    );
    assert.ok(lineIds(found).some((id) => String(id).startsWith('mine')));
    assert.ok(!JSON.stringify(found.windows).includes('ξενο'));
  } finally {
    env.done();
  }
});

test('a channel the place rule refuses stays out of a range and answers nothing when named', () => {
  const env = dayFixture();
  try {
    spread(env, 'open', { from: DAY_START, to: DAY_END, count: 12 });
    spread(env, 'shut', { from: DAY_START, to: DAY_END, count: 12, place: SECRET, text: 'κρυφο' });
    const allowPlace = (placeId: unknown) => placeId !== SECRET;
    const wide = sampling(env, theDay(), { limit: 5, allowPlace });
    assert.ok(wide.hits.length > 0);
    assert.ok(!JSON.stringify(wide.windows).includes('κρυφο'));
    const named = sampling(env, theDay({ placeId: 'c4' }), { limit: 5, allowPlace });
    assert.deepEqual([named.windows.length, named.sampled], [0, false]);
  } finally {
    env.done();
  }
});

test('retired, deleted and superseded lines are out of a sample', () => {
  const env = dayFixture();
  try {
    const at = DAY_START + 60 * DAY_MINUTE;
    const retired = env.say({ native: 'gone', at, text: 'αποσυρθηκε', place: DAY_GENERAL });
    env.db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(new Date(DAY_NOW).toISOString(), retired);
    env.say({ native: 'del', at: at + 20 * DAY_MINUTE, text: 'σβηστηκε', place: DAY_GENERAL });
    env.deleted('del', at + 21 * DAY_MINUTE);
    env.say({ native: 'ed', at: at + 40 * DAY_MINUTE, text: 'παλια μορφη', place: DAY_GENERAL });
    env.say({ native: 'ed', at: at + 40 * DAY_MINUTE, text: 'νεα μορφη', place: DAY_GENERAL, revision: 2 });
    env.say({ native: 'kept', at: at + 60 * DAY_MINUTE, text: 'μενει', place: DAY_GENERAL });
    const found = sampling(env, theDay({ placeId: 'c1' }), { limit: 5 });
    assert.deepEqual(hitIds(found).sort(), ['ed', 'kept']);
    const dump = JSON.stringify(found.windows);
    assert.ok(dump.includes('νεα μορφη'));
    for (const text of ['αποσυρθηκε', 'σβηστηκε', 'παλια μορφη']) assert.ok(!dump.includes(text), text);
  } finally {
    env.done();
  }
});

test('a line left out by the exclusions is neither a hit nor a line of a sample', () => {
  const env = dayFixture();
  try {
    const id = (i: number) => messageSourceId('discord', `d${i}`, 1, 'seen');
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 8 });
    const found = sampling(env, theDay({ placeId: 'c1' }), {
      limit: 5,
      exclusions: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ kind: 'source' as const, sourceId: id(i) })),
    });
    assert.deepEqual(hitIds(found), ['d7']);
    assert.deepEqual(lineIds(found), ['d7']);
  } finally {
    env.done();
  }
});

// ---------- picture-only lines ----------

const { imageDescribed } = labels.transcript;
const imageTag = (text: string) => imageDescribed.replace('{text}', text);

test('a picture-only line of a sampled day comes back with the bare image marker when it has no description', async () => {
  const env = dayFixture();
  try {
    const source = env.say({ native: 'pic', at: DAY_START + 60 * DAY_MINUTE, text: '', place: DAY_GENERAL });
    // The kinds of a line live on its links: one bare item, as the migration leaves an old picture.
    env.db
      .prepare(
        "INSERT INTO media (id, kind, availability, scope_kind, scope_iface) VALUES ('media:bare:b', 'image', 'unknown', 'group', 'discord')"
      )
      .run();
    env.db
      .prepare(
        "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, 'media:bare:b')"
      )
      .run(source);
    const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(labels.transcript.image), text);
    assert.ok(!text.includes(NONE_MARK), text);
  } finally {
    env.done();
  }
});

test('a picture observed with its attachment id renders the description of the media table', async () => {
  const env = dayFixture();
  try {
    observePicture(env, {
      native: 'pic',
      at: DAY_START + 60 * DAY_MINUTE,
      attachments: [{ id: 'att-1', kind: 'image' }],
    });
    dayDescribe(env, 'att-1', 'a red bicycle by a wall');
    const rig = toolRig(env);
    const text = textOf(await rig.ask({ when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(imageTag('a red bicycle by a wall')), text);
    assert.deepEqual(rig.llmCalls, [], 'the read asks no model');
  } finally {
    env.done();
  }
});

test('two pictures on one line each carry their own description, in order', async () => {
  const env = dayFixture();
  try {
    observePicture(env, {
      native: 'pic',
      at: DAY_START + 60 * DAY_MINUTE,
      attachments: [
        { id: 'att-1', kind: 'image' },
        { id: 'att-2', kind: 'image' },
      ],
    });
    dayDescribe(env, 'att-1', 'a red bicycle');
    dayDescribe(env, 'att-2', 'a blue kettle');
    const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
    const first = text.indexOf(imageTag('a red bicycle'));
    const second = text.indexOf(imageTag('a blue kettle'));
    assert.ok(first >= 0 && second > first, text);
  } finally {
    env.done();
  }
});

for (const [name, setup] of [
  ['with no row in the media table', () => {}],
  ['whose row holds no description', (env: DayEnv) => dayDescribe(env, 'att-1', null)],
  [
    'whose row is retired',
    (env: DayEnv) => dayDescribe(env, 'att-1', 'a retired description', { retired: new Date(DAY_NOW).toISOString() }),
  ],
] as const) {
  test(`a picture ${name} renders the bare marker, nothing invented`, async () => {
    const env = dayFixture();
    try {
      observePicture(env, {
        native: 'pic',
        at: DAY_START + 60 * DAY_MINUTE,
        attachments: [{ id: 'att-1', kind: 'image' }],
      });
      setup(env);
      const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
      assert.ok(text.includes(labels.transcript.image), text);
      assert.ok(!text.includes('a retired description'), text);
    } finally {
      env.done();
    }
  });
}

// One row per item, and audience comes only from a link. A group line that shows an item reads
// its description; a DM's line stays out of a group by its own audience (the `audience:` tests earlier in this file hold that for each kind).
test('a group line reads the description of the item it shows, whichever reader told it', async () => {
  const env = dayFixture();
  try {
    observePicture(env, {
      native: 'pic',
      at: DAY_START + 60 * DAY_MINUTE,
      attachments: [{ id: 'att-1', kind: 'image' }],
    });
    dayDescribe(env, 'att-1', 'a red bicycle');
    const text = textOf(await toolRig(env).ask({ when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(imageTag('a red bicycle')), text);
  } finally {
    env.done();
  }
});

test('a picture line beside a word match carries its description too', async () => {
  const env = dayFixture();
  try {
    env.say({ native: 'word', at: DAY_START + 60 * DAY_MINUTE, text: 'το ποδηλατο', place: DAY_GENERAL });
    env.stem();
    observePicture(env, {
      native: 'pic',
      at: DAY_START + 61 * DAY_MINUTE,
      attachments: [{ id: 'att-1', kind: 'image' }],
    });
    dayDescribe(env, 'att-1', 'a red bicycle');
    const text = textOf(await toolRig(env).ask({ terms: 'ποδηλατο', when: '2026-11-01', placeId: 'c1' }));
    assert.ok(text.includes(imageTag('a red bicycle')), text);
    assert.ok(!text.includes(SAMPLED_MARK), text);
  } finally {
    env.done();
  }
});

// ---------- an ordinary word search ----------

/** The lines of each place around the rows the word index holds for a form: the word stream's windows, built by hand. */
function wordBaseline(env: DayEnv, form: string, around: number): Array<Array<string>> {
  const hits = env.db
    .prepare(
      `SELECT s.native_id AS native_id, s.place_id AS place_id, s.occurred_at AS occurred_at
       FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
       WHERE sources_fts MATCH ? ORDER BY s.occurred_at DESC`
    )
    .all(`{stems} : "${loadStemmer(env.db).stem(form)}"`);
  return hits.map((hit) => {
    const place = env.db
      .prepare('SELECT native_id FROM sources WHERE place_id = ? ORDER BY occurred_at')
      .all(hit.place_id as string)
      .map((row) => String(row.native_id));
    const at = place.indexOf(String(hit.native_id));
    return place.slice(Math.max(0, at - around), at + around + 1);
  });
}

function wordFixture(env: DayEnv) {
  spread(env, 'a', { from: DAY_START, to: DAY_END, count: 40 });
  spread(env, 'b', { from: DAY_START, to: DAY_END, count: 40, place: DAY_OTHER });
  env.say({ native: 'w1', at: DAY_START + 3 * 60 * DAY_MINUTE + 1, text: 'το ποδηλατο εδω', place: DAY_GENERAL });
  env.say({ native: 'w2', at: DAY_START + 20 * 60 * DAY_MINUTE + 1, text: 'και το ποδηλατο εκει', place: DAY_OTHER });
  env.stem();
}

const sansFollow = { ...DAY_SETTINGS, followMessages: 0 };

test('an ordinary word search gives the windows the word index computes', () => {
  const env = dayFixture();
  try {
    wordFixture(env);
    const found = search(env.db, {
      ctx: dayGroup,
      plan: planOf({ forms: ['ποδηλατο'] }),
      now: DAY_NOW,
      settings: sansFollow,
    });
    assert.deepEqual(
      found.windows.map((window) => window.messages.map((message) => message.id)),
      wordBaseline(env, 'ποδηλατο', DAY_SETTINGS.recordContext)
    );
  } finally {
    env.done();
  }
});

test('asking for the time stream changes nothing about a search whose words matched', () => {
  const env = dayFixture();
  try {
    wordFixture(env);
    channelRows(env);
    for (const plan of [
      planOf({ forms: ['ποδηλατο'] }),
      theDay({ forms: ['ποδηλατο'] }),
      theDay({ forms: ['ποδηλατο'], placeId: 'c1' }),
    ]) {
      const asked = { ctx: dayGroup, plan, now: DAY_NOW, settings: DAY_SETTINGS };
      const plain = search(env.db, asked);
      const withStream = search(env.db, { ...asked, sampleTime: true });
      assert.deepEqual(withStream.windows, plain.windows);
      assert.deepEqual(withStream.hits, plain.hits);
      assert.deepEqual(withStream.stats, plain.stats);
      assert.ok(plain.hits.length > 0);
    }
  } finally {
    env.done();
  }
});

test('the stream counts of a search stay the four named ones after a sample', () => {
  const env = dayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 10 });
    const found = sampling(env, theDay({ placeId: 'c1' }));
    assert.ok(found.hits.length > 0, 'the day has lines');
    assert.deepEqual(found.stats, { words: 0, trigram: 0, meaning: 0, people: 0 });
  } finally {
    env.done();
  }
});

// Recall in a direct chat with no root and an opaque partner: stored recall runs by the issued context, and its search
// reaches the person's DMs and nobody else's. Over the real database search and a service-issued context.
// Contract, plan 2026-11-04-cli-and-memory task 5: `hasRecallContext({ channel, partnerId, memoryContext })` has no `rootId`.
// Appendix entries: src/behavior/recall-reads.ts, src/behavior/recall-run.ts, src/behavior/recall-run-types.ts,
// src/behavior/recall.ts, src/turn/phases/request/lookup.ts, src/turn/pulls.ts.
describe('searches of opaque persons', () => {
  const NOW = Date.parse('2026-11-05T12:00:00.000Z');
  const opened: Array<MemoryDbService> = [];
  after(async () => {
    for (const service of opened) await service.close();
  });

  function line(
    db: Db,
    id: string,
    place: string,
    text: string,
    scope = 'dm',
    audience = `aud:dm:${place}`,
    ago = 1
  ): void {
    db.prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, direct, scope_kind, audience_id)
     VALUES (?, 'seen', (SELECT iface FROM places WHERE id = ?), ?, 1, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      place,
      id,
      place,
      new Date(NOW - ago * 86400000).toISOString(),
      new Date(NOW).toISOString(),
      text,
      scope,
      audience
    );
  }

  /** A group line of a place on `iface`, read by every group context. */
  const groupLine = (db: Db, id: string, place: string, text: string, { iface = 'discord', ago = 1 } = {}): void =>
    line(db, id, place, text, 'group', `aud:group:${iface}`, ago);

  /** A group place whose native id spells nothing of its place id, with the group audience of its interface. */
  function groupPlace(db: Db, id: string, iface: string, native: string): void {
    db.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', ?)").run(
      `aud:group:${iface}`,
      iface
    );
    db.prepare(
      `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, ?, 'channel', ?, ?, ?, 1, 'group', 'group')`
    ).run(id, iface, native, native, `${iface}/global`);
  }

  function serviceOver(more: (db: Db) => void = () => {}): MemoryDbService {
    const dataDir = tempDir('nep-recall-opaque-');
    const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
    const db = dbOf(seed);
    seedOpaqueWorld(db);
    line(db, 'src:far', 'place:dm-a21', 'the synthetic beekeeping plan on the other interface');
    line(db, 'src:his', BORIS_PLACE, 'the synthetic beekeeping plan of a stranger');
    more(db);
    fillStems(db);
    seed.close();
    const service = createMemoryDb({
      iface: () => 'discord',
      hot: { config: { memoryDb: { session: { mode: 'off' } } } },
      dataDir,
      log: { info() {}, debug() {}, warn() {}, error() {} },
      worker: false,
    });
    service.tick();
    opened.push(service);
    return service;
  }

  const searchIn = (service: MemoryDbService) => {
    const ctx = service.issueContext({ kind: 'dm', iface: 'discord', person: ANNA, place: 'place:dm-a11' });
    return search(dbOf(wrongly<Parameters<typeof dbOf>[0]>(service.readHandle())), {
      ctx,
      plan: { forms: ['beekeeping'], who: [], from: null, to: null },
      now: NOW,
    });
  };

  test('the search of an opaque person finds what they said in a linked DM on another interface', () => {
    // Bug: the context carries no linked places, so recall in one DM forgets the same person's other DM.
    const found = searchIn(serviceOver());
    const texts = JSON.stringify(found.hits);
    assert.ok(texts.includes('src:far'), texts);
  });

  test('the search of an opaque person never finds the DM of another person', () => {
    // Bug: widening by a native id or by subject reads a stranger's chat.
    const found = searchIn(serviceOver());
    assert.equal(JSON.stringify([found.hits, found.windows]).includes('src:his'), false);
  });

  const orchard = { forms: ['orchard'], who: [], from: null, to: null };
  const readOf = (service: MemoryDbService) => dbOf(wrongly<Parameters<typeof dbOf>[0]>(service.readHandle()));
  const groupAsking = (service: MemoryDbService) => ({
    ...service.issueContext({ kind: 'group', iface: 'discord', destination: GROUP_PLACE }),
    asker: [ANNA],
  });

  test('a group read is told when the opaque asker has a better match in their own DM', () => {
    // Bug: the asker's DM audience is spelled from the person id, so an opaque person's DM never gives the hint.
    const service = serviceOver((db) => line(db, 'src:own', 'place:dm-a11', 'the orchard by the river'));
    const found = search(readOf(service), { ctx: groupAsking(service), plan: orchard, now: NOW });
    assert.equal(found.hidden, true);
  });

  test('a group read is told nothing when the better match is an internal row', () => {
    // Bug: the spelled audience of an opaque asker resolves to the internal audience, so an internal row gives the hint.
    const service = serviceOver((db) =>
      line(db, 'src:inner', GROUP_PLACE, 'the orchard by the river', 'internal', 'aud:internal')
    );
    const found = search(readOf(service), { ctx: groupAsking(service), plan: orchard, now: NOW });
    assert.equal(found.hidden, false);
  });

  test('a search narrowed to a channel finds that channel by its stored native id', () => {
    // Bug: the place is spelled from the native id, so a channel whose id spells nothing is never found.
    const service = serviceOver((db) => {
      groupPlace(db, 'place:room-2', 'discord', 'n-room-2');
      groupLine(db, 'src:in-room', 'place:room-2', 'the orchard by the river');
      groupLine(db, 'src:elsewhere', GROUP_PLACE, 'the orchard by the river');
    });
    const ctx = service.issueContext({ kind: 'group', iface: 'discord', destination: GROUP_PLACE });
    const found = search(readOf(service), { ctx, plan: { ...orchard, placeId: 'n-room-2' }, now: NOW });
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      ['src:in-room']
    );
  });

  test('an equal hit on the interface of the read comes before one on another interface', () => {
    // Bug: the interface is read from the place id's prefix, so two opaque places of different interfaces tie.
    const service = serviceOver((db) => {
      groupPlace(db, 'place:room-2', 'discord', 'n-room-2');
      groupPlace(db, 'place:room-9', 'telegram', 'n-room-9');
      groupLine(db, 'src:near', 'place:room-2', 'the orchard by the river', { ago: 5 });
      groupLine(db, 'src:far-away', 'place:room-9', 'the orchard by the river', { iface: 'telegram' });
    });
    const ctx = service.issueContext({ kind: 'group', iface: 'discord', destination: GROUP_PLACE });
    const found = search(readOf(service), {
      ctx,
      plan: orchard,
      now: NOW,
      settings: { ...dbSettings({})!, gateShare: 0 },
    });
    assert.deepEqual(
      found.hits.map((hit) => hit.id),
      ['src:near', 'src:far-away']
    );
  });
});

// One sent line, one `sources` row. The interface echoes the persona's own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.

const SINGLE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = SINGLE_NOW - 60_000;
const IFACE = 'synthetic';
const SINGLE_ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, SINGLE_ROOT);
const ROOM = 'room-a';
const SELF_ID = 'her-account';
const WORDS = 'κουνέλι στον κήπο';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

/** The `message.received` event of a line: the persona's when `author` is their id, as the interface delivers their own echo. */
function singleLineEvent({
  id = 'sent-1',
  author = SELF_ID,
  at = SENT,
  text = WORDS,
  replyToId,
  mentionedAccountIds = [],
}: {
  id?: string;
  author?: string;
  at?: number;
  text?: string;
  replyToId?: string;
  mentionedAccountIds?: Array<string>;
} = {}) {
  return {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: SINGLE_ROOT },
    addressing: { mentionedAccountIds },
    message: {
      id,
      at,
      content: text,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

async function singleObserveLine(memory: Memory, options: Parameters<typeof singleLineEvent>[0] = {}): Promise<string> {
  const envelope = observationOf(singleLineEvent(options), { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

/** The record line of the persona's send, as recordSaid builds it, appended with no descriptor as every said writer does. */
async function recordSent(memory: Memory, { mentionedAccountIds = [] }: { mentionedAccountIds?: Array<string> } = {}) {
  const line = toRecordLine(
    { id: 'sent-1', placeId: ROOM, content: WORDS, ts: SENT, replyToId: null, mentionedAccountIds },
    { kind: 'said', now: () => SINGLE_NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => SINGLE_NOW }).append(TOP, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

async function withEchoedLine(run: (memory: Memory, db: Db) => Promise<void> | void): Promise<void> {
  const memory = await openTestMemory({ now: () => SINGLE_NOW, iface: () => IFACE });
  try {
    await singleObserveLine(memory);
    await recordSent(memory);
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test("recall finds the persona's echoed line once", async () => {
  // Bug: a word search returns the same sentence twice and spends two of its slots on it.
  await withEchoedLine((_memory, db) => {
    const found = search(db, {
      ctx: groupContext(IFACE),
      plan: { forms: ['κουνέλι'], who: [], from: null, to: null },
      now: SINGLE_NOW,
    });
    const lines = JSON.stringify(found).split(WORDS).length - 1;
    assert.equal(lines, 1);
  });
});
