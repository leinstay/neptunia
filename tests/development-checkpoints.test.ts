// src/development/checkpoints.ts: file checkpoints of an explicit development worktree, in disposable folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFileCheckpoints } from '../src/development/checkpoints.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig(over: { allowed?: boolean; writeFile?: (file: string, data: Buffer) => void } = {}) {
  const worktree = tempDir('nep-checkpoint-tree-');
  const write = (name: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(worktree, name)), { recursive: true });
    fs.writeFileSync(path.join(worktree, name), text);
  };
  write('src/a.ts', 'a one\n');
  write('src/b.ts', 'b one\n');
  let serial = 0;
  const checkpoints = createFileCheckpoints({
    worktree,
    storeDir: tempDir('nep-checkpoint-store-'),
    authority: { allowsWorktree: () => over.allowed !== false },
    now: () => 1000,
    newId: () => `c${(serial += 1)}`,
    ...(over.writeFile === undefined ? {} : { io: { writeFile: over.writeFile } }),
  });
  const read = (name: string): string => fs.readFileSync(path.join(worktree, name), 'utf8');
  return { worktree, checkpoints, write, read };
}

const taken = (checkpoints: ReturnType<typeof rig>['checkpoints'], revision = 1) => {
  const answer = checkpoints.take({ revision });
  assert.equal(answer.ok, true);
  if (!answer.ok) throw new Error(answer.code);
  return answer.checkpoint;
};

test('a preview lists the affected paths and the diff, and changes nothing', () => {
  // Bug: previewing a restore overwrites the files, or a deleted file is not in the list.
  const { checkpoints, write, read, worktree } = rig();
  const point = taken(checkpoints);
  write('src/a.ts', 'a two\n');
  write('src/new.ts', 'new\n');
  fs.rmSync(path.join(worktree, 'src/b.ts'));
  const preview = checkpoints.preview(point.id);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(
    [...preview.changes].sort((one, two) => one.path.localeCompare(two.path)),
    [
      { path: 'src/a.ts', change: 'modified' },
      { path: 'src/b.ts', change: 'removed' },
      { path: 'src/new.ts', change: 'added' },
    ]
  );
  assert.match(preview.diff, /a two/);
  assert.equal(read('src/a.ts'), 'a two\n');
});

test('a restore needs the explicit confirmation and the revision the preview showed', () => {
  // Bug: a stale panel restores over work done since the preview.
  const { checkpoints, write, read } = rig();
  const point = taken(checkpoints, 7);
  write('src/a.ts', 'a two\n');
  const unconfirmed = checkpoints.restore(point.id, { confirm: false, revision: 7 });
  assert.equal(unconfirmed.status, 'refused');
  assert.equal(unconfirmed.status === 'refused' && unconfirmed.code, 'needs-confirmation');
  const stale = checkpoints.restore(point.id, { confirm: true, revision: 6 });
  assert.equal(stale.status, 'refused');
  assert.equal(stale.status === 'refused' && stale.code, 'stale-revision');
  assert.equal(read('src/a.ts'), 'a two\n');
});

test('a restore brings the files back, removes what was added, and keeps the prior state recoverable', () => {
  // Bug: a restore is one-way and costs the work it replaced.
  const { checkpoints, write, read, worktree } = rig();
  const point = taken(checkpoints);
  write('src/a.ts', 'a two\n');
  write('src/new.ts', 'new\n');
  const restored = checkpoints.restore(point.id, { confirm: true, revision: 1 });
  assert.equal(restored.status, 'restored');
  assert.equal(read('src/a.ts'), 'a one\n');
  assert.equal(fs.existsSync(path.join(worktree, 'src/new.ts')), false);
  if (restored.status !== 'restored') return;
  const undone = checkpoints.restore(restored.undoId, { confirm: true, revision: restored.undoRevision });
  assert.equal(undone.status, 'restored');
  assert.equal(read('src/a.ts'), 'a two\n');
  assert.equal(read('src/new.ts'), 'new\n');
});

