// The watcher's read of what the services actually asked and answered (src/watcher/requests.ts over `model_requests`):
// the observation window on the engine clock, whole records paged under a bound, counts of what is left, and every gap
// named instead of filled in. Rows go through the single writer (`applyMemoryWrite`) or `archivedLlm`, into a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { archivedLlm, currentRequestMeta, withRequestMeta } from '../src/llm/archive.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { readRequests } from '../src/memory/db/request-archive.ts';
import { SESSION_PURPOSE } from '../src/memory/db/session.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import { memoryWriterClient } from '../src/subharness/memory-writer.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import type { ArchiveWriteGap, RecordedRequest, RecordedRunPage } from '../src/watcher/requests.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import { PLANTED_KEY } from './fixtures/watcher-rig.ts';
import fs from 'node:fs';

const requests = () => import('../src/watcher/requests.ts');

const at = (iso: string): number => Date.parse(iso);
const MIDNIGHT = at('2026-11-04T00:00:00Z');
const MINUTE = 60_000;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const WHOLE = { maxChars: 1_000_000 };

function freshDb(): { handle: MemoryHandle; file: string } {
  const file = path.join(tempDir('nep-requests-'), 'memory.db');
  return { handle: openMemoryDb(file), file };
}

type Row = {
  started: number;
  finished?: number | null;
  status?: 'ok' | 'failed';
  system?: string | null;
  messages?: ReadonlyArray<unknown>;
  response?: string | null;
  fields?: Record<string, unknown>;
  finish?: Record<string, unknown>;
};

/** One request through the writer: its `start`, and its `finish` unless `finished` is null. */
function put(handle: MemoryHandle, id: string, row: Row): void {
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'start',
    record: {
      id,
      at: row.started,
      system_text: row.system === undefined ? `system of ${id}` : row.system,
      messages: JSON.stringify(row.messages ?? [{ role: 'user', content: `asked in ${id}` }]),
      ...row.fields,
    },
  });
  if (row.finished === null) return;
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'finish',
    id,
    at: row.finished ?? row.started + MINUTE,
    status: row.status ?? 'ok',
    response_text: row.response === undefined ? `answer of ${id}` : row.response,
    ...row.finish,
  });
}

const idsOf = (page: RecordedRunPage): Array<string> =>
  page.runs.flatMap((run) => run.requests.map((request) => request.id));

const only = (page: RecordedRunPage): RecordedRequest =>
  page.runs[0]?.requests[0] ?? assert.fail('the page holds no request');

const ask = (system: string, user = 'hello'): Array<Record<string, unknown>> => [
  { role: 'system', content: system },
  { role: 'user', content: user },
];

const archiveOf = (handle: MemoryHandle, times: ReadonlyArray<number>) => {
  let n = 0;
  return {
    write: (update: Record<string, unknown>) => Promise.resolve(applyMemoryWrite(handle, update)),
    now: () => times[Math.min(n++, times.length - 1)] ?? 0,
    newId: () => `req-${n}`,
    log: SILENT,
  };
};

// ---- the observation window -----------------------------------------------------------------------------------------

test('the window opens at the previous successful inspection and closes now, with the current day beside it', async () => {
  // Bug: the window is "the UTC day", so a second inspection reads the morning again and a late run falls between days.
  const { observationInterval } = await requests();
  const now = MIDNIGHT + 300 * MINUTE;
  const previous = MIDNIGHT - 90 * MINUTE;
  assert.deepEqual(observationInterval({ now, previousSuccessAt: previous }), {
    from: previous,
    to: now,
    dayFrom: MIDNIGHT,
  });
});

test('with no earlier inspection the window opens at the start of the current day', async () => {
  // Bug: a first run reads the whole archive and never finishes, or reads nothing.
  const { observationInterval } = await requests();
  const now = MIDNIGHT + 300 * MINUTE;
  assert.deepEqual(observationInterval({ now, previousSuccessAt: null }), {
    from: MIDNIGHT,
    to: now,
    dayFrom: MIDNIGHT,
  });
});

