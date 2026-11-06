// The owner's plan fill for old diary entries (`/memory backfill-plans`, src/memory/db/selfreflection-plan-fill.ts): every
// live entry with no `extra.plan` is shown to the analyzer once, oldest first, with its kind, text, scene and the seed
// families, under a strict JSON schema, and the answer becomes a reconstructed plan written through the one writer. An
// entry with a scene gets one line of each family, a thought and a meme the brief alone. A failed request leaves its
// entry for the next run. The real memory service and stores over a temporary data directory, a scripted model,
// invented entries only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../bin/neptunia-request.ts';
import { parseSeedFamilies, usedSeedLines } from '../src/behavior/selfreflection.ts';
import { commandLineWords, parseCommandLine } from '../src/interface/commands/table.ts';
import { planFillSchema, selfreflectionPlanFillDesk } from '../src/memory/db/selfreflection-plan-fill.ts';
import type { PlanFillDeskState } from '../src/memory/db/selfreflection-plan-fill.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import type { CompleteOptions } from '../src/llm/openrouter.ts';
import { labels } from './fixtures/labels.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const PURPOSE = 'selfreflection-plan-fill';
const SEEDS = [
  '# place',
  'a harbour town',
  'a mountain village',
  '# setting',
  'an attic room',
  'a ferry deck',
  '# detail',
  'a cracked teacup',
  'a paper lantern',
  '# activity',
  'sorting old letters',
  'feeding pigeons',
  '# subject',
  'a stray cat',
  'a broken clock',
  '# twist',
  'it starts to snow',
  'the power goes out',
].join('\n');
const FAMILIES = parseSeedFamilies(SEEDS);
const SCENE_LINES = [
  'a harbour town',
  'a ferry deck',
  'a paper lantern',
  'feeding pigeons',
  'a stray cat',
  'it starts to snow',
];
const AUDIENCE = { kind: 'interface', iface: 'fake' };

/** The invented entries, by id: their kind, time, text, drawing prompt and, for some, a plan or an audience. */
const ENTRIES = {
  sketch: {
    kind: null,
    at: NOW - 5 * DAY,
    text: 'Drew the lighthouse from memory today.',
    picture: 'a lighthouse sketch',
  },
  pier: { kind: 'picture', at: NOW - 4 * DAY, text: 'The pier was empty and I liked it.', picture: 'a pier prompt' },
  musing: { kind: 'thought', at: NOW - 3 * DAY, text: 'Why do clocks in old houses always run late?', picture: null },
  planned: { kind: 'status', at: NOW - 2 * DAY, text: 'A slow day of tea and rain.', picture: null },
  meme: { kind: 'meme', at: NOW - DAY, text: 'When the kettle boils the moment you leave.', picture: 'a kettle meme' },
} as const;
type EntryName = keyof typeof ENTRIES;
const idOf = (name: EntryName): string => `selfreflection:${name}`;
/** The description of the pier entry's first linked picture: its scene. */
const PIER_PICTURE = 'a wooden pier under a full moon';
const OLD_PLAN = { brief: 'tea and rain', seeds: [['a mountain village', 'an attic room']], seed: 1 };

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<TestMemory> = [];
after(async () => {
  for (const memory of OPEN.splice(0)) await memory.close();
});

type Store = ReturnType<typeof createStore>;
type Post = Parameters<Store['appendSelfreflectionPost']>[0];

/** The database the service reads, for the test's own reads and its picture links. */
function dbOfService(memory: TestMemory): Db {
  const handle = memory.memoryDb.readHandle() as { db: unknown };
  return dbOf(handle);
}

/** A memory with the entries `names` recorded through a store, and the pier entry's two pictures linked. */
async function seeded(names: ReadonlyArray<EntryName>): Promise<{ memory: TestMemory; writer: Store }> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'fake' });
  OPEN.push(memory);
  const writer = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  for (const name of names) {
    const { kind, at, text, picture } = ENTRIES[name];
    // The store's post type names a new entry's fields; an old entry is the same post without a plan.
    const post: Record<string, unknown> = { at, kind, gist: text, text, picture, search: null, itemId: idOf(name) };
    if (name === 'planned') post.plan = OLD_PLAN;
    if (name === 'pier') post.publicationAudience = AUDIENCE;
    writer.appendSelfreflectionPost(post as Post, { max: 40 });
  }
  writer.flush();
  await writer.flushSettled({});
  if (names.includes('pier')) linkPictures(dbOfService(memory));
  return { memory, writer };
}

