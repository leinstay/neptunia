// Automatic skill activation after a development task (plan section 8). A package filed for a task is bound to the task
// by its immutable version; when her task is done, that exact version activates through the writer, with the version and
// the actor recorded. Nothing else activates: another pending version, a later edit, a failed task or a watcher's task.
// A real board and a real skills port over a memory database in memory, real temporary skill folders.
//
// The signatures these tests hold the code to:
// - src/skills/task-activation.ts:
//   `type SkillTasksDeps = { skills: SkillsAccess; board: BoardCaller; principal: string }`
//   `bindPackage(deps, { taskId, name }): Promise<{ ok: true; versionId: string } | { ok: false; code: string }>`
//     validates the package now and writes `metadata.package = { skill, versionId }` on the open task. `code` is
//     `invalid-name`, `no-package` or the loader's problem code (`bad-setup`, `symlink`, ...).
//   `settleSkillTasks(deps): Promise<Array<{ taskId: string; skill: string | null; versionId: string | null; code: string }>>`
//     one sweep over the done tasks with `requester` `persona:self`, `metadata.kind` `skill` and a binding, each answered
//     once: `activated`, `already-active`, `superseded`, `invalid-package`, `invalid-name` or `unknown-version`. A
//     refusal writes one `task.comment` naming its code, so the reason stays visible on the task. A later sweep answers
//     nothing for a settled task, and a sweep that could not write leaves the task for the next one.
// - src/skills/port.ts and client.ts: `activateVersion(name, versionId, by)` answers
//   `{ ok: true, versionId, previous }` or `{ ok: false, code }`, one write `{ kind: 'skills', op: 'activate-version',
//   name, versionId, at, by }` (`applySkillsWrite`). The actor is `task:<id>`.
// - src/skills/agent-commands.ts: `skillCommandOf(access, caller, 'skill.pending', { name, task }, { board })` binds the
//   filed package to `task` as `caller.name`. An agent still has no activation command.
// - src/skills/load.ts: a symlink as `SKILL.md`, `setup.json`, `scripts` or a script is the problem `symlink`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openBoard } from '../src/board/board.ts';
import type { Board } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applySkillsWrite } from '../src/memory/db/skills.ts';
import type { SkillsUpdate } from '../src/memory/db/skills.ts';
import { skillCommandOf } from '../src/skills/agent-commands.ts';
import { createSkillsClient } from '../src/skills/client.ts';
import { loadSkills } from '../src/skills/load.ts';
import { snapshotDir } from '../src/skills/package.ts';
import { createSkillsPort } from '../src/skills/port.ts';
import { bindPackage, settleSkillTasks } from '../src/skills/task-activation.ts';
import type { BoardCaller } from '../src/tools/operations/board.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import type { SkillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-02T10:00:00Z');
const WORKER = 'selfimprovement';
const SCRIPT = "process.stdout.write(JSON.stringify({ ok: true, text: 'one' }));\n";
const SETUP = JSON.stringify({ scripts: { 'say.mjs': { args: {}, credentials: [] } } });

type BoardWorld = { board: Board; caller: BoardCaller };

/** A real board in memory with her, the worker and the watcher as the core's builtin principals. */
function boardWorld(t: { after: (fn: () => void) => void }): BoardWorld {
  const dir = tempDir('nep-skill-tasks-board-');
  fs.writeFileSync(path.join(dir, 'clients.json'), '{}');
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const board = openBoard({
    // open.js types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => T0,
    settings: () => ({
      leaseTtlMinutes: 30,
      autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
      projects: {},
    }),
    builtins: { persona: ['persona'], [WORKER]: ['reviewer', 'worker'], watcher: ['watcher'] },
  });
  return { board, caller: board };
}

type Rig = {
  world: BoardWorld;
  rig: SkillsRig;
  deps: { skills: SkillsRig['port']; board: BoardCaller; principal: string };
};

function rigs(t: { after: (fn: () => void) => void }, options: { granted?: ReadonlyArray<string> } = {}): Rig {
  const world = boardWorld(t);
  const rig = skillsRig(t, options);
  return { world, rig, deps: { skills: rig.port, board: world.caller, principal: WORKER } };
}