test('several windows in a day each hold their own runs, and a run on the boundary lands in one', async () => {
  // Bug: two inspections of a day overlap, so a run is judged twice, or a boundary run is judged by neither.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const t1 = MIDNIGHT + 100 * MINUTE;
  const t2 = MIDNIGHT + 200 * MINUTE;
  put(handle, 'early', { started: t1 - 10 * MINUTE, finished: t1 - 5 * MINUTE });
  put(handle, 'edge', { started: t1 - MINUTE, finished: t1 });
  put(handle, 'late', { started: t1 + MINUTE, finished: t1 + 2 * MINUTE });
  const db = dbOf(handle);
  assert.deepEqual(idsOf(readRecordedRuns(db, { from: MIDNIGHT, to: t1, ...WHOLE })), ['early', 'edge']);
  assert.deepEqual(idsOf(readRecordedRuns(db, { from: t1, to: t2, ...WHOLE })), ['late']);
  handle.close();
});

test('a run crossing midnight belongs to the window it finished in, and to the view of the new day', async () => {
  // Bug: runs are picked by their start, so a run begun before an inspection and ended after it is never reviewed.
  const { currentDayView, readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'night', { started: MIDNIGHT - 10 * MINUTE, finished: MIDNIGHT + 10 * MINUTE });
  const db = dbOf(handle);
  assert.deepEqual(idsOf(readRecordedRuns(db, { from: MIDNIGHT - 60 * MINUTE, to: MIDNIGHT, ...WHOLE })), []);
  assert.deepEqual(idsOf(readRecordedRuns(db, { from: MIDNIGHT, to: MIDNIGHT + 60 * MINUTE, ...WHOLE })), ['night']);
  assert.deepEqual(idsOf(currentDayView(db, { now: MIDNIGHT + 60 * MINUTE, ...WHOLE })), ['night']);
  assert.deepEqual(idsOf(currentDayView(db, { now: MIDNIGHT - MINUTE, ...WHOLE })), []);
  handle.close();
});

test('the steps of one turn stay one run, in the window its last step finished in', async () => {
  // Bug: a tool loop cut at the boundary is judged half in each window, with its tool results on the far side.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const turn = { turn_id: 't1', attempt_id: 'a1' };
  put(handle, 'step-0', { started: MIDNIGHT + MINUTE, finished: MIDNIGHT + 2 * MINUTE, fields: { ...turn, step: 0 } });
  put(handle, 'step-1', {
    started: MIDNIGHT + 3 * MINUTE,
    finished: MIDNIGHT + 4 * MINUTE,
    fields: { ...turn, step: 1 },
  });
  const db = dbOf(handle);
  const before = readRecordedRuns(db, { from: MIDNIGHT, to: MIDNIGHT + 150_000, ...WHOLE });
  assert.equal(before.totalRuns, 0);
  const after = readRecordedRuns(db, { from: MIDNIGHT + 150_000, to: MIDNIGHT + 5 * MINUTE, ...WHOLE });
  assert.equal(after.totalRuns, 1);
  assert.deepEqual(idsOf(after), ['step-0', 'step-1']);
  handle.close();
});

test('a run still in flight is counted apart and is not called examined', async () => {
  // Bug: a pending row reads as a run with an empty answer, a failure that never happened.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'going', { started: MIDNIGHT + MINUTE, finished: null });
  put(handle, 'done', { started: MIDNIGHT + MINUTE, finished: MIDNIGHT + 2 * MINUTE });
  const page = readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE });
  assert.deepEqual(idsOf(page), ['done']);
  assert.equal(page.totalRuns, 1);
  assert.equal(page.inFlightRuns, 1);
  handle.close();
});

