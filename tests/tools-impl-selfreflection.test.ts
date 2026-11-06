// The diary turn's tools and the restriction a diary entry keeps through storage and reads. Real turn runner, admin,
// store and memory database over the fake interface, with two enabled mirrors and a scripted model. Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { issueContext, type Context } from '../src/memory/db/scope.ts';
import { wakeInputs } from '../src/behavior/selfreflection-turn.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { walk } from '../src/memory/db/graph.ts';
import { utcDay } from '../src/time.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createMirrors, guardMirrorPort } from '../src/behavior/mirror.ts';
import { createTurnRunner } from '../src/behavior/turn.ts';
import { createAdmin } from '../src/admin.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createStore } from '../src/memory/store.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { seedMirror } from './fixtures/selfreflection-mirror.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { DISCORD, rawMessage, sequenceLlm } from './fixtures/turn-harness.ts';
import { selfreflectionToolHot } from './fixtures/selfreflection-tool.ts';
import { freshWorld, world } from './fixtures/turn-world.ts';
import '../src/tools/impl/index.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const GUILD = 'g1';
const MAX_PER_DAY = 3;

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/**
 * A community with `general` (c1), where Alice wrote last, and the diary's two enabled mirrors `journal` (d1) and
 * `notes` (d2), on a fake interface; a real store over memory, the publisher over the interface's own port, and her
 * tools through a real admin over the guarded port. `postsToday` diary entries are already counted today.
 */
async function community({ postsToday = 0 }: { postsToday?: number } = {}) {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  freshWorld();
  const line = (placeId: string) => ({
    ...rawMessage({ id: `m-${placeId}`, ts: NOW - 30_000, content: 'γεια' }),
    placeId,
  });
  // Her own earlier post in c1 with a picture: what a media repost takes.
  const ownPicture = {
    ...rawMessage({ id: 'p-own', ts: NOW - 60_000, content: '' }),
    placeId: 'c1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    attachments: new Map([
      [
        'att-own',
        { id: 'att-own', name: 'pier.png', url: 'https://cdn.example/pier.png', contentType: 'image/png', size: 3 },
      ],
    ]),
  };
  world().channel({ id: 'c1', name: 'general', placeId: GUILD, historyMessages: [ownPicture, line('c1')] });
  world().channel({ id: 'd1', name: 'journal', placeId: GUILD });
  world().channel({ id: 'd2', name: 'notes', placeId: GUILD });
  for (const [id, name] of [
    ['d1', 'journal'],
    ['d2', 'notes'],
  ] as const)
    seedMirror(memory.memoryDb, { iface: 'fake', conversationId: id, name, at: NOW });
  // Her GIF library holds one GIF, `g1`, posted as its address.
  const store = Object.assign(createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb }), {
    findGif: (_guildId: string, handle: string) =>
      handle === 'g1' ? { id: 'g1', url: 'https://media.example/g1.gif', file: null } : null,
    recordOwnGif: () => {},
  });
  // The diary cap counts by the admin's own clock, the real one, so the seeded day is today's.
  if (postsToday > 0)
    Object.assign(store.state.data, { selfreflectionDay: utcDay(Date.now()), selfreflectionPosts: postsToday });
  const adapter = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const reads = world().adopt(adapter);
  const mirrors = createMirrors({
    memoryDb: memory.memoryDb,
    port: () => adapter,
    now: () => NOW,
    dataDir: memory.dataDir,
  });
  const port = guardMirrorPort(adapter, { memoryDb: memory.memoryDb });
  const texts = (conversationId: string) => adapter.messagesIn(conversationId).map((message) => message.text);
  // A file one of her errands brought back.
  const filePath = path.join(memory.dataDir, 'notes.txt');
  fs.writeFileSync(filePath, 'σημειώσεις');
  const errands = { fileOf: () => ({ name: 'notes.txt', path: filePath, contentType: 'text/plain' }) };
  return { memory, store, adapter, reads, mirrors, port, texts, errands };
}

type Community = Awaited<ReturnType<typeof community>>;

/** An intention due in c1: an inner turn of hers. */
const INTENTION_WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'γράψε στο ημερολόγιο', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
};

/**
 * One turn of hers over `core`: an ordinary reply to Alice in c1, an inner turn in c1 for `wake`, or the diary turn.
 * Returns the logs and the scripted model.
 */
