// The persona sees any attachment the same way in recent messages and in memory: the kind marker and the text form, from one read
// (src/memory/db/media-store.ts#lineMedia). The memory prefetch (src/behavior/recall-run.ts#prefetch), window reads (#window),
// the memory session's source batch (src/memory/db/session.ts#buildSessionRequest), the turn's chat rendering
// (src/format.ts#formatTranscript), the stored lines a task and a chat read (src/memory/db/chat-lines.ts) and
// the owner's browser (src/memory/db/domain-read.ts#domainDetail). Audience holds in each. Synthetic content; no model.
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleOfPerson } from '../../../../src/memory/db/direct-chats.ts';
import {
  batchOf,
  buildSessionRequest,
  scopesOf,
  mediaPassBatch,
  parseSessionAnswer,
  resolveSessionReads,
  validateAnswer,
  sweep,
  cursorKey,
  joinOf,
  sessionSettings,
  CODES,
  memoryKeyState,
  refusalOf,
  scopeSweepsToday,
  type SessionContext,
  fitBatch,
  type SweepScope,
} from '../../../../src/memory/db/session.ts';
import { fillStems } from '../../../../src/memory/db/stems.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import {
  baseConfig,
  prompts as sessionPrompts,
  textOf,
  memoryBlock,
  prompts,
  ADA,
  chat,
  count,
  ctxOf,
  fakeLlm,
  fixture as semanticSessionFixture,
  personOf,
  request,
  BOB,
  CHANNEL,
  dmPlaceOf,
  MINUTE,
  NOW as HASH_IDS_NOW,
  HOUR,
  memoryRing,
  GUILD,
  channelPlaceOf,
  guildPlaceOf,
  messageSourceOf,
} from '../../../fixtures/memory-db/session-rig.ts';
import {
  ALICE,
  SELF_ID,
  KINDS,
  LABELS,
  NOW,
  PRESENCES,
  assertForms as checkForms,
  fixture,
  itemsOf,
  observeDmLine,
  observeLine,
  type Env,
  type Kind,
  type Presence,
  AT,
  GENERAL,
} from '../../../fixtures/media-memory.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { OBSERVATION_VERSION, observe } from '../../../../src/memory/db/observe.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { wrongly, sqlOf } from '../../../fixtures/loose-types.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import type { Fixture, LlmCall, Rec, SayArgs } from '../../../fixtures/memory-db/session-shapes.ts';
import {
  PUBLIC,
  ALEX,
  DM_ALEX,
  addSource,
  dmAudience,
  semanticWorld,
} from '../../../fixtures/memory-db/semantic-world.ts';
import { dmContext, groupContext, audienceOf, whereFor, groupScope } from '../../../../src/memory/db/scope.ts';
import { matchName, type NameHit } from '../../../../src/memory/db/names.ts';
import * as memoryIds from '../../../../src/memory/db/ids.ts';
import type { KeyRing } from '../../../../src/keys/ring.ts';
import { withCacheMarker } from '../../../../src/llm/openrouter.ts';
import { MEMORY_ROLE } from '../../../../src/llm/roles.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { dbOf, type Config, type Row, type Db, type MemoryHandle } from '../../../../src/memory/db/types.ts';
import { reviewRefusal } from '../../../../src/memory/db/describe.ts';
import { createKeyStore } from '../../../../src/keys/store.ts';
import { chainRing } from '../../../fixtures/keys-rig.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import fs, { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path, { join } from 'node:path';
import { CONFIG_SCHEMA } from '../../../../src/config/schema.ts';
import { dueScopes } from '../../../../src/memory/db/writer-switch.ts';
import { ROOT } from '../../../fixtures/private-layer.ts';
import { estimateMessages } from '../../../../src/llm/tokens.ts';
import { storedStretches } from '../../../../src/memory/db/stretches.ts';
import { MEMBER, buildDataDir } from '../../../fixtures/memory-db/datadir.ts';
import os from 'node:os';
import { minute, storeProductionEdit } from '../../../fixtures/memory-db/edited-line.ts';
import { openWorld } from '../../../fixtures/memory-db/mind-world.ts';
import { auditMemory } from '../../../fixtures/memory-audit.ts';
import { linkOwnerAccount } from '../../../../src/memory/db/identity-links.ts';
import { linkAccount } from '../../../../src/memory/db/person-links.ts';
import { DatabaseSync } from 'node:sqlite';
import {
  CLI_AUDIENCE,
  CLI_PLACE,
  OLD_PERSON,
  OWNER,
  addCliLines,
  addCliPlace,
} from '../../../fixtures/memory-audit-production.ts';
import type { MemoryPage } from '../../../../src/memory/db/semantic-types.ts';
import { topPlaceSpelled } from '../../../../src/memory/db/ids.ts';
import { runChildProcess } from '../../../../src/agent-runner/backend.ts';
import { memoryWriterClient, type MemoryWriterDeps } from '../../../../src/subharness/memory-writer.ts';
import { subharnessPlace } from '../../../../src/subharness/place.ts';
import { writeKeysFile } from '../../../fixtures/keys-file.ts';
import { startCore } from '../../../../src/core.ts';
import { onLog } from '../../../../src/log.ts';
import { graphNodeId } from '../../../../src/memory/db/graph.ts';
import { lineEvent as journeyLineEvent } from '../../../fixtures/core-over-fake.ts';
import {
  CLI_CLIENT,
  FAKE_CLIENT,
  addClient,
  folders,
  mention,
  query,
  runCli,
  startedUnit,
  type Core,
  type Dirs,
  type Row as JourneyRow,
  type Unit,
} from '../../../fixtures/core-units.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';

const voiceSaid = KINDS.find((kind) => kind.self) as Kind;

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

function assertForms(text: string, kind: Kind, presence: Presence) {
  checkForms(text, kind, presence);
}

/** The `<batch>` of a memory session request over the fixture's group or DM lines. */
function sessionBatch(env: Env, scopeKind = 'group', labels: object = LABELS): string {
  fillEnvAudiences(env);
  const scopeEntry = scopesOf(env.db).find((one) => one.scope.scope_kind === scopeKind);
  assert.ok(scopeEntry, `a ${scopeKind} scope`);
  const batch = batchOf(env.db, scopeEntry.scope, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW });
  const built = buildSessionRequest({
    db: env.db,
    scope: scopeEntry,
    batch,
    config: baseConfig(),
    prompts: { ...sessionPrompts, labels },
    selfName: 'Self',
    now: NOW,
  });
  const secondMessage = built.messages[1];
  const text = textOf(secondMessage.content);
  return text.slice(text.indexOf('<batch>'));
}

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    test(`session batch: a ${kind.name} is a numbered line with its marker and its text form, ${presence}`, () =>
      withLine(kind, presence, (env) => {
        const batch = sessionBatch(env);
        assert.match(batch, /#1 \[/, 'a line with no text still has a number the persona can cite');
        assertForms(batch, kind, presence);
      }));
  }

  test(`audience: a group's session batch holds nothing of a DM's ${kind.name}, its own DM's batch does`, () => {
    const env = fixture();
    try {
      observeDmLine(env, kind);
      observeLine(env, KINDS[0], 'absent', { native: 'public' });
      fillStems(env.db);
      assert.ok(!sessionBatch(env).includes(kind.first.word));
      assert.ok(sessionBatch(env, 'dm').includes(kind.first.word));
    } finally {
      env.done();
    }
  });
}

test('the persona’s own line in the session batch is under their self label, the voice with what they voiced', () =>
  withLine(voiceSaid, 'full', (env) => {
    const batch = sessionBatch(env);
    assert.ok(batch.includes(voiceSaid.first.word), batch);
    assert.ok(!batch.includes(SELF_ID), 'by their name, never their id');
  }));

test('session batch: the legend stands right after the cutoff line, before the first numbered line', () =>
  withLine(KINDS.find((kind) => kind.name === 'emoji') as Kind, 'full', (env) => {
    const batch = sessionBatch(env);
    const afterCutoff = batch.slice(batch.indexOf('cutoff: '));
    const [, second] = afterCutoff.split('\n');
    // The block of custom emoji and stickers is <media>.
    assert.equal(second, '<media>', batch);
    assert.ok(batch.indexOf('</media>') < batch.indexOf('#1 ['), batch);
  }));

test('session batch: a picture the persona made is followed by the made mark and the people it shows by handle', () =>
  withLine(KINDS[0], 'full', (env) => {
    const alice = String(env.db.prepare('SELECT person_id FROM accounts WHERE native_id = ?').get(ALICE)?.person_id);
    env.db
      .prepare("UPDATE media SET extra = json_set(extra, '$.made', 'self', '$.depicts', json(?)) WHERE native_ref = ?")
      .run(JSON.stringify(['person:self', alice]), itemsOf(KINDS[0], 'pic')[0].id);
    const labels = {
      ...LABELS,
      transcript: {
        ...LABELS.transcript,
        mediaMade: '[MADE]',
        mediaDepicts: '[SHOWS {names}]',
        mediaDepictsSelf: 'HERSELF',
      },
    };
    const batch = sessionBatch(env, 'group', labels);
    assert.ok(batch.includes('[MADE]'), batch);
    // A person is written by the handle the persona can pass to a tool, never by a name.
    assert.ok(batch.includes(`[SHOWS HERSELF, @${handleOfPerson(alice)}]`), batch);
  }));

// The bounded session pass over old media lines (src/memory/db/session.ts#mediaPassBatch): lines the ordinary cursor passed
// because they held no words come back oldest first, only with a text form, and the ordinary cursor stays. Synthetic rows.

const IMAGE = KINDS[0];

function withLines(body: (env: Env, scope: ReturnType<typeof scopesOf>[number]) => void) {
  const env = fixture();
  try {
    observeLine(env, IMAGE, 'part', { native: 'told-1', at: AT });
    env.say({ native: 'words', at: AT + 1000, text: 'words of its own', place: GENERAL });
    observeLine(env, IMAGE, 'absent', { native: 'bare', at: AT + 2000 });
    observeLine(env, IMAGE, 'part', { native: 'told-2', at: AT + 3000 });
    fillEnvAudiences(env);
    const scope = scopesOf(env.db).find((one) => one.scope.scope_kind === 'group');
    assert.ok(scope);
    body(env, scope);
  } finally {
    env.done();
  }
}

const rowidOf = (env: Env, native: string) =>
  Number(env.db.prepare('SELECT rowid AS r FROM sources WHERE native_id = ?').get(native)?.r);

test('the pass reads media-only lines with a text form, oldest first, leaving words and bare lines out', () =>
  withLines((env, scope) => {
    const lines = mediaPassBatch(env.db, scope, {
      after: 0,
      upTo: rowidOf(env, 'told-2'),
      maxMessages: 10,
      since: null,
    });
    assert.deepEqual(
      lines.map((line) => line.native_id),
      ['told-1', 'told-2']
    );
  }));

test('the pass stops at the ordinary cursor: a line not yet learned stays for the ordinary batch', () =>
  withLines((env, scope) => {
    const lines = mediaPassBatch(env.db, scope, {
      after: 0,
      upTo: rowidOf(env, 'words'),
      maxMessages: 10,
      since: null,
    });
    assert.deepEqual(
      lines.map((line) => line.native_id),
      ['told-1']
    );
  }));

test('the pass takes up after its own cursor and holds at most its limit', () =>
  withLines((env, scope) => {
    const upTo = rowidOf(env, 'told-2');
    const first = mediaPassBatch(env.db, scope, { after: 0, upTo, maxMessages: 1, since: null });
    assert.equal(first.length, 1);
    const next = mediaPassBatch(env.db, scope, { after: Number(first[0].rowid), upTo, maxMessages: 1, since: null });
    assert.deepEqual(
      next.map((line) => line.native_id),
      ['told-2']
    );
  }));

// The observation envelope (schema v8, src/memory/db/observe.ts), and how the memory session's batch names the author
// of an observed line. Fixtures for three interfaces nobody wires yet: Twitter (the persona's post,
// replies, a mention of the persona; a stranger's quote tweet stays out unless the caller passes it), an imageboard (thread
// tokens, a post-number-only board, display names, a site-wide id, a reset token) and Telegram (a DM and a group).
// Synthetic text only; the ids and handles are made up.

/** What `observe` answers for a stored message: the ids it assigned and the author's account. */
type Observed = {
  ok: boolean;
  sourceId: string;
  placeId: string;
  audienceId: string;
  author: { account: string };
};
const observed = (...args: Parameters<typeof observe>) => wrongly<Observed>(observe(...args));

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const OBSERVE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const at = (minutes: number) => new Date(Date.parse('2026-10-24T10:00:00.000Z') + minutes * 60_000).toISOString();
const opts = { now: () => OBSERVE_NOW, log: quiet };

function fresh() {
  return openMemoryDb(':memory:');
}

// ---------- an imageboard ----------

const SITE = 'imageboard/site:board.example';
const post = (key: string, author: Record<string, Untyped>, over = {}) => ({
  v: OBSERVATION_VERSION,
  iface: 'imageboard',
  authority: SITE,
  native: { kind: 'post', key, revision: 0 },
  place: {
    authority: SITE,
    key: 'thread:100',
    kind: 'thread',
    chat: 'group',
    title: 'a thread',
    parent: 'board:b',
  },
  author,
  occurredAt: at(Number(key) % 50),
  observedAt: at((Number(key) % 50) + 1),
  text: `post ${key}`,
  ...over,
});

// ---------- session batch ----------

test('a stored participant line in the session batch names its author by the display name', () => {
  // Bug: the batch reads `author_account` alone, so a line an anonymous participant wrote is credited to nobody.
  const handle = fresh();
  const db = sqlOf(handle);
  try {
    const line = observed(
      handle,
      post('101', { kind: 'account', key: 'id:9f3c' }, { occurredAt: at(1), observedAt: at(2) }),
      opts
    );
    db.prepare(
      `INSERT INTO participants (id, authority_id, scope_place_id, token_kind, native_token, generation, continuity,
       display, first_seen_at, last_seen_at, recorded_at) VALUES ('participant:ab12', ?, ?, 'thread_token', 'Ab12', 1,
       'provider_asserted', 'Ab12', ?, ?, ?)`
    ).run(SITE, line.placeId, at(1), at(1), at(2));
    db.prepare(
      `UPDATE sources SET author_kind = 'participant', author_account = NULL, author_person = NULL,
       author_participant = 'participant:ab12' WHERE id = ?`
    ).run(line.sourceId);
    const scopeEntry = scopesOf(db).find((entry) => entry.key === 'group:imageboard');
    assert.ok(scopeEntry, 'the imageboard group is a scope');
    const batch = batchOf(db, scopeEntry.scope, { cursor: 0, since: null, maxMessages: 50, settleBefore: OBSERVE_NOW });
    const built = buildSessionRequest(
      wrongly({
        db,
        scope: scopeEntry,
        batch,
        config: {},
        prompts: { 'memory/session': 'x', labels: {} },
        selfName: 'Nep',
        now: OBSERVE_NOW,
      })
    );
    const secondMessage = built.messages[1];
    assert.match(textOf(secondMessage.content), /\] Ab12: post 101/);
  } finally {
    handle.close();
  }
});

// Participation and session evidence retain the observed source across qualified record adoption and later edits.

const PARTICIPATION_SOURCES_NOW = Date.parse('2026-10-24T12:00:00Z');
const PARTICIPATION_SOURCES_AT = PARTICIPATION_SOURCES_NOW - 60 * 60_000;
const NATIVE = 'same-evidence-message';
const locator = (room: string) => ({ iface: 'discord', chatId: room, messageId: NATIVE });

function envelope(room: string, text: string, edit = false) {
  const value = observationOf({
    iface: 'discord',
    at: PARTICIPATION_SOURCES_NOW,
    edit,
    chat: { id: room, kind: 'channel', chatType: 'channel', rootId: 'root' },
    message: { id: NATIVE, at: PARTICIPATION_SOURCES_AT, content: text, author: { id: 'member', name: 'Member' } },
  });
  if (!value) throw new Error('synthetic normalized message was refused');
  return value;
}

function sourceId(result: object | null): string {
  if (!result || !('sourceId' in result) || typeof result.sourceId !== 'string') {
    throw new Error('normalized observation returned no source');
  }
  return result.sourceId;
}

async function evidence() {
  const memory = await openTestMemory({ now: () => PARTICIPATION_SOURCES_NOW });
  const record = createRecord({ ...memory, now: () => PARTICIPATION_SOURCES_NOW });
  const original = sourceId(await memory.memoryDb.observeMessage(envelope('room-a', 'Original batch evidence')));
  const foreign = sourceId(await memory.memoryDb.observeMessage(envelope('room-b', 'Foreign collision evidence')));
  const db = memory.memoryDb.database();
  if (!db) throw new Error('the synthetic memory database is unavailable');
  return {
    ...memory,
    db,
    original,
    foreign,
    async edit() {
      const edited = sourceId(
        await memory.memoryDb.observeMessage(envelope('room-a', 'Edited canonical evidence', true))
      );
      const line = {
        v: 1,
        id: 'edited-record-line',
        kind: 'seen',
        messageId: NATIVE,
        revision: 2,
        occurredAt: new Date(PARTICIPATION_SOURCES_AT).toISOString(),
        recordedAt: new Date(PARTICIPATION_SOURCES_NOW).toISOString(),
        placeId: 'root',
        scope: { channel: 'room-a' },
        by: 'member',
        text: 'Edited canonical evidence',
        origin: 'live',
      };
      await record.append('root', [line], {
        messages: [{ lineId: line.id, locator: locator('room-a'), observedSourceId: edited }],
      });
      return edited;
    },
  };
}

test('a session answer cites the exact source its batch read before a later observed and recorded edit', async () => {
  const env = await evidence();
  try {
    const scopeEntry = scopesOf(env.db).find((entry) => entry.key === 'group:discord');
    if (!scopeEntry) throw new Error('the normalized sources have no group session scope');
    const batch = batchOf(env.db, scopeEntry.scope, {
      cursor: 0,
      since: null,
      maxMessages: 20,
      settleBefore: PARTICIPATION_SOURCES_NOW,
    });
    const request = buildSessionRequest({
      db: env.db,
      scope: scopeEntry,
      batch,
      config: baseConfig(),
      prompts,
      selfName: 'Synthetic persona',
      now: PARTICIPATION_SOURCES_NOW,
    });
    const sourceHandle = [...request.maps.sources].find(([, id]) => id === env.original)?.[0];
    const placeId = env.db.prepare('SELECT place_id FROM sources WHERE id = ?').get(env.original)?.place_id;
    const placeHandle = [...request.maps.places].find(([, id]) => id === placeId)?.[0];
    if (!sourceHandle || !placeHandle) throw new Error('the batch omitted its actual source or place');
    const edited = await env.edit();
    const reads = resolveSessionReads(env.db, request, 'discord');
    assert.deepEqual(
      reads.filter((row) => row.row_kind === 'sources' && row.row_id === env.original).map((row) => row.revision),
      [1]
    );
    const answer = parseSessionAnswer(
      memoryBlock({
        claims: [
          {
            op: 'add',
            subject: 'place',
            place: placeHandle,
            kind: 'injoke',
            text: 'Batch evidence claim',
            how: 'saw',
            sources: [sourceHandle],
          },
        ],
      })
    );
    if (!answer.ok) throw new Error('the synthetic session answer was refused');
    const { plan, counts } = validateAnswer(answer.value, { maps: request.maps, people: request.people });
    assert.equal(counts.kept, 1);
    const firstClaim = plan.claims[0];
    assert.deepEqual(firstClaim?.sources, [env.original]);
    await env.memoryDb.memoryWrite({
      kind: 'session',
      mode: 'apply',
      now: PARTICIPATION_SOURCES_NOW,
      maxDelta: 15,
      run: {
        id: 'run:exact-batch-source',
        scopeKey: scopeEntry.key,
        scope: scopeEntry.scope,
        batchKey: 'apply|exact-batch-source',
        startedAt: new Date(PARTICIPATION_SOURCES_NOW).toISOString(),
        finishedAt: new Date(PARTICIPATION_SOURCES_NOW).toISOString(),
        outcome: 'ok',
        counts: {},
        errors: [],
      },
      plan,
    });
    const links = env.db
      .prepare(
        'SELECT cs.source_id FROM claim_sources cs JOIN claims c ON c.id = cs.claim_id WHERE c.text = ? ORDER BY cs.position'
      )
      .all('Batch evidence claim')
      .map((row) => row.source_id);
    assert.deepEqual(links, [env.original]);
    assert.equal(links.includes(edited), false);
    assert.equal(links.includes(env.foreign), false);
  } finally {
    await env.close();
  }
});

// The memory session's answer carrying structured facts: the two new groups of the `<memory>` object (`entities`
// and `assertions`, documented in docs/prompt-contract.md and prompts/memory/session.md), the fake model's answer through
// a real sweep, and the meeting of the writers (a session write, a unit flush, a legacy upsert) on one sealed version.
// The persona's words stay as they wrote them. Fake model, synthetic text.

const APPLY = baseConfig({ mode: 'apply' });
const ANSWER = {
  entities: [{ handle: 'n1', kind: 'project', name: 'Lumen', language: 'en', sources: [1] }],
  assertions: [
    {
      predicate: { id: 'project.works_on', version: 1 },
      assertionKind: 'relation',
      text: 'Ada works on Lumen, as she told us',
      arguments: [
        { role: 'person', position: 0, ref: 'Ada' },
        { role: 'project', position: 0, ref: 'n1' },
      ],
      polarity: 'positive',
      how: 'said',
      sources: [1],
    },
  ],
};
const structured = (env: Fixture) => ({
  entities: Number(count(env.db, 'semantic_entities')),
  assertions: Number(count(env.db, 'semantic_assertion_versions', "assertion_kind <> 'text'")),
  arguments: Number(count(env.db, 'semantic_arguments')),
});

test('a session answer stores a sourced project and a relation that names it by its local handle', async () => {
  // Bug: the model must guess an entity id, or the new entity and its relation land in different transactions.
  const env = semanticSessionFixture();
  const lines = chat(env);
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(ANSWER)), config: APPLY }));
  const relation = env.db
    .prepare("SELECT version_id FROM semantic_assertion_versions WHERE predicate_id = 'project.works_on'")
    .get();
  assert.ok(relation, 'the relation was not stored');
  const roles = env.db
    .prepare('SELECT role, ref_kind, ref_id FROM semantic_arguments WHERE version_id = ? ORDER BY role')
    .all(relation.version_id);
  const entity = env.db.prepare('SELECT id FROM semantic_entities').get();
  assert.deepEqual(
    roles.map((row) => [row.role, row.ref_kind, row.ref_id]),
    [
      ['person', 'person', personOf(ADA)],
      ['project', 'entity', entity?.id],
    ]
  );
  const stored = env.db.prepare('SELECT text FROM claim_versions WHERE id = ?').get(relation.version_id);
  assert.equal(stored?.text, 'Ada works on Lumen, as she told us');
  const evidence = env.db
    .prepare('SELECT source_id FROM claim_version_sources WHERE version_id = ?')
    .all(relation.version_id);
  assert.deepEqual(
    evidence.map((row) => row.source_id),
    [lines.a]
  );
  env.done();
});

test('a shadow session writes proposals and no structured row', async () => {
  // Bug: shadow mode changes real memory while it is still under evaluation.
  const env = semanticSessionFixture();
  chat(env);
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(ANSWER)), config: baseConfig({ mode: 'shadow' }) }));
  assert.deepEqual(structured(env), { entities: 0, assertions: 0, arguments: 0 });
  assert.equal(count(env.db, 'decisions', "action LIKE 'proposed:%'"), 2);
  env.done();
});

test('the same batch written twice stores one entity and one relation', async () => {
  // Bug: a retried write mints a second entity with a new uuid.
  const env = semanticSessionFixture();
  chat(env);
  const writes: Array<Record<string, unknown>> = [];
  const write = (update: unknown) => {
    writes.push(update as Record<string, unknown>);
    return Promise.resolve(applyMemoryWrite(env.handle, update));
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(ANSWER)), config: APPLY, write }));
  const first = structured(env);
  assert.equal(first.entities, 1);
  const applied = writes.find((update) => update.kind === 'session' && update.plan);
  assert.ok(applied, 'the sweep wrote no plan');
  const again = applyMemoryWrite(env.handle, { ...applied, advance: null }) as { replayed?: boolean };
  assert.equal(again.replayed, true);
  assert.deepEqual(structured(env), first);
  env.done();
});

test('an answer with an unknown group says so', () => {
  // Bug: a misspelled group is ignored in silence and the persona believes the fact was kept.
  const env = semanticSessionFixture();
  chat(env);
  const given = request(env, APPLY);
  const { counts } = validateAnswer({ relationships: [{ a: 1 }] }, { maps: given.maps, people: given.people });
  assert.equal(counts.dropped.unknown_group, 1);
  env.done();
});

