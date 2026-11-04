// The report of the watcher as `/service watcher report [<date>]` (src/interface/commands/table.ts and
// src/service/commands.ts): what the parse accepts, and that a target which is no date reads no file. `/report` itself is
// retired, and tests/commands-service.test.ts holds that it is refused and names this command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createConsole } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { tempDir } from './fixtures/tmp.ts';

test('/service watcher report with no date parses with no arguments: the latest report', () => {
  assert.deepEqual(parseCommandLine('/service watcher report'), { ok: true, name: 'service.watcher.report', args: {} });
});

test('/service watcher report <date> parses with the target', () => {
  assert.deepEqual(parseCommandLine('/service watcher report 2026-11-02'), {
    ok: true,
    name: 'service.watcher.report',
    args: { target: '2026-11-02' },
  });
});

// Changed: the target is free in the table, since a later slice adds run identities, so the refusal moved to the handler.
test('a word, a path or two words where a date goes read no file', async () => {
  const dir = tempDir('nep-report-target-');
  const reports = reportsDirOf(dir, watcherDir({}));
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(dirname(reports), 'x.md'), 'zeta-outside\n');
  writeFileSync(join(reports, 'yesterday.md'), 'zeta-word\n');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => 'g1',
    selfId: () => 'self-1',
    hot: { config: {} },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => 0,
  });
  for (const target of ['yesterday', '../x', '2026-11-02 extra', '2026-1-2']) {
    const parsed = parseCommandLine(`/service watcher report ${target}`);
    assert.ok(parsed.ok, target);
    const answer = await desk.run(parsed.name, parsed.args, { id: 'owner-1' });
    assert.equal(answer.status, 'failed', target);
    assert.equal(answer.text.includes('zeta-'), false, target);
  }
});
