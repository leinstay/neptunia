// Tests for scripts/lib/stand.ts: the stand repeats itself at one checkout, offline, and its compare names what
// differs between two runs part by part, a step one run adds leaving the turns after it paired as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCase, compareStands, runStand } from '../../../scripts/lib/stand.ts';
import type { CaseResult } from '../../../scripts/lib/stand.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('repeats every request, report, file, stdout and exit code of its cases when run twice at one checkout', async () => {
  const cases = ['message-reply', 'inner-heartbeat', 'turn-discord-files', 'cut'];
  const first = await runStand(ROOT, path.join(tempDir('nep-stand-'), 'a'), cases);
  const second = await runStand(ROOT, path.join(tempDir('nep-stand-'), 'b'), cases);
  assert.deepEqual(
    first.map((result) => [result.name, result.exit]),
    cases.map((name) => [name, 0])
  );
  assert.ok(
    first.every(
      (result) => Object.keys(result.files).some((rel) => /req-001\.json$/.test(rel)) || result.name === 'cut'
    )
  );
  assert.deepEqual(
    compareStands(first, second).map((row) => [row.name, row.result]),
    cases.map((name) => [name, 'identical'])
  );
});

/** A request file of a case: a user text of blocks, the messages after it, and the tools by name. */
const request = (task: string, tools: Array<string>, later = 0) =>
  JSON.stringify({
    model: 'm',
    purpose: 'reply',
    system: 's',
    messages: [
      { role: 'user', content: `<chat>\nlines\n</chat>\n\n<task>\n${task}\n</task>` },
      ...Array.from({ length: later }, () => ({ role: 'tool', content: 'done' })),
    ],
    tools: tools.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    toolChoice: 'auto',
  });

const result = (files: Array<string>): CaseResult => ({
  name: 'c',
  scenario: 'a case',
  entry: 'scripts/replay.ts',
  exit: 0,
  stdout: '{}\n',
  files: Object.fromEntries(files.map((text, i) => [`answers/req-${String(i + 1).padStart(3, '0')}.json`, text])),
});

test('pairs the turns after a step one run adds as they are, and names the parts that differ', () => {
  const before = result([request('first', ['a']), request('second', ['a'])]);
  const after = result([request('first', ['a']), request('first', ['a'], 1), request('second', ['b'])]);
  const row = compareCase(before, after);
  assert.equal(row.result, 'differs');
  assert.deepEqual(row.requests, [2, 3]);
  assert.deepEqual(row.parts.requests, { equal: 2, differs: 0, onlyA: 0, onlyB: 1 });
  assert.deepEqual(row.parts['<task>'], { equal: 2, differs: 0, onlyA: 0, onlyB: 0 });
  assert.deepEqual(row.parts['tool names'], { equal: 1, differs: 1, onlyA: 0, onlyB: 0 });
  assert.deepEqual(row.parts['each tool schema'], { equal: 1, differs: 0, onlyA: 1, onlyB: 1 });
});
