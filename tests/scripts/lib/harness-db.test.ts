// The memory database edge of the reference harness (scripts/lib/harness-db.ts): a synthetic data folder cut at a
// corpus turn, the turn's kept lines written through the journal, a stored memory-session run replayed with its
// archived answer, every request it sent recorded, and every table hashed. Synthetic Greek and accented Latin text only; nothing leaves the process.

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDbEdge } from '../../../scripts/lib/harness-db.ts';
import { writeTurnRecords } from '../../../scripts/lib/harness-record.ts';
import type { TableHash } from '../../../scripts/lib/harness-db.ts';
import { fillEnvAudiences } from '../../fixtures/memory-db/audiences.ts';
import { CHANNEL, MINUTE, NOW, baseConfig, fixture, memoryBlock } from '../../fixtures/memory-db/session-rig.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TURN = 't-1';
const TURN_AT = NOW - 300 * MINUTE;

/** A line Ada wrote in the channel `minutesAgo` before NOW, as the record stores it. */
const heard = (n: number, minutesAgo: number, text: string): Record<string, unknown> => {
  const at = new Date(NOW - minutesAgo * MINUTE).toISOString();
  return {
    v: 1,
    id: `line-${n}`,
    kind: 'seen',
    messageId: `m${n}`,
    revision: 1,
    occurredAt: at,
    recordedAt: at,
    scope: { channel: 'c1' },
    by: 'u-ada',
    replyTo: null,
    text,
    media: [],
    mentions: [],
    direct: false,
    participants: ['u-ada'],
    sourceMessageIds: [`m${n}`],
    origin: 'live',
  };
};

/** A data folder whose memory holds five chat lines, the start of `TURN`, one session run after it and its answer. */
function dataFolder(session: Record<string, unknown> = {}): string {
  const dir = tempDir('nep-harness-db-data-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(
    path.join(dir, 'config', 'config.json'),
    JSON.stringify(baseConfig({ mode: 'apply', settleMinutes: 1, ...session }))
  );
  const env = fixture();
  try {
    // The chat after the cut, written as the live record writes it, one line at its own time.
    const texts = [
      'Καλημέρα, I like café mornings',
      'ναι, σωστά',
      'hey you there?',
      'ωραία',
      'I moved to Thessaloniki',
    ];
    texts.forEach((text, index) =>
      applyMemoryWrite(env.handle, {
        kind: 'record-lines',
        placeId: CHANNEL,
        lines: [heard(index + 1, 100 - index * 10, text)],
        iface: 'discord',
        now: NOW - (100 - index * 10) * MINUTE,
      })
    );
    fillEnvAudiences(env);
    const iso = (ms: number) => new Date(ms).toISOString();
    env.db
      .prepare("INSERT INTO day (id, at, what, place_id, turn_id) VALUES ('d-1', ?, 'turn.start', ?, ?)")
      .run(iso(TURN_AT), CHANNEL, TURN);
    env.db
      .prepare(
        `INSERT INTO session_runs (id, sweep_id, scope_key, scope_kind, scope_iface, mode, started_at, outcome)
         VALUES ('run:1', 'sweep:1', 'group:discord', 'group', 'discord', 'apply', ?, 'ok')`
      )
      .run(iso(NOW));
    const answer = memoryBlock({
      claims: [
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'moved to Thessaloniki', how: 'said', sources: ['#5'] },
      ],
    });
    env.db
      .prepare(
        `INSERT INTO model_requests (id, schema_version, purpose, status, started_at, messages, response_text)
         VALUES ('rq-1', 1, 'memory-session', 'ok', ?, '[]', ?)`
      )
      .run(iso(NOW + 1000), answer);
    env.db.exec(`VACUUM INTO '${path.join(dir, 'memory.db')}'`);
  } finally {
    env.done();
  }
  return dir;
}

/** The records of `TURN` as `turns` writes them: its start and one action line kept. */
function writeTurn(dir: string): void {
  const lines = [
    { kind: 'turn.start', placeId: CHANNEL, record: { placeId: 'c1', mode: 'reply', turnId: TURN, attemptId: 1 } },
    { kind: 'action', placeId: CHANNEL, record: { name: 'message.create', opId: 'op-replay-1', phase: 'started' } },
  ];
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  writeTurnRecords(dir, TURN, { requests: '', tools: '', actions: '', lines: text });
}

/** A `turns` run whose one turn kept its start and one action line. */
function turnsRun(): string {
  const dir = tempDir('nep-harness-db-turns-');
  writeTurn(dir);
  return dir;
}

async function recordOf(dataDir: string, turns: string, linesWaitMs = 30_000) {
  const out = tempDir('nep-harness-db-out-');
  const counts = await runDbEdge({
    root: ROOT,
    dataDir,
    fromTurn: TURN,
    turnIds: [TURN],
    turnsRun: turns,
    out,
    seed: 'a',
    linesWaitMs,
  });
  const read = (name: string) => fs.readFileSync(path.join(out, 'db', name), 'utf8');
  const requests = (name: string) => fs.readFileSync(path.join(out, 'db-requests', name), 'utf8');
  return { counts, out, read, requests, tables: JSON.parse(read('tables.json')) as Record<string, TableHash> };
}