/** Two described pictures linked to the pier entry, the first one its scene. */
function linkPictures(db: Db): void {
  const group = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };
  const picture = (id: string, description: string) => ({
    id,
    kind: 'image',
    owner: idOf('pier'),
    path: `media/selfreflection/${id}.png`,
    native_ref: null,
    description,
    mime: 'image/png',
    ...group,
  });
  insertRows(
    db,
    {
      media: [picture('media:pier-1', PIER_PICTURE), picture('media:pier-2', 'a gull on a post')],
      media_links: ['media:pier-1', 'media:pier-2'].map((id, position) => ({
        owner_kind: 'selfreflection',
        owner_id: idOf('pier'),
        position,
        media_id: id,
      })),
    },
    { at: new Date(NOW).toISOString() }
  );
}

type Message = { role: string; content: unknown };
type Call = { entry: EntryName | null; text: string; options: CompleteOptions };
type Format = { name?: unknown; schema?: unknown };

/** The text of every message of a request, joined. */
const textOf = (messages: Array<Message>): string =>
  messages
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');

/** The entry a request is about: the one whose text it carries. */
function entryIn(text: string): EntryName | null {
  const names = Object.keys(ENTRIES) as Array<EntryName>;
  return names.find((name) => text.includes(ENTRIES[name].text)) ?? null;
}

/** The response format a call handed the client. */
function formatOf(options: CompleteOptions): Format {
  const { responseFormat } = options;
  assert.ok(responseFormat, 'the call carries a response format');
  return responseFormat;
}

/** The schema of a call's response format. */
function schemaOf(options: CompleteOptions): unknown {
  return formatOf(options).schema;
}

/**
 * A model that answers by the schema it is handed: one fixed line of every family when the schema names `place`, the
 * brief alone otherwise. `answer` overrides the text for an entry; one that throws makes the request fail.
 */
function scriptedModel(answer: Partial<Record<EntryName, () => string>> = {}) {
  const calls: Array<Call> = [];
  return {
    calls,
    complete(messages: Array<Message>, options: CompleteOptions): Promise<{ text: string }> {
      const text = textOf(messages);
      const entry = entryIn(text);
      calls.push({ entry, text, options });
      const own = entry ? answer[entry] : undefined;
      if (own) return Promise.resolve().then(() => ({ text: own() }));
      const schema = schemaOf(options) as { properties?: Record<string, unknown> } | undefined;
      const scene = Object.hasOwn(schema?.properties ?? {}, 'place');
      const brief = `the brief of ${entry ?? 'nothing'}`;
      if (!scene) return Promise.resolve({ text: JSON.stringify({ brief }) });
      const [place, setting, detail, activity, subject, twist] = SCENE_LINES;
      return Promise.resolve({ text: JSON.stringify({ brief, place, setting, detail, activity, subject, twist }) });
    },
  };
}

/** The live settings and prompts of a run. */
const hot = () => ({
  config: {
    models: { base: { core: 'test-core', analyzer: 'test-analyzer' } },
    llm: { maxRequestTokens: 50000, maxRequestsPerDay: 300 },
  },
  prompts: {
    'selfreflection-plan-fill': 'PLAN_FILL_SYSTEM',
    'selfreflection-seeds': SEEDS,
    labels,
  },
});

type Logged = Array<{ message: string; fields: unknown }>;

