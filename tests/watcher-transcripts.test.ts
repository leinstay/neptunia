// What the agents' subprocess runs recorded: Claude's session transcripts (`readTranscriptRuns` of
// src/watcher/transcripts.ts), the source the inventory names for thinker, dev, scout, server and watcher, and
// `neptunia services watcher evidence [--from <iso>] [--cursor <c>]`, the bounded read-only path the watcher agent calls.
// Transcripts are synthetic (tests/fixtures/claude-transcript.ts). The one real process runs the command line, with no core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../bin/neptunia-request.ts';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { ServiceAnswer } from '../src/service/commands.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RecordedRunPage } from '../src/watcher/requests.ts';
import {
  SESSION,
  answerRecord,
  blobRecord,
  oneRequest,
  requestRecord,
  shapeRecord,
  textBlob,
  writeFakeClaude,
  writeTranscript,
} from './fixtures/claude-transcript.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import { PLANTED_KEY } from './fixtures/watcher-rig.ts';

const transcripts = () => import('../src/watcher/transcripts.ts');
const lifecycle = () => import('../src/watcher/lifecycle.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO, 'bin', 'neptunia.ts');
const at = (iso: string): number => Date.parse(iso);
const FROM = at('2026-11-04T00:00:00Z');
const TO = at('2026-11-04T12:00:00Z');
const T1 = '2026-11-04T01:00:00.000Z';
const WINDOW = { from: FROM, to: TO, maxChars: 1_000_000 };

const requestsOf = (page: RecordedRunPage) => page.runs.flatMap((run) => run.requests);

// ---- the transcript as a source -------------------------------------------------------------------------------------

test('a transcript gives the effective system text, messages, tools, model, effort, answer and usage', async () => {
  // Bug: the review reads today's prompt template, while the record of what the CLI really sent sits unread on disk.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, [
    shapeRecord('shape-1', ['EFFECTIVE-SYSTEM vendor block', 'EFFECTIVE-SYSTEM agent brief'], ['Bash']),
    textBlob('b-sys', 'system', 'EFFECTIVE-SYSTEM reminder'),
    textBlob('b-user', 'user', 'ASKED'),
    blobRecord('b-result', 'user', [{ type: 'tool_result', tool_use_id: 'c1', content: 'TOOL-RESULT' }]),
    requestRecord('req-1', T1, { tail: ['b-sys', 'b-user', 'b-result'], model: 'model-real', effort: 'high' }),
    answerRecord('req-1', T1, 'ANSWERED'),
  ]);
  const page = readTranscriptRuns({ home, ...WINDOW });
  assert.equal(page.totalRuns, 1);
  const [request] = requestsOf(page);
  assert.equal(request?.backend, 'claude');
  assert.equal(request?.model, 'model-real');
  assert.equal(request?.effort, 'high');
  assert.equal(request?.runId, SESSION);
  assert.equal(request?.startedAt, T1);
  for (const part of ['vendor block', 'agent brief', 'reminder']) assert.ok(request?.systemText?.includes(part), part);
  assert.ok(String(request?.messages).includes('ASKED'));
  assert.ok(String(request?.messages).includes('TOOL-RESULT'));
  assert.ok(String(request?.tools).includes('Bash'));
  assert.equal(request?.responseText, 'ANSWERED');
  assert.ok(String(request?.usage).includes('11'));
  assert.deepEqual(request?.gaps, []);
});

test('a later request keeps the first `keep` messages of the one before it and adds its `tail`', async () => {
  // Bug: only the tail is read, so each step of a tool loop looks as if the model saw one message.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, [
    shapeRecord('shape-1', ['SYSTEM']),
    textBlob('b1', 'user', 'FIRST'),
    textBlob('b2', 'assistant', 'SECOND'),
    textBlob('b3', 'user', 'THIRD'),
    textBlob('b4', 'user', 'FOURTH'),
    requestRecord('req-1', T1, { tail: ['b1', 'b2', 'b3'] }),
    requestRecord('req-2', '2026-11-04T01:01:00.000Z', { keep: 2, tail: ['b4'] }),
  ]);
  const [, second] = requestsOf(readTranscriptRuns({ home, ...WINDOW }));
  const text = String(second?.messages);
  assert.ok(text.indexOf('FIRST') < text.indexOf('SECOND'));
  assert.ok(text.indexOf('SECOND') < text.indexOf('FOURTH'));
  assert.equal(text.includes('THIRD'), false);
});