const BAD_OPS: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  ['an unknown field on an entity', { entities: [{ ...ANSWER.entities[0], id: 'ent:x' }] }, 'unknown_field'],
  ['an entity with no sources', { entities: [{ ...ANSWER.entities[0], sources: [] }] }, 'no_sources'],
  [
    'an entity citing a line outside the batch',
    { entities: [{ ...ANSWER.entities[0], sources: [999] }] },
    'unknown_source',
  ],
  [
    'an assertion citing a line outside the batch',
    { assertions: [{ ...ANSWER.assertions[0], sources: [999] }] },
    'unknown_source',
  ],
  [
    'an assertion naming a handle nobody gave',
    {
      assertions: [
        {
          ...ANSWER.assertions[0],
          arguments: [
            { role: 'person', position: 0, ref: 'Ada' },
            { role: 'project', position: 0, ref: 'n9' },
          ],
        },
      ],
    },
    'unknown_ref',
  ],
  [
    'an unknown field on an assertion',
    { assertions: [{ ...ANSWER.assertions[0], audience: 'aud:none' }] },
    'unknown_field',
  ],
];

for (const [name, answer, code] of BAD_OPS) {
  test(`drops ${name} with the reason ${code}`, () => {
    // Bug: the op is repaired or half kept, so a fact is stored with evidence the persona never gave.
    const env = semanticSessionFixture();
    chat(env);
    const given = request(env, APPLY);
    const { plan, counts } = validateAnswer(answer, { maps: given.maps, people: given.people });
    assert.equal(counts.dropped[code], 1);
    assert.deepEqual([plan.entities?.length ?? 0, plan.assertions?.length ?? 0], [0, 0]);
    env.done();
  });
}

test('a rejected kind leaves no entity and rejects the relation that named it, each with its own decision', async () => {
  // Bug: the relation saves with a dangling reference, or the sweep claims both were kept.
  const env = semanticSessionFixture();
  chat(env);
  const bad = { ...ANSWER, entities: [{ ...ANSWER.entities[0], kind: 'dragon' }] };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(bad)), config: APPLY }));
  assert.deepEqual(structured(env), { entities: 0, assertions: 0, arguments: 0 });
  assert.equal(count(env.db, 'decisions', "action = 'rejected:unknown_kind'"), 1);
  assert.equal(count(env.db, 'decisions', "action = 'rejected:unknown_ref'"), 1);
  env.done();
});

test('a rejected relation does not undo the entity beside it', async () => {
  // Bug: one bad op rolls back the whole answer, and the cursor moves past lost facts.
  const env = semanticSessionFixture();
  chat(env);
  const bad = { ...ANSWER, assertions: [{ ...ANSWER.assertions[0], predicate: { id: 'made.up', version: 1 } }] };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(bad)), config: APPLY }));
  assert.equal(count(env.db, 'semantic_entities'), 1);
  assert.equal(count(env.db, 'semantic_assertion_versions', "predicate_id = 'made.up'"), 0);
  assert.equal(count(env.db, 'decisions', "action = 'rejected:unknown_predicate'"), 1);
  env.done();
});

test('a plain claim add also snapshots how, truth and audience on its version', async () => {
  // Bug: a new prose fact is left without a snapshot and a later reader falls back to the mutable parent.
  const env = semanticSessionFixture();
  chat(env);
  const plain = {
    claims: [
      { op: 'add', subject: 'Ada', kind: 'interest', text: 'Ada likes café mornings', how: 'said', sources: [1] },
    ],
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(plain)), config: APPLY }));
  const version = env.db
    .prepare("SELECT id FROM claim_versions WHERE origin = 'session' AND text = 'Ada likes café mornings'")
    .get();
  const snapshot = env.db.prepare('SELECT * FROM semantic_assertion_versions WHERE version_id = ?').get(version?.id);
  assert.deepEqual(
    [snapshot?.assertion_kind, snapshot?.how, snapshot?.truth_state, snapshot?.polarity, snapshot?.audience_id],
    ['text', 'said', 'current', 'unknown', PUBLIC]
  );
  env.done();
});

test('a revise appends a snapshot and leaves the sealed text of the version before it', async () => {
  // Bug: the session's own `INSERT OR REPLACE` hits the seal, or a new row inherits the old snapshot.
  const env = semanticSessionFixture();
  chat(env);
  const add = {
    claims: [{ op: 'add', subject: 'Ada', kind: 'interest', text: 'Ada likes tea', how: 'said', sources: [1] }],
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(add)), config: APPLY }));
  const first = env.db.prepare("SELECT id, claim_id FROM claim_versions WHERE text = 'Ada likes tea'").get();
  assert.ok(first);
  // The claim must look older than the batch for the request to offer it: the rig's clock stands still after the sweep.
  env.db
    .prepare('UPDATE claims SET created_at = ?, last_seen_at = ? WHERE id = ?')
    .run('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', first.claim_id);
  env.say({ native: 'm6', minutesAgo: 50, text: 'actually coffee' });
  const given = request(env, APPLY);
  const handle = [...given.maps.claims].find(([, id]) => id === first.claim_id)?.[0];
  assert.ok(handle, 'the request did not offer the stored claim');
  const revise = {
    claims: [
      { op: 'revise', id: handle, text: 'Ada likes coffee', how: 'said', sources: [1], reason: 'she corrected it' },
    ],
  };
  await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock(revise)), config: APPLY }), { ignoreSweepCap: true });
  assert.equal(env.db.prepare('SELECT text FROM claim_versions WHERE id = ?').get(first.id)?.text, 'Ada likes tea');
  assert.equal(count(env.db, 'semantic_assertion_versions', "how = 'said' AND assertion_kind = 'text'"), 2);
  env.done();
});

// The memory session writes an alias of a place as it writes one of a person, and the name index finds it under
// the place's audience: a group room's in the groups of its interface, a direct chat's in that chat only.

/** The nodes `words` name, read under `ctx`: per word, one hit per node by its strongest match. */
const namesOf = (
  db: Parameters<typeof matchName>[0],
  ctx: Parameters<typeof matchName>[1],
  words: Array<string>
): Array<NameHit> => words.flatMap((word) => matchName(db, ctx, word));

// Place aliases: a place alias goes through the session as a person's does and the name
// index reads it under the place's audience.
const DM_ADA = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
const placeNode = (placeId: string): string => `place:${placeId}`;
const aliasOf = (place: string, text: string, sources: Array<string>) => ({
  op: 'add',
  subject: 'place',
  place,
  kind: 'alias',
  text,
  how: 'said',
  sources,
});
// The key of a DM scope is its place, never a partner spelled from its id.
const DM_ADA_KEY = `dm:discord:${dmPlaceOf(ADA)}`;
/** Ada's direct chat as a stored place and two lines in it, the second the persona's, for a session of that scope alone. */
function dmChat(env: ReturnType<typeof semanticSessionFixture>): void {
  env.db
    .prepare(
      "INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, partner_account, partner_person) VALUES (?, 'discord', 'dm', ?, 'dm', 'dm', ?, ?)"
    )
    .run(dmPlaceOf(ADA), ADA, `discord:${ADA}`, personOf(ADA));
  env.say({
    native: 'd1',
    minutesAgo: 50,
    text: 'we call this chat the Κήπος',
    scope: DM_ADA,
    place: dmPlaceOf(ADA),
    direct: 1,
  });
  env.say({
    native: 'd2',
    minutesAgo: 45,
    text: 'the Κήπος it is',
    scope: DM_ADA,
    place: dmPlaceOf(ADA),
    kind: 'said',
  });
}

test('a session answer with a place alias writes a claim with subject_kind place', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const llm = fakeLlm(() => memoryBlock({ claims: [aliasOf('p1', 'Αγορά', ['#1'])] }));
    const result = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }));
    const [run] = result.runs;
    assert.equal(run.outcome, 'ok');
    const rows = env.db.prepare("SELECT subject_kind, subject_id, kind, text FROM claims WHERE author = 'her'").all();
    assert.deepEqual(
      rows.map((row) => [row.subject_kind, row.subject_id, row.kind, row.text]),
      [['place', CHANNEL, 'alias', 'Αγορά']]
    );
  } finally {
    env.done();
  }
});

test("a group room's alias from a session is found by namesOf in a group context of its interface", async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const llm = fakeLlm(() => memoryBlock({ claims: [aliasOf('p1', 'Αγορά', ['#1'])] }));
    await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }));
    const hits = namesOf(env.db, groupContext('discord'), ['Αγορά']).filter((hit) => hit.nodeId === placeNode(CHANNEL));
    assert.deepEqual(
      hits.map((hit) => [hit.kind, hit.match]),
      [['alias', 'exact']]
    );
  } finally {
    env.done();
  }
});

test("a direct chat's alias from a session is found by namesOf in that chat only, never in the group or another chat", async () => {
  const env = semanticSessionFixture();
  try {
    dmChat(env);
    const llm = fakeLlm(() => memoryBlock({ claims: [aliasOf('p1', 'Κήπος', ['#1'])] }));
    const result = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }), {
      scope: DM_ADA_KEY,
      ignoreSweepCap: true,
    });
    const [run] = result.runs;
    assert.equal(run.outcome, 'ok');
    const node = placeNode(dmPlaceOf(ADA));
    const found = (ctx: Parameters<typeof namesOf>[1]): Array<string> =>
      namesOf(env.db, ctx, ['Κήπος'])
        .filter((hit) => hit.nodeId === node)
        .map((hit) => hit.kind);
    assert.deepEqual(found(dmContext(personOf(ADA), 'discord', dmPlaceOf(ADA))), ['alias'], 'read in its own chat');
    assert.deepEqual(found(groupContext('discord')), [], 'never in the group');
    assert.deepEqual(found(dmContext(personOf(BOB), 'discord', dmPlaceOf(BOB))), [], 'never in another chat');
  } finally {
    env.done();
  }
});

// The ids of the stored items in a memory session's request (src/memory/db/session.ts): the persona's claims about themselves, the
// claims about people and places, and the open episodes go by a short hash of the row's own id, `k` and four base-36
// characters, so a chat line's stable names (`:e2:`, `[sticker s1]`) never share a token with a stored item. The hash
// is injected as `hash` (row id -> base-36 text), as `rng` and `now` are elsewhere. Synthetic content only.

type HashIdsEnv = ReturnType<typeof semanticSessionFixture>;

const HASHES: Record<string, string> = {
  'cl-self': 'q7m2ab90',
  'cl-ada': 'w8n4cd12',
  'ep-1': 'r5t6ef34',
};
const fakeHash = (table: Record<string, string>) => (id: string) => table[id] ?? 'zzzz0000';

function stored(env: HashIdsEnv): void {
  chat(env);
  env.claim({
    id: 'cl-self',
    subjectKind: 'self',
    subjectId: memoryIds.SELF_PERSON,
    kind: 'self_fact',
    text: 'keeps a small garden',
  });
  env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
  const { db } = env;
  db.prepare(
    "INSERT INTO episodes (id, kind, subject_id, date, what, feeling, status, scope_kind, scope_iface) VALUES ('ep-1', 'profile', ?, '2026-10-10', 'Ada helped with the move', 'warm', 'open', 'group', 'discord')"
  ).run(personOf(ADA));
}

function requestWith(env: HashIdsEnv, hash?: (id: string) => string) {
  const scope = scopesOf(env.db)[0];
  const { scope: swept } = scope;
  const batch = batchOf(env.db, swept, {
    cursor: 0,
    since: null,
    maxMessages: 200,
    settleBefore: HASH_IDS_NOW - 10 * MINUTE,
  });
  const given = { db: env.db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now: HASH_IDS_NOW };
  const built = buildSessionRequest(hash ? { ...given, hash } : given);
  const { claims, episodes } = built.maps;
  const [, user] = built.messages;
  return { ...built, claims, episodes, text: textOf(user.content) };
}

const answerOf = ({ maps, people }: ReturnType<typeof requestWith>) => ({ maps, people });

const idOf = (map: Map<string, string>, rowId: string): string | undefined =>
  [...map.entries()].find(([, id]) => id === rowId)?.[0];

test('the persona’s own claim is printed and mapped under its hash id', () => {
  // Bug: `s1` of `<self>` is the same token as the stable name of a sticker in the batch.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    assert.equal(built.claims.get('kq7m2'), 'cl-self');
    assert.match(built.text, /<self>\n\[kq7m2\] self_fact: keeps a small garden/);
  } finally {
    env.done();
  }
});

test("a person's claim is printed and mapped under its hash id", () => {
  // Bug: `c1` of `<people>` is a numbered id a mis-copy moves onto the neighbouring claim.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    assert.equal(built.claims.get('kw8n4'), 'cl-ada');
    assert.match(built.text, /\[kw8n4\] interest: likes café mornings/);
  } finally {
    env.done();
  }
});

test('an open episode is printed and mapped under its hash id', () => {
  // Bug: `e1` of `<episodes>` is the same token as the stable name of a custom emoji, `:e1:`.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    assert.deepEqual([...built.episodes.entries()], [['kr5t6', 'ep-1']]);
    assert.match(built.text, /\[kr5t6\] 2026-10-10 Ada: Ada helped with the move/);
  } finally {
    env.done();
  }
});

test('a row keeps its id in a later request that shows one more claim before it', () => {
  // Bug: a numbered id follows the row's rank, so the same claim is `c1` in one request and `c2` in the next.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const first = idOf(requestWith(env).claims, 'cl-ada');
    env.claim({ id: 'cl-ada-2', subjectId: personOf(ADA), text: 'reads poetry aloud' });
    const { db } = env;
    db.prepare("UPDATE claims SET last_seen_at = '2026-10-21' WHERE id = 'cl-ada-2'").run();
    const second = idOf(requestWith(env).claims, 'cl-ada');
    assert.match(first ?? '', /^k[0-9a-z]{4}$/);
    assert.equal(second, first);
  } finally {
    env.done();
  }
});

test('no id has the shape of a letter followed only by digits when the hash is all digits', () => {
  // Bug: an id such as `k1234` reads as a numbered id of another kind.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, () => '12345678');
    const ids = [...built.claims.keys(), ...built.episodes.keys()];
    assert.deepEqual(
      ids.filter((id) => /^[a-z]\d+$/.test(id)),
      []
    );
  } finally {
    env.done();
  }
});

test('two rows whose hashes collide in one request get ids one character longer that differ', () => {
  // Bug: the second row overwrites the first in the map, and an answer about one lands on the other.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash({ 'cl-self': 'abcd1xyz', 'cl-ada': 'abcd2xyz', 'ep-1': 'mnop3xyz' }));
    assert.deepEqual(
      [built.claims.get('kabcd1'), built.claims.get('kabcd2'), built.episodes.get('kmnop3')],
      ['cl-self', 'cl-ada', 'ep-1']
    );
  } finally {
    env.done();
  }
});

test('an answer naming an id one character off an issued one is refused as unknown', () => {
  // Bug: a mis-copied id is matched to the nearest issued id and the confirm lands on another claim.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    const { plan, counts } = validateAnswer(
      { claims: [{ op: 'confirm', id: 'kw8n5', sources: ['#1'] }] },
      answerOf(built)
    );
    assert.deepEqual([plan.claims, counts.dropped], [[], { unknown_id: 1 }]);
  } finally {
    env.done();
  }
});

test('an answer naming an old numbered id is refused as unknown', () => {
  // Bug: `s1` from a stale habit of the model still resolves to the persona's first claim.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    const { plan, counts } = validateAnswer(
      {
        claims: [
          { op: 'confirm', id: 's1', sources: ['#1'] },
          { op: 'confirm', id: 'c1', sources: ['#1'] },
        ],
      },
      answerOf(built)
    );
    assert.deepEqual([plan.claims, counts.dropped], [[], { unknown_id: 2 }]);
  } finally {
    env.done();
  }
});

test('an answer naming an issued hash id resolves to its row', () => {
  // Bug: the answer's id is read through another map than the one the request printed.
  const env = semanticSessionFixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    const { plan } = validateAnswer({ claims: [{ op: 'confirm', id: 'kq7m2', sources: ['#1'] }] }, answerOf(built));
    assert.deepEqual(
      plan.claims.map((entry) => entry.id),
      ['cl-self']
    );
  } finally {
    env.done();
  }
});

// The memory writer made cheaper: small sessions wait and join the next one of their scope,
// the request puts its stable part first under the cache marker, and a run records the sessions it joined and the
// cache tokens the provider read. A scripted model and a fake clock; nothing leaves the process.

const SETTINGS = { minLines: 10, batchLines: 30, maxWaitHours: 24 };
const cfg = (over: Rec = {}): Rec => baseConfig({ ...SETTINGS, ...over });

/** `n` lines a minute apart from `startMin` minutes after NOW, by Ada and Bob in turn (the group scope unless `scope`). */
function lines(env: Fixture, n: number, startMin: number, tag: string, extra: Partial<SayArgs> = {}): void {
  for (let i = 0; i < n; i += 1) {
    env.say({
      native: `${tag}${i}`,
      minutesAgo: -(startMin + i),
      text: `${tag}${i} line about café`,
      author: i % 2 === 0 ? ADA : BOB,
      ...extra,
    });
  }
}

type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } };
/** A scripted model: an empty memory answer to every call, the given usage, the calls recorded. */
function scripted(usage: Usage = { prompt_tokens: 1000, completion_tokens: 50 }) {
  const calls: Array<LlmCall> = [];
  return {
    calls,
    complete(messages: LlmCall['messages'], options: LlmCall['options']) {
      calls.push({ messages, options });
      return Promise.resolve({ text: memoryBlock({}), usage });
    },
  };
}

/** A context whose clock stands at `minutes` after NOW. */
const ctxAt = (
  env: Fixture,
  minutes: number,
  llm: ReturnType<typeof scripted>,
  config: Rec = cfg(),
  ring?: KeyRing | null
) => ({
  ...ctxOf(env, { llm, config, ...(ring === undefined ? {} : { ring }) }),
  now: () => HASH_IDS_NOW + minutes * MINUTE,
});
const runs = (env: Fixture) => env.db.prepare('SELECT * FROM session_runs ORDER BY started_at').all();
const countsOf = (row: Rec): Rec => JSON.parse(row.counts as string) as Rec;
const cursorOf = (env: Fixture): unknown =>
  env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('shadow', 'group:discord'))?.value ?? null;

// ---------- the join rule ----------

test('settings: no waiting, batchLines 30, maxWaitHours 24 by default; a wrong value falls back to the default', () => {
  // minLines defaults to 0: a short session is written at once, never held a day.
  const given = sessionSettings({});
  assert.deepEqual([given.minLines, given.batchLines, given.maxWaitHours], [0, 30, 24]);
  const bad = sessionSettings({ memoryDb: { session: { minLines: -3, batchLines: 'x', maxWaitHours: 0 } } });
  assert.deepEqual([bad.minLines, bad.batchLines, bad.maxWaitHours], [0, 30, 24]);
  assert.equal(sessionSettings({ memoryDb: { session: { minLines: 0 } } }).minLines, 0, '0 switches waiting off');
});

test('a settled session of ten lines waits: no request, no run row, the cursor stays', async () => {
  // Catches: a tiny session sent at the full price of the stable part (47 runs, 1.37M tokens for 35 facts).
  const env = semanticSessionFixture();
  try {
    lines(env, 10, 0, 'a');
    const llm = scripted();
    const result = await sweep(ctxAt(env, 30, llm));
    assert.deepEqual(
      result.runs.map((r) => [r.outcome, r.lines]),
      [['waiting', 10]]
    );
    assert.equal(llm.calls.length, 0);
    assert.equal(runs(env).length, 0);
    assert.equal(cursorOf(env), null);
  } finally {
    env.done();
  }
});

test('a session of eleven lines is written as before, joining nothing', async () => {
  // Catches: a wait rule that holds back a session over minLines.
  const env = semanticSessionFixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm));
    assert.equal(llm.calls.length, 1);
    const [row] = runs(env);
    assert.equal(row.sources_n, 11);
    assert.equal(countsOf(row).sessions, 1);
  } finally {
    env.done();
  }
});

test('small sessions of one scope join: ten, ten and ten lines go out as one request that records three sessions', async () => {
  // Catches: waiting sessions written separately (no saving), or lost when the next one comes.
  const env = semanticSessionFixture();
  try {
    lines(env, 10, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm));
    lines(env, 10, 60, 'b');
    await sweep(ctxAt(env, 100, llm));
    assert.equal(llm.calls.length, 0, 'twenty lines in two small sessions still wait');
    lines(env, 10, 120, 'c');
    await sweep(ctxAt(env, 200, llm));
    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    const secondMessage = firstCall.messages[1];
    const text = textOf(secondMessage.content);
    for (const tag of ['a0 ', 'a9 ', 'b0 ', 'c9 '])
      assert.ok(text.includes(`${tag.trim()} line`), `the joined request holds ${tag}`);
    const [row] = runs(env);
    assert.equal(row.sources_n, 30);
    assert.equal(countsOf(row).sessions, 3);
    assert.match(String(cursorOf(env)), /^\d+$/, 'the cursor moved past every joined line');
  } finally {
    env.done();
  }
});

test('twenty-nine joined lines still wait; the thirtieth sends them', async () => {
  // Catches: an off-by-one at batchLines.
  const env = semanticSessionFixture();
  try {
    lines(env, 10, 0, 'a');
    lines(env, 10, 60, 'b');
    lines(env, 9, 120, 'c');
    const llm = scripted();
    await sweep(ctxAt(env, 200, llm));
    assert.equal(llm.calls.length, 0);
    lines(env, 1, 130, 'd');
    await sweep(ctxAt(env, 200, llm));
    assert.equal(llm.calls.length, 1);
  } finally {
    env.done();
  }
});

test('a waiting session and a later one over ten lines go out together', async () => {
  // Catches: the waiting lines left behind when a large session arrives.
  const env = semanticSessionFixture();
  try {
    lines(env, 5, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm));
    lines(env, 12, 60, 'b');
    await sweep(ctxAt(env, 120, llm));
    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    const secondMessage = firstCall.messages[1];
    assert.ok(textOf(secondMessage.content).includes('a0 line'));
    const [row] = runs(env);
    assert.equal(row.sources_n, 17);
    assert.equal(countsOf(row).sessions, 2);
  } finally {
    env.done();
  }
});

test('two small sessions whose sum passes ten do not count as a large one', async () => {
  // Catches: the rule comparing the joined total with minLines instead of each session.
  const env = semanticSessionFixture();
  try {
    lines(env, 8, 0, 'a');
    lines(env, 8, 60, 'b');
    const llm = scripted();
    await sweep(ctxAt(env, 120, llm));
    assert.equal(llm.calls.length, 0);
  } finally {
    env.done();
  }
});

test('the day ends: a waiting session is written when its oldest line is maxWaitHours old, and not a minute before', async () => {
  // Catches: lines that wait for ever in a quiet scope (a loss); a deadline counted from the wrong end.
  const env = semanticSessionFixture();
  try {
    lines(env, 4, 0, 'a'); // the oldest line is at NOW + 0
    const llm = scripted();
    const before = await sweep(ctxAt(env, 24 * 60 - 1, llm));
    assert.equal(llm.calls.length, 0);
    const firstRun = before.runs[0];
    assert.equal(firstRun.outcome, 'waiting');
    await sweep(ctxAt(env, 24 * 60, llm));
    assert.equal(llm.calls.length, 1);
    assert.equal(runs(env)[0].sources_n, 4);
    const again = await sweep(ctxAt(env, 24 * 60 + 5, llm));
    assert.equal(llm.calls.length, 1, 'the written lines are not read twice');
    const runsFirstRun = again.runs[0];
    assert.equal(runsFirstRun.outcome, 'quiet');
  } finally {
    env.done();
  }
});

test('maxWaitHours is read from the live config', async () => {
  // Catches: the wait fixed at a constant.
  const env = semanticSessionFixture();
  try {
    lines(env, 4, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 60, llm, cfg({ maxWaitHours: 2 })));
    assert.equal(llm.calls.length, 0, 'an hour into a two-hour wait');
    await sweep(ctxAt(env, 3 * 60, llm, cfg({ maxWaitHours: 2 })));
    assert.equal(llm.calls.length, 1);
  } finally {
    env.done();
  }
});

test('a private chat waits and joins on its own, never with the group', async () => {
  // Catches: a small private session joined into the group request (a leak across scopes), or the group held back by it.
  const env = semanticSessionFixture();
  try {
    env.storeDmPlace(ADA); // No writer makes the DM place from Ada's person id.
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
    lines(env, 12, 0, 'g');
    lines(env, 4, 0, 'p', { scope: dm, place: dmPlaceOf(ADA) });
    const llm = scripted();
    const result = await sweep(ctxAt(env, 60, llm));
    assert.deepEqual(
      result.runs.map((r) => [r.scope, r.outcome]),
      [
        [`dm:discord:${dmPlaceOf(ADA)}`, 'waiting'], // The key is the place.
        ['group:discord', 'ok'],
      ]
    );
    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    const secondMessage = firstCall.messages[1];
    assert.ok(!textOf(secondMessage.content).includes('p0 line'), 'the private lines are not in the group request');
  } finally {
    env.done();
  }
});

test('minLines 0 writes every session as before', async () => {
  // Catches: no way to switch the waiting off.
  const env = semanticSessionFixture();
  try {
    lines(env, 2, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm, cfg({ minLines: 0 })));
    assert.equal(llm.calls.length, 1);
  } finally {
    env.done();
  }
});