test('writes the heard lines and the kept lines, and replays the stored session run with its archived answer', async () => {
  // Catches: a kept line or a session run left out of the replay, or a run answered with something else.
  const { counts, tables } = await recordOf(dataFolder(), turnsRun());
  assert.deepEqual(
    { turns: counts.turns, lines: counts.lines, failed: counts.failedLines, sessions: counts.sessions },
    { turns: 1, lines: 2, failed: 0, sessions: 1 }
  );
  assert.deepEqual(
    { heard: counts.heard, inexact: counts.inexact, unrebuilt: counts.unrebuilt },
    { heard: 5, inexact: 0, unrebuilt: 0 }
  );
  assert.deepEqual({ requests: counts.requests, past: counts.pastArchive }, { requests: 1, past: 0 });
  // The cut keeps the turn's own start; the replay adds its start and its action line.
  assert.equal(tables.day.rows, 3);
  assert.equal(tables.claims.rows, 1);
});

test('waits for a turn whose lines record the turns run writes after the replay started, and writes it', async () => {
  // Catches: db reading the turns run's lines before that run wrote them, so db cannot start beside turns.
  const turns = tempDir('nep-harness-db-turns-');
  const late = setTimeout(() => writeTurn(turns), 1500);
  try {
    const { counts, tables } = await recordOf(dataFolder(), turns);
    assert.deepEqual({ turns: counts.turns, lines: counts.lines }, { turns: 1, lines: 2 });
    assert.equal(tables.day.rows, 3);
  } finally {
    clearTimeout(late);
  }
});

test('keeps waiting past the bound while the turns run goes on writing the records of other turns', async () => {
  // Catches: a wait counted from the moment db reached the turn, which fails a turn late in the corpus order while
  // the turns run is still working through the turns before it.
  const data = dataFolder();
  const turns = tempDir('nep-harness-db-turns-');
  let written = 0;
  const others = setInterval(() => {
    written += 1;
    if (written <= 8)
      writeTurnRecords(turns, `t-other-${written}`, { requests: '', tools: '', actions: '', lines: '' });
    else {
      clearInterval(others);
      writeTurn(turns);
    }
  }, 250);
  try {
    const { counts } = await recordOf(data, turns, 600);
    assert.equal(counts.lines, 2);
  } finally {
    clearInterval(others);
  }
});

test('fails naming the turn when its lines record does not appear within the wait', async () => {
  // Catches: a db that waits forever on a turns run that stopped, or fails without saying which turn it waited for.
  const data = dataFolder();
  const turns = tempDir('nep-harness-db-turns-');
  const started = Date.now();
  await assert.rejects(recordOf(data, turns, 400), /lines record of turn t-1 did not appear within 400 ms/);
  // The cut and the replay before the turn take about a second here; a wait past its bound takes far longer.
  const took = Date.now() - started;
  assert.ok(took >= 400 && took < 10_000, `took ${took} ms`);
});

test('records the same tables and graph twice over two copies of one folder', async () => {
  // Catches: a random id or a wall time a writer stamps, which makes two runs of one tree differ.
  const data = dataFolder();
  const turns = turnsRun();
  const copy = tempDir('nep-harness-db-copy-');
  fs.cpSync(data, copy, { recursive: true });
  const first = await recordOf(data, turns);
  const second = await recordOf(copy, turns);
  assert.equal(second.read('tables.json'), first.read('tables.json'));
  assert.equal(second.read('graph.json'), first.read('graph.json'));
  assert.equal(second.read('claims.sha'), first.read('claims.sha'));
  assert.equal(second.requests('00001.jsonl'), first.requests('00001.jsonl'));
});

test('records each request a session run sent with its messages, model, purpose and options', async () => {
  // Catches: a request answered from the archive and never recorded, or recorded without what it was asked.
  const { requests } = await recordOf(dataFolder(), turnsRun());
  const lines = requests('00001.jsonl')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 1);
  const [request] = lines;
  assert.equal(request.purpose, 'memory-session');
  assert.equal(request.model, 'x/memory');
  assert.match(JSON.stringify(request.messages), /I moved to Thessaloniki/);
  const options = request.options as Record<string, unknown>;
  assert.equal(options.maxOutputTokens, 8000);
  assert.equal(options.role, 'memory');
});

test('records a changed request option while the tables stay equal', async () => {
  // Catches: equal tables taken for equal requests, when the session asked with another parameter.
  const turns = turnsRun();
  const first = await recordOf(dataFolder(), turns);
  const second = await recordOf(dataFolder({ maxOutputTokens: 7000 }), turns);
  assert.equal(second.read('tables.json'), first.read('tables.json'));
  assert.notEqual(second.requests('00001.jsonl'), first.requests('00001.jsonl'));
});

test('leaves out the leases and hashes model_requests without the measured columns', async () => {
  // Catches: a table that measures the run hashed, so no two runs ever compare identical.
  const { tables, out } = await recordOf(dataFolder(), turnsRun());
  assert.equal('leases' in tables, false);
  assert.equal(fs.existsSync(path.join(out, 'db', 'leases.sha')), false);
  assert.equal(fs.existsSync(path.join(out, 'db', 'model_requests.sha')), true);
});