test('a blob the transcript does not hold is a declared gap and nothing stands in for it', async () => {
  // Bug: a request with a hole reads as complete, or the hole is filled from the blob of another session.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, [
    shapeRecord('shape-1', ['SYSTEM']),
    textBlob('b1', 'user', 'HELD'),
    requestRecord('req-1', T1, { tail: ['b1', 'b-gone'] }),
    answerRecord('req-1', T1, 'ANSWERED'),
  ]);
  const [request] = requestsOf(readTranscriptRuns({ home, ...WINDOW }));
  assert.ok(request?.gaps.includes('missing-blob'));
  assert.ok(String(request?.messages).includes('HELD'));
});

test('a request whose shape and system blobs are gone says so, with no system text', async () => {
  // Bug: the reader takes the shape of another request, and the run is judged against instructions it never got.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, [
    shapeRecord('shape-other', ['ANOTHER SYSTEM']),
    textBlob('b1', 'user', 'ASKED'),
    requestRecord('req-1', T1, { shapeHash: 'shape-gone', tail: ['b1'] }),
    answerRecord('req-1', T1, 'ANSWERED'),
  ]);
  const [request] = requestsOf(readTranscriptRuns({ home, ...WINDOW }));
  assert.equal(request?.systemText, null);
  assert.ok(request?.gaps.includes('missing-system-text'));
});

test('a request with no answer record says absent-response and invents none', async () => {
  // Bug: a CLI killed mid-request reads as a run that answered with an empty text.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, [
    shapeRecord('shape-1', ['SYSTEM']),
    textBlob('b1', 'user', 'ASKED'),
    requestRecord('req-1', T1, { tail: ['b1'] }),
  ]);
  const [request] = requestsOf(readTranscriptRuns({ home, ...WINDOW }));
  assert.equal(request?.responseText, null);
  assert.ok(request?.gaps.includes('absent-response'));
});

test('a broken line is counted as a gap and the rest of the session still reads; other files are ignored', async () => {
  // Bug: one torn line from a killed CLI hides the whole session, or a stray file is parsed as one.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  const file = writeTranscript(home, [...oneRequest(T1), '{"type":"api-requ']);
  fs.writeFileSync(path.join(path.dirname(file), 'notes.txt'), 'not a session');
  const page = readTranscriptRuns({ home, ...WINDOW });
  assert.equal(requestsOf(page).length, 1);
  assert.ok(page.gaps.some((gap) => gap.kind === 'unreadable-line' && gap.count === 1));
});

test('a home with no transcripts is an empty page, not a failure', async () => {
  // Bug: an account that has not run yet makes the whole evidence read throw.
  const { readTranscriptRuns } = await transcripts();
  const page = readTranscriptRuns({ home: tempDir('nep-transcript-'), ...WINDOW });
  assert.equal(page.totalRuns, 0);
  assert.equal(page.nextCursor, null);
});

test('a session belongs to the window its last request falls in, crossing midnight included', async () => {
  // Bug: sessions are picked by file time or first request, so a night run is reviewed twice or never.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, [
    shapeRecord('shape-1', ['SYSTEM']),
    requestRecord('req-1', '2026-11-03T23:50:00.000Z'),
    requestRecord('req-2', '2026-11-04T00:10:00.000Z'),
  ]);
  const before = readTranscriptRuns({ home, ...WINDOW, from: at('2026-11-03T00:00:00Z'), to: FROM });
  assert.equal(before.totalRuns, 0);
  const after = readTranscriptRuns({ home, ...WINDOW });
  assert.equal(after.totalRuns, 1);
  assert.equal(requestsOf(after).length, 2);
});