function writePackage(rig: SkillsRig, name: string, { script = SCRIPT, setup = SETUP, body = 'Steps.' } = {}): void {
  const root = path.join(rig.folders.localDir, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), skillText(name, 'd', ['skill.run'], body));
  fs.writeFileSync(path.join(root, 'setup.json'), setup);
  fs.writeFileSync(path.join(root, 'scripts', 'say.mjs'), script, { mode: 0o755 });
}

/** A skill task of hers, claimed by the worker. */
async function openTask(world: BoardWorld, title = 'A skill'): Promise<string> {
  const { caller } = world;
  const task = await caller.call('persona', 'task.add', {
    lane: 'dev',
    title,
    description: 'The need.',
    metadata: { kind: 'skill' },
    requester: 'persona:self',
    subscriber: 'persona:self',
  });
  return await claimed(world, task.id, task.revision);
}

async function claimed(world: BoardWorld, id: string, revision: number): Promise<string> {
  const { caller } = world;
  await caller.call(WORKER, 'task.transition', {
    id,
    status: 'triaged',
    revision,
    set: { role: 'dev', estimate: 30, budget: 4, risk: 'low' },
  });
  await caller.call(WORKER, 'task.approve', { id, scope: 'plan' });
  await caller.call(WORKER, 'task.claim', { id });
  return id;
}

/** The worker's handoff and the review that closes the task as done. */
async function finish(world: BoardWorld, id: string): Promise<void> {
  const { caller } = world;
  const held = await caller.call(WORKER, 'task.show', { id });
  await caller.call(WORKER, 'task.submit', {
    id,
    generation: held.task.lease_generation,
    handoff: { result: 'done', evidence: [], artifacts: [], tests: [], open_issues: [] },
  });
  const { task } = await caller.call(WORKER, 'task.show', { id });
  await caller.call(WORKER, 'task.update', { id, revision: task.revision, metadata: { ci: 'green' } });
  await caller.call(WORKER, 'task.review', { id, decision: 'accept' });
}

/** A task that produced `name` from what the folder holds now, closed as done. */
async function produced({ world, rig, deps }: Rig, name: string): Promise<{ id: string; versionId: string }> {
  const id = await openTask(world, `A skill ${name}`);
  const bound = await bindPackage(deps, { taskId: id, name });
  assert.ok(bound.ok, 'the package binds');
  await finish(world, id);
  assert.ok(rig.port.pending().some((one) => one.versionId === bound.versionId));
  return { id, versionId: bound.versionId };
}

const rowOf = (rig: SkillsRig, name: string) => rig.port.list().find((row) => row.name === name);

test('first activation: the exact bound version goes active, with its version and its actor recorded', async (t) => {
  // Bug: the task's end activates nothing, or the record says nothing of who did it.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const { id, versionId } = await produced(r, 'say-it');
  const settled = await settleSkillTasks(r.deps);
  assert.deepEqual(settled, [{ taskId: id, skill: 'say-it', versionId, code: 'activated' }]);
  const row = rowOf(r.rig, 'say-it');
  assert.equal(row?.active?.versionId, versionId);
  assert.equal(row?.active?.activatedBy, `task:${id}`);
  assert.deepEqual(
    r.rig.port.active().map((one) => one.versionId),
    [versionId]
  );
});

test('binding alone activates nothing, and an open task keeps its version pending', async (t) => {
  // Bug: filing the package counts as the task's success.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const id = await openTask(r.world);
  assert.ok((await bindPackage(r.deps, { taskId: id, name: 'say-it' })).ok);
  assert.deepEqual(await settleSkillTasks(r.deps), []);
  assert.equal(r.rig.port.active().length, 0);
  assert.equal(r.rig.port.pending().length, 1);
});