test('joinOf counts sessions by the settle gap and answers wait, large, batch, deadline', () => {
  // Catches: the pure rule drifting from the sweep: the gap that splits sessions, the order of the reasons.
  const settings = sessionSettings({ memoryDb: { session: SETTINGS } });
  const at = (minutes: number): never => ({ at: HASH_IDS_NOW + minutes * MINUTE, rowid: minutes }) as never;
  const small = [at(0), at(1), at(2), at(20), at(21)]; // a 9-minute gap would not split; 18 does
  assert.deepEqual(joinOf(small, settings, HASH_IDS_NOW + HOUR), { write: false, sessions: 2, reason: 'wait' });
  assert.equal(joinOf([at(0), at(9)], settings, HASH_IDS_NOW + HOUR).sessions, 1, 'a gap under settleMinutes joins');
  assert.equal(joinOf([], settings, HASH_IDS_NOW).sessions, 0);
  const large = Array.from({ length: 11 }, (_, i) => at(i));
  assert.equal(joinOf(large, settings, HASH_IDS_NOW + HOUR).reason, 'large');
  const many = Array.from({ length: 30 }, (_, i) => at(i * 30));
  assert.equal(joinOf(many, settings, HASH_IDS_NOW + 30 * HOUR).reason, 'batch');
  assert.equal(joinOf([at(0)], settings, HASH_IDS_NOW + 24 * HOUR).reason, 'deadline');
  assert.equal(joinOf([at(0)], { ...settings, minLines: 0 }, HASH_IDS_NOW + HOUR).reason, 'off');
});

// ---------- the request layout ----------

function build(env: Fixture, now: number, config: Rec = cfg()) {
  const scopeEntry = scopesOf(env.db)[0];
  const batch = batchOf(env.db, scopeEntry.scope, {
    cursor: 0,
    since: null,
    maxMessages: 200,
    settleBefore: now - 10 * MINUTE,
  });
  return buildSessionRequest({ db: env.db, scope: scopeEntry, batch, config, prompts, selfName: 'Nep', now });
}
type Part = { type: string; text: string; cacheSegment?: string; cache_control?: unknown };
const partsOf = (content: unknown): Array<Part> => {
  assert.ok(Array.isArray(content), 'the user content is a list of text parts');
  return content as Array<Part>;
};

test('the stable blocks come first under the cache marker, the batch lines last and unmarked', () => {
  // Catches: the lines inside the cached prefix (never read twice) or the memory outside it (sent uncached each run).
  const env = semanticSessionFixture();
  try {
    lines(env, 6, 0, 'a');
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), kind: 'interest', text: 'likes café mornings' });
    const built = build(env, HASH_IDS_NOW + HOUR);
    const firstMessage = built.messages[0];
    assert.match(firstMessage.content, /^SYSTEM Nep\n\nCARD Nep/, 'the system text stays a string');
    const secondMessage = built.messages[1];
    const parts = partsOf(secondMessage.content);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].cacheSegment, 'stable');
    assert.equal(parts[1].cacheSegment, undefined);
    const firstPartText = parts[0].text;
    assert.ok(firstPartText.includes('<place>'));
    assert.ok(firstPartText.includes('<people>') && firstPartText.includes('likes café mornings'));
    assert.ok(!firstPartText.includes('<batch>') && !firstPartText.includes('a0 line'));
    const secondPartText = parts[1].text;
    assert.ok(secondPartText.startsWith('<batch>') && secondPartText.includes('a5 line'));
    assert.ok(!secondPartText.includes('<people>'));
    const sent = withCacheMarker(built.messages as never, '1h') as unknown as Array<{ content: Array<Part> | string }>;
    const sentParts = sent[1].content as Array<Part>;
    assert.ok(sentParts[0].cache_control, 'the stable part carries the marker');
    assert.equal(sentParts[1].cache_control, undefined, 'the lines carry none');
    assert.equal(sentParts[0].cacheSegment, undefined, 'the neutral tag never reaches the provider');
    const systemContent = sent[0].content;
    assert.ok(Array.isArray(systemContent) && systemContent.at(-1)!.cache_control, 'the system text is marked too');
  } finally {
    env.done();
  }
});

test('the stable part is byte-identical between two runs of a scope while nothing in it changed, and moves when a claim does', () => {
  // Catches: a clock, a counter or a line in the prefix (the cache never hits), and a cached prefix that outlives a changed memory.
  const env = semanticSessionFixture();
  try {
    lines(env, 6, 0, 'a');
    env.claim({
      id: 'cl-self',
      subjectKind: 'self',
      subjectId: 'self',
      kind: 'self_fact',
      text: 'keeps a small garden',
    });
    const first = partsOf(build(env, HASH_IDS_NOW + 2 * HOUR).messages[1].content)[0].text;
    lines(env, 6, 90, 'b');
    const second = partsOf(build(env, HASH_IDS_NOW + 5 * HOUR).messages[1].content);
    assert.equal(second[0].text, first);
    const secondSecondText = second[1].text;
    assert.ok(secondSecondText.includes('b5 line'), 'the new lines are in the batch part');
    env.db.prepare("UPDATE claims SET text = 'keeps a large garden' WHERE id = 'cl-self'").run();
    const changed = partsOf(build(env, HASH_IDS_NOW + 6 * HOUR).messages[1].content)[0].text;
    assert.notEqual(changed, first);
    assert.ok(changed.includes('large garden'));
  } finally {
    env.done();
  }
});

// ---------- the model and the record ----------

test('the run goes to the model of the memory chain with the memory role and a forced cache marker, never to the core model', async () => {
  // Catches: the writer sent to another model or role, or without the cache request.
  const env = semanticSessionFixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted();
    const config = { ...cfg(), models: { routes: chainsOf({ memory: 'x/the-writer', core: 'x/the-core' }) } };
    await sweep(ctxAt(env, 60, llm, config));
    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    const options = firstCall.options as Rec;
    assert.equal(options.model, 'x/the-writer');
    assert.equal(options.role, MEMORY_ROLE);
    assert.equal(options.cache, true);
    assert.equal(runs(env)[0].model, 'x/the-writer');
    assert.ok(!JSON.stringify(llm.calls[0]).includes('x/the-core'));
  } finally {
    env.done();
  }
});

test('without a key ring no request is made', async () => {
  // Catches: the writer sending a request with no key behind it. A core key in `.env` stood here: the session reads its
  // key from the key ring alone, so the case is a missing ring.
  const env = semanticSessionFixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted();
    const result = await sweep(ctxAt(env, 60, llm, cfg(), null));
    assert.equal(result.status, 'refused');
    assert.equal(llm.calls.length, 0);
  } finally {
    env.done();
  }
});

test('a run records the cache tokens the provider read, and zero when it reported none', async () => {
  // Catches: the saving unmeasurable.
  const env = semanticSessionFixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted({
      prompt_tokens: 3000,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 2400 },
    });
    await sweep(ctxAt(env, 60, llm));
    const [row] = runs(env);
    assert.equal(countsOf(row).cacheRead, 2400);
    assert.equal(row.tokens_prompt, 3000);
  } finally {
    env.done();
  }
  const bare = semanticSessionFixture();
  try {
    lines(bare, 11, 0, 'a');
    await sweep(ctxAt(bare, 60, scripted()));
    assert.equal(countsOf(runs(bare)[0]).cacheRead, 0);
  } finally {
    bare.done();
  }
});

// The memory session's key (src/memory/db/session.ts#memoryKeyState).

// The memory key from the key store: the memory session goes out on the key of its
// route, like every other role; a variable of `.env` never counts.
// A role's key is the route of its chain, so the ring is read off a
// memory chain that names `keys`, every key of the store when none is given.

/** A key ring over a fresh keys.json in a temp folder, with `fill` run on its store first. */
function ringWith(fill: (store: ReturnType<typeof createKeyStore>) => void, keys?: Array<string>): KeyRing {
  const store = createKeyStore({ privateDir: tempDir('memory-ring-') });
  fill(store);
  const chain = (keys ?? store.names()).map((key) => ({ via: 'api', key }));
  const ring = chainRing(store, (role) => (role === 'memory' ? chain : []));
  return { ...ring, names: () => [], states: () => [], bound: () => [] };
}

const reviewPrompts = { ...prompts, 'memory/draft': 'DRAFT', 'memory/check': 'CHECK' };

test('with a key store and no memory variable in .env, the memory session runs on the core key in use', () => {
  // Catches: the session stays not_configured after the deploy because it still looks for llm.keyByRole.memory in .env.
  const ring = ringWith((store) => store.add({ name: 'core-1', value: 'v-core-0001' }));
  const config = baseConfig({}, { llm: {} });
  assert.deepEqual(memoryKeyState(config, {}, ring), { ok: true, name: 'core-1' });
  assert.equal(refusalOf(config, {}, prompts, ring), null);
});

test('with a key store the memory role whose chain names another key is named by that key', () => {
  // Catches: the memory chain ignored, and the state names the first key of the file it does not go out on.
  const ring = ringWith(
    (store) => {
      store.add({ name: 'core-1', value: 'v-core-0001' });
      store.add({ name: 'mem-own', value: 'v-mem-0002' });
    },
    ['mem-own']
  );
  assert.deepEqual(memoryKeyState(baseConfig(), {}, ring), { ok: true, name: 'mem-own' });
});

test('with an empty key store the session refuses even when .env still holds the memory variable', () => {
  // Catches: the old .env variable keeps the session alive on a deployment whose store has no key at all.
  const ring = ringWith(() => undefined);
  const env = { OPENROUTER_MEMORY_KEY: 'v-env-0003' };
  assert.deepEqual(memoryKeyState(baseConfig(), env, ring), { ok: false, name: null });
  assert.equal(refusalOf(baseConfig(), env, prompts, ring), CODES.NOT_CONFIGURED);
});

// A role that runs through a harness needs no API key, and no check at
// the moment of use asks for one. The memory writer on `claude` or `codex` sends no key, so neither its sweep nor its
// review may refuse for want of one.
const onHarness = { kind: 'subharness' as const, backend: 'claude' as const, model: 'claude-opus-4-6', effort: null };

test('a memory writer on a harness needs no key: the sweep and the review are not refused with an empty store', () => {
  // Catches: memory sessions stopped for two days with not_configured while the writer ran on the Claude harness.
  const empty = ringWith(() => undefined);
  assert.equal(refusalOf(baseConfig(), {}, prompts, empty, onHarness), null);
  assert.equal(reviewRefusal(baseConfig(), {}, reviewPrompts, empty, onHarness), null);
  assert.equal(memoryKeyState(baseConfig(), {}, empty, onHarness).ok, true);
});

test('a memory writer on the direct path with no key is still refused', () => {
  // Catches: the harness exception swallowing the direct path's real need for a key.
  const empty = ringWith(() => undefined);
  assert.equal(refusalOf(baseConfig(), {}, prompts, empty, { kind: 'direct' }), CODES.NOT_CONFIGURED);
  assert.equal(reviewRefusal(baseConfig(), {}, reviewPrompts, empty, { kind: 'direct' }), CODES.NOT_CONFIGURED);
});

test('a sweep whose writer runs on a harness goes on with an empty key store', async () => {
  // Catches: the sweep reading only the key ring and refusing before the harness client is ever asked.
  const empty = ringWith(() => undefined);
  const result = await sweep({
    db: dbOf(openMemoryDb(':memory:')),
    write: () => Promise.resolve(),
    llm: { complete: () => Promise.reject(new Error('no request expected')) },
    hot: { config: baseConfig(), prompts },
    env: {},
    ring: empty,
    path: () => onHarness,
    now: () => HASH_IDS_NOW,
  });
  assert.notEqual(result.code, CODES.NOT_CONFIGURED);
});

// The media pass keeps its own daily count and its pace (src/memory/db/session.ts#sweep, the quiet branch, and
// src/memory/db/writer-switch.ts#dueScopes): its sweeps count toward `memoryDb.session.mediaPassPerDay`, never toward
// `sweepsPerScopePerDay`, so a scope whose pass used its day still gets its ordinary session, and a pass that finds
// `maxMessages` old lines waits `everyMinutes` like any sweep. Every run here comes from a real sweep with a fake model
// and a fake clock; the told media lines and the ids are synthetic.

const MEDIA_PASS_CAP_MINUTE = 60_000;
const DAY_START = Date.parse('2026-11-05T09:00:00.000Z');
const MODE = 'shadow';

/** The value under `keys` in a parsed JSON tree, or undefined. */
function valueAt(tree: unknown, keys: ReadonlyArray<string>): unknown {
  let at: unknown = tree;
  for (const key of keys) at = at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
  return at;
}

type Session = {
  maxMessages?: number;
  everyMinutes?: number;
  sweepsPerScopePerDay?: number;
  mediaPassPerDay?: number;
};

function configOf(session: Session): Config {
  return {
    bot: { timezone: 'UTC' },
    models: { routes: chainsOf({ memory: 'x/memory' }) },
    memoryDb: {
      session: {
        mode: MODE,
        minMessages: 1,
        minLines: 0,
        maxMessages: 1,
        everyMinutes: 0,
        sweepsPerScopePerDay: 24,
        mediaPassPerDay: 24,
        mediaPass: true,
        ...session,
      },
    },
  };
}

/** The database, the scope, a clock the test moves and the count of model calls. */
type Rig = { env: Env; scopeKey: string; at: number; calls: number };

/** A sweep's context whose model answers an empty memory to every call and counts the calls. */
function mediaPassCapCtxOf(rig: Rig, config: Config): SessionContext {
  return {
    db: rig.env.db,
    write: (update: Row) => new Promise((resolve) => resolve(applyMemoryWrite(rig.env.handle, update))),
    llm: {
      complete() {
        rig.calls += 1;
        return Promise.resolve({ text: memoryBlock({}), usage: { prompt_tokens: 100, completion_tokens: 10 } });
      },
    },
    hot: { config, prompts },
    env: {},
    ring: memoryRing(),
    now: () => rig.at,
    log: {},
    selfName: 'Nep',
  };
}

/**
 * The group scope with `told` old image lines and one line of words, its ordinary cursor past them all: the scope is
 * quiet, and the media pass has the told lines left to read.
 */
function withQuietScope(told: number, body: (rig: Rig) => Promise<void>): Promise<void> {
  const env = fixture();
  for (let i = 0; i < told; i += 1) observeLine(env, KINDS[0], 'part', { native: `told-${i}`, at: AT + i * 1000 });
  env.say({ native: 'words', at: AT + told * 1000, text: 'words of its own', place: GENERAL });
  fillEnvAudiences(env);
  const scope = scopesOf(env.db).find((one) => one.scope.scope_kind === 'group');
  assert.ok(scope);
  const last = Number(env.db.prepare('SELECT MAX(rowid) AS r FROM sources').get()?.r);
  env.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(cursorKey(MODE, scope.key), String(last));
  const rig: Rig = { env, scopeKey: scope.key, at: DAY_START, calls: 0 };
  return body(rig).finally(() => env.done());
}

/** `n` new lines of words in the scope, settled half an hour before the clock. */
function newLines(rig: Rig, n: number, tag: string): void {
  for (let i = 0; i < n; i += 1) {
    rig.env.say({
      native: `${tag}-${i}`,
      at: rig.at - 30 * MEDIA_PASS_CAP_MINUTE + i * 1000,
      text: `${tag} line ${i}`,
      place: GENERAL,
    });
  }
  fillEnvAudiences(rig.env);
}

/** One sweep of the scope at the clock's time. */
const sweepAt = (rig: Rig, config: Config) =>
  sweep(mediaPassCapCtxOf(rig, config), { scopes: new Set([rig.scopeKey]) });

/** `n` sweeps of the quiet scope a minute apart: each one is a media pass. */
async function mediaPasses(rig: Rig, config: Config, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    rig.at += MEDIA_PASS_CAP_MINUTE;
    await sweepAt(rig, config);
  }
}

const dueKeys = (rig: Rig, config: Config): Array<string> =>
  dueScopes(rig.env.db, config, rig.at).map((one) => one.key);

test('a media pass the sweep runs leaves the ordinary sweeps of the day at zero', () =>
  // Catches: scopeSweepsToday counting media-pass runs with the ordinary ones, which stalled a production run.
  withQuietScope(3, async (rig) => {
    const config = configOf({});
    await mediaPasses(rig, config, 1);
    assert.equal(rig.calls, 1, 'the quiet scope ran its media pass');
    assert.equal(scopeSweepsToday(rig.env.db, rig.scopeKey, rig.at, MODE), 0);
  }));

test('the sweep runs the ordinary batch of a scope whose media pass used its day', () =>
  // Catches: sweep's own cap check refusing the new lines with `capped` because media passes filled the count.
  withQuietScope(4, async (rig) => {
    const config = configOf({ sweepsPerScopePerDay: 2, mediaPassPerDay: 2 });
    await mediaPasses(rig, config, 2);
    rig.at += MEDIA_PASS_CAP_MINUTE;
    newLines(rig, 1, 'fresh');
    const result = await sweepAt(rig, config);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.runs.map((run) => run.outcome),
      ['ok']
    );
    assert.equal(rig.calls, 3);
  }));

test('the media pass stops at mediaPassPerDay while old lines are left', () =>
  // Catches: the quiet branch still comparing with sweepsPerScopePerDay, so the pass runs on all day.
  withQuietScope(4, async (rig) => {
    const config = configOf({ sweepsPerScopePerDay: 24, mediaPassPerDay: 1 });
    await mediaPasses(rig, config, 2);
    assert.equal(rig.calls, 1, 'the second pass of the day did not run');
    assert.deepEqual(dueKeys(rig, config), []);
  }));

// ---------- the setting ----------

test('mediaPassPerDay falls back to the value of config.json, which the schema names', () => {
  // Catches: a code fallback that drifts from the shipped config, or a setting missing from the schema and its document.
  const shipped: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  const shippedValue = valueAt(shipped, ['memoryDb', 'session', 'mediaPassPerDay']);
  assert.ok(Number.isInteger(shippedValue) && Number(shippedValue) > 0, 'config.json ships a whole number of passes');
  assert.equal(sessionSettings({}).mediaPassPerDay, shippedValue);
  assert.equal(sessionSettings({ memoryDb: { session: { mediaPassPerDay: -1 } } }).mediaPassPerDay, shippedValue);
  const entry = CONFIG_SCHEMA.find((one) => one.key === 'memoryDb.session.mediaPassPerDay');
  assert.ok(entry, 'the schema names the key');
  assert.equal(entry.default, shippedValue);
});

// A memory session of a DM whose partner is an opaque person (src/memory/db/session-write.ts, session.ts#scopesOf): the
// triple of such a DM spells no chat, so the sweep finds the DM by its stored audience and the writer narrows on
// audience ids. A fact learned there stays that partner's and no one else's. Synthetic content only.

const NOTE = 'told only in this DM';

test('the sweep finds a DM with an opaque partner as its own scope, and its answer stays in that DM', async () => {
  // Bug: the sweep drops the scope as malformed, so nothing said in this DM is ever remembered.
  const world = semanticWorld();
  addSource(world, 'alex', 'between us');
  const found = scopesOf(world.db).find((one) => one.scope.scope_dm === ALEX);
  assert.equal(found?.audienceId, dmAudience(DM_ALEX));
  const answer = {
    claims: [{ op: 'add', subject: ALEX, kind: 'detail', text: NOTE, how: 'said', sources: [1] }],
  };
  await sweep({
    db: world.db,
    write: (update: unknown) => Promise.resolve(applyMemoryWrite(world.handle, update)),
    llm: fakeLlm(memoryBlock(answer)),
    hot: { config: baseConfig({ mode: 'apply', settleMinutes: 0 }), prompts },
    env: {},
    ring: memoryRing(),
    now: () => Date.UTC(2026, 10, 5, 12),
    log: {},
    selfName: 'Nep',
  });
  const row = world.db.prepare('SELECT audience_id FROM claims WHERE text = ?').get(NOTE);
  assert.equal(row?.audience_id, dmAudience(DM_ALEX));
  world.handle.close();
});

// The memory session of the persona's own time (src/memory/db/session.ts, scope `own:<iface>`): their heartbeat turns
// read as a batch under the interface's group context, what they keep written under the group audience. A fake llm and made-up
// rows only; nothing leaves the process.

const OWN = 'own:discord';
const config = baseConfig({ mode: 'apply' });