async function turnOf(
  core: Community,
  {
    answers,
    mode = 'reply',
    onAnswer = null,
    memoryContext,
  }: {
    answers: Array<unknown>;
    mode?: 'reply' | 'inner' | 'selfreflection';
    onAnswer?: ((index: number) => void) | null;
    memoryContext?: Context;
  }
) {
  const hot = selfreflectionToolHot({ maxPerDay: MAX_PER_DAY });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store: core.store,
    client,
    isServedCommunity: (id: unknown) => id === GUILD,
    port: core.port,
    reads: core.reads,
    errands: core.errands,
    // The download of her own picture a media repost takes.
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new Uint8Array([7, 8, 9]).buffer),
      }),
  });
  const llm = sequenceLlm(answers, 'none', onAnswer);
  const turns = createTurnRunner({
    hot,
    store: core.store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    // What the runner takes and this scene has none of: no describer, search, emoji or routes.
    describer: undefined,
    lookup: undefined,
    emoji: undefined,
    routeChannels: undefined,
    images: undefined,
    now: () => NOW,
    port: core.port,
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    skills: skillRegistry(),
    journal: null,
    // Her errands' files, which a post may carry.
    errands: core.errands,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
  });
  const conversation = { iface: 'fake', conversationId: 'c1' };
  const trigger = {
    id: 'm-c1',
    placeId: 'c1',
    authorId: 'u1',
    authorName: 'Alice',
    self: false,
    bot: false,
    content: 'γεια',
    ts: NOW - 30_000,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
  // One call per kind of turn, each written in the call, so runTurn's declared parameter types it; the selfreflection
  // wake has no conversation (section 3 item 2).
  const run = () =>
    mode === 'inner'
      ? turns.runTurn({
          conversation,
          memoryContext,
          placeId: GUILD,
          mode: 'inner',
          triggerKind: 'inner',
          inner: { wake: INTENTION_WAKE, shadow: false, mayAct: () => true },
        })
      : mode === 'selfreflection'
        ? turns.runTurn({
            memoryContext,
            mode: 'selfreflection',
            selfreflection: { kind: 'status', forced: true },
            placeId: GUILD,
          })
        : turns.runTurn({ memoryContext, conversation, mode: 'reply', triggerKind: 'mention', trigger });
  const { logs } = await withCapturedLogs(run);
  await core.store.flushSettled({});
  return { logs: logs as Array<Record<string, unknown>>, llm };
}

