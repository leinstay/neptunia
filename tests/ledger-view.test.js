// Tests for src/errands/ledger-view.js (the owner's read views of the ledger, every word from the
// labels) and for the `/nep status` card's ledger lines over a FAKE ledger socket
// (tests/fixtures/fake-ledger.js): the last five tasks of both lanes, newest first, the title cut
// to 60; `off` without a socket or an answer; nothing of it on a member's card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LEDGER_STATUS_COUNT, LEDGER_TITLE_CHARS, latestLedgerTasks, ledgerStatusLines, ledgerTaskText, ledgerTasksOf } from '../src/errands/ledger-view.js';
import { runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { labels } from './fixtures/labels.js';
import { startFakeLedger, deadSocket } from './fixtures/fake-ledger.js';

const DISCORD = createDiscordInterface().capabilities;
const OWNER = '42';
const MEMBER = '7';

/** Seven tasks of both lanes, created a minute apart, listed oldest first by the ledger. */
const SEVEN = Array.from({ length: 7 }, (_, i) => ({
  id: `T-${i}`,
  lane: i % 2 === 0 ? 'dev' : 'errand',
  status: 'done',
  title: i === 6 ? `a long title ${'mot très long '.repeat(8)}` : `task number ${i}`,
  created_at: new Date(Date.UTC(2026, 9, 17, 10, i)).toISOString(),
}));

test('ledgerTasksOf / latestLedgerTasks: an array or its tasks; the newest five by creation time; the ledger order without times', () => {
  assert.equal(ledgerTasksOf(SEVEN).length, 7);
  assert.equal(ledgerTasksOf({ tasks: SEVEN }).length, 7);
  assert.deepEqual(ledgerTasksOf({ nothing: true }), []);
  assert.deepEqual(latestLedgerTasks(SEVEN).map((task) => task.id), ['T-6', 'T-5', 'T-4', 'T-3', 'T-2']);
  assert.equal(LEDGER_STATUS_COUNT, 5);
  const untimed = SEVEN.map(({ created_at: _ignored, ...task }) => task);
  assert.deepEqual(latestLedgerTasks(untimed).map((task) => task.id), ['T-0', 'T-1', 'T-2', 'T-3', 'T-4']);
});

test('ledgerStatusLines: header and one line per task (title cut to 60); off on a failed read; empty without tasks; nothing without labels', () => {
  const lines = ledgerStatusLines({ ok: true, result: { tasks: SEVEN } }, labels);
  assert.equal(lines[0], 'ledger:');
  assert.equal(lines.length, 6);
  assert.equal(lines[2], 'T-5 | errand | done | task number 5');
  assert.ok(lines[1].startsWith('T-6 | dev | done | a long title mot très long'), lines[1]);
  const title = lines[1].split(' | ')[3];
  assert.ok([...title].length <= LEDGER_TITLE_CHARS && [...title].length > 50 && title.endsWith('…'), title);
  assert.deepEqual(ledgerStatusLines({ ok: false, code: 'off' }, labels), ['ledger: off']);
  assert.deepEqual(ledgerStatusLines({ ok: false, code: 'unreachable' }, labels), ['ledger: off']);
  assert.deepEqual(ledgerStatusLines({ ok: true, result: [] }, labels), ['ledger: empty']);
  assert.deepEqual(ledgerStatusLines({ ok: true, result: SEVEN }, {}), []);
});

/** One ledger task as `task.show --full` gives it (the lists beside the task). */
const SHOWN = {
  task: {
    id: 'T-q3moxl',
    lane: 'dev',
    status: 'done',
    title: 'replay and recall-eval: search availability',
    description: 'First line.\n\nSecond paragraph.',
    acceptance_criteria: 'tests pass',
    project: 'core',
    requester: 'lead',
    role: 'nep-implementer',
    created_at: '2026-10-17T16:30:00Z',
    updated_at: '2026-10-17T16:45:00Z',
    close_reason: 'merged',
  },
  attempts: [{ id: 'A-xing4j', role: 'nep-implementer', model: 'opus', outcome: 'done', steps: 24, cost_est_usd: 0.65, started_at: '2026-10-17T16:31:00Z', ended_at: '2026-10-17T16:33:10Z' }],
  results: [
    { kind: 'prompt', body: 'the whole prompt\nsecond line', attempt_id: 'A-xing4j', created_at: '2026-10-17T16:31:00Z' },
    { kind: 'spec', body: 'the spec', created_at: '2026-10-17T16:31:00Z' },
    { kind: 'pr', uri: 'https://example.org/pr/208', created_at: '2026-10-17T16:40:00Z' },
  ],
  questions: [{ id: 'Q1', asked_by: 'worker', text: 'which engine?', answer: 'the configured one', answered_by: 'lead', answered_at: '2026-10-17T16:32:00Z' }, { id: 'Q2', asked_by: 'worker', text: 'more?' }],
  events: [{ seq: 1, created_at: '2026-10-17T16:30:00Z', actor: 'lead', type: 'created' }, { seq: 2, created_at: '2026-10-17T16:31:00Z', actor: 'dispatcher', type: 'status', old: 'approved', new: 'in_progress' }],
};

test('ledgerTaskText: the task whole -- description, acceptance, attempts with cost, every result kind with its body, questions, events', () => {
  const text = ledgerTaskText(SHOWN, labels);
  const lines = text.split('\n');
  assert.equal(lines[0], 'T-q3moxl | dev | done | replay and recall-eval: search availability');
  assert.equal(lines[1], 'project core | requester lead | role nep-implementer | created 2026-10-17 16:30 UTC | updated 2026-10-17 16:45 UTC');
  assert.equal(lines[2], 'closed: merged');
  assert.ok(text.includes('description:\nFirst line.\n\nSecond paragraph.'), 'the description whole');
  assert.ok(text.includes('acceptance:\ntests pass'));
  assert.ok(text.includes('attempts:\nA-xing4j | nep-implementer | opus | done | 24 steps | 0.650 USD | 2026-10-17 16:31 UTC - 2026-10-17 16:33 UTC'));
  assert.ok(text.includes('[prompt] 2026-10-17 16:31 UTC | attempt A-xing4j\nthe whole prompt\nsecond line'), 'the prompt kind with its body');
  assert.ok(text.includes('[spec] 2026-10-17 16:31 UTC | attempt -\nthe spec'), 'the spec kind');
  assert.ok(text.includes('[pr] 2026-10-17 16:40 UTC | attempt -\nuri: https://example.org/pr/208'));
  assert.ok(text.includes('questions:\nQ Q1 (worker): which engine?\nA (lead, 2026-10-17 16:32 UTC): the configured one\nQ Q2 (worker): more?\nA: none yet'));
  assert.ok(text.endsWith('events:\n1 | 2026-10-17 16:30 UTC | lead | created\n2 | 2026-10-17 16:31 UTC | dispatcher | status approved -> in_progress'), text);
});

test('ledgerTaskText: the lists on the task itself, camelCase fields; an empty section says none; no labels gives nothing', () => {
  const text = ledgerTaskText({ id: 'T-2', lane: 'errand', state: 'failed', title: 't', acceptance: 'x', attempts: [{ id: 'A1', costUsd: 0.1 }], events: [] }, labels);
  assert.ok(text.startsWith('T-2 | errand | failed | t'));
  assert.ok(text.includes('description:\n(none)'));
  assert.ok(text.includes('acceptance:\nx'));
  assert.ok(text.includes('A1 | - | - | - | - steps | 0.100 USD | - - -'));
  assert.ok(text.includes('results:\n(none)'));
  assert.ok(text.endsWith('events:\n(none)'));
  assert.equal(ledgerTaskText(SHOWN, {}), '');
});

// ---- the status card ------------------------------------------------------------------

function makeEnv(socket) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-ledger-view-'));
  const hot = {
    config: { bot: { owners: [OWNER], access: { 'status.show': { everyone: true, roles: [], users: [] } } }, llm: { maxRequestsPerDay: 10 }, agents: { ledger: { socket } } },
    prompts: { labels },
    promptSources: {},
    rootDir,
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  return { env: createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => 'g1' }), hot };
}