test('the attribution names the service of a session, and a session it cannot place says so', async () => {
  // Bug: a dev run and a scout run share one account home, and the review cannot tell whose request it reads.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, oneRequest(T1, 'dev'), { project: '-work-dev' });
  writeTranscript(home, oneRequest(T1, 'lost'), { project: '-work-lost' });
  const page = readTranscriptRuns({
    home,
    ...WINDOW,
    attribute: (project) => (project === '-work-dev' ? 'dev' : null),
  });
  const of = (mark: string) => requestsOf(page).find((one) => one.id === `req-${mark}`);
  assert.equal(of('dev')?.service, 'dev');
  assert.deepEqual(of('dev')?.gaps, []);
  assert.equal(of('lost')?.service, null);
  assert.ok(of('lost')?.gaps.includes('unattributed-session'));
});

test('sessions page under the bound with the counts, and a named session is left out', async () => {
  // Bug: the read stops at one context and calls that the day, or the watcher reviews its own running session.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  const sessions = ['s1', 's2', 's3', 's4', 's5'];
  for (const session of sessions) {
    writeTranscript(home, oneRequest(T1, `${session} ${'λ'.repeat(1500)}`), { session });
  }
  writeTranscript(home, oneRequest(T1, 'MINE'), { session: 'mine' });
  const seen: Array<string> = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: RecordedRunPage = readTranscriptRuns({
      home,
      ...WINDOW,
      maxChars: 8000,
      excludeSessions: ['mine'],
      cursor,
    });
    pages += 1;
    assert.ok(JSON.stringify(page.runs).length <= 8000);
    seen.push(...page.runs.map((run) => run.requests[0]?.runId ?? ''));
    assert.equal(page.totalRuns, 5);
    assert.equal(page.unreviewedRuns, 5 - seen.length);
    cursor = page.nextCursor;
  } while (cursor !== null && pages < 10);
  assert.ok(pages > 1);
  assert.deepEqual([...seen].sort(), sessions);
});

test('a credential in a transcript is masked in the read and named as a gap', async () => {
  // Bug: a tool result that printed an environment hands the key to the watcher's account and from there to its report.
  const { readTranscriptRuns } = await transcripts();
  const home = tempDir('nep-transcript-');
  writeTranscript(home, [
    shapeRecord('shape-1', ['SYSTEM']),
    blobRecord('b1', 'user', [{ type: 'tool_result', tool_use_id: 'c1', content: `before ${PLANTED_KEY} after` }]),
    requestRecord('req-1', T1, { tail: ['b1'] }),
    answerRecord('req-1', T1, `it was ${PLANTED_KEY}`),
  ]);
  const page = readTranscriptRuns({ home, ...WINDOW });
  assert.equal(JSON.stringify(page).includes(PLANTED_KEY), false);
  const [request] = requestsOf(page);
  assert.ok(String(request?.messages).includes('before'));
  assert.ok(request?.gaps.includes('credential-masked'));
});

// ---- the run-to-session mapping -------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HELP_WITH = '  --resume <session-id>  Resume\n  --session-id <uuid>    Use a specific session ID';
const HELP_WITHOUT = '  --resume <session-id>  Resume a chat by its session-id';

function installed(help: string | null, subharness: Record<string, unknown> = {}) {
  const privateDir = tempDir('nep-session-');
  writeKeysFile(privateDir, {
    subharness: { backends: ['claude'], key: null, modes: {}, models: {}, uses: {}, ...subharness },
  });
  const argvFile = path.join(privateDir, 'argv');
  writeFakeClaude(subharnessPlace(privateDir, 'claude').binary, argvFile, help);
  const deps = { privateDir, denyDir: tempDir('nep-session-deny-') };
  const run = { agent: 'dev', brief: 'THE-BRIEF', cwd: privateDir, timeoutMs: 5_000 };
  const argv = (): Array<string> => fs.readFileSync(argvFile, 'utf8').split('\n');
  return { privateDir, deps, run, argv };
}