/** One run of the desk to its end over the memory: its first answer, its last state and the log lines it wrote. */
async function fill(
  memory: TestMemory,
  model: ReturnType<typeof scriptedModel>,
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<{ first: PlanFillDeskState; last: PlanFillDeskState; logged: Logged }> {
  const logged: Logged = [];
  const desk = selfreflectionPlanFillDesk({
    memoryDb: memory.memoryDb,
    llm: model,
    hot: hot(),
    now: () => NOW,
    log: { warn: (message: string, fields?: Row) => void logged.push({ message, fields }) },
  });
  const first = await desk.start({ dryRun });
  while (desk.status().state === 'running') await new Promise((resolve) => setImmediate(resolve));
  return { first, last: desk.status(), logged };
}

/** The report a finished run holds. */
function reportOf(desk: PlanFillDeskState) {
  // The lead: the parameter is named `desk`, for the chain rule.
  const state = desk;
  assert.equal(desk.state, 'done', JSON.stringify(state));
  const { report } = desk;
  assert.ok(report, 'a finished run holds its report');
  return report;
}

/** The posts as a store that opens now reads them. */
function postsOf(memory: TestMemory) {
  const reader = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  return reader.getSelfreflection().posts;
}

/** The plan a store that opens now reads for an entry. */
function planOf(memory: TestMemory, name: EntryName): unknown {
  const post = postsOf(memory).find((one) => one.itemId === idOf(name));
  assert.ok(post, name);
  return post.plan;
}

const asked = (model: ReturnType<typeof scriptedModel>): Array<EntryName | null> =>
  model.calls.map((call) => call.entry);

/** The call about one entry. */
function callAbout(model: ReturnType<typeof scriptedModel>, name: EntryName): Call {
  const call = model.calls.find((one) => one.entry === name);
  assert.ok(call, `a request about ${name}`);
  return call;
}

const ALL: ReadonlyArray<EntryName> = ['sketch', 'pier', 'musing', 'planned', 'meme'];

// ---------- what is asked ----------

test('every entry with no plan is asked about once, oldest first, and an entry with a plan is not', async () => {
  // Bug: the fill asks about entries #662 already planned and overwrites a real plan with a guess, or works newest first.
  const { memory } = await seeded(ALL);
  const model = scriptedModel();
  await fill(memory, model);
  assert.deepEqual(asked(model), ['sketch', 'pier', 'musing', 'meme']);
  assert.deepEqual(planOf(memory, 'planned'), OLD_PLAN);
});

test('a retired entry is not asked about', async () => {
  // Bug: the fill reads every row, spends a request on an entry nobody sees and writes a plan into a retired row.
  const { memory } = await seeded(['musing', 'meme']);
  dbOfService(memory)
    .prepare('UPDATE selfreflection SET retired_at = ? WHERE id = ?')
    .run(new Date(NOW - DAY).toISOString(), idOf('musing'));
  const model = scriptedModel();
  await fill(memory, model);
  assert.deepEqual(asked(model), ['meme']);
});

test('the request runs on the analyzer under its purpose and hands the client the named schema of its entry', async () => {
  // Bug: the schema never reaches the client, or the usage line and the rails read the request as a reply of hers.
  const { memory } = await seeded(['pier', 'musing']);
  const model = scriptedModel();
  await fill(memory, model);
  for (const [name, scene] of [
    ['pier', true],
    ['musing', false],
  ] as const) {
    const { options } = callAbout(model, name);
    assert.deepEqual([options.role, options.purpose], ['analyzer', PURPOSE], name);
    const format = formatOf(options);
    assert.ok(typeof format.name === 'string' && format.name !== '', name);
    assert.deepEqual(schemaOf(options), planFillSchema(FAMILIES, scene), name);
  }
});

test('the request shows the entry its kind, its text, the description of its first picture and every seed line', async () => {
  // Bug: the model is asked to guess a scene it never sees, or picks from a part of the families.
  const { memory } = await seeded(['pier']);
  const model = scriptedModel();
  await fill(memory, model);
  const { text } = callAbout(model, 'pier');
  for (const shown of ['picture', ENTRIES.pier.text, PIER_PICTURE, ...Object.values(FAMILIES).flat()])
    assert.ok(text.includes(shown), shown);
});

test('an entry with no described picture shows its drawing prompt as its scene', async () => {
  // Bug: an entry the backfill imported has only its prompt, and the fill treats it as an entry with no scene.
  const { memory } = await seeded(['sketch']);
  const model = scriptedModel();
  await fill(memory, model);
  const { text, options } = callAbout(model, 'sketch');
  assert.ok(text.includes(ENTRIES.sketch.picture), text);
  assert.deepEqual(schemaOf(options), planFillSchema(FAMILIES, true));
});

test('a meme with a picture is asked for the brief alone', async () => {
  // Bug: the fill keys the scene on the picture alone, so a meme that built on no seed gets six invented lines.
  const { memory } = await seeded(['meme']);
  const model = scriptedModel();
  await fill(memory, model);
  assert.deepEqual(schemaOf(callAbout(model, 'meme').options), planFillSchema(FAMILIES, false));
});

// ---------- what is stored ----------

test('an entry with a picture gets a reconstructed plan of six lines and a thought the brief alone', async () => {
  // Bug: the answer is parsed and dropped, or a thought entry gets a combination it never built on.
  const { memory } = await seeded(['pier', 'musing']);
  const { last } = await fill(memory, scriptedModel());
  assert.deepEqual(planOf(memory, 'pier'), {
    brief: 'the brief of pier',
    seeds: [SCENE_LINES],
    seed: 1,
    reconstructed: true,
  });
  assert.deepEqual(planOf(memory, 'musing'), { brief: 'the brief of musing', seeds: [], seed: 0, reconstructed: true });
  const report = reportOf(last);
  assert.deepEqual([report.filled, report.withSeeds, report.briefOnly, report.failed, report.left], [2, 1, 1, 0, 0]);
});

test('the fill changes nothing of an entry but its plan: text, time, scope and audience stay', async () => {
  // Bug: the write rewrites the row from a partial post, so the entry loses its text, moves in time or widens its readers.
  const { memory } = await seeded(['pier']);
  const db = dbOfService(memory);
  const read = () => db.prepare('SELECT * FROM selfreflection WHERE id = ?').get(idOf('pier')) as Row;
  const { extra: before, ...restBefore } = read();
  await fill(memory, scriptedModel());
  const { extra: afterFill, ...restAfter } = read();
  assert.equal(restAfter.text, ENTRIES.pier.text);
  assert.equal(restAfter.at_ms, ENTRIES.pier.at);
  assert.deepEqual(
    [restAfter.scope_kind, restAfter.scope_iface, restAfter.retired_at],
    [restBefore.scope_kind, restBefore.scope_iface, restBefore.retired_at]
  );
  const keptExtra = JSON.parse(String(afterFill)) as Row;
  delete keptExtra.plan;
  assert.deepEqual(keptExtra, JSON.parse(String(before)) as Row);
  assert.deepEqual(keptExtra.publicationAudience, AUDIENCE);
});

test('after the fill usedSeedLines over the posts returns the stored lines', async () => {
  // Bug: the reconstructed plan is stored where usedSeedLines does not look, so the next draw offers the same scene.
  const { memory } = await seeded(['pier', 'musing']);
  await fill(memory, scriptedModel());
  assert.deepEqual([...usedSeedLines(postsOf(memory))].sort(), [...SCENE_LINES].sort());
});

test('a store that read the diary before the fill reads the reconstructed plan after it', async () => {
  // Bug: the running core's store keeps the posts it cached before the run, so the next draw and <diary> never see
  // the fill until a restart.
  const { memory, writer } = await seeded(['pier']);
  writer.getSelfreflection();
  await fill(memory, scriptedModel());
  const post = writer.getSelfreflection().posts.find((one) => one.itemId === idOf('pier'));
  assert.deepEqual(usedSeedLines(post ? [post] : []).size, SCENE_LINES.length);
});

test('a new entry recorded after the fill keeps the reconstructed plan of the old one', async () => {
  // Bug: the store writes its whole cached diary back with the next entry and erases every plan the fill wrote.
  const { memory, writer } = await seeded(['pier']);
  writer.getSelfreflection();
  await fill(memory, scriptedModel());
  const later: Record<string, unknown> = {
    at: NOW,
    kind: 'status',
    gist: 'a new evening',
    text: 'a new evening',
    picture: null,
    search: null,
    itemId: 'selfreflection:later',
  };
  writer.appendSelfreflectionPost(later as Post, { max: 40 });
  writer.flush();
  await writer.flushSettled({});
  assert.deepEqual(planOf(memory, 'pier'), {
    brief: 'the brief of pier',
    seeds: [SCENE_LINES],
    seed: 1,
    reconstructed: true,
  });
});

test('the stored plan survives a reopen of the database', async () => {
  // Bug: the plan lands in a cache or a write that never commits, and the next start finds the entry empty again.
  const { memory } = await seeded(['pier']);
  await fill(memory, scriptedModel());
  const { dataDir } = memory;
  OPEN.splice(OPEN.indexOf(memory), 1);
  await memory.close();
  const reopened = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'fake' });
  OPEN.push(reopened);
  assert.deepEqual(planOf(reopened, 'pier'), {
    brief: 'the brief of pier',
    seeds: [SCENE_LINES],
    seed: 1,
    reconstructed: true,
  });
});

