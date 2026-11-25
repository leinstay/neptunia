// The stored request dumps that scripts/replay.ts shows for one turn (scripts/lib/replay-message.ts). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../../../scripts/lib/replay-args.ts';
import { storedDumps } from '../../../scripts/lib/replay-message.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { asRecord } from '../../fixtures/records.ts';

test("replay: --show-request reads the base dumps of a turn by default, --steps adds each attempt's later requests after it", () => {
  const journalDir = tempDir('nep-replay-dumps-');
  const day = path.join(journalDir, 'requests', '2026-10-18');
  fs.mkdirSync(day, { recursive: true });
  for (const name of [
    't-ab-1.json',
    't-ab-1-s1.json',
    't-ab-1-s10.json',
    't-ab-1-s2.json',
    't-ab-2.json',
    't-ab-2-s1.json',
    't-ab-cd-1.json',
    'notes.txt',
  ]) {
    fs.writeFileSync(path.join(day, name), JSON.stringify({ name }));
  }
  assert.deepEqual(
    storedDumps(journalDir, 't-ab').map(({ dump }) => asRecord(dump).name),
    ['t-ab-1.json', 't-ab-2.json']
  );
  assert.deepEqual(
    storedDumps(journalDir, 't-ab', { steps: true }).map(({ dump }) => asRecord(dump).name),
    ['t-ab-1.json', 't-ab-1-s1.json', 't-ab-1-s2.json', 't-ab-1-s10.json', 't-ab-2.json', 't-ab-2-s1.json']
  );
  assert.equal(parseArgs(['--show-request', 't-ab', '--steps']).steps, true);
  assert.equal(parseArgs(['--show-request', 't-ab']).steps, false);
  assert.throws(() => parseArgs(['c1', 'm1', '--steps']), /usage/i);
});

test('replay: a stored dump that had tools gets its definitions back from the by-hash copy', () => {
  const journalDir = tempDir('nep-replay-dump-tools-');
  const day = path.join(journalDir, 'requests', '2026-10-20');
  fs.mkdirSync(path.join(journalDir, 'requests', 'tools'), { recursive: true });
  fs.mkdirSync(day, { recursive: true });
  const tools = [
    { type: 'function', function: { name: 'draw_create', description: 'd', parameters: { type: 'object' } } },
  ];
  const hash = 'a'.repeat(64);
  fs.writeFileSync(path.join(journalDir, 'requests', 'tools', `${hash}.json`), JSON.stringify(tools));
  fs.writeFileSync(path.join(day, 't-1-1.json'), JSON.stringify({ tools: hash, toolChoice: 'auto' }));
  fs.writeFileSync(path.join(day, 't-2-1.json'), JSON.stringify({ tools: 'b'.repeat(64) }));
  fs.writeFileSync(path.join(day, 't-3-1.json'), JSON.stringify({ raw: 'x' }));
  assert.deepEqual(asRecord(storedDumps(journalDir, 't-1')[0].dump).toolDefinitions, tools);
  assert.equal('toolDefinitions' in storedDumps(journalDir, 't-2')[0].dump, false);
  assert.equal('toolDefinitions' in storedDumps(journalDir, 't-3')[0].dump, false);
});

test("replay: a stored dump's later messages are shown as role, tool_calls and tool_call_id", () => {
  const journalDir = tempDir('nep-replay-dump-later-');
  const day = path.join(journalDir, 'requests', '2026-10-20');
  fs.mkdirSync(day, { recursive: true });
  const calls = [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }];
  fs.writeFileSync(
    path.join(day, 't-1-1-s1.json'),
    JSON.stringify({
      later: [
        { role: 'assistant', content: 'a', tool_calls: calls },
        { role: 'tool', tool_call_id: 'call_1', content: 'r' },
        { role: 'user', content: 'n' },
      ],
    })
  );
  fs.writeFileSync(path.join(day, 't-1-1.json'), JSON.stringify({ raw: 'x' }));
  const [base, step] = storedDumps(journalDir, 't-1', { steps: true });
  assert.equal('later' in base.dump, false);
  assert.deepEqual(asRecord(step.dump).later, [
    { role: 'assistant', tool_calls: calls, content: 'a' },
    { role: 'tool', tool_call_id: 'call_1', content: 'r' },
    { role: 'user', content: 'n' },
  ]);
});