function heartbeat(db: Db, id: string, { think = 'a quiet hour', query = 'ήλιος', found = 'sunny pages' } = {}): void {
  const at = '2026-10-24T10:00:00.000Z';
  db.prepare(
    "INSERT INTO wake_runs (id, kind, started_at, finished_at, status, outcome) VALUES (?, 'heartbeat', ?, ?, 'succeeded', 'skip')"
  ).run(id, at, at);
  const calls = [
    { id: 'c1', name: 'web_search', arguments: JSON.stringify({ query }), parsed: { query }, parseError: null },
    { id: 'c2', name: 'conversation_read', arguments: '{"chat":"#cdm"}', parsed: { chat: '#cdm' }, parseError: null },
  ];
  const insert = db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, messages, think, tool_calls)
     VALUES (?, 1, ?, 'a1', ?, 'core', 'ok', ?, ?, ?, ?)`
  );
  insert.run(
    `${id}:0`,
    id,
    0,
    at,
    JSON.stringify([{ role: 'user', content: 'HEARTBEAT INPUT' }]),
    think,
    JSON.stringify(calls)
  );
  const next = [
    { role: 'user', content: 'HEARTBEAT INPUT' },
    {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    { role: 'tool', tool_call_id: 'c1', content: `Call succeeded: ${found}` },
    { role: 'tool', tool_call_id: 'c2', content: 'Call succeeded: a private line' },
  ];
  insert.run(`${id}:1`, id, 1, at, JSON.stringify(next), 'done looking', null);
}

/** The user content of request `n` the fake llm was sent. */
const sentOf = (llm: ReturnType<typeof fakeLlm>, n: number): string => {
  const { calls } = llm;
  const [, user] = calls[n].messages;
  return textOf(user.content);
};

const ownTimeCursorOf = (db: Db): unknown =>
  db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('apply', OWN))?.value ?? null;

test('a heartbeat run yields one request with the persona’s thinking and every call, and a claim lands under the group audience', async () => {
  const env = semanticSessionFixture();
  try {
    heartbeat(env.db, 'turn:1');
    const llm = fakeLlm(
      memoryBlock({
        claims: [
          { op: 'add', subject: 'self', kind: 'self_fact', text: 'reads about the sun', how: 'said', sources: ['#2'] },
        ],
      })
    );
    const result = await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    assert.equal(llm.calls.length, 1);
    const [first] = result.runs;
    assert.equal(first.outcome, 'ok');
    const sent = sentOf(llm, 0);
    for (const part of [
      'a quiet hour',
      'web.search {"query":"ήλιος"}',
      'sunny pages',
      'conversation.read',
      'a private line',
    ])
      assert.ok(sent.includes(part), `the request holds ${part}`);
    assert.ok(!sent.includes('HEARTBEAT INPUT'), 'the heartbeat input request stays out');
    const group = audienceOf({ scope_kind: 'group', scope_iface: 'discord', scope_dm: null }).audience_id;
    const claim = env.db.prepare("SELECT audience_id FROM claims WHERE subject_kind = 'self'").get();
    assert.equal(claim?.audience_id, group);
    const where = whereFor(groupContext('discord'), 'c');
    const read = env.db.prepare(`SELECT c.text FROM claims c WHERE c.subject_kind = 'self' AND ${where.sql}`);
    const seen = read.all(...where.params).map((row) => row.text);
    assert.deepEqual(seen, ['reads about the sun']);
    assert.equal(ownTimeCursorOf(env.db), '1', 'the cursor moved past the run');
  } finally {
    env.handle.close();
  }
});

test('a failed request leaves the cursor and the next sweep sends the same run again', async () => {
  const env = semanticSessionFixture();
  try {
    heartbeat(env.db, 'turn:1');
    const llm = fakeLlm([new Error('down'), memoryBlock({})]);
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    assert.equal(ownTimeCursorOf(env.db), null);
    const stored = env.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE kind = 'own_time'").get();
    assert.equal(stored?.n, 0);
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]), ignoreSweepCap: true });
    assert.equal(llm.calls.length, 2);
    assert.equal(sentOf(llm, 1), sentOf(llm, 0));
    assert.equal(ownTimeCursorOf(env.db), '1');
  } finally {
    env.handle.close();
  }
});

test('a run with no step moves the cursor and sends nothing', async () => {
  const env = semanticSessionFixture();
  try {
    env.db
      .prepare(
        "INSERT INTO wake_runs (id, kind, started_at, finished_at, status) VALUES ('turn:0', 'heartbeat', '2026-10-24T09:00:00.000Z', '2026-10-24T09:00:00.000Z', 'failed')"
      )
      .run();
    const llm = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    assert.equal(llm.calls.length, 0);
    assert.equal(ownTimeCursorOf(env.db), '1');
  } finally {
    env.handle.close();
  }
});

test('two runs waiting go out oldest first in one request', async () => {
  const env = semanticSessionFixture();
  try {
    heartbeat(env.db, 'turn:1', { think: 'Ἀρχή' });
    heartbeat(env.db, 'turn:2', { think: 'Τέλος' });
    const llm = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set([OWN]) });
    const sent = sentOf(llm, 0);
    assert.ok(sent.indexOf('Ἀρχή') >= 0 && sent.indexOf('Ἀρχή') < sent.indexOf('Τέλος'), sent);
  } finally {
    env.handle.close();
  }
});

// The size of one memory session request (src/memory/db/session.ts): a page is bounded by
// `memoryDb.session.maxPageTokens` as well as by the request cap, so a batch of long lines cannot send a request the
// model does not answer within the session's timeout. A batch pinned by an applied page cannot be cut by lines, so its
// page that is too large goes out in parts of fewer people. Synthetic people and Greek and accented Latin text only.

const CY = 'u-cy';
const DORA = 'u-dora';
const SCOPE = 'group:discord';

/** Four people with long claims, two lines each: with `maxPeople` 2 the batch takes two pages of two people. */
function crowd(env: Fixture): void {
  for (const [native, name] of [
    [CY, 'Κύρος'],
    [DORA, 'Dóra'],
  ]) {
    const { db } = env;
    const person = db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 1)");
    person.run(personOf(native));
    const account = db.prepare(
      "INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)"
    );
    account.run(`discord:${native}`, native, personOf(native), JSON.stringify([name]));
  }
  let minutes = 120;
  for (const native of [ADA, BOB, CY, DORA]) {
    for (let i = 0; i < 6; i += 1)
      env.claim({
        id: `claim-${native}-${i}`,
        subjectId: personOf(native),
        text: `${native} κρατά μια μακριά σημείωση ${i}: ${'café στη Θεσσαλονίκη, '.repeat(12)}`,
      });
    for (let i = 0; i < 2; i += 1) {
      env.say({
        native: `m-${native}-${i}`,
        minutesAgo: minutes,
        text: `γεια από ${native}, γραμμή ${i}`,
        author: native,
      });
      minutes -= 5;
    }
  }
}

const apply = (session: Record<string, unknown> = {}) =>
  baseConfig({ mode: 'apply', maxPeople: 2, ...session }, { llm: { temperature: 1, maxRequestTokens: 1_000_000 } });

/** The natives of the people a request shows in `<people>` (each person's `id: <@native>` line). */
const shownPeople = (messages: unknown): Array<string> => {
  const user = textOf((messages as Array<{ content: unknown }>)[1].content);
  return [...user.matchAll(/^id: <@([^>]+)>$/gm)].map((match) => match[1]);
};

const metaRow = ({ db }: Fixture) => db.prepare('SELECT value FROM meta WHERE key = ?');
const pageBudgetCursorOf = (env: Fixture): number => Number(metaRow(env).get(cursorKey('apply', SCOPE))?.value ?? 0);

/** The batch at cursor 0, and the estimate and people of each of its two pages under `config`. */
function pagesNow(env: Fixture, config: Record<string, unknown>) {
  const scope = scopesOf(env.db).find((entry) => entry.key === SCOPE)!;
  const { scope: where } = scope;
  const batch = batchOf(env.db, where, { cursor: 0, since: null, maxMessages: 200, settleBefore: HASH_IDS_NOW });
  const page = (n: number) => {
    const built = buildSessionRequest({
      db: env.db,
      scope,
      batch,
      config,
      prompts,
      selfName: 'Nep',
      now: HASH_IDS_NOW,
      page: n,
    });
    return { estimate: estimateMessages(built.messages), people: built.people.map((person) => person.native) };
  };
  return { scope, batch, pages: [page(0), page(1)] };
}

/** A first sweep whose page 0 fails and page 1 is applied: the batch is pinned from then on. */
async function pinWithPageOneApplied(env: Fixture) {
  const llm = fakeLlm((_messages, _options, n) => (n === 1 ? new Error('timeout') : memoryBlock({})));
  await sweep(ctxOf(env, { llm, config: apply() }));
  assert.equal(llm.calls.length, 2, 'the batch took two pages');
  assert.equal(pageBudgetCursorOf(env), 0, 'the cursor waits for page 0');
}

test('a batch whose largest page fits the request cap but not maxPageTokens is cut by lines until it fits the page budget', () => {
  // Catches: fitBatch measured pages against 0.85 of llm.maxRequestTokens only, so a media pass of 200 long lines sent
  // an 84k-token page that timed out at 300 s every hour.
  const env = semanticSessionFixture();
  try {
    crowd(env);
    const { scope, batch, pages } = pagesNow(env, apply());
    const largest = Math.max(...pages.map((page) => page.estimate));
    const config = apply({ maxPageTokens: largest - 1 });
    const fitted = fitBatch(env.db, scope, batch, { config, prompts, selfName: 'Nep', now: HASH_IDS_NOW, min: 1 });
    assert.ok(fitted.length < batch.length, 'the batch is cut');
    const firstByArrival = [...batch]
      .sort((a, b) => a.rowid - b.rowid)
      .slice(0, fitted.length)
      .map((line) => line.rowid);
    assert.deepEqual(
      fitted.map((line) => line.rowid).sort((a, b) => a - b),
      firstByArrival,
      'the first lines by arrival, so none is skipped'
    );
  } finally {
    env.done();
  }
});

test('a pinned batch whose open page passes maxPageTokens sends that page in parts of fewer people and then moves the cursor', async () => {
  // Catches: the media pass at cursor 24043 stuck for good. Page 1 was applied, so the batch kept its lines (no cut), and
  // page 0 went out whole every hour at the same size and timed out every time.
  const env = semanticSessionFixture();
  try {
    crowd(env);
    await pinWithPageOneApplied(env);
    const { batch, pages } = pagesNow(env, apply());
    const budget = pages[0].estimate - 1;
    const llm = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm, config: apply({ maxPageTokens: budget }) }));
    assert.ok(llm.calls.length >= 2, 'page 0 went out in parts');
    for (const call of llm.calls)
      assert.ok(estimateMessages(call.messages) <= budget, 'every part fits the page budget');
    const sent = llm.calls.flatMap((call) => shownPeople(call.messages));
    assert.deepEqual([...sent].sort(), [...pages[0].people].sort(), 'each person of page 0 once, nobody of page 1');
    assert.equal(
      pageBudgetCursorOf(env),
      Math.max(...batch.map((line) => line.rowid)),
      'the cursor moves past the batch'
    );
  } finally {
    env.done();
  }
});

test('a page sent in parts keeps its parts on the next try: an applied part is not sent again, even when the page would now fit whole', async () => {
  // Catches: a retry that rebuilt the page whole (or split it another way) and wrote the notes of an applied part a
  // second time, from lines whose notes it no longer saw (the context is as of the batch's newest line).
  const env = semanticSessionFixture();
  try {
    crowd(env);
    await pinWithPageOneApplied(env);
    const { batch, pages } = pagesNow(env, apply());
    const split = fakeLlm((_messages, _options, n) => (n === 1 ? memoryBlock({}) : new Error('timeout')));
    await sweep(ctxOf(env, { llm: split, config: apply({ maxPageTokens: pages[0].estimate - 1 }) }));
    assert.ok(split.calls.length >= 2, 'page 0 went out in parts');
    const [first] = split.calls;
    const appliedPart = shownPeople(first.messages);
    assert.equal(pageBudgetCursorOf(env), 0, 'a failed part holds the cursor');

    const retry = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm: retry, config: apply() }));
    const open = pages[0].people;
    const resent = retry.calls.flatMap((call) => shownPeople(call.messages));
    assert.deepEqual(
      [...resent].sort(),
      open.filter((native) => !appliedPart.includes(native)).sort(),
      'only the people of the parts not applied'
    );
    assert.equal(
      pageBudgetCursorOf(env),
      Math.max(...batch.map((line) => line.rowid)),
      'the cursor moves past the batch'
    );
  } finally {
    env.done();
  }
});

// The memory session's `<people>` block lists the people of a batch. The persona's own accounts are linked to their
// person when they are seen (identity-links.ts), so an edit of their own line, stored as `seen`, must not put them among
// the people they read about. A real memory service and synthetic ids.

const PEOPLE_NOW = Date.parse('2026-11-05T12:00:00Z');
const PEOPLE_AT = PEOPLE_NOW - 60 * 60_000;
const PEOPLE_SELF = 'her-synthetic-id';

function line(id: string, author: string, name: string, edit = false) {
  const envelope = observationOf(
    {
      iface: 'discord',
      at: PEOPLE_AT,
      edit,
      chat: { id: 'room', kind: 'channel', chatType: 'channel', rootId: 'root' },
      message: {
        id,
        at: PEOPLE_AT,
        content: `a synthetic line ${id}${edit ? ', edited' : ''}`,
        author: { id: author, name },
      },
    },
    { selfId: PEOPLE_SELF }
  );
  if (!envelope) throw new Error('the synthetic line was refused');
  return envelope;
}

test('an edit of the persona’s own line leaves their person out of the session request', async () => {
  // Bug: the persona's account is linked to `person:self`, their edit is a `seen` line, and the session reads them as one of the
  // people of the batch.
  const memory = await openTestMemory({ now: () => PEOPLE_NOW });
  try {
    await memory.memoryDb.observeMessage(line('m1', 'member', 'Member'));
    await memory.memoryDb.observeMessage(line('m2', PEOPLE_SELF, 'Her'));
    await memory.memoryDb.observeMessage(line('m2', PEOPLE_SELF, 'Her', true));
    const db = memory.memoryDb.database();
    if (!db) throw new Error('the synthetic memory database is unavailable');
    const scopeEntry = scopesOf(db).find((entry) => entry.key === 'group:discord');
    if (!scopeEntry) throw new Error('the synthetic lines have no group session scope');
    const batch = batchOf(db, scopeEntry.scope, { cursor: 0, since: null, maxMessages: 20, settleBefore: PEOPLE_NOW });
    const request = buildSessionRequest({
      db,
      scope: scopeEntry,
      batch,
      config: baseConfig(),
      prompts,
      selfName: 'Synthetic persona',
      now: PEOPLE_NOW,
    });
    assert.equal(
      request.people.some((person) => person.id === 'person:self'),
      false
    );
  } finally {
    await memory.close();
  }
});

// The session request's place block (src/memory/db/session.ts): the place fields a place of the batch has not written.
// Synthetic rows only; nothing leaves the process.

test('the place block names the place fields a place of the batch has not written, and only those', () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const bare = textOf(request(env).messages[1].content);
    const place = (text: string) => text.slice(text.indexOf('<place>'), text.indexOf('</place>'));
    assert.match(place(bare), /\[p1\] UNWRITTEN purpose, tone, topics/, 'an undescribed place lists all three fields');

    env.db
      .prepare(
        "INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, audience_id, current_version) VALUES ('d-purpose', 'place', ?, 'purpose', 'group', 'discord', 'aud:none', 'dv-purpose')"
      )
      .run(CHANNEL);
    env.db
      .prepare(
        "INSERT INTO description_versions (id, description_id, text, written_at) VALUES ('dv-purpose', 'd-purpose', 'planning trips', '2026-10-20T10:00:00Z')"
      )
      .run();
    const partly = place(textOf(request(env).messages[1].content));
    assert.match(partly, /\[p1\] UNWRITTEN tone, topics/, 'a written field leaves the list');
    assert.doesNotMatch(partly, /UNWRITTEN[^\n]*purpose/);
  } finally {
    env.done();
  }
});

// The memory session's stretches (src/memory/db/session.ts, session-write.ts, stretches.ts): the request lists the
// stretches of the persona's lines a batch holds, the answer writes one sentence per stretch, and the sentence is an `episodes`
// row of the kind `stretch`. A fake llm and made-up rows only; nothing leaves the process.

const stretchesConfig = baseConfig({ mode: 'apply' });
const GROUP = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };

const ago = (minutes: number): number => HASH_IDS_NOW - minutes * MINUTE;

const stretchRows = (db: Db) =>
  db
    .prepare(
      "SELECT id, place_id, start_ms, last_ms, what, audience_id, subject_id, holder_id, extra FROM episodes WHERE kind = 'stretch' ORDER BY start_ms"
    )
    .all();

/** The user content of request `n` the fake llm was sent. */
const stretchesSentOf = (llm: ReturnType<typeof fakeLlm>, n: number): string => {
  const { calls } = llm;
  const [, user] = calls[n].messages;
  return textOf(user.content);
};

test("an answer's sentence is stored as a stretch row with its place, moments and the group audience", async () => {
  // Bug: the sentence is dropped, lands on another place, or takes the run's audience instead of its lines'.
  const env = semanticSessionFixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα' });
    env.say({ native: 'm2', minutesAgo: 95, text: 'καλημέρα', kind: 'said' });
    env.say({ native: 'm3', minutesAgo: 80, text: 'τι νέα;', kind: 'said' });
    const llm = fakeLlm(memoryBlock({ stretches: [{ stretch: 's1', what: 'Είπαμε καλημέρα.' }] }));
    const result = await sweep(ctxOf(env, { llm, config: stretchesConfig }), {});
    const [run] = result.runs;
    assert.equal(run?.outcome, 'ok');
    const rows = stretchRows(env.db);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row?.place_id, CHANNEL);
    assert.equal(row?.start_ms, ago(95));
    assert.equal(row?.last_ms, ago(80));
    assert.equal(row?.what, 'Είπαμε καλημέρα.');
    assert.equal(row?.subject_id, memoryIds.SELF_PERSON);
    assert.equal(row?.audience_id, audienceOf(GROUP).audience_id);
    const read = storedStretches(env.db, whereFor(groupContext('discord'), 'e'), {
      holders: [CHANNEL],
      from: ago(200),
      to: HASH_IDS_NOW,
    });
    assert.deepEqual(
      read.map((one) => one.what),
      ['Είπαμε καλημέρα.']
    );
  } finally {
    env.done();
  }
});

test("a sentence of a direct chat's stretch is not read under a group context", async () => {
  // Bug: the sentence takes the group audience, so a group turn reads what the persona talked about in private.
  const env = semanticSessionFixture();
  try {
    env.storeDmPlace(ADA);
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
    env.say({ native: 'd1', minutesAgo: 100, text: 'γεια', place: dmPlaceOf(ADA), scope: dm });
    env.say({ native: 'd2', minutesAgo: 95, text: 'γεια σου', kind: 'said', place: dmPlaceOf(ADA), scope: dm });
    const llm = fakeLlm(memoryBlock({ stretches: [{ stretch: 's1', what: 'Μιλήσαμε ιδιωτικά.' }] }));
    await sweep(ctxOf(env, { llm, config: stretchesConfig }), {});
    assert.equal(stretchRows(env.db).length, 1);
    const read = (ctx: unknown) =>
      storedStretches(env.db, whereFor(ctx, 'e'), { holders: [dmPlaceOf(ADA)], from: ago(200), to: HASH_IDS_NOW });
    assert.deepEqual(read(groupContext('discord')), []);
    assert.equal(read(dmContext(personOf(ADA), 'discord', dmPlaceOf(ADA))).length, 1);
  } finally {
    env.done();
  }
});

test('a second batch that continues the stretch replaces the sentence and extends the last moment in one row', async () => {
  // Bug: a continued talk gets a second row, or keeps the old sentence and its old end.
  const env = semanticSessionFixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα' });
    env.say({ native: 'm2', minutesAgo: 95, text: 'καλημέρα', kind: 'said' });
    const llm = fakeLlm([
      memoryBlock({ stretches: [{ stretch: 's1', what: 'ΠΡΩΤΗ' }] }),
      memoryBlock({ stretches: [{ stretch: 's1', what: 'ΔΕΥΤΕΡΗ' }] }),
    ]);
    await sweep(ctxOf(env, { llm, config: stretchesConfig }), {});
    env.say({ native: 'm3', minutesAgo: 80, text: 'και κάτι ακόμα', kind: 'said' });
    await sweep(ctxOf(env, { llm, config: stretchesConfig }), { ignoreSweepCap: true });
    assert.equal(llm.calls.length, 2);
    assert.ok(stretchesSentOf(llm, 1).includes('ΠΡΩΤΗ'), 'the second request shows the stored sentence');
    const rows = stretchRows(env.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.what, 'ΔΕΥΤΕΡΗ');
    assert.equal(rows[0]?.start_ms, ago(95));
    assert.equal(rows[0]?.last_ms, ago(80));
  } finally {
    env.done();
  }
});

test('an unknown handle, an empty sentence and a duplicate are dropped with their codes and the rest is kept', () => {
  // Bug: a bad entry sinks the answer, or a second sentence for one stretch overwrites the first.
  const env = semanticSessionFixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'μια', kind: 'said' });
    const built = request(env);
    const long = 'λ'.repeat(5000);
    const { plan, counts } = validateAnswer(
      {
        stretches: [
          { stretch: 's9', what: 'κανένα' },
          { stretch: 's1', what: '  ' },
          { stretch: 's1', what: long },
          { stretch: 's1', what: 'πάλι' },
        ],
        claims: [{ op: 'add', subject: 'self', kind: 'self_fact', text: 'γράφει', how: 'saw', sources: ['#1'] }],
      },
      { maps: built.maps, people: built.people }
    );
    assert.equal(counts.dropped.unknown_stretch, 1);
    assert.equal(counts.dropped.no_text, 1);
    assert.equal(counts.dropped.duplicate_stretch, 1);
    assert.equal(plan.stretches.length, 1);
    const [kept] = plan.stretches;
    assert.ok(String(kept?.what).length < long.length, 'a too long sentence is cut');
    assert.equal(plan.claims.length, 1);
  } finally {
    env.done();
  }
});

/** A finished heartbeat run `id` at `at` with one step of thinking. */
function stretchesHeartbeat(db: Db, id: string, at: string, think: string): void {
  db.prepare(
    "INSERT INTO wake_runs (id, kind, started_at, finished_at, status, outcome) VALUES (?, 'heartbeat', ?, ?, 'succeeded', 'skip')"
  ).run(id, at, at);
  db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, messages, think, tool_calls)
     VALUES (?, 1, ?, 'a1', 0, 'core', 'ok', ?, '[]', ?, NULL)`
  ).run(`${id}:0`, id, at, think);
}

test('an own-time batch of two turns lists two stretches and stores a sentence per turn under the group audience', async () => {
  // Bug: two heartbeats share one sentence, or the persona's own time is stored under the internal audience.
  const env = semanticSessionFixture();
  try {
    stretchesHeartbeat(env.db, 'turn:1', '2026-10-24T09:00:00.000Z', 'Ἀρχή');
    stretchesHeartbeat(env.db, 'turn:2', '2026-10-24T10:00:00.000Z', 'Τέλος');
    const llm = fakeLlm(
      memoryBlock({
        stretches: [
          { stretch: 's1', what: 'Σκέφτηκα την αρχή.' },
          { stretch: 's2', what: 'Σκέφτηκα το τέλος.' },
        ],
      })
    );
    await sweep(ctxOf(env, { llm, config: stretchesConfig }), { scopes: new Set(['own:discord']) });
    const sent = stretchesSentOf(llm, 0);
    assert.ok(sent.includes('[s1]') && sent.includes('[s2]'), sent);
    const rows = stretchRows(env.db);
    assert.deepEqual(
      rows.map((row) => [
        row.holder_id,
        row.what,
        row.place_id,
        (JSON.parse(String(row.extra)) as { turn: string }).turn,
      ]),
      [
        ['turn:1', 'Σκέφτηκα την αρχή.', null, 'turn:1'],
        ['turn:2', 'Σκέφτηκα το τέλος.', null, 'turn:2'],
      ]
    );
    for (const row of rows) assert.equal(row.audience_id, audienceOf(GROUP).audience_id);
  } finally {
    env.done();
  }
});

// The persona's memory session (src/memory/db/session.ts, session-write.js): the request, the answer's checks, the id mapping, shadow
// and apply writes, the refusals. A fake llm and synthetic Greek and accented Latin text only; nothing leaves the process.

// The key comes from the key ring, not from a variable of `.env`: the cases pass a ring where they passed `env`.
test('refusals: off, no key, no prompt; the key state names a key, never a value', () => {
  const ring = memoryRing();
  assert.equal(refusalOf(baseConfig({ mode: 'off' }), null, prompts, ring), CODES.OFF);
  assert.equal(refusalOf(baseConfig(), null, prompts, null), CODES.NOT_CONFIGURED);
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }), null, prompts, ring), null);
  assert.equal(refusalOf(baseConfig({ mode: 'shadow' }), null, prompts, ring), null);
  assert.equal(refusalOf(baseConfig(), null, { ...prompts, 'memory/session': '' }, ring), CODES.NO_PROMPT);
  assert.deepEqual(memoryKeyState(baseConfig(), null, ring), { ok: true, name: 'memory-key' });
  assert.equal(sessionSettings({}).mode, 'off');
  assert.equal(sessionSettings({ memoryDb: { session: { mode: 'bogus' } } }).mode, 'off');
});

test('the request: the system text of a turn then the session prompt; blocks in the contract order; lines numbered, addressed and own lines marked', () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), kind: 'interest', text: 'likes café mornings' });
    env.claim({
      id: 'cl-self',
      subjectKind: 'self',
      subjectId: memoryIds.SELF_PERSON,
      kind: 'self_fact',
      text: 'keeps a small garden',
      scope: { scope_kind: 'none', scope_iface: null, scope_dm: null },
    });
    env.claim({
      id: 'cl-place',
      subjectKind: 'place',
      subjectId: guildPlaceOf(GUILD),
      kind: 'injoke',
      text: 'the soup incident',
    });
    env.claim({ id: 'cl-gone', subjectId: personOf(ADA), text: 'hidden one', shown: 0 });
    env.db
      .prepare(
        "INSERT INTO episodes (id, kind, subject_id, date, what, feeling, status, scope_kind, scope_iface) VALUES ('ep-1', 'profile', ?, '2026-10-10', 'Ada helped with the move', 'warm', 'open', 'group', 'discord')"
      )
      .run(personOf(ADA));
    env.db
      .prepare(
        "INSERT INTO intentions (id, record, status, scope_kind, scope_iface, archived) VALUES ('i1', ?, 'pending', 'group', 'discord', 0)"
      )
      .run(
        JSON.stringify({
          id: 'i1',
          status: 'pending',
          purpose: 'ask Ada about the move',
          provenance: { participants: [ADA] },
        })
      );
    const built = request(env);
    const [system, user] = built.messages;
    assert.equal(system.role, 'system');
    // The rules prompt goes in only with a rule in the memory table `rules`, and this memory holds none.
    assert.equal(system.content, 'SYSTEM Nep\n\nCARD Nep\n\nFORMAT\n\nSESSION Nep');
    assert.equal(user.role, 'user');
    const userText = textOf(user.content);
    const order = ['<self>', '<place>', '<people>', '<episodes>', '<intentions>', '<batch>'].map((tag) =>
      userText.indexOf(tag)
    );
    assert.ok(
      order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
      `blocks in order: ${String(order)}`
    );
    const batch = userText.slice(userText.indexOf('<batch>')).split('\n');
    assert.equal(batch[1], 'cutoff: 2026-10-24 11:00', 'the cutoff is stated at the top');
    assert.equal(
      batch[2],
      '#1 [2026-10-24 10:20] [p1] Ada: Καλημέρα, I like café mornings',
      'the account name, not the account id; the place handle of the line'
    );
    assert.equal(batch[3], '#2 [2026-10-24 10:30] [p1] Βασίλης: ναι, σωστά');
    assert.equal(
      batch[4],
      '→ #3 [2026-10-24 10:40] [p1] Ada: hey you there?',
      'addressed to the persona: led by an arrow'
    );
    assert.equal(
      batch[5],
      '#4 [2026-10-24 10:50] [p1] Nep (you): I am here',
      'the persona’s own line: their self label'
    );
    assert.equal(batch[6], '#5 [2026-10-24 11:00] [p1] Ada: I moved to Thessaloniki');
    // The ids the answer may use stand for database ids.
    const mapsSources = built.maps.sources;
    assert.equal(mapsSources.get('#1'), chat_ids(env).a);
    assert.equal(mapsSources.size, 5);
    const mapsClaims = built.maps.claims;
    const claimIds = [...mapsClaims.entries()];
    // A stored item of the session's request goes by a hash id.
    const hashId = /^k[0-9a-z]{4,}$/;
    assert.ok(
      claimIds.some(([label, id]) => hashId.test(label) && id === 'cl-self'),
      'the persona’s own claim goes by a hash id'
    );
    assert.ok(claimIds.some(([label, id]) => hashId.test(label) && id === 'cl-ada'));
    assert.ok(claimIds.some(([label, id]) => hashId.test(label) && id === 'cl-place'));
    assert.ok(!claimIds.some(([, id]) => id === 'cl-gone'), 'a claim that is not shown has no id in the request');
    // A stored item of the session's request goes by a hash id.
    const mapsEpisodes = built.maps.episodes;
    const episodeIds = [...mapsEpisodes.entries()];
    assert.deepEqual(
      episodeIds.map(([label, id]) => [hashId.test(label), id]),
      [[true, 'ep-1']]
    );
    const people = userText.slice(userText.indexOf('<people>'), userText.indexOf('</people>'));
    assert.match(people, /## Ada/);
    assert.match(people, /id: <@u-ada>/);
    assert.match(people, /affinity: 5/);
    // A stored item of the session's request goes by a hash id.
    assert.match(people, /\[k[0-9a-z]{4,}\] interest: likes café mornings/);
    assert.match(userText, /\[k[0-9a-z]{4,}\] 2026-10-10 Ada: Ada helped with the move \(warm\)/);
    assert.match(userText, /open|pending: ask Ada about the move|pending: ask Ada/);
    // The intended request difference of this slice: the top of the tree is named `server:` in `prompts/memory/session.md`.
    assert.match(userText, /<place>\nscope: group\n\[p1\] channel: general - chat\n\[p2\] server: Server/);
    const mapsPlaces = built.maps.places;
    assert.deepEqual(
      [...mapsPlaces.entries()],
      [
        ['p1', CHANNEL],
        ['p2', guildPlaceOf(GUILD)],
      ]
    );
  } finally {
    env.done();
  }
});