test('the current watcher invocation is left out and earlier watcher runs stay in', async () => {
  // Bug: the watcher reviews itself recursively, or drops the earlier runs it must compare with.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'mine', { started: MIDNIGHT + MINUTE, fields: { service: 'watcher', run_id: 'run-now' } });
  put(handle, 'older', { started: MIDNIGHT + MINUTE, fields: { service: 'watcher', run_id: 'run-before' } });
  const page = readRecordedRuns(dbOf(handle), {
    from: MIDNIGHT,
    to: MIDNIGHT + 9 * MINUTE,
    excludeRunId: 'run-now',
    ...WHOLE,
  });
  assert.deepEqual(idsOf(page), ['older']);
  assert.equal(page.totalRuns, 1);
  handle.close();
});

// ---- whole records and pages ----------------------------------------------------------------------------------------

test('a record comes back whole: system, messages, tools, tool results, response, usage', async () => {
  // Bug: the reader takes a summary or a clamp, so the watcher judges a prompt it did not see.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const long = 'ω'.repeat(40_000);
  put(handle, 'r', {
    started: MIDNIGHT + MINUTE,
    system: `SYSTEM ${long}`,
    messages: [
      { role: 'user', content: 'asked' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'recall' } }] },
      { role: 'tool', tool_call_id: 'c1', content: `TOOL-RESULT ${long}` },
    ],
    response: `ANSWER ${long}`,
    fields: { tools: JSON.stringify([{ name: 'TOOL-DEFINITION' }]) },
    finish: { usage: JSON.stringify({ total: 77 }), tool_calls: JSON.stringify([{ name: 'TOOL-CALL' }]) },
  });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.systemText, `SYSTEM ${long}`);
  assert.ok(String(request.messages).includes(`TOOL-RESULT ${long}`));
  assert.ok(String(request.tools).includes('TOOL-DEFINITION'));
  assert.ok(String(request.toolCalls).includes('TOOL-CALL'));
  assert.equal(request.responseText, `ANSWER ${long}`);
  assert.ok(String(request.usage).includes('77'));
  assert.equal(request.startedAt, new Date(MIDNIGHT + MINUTE).toISOString());
  handle.close();
});

test('a failed request comes back with its code', async () => {
  // Bug: only successes are readable, so a provider outage looks like a quiet day.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', {
    started: MIDNIGHT + MINUTE,
    status: 'failed',
    response: null,
    finish: { error_code: 'http_500' },
  });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.status, 'failed');
  assert.equal(request.errorCode, 'http_500');
  handle.close();
});

test('pages stay under the bound, hold every run once with no text cut, and count what is left', async () => {
  // Bug: the read cuts at one context and calls that the day, so a sample passes for the full review.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const ids = Array.from({ length: 7 }, (_, i) => `r${i}`);
  for (const [i, id] of ids.entries())
    put(handle, id, { started: MIDNIGHT + i * MINUTE, system: `${id} ${'λ'.repeat(1000)}` });
  const query = { from: MIDNIGHT, to: MIDNIGHT + 60 * MINUTE, maxChars: 5000 };
  const seen: Array<string> = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: RecordedRunPage = readRecordedRuns(dbOf(handle), { ...query, cursor });
    pages += 1;
    assert.ok(JSON.stringify(page.runs).length <= query.maxChars);
    for (const run of page.runs)
      for (const one of run.requests) assert.equal(one.systemText?.length, 1000 + one.id.length + 1);
    seen.push(...idsOf(page));
    assert.equal(page.totalRuns, 7);
    assert.equal(page.examinedRuns, seen.length);
    assert.equal(page.unreviewedRuns, 7 - seen.length);
    cursor = page.nextCursor;
  } while (cursor !== null && pages < 10);
  assert.ok(pages > 1);
  assert.deepEqual(seen, ids);
  handle.close();
});

