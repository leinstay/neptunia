// Her `message.edit` and `message.delete` of her own line on the command line, end to end: `startCore` over temporary
// folders, the real `cli` interface package on the core's socket as a principal of kind `cli`, a scripted model, and
// the memory database read through a second, read-only connection once the writer has flushed. The model's tool calls
// are the only thing scripted. Synthetic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start as startCli } from '../interfaces/cli/link.ts';
import type { RunningCli } from '../interfaces/cli/link.ts';
import { startCore } from '../src/core.ts';
import { start as startFake } from '../src/interface/fake-interface.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { connectSocket } from '../src/protocol/wire.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { LogEntry } from './fixtures/capture-logs.ts';
import { chainsOf } from './fixtures/chains.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import type { Completion } from './fixtures/tool-answers.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const LABELS = JSON.parse(readFileSync(join(REPO, 'config', 'labels.json'), 'utf8')) as {
  model: { transcript: { edited: string } };
};
const { transcript: WORDS } = LABELS.model;
const EDITED = WORDS.edited;
const FIRST = 'the kettle is on 🙂';
const SECOND = 'the kettle is on';

type Row = Record<string, unknown>;
type Rig = {
  cli: RunningCli;
  printed: Array<string>;
  requests: Array<string>;
  rows: () => Array<Row>;
};

/** The scripted model: `script` answers the persona's requests in order; the address check says yes. */
function scripted(script: ReadonlyArray<Completion>, requests: Array<string>) {
  return {
    complete: (messages: unknown, given?: unknown): Promise<Completion> => {
      const purpose = (given as { purpose?: unknown } | undefined)?.purpose;
      if (purpose === 'address') return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      if (purpose === 'lookup' || purpose === 'elsewhere-pick')
        return Promise.resolve({ text: 'none', usage: {}, estimated: 1 });
      requests.push(JSON.stringify(messages));
      const answer = script[requests.length - 1];
      assert.ok(answer, 'the model must not make an unscripted request');
      return Promise.resolve(answer);
    },
  };
}

async function withCli(script: ReadonlyArray<Completion>, body: (rig: Rig) => Promise<void>): Promise<Array<LogEntry>> {
  const root = mkdtempSync(join(tmpdir(), 'ce-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: {
        timezone: 'UTC',
        owners: [],
        access: {
          'message.edit': { everyone: false, roles: [], users: ['self-id'] },
          'message.delete': { everyone: false, roles: [], users: ['self-id'] },
        },
      },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 500 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      tools: { loop: { maxSteps: 5, timeBudgetMs: 20000, maxCallsPerStep: 2 } },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  const made = spawnSync(process.execPath, ['scripts/client-token.ts', 'add', 'cli', '--kind', 'cli'], {
    cwd: REPO,
    env: { PATH: process.env.PATH, NEPTUNIA_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(made.status, 0, made.stderr);
  const requests: Array<string> = [];
  try {
    const { logs } = await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [{ name: 'fake', start: (host) => startFake(host, { selfId: 'self-id' }) }],
        llm: scripted(script, requests),
        embedder: { embed: () => Promise.resolve([]) },
      });
      const printed: Array<string> = [];
      const cli = await startCli({
        connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
        token: readFileSync(join(dataDir, 'clients', 'cli.token'), 'utf8').trim(),
        print: (text) => void printed.push(text),
      });
      try {
        await body({
          cli,
          printed,
          requests,
          rows: () => {
            const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
            try {
              // A line's message id is the one its message family holds; `native_id` is the writer's own key.
              const sql = `SELECT s.kind, s.revision, s.text, f.message_id FROM sources s
                JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
                AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
                WHERE s.kind IN ('seen', 'said', 'deleted') ORDER BY s.rowid`;
              return (handle.db as { prepare(sql: string): { all(): Array<Row> } })
                .prepare(sql)
                .all()
                .map((row) => ({ ...row }));
            } finally {
              handle.close();
            }
          },
        });
      } finally {
        await cli.stop();
        await core.stop();
      }
    });
    return logs;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Polls `read` until `ready` accepts it or three seconds pass (the writer flushes asynchronously). */
async function settled<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = read();
    if (ready(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The stored rows of the line the persona said first, oldest first: `[kind, revision, text]`. */
function historyOf(rows: Array<Row>): Array<[unknown, unknown, unknown]> {
  const said = rows.find((row) => row.kind === 'said');
  return rows.filter((row) => row.message_id === said?.message_id).map((row) => [row.kind, row.revision, row.text]);
}

const calledOk = (logs: Array<LogEntry>, skill: string): boolean =>
  logs.some((entry) => entry.msg === 'skills: called' && entry.skill === skill && entry.status === 'ok');

// Bug: her tool is refused on the command line and the owner's request to drop an emoji changes nothing; or the core
// drops the edit of a chat with no root, so the stored line keeps the old text and her next request shows it.
test('her message.edit of her own line on the command line stores revision 2 beside the old text and the next request shows it edited', async () => {
  let rows: Array<Row> = [];
  let after = '';
  const logs = await withCli(
    [
      toolAnswer(`<msg>${FIRST}</msg>`),
      toolAnswer('', [call('message.edit', { message: '#2', text: SECOND })]),
      toolAnswer('<skip/>'),
      toolAnswer('<msg>fine</msg>'),
    ],
    async (rig) => {
      await rig.cli.turn('hello there');
      await rig.cli.turn('drop the emoji');
      rows = await settled(rig.rows, (found) => historyOf(found).length >= 2);
      await rig.cli.turn('and now?');
      after = rig.requests[3] ?? '';
    }
  );
  assert.equal(calledOk(logs, 'message.edit'), true, 'the edit answered ok');
  assert.deepEqual(
    historyOf(rows).map(([, revision, text]) => [revision, text]),
    [
      [1, FIRST],
      [2, SECOND],
    ]
  );
  assert.ok(after.includes(`${SECOND} ${EDITED}`), 'the new text carries the edited mark');
  assert.equal(after.includes(FIRST), false, 'the old text is gone from the request');
});

// Bug: her deletion on the command line is refused, or the core drops it, so the stored line stays a line and the
// request keeps showing words she took back.
test('her message.delete of her own line on the command line stores it as deleted and the next request no longer holds the line', async () => {
  let rows: Array<Row> = [];
  let after = '';
  const logs = await withCli(
    [
      toolAnswer(`<msg>${FIRST}</msg>`),
      toolAnswer('', [call('message.delete', { message: '#2' })]),
      toolAnswer('<skip/>'),
      toolAnswer('<msg>fine</msg>'),
    ],
    async (rig) => {
      await rig.cli.turn('hello there');
      await rig.cli.turn('take that back');
      rows = await settled(rig.rows, (found) => found.some((row) => row.kind === 'deleted'));
      await rig.cli.turn('and now?');
      after = rig.requests[3] ?? '';
    }
  );
  assert.equal(calledOk(logs, 'message.delete'), true, 'the deletion answered ok');
  assert.deepEqual(
    historyOf(rows).map(([kind]) => kind),
    ['said', 'deleted']
  );
  assert.equal(after.includes(FIRST), false, 'her words left with the window');
  assert.ok(after.includes('#1 ') && after.includes('#3 '), 'the lines around hers stay under their numbers');
  assert.equal(after.includes('#2 '), false, 'her line, #2, is not a line of the window');
});