test('a claude run gets a fresh --session-id when its help lists it, and the mapping names the agent and the run', async () => {
  // Bug: one account home holds every agent's sessions, so a transcript cannot be tied to the run that made it.
  const { readSessionMap } = await import('../src/subharness/sessions.ts');
  const { privateDir, deps, run, argv } = installed(HELP_WITH);
  const done = await runAgent({ ...run, runId: 'task-7' }, deps);
  assert.equal(done.ok, true);
  const args = argv();
  const id = args[args.indexOf('--session-id') + 1] ?? '';
  assert.match(id, UUID);
  assert.equal(done.sessionId, id);
  const [row] = readSessionMap(privateDir);
  assert.equal(row?.sessionId, id);
  assert.equal(row?.agent, 'dev');
  assert.equal(row?.backend, 'claude');
  assert.equal(row?.runId, 'task-7');
});

test('two runs get two session ids, both on the map', async () => {
  // Bug: the id is computed once per process, and the second run's --session-id collides with the first's transcript.
  const { readSessionMap } = await import('../src/subharness/sessions.ts');
  const { privateDir, deps, run } = installed(HELP_WITH);
  await runAgent(run, deps);
  await runAgent({ ...run, agent: 'scout' }, deps);
  const rows = readSessionMap(privateDir);
  assert.deepEqual(
    rows.map((row) => row.agent),
    ['dev', 'scout']
  );
  assert.notEqual(rows[0]?.sessionId, rows[1]?.sessionId);
});

test('a run on a task route gets its session id too, with keys.json closed', async () => {
  // Bug: only the keys.json path sets the flag, so every dev task, which carries a route, stays unattributed.
  const { readSessionMap } = await import('../src/subharness/sessions.ts');
  const { privateDir, deps, run, argv } = installed(HELP_WITH);
  fs.rmSync(path.join(privateDir, 'keys.json'));
  const route = { backend: 'claude', model: 'model-r', effort: null, mode: 'write' } as const;
  const done = await runAgent({ ...run, route }, deps);
  assert.equal(done.ok, true);
  assert.ok(argv().includes('--session-id'));
  assert.equal(readSessionMap(privateDir)[0]?.agent, 'dev');
});

for (const [name, help] of [
  ['does not list the flag', HELP_WITHOUT],
  ['cannot be read', null],
] as const) {
  test(`a claude whose help ${name} runs without the flag, and the map stays empty`, async () => {
    // Bug: an older CLI dies on an unknown flag, or the words `<session-id>` under --resume pass for the flag.
    const { readSessionMap } = await import('../src/subharness/sessions.ts');
    const { privateDir, deps, run, argv } = installed(help);
    const done = await runAgent(run, deps);
    assert.equal(done.ok, true);
    assert.equal(argv().includes('--session-id'), false);
    assert.equal(done.sessionId, undefined);
    assert.deepEqual(readSessionMap(privateDir), []);
  });
}

for (const backend of ['codex', 'opencode'] as const) {
  test(`${backend} gets no session id and no row`, async () => {
    // Bug: the claude flag reaches another CLI, which refuses it and fails the run.
    const { readSessionMap } = await import('../src/subharness/sessions.ts');
    const { privateDir, deps, run } = installed(HELP_WITH);
    const seen: Array<Record<string, unknown>> = [];
    const done = await runAgent(
      { ...run, route: { backend, model: 'm', effort: null, mode: 'read' }, routeKey: 'k' },
      {
        ...deps,
        backendFactory: (name) => ({
          name,
          run: (_brief, options) => {
            seen.push({ ...options });
            return Promise.resolve({ ok: true, text: 'x', exitCode: 0 });
          },
        }),
      }
    );
    assert.equal(done.ok, true);
    assert.equal(seen[0]?.sessionId, undefined);
    assert.deepEqual(readSessionMap(privateDir), []);
  });
}

// ---- service watcher evidence --------------------------------------------------------------------------------------

type Rig = { data: string; home: string; calls: Array<string> };

function rig(options: { db?: boolean } = {}): Rig {
  const data = tempDir('nep-evidence-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), JSON.stringify({ watcher: { enabled: true, schedule: 'at 06:00' } }));
  fs.mkdirSync(path.join(data, 'agents', 'watcher', 'reports'), { recursive: true });
  const home = path.join(subharnessPlace(data, 'claude').dir, 'home');
  if (options.db !== false) openMemoryDb(path.join(data, 'memory.db')).close();
  return { data, home, calls: [] };
}

function putRow(where: Rig, id: string, started: number, fields: Record<string, unknown> = {}): void {
  const handle = openMemoryDb(path.join(where.data, 'memory.db'));
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'start',
    record: { id, at: started, system_text: `ROW-SYSTEM ${id}`, messages: '[]', ...fields },
  });
  applyMemoryWrite(handle, { kind: 'request-archive', op: 'finish', id, at: started + 1000, status: 'ok' });
  handle.close();
}