const chat_ids = (env: ReturnType<typeof semanticSessionFixture>) => ({ a: messageSourceOf('m1', 1, 'seen') });

test('the answer: a block after the thinking; a fence around it, a missing close tag and a thinking block with braces are read; the rest is refused by code', () => {
  assert.deepEqual(parseSessionAnswer(memoryBlock({ claims: [] })), { ok: true, value: { claims: [] } });
  assert.deepEqual(
    parseSessionAnswer(
      '<think>{"claims": [1]} <memory>{}</memory></think><memory>```json\n{"claims": []}\n```</memory>'
    ),
    { ok: true, value: { claims: [] } }
  );
  assert.equal(
    parseSessionAnswer('<memory>{"episodes": []}').ok,
    true,
    'cut off before the close tag, still whole JSON'
  );
  assert.deepEqual(parseSessionAnswer('<think>only thinking</think>'), { ok: false, code: 'no_block' });
  assert.deepEqual(parseSessionAnswer('<memory>{"claims": [</memory>'), { ok: false, code: 'bad_json' });
  assert.deepEqual(parseSessionAnswer('<memory>[1, 2]</memory>'), { ok: false, code: 'not_object' });
  assert.deepEqual(parseSessionAnswer(undefined), { ok: false, code: 'no_block' });
});

test('validation: ids map back to the database; what the request did not carry is dropped and counted, never guessed', () => {
  const env = semanticSessionFixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
    env.claim({
      id: 'cl-self',
      subjectKind: 'self',
      subjectId: memoryIds.SELF_PERSON,
      kind: 'self_fact',
      text: 'keeps a small garden',
    });
    const built = request(env);
    const check = (value: unknown) => validateAnswer(value, { maps: built.maps, people: built.people });
    const mapsClaims = built.maps.claims;
    const label = [...mapsClaims.entries()].find(([, id]) => id === 'cl-ada')![0];
    const selfLabel = [...mapsClaims.entries()].find(([, id]) => id === 'cl-self')![0];
    const { plan, counts } = check({
      claims: [
        {
          op: 'add',
          subject: 'Ada',
          kind: 'detail',
          text: 'moved to Thessaloniki',
          how: 'said',
          sources: ['#5'],
          when: '2026-10',
        },
        { op: 'add', subject: 'ada', kind: 'detail', text: 'same person by a folded name', how: 'saw', sources: [5] },
        { op: 'add', subject: 'place', place: 'p2', kind: 'injoke', text: 'a joke', how: 'saw', sources: ['#1'] },
        { op: 'add', subject: 'self', kind: 'self_fact', text: 'I answered a greeting', how: 'saw', sources: ['#4'] },
        { op: 'add', subject: personOf(BOB), kind: 'interest', text: 'Greek texts', how: 'inferred', sources: ['#2'] },
        { op: 'confirm', id: label, sources: ['#1'] },
        { op: 'revise', id: label, text: 'likes tea mornings', how: 'said', sources: ['#5'], reason: 'said so' },
        { op: 'retire', id: selfLabel, truth: 'disputed', reason: 'contradicted', sources: ['#3'] },
        // dropped
        { op: 'add', subject: 'Nobody', kind: 'detail', text: 'x', how: 'said', sources: ['#1'] },
        { op: 'add', subject: 'Ada', kind: 'mood', text: 'x', how: 'said', sources: ['#1'] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'dreamed', sources: ['#1'] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'said', sources: ['#42'] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'said', sources: [] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: '  ', how: 'said', sources: ['#1'] },
        { op: 'add', subject: 'place', place: 'p1', kind: 'injoke', text: 'x', how: 'saw', sources: ['#1', '#99'] },
        { op: 'add', subject: 'place', kind: 'injoke', text: 'x', how: 'saw', sources: ['#1'] },
        { op: 'add', subject: 'place', place: 'p9', kind: 'injoke', text: 'x', how: 'saw', sources: ['#1'] },
        { op: 'revise', id: label, text: 'x', how: 'said', sources: ['#1'] },
        { op: 'retire', id: label, truth: 'disputed', sources: ['#1'] },
        { op: 'confirm', id: 'c999', sources: ['#1'] },
        { op: 'confirm', id: 'cl-ada', sources: ['#1'] },
        { op: 'retire', id: label, truth: 'gone', sources: ['#1'] },
        { op: 'forget', id: label, sources: ['#1'] },
        'text',
      ],
      episodes: [
        { subject: 'Ada', what: 'helped with the move', feeling: 'warm', sources: ['#5'] },
        { subject: 'Ada', what: 'no source', sources: [] },
      ],
      affinity: [
        { person: 'Βασίλης', delta: 2.4, reason: 'kind', sources: ['#2'] },
        { person: 'Ada', delta: 0, sources: ['#1'] },
        { person: 'Ada', delta: 'up', sources: ['#1'] },
      ],
      descriptions: [
        { subject: 'Ada', field: 'character', why: 'new facts' },
        { subject: 'Ada', field: 'height', why: 'x' },
      ],
    });
    assert.deepEqual(
      plan.claims.map((claim) => [claim.op, claim.subjectKind, claim.subjectId]),
      [
        ['add', 'person', personOf(ADA)],
        ['add', 'person', personOf(ADA)],
        ['add', 'place', guildPlaceOf(GUILD)],
        ['add', 'self', memoryIds.SELF_PERSON],
        ['add', 'person', personOf(BOB)],
        ['confirm', undefined, undefined],
        ['revise', undefined, undefined],
        ['retire', undefined, undefined],
      ]
    );
    const firstClaim = plan.claims[0];
    assert.deepEqual(firstClaim.sources, [ids.e], 'a #n is the line it numbered');
    assert.equal(firstClaim.when, '2026-10');
    const thirdClaim = plan.claims[2];
    assert.deepEqual(thirdClaim.sources, [ids.a]);
    assert.equal(thirdClaim.subjectId, guildPlaceOf(GUILD), 'a place is the one the handle names');
    const sixthClaim = plan.claims[5];
    assert.equal(sixthClaim.id, 'cl-ada', 'cN back to the claim id');
    const eighthClaim = plan.claims[7];
    assert.equal(eighthClaim.id, 'cl-self');
    assert.deepEqual(plan.episodes, [
      { subjectId: personOf(ADA), what: 'helped with the move', feeling: 'warm', sources: [ids.e] },
    ]);
    assert.deepEqual(
      plan.affinity,
      [{ personId: personOf(BOB), delta: 2, reason: 'kind', sources: [ids.b] }],
      'a name resolves, the delta is whole'
    );
    assert.deepEqual(plan.descriptions, [
      { subjectKind: 'person', subjectId: personOf(ADA), field: 'character', why: 'new facts' },
    ]);
    assert.equal(counts.kept, 8 + 1 + 1 + 1);
    assert.deepEqual(counts.dropped, {
      unknown_source: 2,
      unknown_subject: 1,
      bad_kind: 1,
      bad_how: 1,
      no_sources: 2,
      no_text: 1,
      unknown_id: 2,
      bad_truth: 1,
      bad_op: 2,
      bad_delta: 2,
      bad_field: 1,
      no_place: 1,
      unknown_place: 1,
      no_reason: 2,
    });
    // An op with one unknown source among known ones is dropped whole, never kept with part of its evidence.
    assert.equal(
      check({ claims: [{ op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'said', sources: ['#1', '#99'] }] })
        .plan.claims.length,
      0
    );
    // A reason is required for a revision, a retirement, an attitude change and a description flag.
    assert.deepEqual(
      check({
        affinity: [{ person: 'Ada', delta: 1, sources: ['#1'] }],
        descriptions: [{ subject: 'Ada', field: 'character' }],
      }).counts.dropped,
      { no_reason: 2 }
    );
    // a part that is not a list; two people with one name
    assert.deepEqual(check({ claims: 'x', episodes: {} }).counts.dropped, { claims_not_list: 1, episodes_not_list: 1 });
    env.db.prepare('UPDATE accounts SET names = ? WHERE id = ?').run(JSON.stringify(['Ada']), `discord:${BOB}`);
    const twin = request(env);
    const result = validateAnswer(
      { episodes: [{ subject: 'Ada', what: 'x', sources: ['#1'] }] },
      { maps: twin.maps, people: twin.people }
    );
    assert.deepEqual(result.counts.dropped, { unknown_subject: 1 }, 'a name two people share names no one');
    assert.equal(
      validateAnswer(
        { claims: [{ op: 'add', subject: 'place', kind: 'detail', text: 'x', how: 'said', sources: ['#1'] }] },
        { maps: twin.maps, people: twin.people }
      ).counts.dropped.no_place,
      1,
      'a place proposal names its place; there is no first-place default'
    );
  } finally {
    env.done();
  }
});

test('a shadow sweep: one request on the memory role, every proposal a decisions row, one session_runs row, the cursor moved, nothing else touched', async () => {
  const env = semanticSessionFixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
    const label = () => [...request(env).maps.claims.entries()].find(([, id]) => id === 'cl-ada')![0];
    const llm = fakeLlm(() =>
      memoryBlock({
        claims: [
          { op: 'add', subject: 'Ada', kind: 'detail', text: 'moved to Thessaloniki', how: 'said', sources: ['#5'] },
          { op: 'confirm', id: label(), sources: ['#1'] },
          { op: 'confirm', id: 'c77', sources: ['#1'] },
        ],
        episodes: [{ subject: 'Ada', what: 'greeted me', feeling: 'glad', sources: ['#1'] }],
        affinity: [{ person: 'Ada', delta: 2, reason: 'friendly', sources: ['#3'] }],
        descriptions: [{ subject: 'Ada', field: 'character', why: 'new facts' }],
      })
    );
    const before = {
      claims: count(env.db, 'claims'),
      versions: count(env.db, 'claim_versions'),
      episodes: count(env.db, 'episodes'),
      events: count(env.db, 'affinity_events'),
    };
    const result = await sweep(ctxOf(env, { llm }));
    assert.equal(result.status, 'ok');
    assert.equal(result.runs.length, 1);
    const firstRun = result.runs[0];
    assert.equal(firstRun.outcome, 'ok');
    // the request
    assert.equal(llm.calls.length, 1);
    const { options, messages } = llm.calls[0];
    assert.equal(options.role, 'memory');
    assert.equal(options.purpose, 'memory-session');
    assert.equal(options.model, 'x/memory');
    assert.equal(Object.hasOwn(options, 'reasoning'), false, 'provider reasoning stays off');
    assert.equal(messages.length, 2);
    // the writes
    const decisions = env.db
      .prepare('SELECT by, action, target_kind, target_id, extra FROM decisions ORDER BY id')
      .all();
    assert.equal(decisions.length, 5);
    assert.ok(decisions.every((row) => row.by === 'her'));
    assert.deepEqual(decisions.map((row) => row.action).sort(), [
      'proposed:add',
      'proposed:affinity',
      'proposed:confirm',
      'proposed:description',
      'proposed:episode',
    ]);
    const add = decisions.find((row) => row.action === 'proposed:add');
    assert.equal(JSON.parse(add!.extra as string).op.text, 'moved to Thessaloniki', 'the whole op rides in extra');
    assert.deepEqual(JSON.parse(add!.extra as string).op.sources, [ids.e]);
    assert.equal(decisions.find((row) => row.action === 'proposed:confirm')!.target_id, 'cl-ada');
    assert.deepEqual(
      {
        claims: count(env.db, 'claims'),
        versions: count(env.db, 'claim_versions'),
        episodes: count(env.db, 'episodes'),
        events: count(env.db, 'affinity_events'),
      },
      before,
      'shadow touches no claim, episode or attitude'
    );
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity, 5);
    const run = env.db.prepare('SELECT * FROM session_runs').get();
    assert.equal(run!.mode, 'shadow');
    assert.equal(run!.scope_key, 'group:discord');
    assert.equal(run!.scope_kind, 'group');
    assert.equal(run!.sources_n, 5);
    assert.equal(run!.tokens_prompt, 1000);
    assert.equal(run!.tokens_completion, 50);
    assert.equal(run!.model, 'x/memory');
    assert.equal(run!.outcome, 'ok');
    assert.equal(run!.cursor_from, 0);
    assert.ok((run!.cursor_to as number) > 0);
    const counts = JSON.parse(run!.counts as string);
    assert.equal(counts.claims, 2);
    assert.deepEqual(counts.dropped, { unknown_id: 1 });
    assert.equal(
      env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('shadow', 'group:discord'))!.value,
      String(run!.cursor_to)
    );
    // a second sweep finds nothing new: no request
    const again = await sweep(ctxOf(env, { llm }), { ignoreSweepCap: true });
    assert.deepEqual(
      again.runs.map((entry) => entry.outcome),
      ['quiet']
    );
    assert.equal(llm.calls.length, 1);
    // new lines are read from the cursor on, and only them
    env.say({ native: 'm6', minutesAgo: 30, text: 'a later line' });
    const third = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }), { ignoreSweepCap: true });
    const runsFirstRun = third.runs[0];
    assert.equal(runsFirstRun.lines, 1);
  } finally {
    env.done();
  }
});

test('an answer that cannot be read leaves the cursor and writes only its run; a failed request the same; a partial answer keeps what holds', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const bad = await sweep(ctxOf(env, { llm: fakeLlm('I think nothing') }));
    const firstRun = bad.runs[0];
    assert.equal(firstRun.outcome, 'bad_answer');
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 0, 'the lines stay for the next sweep');
    assert.equal(env.db.prepare('SELECT outcome, errors FROM session_runs').get()!.outcome, 'bad_answer');
    assert.deepEqual(JSON.parse(env.db.prepare('SELECT errors FROM session_runs').get()!.errors as string), [
      'no_block',
    ]);
    const down = await sweep(ctxOf(env, { llm: fakeLlm(Object.assign(new Error('boom'), { code: 'ECONNRESET' })) }), {
      ignoreSweepCap: true,
    });
    const runsFirstRun = down.runs[0];
    assert.equal(runsFirstRun.outcome, 'llm_error');
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 0);
    const partial = await sweep(
      ctxOf(env, {
        llm: fakeLlm(
          memoryBlock({
            claims: [
              { op: 'add', subject: 'Ada', kind: 'detail', text: 'ok', how: 'said', sources: ['#1'] },
              { nonsense: true },
            ],
            episodes: 'no',
          })
        ),
      }),
      { ignoreSweepCap: true }
    );
    const partialFirstRun = partial.runs[0];
    assert.equal(partialFirstRun.outcome, 'ok');
    assert.equal(count(env.db, 'decisions'), 1);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 1);
    assert.deepEqual(
      JSON.parse(env.db.prepare("SELECT counts FROM session_runs WHERE outcome = 'ok'").get()!.counts as string)
        .dropped,
      { bad_op: 1, episodes_not_list: 1 }
    );
  } finally {
    env.done();
  }
});

test('refused before any request: off, no key of its own, the daily sweep cap', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const llm = fakeLlm(memoryBlock({}));
    const off = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'off' }) }));
    assert.deepEqual([off.status, off.code], ['off', 'off']);
    const keyless = await sweep(ctxOf(env, { llm, ring: null }));
    assert.deepEqual([keyless.status, keyless.code], ['refused', 'not_configured'], 'another key never stands in');
    assert.equal(llm.calls.length, 0);
    assert.equal(count(env.db, 'session_runs'), 0);
    const config = baseConfig({ sweepsPerDay: 1 });
    await sweep(ctxOf(env, { llm, config }));
    env.say({ native: 'm9', minutesAgo: 20, text: 'more' });
    const capped = await sweep(ctxOf(env, { llm, config }));
    assert.deepEqual([capped.status, capped.code], ['refused', 'sweep_cap']);
    assert.equal(llm.calls.length, 1);
    // a request refused by the client for want of the key is the same state, and writes its run
    const noKey = fakeLlm(Object.assign(new Error('no key'), { code: 'ROLE_KEY_MISSING' }));
    const env2 = semanticSessionFixture();
    try {
      chat(env2);
      const refused = await sweep(ctxOf(env2, { llm: noKey }));
      const firstRun = refused.runs[0];
      assert.equal(firstRun.outcome, 'not_configured');
    } finally {
      env2.done();
    }
  } finally {
    env.done();
  }
});

test('a scope with too few lines waits; lines still settling are left; a deleted or edited line is read once, as it stands', async () => {
  const env = semanticSessionFixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'first' });
    env.say({ native: 'm2', minutesAgo: 90, text: 'second', revision: 1 });
    env.say({ native: 'm2', minutesAgo: 89, text: 'second, edited', revision: 2 });
    env.say({ native: 'm3', minutesAgo: 80, text: 'to be deleted' });
    env.db
      .prepare(
        "INSERT INTO sources (id, kind, iface, native_id, place_id, occurred_at, scope_kind, scope_iface) VALUES ('src:discord:m3:none:deleted:x', 'deleted', 'discord', 'm3', ?, ?, 'group', 'discord')"
      )
      .run(CHANNEL, new Date(HASH_IDS_NOW - 70 * MINUTE).toISOString());
    env.say({ native: 'm4', minutesAgo: 5, text: 'still settling' });
    const scopeEntry = scopesOf(env.db)[0];
    const batch = batchOf(env.db, scopeEntry.scope, {
      cursor: 0,
      since: null,
      maxMessages: 200,
      settleBefore: HASH_IDS_NOW - 10 * MINUTE,
    });
    assert.deepEqual(
      batch.map((line) => line.text),
      ['first', 'second, edited']
    );
    assert.deepEqual(
      batchOf(env.db, scopeEntry.scope, { cursor: 0, since: null, maxMessages: 1, settleBefore: HASH_IDS_NOW }).map(
        (line) => line.text
      ),
      ['first']
    );
    assert.deepEqual(
      batchOf(env.db, scopeEntry.scope, {
        cursor: 0,
        since: new Date(HASH_IDS_NOW - 95 * MINUTE).toISOString(),
        maxMessages: 200,
        settleBefore: HASH_IDS_NOW,
      }).map((line) => line.text),
      ['second, edited', 'still settling']
    );
    const llm = fakeLlm(memoryBlock({}));
    const quiet = await sweep(ctxOf(env, { llm, config: baseConfig({ minMessages: 3 }) }));
    assert.deepEqual(
      quiet.runs.map((entry) => [entry.outcome, entry.lines]),
      [['quiet', 2]]
    );
    assert.equal(llm.calls.length, 0);
  } finally {
    env.done();
  }
});

test('private chats are scopes of their own: one request each, the partner only, its cursor apart from the group', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
    env.say({ native: 'd1', minutesAgo: 50, text: 'a private word', scope: dm, place: dmPlaceOf(ADA), direct: 1 });
    env.say({ native: 'd2', minutesAgo: 45, text: 'private reply', scope: dm, place: dmPlaceOf(ADA), kind: 'said' });
    env.claim({ id: 'cl-dm', subjectId: personOf(ADA), text: 'only in private', scope: dm });
    env.claim({ id: 'cl-pub', subjectId: personOf(ADA), text: 'public one' });
    // The DM is a stored place and its lines carry its audience: the sweep finds a DM through that place, never one
    // spelled from the partner's id. The scope's key and cursor are the place's.
    env.db
      .prepare(
        "INSERT INTO places (id, iface, kind, chat, scope_kind, partner_account, partner_person) VALUES (?, 'discord', 'dm', 'dm', 'dm', ?, ?)"
      )
      .run(dmPlaceOf(ADA), `discord:${ADA}`, personOf(ADA));
    fillEnvAudiences(env);
    assert.deepEqual(
      scopesOf(env.db).map((scope) => scope.key),
      [`dm:discord:${dmPlaceOf(ADA)}`, 'group:discord']
    );
    const llm = fakeLlm(memoryBlock({}));
    const result = await sweep(ctxOf(env, { llm }));
    assert.equal(result.runs.length, 2);
    assert.equal(llm.calls.length, 2);
    const [dmCall, groupCall] = llm.calls.map(({ messages }) => textOf(messages[1].content));
    assert.match(dmCall, /private word/);
    assert.doesNotMatch(dmCall, /Thessaloniki/, 'the group lines are not in the private request');
    assert.match(dmCall, /only in private/);
    assert.match(dmCall, /public one/, 'a private request may read the public claims');
    assert.doesNotMatch(
      groupCall,
      /private word|only in private/,
      'the group request never carries a private line or claim'
    );
    assert.match(groupCall, /public one/);
    const keys = env.db
      .prepare("SELECT key FROM meta WHERE key LIKE 'memory_session.cursor.%' ORDER BY key")
      .all()
      .map((row) => row.key);
    assert.deepEqual(keys, [cursorKey('shadow', `dm:discord:${dmPlaceOf(ADA)}`), cursorKey('shadow', 'group:discord')]);
    assert.equal(llm.calls.length, 2);
    const only = await sweep(ctxOf(env, { llm }), { scope: 'group:discord', ignoreSweepCap: true });
    assert.equal(only.runs.length, 1);
  } finally {
    env.done();
  }
});

test('apply: claims with versions and sources, episodes, attitude, decisions; disputed stays shown, retired leaves', async () => {
  const env = semanticSessionFixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
    env.claim({ id: 'cl-old', subjectId: personOf(ADA), kind: 'detail', text: 'lives in Athens' });
    env.claim({ id: 'cl-gone', subjectId: personOf(ADA), kind: 'detail', text: 'plays chess' });
    env.claim({ id: 'cl-fresh', subjectId: personOf(ADA), kind: 'detail', text: 'owns a bicycle' });
    const labelOf = (id: string) => [...request(env).maps.claims.entries()].find(([, value]) => value === id)![0];
    const llm = fakeLlm(() =>
      memoryBlock({
        claims: [
          {
            op: 'add',
            subject: 'Ada',
            kind: 'detail',
            text: 'lives in Thessaloniki',
            how: 'said',
            sources: ['#5'],
            when: '2026-10',
          },
          { op: 'confirm', id: labelOf('cl-ada'), sources: ['#1'] },
          {
            op: 'revise',
            id: labelOf('cl-old'),
            text: 'moved from Athens',
            how: 'said',
            sources: ['#5'],
            reason: 'she said so',
          },
          { op: 'retire', id: labelOf('cl-gone'), truth: 'historical', reason: 'stopped', sources: ['#3'] },
        ],
        episodes: [{ subject: 'Ada', what: 'told me about the move', feeling: 'glad', sources: ['#5'] }],
        affinity: [{ person: 'Ada', delta: 40, reason: 'a warm talk', sources: ['#1'] }],
        descriptions: [{ subject: 'Ada', field: 'character', why: 'new facts' }],
      })
    );
    const config = baseConfig({ mode: 'apply' });
    const result = await sweep(ctxOf(env, { llm, config }));
    const firstRun = result.runs[0];
    assert.equal(firstRun.outcome, 'ok');
    const added = env.db.prepare("SELECT * FROM claims WHERE author = 'her'").get();
    assert.equal(added!.text, 'lives in Thessaloniki');
    assert.equal(added!.subject_kind, 'person');
    assert.equal(added!.subject_id, personOf(ADA));
    assert.deepEqual(
      [added!.how, added!.truth, added!.shown, added!.scope_kind, added!.scope_iface],
      ['said', 'current', 1, 'group', 'discord']
    );
    assert.deepEqual(
      env.db
        .prepare('SELECT source_id FROM claim_sources WHERE claim_id = ?')
        .all(added!.id)
        .map((row) => row.source_id),
      [ids.e]
    );
    assert.deepEqual(
      env.db
        .prepare('SELECT event, by, origin FROM claim_versions WHERE claim_id = ?')
        .all(added!.id)
        .map((row) => [row.event, row.by, row.origin]),
      [['add', 'her', 'session']]
    );
    const confirmed = env.db.prepare("SELECT last_seen_at FROM claims WHERE id = 'cl-ada'").get();
    assert.match(confirmed!.last_seen_at as string, /^2026-10-24T12:\d\d:\d\d\.000Z$/);
    assert.deepEqual(
      env.db
        .prepare("SELECT source_id FROM claim_sources WHERE claim_id = 'cl-ada'")
        .all()
        .map((row) => row.source_id),
      [ids.a]
    );
    const revised = env.db.prepare("SELECT text, how FROM claims WHERE id = 'cl-old'").get();
    assert.deepEqual([revised!.text, revised!.how], ['moved from Athens', 'said']);
    assert.equal(
      JSON.parse(env.db.prepare("SELECT extra FROM claim_versions WHERE claim_id = 'cl-old'").get()!.extra as string)
        .before,
      'lives in Athens'
    );
    const retired = env.db.prepare("SELECT truth, shown, valid_to FROM claims WHERE id = 'cl-gone'").get();
    assert.deepEqual([retired!.truth, retired!.shown], ['historical', 0]);
    assert.ok(retired!.valid_to);
    const episode = env.db.prepare('SELECT * FROM episodes').get();
    assert.deepEqual(
      [episode!.subject_id, episode!.what, episode!.feeling, episode!.kind, episode!.scope_kind],
      [personOf(ADA), 'told me about the move', 'glad', 'session', 'group']
    );
    assert.deepEqual(
      env.db
        .prepare('SELECT source_id FROM episode_sources WHERE episode_id = ?')
        .all(episode!.id)
        .map((row) => row.source_id),
      [ids.e]
    );
    const event = env.db.prepare('SELECT delta, applied, score FROM affinity_events').get();
    assert.deepEqual(
      [event!.delta, event!.applied, event!.score],
      [40, 15, 20], // The cap is the constant RELATIONSHIP_LIMITS.maxDeltaPerUpdate, 15.
      'the step is capped by relationships.maxDeltaPerUpdate'
    );
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity, 20);
    const actions = env.db
      .prepare('SELECT action FROM decisions ORDER BY id')
      .all()
      .map((row) => row.action)
      .sort();
    assert.deepEqual(actions, ['add', 'affinity', 'confirm', 'episode', 'flag:description', 'retire', 'revise']);
    assert.equal(count(env.db, 'decisions', "action LIKE 'proposed:%'"), 0);
    // a second answer: dispute keeps the claim shown; an id that has since left is counted, not written
    env.say({ native: 'm7', minutesAgo: 20, text: 'no, I never played chess' });
    // (a claim the first answer touched is newer than the second batch's cutoff and is not in the request; this one is untouched)
    const disputed = [...request(env).maps.claims.entries()].find(([, id]) => id === 'cl-fresh');
    const second = await sweep(
      ctxOf(env, {
        llm: fakeLlm(
          memoryBlock({
            claims: [{ op: 'retire', id: disputed![0], truth: 'disputed', reason: 'contradicted', sources: ['#1'] }],
          })
        ),
        config,
      }),
      { ignoreSweepCap: true }
    );
    const runsFirstRun = second.runs[0];
    assert.equal(runsFirstRun.outcome, 'ok');
    assert.deepEqual(Object.values(env.db.prepare("SELECT truth, shown FROM claims WHERE id = 'cl-fresh'").get()!), [
      'disputed',
      1,
    ]);
  } finally {
    env.done();
  }
});

