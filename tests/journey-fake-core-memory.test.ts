// The plan's S12.3 journey, end to end over the fake interface and a scripted model, with no Discord object. A member's
// message reaches the core through a fake interface unit. Her memory session (`memoryDb.session.mode: apply`) reads the
// settled line and the scripted memory model answers with an entity pair and a relation. A neighbour of the seeded entity
// is reached through the owner's graph read with its source line. A second member message is a follow-up query whose
// turn request carries the stored fact. A later message contradicts the premise: the session stores the inference as
// disputed on that premise, and the next follow-up shows it as disputed. The heartbeat runs with no place and no
// destination and ends handled. The owner exports the database and the rows of every semantic and graph table
// reconcile with the live database. The tests run in file order over one core, because each step is the state the next
// one reads; the model sees a real session request and a request that names no handle it could not have been shown
// fails the step with the reason in the timeout message. Synthetic text only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startCore } from '../src/core.ts';
import { onLog } from '../src/log.ts';
import { graphNodeId } from '../src/memory/db/graph.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';
import {
  CLI_CLIENT,
  FAKE_CLIENT,
  addClient,
  folders,
  mention,
  query,
  runCli,
  startedUnit,
} from './fixtures/core-units.ts';
import type { Core, Dirs, Row, Unit } from './fixtures/core-units.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

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
const member = (id: string, text: string) => lineEvent({ id, text, at: Date.now() - SETTLED_MS });
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
};

const textOf = (messages: unknown): string =>
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
    // She answers the question and reads the member statements without a reply: her own reply line is stamped now and
    // a session reads nothing behind a line younger than its settle time.
    if (purpose === 'address') return reply(textOf(messages).includes(QUESTION) ? 'yes' : 'no');
    if (purpose === 'lookup' || purpose === 'elsewhere-pick') return reply('none');
    // The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
    if (purpose === 'split') return reply('{"parts":[]}');
    const text = textOf(messages);
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
onLog((entry: object) => {
  const line = JSON.stringify(entry);
  if (/memory session|retriev/.test(line)) warnings.push(line.slice(0, 260));
});
let realFetch: typeof fetch = globalThis.fetch;
let releaseLogs: () => void = () => undefined;
let logsDone: Promise<unknown> = Promise.resolve();

before(async () => {
  const dirs = folders(CONFIG);
  for (const client of [FAKE_CLIENT, CLI_CLIENT]) addClient(dirs.privateDir, client);
  // The memory role runs on the core list of the key store. Its probe at the start is the only request to a provider,
  // and a fake answers it.
  writeKeysFile(dirs.privateDir, { core: [{ name: 'OPENROUTER_CORE_KEY', value: 'test-core-key' }] });
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

// The log is named so the chain stays under the code-health depth (tests by the lead).
const why = (): string => {
  const { llm } = journey;
  return `session problems: ${JSON.stringify(llm.problems)}; model purposes: ${llm.entries
    .map((entry) => entry.purpose)
    .join(
      ','
    )}; session runs: ${JSON.stringify(rows('SELECT scope_key, outcome FROM session_runs'))}; provider calls: ${providerCalls.length}; memory logs: ${warnings.join(' | ')}`;
};
const rows = (sql: string, ...args: Array<unknown>): Array<Row> => query(journey.dirs, sql, ...args);

const entityIdOf = (name: string): string => {
  const found = rows('SELECT DISTINCT entity_id FROM semantic_labels WHERE text = ?', name);
  assert.equal(found.length, 1, `no single entity named ${name}`);
  return String(found[0]?.entity_id);
};

test('a current message seeds a sourced entity through her memory session', async () => {
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

let followUp = '';

test('a follow-up query reaches her turn with the facts the sessions stored', async () => {
  // Bug: the question is asked and the turn never gets the structured memory, so she answers from the chat history.
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

test('the follow-up request carries the stored relation in her own words', () => {
  // Bug: the prefetch finds the line but never offers the structured fact the session stored from it.
  assert.ok(followUp.includes(PART_OF), 'the request does not carry the stored fact');
});

test('the follow-up request shows the doubted inference as disputed', () => {
  // Bug: the state is stored but the turn's request drops it, so she repeats a doubted fact as a plain one.
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
