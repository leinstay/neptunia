// src/memory/db/request-archive.ts: the records a restart cuts off, and the old dump files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { importRequestDumps, readRequests } from '../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

test('a request a restart cut off is recorded as unknown with no answer invented, and nothing asks again', async () => {
  // Bug: a request in flight stays pending for ever, gets a made-up answer, or is sent again to fill the archive.
  const handle = openMemoryDb(path.join(tempDir('nep-archive-'), 'memory.db'));
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'start',
    record: { id: 'r1', at: 5, system_text: 's', messages: '[]' },
  });
  applyMemoryWrite(handle, { kind: 'request-archive', op: 'interrupt', at: 9 });
  const [row] = readRequests(dbOf(handle));
  assert.equal(row?.status, 'unknown');
  assert.equal(row?.response_text, null);
  handle.close();
});

test('old dump files are read in once, with a missing tools file named, and they stay in place', () => {
  // Bug: a second start doubles the history, a broken dump stops the start, or the import deletes its source.
  const dataDir = tempDir('nep-archive-import-');
  const day = path.join(dataDir, 'guilds', 'g1', 'journal', 'requests', '2026-11-01');
  fs.mkdirSync(day, { recursive: true });
  const dump = {
    turnId: 't1',
    attemptId: 1,
    recordedAt: '2026-11-01T10:00:00.000Z',
    system: 'old prompt',
    parts: [{ type: 'text', text: 'hi' }],
    raw: 'answer',
    tools: 'gone',
  };
  fs.writeFileSync(path.join(day, 't1-1.json'), JSON.stringify(dump));
  fs.writeFileSync(path.join(day, 'broken.json'), '{');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  assert.deepEqual(importRequestDumps(handle, { dataDir }), { imported: 1, broken: 1 });
  assert.deepEqual(importRequestDumps(handle, { dataDir }), { imported: 0, broken: 1 });
  const [row] = readRequests(dbOf(handle));
  assert.equal(row?.system_text, 'old prompt');
  assert.equal(row?.response_text, 'answer');
  assert.equal(row?.error_code, 'tools-file-missing');
  assert.ok(fs.existsSync(path.join(day, 't1-1.json')));
  handle.close();
});