test('a run larger than the bound comes alone and whole', async () => {
  // Bug: a huge prompt blocks the cursor for ever, or is the one record quietly cut.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'small', { started: MIDNIGHT + MINUTE });
  put(handle, 'huge', { started: MIDNIGHT + 2 * MINUTE, system: 'θ'.repeat(9000) });
  const query = { from: MIDNIGHT, to: MIDNIGHT + 60 * MINUTE, maxChars: 1000 };
  const first = readRecordedRuns(dbOf(handle), query);
  assert.deepEqual(idsOf(first), ['small']);
  const second = readRecordedRuns(dbOf(handle), { ...query, cursor: first.nextCursor });
  assert.deepEqual(idsOf(second), ['huge']);
  assert.equal(only(second).systemText?.length, 9000);
  assert.equal(second.nextCursor, null);
  handle.close();
});

test('the read works on a read-only connection and changes nothing', async () => {
  // Bug: the watcher's read goes through a second writer, which memory forbids, or marks pending rows on its way.
  const { readRecordedRuns } = await requests();
  const { handle, file } = freshDb();
  put(handle, 'done', { started: MIDNIGHT + MINUTE });
  put(handle, 'going', { started: MIDNIGHT + MINUTE, finished: null });
  const before = JSON.stringify(readRequests(dbOf(handle)));
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    assert.deepEqual(idsOf(readRecordedRuns(dbOf(reader), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE })), [
      'done',
    ]);
  } finally {
    reader.close();
  }
  assert.equal(JSON.stringify(readRequests(dbOf(handle))), before);
  handle.close();
});

// ---- credentials ------------------------------------------------------------------------------------------------------

test('transport headers and keys never reach the archive or the read', async () => {
  // Bug: the whole options object is kept for completeness, with the Authorization header in it.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const llm = archivedLlm(
    { complete: (_messages: unknown, _options?: unknown) => Promise.resolve({ text: 'ok' }) },
    archiveOf(handle, [MIDNIGHT + MINUTE])
  );
  await llm.complete(ask('s'), {
    model: 'm',
    apiKey: PLANTED_KEY,
    headers: { Authorization: `Bearer ${PLANTED_KEY}` },
  });
  const page = readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE });
  assert.equal(page.totalRuns, 1);
  assert.equal(JSON.stringify(page).includes(PLANTED_KEY), false);
  handle.close();
});

test('a credential inside a recorded tool result is masked in the read, named as a gap, and the text around it stays', async () => {
  // Bug: a tool that printed an environment hands the key to the watcher's backend account and from there to its report.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', {
    started: MIDNIGHT + MINUTE,
    messages: [{ role: 'tool', content: `before ${PLANTED_KEY} after` }],
    response: `it was ${PLANTED_KEY}`,
  });
  const page = readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE });
  const request = only(page);
  assert.equal(JSON.stringify(page).includes(PLANTED_KEY), false);
  assert.ok(String(request.messages).includes('before'));
  assert.ok(String(request.messages).includes('after'));
  assert.ok(request.gaps.includes('credential-masked'));
  handle.close();
});

// ---- gaps, never filled in ----------------------------------------------------------------------------------------

test('a picture kept as a marker is named as missing media', async () => {
  // Bug: the record reads as complete although the model saw an image the archive does not hold.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const llm = archivedLlm(
    { complete: (_messages: unknown, _options?: unknown) => Promise.resolve({ text: 'ok' }) },
    archiveOf(handle, [MIDNIGHT + MINUTE])
  );
  await llm.complete(
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } }] }],
    {}
  );
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.ok(request.gaps.includes('missing-media'));
  assert.equal(String(request.messages).includes('QUJDRA'), false);
  handle.close();
});

test('an archive write that failed is named in the page, with no content', async () => {
  // Bug: `keep` only logs the failure, so the request the provider saw is absent and the day reads complete.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const noted: Array<ArchiveWriteGap> = [];
  const llm = archivedLlm(
    { complete: (_messages: unknown, _options?: unknown) => Promise.resolve({ text: 'SECRET-ANSWER' }) },
    {
      write: () => Promise.reject(new Error('disk full')),
      now: () => MIDNIGHT + MINUTE,
      newId: () => 'lost',
      log: SILENT,
      noteGap: (gap) => noted.push(gap),
    }
  );
  await llm.complete(ask('SECRET-PROMPT'), { model: 'm', role: 'core' });
  const page = readRecordedRuns(dbOf(handle), {
    from: MIDNIGHT,
    to: MIDNIGHT + 9 * MINUTE,
    archiveGaps: noted,
    ...WHOLE,
  });
  assert.ok(page.gaps.some((gap) => gap.kind === 'archive-write-failed' && gap.requestId === 'lost'));
  assert.equal(JSON.stringify(page.gaps).includes('SECRET'), false);
  handle.close();
});

