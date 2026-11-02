// The `/report [<date>]` entry of the command table (src/interface/commands/table.ts): what the parse accepts and
// refuses. The command runs in bin/neptunia.ts itself (no core), so only the table is tested here. The existing lists
// of commands in tests/commands-table.test.ts and tests/commands-console.test.ts gain `report` with the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';

test('/report with no date parses with no arguments: the latest report', () => {
  assert.deepEqual(parseCommandLine('/report'), { ok: true, name: 'report', args: {} });
});

test('/report <date> parses with the day', () => {
  assert.deepEqual(parseCommandLine('/report 2026-11-02'), { ok: true, name: 'report', args: { day: '2026-11-02' } });
});

test('/report refuses a word, a path or two words where a date goes, before anything reads a file', () => {
  for (const line of ['/report yesterday', '/report ../x', '/report 2026-11-02 extra', '/report 2026-1-2']) {
    assert.equal(parseCommandLine(line).ok, false, line);
  }
});

test('the table lists /report once with a help line', () => {
  const found = COMMANDS.filter((command) => command.name === 'report');
  assert.equal(found.length, 1);
  assert.ok((found[0]?.help ?? '').trim().length > 0);
});