test('replacement: the new version goes active, the old one stays for a rollback, and the rollback works', async (t) => {
  // Bug: a replacement loses the way back, or the activation keeps two versions active.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const first = await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  writePackage(r.rig, 'say-it', { script: 'process.stdout.write(\'{"ok":true,"text":"two"}\');\n' });
  const second = await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  assert.equal(rowOf(r.rig, 'say-it')?.active?.versionId, second.versionId);
  assert.equal(rowOf(r.rig, 'say-it')?.rollbackTo?.versionId, first.versionId);
  assert.ok(r.rig.port.rollback('say-it', 'owner').ok);
  assert.equal(rowOf(r.rig, 'say-it')?.active?.versionId, first.versionId);
});

test('an unrelated pending version stays pending', async (t) => {
  // Bug: the activation walks every candidate, or uses the name-based activation that takes the newest.
  const r = rigs(t);
  writePackage(r.rig, 'other-skill');
  writePackage(r.rig, 'say-it');
  await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  assert.deepEqual(
    r.rig.port.pending().map((one) => one.skill),
    ['other-skill']
  );
  assert.equal(rowOf(r.rig, 'other-skill')?.active, null);
});

for (const [label, close] of [
  [
    'failed',
    (world: BoardWorld, id: string) =>
      world.caller.call(WORKER, 'task.transition', {
        id,
        status: 'failed',
        revision: world.board.call(WORKER, 'task.show', { id }).task.revision,
        close_reason: 'the tests failed',
      }),
  ],
  [
    'cancelled',
    (world: BoardWorld, id: string) =>
      world.caller.call('persona', 'task.transition', {
        id,
        status: 'cancelled',
        revision: world.board.call(WORKER, 'task.show', { id }).task.revision,
        close_reason: 'not needed',
      }),
  ],
] as const) {
  test(`a ${label} generation activates nothing and leaves the version pending`, async (t) => {
    // Bug: the binding alone is taken as evidence of success.
    const r = rigs(t);
    writePackage(r.rig, 'say-it');
    const id = await openTask(r.world);
    assert.ok((await bindPackage(r.deps, { taskId: id, name: 'say-it' })).ok);
    await close(r.world, id);
    assert.deepEqual(await settleSkillTasks(r.deps), []);
    assert.equal(r.rig.port.active().length, 0);
    assert.equal(r.rig.port.pending().length, 1);
  });
}

test('a done task with no binding activates nothing, whatever waits under its name', async (t) => {
  // Bug: a done skill task activates the newest candidate of a name found in its title or text.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const id = await openTask(r.world, 'say-it');
  await finish(r.world, id);
  assert.deepEqual(await settleSkillTasks(r.deps), []);
  assert.equal(r.rig.port.active().length, 0);
});

test('a malformed package cannot be bound, and the reason says what is wrong', async (t) => {
  // Bug: a broken package is recorded as the task's output and reaches activation.
  const r = rigs(t);
  writePackage(r.rig, 'half-done', { setup: '{ nope' });
  const id = await openTask(r.world);
  assert.deepEqual(await bindPackage(r.deps, { taskId: id, name: 'half-done' }), { ok: false, code: 'bad-setup' });
  assert.equal(r.rig.port.pending().length, 0);
});

test('a package that broke after binding stays inactive, with its reason visible on the task once', async (t) => {
  // Bug: the refusal only reaches a log nobody reads, or every sweep writes it again.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const id = await openTask(r.world);
  const bound = await bindPackage(r.deps, { taskId: id, name: 'say-it' });
  assert.ok(bound.ok);
  fs.writeFileSync(path.join(r.rig.folders.localDir, 'say-it', 'setup.json'), '{ nope');
  await finish(r.world, id);
  const [settled] = await settleSkillTasks(r.deps);
  assert.equal(settled?.code, 'invalid-package');
  assert.equal(r.rig.port.active().length, 0);
  assert.deepEqual(await settleSkillTasks(r.deps), []);
  const { comments } = await r.world.caller.call(WORKER, 'task.show', { id });
  assert.equal(comments.filter((one) => one.text.includes('bad-setup')).length, 1);
});

