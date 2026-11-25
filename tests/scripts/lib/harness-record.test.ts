// The records of one harness turn (scripts/lib/harness-record.ts): each request as the client got it, each tool call
// the gate answered and each journal action line, and each interface action, one JSON line each, with no time a run
// measures and no path of the machine that ran it.

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnRecords, writeTurnRecords } from '../../../scripts/lib/harness-record.ts';
import type { TurnRun } from '../../../scripts/lib/harness-record.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const SCRATCH = '/var/tmp/nep-turn-replay-Xy12';

/** A run of one turn that asked twice, ran one read, kept one post and typed before it sent. */
function run(): TurnRun {
  const request = (purpose: string, text: string) => ({
    purpose,
    model: 'm-1',
    messages: [{ role: 'user', content: text }],
    tools: [],
    startedAt: 1_772_000_000_000,
    ms: 41,
    text: '',
    toolCalls: [],
    error: null,
    options: { toolChoice: 'auto', temperature: 0.4 },
  });
  return {
    requests: [request('split', 'Γεια'), request('reply', 'Τι κάνεις')],
    gateway: [
      {
        op: 'memory.recent.read',
        args: { place: 'γενικό' },
        ran: true,
        result: { status: 'ok', data: { text: `${SCRATCH}/a.png` } },
      },
      { op: 'message.create', args: { text: 'Καλά' }, ran: false, result: { status: 'ok', data: { text: '' } } },
    ],
    journal: [
      { kind: 'turn.start', placeId: 'p-1', record: {} },
      { kind: 'action', placeId: 'p-1', record: { opId: 'op-replay-2', phase: 'proposed' } },
    ],
    writes: [
      { op: 'typing', at: 1_772_000_000_123, args: [{ iface: 'fake', chatId: '1' }, { untilMs: 5 }] },
      { op: 'send', at: 1_772_000_000_456, args: [{ iface: 'fake', chatId: '1' }, { text: 'Καλά' }] },
    ],
    end: 'spoke',
  };
}

const lines = (text: string): Array<Record<string, unknown>> =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test('keeps each request as the client got it, its options included, without the times the run measured', () => {
  // Catches: a record that holds a request's start or duration, so two identical runs never compare equal, or one
  // that drops an option such as the tool choice, so a changed request compares equal.
  const records = turnRecords(run(), [SCRATCH]);
  const options = { toolChoice: 'auto', temperature: 0.4 };
  assert.deepEqual(lines(records.requests), [
    { purpose: 'split', model: 'm-1', messages: [{ role: 'user', content: 'Γεια' }], tools: [], options },
    { purpose: 'reply', model: 'm-1', messages: [{ role: 'user', content: 'Τι κάνεις' }], tools: [], options },
  ]);
});

test('names each tool call with whether it ran, its status and its result, then the journal action lines', () => {
  // Catches: a kept call recorded as run, or the scratch folder of one run leaking into its record.
  const records = turnRecords(run(), [SCRATCH]);
  const [read, post, action] = lines(records.tools);
  assert.deepEqual(
    [read.name, read.ran, read.status, post.name, post.ran, post.status],
    ['memory.recent.read', 'ran', 'ok', 'message.create', 'kept', 'ok']
  );
  assert.equal(records.tools.includes(SCRATCH), false);
  assert.deepEqual(action, {
    source: 'journal',
    kind: 'action',
    placeId: 'p-1',
    record: { opId: 'op-replay-2', phase: 'proposed' },
  });
});

test('keeps the interface actions in order with no time, and the way the turn ended last', () => {
  // Catches: typing dropped from the record, or a wall time kept on each action.
  const records = turnRecords(run(), [SCRATCH]);
  assert.deepEqual(lines(records.actions), [
    { op: 'typing', args: [{ iface: 'fake', chatId: '1' }, { untilMs: 5 }] },
    { op: 'send', args: [{ iface: 'fake', chatId: '1' }, { text: 'Καλά' }] },
    { end: 'spoke' },
  ]);
});

test('writes each record under its edge, named by the turn', () => {
  // Catches: records written where compare does not look, `<run>/<edge>/<turnId>.jsonl`.
  const out = tempDir('nep-harness-record-');
  writeTurnRecords(out, 't-1', turnRecords(run(), [SCRATCH]));
  assert.deepEqual(
    ['requests', 'tools', 'actions', 'lines'].map((edge) => fs.existsSync(path.join(out, edge, 't-1.jsonl'))),
    [true, true, true, true]
  );
  fs.rmSync(out, { recursive: true, force: true });
});

test('shows a record under its name only with its whole content, while another thread writes it', async () => {
  // Catches: a record written in place, so `db` running beside `turns` reads a lines record cut short.
  const out = tempDir('nep-harness-record-');
  const size = 64 * 1024 * 1024;
  const done = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `const { workerData } = require('node:worker_threads');
     import(workerData.module).then(({ writeTurnRecords }) => {
       writeTurnRecords(workerData.out, 't-big', { requests: '', tools: '', actions: '', lines: 'x'.repeat(workerData.size) });
       Atomics.store(workerData.done, 0, 1);
     });`,
    {
      eval: true,
      workerData: { module: new URL('../../../scripts/lib/harness-record.ts', import.meta.url).href, out, size, done },
    }
  );
  const file = path.join(out, 'lines', 't-big.jsonl');
  const sizes = new Set<number>();
  const until = Date.now() + 60_000;
  while (Atomics.load(done, 0) === 0 && Date.now() < until) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat !== undefined) sizes.add(stat.size);
  }
  await new Promise((resolve) => worker.once('exit', resolve));
  assert.equal([...sizes].filter((seen) => seen !== size).length, 0);
  assert.equal(fs.statSync(file).size, size);
  assert.deepEqual(fs.readdirSync(path.join(out, 'lines')), ['t-big.jsonl']);
  fs.rmSync(out, { recursive: true, force: true });
});

test('keeps every journal line and record append in order, paths replaced, for the database edge', () => {
  // Catches: a line the turn kept left out of `lines`, so `db` writes less than the turn would have.
  const append = {
    kind: 'record.append',
    placeId: 'p-1',
    record: { lines: [{ text: `${SCRATCH}/b.png` }], messages: null },
  };
  const records = turnRecords({ ...run(), journal: [...run().journal, append] }, [SCRATCH]);
  assert.deepEqual(lines(records.lines), [
    { kind: 'turn.start', placeId: 'p-1', record: {} },
    { kind: 'action', placeId: 'p-1', record: { opId: 'op-replay-2', phase: 'proposed' } },
    { kind: 'record.append', placeId: 'p-1', record: { lines: [{ text: '<path-1>/b.png' }], messages: null } },
  ]);
});