const tasksField = async (env, userId) => {
  const result = await runOp('status.show', { field: 'tasks' }, { env, guildId: 'g1', userId, roleIds: [] });
  assert.equal(result.status, 'ok', result.summary);
  return result.data.embeds[0].fields.find((field) => field.name === 'tasks').value.split('\n');
};

test('status: the owner\'s tasks field lists the last five ledger tasks of both lanes through task.list; a member\'s has none of it', async () => {
  const ledger = await startFakeLedger((request) => (request.op === 'task.list' ? { ok: true, result: { tasks: SEVEN } } : { ok: false, error: 'unknown-op' }));
  try {
    const { env } = makeEnv(ledger.socket);
    const lines = await tasksField(env, OWNER);
    assert.deepEqual(lines.slice(0, 2), ['none', 'ledger:']);
    assert.deepEqual(lines.slice(2).map((line) => line.split(' | ')[0]), ['T-6', 'T-5', 'T-4', 'T-3', 'T-2']);
    assert.deepEqual(ledger.requests.map(({ op, args }) => [op, args]), [['task.list', { limit: 5 }]]);
    assert.deepEqual(await tasksField(env, MEMBER), ['none'], 'a member\'s card: no ledger read, no line');
    assert.equal(ledger.requests.length, 1);
  } finally {
    await ledger.close();
  }
});

test('status: without a socket, or with one nobody answers on, the owner\'s tasks field says ledger: off', async () => {
  const { env, hot } = makeEnv(null);
  assert.deepEqual(await tasksField(env, OWNER), ['none', 'ledger: off']);
  hot.config.agents.ledger.socket = deadSocket();
  assert.deepEqual(await tasksField(env, OWNER), ['none', 'ledger: off'], 'the socket read at the moment of use');
});