test('a stale completion for a superseded version changes nothing', async (t) => {
  // Bug: the slower task's end rolls the skill back to the older version.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const stale = await openTask(r.world, 'The slower task');
  const old = await bindPackage(r.deps, { taskId: stale, name: 'say-it' });
  assert.ok(old.ok);
  writePackage(r.rig, 'say-it', { script: 'process.stdout.write(\'{"ok":true,"text":"two"}\');\n' });
  const newer = await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  await finish(r.world, stale);
  const settled = await settleSkillTasks(r.deps);
  assert.deepEqual(
    settled.map((one) => [one.taskId, one.code]),
    [[stale, 'superseded']]
  );
  assert.equal(rowOf(r.rig, 'say-it')?.active?.versionId, newer.versionId);
  assert.equal(rowOf(r.rig, 'say-it')?.rollbackTo, null);
});

test('duplicate notifications of one completion activate once', async (t) => {
  // Bug: a repeated sweep records a second activation, moving the date and the history.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  const before = rowOf(r.rig, 'say-it')?.active?.activatedAt;
  r.rig.clock.t += 60_000;
  assert.deepEqual(await settleSkillTasks(r.deps), []);
  assert.equal(rowOf(r.rig, 'say-it')?.active?.activatedAt, before);
  assert.equal(rowOf(r.rig, 'say-it')?.rollbackTo, null);
});

test('a crash between the completion and the activation recovers on the first sweep after the restart', async (t) => {
  // Bug: only a live notification activates, so a restart leaves a finished skill pending forever.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const { versionId } = await produced(r, 'say-it');
  const restarted = createSkillsPort({
    handle: r.rig.handle,
    now: () => r.rig.clock.t,
    load: () => loadSkills(r.rig.folders),
    granted: () => r.rig.granted,
    registered: () => r.rig.registered,
    reviewDays: () => 30,
  });
  await settleSkillTasks({ ...r.deps, skills: restarted });
  assert.equal(rowOf(r.rig, 'say-it')?.active?.versionId, versionId);
});

test('a sweep whose write fails leaves the task for the next sweep', async (t) => {
  // Bug: the task is marked settled before the writer took the activation.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const { versionId } = await produced(r, 'say-it');
  const down = { ...r.rig.port, activateVersion: () => ({ ok: false as const, code: 'db-closed' as const }) };
  await settleSkillTasks({ ...r.deps, skills: down }).catch(() => []);
  assert.equal(r.rig.port.active().length, 0);
  await settleSkillTasks(r.deps);
  assert.equal(rowOf(r.rig, 'say-it')?.active?.versionId, versionId);
});

test('a crash after the activation and before its mark finds it already active and writes nothing', async (t) => {
  // Bug: the recovery activates again and pushes the version onto its own rollback history.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const { id, versionId } = await produced(r, 'say-it');
  assert.ok(r.rig.port.activateVersion('say-it', versionId, `task:${id}`).ok);
  const settled = await settleSkillTasks(r.deps);
  assert.deepEqual(
    settled.map((one) => one.code),
    ['already-active']
  );
  assert.equal(rowOf(r.rig, 'say-it')?.rollbackTo, null);
});

test('scripts changed after validation are refused by the immutable identity, and the edit stays pending', async (t) => {
  // Bug: the activation goes by name and takes unvalidated bytes written after the check.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const id = await openTask(r.world);
  const bound = await bindPackage(r.deps, { taskId: id, name: 'say-it' });
  assert.ok(bound.ok);
  fs.writeFileSync(path.join(r.rig.folders.localDir, 'say-it', 'scripts', 'say.mjs'), 'process.exit(9);\n');
  await finish(r.world, id);
  const settled = await settleSkillTasks(r.deps);
  assert.deepEqual(
    settled.map((one) => [one.versionId, one.code]),
    [[bound.versionId, 'superseded']]
  );
  assert.equal(rowOf(r.rig, 'say-it')?.active, null);
  assert.equal(r.rig.port.pending().length, 1);
  assert.notEqual(r.rig.port.pending()[0]?.versionId, bound.versionId);
});

