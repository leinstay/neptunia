// The board's reaper (src/board/reaper.ts), moved from the private ledger's claim.test.js: its timer runs the board's
// reap on its interval. A temporary memory file, a fake clock, synthetic principals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openMemoryDb } from '../src/memory/db/open.js';
import { openBoard } from '../src/board/board.ts';
import type { BoardSettings } from '../src/board/board.ts';
import { startReaper } from '../src/board/reaper.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tempDir } from './fixtures/tmp.js';

const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

test('the reaper timer runs reap on its interval', async (t) => {
  const dir = tempDir('nep-board-reaper-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({
      lead: { kind: 'cli', tokenFile: 'clients/lead.token', permissions: [], boardRoles: ['owner'] },
      dispatcher: { kind: 'cli', tokenFile: 'clients/dispatcher.token', permissions: [], boardRoles: ['scheduler'] },
    })
  );
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  let now = Date.parse('2026-10-17T10:00:00.000Z');
  // open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
  const board = openBoard({ db: handle.db as BoardDb, privateDir: dir, now: () => now, settings: () => SETTINGS });
  let task = board.call('lead', 'task.add', { title: 'held', lane: 'dev', project: 'core' });
  task = board.call('lead', 'task.transition', {
    id: task.id,
    status: 'triaged',
    revision: task.revision,
    set: { role: 'implementer', estimate: 40, budget: 3 },
  });
  board.call('lead', 'task.approve', { id: task.id, scope: 'plan' });
  board.call('dispatcher', 'task.claim', { id: task.id });
  now += 31 * 60000;
  const lines: Array<string> = [];
  const reaper = startReaper(board, { intervalMs: 20, log: (l) => lines.push(l) });
  t.after(() => reaper.stop());
  await sleep(80);
  assert.equal(board.call('lead', 'task.show', { id: task.id }).task.status, 'approved');
  assert.match(lines[0] ?? '', new RegExp(task.id));
});