test('a tool result cut before the request is named as truncated', async () => {
  // Bug: the watcher judges "she ignored the evidence" when the evidence never reached her whole.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', {
    started: MIDNIGHT + MINUTE,
    messages: [{ role: 'tool', content: 'the head of it', truncated: true }],
  });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.ok(request.gaps.includes('truncated-tool-output'));
  handle.close();
});

test('a subprocess record declares the instructions and the transcript it cannot hold', async () => {
  // Bug: the brief and final answer of a CLI run read as its complete transcript.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', {
    started: MIDNIGHT + MINUTE,
    system: null,
    fields: { source: 'subprocess', service: 'dev', backend: 'claude', run_id: 'task-7' },
  });
  const page = readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE });
  const request = only(page);
  assert.equal(request.service, 'dev');
  assert.equal(request.backend, 'claude');
  assert.equal(request.runId, 'task-7');
  assert.ok(request.gaps.includes('vendor-instructions'));
  assert.ok(request.gaps.includes('absent-transcript'));
  handle.close();
});

test('a missing system text stays missing, named as a gap', async () => {
  // Bug: the reader fills the hole from today's prompt file, and an old run is judged against words it never saw.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', { started: MIDNIGHT + MINUTE, system: null });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.systemText, null);
  assert.ok(request.gaps.includes('missing-system-text'));
  handle.close();
});

test('an effective local prompt reads as it was sent, whatever a template says', async () => {
  // Bug: the review reads prompts/ and calls it what the run received, while prompts.local/ had replaced it.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const llm = archivedLlm(
    { complete: (_messages: unknown, _options?: unknown) => Promise.resolve({ text: 'ok' }) },
    archiveOf(handle, [MIDNIGHT + MINUTE])
  );
  const tracked = fs.readFileSync(new URL('../prompts/system-prompt.md', import.meta.url), 'utf8');
  await llm.complete(ask('LOCAL-OVERRIDE of the system prompt'), { model: 'm' });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.systemText, 'LOCAL-OVERRIDE of the system prompt');
  assert.notEqual(request.systemText, tracked);
  handle.close();
});

// ---- outcomes -----------------------------------------------------------------------------------------------------------

test('a successful response whose persistence failed is told apart from a confirmed one', async () => {
  // Bug: `status: ok` passes for the work being done, so a memory session that wrote nothing reads as healthy.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'lost', { started: MIDNIGHT + MINUTE });
  put(handle, 'kept', { started: MIDNIGHT + MINUTE });
  const outcome = (id: string, state: string): void => {
    applyMemoryWrite(handle, {
      kind: 'request-archive',
      op: 'outcome',
      id,
      outcome: { kind: 'memory-write', state, ref: `session-${id}` },
    });
  };
  outcome('lost', 'failed');
  outcome('kept', 'confirmed');
  const page = readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE });
  const of = (id: string) => page.runs.flatMap((run) => run.requests).find((request) => request.id === id);
  assert.equal(of('lost')?.status, 'ok');
  assert.deepEqual(of('lost')?.outcome, { kind: 'memory-write', state: 'failed', ref: 'session-lost' });
  assert.deepEqual(of('kept')?.outcome, { kind: 'memory-write', state: 'confirmed', ref: 'session-kept' });
  handle.close();
});