/** The `skills: called` lines of a turn, as `skill:status` and the code when there is one. */
const calledOf = (logs: Array<Record<string, unknown>>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map(
      (entry) =>
        `${String(entry.skill)}:${String(entry.status)}${typeof entry.code === 'string' ? `/${entry.code}` : ''}`
    );

/** The tools a request offered her, by their API names. */
const offeredIn = (options: unknown): Array<string> =>
  ((options as { tools?: Array<{ function: { name: string } }> } | undefined)?.tools ?? []).map(
    (tool) => tool.function.name
  );

// The diary turn keeps its requests byte for byte (section 4): the tools its writer request offers, and how it answers
// a `message.create` call, are what the code of main gave for the same turn in the diary channel
// (tests/fixtures/selfreflection-tool.json, recorded under the same settings).
test('the diary turn offers the tools and answers a diary call as the diary channel turn did', async () => {
  const recorded = JSON.parse(
    fs.readFileSync(new URL('./fixtures/selfreflection-tool.json', import.meta.url), 'utf8')
  ) as {
    writerHasTools: boolean;
    writerTools: Array<string>;
    called: Array<string>;
  }; // this test's own fixture, written by the recording of the scene on main
  // PR 7d: voice messages are code, so the recorded writer tools gained voice_say.
  const core = await community();
  const plan = JSON.stringify({ kind: 'status', brief: 'a quiet day', search: '', picture: false });
  const { llm, logs } = await turnOf(core, {
    mode: 'selfreflection',
    answers: [
      plan,
      toolAnswer('<msg>μια ήσυχη μέρα</msg>', [call('message.create', { text: 'x' })]),
      '<msg>μια ήσυχη μέρα</msg>',
    ],
  });
  const writer = llm.options[1] as Record<string, unknown> | undefined; // the scripted model keeps each request's options
  assert.ok(writer, 'the diary turn made its writer request');
  assert.equal('tools' in writer, recorded.writerHasTools);
  assert.deepEqual(offeredIn(writer), recorded.writerTools);
  assert.deepEqual(calledOf(logs), recorded.called);
});

const PRIVATE_SELFREFLECTION = 'private-diary-marker-731';
const PUBLIC_SELFREFLECTION = 'ordinary-diary-marker-942';
const PRIVATE_BOUNDARY = { kind: 'internal-turn', origin: { iface: 'fake', conversationId: 'c1' } } as const;
const internalSelfreflectionContext = () =>
  issueContext({ kind: 'internal', now: () => NOW, newId: () => 'ctx:private-diary' });

function selfreflectionDb(core: Community) {
  const handle = core.memory.memoryDb.readHandle();
  assert.ok(handle);
  return dbOf(handle);
}

function seedRestrictedSelfreflection(core: Community, metadata: unknown = PRIVATE_BOUNDARY): void {
  // Public store writes reproduce restored metadata without granting a model control over it.
  const post = {
    at: NOW - 60000,
    kind: 'status',
    gist: PRIVATE_SELFREFLECTION,
    picture: null,
    search: '',
    text: PRIVATE_SELFREFLECTION,
    itemId: 'selfreflection:restricted-seed',
    publicationBoundary: metadata,
    send: { messages: [PRIVATE_SELFREFLECTION], mentions: [[]] },
  };
  core.store.appendSelfreflectionPost(post);
}

for (const metadata of [PRIVATE_BOUNDARY, null, { kind: 'internal-turn', origin: {} }]) {
  test(`restored ${metadata === PRIVATE_BOUNDARY ? 'valid' : metadata === null ? 'null' : 'malformed'} diary restriction hides the entry from outward reads`, async () => {
    // Catches group-scoped diary rows exposing internal text after a mapper round trip.
    const core = await community();
    seedRestrictedSelfreflection(core, metadata);
    await core.store.flushSettled({});
    const db = selfreflectionDb(core);
    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE kind = 'selfreflection' AND row_id = ?")
      .get('selfreflection:restricted-seed');
    assert.ok(node && typeof node.id === 'string');
    const owner = walk(db, internalSelfreflectionContext(), { from: node.id, maxDepth: 0 });
    assert.ok(owner.rows.some((row) => row.rowId === 'selfreflection:restricted-seed'));
    const outward = issueContext({ kind: 'group', iface: 'fake', now: () => NOW });
    assert.deepEqual(walk(db, outward, { from: node.id, maxDepth: 0 }).rows, []);
    const restored = createStore({ dataDir: core.memory.dataDir, memoryDb: core.memory.memoryDb });
    const post = restored.getSelfreflection().posts[0];
    assert.ok(post && 'publicationBoundary' in post);
    assert.deepEqual(post.publicationBoundary, metadata);
  });
}

test('selfreflection history omits restricted stored diary text and retains ordinary entries', async () => {
  // Catches the raw diary fallback leaking a private entry despite a correct graph audience.
  const core = await community();
  seedRestrictedSelfreflection(core);
  core.store.appendSelfreflectionPost({
    at: NOW - 120000,
    kind: 'status',
    gist: PUBLIC_SELFREFLECTION,
    picture: null,
    search: '',
    text: PUBLIC_SELFREFLECTION,
    itemId: 'selfreflection:ordinary-seed',
  });
  await core.store.flushSettled({});
  const inputs = await wakeInputs({
    store: core.store,
    conversationInfo: () => Promise.resolve(null),
    iface: 'fake',
    selfId: 'self-id',
    selfName: 'Bot',
    config: { context: { channelMessages: 50 } },
  });
  assert.equal(JSON.stringify(inputs.history).includes(PRIVATE_SELFREFLECTION), false);
  assert.ok(JSON.stringify(inputs.history).includes(PUBLIC_SELFREFLECTION));
});

test('ordinary diary planning and writing omit restricted posts from the store', async () => {
  // Catches the second diary history path feeding private gists to an outward planning model.
  const core = await community();
  seedRestrictedSelfreflection(core);
  core.store.appendSelfreflectionPost({
    at: NOW - 120000,
    kind: 'status',
    gist: PUBLIC_SELFREFLECTION,
    picture: null,
    search: '',
    text: PUBLIC_SELFREFLECTION,
    itemId: 'selfreflection:ordinary-seed',
  });
  await core.store.flushSettled({});
  const plan = JSON.stringify({ kind: 'status', brief: 'a quiet day', search: '', picture: false });
  const { llm } = await turnOf(core, { mode: 'selfreflection', answers: [plan, '<msg>ordinary entry</msg>'] });
  assert.ok(llm.calls.length >= 2);
  const prompts = JSON.stringify(llm.calls);
  assert.ok(prompts.includes(PUBLIC_SELFREFLECTION));
  assert.equal(prompts.includes(PRIVATE_SELFREFLECTION), false);
});

test('a diary-mode internal turn records restricted provenance on its held speech', async () => {
  // Catches guarding diary tool calls while leaving the ordinary diary-mode producer unrestricted.
  const core = await community();
  const plan = JSON.stringify({ kind: 'status', brief: 'a private day', search: '', picture: false });
  await turnOf(core, {
    mode: 'selfreflection',
    memoryContext: internalSelfreflectionContext(),
    answers: [plan, `<msg>${PRIVATE_SELFREFLECTION}</msg>`],
  });
  const [row] = selfreflectionDb(core).prepare('SELECT text, scope_kind, extra FROM selfreflection').all();
  assert.equal(row.text, PRIVATE_SELFREFLECTION);
  assert.equal(row.scope_kind, 'internal');
  const extra = JSON.parse(String(row.extra)) as Record<string, unknown>;
  assert.ok(extra.publicationBoundary);
});