// ---------- runs and failures ----------

test('a second run asks about nothing and writes nothing', async () => {
  // Bug: the fill does not see its own plans as plans and spends a request on every entry at every run.
  const { memory } = await seeded(['pier', 'musing']);
  await fill(memory, scriptedModel());
  const again = scriptedModel();
  const { last } = await fill(memory, again);
  assert.deepEqual(asked(again), []);
  const report = reportOf(last);
  assert.deepEqual([report.filled, report.failed, report.left], [0, 0, 0]);
});

test('a failed request leaves its entry, is counted under its code, and the next entry is still filled', async () => {
  // Bug: one provider error ends the run, or marks the entry as done, so it is never asked about again.
  const { memory } = await seeded(['pier', 'musing']);
  const failing = scriptedModel({
    pier: () => {
      throw Object.assign(new Error('upstream'), { code: 'INVENTED_UPSTREAM' });
    },
  });
  const { last } = await fill(memory, failing);
  assert.equal(planOf(memory, 'pier'), undefined);
  assert.deepEqual(planOf(memory, 'musing'), { brief: 'the brief of musing', seeds: [], seed: 0, reconstructed: true });
  const report = reportOf(last);
  assert.deepEqual([report.filled, report.failed, report.left], [1, 1, 1]);
  assert.deepEqual(report.codes, { INVENTED_UPSTREAM: 1 });
  const retry = scriptedModel();
  await fill(memory, retry);
  assert.deepEqual(asked(retry), ['pier']);
});