type Evidence = RecordedRunPage & { interval: { from: string; to: string } };

async function evidence(where: Rig, flags: Record<string, unknown> = {}, now = TO) {
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: where.data,
      dataDir: where.data,
      config: () => readConfig(REPO, { privateDir: where.data }),
      now: () => now,
      env: { NEPTUNIA_UNIT_SCOPE: 'user' },
      coreUp: false,
      run: (command, list) => {
        where.calls.push([command, ...list].join(' '));
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    },
    'services.watcher.evidence',
    flags
  );
  return { answer, page: answer.status === 'ok' ? (JSON.parse(answer.text) as Evidence) : null };
}

test('evidence joins the recorded requests and the transcripts of the window, with the core down', async () => {
  // Bug: the agent gets one of the two sources, so a dev run or a reply is missing from the review with no sign of it.
  const where = rig();
  putRow(where, 'row-1', FROM + 60_000, { service: 'core' });
  writeTranscript(where.home, oneRequest(T1, 'dev'));
  const { answer, page } = await evidence(where, { from: new Date(FROM).toISOString() });
  assert.equal(answer.status, 'ok', answer.text.slice(0, 200));
  const ids = page?.runs.flatMap((run) => run.requests.map((one) => one.id)) ?? [];
  assert.deepEqual([...ids].sort(), ['req-dev', 'row-1']);
  assert.equal(page?.totalRuns, 2);
  assert.deepEqual(page?.interval, { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() });
});

test('evidence with no --from opens at the last successful inspection', async () => {
  // Bug: every call starts from midnight, so a second inspection reads the morning again.
  const { claimRun, finishRun } = await lifecycle();
  const where = rig();
  const last = TO - 3_600_000;
  const store = {
    dir: path.join(where.data, 'agents', 'watcher'),
    now: () => last,
    newRunId: () => 'run-before',
    processStart: () => 'x',
  };
  const { run } = claimRun(store, { source: 'timer', owner: { pid: 1, startId: 'x' }, timeoutMs: 1000 });
  finishRun(store, run.runId, { state: 'succeeded' });
  putRow(where, 'old', last - 60_000);
  putRow(where, 'new', last + 60_000);
  const { page } = await evidence(where);
  assert.equal(page?.interval.from, new Date(last).toISOString());
  assert.deepEqual(
    page?.runs.flatMap((one) => one.requests.map((request) => request.id)),
    ['new']
  );
});