test('an edit after the activation does not change the bytes the active version runs', async (t) => {
  // Bug: the activation points at the working folder, so a later edit runs unreviewed.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  const root = path.join(r.rig.folders.localDir, 'say-it');
  fs.writeFileSync(path.join(root, 'scripts', 'say.mjs'), 'process.exit(9);\n');
  const hash = rowOf(r.rig, 'say-it')?.active?.contentHash ?? '';
  assert.equal(fs.readFileSync(path.join(snapshotDir(root, hash), 'scripts', 'say.mjs'), 'utf8'), SCRIPT);
});

for (const [label, plant] of [
  [
    'SKILL.md',
    (root: string, outside: string) => {
      fs.writeFileSync(path.join(outside, 'SKILL.md'), fs.readFileSync(path.join(root, 'SKILL.md')));
      fs.rmSync(path.join(root, 'SKILL.md'));
      fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(root, 'SKILL.md'));
    },
  ],
  [
    'setup.json',
    (root: string, outside: string) => {
      fs.writeFileSync(path.join(outside, 'setup.json'), SETUP);
      fs.rmSync(path.join(root, 'setup.json'));
      fs.symlinkSync(path.join(outside, 'setup.json'), path.join(root, 'setup.json'));
    },
  ],
  [
    'scripts',
    (root: string, outside: string) => {
      fs.mkdirSync(path.join(outside, 'scripts'));
      fs.writeFileSync(path.join(outside, 'scripts', 'say.mjs'), SCRIPT);
      fs.rmSync(path.join(root, 'scripts'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'scripts'), path.join(root, 'scripts'));
    },
  ],
  [
    'a script',
    (root: string, outside: string) => {
      fs.writeFileSync(path.join(outside, 'say.mjs'), SCRIPT);
      fs.rmSync(path.join(root, 'scripts', 'say.mjs'));
      fs.symlinkSync(path.join(outside, 'say.mjs'), path.join(root, 'scripts', 'say.mjs'));
    },
  ],
] as const) {
  test(`a symlink as ${label} is refused and never becomes a version`, async (t) => {
    // Bug: the loader follows the link, so a package version holds bytes from outside its folder.
    const r = rigs(t);
    writePackage(r.rig, 'say-it');
    plant(path.join(r.rig.folders.localDir, 'say-it'), tempDir('nep-skill-outside-'));
    const id = await openTask(r.world);
    assert.deepEqual(await bindPackage(r.deps, { taskId: id, name: 'say-it' }), { ok: false, code: 'symlink' });
    assert.deepEqual(r.rig.port.problems(), [{ dir: 'say-it', code: 'symlink' }]);
    assert.equal(r.rig.port.pending().length, 0);
  });
}

test('a skill folder that is a symlink is no package', async (t) => {
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const outside = tempDir('nep-skill-outside-');
  fs.renameSync(path.join(r.rig.folders.localDir, 'say-it'), path.join(outside, 'say-it'));
  fs.symlinkSync(path.join(outside, 'say-it'), path.join(r.rig.folders.localDir, 'say-it'));
  const id = await openTask(r.world);
  assert.deepEqual(await bindPackage(r.deps, { taskId: id, name: 'say-it' }), { ok: false, code: 'no-package' });
});

test('a path traversal in a name is refused before any folder is read, in a binding and on a forged task', async (t) => {
  // Bug: a forged task's metadata walks the activation out of the skills folder.
  const r = rigs(t);
  const id = await openTask(r.world);
  assert.deepEqual(await bindPackage(r.deps, { taskId: id, name: '../say-it' }), { ok: false, code: 'invalid-name' });
  const { task } = await r.world.caller.call(WORKER, 'task.show', { id });
  await r.world.caller.call(WORKER, 'task.update', {
    id,
    revision: task.revision,
    metadata: { package: { skill: '../say-it', versionId: 'skillver:../say-it:0' } },
  });
  await finish(r.world, id);
  assert.deepEqual(
    (await settleSkillTasks(r.deps)).map((one) => one.code),
    ['invalid-name']
  );
});