test('an answer that is not JSON or names a line outside its family leaves the entry and is counted failed', async () => {
  // Bug: a provider that ignores the schema gets an invented seed stored, or a parse error stops the run.
  const { memory } = await seeded(['sketch', 'pier', 'musing']);
  const model = scriptedModel({
    sketch: () => 'the lighthouse, I think',
    pier: () =>
      JSON.stringify({
        brief: 'a night on the pier',
        place: 'a ferry deck',
        setting: 'an attic room',
        detail: 'a paper lantern',
        activity: 'feeding pigeons',
        subject: 'a stray cat',
        twist: 'it starts to snow',
      }),
  });
  const { last } = await fill(memory, model);
  assert.equal(planOf(memory, 'sketch'), undefined);
  assert.equal(planOf(memory, 'pier'), undefined);
  const report = reportOf(last);
  assert.deepEqual([report.filled, report.failed, report.left], [1, 2, 2]);
  const codes = Object.values(report.codes).reduce((sum, count) => sum + count, 0);
  assert.equal(codes, 2);
});

test('the log of a run holds counts and codes, never an entry text, scene or brief', async () => {
  // Bug: a failure line quotes the entry or the answer, and her diary ends up in the journal.
  const { memory } = await seeded(['pier', 'musing']);
  const model = scriptedModel({ pier: () => 'not json at all' });
  const { logged } = await fill(memory, model);
  const written = JSON.stringify(logged);
  for (const secret of [ENTRIES.pier.text, ENTRIES.musing.text, PIER_PICTURE, 'the brief of musing', 'not json at all'])
    assert.equal(written.includes(secret), false, secret);
});

test('a dry run counts the entries to fill with no request and no write', async () => {
  // Bug: the dry run spends the requests it only meant to count, or counts entries that already have a plan.
  const { memory } = await seeded(ALL);
  const model = scriptedModel();
  const { first } = await fill(memory, model, { dryRun: true });
  const report = reportOf(first);
  assert.deepEqual([report.toFill, report.filled, report.left], [4, 0, 4]);
  assert.deepEqual(asked(model), []);
  assert.equal(planOf(memory, 'pier'), undefined);
});

test('a run over a diary with no entries asks nothing and reports zeros', async () => {
  const { memory } = await seeded([]);
  const model = scriptedModel();
  const { last } = await fill(memory, model);
  const report = reportOf(last);
  assert.deepEqual(
    [report.toFill, report.filled, report.withSeeds, report.briefOnly, report.failed, report.left],
    [0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(asked(model), []);
});

// ---------- the owner's command ----------

test('/memory backfill-plans parses the same from the chat and from argv', () => {
  // Bug: the command is wired on one surface only, so the owner can start the fill from the chat but not from the shell.
  const line = '/memory backfill-plans';
  const fromChat = parseCommandLine(line);
  assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
  assert.equal(fromChat.name, 'memory.backfill-plans');
  assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
});