test('a response with no linked outcome says unlinked, never confirmed', async () => {
  // Bug: a missing link defaults to success, the agent's claim standing in for a receipt.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', { started: MIDNIGHT + MINUTE });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.deepEqual(request.outcome, { kind: 'none', state: 'unlinked', ref: null });
  handle.close();
});

test('a legitimate skip is an outcome, with no gap and no failure', async () => {
  // Bug: her choosing silence reads as a failed turn, and the watcher reports a defect in a quiet day.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', { started: MIDNIGHT + MINUTE, response: '<think>nothing to add</think>' });
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'outcome',
    id: 'r',
    outcome: { kind: 'skip', state: 'confirmed', ref: null },
  });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.status, 'ok');
  assert.equal(request.outcome.kind, 'skip');
  assert.deepEqual(request.gaps, []);
  handle.close();
});

test('an absent response, after a restart cut the run, is named and invents nothing', async () => {
  // Bug: the row reads like an empty answer, or the reader treats the unknown as a failure with a made-up code.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  put(handle, 'r', { started: MIDNIGHT + MINUTE, finished: null });
  applyMemoryWrite(handle, { kind: 'request-archive', op: 'interrupt', at: MIDNIGHT + 2 * MINUTE });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.status, 'unknown');
  assert.equal(request.responseText, null);
  assert.equal(request.errorCode, null);
  assert.ok(request.gaps.includes('absent-response'));
  handle.close();
});

// ---- what the archive records of each run -----------------------------------------------------------------------------

test('the turn names its service, run and backend on each row, and the effective model comes from the answer', async () => {
  // Bug: `model_requests` holds the requested model and no service, so a heartbeat and a reply cannot be told apart.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const llm = archivedLlm(
    {
      complete: (_messages: unknown, _options?: unknown) =>
        Promise.resolve({ text: 'ok', model: 'vendor/effective-model' }),
    },
    archiveOf(handle, [MIDNIGHT + MINUTE])
  );
  await withRequestMeta(async () => {
    Object.assign(currentRequestMeta() ?? {}, {
      turnId: 't1',
      attemptId: 'a1',
      service: 'heartbeat',
      runId: 'wake-9',
      backend: 'openrouter',
    });
    await llm.complete(ask('s'), { model: 'vendor/asked-model', role: 'core' });
  });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.service, 'heartbeat');
  assert.equal(request.runId, 'wake-9');
  assert.equal(request.backend, 'openrouter');
  assert.equal(request.model, 'vendor/effective-model');
  handle.close();
});

test('a memory session through a subharness records the backend and its model, and declares what it cannot hold', async () => {
  // Bug: the archive wraps the client from outside, so the row names the direct route's model for a run on another account.
  const { readRecordedRuns } = await requests();
  const { handle } = freshDb();
  const privateDir = tempDir('nep-requests-memory-');
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: {},
      models: {},
      uses: {},
      memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  const { binary } = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  const client = memoryWriterClient({
    writer: {
      privateDir,
      workDir: tempDir('nep-requests-work-'),
      runChild: () =>
        Promise.resolve({
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ result: 'WRITER-ANSWER', is_error: false, usage: {} }),
        }),
    },
    direct: { complete: () => assert.fail('the direct client is not asked') },
  });
  const llm = archivedLlm(client, archiveOf(handle, [MIDNIGHT + MINUTE]));
  await llm.complete(ask('MEMORY-SYSTEM'), { purpose: SESSION_PURPOSE, model: 'direct/route-model', role: 'memory' });
  const request = only(readRecordedRuns(dbOf(handle), { from: MIDNIGHT, to: MIDNIGHT + 9 * MINUTE, ...WHOLE }));
  assert.equal(request.systemText, 'MEMORY-SYSTEM');
  assert.equal(request.responseText, 'WRITER-ANSWER');
  assert.equal(request.backend, 'claude');
  assert.equal(request.model, 'claude-opus-4-6');
  assert.ok(request.gaps.includes('vendor-instructions'));
  assert.ok(request.gaps.includes('absent-transcript'));
  handle.close();
});