test('the people block renders a stored profile the way the persona’s turns do, from the database alone', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-session-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const { seedUnits } = await import('../../../fixtures/memory-db/seed.ts');
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  try {
    assert.equal(seedUnits(handle, data).errors, 0);
    const scopeEntry = scopesOf(dbOf(handle)).find((entry) => entry.key === 'group:discord');
    assert.ok(scopeEntry, 'the stored record has a group scope');
    const batch = batchOf(dbOf(handle), scopeEntry.scope, {
      cursor: 0,
      since: null,
      maxMessages: 50,
      settleBefore: Date.parse('2027-01-01'),
    });
    assert.ok(batch.length >= 2);
    const built = buildSessionRequest({
      db: dbOf(handle),
      scope: scopeEntry,
      batch,
      config: baseConfig(),
      prompts,
      selfName: 'Nep',
      now: HASH_IDS_NOW,
    });
    // A profile whose rows are all retired holds nothing: it is not rendered.
    const retire = (at: string | null) => {
      for (const table of ['accounts', 'people'])
        dbOf(handle)
          .prepare(`UPDATE "${table}" SET retired_at = ? WHERE writer = 'profile' AND holder_id LIKE ?`)
          .run(at, `%${MEMBER}`);
    };
    retire('2026-10-24T00:00:00.000Z');
    const withoutFile = buildSessionRequest({
      db: dbOf(handle),
      scope: scopeEntry,
      batch,
      config: baseConfig(),
      prompts,
      selfName: 'Nep',
      now: HASH_IDS_NOW,
    });
    const secondMessage = withoutFile.messages[1];
    const builtSecondMessage = built.messages[1];
    assert.ok(
      textOf(secondMessage.content).length < textOf(builtSecondMessage.content).length,
      'the profile of a file that is gone is left out'
    );
    retire(null);
    const messagesSecondMessage = built.messages[1];
    const people = textOf(messagesSecondMessage.content);
    const stored = JSON.parse(
      fs.readFileSync(path.join(data, 'guilds', '300000000000000001', 'users', `${MEMBER}.json`), 'utf8')
    );
    assert.ok(built.people.some((person) => person.native === MEMBER));
    const firstName = stored.names[0];
    assert.match(people, new RegExp(`## ${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(people, new RegExp(`id: <@${MEMBER}>`));
  } finally {
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- before any `apply`: modes, idempotent runs, evidence, batches, stored answers ----------

const SESSION_GROUP = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }; // what a session write answers: the counts the tests read

test('an all_dropped answer leaves the cursor and the batch pending; after retryLimit tries it is skipped with a recorded decision', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const config = baseConfig({ retryLimit: 2 });
    const llm = fakeLlm(
      memoryBlock({
        claims: [{ op: 'add', subject: 'Nobody', kind: 'detail', text: 'x', how: 'said', sources: ['#1'] }],
      })
    );
    const cursor = cursorKey('shadow', 'group:discord');
    const first = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    const firstRun = first.runs[0];
    assert.equal(firstRun.outcome, 'all_dropped');
    assert.equal(
      env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor),
      undefined,
      'the cursor did not move'
    );
    const second = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    const runsFirstRun = second.runs[0];
    assert.equal(runsFirstRun.outcome, 'all_dropped');
    assert.equal(llm.calls.length, 2);
    const third = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.deepEqual(
      third.runs.map((run) => run.outcome),
      ['skipped']
    );
    assert.equal(llm.calls.length, 2, 'a skipped batch costs no request');
    assert.ok(
      Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor)!.value) > 0,
      'the cursor moved past it'
    );
    const decision = env.db
      .prepare("SELECT by, action, extra FROM decisions WHERE action = 'skipped:all_dropped'")
      .get();
    assert.equal(decision!.by, 'engine');
    assert.equal(JSON.parse(decision!.extra as string).tries, 2);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.pending.%'"), 0);
  } finally {
    env.done();
  }
});

test('a write that failed is never an ok run: the cursor stays, the error is in the result', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const down = async () => {
      throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    };
    const result = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})), write: down }));
    const firstRun = result.runs[0];
    assert.equal(firstRun.outcome, 'write_failed');
    assert.deepEqual(firstRun.errors, ['write:SQLITE_BUSY']);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 0);
    const retried = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }), { ignoreSweepCap: true });
    const runsFirstRun = retried.runs[0];
    assert.equal(runsFirstRun.outcome, 'ok', 'the next sweep reads the same lines');
  } finally {
    env.done();
  }
});

test('batches are read in event time and each line names its place; the cursor still follows arrival', async () => {
  const env = semanticSessionFixture();
  try {
    db_second_channel(env);
    env.say({ native: 'm1', minutesAgo: 50, text: 'later line' });
    env.say({ native: 'm2', minutesAgo: 90, text: 'earlier line, stored second', place: SECOND });
    env.say({ native: 'm3', minutesAgo: 70, text: 'middle line' });
    const scopeEntry = scopesOf(env.db)[0];
    const batch = batchOf(env.db, scopeEntry.scope, {
      cursor: 0,
      since: null,
      maxMessages: 200,
      settleBefore: HASH_IDS_NOW,
    });
    assert.deepEqual(
      batch.map((line) => line.text),
      ['earlier line, stored second', 'middle line', 'later line'],
      'occurred_at first, then arrival'
    );
    // the first `maxMessages` by arrival are the batch (no line is skipped by the cursor), shown in event time
    assert.deepEqual(
      batchOf(env.db, scopeEntry.scope, { cursor: 0, since: null, maxMessages: 2, settleBefore: HASH_IDS_NOW }).map(
        (line) => line.text
      ),
      ['earlier line, stored second', 'later line']
    );
    const built = buildSessionRequest({
      db: env.db,
      scope: scopeEntry,
      batch,
      config: baseConfig(),
      prompts,
      selfName: 'Nep',
      now: HASH_IDS_NOW,
    });
    const secondMessage = built.messages[1];
    const builtText = textOf(secondMessage.content);
    const lines = builtText.slice(builtText.indexOf('<batch>')).split('\n');
    assert.match(lines[2], /^#1 \[2026-10-24 10:30\] \[p1\] Ada: earlier line/);
    assert.match(lines[3], /^#2 \[2026-10-24 10:50\] \[p2\] Ada: middle line/);
    assert.match(lines[4], /^#3 \[2026-10-24 11:10\] \[p2\] Ada: later line/);
    assert.match(
      textOf(secondMessage.content),
      /\[p1\] channel: second\n\[p2\] channel: general - chat\n\[p3\] server: Server/
    );
    const result = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }));
    const firstRun = result.runs[0];
    assert.equal(firstRun.outcome, 'ok');
    const run = env.db.prepare('SELECT cursor_to FROM session_runs').get();
    assert.equal(
      run!.cursor_to,
      Math.max(...batch.map((line) => line.rowid)),
      'the cursor is the newest arrival, not the newest event'
    );
  } finally {
    env.done();
  }
});

const SECOND = channelPlaceOf('c2');
function db_second_channel(env: ReturnType<typeof semanticSessionFixture>) {
  env.db
    .prepare(
      "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'channel', 'c2', ?, 'group', 'second', NULL)"
    )
    .run(SECOND, guildPlaceOf(GUILD));
}

test('every person of a batch is a subject: the people are paged over requests of the same batch, the cursor moves after the last', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const config = baseConfig({ maxPeople: 1 });
    const answers = [
      memoryBlock({
        claims: [
          { op: 'add', subject: 'Ada', kind: 'detail', text: 'first page fact', how: 'said', sources: ['#1'] },
          { op: 'add', subject: 'Βασίλης', kind: 'detail', text: 'not on this page', how: 'said', sources: ['#2'] },
        ],
      }),
      memoryBlock({
        claims: [
          { op: 'add', subject: 'Βασίλης', kind: 'detail', text: 'second page fact', how: 'said', sources: ['#2'] },
        ],
      }),
    ];
    const llm = fakeLlm(answers);
    const result = await sweep(ctxOf(env, { llm, config }));
    assert.deepEqual(
      result.runs.map((run) => [run.outcome, run.page]),
      [
        ['ok', 0],
        ['ok', 1],
      ]
    );
    assert.equal(llm.calls.length, 2);
    const [one, two] = llm.calls.map(({ messages }) => textOf(messages[1].content));
    assert.match(one, /id: <@u-ada>/);
    assert.doesNotMatch(one, /id: <@u-bob>/);
    assert.match(two, /id: <@u-bob>/);
    assert.doesNotMatch(two, /id: <@u-ada>/);
    // The block `<batch>` alone: `<stretches>` after it stands on the batch's first request only, so that a stretch
    // gets one sentence however many pages its batch takes.
    const batchOf2 = (text: string) => text.slice(text.indexOf('<batch>'), text.indexOf('</batch>'));
    assert.equal(batchOf2(one), batchOf2(two), 'the same lines in each request');
    assert.ok(
      one.includes('<stretches>') && !two.includes('<stretches>'),
      'the persona’s stretch is listed on the first page'
    );
    assert.deepEqual(
      env.db
        .prepare('SELECT action FROM decisions ORDER BY id')
        .all()
        .map((row) => row.action),
      ['proposed:add', 'proposed:add'],
      "Ada's page keeps her claim; the claim about Bob on her page was dropped; Bob's page keeps his"
    );
    assert.equal(count(env.db, 'session_runs'), 2);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 1, 'one cursor for the batch');
  } finally {
    env.done();
  }
});

test('apply over pages: a page applied before is not asked again, and the cursor moves once every page is in', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const config = baseConfig({ mode: 'apply', maxPeople: 1 });
    const cursor = cursorKey('apply', 'group:discord');
    const page = (subject: string, text: string, ref: string) =>
      memoryBlock({
        claims: [{ op: 'add', subject, kind: 'detail', text, how: 'said', sources: [ref] }],
        affinity: [{ person: subject, delta: 2, reason: 'kind', sources: [ref] }],
      });
    const broken = fakeLlm([page('Ada', 'ada fact', '#1'), Object.assign(new Error('boom'), { code: 'ECONNRESET' })]);
    const first = await sweep(ctxOf(env, { llm: broken, config }));
    assert.deepEqual(
      first.runs.map((run) => run.outcome),
      ['ok', 'llm_error']
    );
    assert.equal(
      env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor),
      undefined,
      'a page is missing: the cursor stays'
    );
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity, 7);
    const llm = fakeLlm([page('Βασίλης', 'bob fact', '#2')]);
    const second = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.deepEqual(
      second.runs.map((run) => run.outcome),
      ['applied_before', 'ok']
    );
    assert.equal(llm.calls.length, 1, 'only the missing page is asked');
    assert.ok(Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor)!.value) > 0);
    assert.equal(
      env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity,
      7,
      'the first page was not applied again'
    );
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(BOB))!.affinity, 2);
    assert.equal(count(env.db, 'claims', "author = 'her'"), 2);
    // when the last page is the one applied before, the cursor still moves
    const env2 = semanticSessionFixture();
    try {
      chat(env2);
      const lastOnly = fakeLlm([
        Object.assign(new Error('boom'), { code: 'ECONNRESET' }),
        page('Βασίλης', 'bob fact', '#2'),
      ]);
      const a = await sweep(ctxOf(env2, { llm: lastOnly, config }));
      assert.deepEqual(
        a.runs.map((run) => run.outcome),
        ['llm_error', 'ok']
      );
      assert.equal(env2.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor), undefined);
      const b = await sweep(ctxOf(env2, { llm: fakeLlm([page('Ada', 'ada fact', '#1')]), config }), {
        ignoreSweepCap: true,
      });
      assert.deepEqual(
        b.runs.map((run) => run.outcome),
        ['ok', 'applied_before']
      );
      assert.ok(Number(env2.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor)!.value) > 0);
    } finally {
      env2.done();
    }
  } finally {
    env.done();
  }
});

test('the context is as of the batch cutoff: claims and episodes created or seen after it are left out', () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    env.claim({ id: 'cl-old', subjectId: personOf(ADA), text: 'known before the batch ended' });
    env.claim({ id: 'cl-new', subjectId: personOf(ADA), text: 'created after the cutoff' });
    env.claim({ id: 'cl-seen', subjectId: personOf(ADA), text: 'seen again after the cutoff' });
    env.claim({
      id: 'cl-self-new',
      subjectKind: 'self',
      subjectId: memoryIds.SELF_PERSON,
      kind: 'self_fact',
      text: 'a later self fact',
    });
    env.db
      .prepare(
        "UPDATE claims SET created_at = '2026-10-24T11:30:00.000Z', last_seen_at = '2026-10-24T11:30:00.000Z' WHERE id IN ('cl-new', 'cl-self-new')"
      )
      .run();
    env.db
      .prepare(
        "UPDATE claims SET created_at = '2026-10-01T00:00:00.000Z', last_seen_at = '2026-10-24T11:45:00.000Z' WHERE id = 'cl-seen'"
      )
      .run();
    env.db
      .prepare(
        "UPDATE claims SET created_at = '2026-10-01T00:00:00.000Z', last_seen_at = '2026-10-24T10:00:00.000Z' WHERE id = 'cl-old'"
      )
      .run();
    env.db
      .prepare(
        "INSERT INTO episodes (id, kind, subject_id, date, what, status, scope_kind, scope_iface, created_at) VALUES ('ep-old', 'profile', ?, '2026-10-10', 'before', 'open', 'group', 'discord', '2026-10-10T00:00:00.000Z')"
      )
      .run(personOf(ADA));
    env.db
      .prepare(
        "INSERT INTO episodes (id, kind, subject_id, date, what, status, scope_kind, scope_iface, created_at) VALUES ('ep-new', 'profile', ?, '2026-10-24', 'after', 'open', 'group', 'discord', '2026-10-24T11:40:00.000Z')"
      )
      .run(personOf(ADA));
    const built = request(env);
    const mapsClaims = built.maps.claims;
    const claimed = [...mapsClaims.values()];
    assert.ok(claimed.includes('cl-old'));
    for (const id of ['cl-new', 'cl-seen', 'cl-self-new'])
      assert.ok(!claimed.includes(id), `${id} is after the cutoff`);
    const mapsEpisodes = built.maps.episodes;
    assert.deepEqual([...mapsEpisodes.values()], ['ep-old']);
    assert.equal(built.cutoff, Date.parse('2026-10-24T11:00:00.000Z'));
  } finally {
    env.done();
  }
});

test('the persona’s whole answer, thinking included, is a source of kind memory_session, scope internal, that no reader of a group sees', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({ episodes: [] })) }));
    const stored = env.db.prepare("SELECT * FROM sources WHERE kind = 'memory_session'").all();
    assert.equal(stored.length, 1);
    assert.deepEqual([stored[0].scope_kind, stored[0].scope_iface, stored[0].scope_dm], ['internal', null, null]);
    assert.match(stored[0].text as string, /^<think>reading<\/think>/);
    assert.equal(stored[0].think, 'reading');
    assert.equal(env.db.prepare('SELECT answer_source FROM session_runs').get()!.answer_source, stored[0].id);
    const group = whereFor(groupContext('discord'), 's');
    assert.equal(
      env.db
        .prepare(`SELECT COUNT(*) AS n FROM sources s WHERE s.kind = 'memory_session' AND ${group.sql}`)
        .get(...group.params)!.n,
      0
    );
    // an unreadable answer is kept as well
    await sweep(ctxOf(env, { llm: fakeLlm('<think>hm</think> nothing parseable') }), { ignoreSweepCap: true });
    env.say({ native: 'm9', minutesAgo: 20, text: 'one more line' });
    const bad = await sweep(ctxOf(env, { llm: fakeLlm('<think>hm</think> nothing parseable') }), {
      ignoreSweepCap: true,
    });
    const firstRun = bad.runs[0];
    assert.equal(firstRun.outcome, 'bad_answer');
    assert.equal(count(env.db, 'sources', "kind = 'memory_session'"), 2);
  } finally {
    env.done();
  }
});

test('a batch retried from the same cursor keeps its lines: lines that settled since do not widen it, so an applied page is not applied again', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const config = baseConfig({ mode: 'apply', maxPeople: 1 });
    const cursor = cursorKey('apply', 'group:discord');
    const page = (subject: string, text: string, ref: string) =>
      memoryBlock({
        claims: [{ op: 'add', subject, kind: 'detail', text, how: 'said', sources: [ref] }],
        affinity: [{ person: subject, delta: 2, reason: 'kind', sources: [ref] }],
      });
    const first = await sweep(
      ctxOf(env, {
        llm: fakeLlm([page('Ada', 'ada fact', '#1'), Object.assign(new Error('boom'), { code: 'ECONNRESET' })]),
        config,
      })
    );
    assert.deepEqual(
      first.runs.map((run) => run.outcome),
      ['ok', 'llm_error']
    );
    const firstTo = env.db.prepare('SELECT cursor_to FROM session_runs WHERE applied = 1').get()!.cursor_to;
    // a line that was still settling during the first sweep is in now
    env.say({ native: 'm6', minutesAgo: 20, text: 'one more thing' });
    const llm = fakeLlm([page('Βασίλης', 'bob fact', '#2')]);
    const second = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.deepEqual(
      second.runs.map((run) => run.outcome),
      ['applied_before', 'ok']
    );
    assert.equal(llm.calls.length, 1, 'only the missing page is asked, over the old lines');
    assert.equal(
      Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor)!.value),
      firstTo,
      'the cursor stops where the old batch ended'
    );
    assert.equal(
      env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personOf(ADA))!.affinity,
      7,
      'the first page was not applied again'
    );
    assert.equal(count(env.db, 'claims', "author = 'her'"), 2);
    assert.ok(
      (env.db.prepare("SELECT rowid FROM sources WHERE native_id = 'm6'").get()!.rowid as number) > (firstTo as number),
      'the new line waits for the next batch'
    );
  } finally {
    env.done();
  }
});

// ---------- schema v9: the run's read-set, the base of a claim edit, lines matched by their native tuple ----------

test("a run records what its request rendered: turn_reads of reader kind session, in the run's context, with the versions shown", async () => {
  const env = semanticSessionFixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
    env.db
      .prepare(
        "INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES ('cv-ada-1', 'cl-ada', 'likes café', '2026-10-02T00:00:00.000Z', 'add')"
      )
      .run();
    const result = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }));
    const firstRun = result.runs[0];
    assert.equal(firstRun.outcome, 'ok');
    const runId = env.db.prepare('SELECT id FROM session_runs').get()!.id;
    const rows = env.db
      .prepare('SELECT * FROM turn_reads WHERE turn_id = ? ORDER BY ord')
      .all(runId)
      .map((row) => ({ ...row }));
    assert.ok(rows.length > 5);
    assert.ok(
      rows.every(
        (row) => row.reader_kind === 'session' && row.step === '0' && row.context_id === `ctx:session:${String(runId)}`
      )
    );
    const claim = rows.find((row) => row.row_kind === 'claims' && row.row_id === 'cl-ada');
    assert.deepEqual([claim!.block, claim!.version_id], ['people', 'cv-ada-1'], 'the exact version the request showed');
    const lines = rows.filter((row) => row.block === 'batch').map((row) => row.row_id);
    assert.deepEqual(
      lines,
      [ids.a, ids.b, ids.c, ids.d, ids.e],
      'the batch lines, in the order the request shows them'
    );
    assert.ok(
      rows.filter((row) => row.block === 'batch').every((row) => row.row_kind === 'sources' && row.revision === 1)
    );
    assert.ok(rows.some((row) => row.row_kind === 'places' && row.row_id === CHANNEL && row.block === 'place'));
    assert.deepEqual(
      {
        ...env.db
          .prepare('SELECT mode, iface FROM execution_contexts WHERE id = ?')
          .get(`ctx:session:${String(runId)}`),
      },
      { mode: 'outward', iface: 'discord' }
    );
  } finally {
    env.done();
  }
});

test('a claim edit carries the version its request showed: a claim that moved on meanwhile is refused as stale_base; the persona’s own base is never read', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
    env.db
      .prepare(
        "INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES ('cv-ada-1', 'cl-ada', 'likes café', '2026-10-02T00:00:00.000Z', 'add')"
      )
      .run();
    const labelOf = (id: string) => [...request(env).maps.claims.entries()].find(([, value]) => value === id)![0];
    const label = labelOf('cl-ada');
    // While the persona answers, another writer gives the claim a newer version.
    const llm = fakeLlm(() => {
      env.db
        .prepare(
          "INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES ('cv-ada-2', 'cl-ada', 'likes tea', '2026-10-24T11:59:00.000Z', 'revise')"
        )
        .run();
      return memoryBlock({
        claims: [
          {
            op: 'revise',
            id: label,
            text: 'likes tea mornings',
            how: 'said',
            sources: ['#1'],
            reason: 'said so',
            base: 'cv-ada-2',
          },
        ],
      });
    });
    const result = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }));
    const firstRun = result.runs[0];
    assert.equal(firstRun.outcome, 'ok');
    assert.equal(
      (firstRun.plan as { claims: Array<{ base: string }> }).claims[0].base,
      'cv-ada-1',
      "the base is the request's, not the answer's"
    );
    assert.equal(
      env.db.prepare("SELECT text FROM claims WHERE id = 'cl-ada'").get()!.text,
      'likes café mornings',
      'nothing written'
    );
    assert.equal(count(env.db, 'decisions', "action = 'rejected:stale_base'"), 1);

    // validateAnswer alone: the base comes from the request's versions, and only when the request resolved them.
    const built = request(env);
    const ask = { claims: [{ op: 'confirm', id: label, sources: ['#1'], base: 'whatever' }] };
    assert.equal(
      Object.hasOwn(validateAnswer(ask, { maps: built.maps, people: built.people }).plan.claims[0], 'base'),
      false
    );
    (resolveSessionReads as (db: Db, built: unknown) => unknown)(env.db, built); // the third argument is left out: the reads need no ids here
    const [firstClaim] = validateAnswer(ask, { maps: built.maps, people: built.people }).plan.claims;
    assert.equal(firstClaim.base, 'cv-ada-2');
  } finally {
    env.done();
  }
});

test("the batch keeps a line's revisions apart from another interface's line with the same native id", () => {
  const env = semanticSessionFixture();
  try {
    env.say({ native: 'm1', minutesAgo: 50, text: 'Καλημέρα' });
    // Another interface's line with the same native id and a higher revision: not a revision of the Discord line.
    env.db
      .prepare(
        `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, scope_kind, scope_iface, authority_id, native_kind)
      VALUES ('src:other:m1', 'seen', 'other', 'm1', 5, NULL, 'other:x', ?, ?, 'elsewhere', 'group', 'other', 'other/global', 'message')`
      )
      .run(new Date(HASH_IDS_NOW - 40 * MINUTE).toISOString(), new Date(HASH_IDS_NOW - 40 * MINUTE).toISOString());
    const scopeEntry = scopesOf(env.db).find((entry) => entry.key === 'group:discord')!;
    const batch = batchOf(env.db, scopeEntry.scope, {
      cursor: 0,
      since: null,
      maxMessages: 200,
      settleBefore: HASH_IDS_NOW,
    });
    assert.deepEqual(
      batch.map((line) => line.text),
      ['Καλημέρα']
    );
  } finally {
    env.done();
  }
});

test('a batch whose request would pass the request cap is cut to its first lines by arrival until it fits; the rest waits for the next batch', async () => {
  const env = semanticSessionFixture();
  try {
    chat(env);
    const scope = scopesOf(env.db).find((entry) => entry.key === 'group:discord')!;
    const all = batchOf(env.db, SESSION_GROUP, {
      cursor: 0,
      since: null,
      maxMessages: 200,
      settleBefore: HASH_IDS_NOW,
    });
    // The cap is set just under the full request, so the batch must be cut, and the cut must fit.
    const probe = buildSessionRequest({
      db: env.db,
      scope,
      batch: all,
      config: baseConfig(),
      prompts,
      selfName: 'Nep',
      now: HASH_IDS_NOW,
    });
    const full = estimateMessages(probe.messages);
    const config = baseConfig(
      {},
      {
        llm: {
          temperature: 1,
          maxRequestTokens: Math.floor((full - 1) / 0.85),
        },
      }
    );
    const fitted = fitBatch(env.db, scope, all, { config, prompts, selfName: 'Nep', now: HASH_IDS_NOW, min: 1 });
    assert.ok(fitted.length < all.length && fitted.length >= 1, 'cut');
    const firstByArrival = [...all]
      .sort((a, b) => a.rowid - b.rowid)
      .slice(0, fitted.length)
      .map((line) => line.rowid)
      .sort();
    assert.deepEqual(
      fitted.map((line) => line.rowid).sort(),
      firstByArrival,
      'the first lines by arrival, so none is skipped'
    );
    const llm = fakeLlm([memoryBlock({})]);
    const result = await sweep(ctxOf(env, { llm, config }));
    const firstRun = result.runs[0];
    assert.equal(firstRun.lines, fitted.length);
    assert.equal(
      Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('shadow', 'group:discord'))!.value),
      Math.max(...fitted.map((line) => line.rowid)),
      'the cursor follows the cut'
    );
  } finally {
    env.done();
  }
});

// Bug: the persona's edit of a line stored `seen` with the moment of the edit reached the memory session as a line of
// someone else's, at the end of the chat, and the session wrote about them as if another had said it.
test('the memory session reads the persona’s edited line once, as theirs, at the place it was said, with the new text', () => {
  const world = openWorld();
  try {
    storeProductionEdit(world.db, { iface: 'fake', place: 'fake:channel:c7' });
    const scope = scopesOf(world.db).find((entry) => entry.key === 'group:fake');
    if (!scope) throw new Error('the synthetic lines have no group session scope');
    const { scope: where } = scope;
    const batch = batchOf(world.db, where, {
      cursor: 0,
      since: null,
      maxMessages: 20,
      settleBefore: minute(200),
    });
    assert.deepEqual(
      batch.map((line) => [line.native_id, line.kind, line.at, line.text]),
      [
        ['owner-1', 'seen', minute(0), 'first words'],
        ['hers-1', 'said', minute(1), 'the kettle is on'],
        ['owner-2', 'seen', minute(2), 'second words'],
        ['hers-2', 'said', minute(3), 'her next words'],
      ]
    );
  } finally {
    world.close();
  }
});

// A custom emoji or sticker stands in every text under its stable name, and its description
// stands once in the block `<media>` of the request that names it, whichever block names it.
const insertEmojiName = (db: Db, name: string, nativeId: string, platformName: string): void => {
  db.prepare(
    "INSERT INTO media_names (name, kind, iface, native_id, platform_name, animated, first_seen_at) VALUES (?, 'emoji', 'discord', ?, ?, 0, '2026-10-01T00:00:00.000Z')"
  ).run(name, nativeId, platformName);
};

/** The `<media>` blocks of a request's user text. */
const mediaBlocksOf = (text: string): Array<string> =>
  [...text.matchAll(/<media>\n([\s\S]*?)\n<\/media>/g)].map((m) => m[1] ?? '');

test('a claim in <people> that names an emoji gives the session request one <media> block with its line', () => {
  // Bug: the legend covers the batch alone, so a stored claim shows the persona a bare `:e7:` they cannot read.
  const env = semanticSessionFixture();
  try {
    chat(env);
    insertEmojiName(env.db, 'e7', '7007', 'λαμπάδα');
    env.claim({
      id: 'cl-ada-emoji',
      subjectId: personOf(ADA),
      kind: 'interest',
      text: 'greets with :e7: every morning',
    });
    const text = textOf(request(env).messages[1].content);
    const blocks = mediaBlocksOf(text);
    assert.equal(blocks.length, 1, text);
    assert.ok((blocks[0] ?? '').includes(':e7: λαμπάδα'), blocks[0]);
  } finally {
    env.done();
  }
});

test('an episode that names an emoji gives the session request its <media> line', () => {
  // Bug: an episode keeps the stable name and no block of the request says what it stands for.
  const env = semanticSessionFixture();
  try {
    chat(env);
    insertEmojiName(env.db, 'e8', '8008', 'φεγγάρι');
    env.db
      .prepare(
        "INSERT INTO episodes (id, kind, subject_id, date, what, status, scope_kind, scope_iface) VALUES ('ep-moon', 'profile', ?, '2026-10-10', 'Ada sent :e8: at midnight', 'open', 'group', 'discord')"
      )
      .run(personOf(ADA));
    const blocks = mediaBlocksOf(textOf(request(env).messages[1].content));
    assert.equal(blocks.length, 1);
    assert.ok((blocks[0] ?? '').includes(':e8: φεγγάρι'), blocks[0]);
  } finally {
    env.done();
  }
});

test('a sweep names in its write the accounts of the people that wrote its batch', async () => {
  // Bug: the core opens a direct chat ahead only for a person a pass came across, so a pass that names nobody opens none.
  const env = semanticSessionFixture();
  try {
    chat(env);
    const writes: Array<Record<string, unknown>> = [];
    const write = (update: unknown) => {
      writes.push(update as Record<string, unknown>);
      return Promise.resolve(applyMemoryWrite(env.handle, update));
    };
    const llm = fakeLlm(() => memoryBlock({ claims: [], episodes: [], affinity: [], descriptions: [] }));
    await sweep(ctxOf(env, { llm, write }));
    const met = writes.flatMap((update) =>
      Array.isArray(update.met) ? (update.met as Array<{ iface: string; native: string }>) : []
    );
    assert.deepEqual(met.map((one) => `${one.iface}:${one.native}`).sort(), [`discord:${ADA}`, `discord:${BOB}`]);
  } finally {
    env.done();
  }
});

// A DM nobody linked to a person: every line has no `scope_dm`, because the place names no partner person. The memory
// session sweeps it by the audience of its lines, so someone who only ever talks to the persona in a DM still leaves them with
// something learned, and the DM's scope and cursor outlive a later link, so none of its lines is read twice. Synthetic ids
// and text only.

const PLACE = 'chat:dm:n7';
const AUDIENCE = 'aud:dm:chat:dm:n7';
const ACCOUNT = 'chat:n7';
const LINKED = 'person:0p4que';
const FIRST_AT = Date.parse('2026-10-24T02:00:00.000Z');

/** One line of the DM, `n` minutes after the first, from the partner. */
function say(handle: MemoryHandle, n: number, text = 'a synthetic line'): void {
  const at = FIRST_AT + n * 60_000;
  const envelope = observationOf(
    {
      kind: 'message.received',
      iface: 'chat',
      at,
      chat: { id: 'n7', kind: 'dm', chatType: 'dm', partnerId: 'n7' },
      message: { id: `line-${n}`, at, content: text, author: { id: 'n7', name: 'someone' } },
    },
    { connection: 'conn:chat', direct: true }
  );
  assert.ok(envelope);
  assert.equal(observe(handle, envelope, { now: () => at }).ok, true);
  asBeforeMetaPersons(dbOf(handle));
}

/**
 * A new account gets a meta-person with its first line, so a DM nobody linked arises only
 * from rows written before that release. The core's link of the partner is taken back here, with what it wrote, to
 * keep the DM in that older state. A link written by anyone else stays.
 */
function asBeforeMetaPersons(db: Db): void {
  const core = db
    .prepare("SELECT person_id FROM account_person_links WHERE account_id = ? AND by = 'core' AND valid_to_at IS NULL")
    .get(ACCOUNT);
  if (typeof core?.person_id !== 'string') return;
  db.prepare("DELETE FROM account_person_links WHERE account_id = ? AND by = 'core'").run(ACCOUNT);
  db.prepare('DELETE FROM person_accounts WHERE id = ?').run(ACCOUNT);
  db.prepare('UPDATE accounts SET person_id = NULL, link = NULL, linked_by = NULL, linked_at = NULL WHERE id = ?').run(
    ACCOUNT
  );
  db.prepare('UPDATE places SET partner_person = NULL WHERE id = ?').run(PLACE);
  db.prepare('UPDATE sources SET scope_dm = NULL, author_person = NULL WHERE place_id = ?').run(PLACE);
}

const dmScopes = (db: Db): Array<SweepScope> =>
  scopesOf(db, { audienceColumn: true }).filter((one) => one.scope.scope_iface === 'chat');

const onlyScope = (db: Db): SweepScope => {
  const scopes = dmScopes(db);
  assert.equal(scopes.length, 1);
  return scopes[0];
};

const applying = baseConfig({ mode: 'apply' });

/** A sweep that answers with `plan`; returns the texts of the requests it sent. */
async function swept(env: Fixture, plan: unknown = {}): Promise<Array<string>> {
  const llm = fakeLlm(() => memoryBlock(plan));
  const result = await sweep(ctxOf(env, { llm, config: applying }), { ignoreSweepCap: true });
  for (const run of result.runs) assert.equal(run.errors?.length ?? 0, 0, String(run.errors));
  return llm.calls.map(({ messages }) => textOf(messages[1]?.content));
}

test('a session on a DM with no link keeps what it learned in that DM, and the audit stays clean', async () => {
  // Bug: the row takes the spelled person of a place, or falls to internal, and the DM's own next turn cannot read it.
  const env = semanticSessionFixture();
  try {
    say(env.handle, 1, 'I keep bees on the roof');
    const before = auditMemory(env.db).findings;
    const requests = await swept(env, {
      claims: [
        { op: 'add', subject: 'self', kind: 'self_fact', text: 'heard about the bees', how: 'said', sources: ['#1'] },
      ],
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0], /bees on the roof/);
    const row = env.db
      .prepare("SELECT scope_kind, scope_iface, scope_dm, audience_id FROM claims WHERE text = 'heard about the bees'")
      .get();
    assert.deepEqual({ ...row }, { scope_kind: 'dm', scope_iface: 'chat', scope_dm: null, audience_id: AUDIENCE });
    assert.equal(auditMemory(env.db).findings, before);
    assert.deepEqual(await swept(env), [], 'a second sweep reads nothing');
  } finally {
    env.done();
  }
});

test('a session on a DM with no link reads no claim of another DM', async () => {
  // Bug: a run with no partner runs under an internal context, which reads and confirms every row of the memory.
  const env = semanticSessionFixture();
  try {
    say(env.handle, 1);
    env.db.exec(`
      INSERT INTO places (id, iface, kind, chat, scope_kind, partner_person, partner_account)
        VALUES ('chat:dm:other', 'chat', 'dm', 'dm', 'dm', 'person:chat:other', NULL);
      INSERT INTO audiences (id, kind, iface, place_id) VALUES ('aud:dm:chat:dm:other', 'dm', 'chat', 'chat:dm:other');
      INSERT INTO claims (id, subject_kind, subject_id, kind, text, how, author, truth, shown, created_at, audience_id, scope_kind, scope_iface, scope_dm)
        VALUES ('claim:elsewhere', 'self', 'person:self', 'self_fact', 'told in another chat', 'said', 'her', 'current', 1, '2026-10-24T00:00:00.000Z', 'aud:dm:chat:dm:other', 'dm', 'chat', 'person:chat:other');
    `);
    const requests = await swept(env);
    assert.doesNotMatch(requests[0], /told in another chat/);
    applyMemoryWrite(env.handle, {
      kind: 'session',
      mode: 'apply',
      run: {
        id: 'run:probe',
        scopeKey: 'probe',
        scope: { scope_kind: 'dm', scope_iface: 'chat', scope_dm: null },
        audienceId: AUDIENCE,
        startedAt: '2026-10-24T03:00:00.000Z',
        finishedAt: '2026-10-24T03:00:00.000Z',
        outcome: 'ok',
      },
      plan: { claims: [{ op: 'confirm', id: 'claim:elsewhere', sources: [] }] },
      now: FIRST_AT + HOUR,
    });
    const claim = env.db.prepare("SELECT last_seen_at FROM claims WHERE id = 'claim:elsewhere'").get();
    assert.equal(claim?.last_seen_at, null, 'a confirm from this DM does not reach another DM');
  } finally {
    env.done();
  }
});

/** The DM swept once over two lines, then a third line after `link` ran. */
async function assertLinkKeepsTheScope(env: Fixture, link: () => void): Promise<void> {
  say(env.handle, 1);
  say(env.handle, 2);
  assert.equal((await swept(env)).length, 1);
  const before = onlyScope(env.db);
  const cursor = env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('apply', before.key))?.value;
  assert.ok(Number(cursor) > 0);
  link();
  say(env.handle, 3, 'a line after the link');

  const after = onlyScope(env.db);
  assert.equal(after.key, before.key, 'the link leaves the scope where it was');
  assert.equal(after.ctx.person, LINKED);
  assert.deepEqual(
    env.db
      .prepare('SELECT DISTINCT scope_dm, audience_id FROM sources WHERE place_id = ?')
      .all(PLACE)
      .map((row) => ({ ...row })),
    [{ scope_dm: LINKED, audience_id: AUDIENCE }],
    'every line of the DM names the person now, in the audience it had'
  );
  const requests = await swept(env);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /a line after the link/);
  assert.doesNotMatch(requests[0], /a synthetic line/, 'the lines already read are not read again');
}

test('a later link by the owner reads no line of the DM twice', async () => {
  // Bug: the key of the scope follows the partner, the new key starts at cursor 0, and the whole DM is summarised again.
  const env = semanticSessionFixture();
  try {
    await assertLinkKeepsTheScope(env, () => {
      linkOwnerAccount(env.db, ACCOUNT, LINKED, '2026-10-24T03:00:00.000Z');
    });
  } finally {
    env.done();
  }
});

test('a link the next line finds reads no line of the DM twice, and the earlier lines take the person', async () => {
  // Bug: a place fills its partner from the account when the next line arrives, and the lines before it fork the DM.
  const env = semanticSessionFixture();
  try {
    await assertLinkKeepsTheScope(env, () => {
      env.db.prepare("INSERT OR IGNORE INTO people (id, first_seen_at) VALUES (?, '2026-10-24')").run(LINKED);
      linkAccount(env.db, ACCOUNT, LINKED, '2026-10-24T03:00:00.000Z', { by: 'owner', reason: 'a test link' });
    });
  } finally {
    env.done();
  }
});

// One DM place is one scope: whatever values its rows carry in `scope_dm`, a memory session sweeps it once, from one cursor,
// and no line is read twice or left unread. The values come from history (a line seen before the account was linked, the
// importer's spelling of the command line, the owner's person on new lines); a link made later must not fork the DM again.
// Synthetic ids and text only. The scopes and batches are read through the exports of `session.ts`, as the sweep reads them.

const cliScopes = (db: Db): Array<SweepScope> =>
  scopesOf(db, { audienceColumn: true }).filter((one) => one.scope.scope_iface === 'cli');

/** The ids of the lines the sweep would read for `scope` after `cursor`, in the order it reads them. */
const batchIds = (db: Db, scopeEntry: SweepScope, cursor: number): Array<string> =>
  batchOf(db, scopeEntry.scope, {
    cursor,
    since: null,
    maxMessages: 1000,
    settleBefore: Number.POSITIVE_INFINITY,
    audienceId: scopeEntry.audienceId ?? null,
  }).map((line) => String(line.id));

const ids = (from: number, to: number): Array<string> =>
  Array.from({ length: to - from + 1 }, (_, i) => `src:cli:${from + i}`);

test('lines that carry three spellings of the partner make one scope, not one per spelling', () => {
  // Bug: a line with the owner's opaque person keys a second scope (`dm:cli:<place>`) beside `dm:cli:person:cli:owner`;
  // each starts at cursor 0 and reads the whole DM, so every line is summarised twice.
  const file = path.join(tempDir('nep-dm-one-scope-'), 'memory.db');
  openMemoryDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = OFF');
  addCliPlace(raw, 'person:0wn3r');
  addCliLines(raw, 9, (n) => (n % 3 === 0 ? null : n % 3 === 1 ? OLD_PERSON : 'person:0wn3r'));
  raw.close();
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    const scopes = cliScopes(db);
    assert.equal(scopes.length, 1);
    assert.deepEqual(batchIds(db, scopes[0], 0), ids(1, 9), 'every line once, in arrival order');
  } finally {
    handle.close();
  }
});

test('a DM whose lines all carry the place partner is swept as one scope that reads its lines', () => {
  // Bug: a person spelled for another interface (`person:discord:...` on a `cli` DM) names no audience from the triple, so
  // the scope is dropped as malformed and the DM is never summarised once its old rows are retired.
  const file = path.join(tempDir('nep-dm-one-scope-'), 'memory.db');
  openMemoryDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = OFF');
  addCliPlace(raw);
  addCliLines(raw, 4, () => OWNER);
  raw.close();
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    const scopes = cliScopes(db);
    assert.equal(scopes.length, 1);
    const [scope] = scopes as [SweepScope];
    assert.equal(scope.audienceId, CLI_AUDIENCE);
    assert.equal(scope.ctx.place, CLI_PLACE);
    assert.equal(scope.ctx.person, OWNER);
    assert.deepEqual(batchIds(db, scope, 0), ids(1, 4));
  } finally {
    handle.close();
  }
});

// Every consumer's way into the one retrieval service. `memoryQueryFor` turns what a consumer already holds into
// a query with no model in between; `retrievalBounds` gives the budget, the prefetch sharing its existing deadline and
// tokens. The deciding turn's outcome, the publisher and the executor stay outside: these tests check that retrieval
// moves nothing there and never yields a destination. Fake model, real temporary databases, synthetic content.

const page = (versionId: string): MemoryPage => ({
  assertions: [
    {
      claimId: 'clm:1',
      versionId,
      text: 'Alex works on Lumen',
      polarity: 'positive',
      state: 'current',
      arguments: [],
      evidence: [],
      dependencies: [],
      needsReview: false,
    },
  ],
  sourceIds: [],
  paths: [],
  next: null,
  partialReason: null,
  ambiguous: [],
  signals: [],
});

const retrievedPage = (versionId: string, sourceId: string): MemoryPage => ({
  ...page(versionId),
  assertions: [{ ...page(versionId).assertions[0], evidence: [{ sourceId, role: 'supports' }] }],
  sourceIds: [sourceId],
});

function sessionWithPrior() {
  const env = semanticSessionFixture();
  chat(env);
  const stored = env.say({ native: 'old', minutesAgo: 9000, text: 'an old stored line' });
  const unseen = env.say({ native: 'never', minutesAgo: 9001, text: 'a line this run never showed' });
  env.db
    .prepare(
      "INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, scope_kind, scope_iface) VALUES ('clm:prior', 'person', 'p', 'detail', 'prior', 'current', 1, 'group', 'discord')"
    )
    .run();
  env.db
    .prepare(
      "INSERT INTO claim_versions (id, claim_id, text, recorded_at, origin) VALUES ('cv:prior', 'clm:prior', 'prior', '2026-10-01T00:00:00.000Z', 'session')"
    )
    .run();
  const given = request(env);
  const retrieved = retrievedPage('cv:prior', stored);
  const built = buildSessionRequest({
    db: env.db,
    scope: given.scope,
    // The two old lines belong to an earlier batch: only `retrieved` can show one of them here.
    batch: given.batch.filter((line) => line.id !== stored && line.id !== unseen),
    config: wrongly(baseConfig()),
    prompts,
    selfName: 'Nep',
    now: Date.parse('2026-10-24T12:00:00.000Z'),
    retrieved,
  });
  return { env, built, stored, unseen };
}

const NEW_PROJECT = { handle: 'n1', kind: 'project', name: 'Lumen', language: 'en', sources: [1] };
const assertionCiting = (premises: Array<{ handle: string; role: string }>, sources: Array<number | string>) => ({
  predicate: { id: 'project.works_on', version: 1 },
  assertionKind: 'relation',
  text: 'Ada works on it',
  arguments: [
    { role: 'person', position: 0, ref: 'Ada' },
    { role: 'project', position: 0, ref: 'n1' },
  ],
  polarity: 'positive',
  how: 'inferred',
  sources,
  premises,
});

test('a session request records the prior versions and sources it shows, under their own handles', () => {
  // Bug: a claim is shown with no read row, so a later citation of it cannot be proved.
  const { env, built, stored } = sessionWithPrior();
  const mapsPriorVersions = built.maps.priorVersions;
  assert.deepEqual([...(mapsPriorVersions?.values() ?? [])], ['cv:prior']);
  const mapsSources = built.maps.sources;
  assert.ok([...mapsSources.values()].includes(stored));
  assert.ok(built.reads.some((read) => read.kind === 'claim_version' && read.id === 'cv:prior'));
  assert.ok(built.reads.some((read) => read.kind === 'source_id' && read.id === stored));
  env.done();
});

test('a shown prior version may be named as a premise and resolves to its exact id', () => {
  // Bug: the persona cannot build on what they were reminded of, so an inference loses its premise.
  const { env, built } = sessionWithPrior();
  const mapsPriorVersions = built.maps.priorVersions;
  const handle = [...(mapsPriorVersions?.keys() ?? [])][0];
  const { plan } = validateAnswer(
    { entities: [NEW_PROJECT], assertions: [assertionCiting([{ handle, role: 'supports' }], [1])] },
    { maps: built.maps, people: built.people }
  );
  const planAssertions = plan.assertions;
  assert.deepEqual(planAssertions?.[0]?.dependencies, [{ versionId: 'cv:prior', role: 'supports' }]);
  env.done();
});

test('a premise handle the request never gave is dropped with its reason', () => {
  // Bug: a guessed handle reaches a real version the persona was not shown.
  const { env, built } = sessionWithPrior();
  const { plan, counts } = validateAnswer(
    { entities: [NEW_PROJECT], assertions: [assertionCiting([{ handle: 'v99', role: 'supports' }], [1])] },
    { maps: built.maps, people: built.people }
  );
  assert.equal(counts.dropped.unknown_version, 1);
  assert.deepEqual(plan.assertions ?? [], []);
  env.done();
});

test('a raw source id is no citation, even of a real line, when the request did not show it', () => {
  // Bug: a displayed claim handle is taken as permission to cite its unseen source.
  const { env, built, unseen } = sessionWithPrior();
  const mapsSources = built.maps.sources;
  assert.ok(![...mapsSources.values()].includes(unseen));
  const { plan, counts } = validateAnswer(
    { entities: [NEW_PROJECT], assertions: [assertionCiting([], [unseen])] },
    { maps: built.maps, people: built.people }
  );
  assert.equal(counts.dropped.unknown_source, 1);
  assert.deepEqual(plan.assertions ?? [], []);
  env.done();
});

test('a session with no retrieved page builds the request it always built', () => {
  // Bug: the new parameter changes every request's bytes and the prompt cache goes cold.
  const env = semanticSessionFixture();
  chat(env);
  const given = request(env);
  const built = buildSessionRequest({
    db: env.db,
    scope: given.scope,
    batch: given.batch,
    config: wrongly(baseConfig()),
    prompts,
    selfName: 'Nep',
    now: Date.parse('2026-10-24T12:00:00.000Z'),
    retrieved: null,
  });
  assert.deepEqual(built.messages, given.messages);
  env.done();
});

// The consumers of memory reach the one retrieval service in production code, not only through the seams
// tests/src/memory/retrieval-input.test.ts exercises: a session's request, an attention's input, an
// errand and a diary post. Each test goes through the module the consumer calls. Fake model, real
// temporary databases, synthetic content.

const BOUNDS = { seeds: 3, hops: 2, nodes: 10, edges: 30, assertions: 6, evidence: 9, tokens: 900, deadlineMs: 700 };

test('a memory session writes a structured fact from its answer and shows what it retrieved in the next request', async () => {
  // Bug: the session writer is never reached in an apply, or the batch never sees what the persona stored before.
  const env = semanticSessionFixture();
  chat(env);
  const base = baseConfig({ mode: 'apply' });
  const config = { ...base, memoryDb: { ...wrongly<object>(base.memoryDb), retrieval: { ...BOUNDS } } };
  const answer = {
    entities: [{ handle: 'n1', kind: 'project', name: 'Hello', language: 'en', sources: [1] }],
    assertions: [
      {
        predicate: { id: 'project.status', version: 1 },
        assertionKind: 'property',
        text: 'hello is ongoing',
        arguments: [
          { role: 'project', position: 0, ref: 'n1' },
          { role: 'status', position: 0, literal: 'ongoing' },
        ],
        polarity: 'positive',
        how: 'said',
        sources: [1],
      },
    ],
  };
  const first = fakeLlm(memoryBlock(answer));
  await sweep(ctxOf(env, { llm: first, config: wrongly(config) }));
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM semantic_entities').get()?.n, 1);
  env.say({ native: 'later', minutesAgo: -30, text: 'hello again, how is hello doing' });
  const second = fakeLlm(memoryBlock({}));
  await sweep(
    { ...ctxOf(env, { llm: second, config: wrongly(config) }), now: () => HASH_IDS_NOW + 3_600_000 },
    { ignoreSweepCap: true }
  );
  const asked = JSON.stringify(second.calls.at(-1));
  assert.match(asked, /<retrieved>/);
  assert.match(asked, /hello is ongoing/);
  env.done();
});

// One sent line, one `sources` row. The interface echoes the persona's own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.

const SAID_ROWS_SINGLE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = SAID_ROWS_SINGLE_NOW - 60_000;
const IFACE = 'synthetic';
const SAID_ROWS_SINGLE_ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, SAID_ROWS_SINGLE_ROOT);
const ROOM = 'room-a';
const SAID_ROWS_SINGLE_SELF = 'her-account';
const WORDS = 'κουνέλι στον κήπο';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

/** The `message.received` event of a line: the persona's when `author` is their id, as the interface delivers their own echo. */
function lineEvent({
  id = 'sent-1',
  author = SAID_ROWS_SINGLE_SELF,
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
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: SAID_ROWS_SINGLE_ROOT },
    addressing: { mentionedAccountIds },
    message: {
      id,
      at,
      content: text,
      author: { id: author, self: author === SAID_ROWS_SINGLE_SELF },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

async function saidRowsSingleObserveLine(
  memory: Memory,
  options: Parameters<typeof lineEvent>[0] = {}
): Promise<string> {
  const envelope = observationOf(lineEvent(options), { selfId: SAID_ROWS_SINGLE_SELF });
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
    { kind: 'said', now: () => SAID_ROWS_SINGLE_NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => SAID_ROWS_SINGLE_NOW }).append(TOP, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

async function withEchoedLine(run: (memory: Memory, db: Db) => Promise<void> | void): Promise<void> {
  const memory = await openTestMemory({ now: () => SAID_ROWS_SINGLE_NOW, iface: () => IFACE });
  try {
    await saidRowsSingleObserveLine(memory);
    await recordSent(memory);
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test('the session batch holds the persona’s echoed line once', async () => {
  // Bug: both rows are current lines, so the session writer reads and cites one sentence as two.
  await withEchoedLine((_memory, db) => {
    const batch = batchOf(db, groupScope(IFACE), {
      cursor: 0,
      since: null,
      maxMessages: 50,
      settleBefore: SAID_ROWS_SINGLE_NOW,
    }).filter((line) => line.kind === 'said');
    assert.equal(batch.length, 1);
  });
});

// The memory writer proved at the spawn boundary, with a disposable executable that records the
// argv, the environment and stdin it really got (`runChildProcess`, src/agent-runner/backend.ts). Claude 2.1.317 enforces
// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, measured live: with 20 a run ended is_error at 80 output tokens, with none 436 end_turn.
// So the writer passes it. Codex lists no such control, so there `maxOutputTokens` stays a reported gap. The installed releases
// list no output-token control in their help (claude 2.1.317, codex 0.164.0), so `maxOutputTokens` is a reported capability
// gap: nothing invents a flag and nothing trims the persona's text. The tests also pin what the writer's parity consists of, how a
// failed selection and a failed source behave, and what `session_runs` records as the path that really ran.

type Seen = { argv: Array<string>; env: Record<string, string>; stdin: string };

/**
 * A private layer with the executable of `backend` writing what it got into a file, then running `tail` as shell. codex
 * writes `final` to the file after `-o`, as the real CLI does.
 */
function boundary(backend: 'codex' | 'claude', tail: string, final = '') {
  const privateDir = tempDir('nep-memory-boundary-');
  writeKeysFile(privateDir, { subharness: { backends: [backend], key: null, modes: {} } });
  const { binary } = subharnessPlace(privateDir, backend);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const record = tempDir('nep-memory-record-');
  const finalFile = path.join(record, 'final');
  fs.writeFileSync(finalFile, final);
  fs.writeFileSync(
    binary,
    `#!/bin/sh
PATH=/usr/bin:/bin
for word in "$@"; do printf '%s\\000' "$word"; done > '${record}/argv'
env -0 > '${record}/env'
cat > '${record}/stdin'
previous=''
for word in "$@"; do
  if [ "$previous" = '-o' ]; then cat '${finalFile}' > "$word"; fi
  previous="$word"
done
${tail}
`,
    { mode: 0o755 }
  );
  const deps: MemoryWriterDeps = {
    privateDir,
    runChild: runChildProcess,
    workDir: tempDir('nep-memory-work-'),
  };
  const seen = (): Seen => ({
    argv: fs.readFileSync(path.join(record, 'argv'), 'utf8').split('\0').slice(0, -1),
    env: Object.fromEntries(
      fs
        .readFileSync(path.join(record, 'env'), 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
    ),
    stdin: fs.readFileSync(path.join(record, 'stdin'), 'utf8'),
  });
  return { privateDir, deps, seen };
}

const subharnessMemoryBoundaryEnvelope = (fields: Record<string, unknown>): string =>
  `cat <<'JSON'\n${JSON.stringify({ type: 'result', is_error: false, ...fields })}\nJSON`;

// session_runs

/** A session client over a recorded path, as `session_runs` sees it through the sweep. */
function sweepClient(deps: MemoryWriterDeps) {
  const client = memoryWriterClient({ writer: deps, direct: fakeLlm(memoryBlock({ claims: [] })) });
  return {
    calls: [] as Array<LlmCall>,
    complete: (messages: LlmCall['messages'], options: LlmCall['options']) => client.complete(messages, options),
  };
}

test('session_runs records the backend and model that really ran, not the role model of the config', async () => {
  // Catches: a Claude session stored under the direct model's name, so no later reading can tell who wrote the memory.
  const env = semanticSessionFixture();
  try {
    chat(env);
    const { privateDir, deps } = boundary(
      'claude',
      subharnessMemoryBoundaryEnvelope({ result: memoryBlock({ claims: [] }) })
    );
    writeKeysFile(privateDir, {
      subharness: {
        backends: ['claude'],
        key: null,
        modes: {},
        memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
      },
    });
    const result = await sweep(ctxOf(env, { llm: sweepClient(deps) }));
    const firstRun = result.runs[0];
    assert.equal(firstRun?.outcome, 'ok');
    assert.equal(env.db.prepare('SELECT model FROM session_runs').get()?.model, 'claude:claude-opus-4-6');
  } finally {
    env.done();
  }
});

test('a failed subharness run records the path that failed too', async () => {
  // Catches: the row of the very run someone needs to diagnose naming a model that was never asked.
  const env = semanticSessionFixture();
  try {
    chat(env);
    const { privateDir, deps } = boundary('claude', 'exit 1');
    writeKeysFile(privateDir, {
      subharness: {
        backends: ['claude'],
        key: null,
        modes: {},
        memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
      },
    });
    const result = await sweep(ctxOf(env, { llm: sweepClient(deps) }));
    const firstRun = result.runs[0];
    assert.equal(firstRun?.outcome, 'llm_error');
    assert.equal(env.db.prepare('SELECT model FROM session_runs').get()?.model, 'claude:claude-opus-4-6');
  } finally {
    env.done();
  }
});

// A journey, end to end over the fake interface and a scripted model, with no Discord object. A member's
// message reaches the core through a fake interface unit. The persona's memory session (`memoryDb.session.mode: apply`) reads the
// settled line and the scripted memory model answers with an entity pair and a relation. A neighbour of the seeded entity
// is reached through the owner's graph read with its source line. A second member message is a follow-up query whose
// turn request carries the stored fact. A later message contradicts the premise: the session stores the inference as
// disputed on that premise, and the next follow-up shows it as disputed. The heartbeat runs with no place and no
// destination and ends handled. The owner exports the database and the rows of every semantic and graph table
// reconcile with the live database. The tests run in file order over one core, because each step is the state the next
// one reads; the model sees a real session request and a request that names no handle it could not have been shown
// fails the step with the reason in the timeout message. Synthetic text only.

/**
 * The journey runs on a clock that is sixty times faster than the real one, installed as `Date.now` for the file: the
 * memory service reads it for the ten minutes a line must age before a session reads it and for the minute between two
 * looks, and a session reads facts as of the newest line of its batch. A wait below uses the real clock.
 */
const REAL_NOW = Date.now.bind(Date);
const CLOCK_START = REAL_NOW();
const FAST = 60;
const fastNow = (): number => CLOCK_START + (REAL_NOW() - CLOCK_START) * FAST;
const now = (): number => Date.now();

/** Waits for `check` up to `ms` of real time. */
async function waitFor(check: () => boolean, what: string | (() => string), ms: number): Promise<void> {
  const deadline = REAL_NOW() + ms;
  while (!check()) {
    if (REAL_NOW() > deadline) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const FIRST = 'Lumen is part of Orbis, settled this morning';
const THIRD = 'Correction: Lumen is not part of Orbis after all';
// Texts the model stores in its own words, none of them a phrase of a member's line, so a request that carries one
// proves a stored fact reached it and not the chat history.
const PART_OF = 'zelkova-fact: Lumen sits under Orbis';
const NOT_PART_OF = 'zelkova-denial: Lumen sits outside Orbis';
const DOUBT = 'zelkova-doubt: Lumen may not answer to the Orbis review';
const QUESTION = 'Where does Lumen sit in the Orbis structure, and does it answer to the Orbis review?';
/** A member's statement to the room: it names no one, and its time lies beyond the settle time of a session. */
const member = (id: string, text: string) => journeyLineEvent({ id, text, at: Date.now() - SETTLED_MS });
// A step waits up to this many real milliseconds for its session: a tick of the memory service comes every ten.
const SESSION_AT = 60_000;
/** A session reads only lines older than its settle time (ten minutes), so a member's line is stamped a little beyond it. */
const SETTLED_MS = 11 * 60_000;

const CONFIG = {
  bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
  gifs: { backfillMessages: 0 },
  wakes: { tickSeconds: 1, review: { enabled: false } },
  heartbeat: { enabled: true, schedule: 'every 15m', jitterMinutes: 0 },
  recall: { prefetch: { deadlineMs: 5000, maxTokens: 1500, contextTokens: 500, trivial: [] } },
  memoryDb: {
    session: { mode: 'apply', minMessages: 1, minLines: 0, everyMinutes: 1, reviewsPerDay: 0 },
  },
  // The memory role runs on its chain, here on the one key.
  models: { routes: { memory: [{ via: 'api', key: 'core-1', model: 'anthropic/claude-opus-4.6', effort: null }] } },
};

const journeyTextOf = (messages: unknown): string =>
  (Array.isArray(messages) ? (messages as Array<{ content?: unknown }>) : [])
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? (message.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('')
          : ''
    )
    .join('\n');

const handleOf = (text: string, letter: 'x' | 'v', containing: string): string => {
  const section = text.slice(Math.max(0, text.search(/^<retrieved>$/m)));
  const line = section
    .split('\n')
    .find((one) => new RegExp(`\\[${letter}\\d+\\]`).test(one) && one.includes(containing));
  const found = line === undefined ? null : new RegExp(`\\[(${letter}\\d+)\\]`).exec(line);
  if (found === null) {
    const from = text.search(/^<retrieved>$/m);
    const shown = from < 0 ? 'the request has no <retrieved> block' : text.slice(from, from + 700);
    throw new Error(`no [${letter}N] line holding "${containing}" in the session request: ${shown}`);
  }
  return found[1];
};

type Entry = { purpose: string; text: string };

/** The scripted model: the door's classifier says yes, the memory session answers by the member line it was shown. */
function journeyLlm() {
  const entries: Array<Entry> = [];
  const problems: Array<string> = [];
  const complete = (
    messages: unknown,
    given?: unknown
  ): Promise<{ text: string; usage: object; estimated: number }> => {
    const purpose = (given as { purpose?: string } | undefined)?.purpose ?? '';
    const reply = (text: string) => Promise.resolve({ text, usage: {}, estimated: 10 });
    // The persona answers the question and reads the member statements without a reply: their own reply line is stamped now and
    // a session reads nothing behind a line younger than its settle time.
    if (purpose === 'address') return reply(journeyTextOf(messages).includes(QUESTION) ? 'yes' : 'no');
    if (purpose === 'lookup' || purpose === 'elsewhere-pick') return reply('none');
    // Split, merge and missed answer in strict JSON.
    if (purpose === 'split') return reply('{"parts":[]}');
    const text = journeyTextOf(messages);
    entries.push({ purpose, text });
    if (purpose === 'memory-session') {
      try {
        return reply(sessionAnswer(text));
      } catch (error) {
        problems.push(error instanceof Error ? error.message.slice(0, 200) : String(error));
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (text.includes('This is your own time')) return reply('<think>nothing calls me</think><skip/>');
    return reply('<msg>γεια σου, καλημέρα</msg>');
  };
  return { entries, problems, complete, requests: [] as Array<unknown>, options: [] as Array<unknown> };
}

const block = (value: unknown): string => `<think>reading</think>\n<memory>\n${JSON.stringify(value)}\n</memory>`;

function sessionAnswer(text: string): string {
  if (text.includes(THIRD)) {
    const lumen = handleOf(text, 'x', 'Lumen');
    const orbis = handleOf(text, 'x', 'Orbis');
    const premise = handleOf(text, 'v', PART_OF);
    const line = Number(/#(\d+) \[[^\]]*\][^\n]*Correction: Lumen is not part/.exec(text)?.[1]);
    return block({
      assertions: [
        {
          predicate: { id: 'concept.part_of', version: 1 },
          assertionKind: 'relation',
          text: NOT_PART_OF,
          arguments: [
            { role: 'part', position: 0, ref: lumen },
            { role: 'whole', position: 0, ref: orbis },
          ],
          polarity: 'negative',
          how: 'said',
          sources: [line],
        },
        {
          predicate: { id: 'project.status', version: 1 },
          assertionKind: 'property',
          text: DOUBT,
          arguments: [
            { role: 'project', position: 0, ref: lumen },
            { role: 'status', position: 0, literal: 'doubtful under review' },
          ],
          polarity: 'positive',
          how: 'inferred',
          state: 'disputed',
          sources: [line],
          premises: [{ handle: premise, role: 'supports' }],
        },
      ],
    });
  }
  const line = Number(/#(\d+) \[[^\]]*\][^\n]*Lumen is part of Orbis/.exec(text)?.[1]);
  return block({
    entities: [
      { handle: 'n1', kind: 'project', name: 'Lumen', language: 'en', sources: [line] },
      { handle: 'n2', kind: 'organization', name: 'Orbis', language: 'en', sources: [line] },
    ],
    assertions: [
      {
        predicate: { id: 'concept.part_of', version: 1 },
        assertionKind: 'relation',
        text: PART_OF,
        arguments: [
          { role: 'part', position: 0, ref: 'n1' },
          { role: 'whole', position: 0, ref: 'n2' },
        ],
        polarity: 'positive',
        how: 'said',
        sources: [line],
      },
    ],
  });
}

type Journey = {
  dirs: Dirs;
  core: Core;
  unit: Unit;
  llm: ReturnType<typeof journeyLlm>;
  stop(): Promise<void>;
};

let journey: Journey;
const providerCalls: Array<string> = [];
const warnings: Array<string> = [];
let realFetch: typeof fetch = globalThis.fetch;
let releaseLogs: () => void = () => undefined;
let logsDone: Promise<unknown> = Promise.resolve();

// The log is named so the chain stays under the code-health depth (tests by the lead).
const why = (): string => {
  const { llm } = journey;
  return `session problems: ${JSON.stringify(llm.problems)}; model purposes: ${llm.entries
    .map((entry) => entry.purpose)
    .join(
      ','
    )}; session runs: ${JSON.stringify(rows('SELECT scope_key, outcome FROM session_runs'))}; provider calls: ${providerCalls.length}; memory logs: ${warnings.join(' | ')}`;
};
const rows = (sql: string, ...args: Array<unknown>): Array<JourneyRow> => query(journey.dirs, sql, ...args);

const entityIdOf = (name: string): string => {
  const found = rows('SELECT DISTINCT entity_id FROM semantic_labels WHERE text = ?', name);
  assert.equal(found.length, 1, `no single entity named ${name}`);
  return String(found[0]?.entity_id);
};

let followUp = '';

describe('the memory journey over a fake core', () => {
  onLog((entry: object) => {
    const line = JSON.stringify(entry);
    if (/memory session|retriev/.test(line)) warnings.push(line.slice(0, 260));
  });

  before(async () => {
    const dirs = folders(CONFIG);
    for (const client of [FAKE_CLIENT, CLI_CLIENT]) addClient(dirs.privateDir, client);
    // The memory role runs on the key its chain names. Its probe at the start is the only request to a provider, and a
    // fake answers it.
    writeKeysFile(dirs.privateDir, { core: [{ name: 'core-1', value: 'test-core-key' }] });
    Date.now = fastNow;
    realFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      providerCalls.push(url);
      return url.endsWith('chat/completions')
        ? Promise.resolve(
            new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 })
          )
        : Promise.reject(new Error(`the journey reached ${url}`));
    };
    const llm = journeyLlm();
    let started!: (value: { core: Core; unit: Unit }) => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<{ core: Core; unit: Unit }>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    // The core's log lines go through the capture until the journey ends, so the test runner's stream stays clean.
    logsDone = withCapturedLogs(async () => {
      try {
        const core = await startCore({
          paths: dirs.paths,
          env: {},
          interfaces: [],
          llm,
          embedder: { embed: () => Promise.resolve([]) },
          now,
        });
        started({ core, unit: await startedUnit(dirs) });
      } catch (error) {
        failed(error);
        return;
      }
      await new Promise<void>((resolve) => {
        releaseLogs = resolve;
      });
    });
    const { core, unit } = await ready;
    journey = {
      dirs,
      core,
      unit,
      llm,
      async stop() {
        await unit.kill();
        await core.stop();
        globalThis.fetch = realFetch;
        Date.now = REAL_NOW;
        releaseLogs();
        await logsDone;
        rmSync(dirs.root, { recursive: true, force: true });
      },
    };
  });

  after(async () => {
    await journey?.stop();
  });

  test('a current message seeds a sourced entity through the persona’s memory session', async () => {
    // Bug: a line the core stored never becomes a structured fact, or the fact loses the line it rests on.
    await journey.unit.emit(member('m1', FIRST));
    await waitFor(
      () => rows('SELECT 1 FROM semantic_entities').length >= 2,
      () => `two seeded entities; ${why()}`,
      SESSION_AT
    );
    assert.deepEqual(journey.llm.problems, []);
    const evidence = rows(
      `SELECT s.text AS text FROM semantic_assertion_versions a
       JOIN claim_versions v ON v.id = a.version_id
       JOIN claim_version_sources cs ON cs.version_id = v.id
       JOIN sources s ON s.id = cs.source_id
      WHERE v.text = ?`,
      PART_OF
    );
    assert.deepEqual(
      evidence.map((row) => row.text),
      [FIRST]
    );
  });

  test('the owner reaches a sourced neighbour of the seeded entity through the graph', async () => {
    // Bug: the relation is stored but the graph walk from one entity does not reach the other, or loses the evidence.
    const lumen = entityIdOf('Lumen');
    const orbis = entityIdOf('Orbis');
    const version = String(
      rows("SELECT version_id FROM semantic_assertion_versions WHERE predicate_id = 'concept.part_of' LIMIT 1")[0]
        ?.version_id
    );
    const run = await runCli(journey.dirs, ['memory', 'graph', 'neighbors', graphNodeId('semantic_entity', lumen)]);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.stdout.includes(graphNodeId('semantic_entity', orbis)), 'Orbis is not a neighbour of Lumen');
    assert.ok(run.stdout.includes(version), 'the edge does not name the version that says it');
  });

  test('a contradicting message stores the doubted inference as disputed on its premise', async () => {
    // Bug: the premise is contradicted and the inference that rests on it still reads as current.
    // A session reads the facts as of the newest line of its batch, so the contradiction is stamped after the facts were
    // recorded: eleven clock minutes before now, with twelve clock minutes gone since the first session wrote them.
    const recorded = Date.parse(String(rows('SELECT MAX(recorded_at) AS at FROM claim_versions')[0]?.at));
    await waitFor(() => Date.now() - recorded > 12 * 60_000, 'twelve clock minutes after the first session', 30_000);
    await journey.unit.emit(member('m3', THIRD));
    await waitFor(
      () => rows('SELECT 1 FROM claim_versions WHERE text = ?', DOUBT).length > 0,
      () => `the disputed inference; ${why()}`,
      SESSION_AT
    );
    const state = rows(
      `SELECT a.truth_state AS state FROM semantic_assertion_versions a JOIN claim_versions v ON v.id = a.version_id
      WHERE v.text = ?`,
      DOUBT
    );
    assert.deepEqual(
      state.map((row) => row.state),
      ['disputed']
    );
  });

  test('a follow-up query reaches the persona’s turn with the facts the sessions stored', async () => {
    // Bug: the question is asked and the turn never gets the structured memory, so the persona answers from the chat history.
    // The log is named so the chains stay under the code-health depth (tests by the lead).
    const { entries } = journey.llm;
    const before = entries.length;
    await journey.unit.emit(mention('q1', QUESTION, Date.now() - SETTLED_MS));
    await waitFor(
      () => entries.slice(before).some((entry) => entry.text.includes(QUESTION)),
      'the follow-up turn request',
      SESSION_AT
    );
    const asked = entries.slice(before).find((entry) => entry.text.includes(QUESTION));
    followUp = asked?.text ?? '';
    assert.notEqual(followUp, '');
  });

  test('the follow-up request carries the stored relation in the persona’s own words', () => {
    // Bug: the prefetch finds the line but never offers the structured fact the session stored from it.
    assert.ok(followUp.includes(PART_OF), 'the request does not carry the stored fact');
  });

  test('the follow-up request shows the doubted inference as disputed', () => {
    // Bug: the state is stored but the turn's request drops it, so the persona repeats a doubted fact as a plain one.
    const at = followUp.indexOf(DOUBT);
    assert.ok(at >= 0, 'the request does not carry the doubted fact');
    assert.match(followUp.slice(Math.max(0, at - 120), at + DOUBT.length + 120), /disputed/);
  });

  test('a heartbeat with no place and no target ends handled without an error', async () => {
    // Bug: a wake with no destination fails on its missing place, or posts somewhere it was never pointed at.
    await waitFor(
      () => rows("SELECT 1 FROM wakes WHERE kind = 'heartbeat' AND state = 'handled'").length > 0,
      'a handled heartbeat wake',
      30_000
    );
    const failed = rows("SELECT 1 FROM wakes WHERE kind = 'heartbeat' AND state = 'failed'");
    assert.equal(failed.length, 0);
    const posts = journey.unit.posted('c1');
    assert.deepEqual(
      // Named so the chain stays under the code-health depth (tests by the lead).
      await posts.then((posted) => posted.filter((text) => text.includes('skip'))),
      []
    );
  });

  test('the owner export carries every semantic and graph row of the live database', async () => {
    // Bug: a table family added for the graph or the semantic facts is missing from the export or short in it.
    const dir = join(journey.dirs.root, 'out');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'export.jsonl');
    const run = await runCli(journey.dirs, ['memory', 'inspect', 'export', file]);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(existsSync(file));
    const exported = new Map<string, number>();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line === '') continue;
      const record = JSON.parse(line) as { kind: string; table?: string };
      if (record.kind === 'row' && record.table !== undefined)
        exported.set(record.table, (exported.get(record.table) ?? 0) + 1);
    }
    const tables = rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'semantic\\_%' ESCAPE '\\' OR name LIKE 'graph\\_%' ESCAPE '\\') ORDER BY name"
    ).map((row) => String(row.name));
    assert.ok(tables.includes('semantic_assertion_versions') && tables.includes('graph_edges'));
    for (const table of tables) {
      const live = Number(rows(`SELECT COUNT(*) AS n FROM "${table}"`)[0]?.n);
      assert.equal(exported.get(table) ?? 0, live, `${table}: the export and the database disagree`);
    }
  });
});