test("a task naming another skill's version activates nothing", async (t) => {
  // Bug: the version id is trusted without checking whose it is, so one task activates a pending version of another skill.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  writePackage(r.rig, 'other-skill');
  const other = r.rig.port.pending().find((one) => one.skill === 'other-skill')?.versionId ?? '';
  const id = await openTask(r.world);
  const { task } = await r.world.caller.call(WORKER, 'task.show', { id });
  await r.world.caller.call(WORKER, 'task.update', {
    id,
    revision: task.revision,
    metadata: { package: { skill: 'say-it', versionId: other } },
  });
  await finish(r.world, id);
  assert.deepEqual(
    (await settleSkillTasks(r.deps)).map((one) => one.code),
    ['unknown-version']
  );
  assert.equal(r.rig.port.active().length, 0);
});

test('a rollback and a rejection hold: the next sweep does not bring the version back', async (t) => {
  // Bug: a sweep sees a done task whose version is not active and activates it again, undoing the owner.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const first = await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  writePackage(r.rig, 'say-it', { script: 'process.stdout.write(\'{"ok":true,"text":"two"}\');\n' });
  await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  assert.ok(r.rig.port.rollback('say-it', 'owner').ok);
  await settleSkillTasks(r.deps);
  assert.equal(rowOf(r.rig, 'say-it')?.active?.versionId, first.versionId);

  writePackage(r.rig, 'say-it', { script: 'process.stdout.write(\'{"ok":true,"text":"three"}\');\n' });
  const refused = await produced(r, 'say-it');
  assert.ok(r.rig.port.reject('say-it', 'owner').ok);
  const settled = await settleSkillTasks(r.deps);
  assert.deepEqual(
    settled.map((one) => [one.versionId, one.code]),
    [[refused.versionId, 'superseded']]
  );
  assert.equal(rowOf(r.rig, 'say-it')?.active?.versionId, first.versionId);
});

test('a disabled skill stays disabled through an activation', async (t) => {
  // Bug: the activation clears the owner's or her switch, and a skill she turned off comes back.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  assert.ok(r.rig.port.disable('say-it', 'owner').ok);
  writePackage(r.rig, 'say-it', { script: 'process.stdout.write(\'{"ok":true,"text":"two"}\');\n' });
  await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  assert.equal(rowOf(r.rig, 'say-it')?.disabled, true);
  assert.deepEqual(r.rig.port.active(), []);
  assert.ok(r.rig.port.enable('say-it', 'owner').ok);
  assert.equal(r.rig.port.active().length, 1);
});

test('an activation grants no undeclared tool and no credential', async (t) => {
  // Bug: making a skill active widens her grants or hands a script a secret its setup never declared.
  const r = rigs(t, { granted: ['web.read'] });
  const root = path.join(r.rig.folders.localDir, 'say-it');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), skillText('say-it', 'd', ['web.search']));
  await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  assert.deepEqual([...r.rig.granted], ['web.read']);
  const [active] = r.rig.port.active();
  assert.deepEqual(active?.tools, ['web.search']);
  assert.equal(active?.missing.length, 1, 'the ungranted tool shows as missing');
});

test("a watcher's task never activates, disables or rewrites a skill", async (t) => {
  // Bug: a finding about a skill is taken as an instruction to change it.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const live = await produced(r, 'say-it');
  await settleSkillTasks(r.deps);
  writePackage(r.rig, 'say-it', { script: 'process.stdout.write(\'{"ok":true,"text":"two"}\');\n' });
  const pending = r.rig.port.pending()[0]?.versionId ?? '';
  const text = fs.readFileSync(path.join(r.rig.folders.localDir, 'say-it', 'SKILL.md'), 'utf8');
  const { id } = await r.world.caller.call('watcher', 'task.add', {
    lane: 'dev',
    title: 'say-it misbehaves',
    description: 'say-it failed in t1.',
    acceptance: 'it stops failing',
    metadata: { kind: 'fix', evidence: 'say-it failed in t1.', origin: 'watcher' },
  });
  const { task } = await r.world.caller.call(WORKER, 'task.show', { id });
  await claimed(r.world, id, task.revision);
  const { task: held } = await r.world.caller.call(WORKER, 'task.show', { id });
  await r.world.caller.call(WORKER, 'task.update', {
    id,
    revision: held.revision,
    metadata: { kind: 'skill', package: { skill: 'say-it', versionId: pending } },
  });
  await finish(r.world, id);
  assert.deepEqual(await settleSkillTasks(r.deps), []);
  const row = rowOf(r.rig, 'say-it');
  assert.equal(row?.active?.versionId, live.versionId);
  assert.equal(row?.disabled, false);
  assert.equal(fs.readFileSync(path.join(r.rig.folders.localDir, 'say-it', 'SKILL.md'), 'utf8'), text);
});