test('a local layer, credentials, live data and git are neither captured nor restored', () => {
  // Bug: a code restore rewinds the live memory or an API key.
  const { checkpoints, write, read, worktree } = rig();
  write('data/memory.db', 'live one');
  write('.env', 'KEY=one');
  write('config.local/config.local.json', '{"a":1}');
  write('prompts.local/card.md', 'one');
  write('.git/HEAD', 'ref one');
  const point = taken(checkpoints);
  write('data/memory.db', 'live two');
  write('.env', 'KEY=two');
  write('config.local/config.local.json', '{"a":2}');
  write('prompts.local/card.md', 'two');
  write('.git/HEAD', 'ref two');
  const preview = checkpoints.preview(point.id);
  assert.equal(preview.ok && preview.changes.length, 0);
  assert.equal(checkpoints.restore(point.id, { confirm: true, revision: 1 }).status, 'restored');
  assert.equal(read('data/memory.db'), 'live two');
  assert.equal(read('.env'), 'KEY=two');
  assert.equal(read('config.local/config.local.json'), '{"a":2}');
  assert.equal(read('prompts.local/card.md'), 'two');
  assert.equal(read('.git/HEAD'), 'ref two');
  assert.ok(fs.existsSync(worktree));
});

test('a symlink that leads out of the worktree stops the restore, and the outside file stays', () => {
  // Bug: restoring through a planted link overwrites a file in another checkout.
  const { checkpoints, worktree } = rig();
  const point = taken(checkpoints);
  const outside = path.join(tempDir('nep-checkpoint-outside-'), 'victim.ts');
  fs.writeFileSync(outside, 'outside\n');
  fs.rmSync(path.join(worktree, 'src/a.ts'));
  fs.symlinkSync(outside, path.join(worktree, 'src/a.ts'));
  const answer = checkpoints.restore(point.id, { confirm: true, revision: 1 });
  assert.equal(answer.status, 'refused');
  assert.equal(answer.status === 'refused' && answer.code, 'symlink-escape');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
});

test('a partial failure never reports restored, and its undo brings back the state before the attempt', () => {
  // Bug: half the files are restored, success is reported, and nothing tells which half.
  let writes = 0;
  const { checkpoints, write, read } = rig({
    writeFile: (file, data) => {
      writes += 1;
      if (writes === 2) throw new Error('disk full');
      fs.writeFileSync(file, data);
    },
  });
  const point = taken(checkpoints);
  write('src/a.ts', 'a two\n');
  write('src/b.ts', 'b two\n');
  writes = 0;
  const answer = checkpoints.restore(point.id, { confirm: true, revision: 1 });
  assert.equal(answer.status, 'failed');
  if (answer.status !== 'failed') return;
  writes = 10;
  assert.equal(checkpoints.restore(answer.undoId, { confirm: true, revision: answer.undoRevision }).status, 'restored');
  assert.equal(read('src/a.ts'), 'a two\n');
  assert.equal(read('src/b.ts'), 'b two\n');
});

test('a worktree outside the task authority has no capability, and nothing reports success', () => {
  // Bug: a backend without support, or another checkout, answers restored.
  const { checkpoints, read } = rig({ allowed: false });
  const capability = checkpoints.capability();
  assert.equal(capability.restore, false);
  assert.ok(capability.restore === false && capability.reason !== '');
  const answer = checkpoints.take({ revision: 1 });
  assert.equal(answer.ok, false);
  assert.equal(!answer.ok && answer.code, 'unavailable');
  assert.equal(checkpoints.restore('c1', { confirm: true, revision: 1 }).status, 'refused');
  assert.equal(read('src/a.ts'), 'a one\n');
});

test('an unknown checkpoint is refused by preview and restore', () => {
  // Bug: a missing id empties the worktree as a restore of nothing.
  const { checkpoints, read } = rig();
  assert.equal(checkpoints.preview('unknown').ok, false);
  const answer = checkpoints.restore('unknown', { confirm: true, revision: 1 });
  assert.equal(answer.status === 'refused' && answer.code, 'unknown-checkpoint');
  assert.equal(read('src/a.ts'), 'a one\n');
});
