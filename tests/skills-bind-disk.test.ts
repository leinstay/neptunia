// `bindPackage` binds the version the folder holds: a package whose bytes differ from the version it would bind is refused
// with `version-not-on-disk`, so a task never activates bytes its agent walked away from. A real board and a real skills
// port over memory databases in memory, real temporary skill folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openBoard } from '../src/board/board.ts';
import type { Board } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { bindPackage } from '../src/skills/task-activation.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-02T10:00:00Z');
const WORKER = 'development';
const V1 = skillText('say-it', 'd', ['web.read'], 'The first steps.');
const V2 = skillText('say-it', 'd', ['web.read'], 'The second steps.');

function boardOf(t: { after: (fn: () => void) => void }): Board {
  const dir = tempDir('nep-skill-bind-board-');
  fs.writeFileSync(path.join(dir, 'clients.json'), '{}');
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  return openBoard({
    // open.js types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => T0,
    settings: () => ({
      leaseTtlMinutes: 30,
      autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
      projects: {},
    }),
    builtins: { persona: ['persona'], [WORKER]: ['reviewer', 'worker'] },
  });
}

function herTask(board: Board): string {
  return board.call('persona', 'task.add', {
    lane: 'dev',
    title: 'A skill',
    description: 'The need.',
    metadata: { kind: 'skill' },
    requester: 'persona:self',
    subscriber: 'persona:self',
  }).id;
}

test('a package reverted to an older version refuses to bind, and the task names no version', async (t) => {
  // Bug: the newest candidate is v2 while the folder holds v1, so the task activates bytes its agent reverted.
  const board = boardOf(t);
  const rig = skillsRig(t);
  rig.writeLocal('say-it', V1);
  rig.port.sync();
  rig.writeLocal('say-it', V2);
  rig.port.sync();
  rig.writeLocal('say-it', V1);
  const id = herTask(board);
  const deps = { skills: rig.port, board, principal: WORKER };
  assert.deepEqual(await bindPackage(deps, { taskId: id, name: 'say-it' }), {
    ok: false,
    code: 'version-not-on-disk',
  });
  assert.equal(board.call(WORKER, 'task.show', { id }).task.metadata?.package, undefined);
});

test('a folder holding a retired version after a rollback refuses to bind the active one', async (t) => {
  // Bug: with no candidate the binding falls back to the active version, whatever the folder holds.
  const board = boardOf(t);
  const rig = skillsRig(t);
  rig.writeLocal('say-it', V1);
  assert.ok(rig.port.activate('say-it', 'owner').ok);
  rig.writeLocal('say-it', V2);
  assert.ok(rig.port.activate('say-it', 'owner').ok);
  assert.ok(rig.port.rollback('say-it', 'owner').ok);
  const id = herTask(board);
  const deps = { skills: rig.port, board, principal: WORKER };
  assert.deepEqual(await bindPackage(deps, { taskId: id, name: 'say-it' }), {
    ok: false,
    code: 'version-not-on-disk',
  });
});

test('a folder that holds the version it would bind still binds', async (t) => {
  // Bug: the comparison takes the text's hash, so a package with scripts never matches its version.
  const board = boardOf(t);
  const rig = skillsRig(t);
  rig.writeLocal('say-it', V1);
  const root = path.join(rig.folders.localDir, 'say-it');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'setup.json'), JSON.stringify({ scripts: { 'say.mjs': { args: {} } } }));
  fs.writeFileSync(path.join(root, 'scripts', 'say.mjs'), 'process.exit(0);\n');
  const id = herTask(board);
  const bound = await bindPackage({ skills: rig.port, board, principal: WORKER }, { taskId: id, name: 'say-it' });
  assert.deepEqual(bound, { ok: true, versionId: rig.port.pending()[0]?.versionId });
});