test('the writer takes the exact version: one activate-version write with its actor, over the client', async (t) => {
  // Bug: the core's client has the port's method and no writer operation, so it only works in tests over a handle.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const versionId = r.rig.port.pending()[0]?.versionId ?? '';
  const writes: Array<SkillsUpdate> = [];
  const client = createSkillsClient({
    now: () => r.rig.clock.t,
    granted: () => r.rig.granted,
    registered: () => r.rig.registered,
    reviewDays: () => 30,
    write: (update) => {
      writes.push(update);
      return Promise.resolve(applySkillsWrite(r.rig.handle, update));
    },
    read: () => r.rig.handle,
    load: () => loadSkills(r.rig.folders),
  });
  const done = await client.activateVersion('say-it', versionId, 'task:T-1');
  assert.ok(done.ok);
  assert.deepEqual(
    writes.filter((one) => one.op !== 'sync').map((one) => ('versionId' in one ? [one.op, one.versionId, one.by] : [])),
    [['activate-version', versionId, 'task:T-1']]
  );
  assert.equal(rowOf(r.rig, 'say-it')?.active?.activatedBy, 'task:T-1');
});

test('filing a package with its task binds the exact version, as the caller, over the core socket command', async (t) => {
  // Bug: `neptunia task skill-pending` validates and forgets, so no task ever names what it produced.
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const id = await openTask(r.world);
  const answer = await skillCommandOf(
    r.rig.port,
    { name: WORKER },
    'skill.pending',
    { name: 'say-it', task: id },
    { board: r.world.caller }
  );
  assert.equal(answer.status, 'ok', answer.text);
  const { task } = await r.world.caller.call(WORKER, 'task.show', { id });
  assert.deepEqual(task.metadata?.package, { skill: 'say-it', versionId: r.rig.port.pending()[0]?.versionId });
});

test('guard: an agent still has no activation command, and the owner keeps his', async (t) => {
  const r = rigs(t);
  writePackage(r.rig, 'say-it');
  const refused = await skillCommandOf(r.rig.port, { name: WORKER }, 'skill.activate', { name: 'say-it' });
  assert.equal(refused.status, 'invalid');
  assert.equal(r.rig.port.active().length, 0);
  assert.ok(r.rig.port.activate('say-it', 'owner').ok);
  assert.equal(r.rig.port.active().length, 1);
});

// `bindPackage` binds the version the folder holds: a package whose bytes differ from the version it would bind is refused
// with `version-not-on-disk`, so a task never activates bytes its agent walked away from. A real board and a real skills
// port over memory databases in memory, real temporary skill folders.

const WORKER_BIND_DISK = 'development';
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
    builtins: { persona: ['persona'], [WORKER_BIND_DISK]: ['reviewer', 'worker'] },
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
  const deps = { skills: rig.port, board, principal: WORKER_BIND_DISK };
  assert.deepEqual(await bindPackage(deps, { taskId: id, name: 'say-it' }), {
    ok: false,
    code: 'version-not-on-disk',
  });
  assert.equal(board.call(WORKER_BIND_DISK, 'task.show', { id }).task.metadata?.package, undefined);
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
  const deps = { skills: rig.port, board, principal: WORKER_BIND_DISK };
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
  const bound = await bindPackage(
    { skills: rig.port, board, principal: WORKER_BIND_DISK },
    { taskId: id, name: 'say-it' }
  );
  assert.deepEqual(bound, { ok: true, versionId: rig.port.pending()[0]?.versionId });
});