test('evidence walks the two sources by its cursor under the bound, and reports what is left', async () => {
  // Bug: the cursor covers one source, so the second is cut off or repeated on each page.
  const { WATCHER_EVIDENCE_MAX_CHARS } = await import('../src/watcher/requests.ts');
  const where = rig();
  const big = 'θ'.repeat(Math.ceil(WATCHER_EVIDENCE_MAX_CHARS / 3));
  for (const id of ['r1', 'r2']) putRow(where, id, FROM + 60_000, { system_text: `${id} ${big}` });
  for (const session of ['s1', 's2']) writeTranscript(where.home, oneRequest(T1, `${session} ${big}`), { session });
  const from = new Date(FROM).toISOString();
  const seen: Array<string> = [];
  let cursor: string | undefined;
  let pages = 0;
  for (; pages < 10; pages += 1) {
    const done: { answer: ServiceAnswer; page: Evidence | null } = await evidence(where, {
      from,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const page = done.page ?? assert.fail(done.answer.text.slice(0, 200));
    assert.ok(page.runs.length === 1 || JSON.stringify(page.runs).length <= WATCHER_EVIDENCE_MAX_CHARS);
    seen.push(...page.runs.map((run) => run.runKey));
    assert.equal(page.totalRuns, 4);
    assert.equal(page.examinedRuns, seen.length);
    assert.equal(page.unreviewedRuns, 4 - seen.length);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.ok(pages > 0);
  assert.equal(new Set(seen).size, 4);
});

test('evidence leaves out the current inspection', async () => {
  // Bug: the watcher reviews the request it is in the middle of, recursively.
  const { claimRun, defaultProcessStart } = await lifecycle();
  const where = rig();
  const store = {
    dir: path.join(where.data, 'agents', 'watcher'),
    now: () => TO,
    newRunId: () => 'run-now',
    processStart: defaultProcessStart,
  };
  const owner = { pid: process.pid, startId: defaultProcessStart(process.pid) ?? '' };
  claimRun(store, { source: 'timer', owner, timeoutMs: 3_600_000 });
  putRow(where, 'mine', FROM + 60_000, { service: 'watcher', run_id: 'run-now' });
  putRow(where, 'other', FROM + 60_000, { service: 'core' });
  const { page } = await evidence(where, { from: new Date(FROM).toISOString() });
  assert.deepEqual(
    page?.runs.flatMap((one) => one.requests.map((request) => request.id)),
    ['other']
  );
});

test('evidence names each session by the map, leaves out the running watcher session, keeps earlier ones', async () => {
  // Bug: the watcher reads its own transcript as it grows, or a dev session reads as nobody's.
  const { recordSession } = await import('../src/subharness/sessions.ts');
  const { claimRun, defaultProcessStart } = await lifecycle();
  const where = rig();
  const store = {
    dir: path.join(where.data, 'agents', 'watcher'),
    now: () => TO,
    newRunId: () => 'run-now',
    processStart: defaultProcessStart,
  };
  const owner = { pid: process.pid, startId: defaultProcessStart(process.pid) ?? '' };
  claimRun(store, { source: 'timer', owner, timeoutMs: 3_600_000 });
  const rows = [
    { sessionId: 's-now', agent: 'watcher', backend: 'claude', runId: 'run-now', at: FROM },
    { sessionId: 's-before', agent: 'watcher', backend: 'claude', runId: 'run-before', at: FROM },
    { sessionId: 's-dev', agent: 'dev', backend: 'claude', runId: 'task-7', at: FROM },
  ];
  for (const row of rows) recordSession(where.data, row);
  for (const session of ['s-now', 's-before', 's-dev', 's-lost']) {
    writeTranscript(where.home, oneRequest(T1, session), { session });
  }
  const { page } = await evidence(where, { from: new Date(FROM).toISOString() });
  const requests = page?.runs.flatMap((run) => run.requests) ?? [];
  const of = (session: string) => requests.find((one) => one.runId === session);
  assert.equal(of('s-now'), undefined);
  assert.equal(of('s-before')?.service, 'watcher');
  assert.equal(of('s-dev')?.service, 'dev');
  assert.equal(of('s-lost')?.service, null);
  assert.ok(of('s-lost')?.gaps.includes('unattributed-session'));
});

test('evidence with no memory database still gives the transcripts, and names what it could not read', async () => {
  // Bug: a missing or locked database makes the watcher blind to the subprocess runs too, exactly on a bad day.
  const where = rig({ db: false });
  writeTranscript(where.home, oneRequest(T1, 'dev'));
  const { answer, page } = await evidence(where, { from: new Date(FROM).toISOString() });
  assert.equal(answer.status, 'ok', answer.text.slice(0, 200));
  assert.equal(page?.totalRuns, 1);
  assert.ok(page?.gaps.some((gap) => gap.kind === 'memory-unavailable'));
  assert.equal(fs.existsSync(path.join(where.data, 'memory.db')), false, 'the read creates no database');
});

for (const [name, flags, flag] of [
  ['a --from that is no date', { from: 'yesterday' }, '--from'],
  ['a --cursor that means nothing', { cursor: '../../keys' }, '--cursor'],
] as const) {
  test(`evidence refuses ${name} as invalid`, async () => {
    // Bug: a bad bound falls back to the whole archive, and one mistyped call reads everything.
    const { answer } = await evidence(rig(), flags);
    assert.equal(answer.status, 'invalid');
    assert.ok(answer.text.includes(flag), answer.text.slice(0, 200));
  });
}

test('evidence writes nothing, starts nothing, asks no model and shows no credential', async () => {
  // Bug: the "read" recovers pending rows through a second writer, or learns the source by asking the backend.
  const where = rig();
  putRow(where, 'row-1', FROM + 60_000, { system_text: `leak ${PLANTED_KEY}` });
  const file = writeTranscript(where.home, oneRequest(T1, 'dev'));
  const before = fs.readFileSync(file, 'utf8');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => {
    fetched += 1;
    return Promise.reject(new Error('no network in a read'));
  };
  try {
    const { answer, page } = await evidence(where, { from: new Date(FROM).toISOString() });
    assert.equal(page?.totalRuns, 2);
    assert.equal(answer.text.includes(PLANTED_KEY), false);
    assert.equal(fetched, 0);
    // Changed: evidence now carries the trash, whose reads go through `run`. What must stay true is that none of them changes anything.
    for (const call of where.calls)
      assert.doesNotMatch(call, /\b(start|stop|enable|disable|restart|prune|clean|remove)\b/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const [form, parsed] of [
  [
    'neptunia services',
    () => parseRequest(['services', 'watcher', 'evidence', '--from', '2026-11-04T00:00:00Z', '--cursor', 'c1']).parsed,
  ],
  ['neptunia -p', () => parseCommandLine('/services watcher evidence --from 2026-11-04T00:00:00Z --cursor c1')],
] as const) {
  test(`${form} parses evidence with its two flags`, () => {
    // Bug: the handler exists and the table does not hold it, so the agent's call answers usage.
    const done = parsed();
    assert.ok(done.ok, done.ok ? '' : done.reason);
    assert.equal(done.name, 'services.watcher.evidence');
    assert.deepEqual(done.args, { from: '2026-11-04T00:00:00Z', cursor: 'c1' });
  });
}

test('the real command line answers evidence as JSON, with no core and no board', () => {
  // Bug: the shell routes evidence to the running core, and the agent's call fails exactly when the core is down.
  const where = rig();
  writeTranscript(where.home, oneRequest(new Date(Date.now() - 60_000).toISOString(), 'dev'));
  const home = tempDir('nep-evidence-home-');
  // Changed: evidence asks `gh` for the CI of main, so a refusing stand-in keeps this test off the network.
  const refusing = tempDir('nep-evidence-bin-');
  for (const tool of ['gh', 'sudo', 'systemctl']) {
    fs.writeFileSync(path.join(refusing, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const done = spawnSync(
    process.execPath,
    [BIN, 'services', 'watcher', 'evidence', '--from', new Date(Date.now() - 3_600_000).toISOString()],
    {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 6_000,
      env: {
        PATH: `${refusing}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: process.env.TMPDIR,
        NEPTUNIA_DATA_DIR: where.data,
      },
    }
  );
  assert.equal(done.status, 0, String(done.stderr).slice(0, 300));
  const page = JSON.parse(done.stdout) as Evidence;
  assert.equal(page.totalRuns, 1);
  assert.equal(page.runs[0]?.requests[0]?.id, 'req-dev');
  assert.equal(page.runs[0]?.requests[0]?.backend, 'claude');
});

const NOW = Date.parse('2026-11-04T10:00:00Z');

/** A persona folder with an empty local config, the way the family expects one. */
function folder(): string {
  const data = tempDir('nep-watcher-scenario-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  return data;
}

/** One action of the `services watcher` family over `data`, every command the family runs answering "denied". */
function family(data: string, action: string, args: Record<string, unknown> = {}): Promise<ServiceAnswer> {
  return serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => NOW,
      env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
      coreUp: false,
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'permission denied' }),
    },
    `services.watcher.${action}`,
    args
  );
}

test('the first page of evidence gives a null, not a zero count, for what the memory database could not answer', async () => {
  // Bug: `audit` and `standards` default to empty counts, and the agent reports a clean memory it never read.
  const data = folder();
  const answer = await family(data, 'evidence');
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  const page = JSON.parse(answer.text) as Record<string, unknown>;
  assert.equal(page.audit, null);
  assert.equal(page.standards, null);
});
