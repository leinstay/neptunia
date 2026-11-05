// The merge gate by risk, over the world of tests/fixtures/development-rig.ts. The thinker records its assessment with
// `task.risk`; code reads the diff of the exact head that would merge and raises the task to `high` by the danger list
// of src/development/risk.ts; `auto` merges only at `low`, anything above waits for the owner; she hears why once, with
// the category and nothing else. Each test names the bug it catches.
//
// `withDiffs` puts a git diff in front of the rig's that answers as git does: per head, and with git's rename detection
// on by default, so a plain `--name-only` shows only the new name of a renamed file. It reads `--name-only` and
// `--name-status`, with `--no-renames` and `-z`, for a range `<base>...<rev>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackOutbox, buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import type { Row } from '../src/board/board.ts';
import { BoardError } from '../src/board/machine.ts';
import {
  HEAD,
  MINUTE,
  T0,
  WORKER,
  developmentWorld,
  fileDevTask,
  ownerTask,
  settle,
} from './fixtures/development-rig.ts';
import type { DevelopmentWorld } from './fixtures/development-rig.ts';
import { FIX_REQUEST, herCalls } from './fixtures/selfimprovement-rig.ts';

const SELF = 'persona:self';
const NEXT_HEAD = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const SECRET_REASON = 'The hook in the secret-corner handler looks wrong.';

type Change = { path: string; from?: string; isDeleted?: boolean };
type Diffs = {
  /** What the diff of a head holds; a head not named here holds `world.changed`. */
  heads: Map<string, ReadonlyArray<Change>>;
  /** The diffs read and the merges asked for, in order: `diff <rev>` and `merge <head>`. */
  log: Array<string>;
  /** Git refuses every diff from now on. */
  isBroken: boolean;
  /** Runs once, right after the next diff was read. */
  afterNextRead: (() => void) | null;
};

/** The output of `git diff` for these changes, by the flags it was given. */
function diffOutput(args: ReadonlyArray<string>, changes: ReadonlyArray<Change>): string | null {
  const shown = args.includes('--no-renames')
    ? changes.flatMap((one): Array<Change> =>
        one.from === undefined ? [one] : [{ path: one.from, isDeleted: true }, { path: one.path }]
      )
    : changes;
  const end = args.includes('-z') ? '\0' : '\n';
  const gap = args.includes('-z') ? '\0' : '\t';
  if (args.includes('--name-only')) return shown.map((one) => `${one.path}${end}`).join('');
  if (!args.includes('--name-status')) return null;
  return shown
    .map((one) =>
      one.from !== undefined
        ? `R100${gap}${one.from}${gap}${one.path}${end}`
        : `${one.isDeleted === true ? 'D' : 'M'}${gap}${one.path}${end}`
    )
    .join('');
}

/** The revision a `git diff` reads: the right side of its range, or its last plain argument. */
function revisionOf(args: ReadonlyArray<string>): string {
  const range = args.find((one) => one.includes('..'));
  if (range !== undefined) return range.split(/\.{2,3}/).at(-1) ?? '';
  return args.filter((one) => !one.startsWith('-')).at(-1) ?? '';
}

function withDiffs(world: DevelopmentWorld): Diffs {
  const diffs: Diffs = { heads: new Map(), log: [], isBroken: false, afterNextRead: null };
  const { git, gh } = world.deps;
  world.deps.git = (file, args, options) => {
    if (args[0] !== 'diff') return git(file, args, options);
    const named = revisionOf(args);
    diffs.log.push(`diff ${named}`);
    if (diffs.isBroken) return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: bad object' });
    const rev = named === 'HEAD' ? world.head : named;
    const stdout = diffOutput(args, diffs.heads.get(rev) ?? world.changed.map((one) => ({ path: one })));
    if (stdout === null) return Promise.resolve({ code: 2, stdout: '', stderr: 'the fake diff has no such format' });
    const after = diffs.afterNextRead;
    diffs.afterNextRead = null;
    after?.();
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  };
  world.deps.gh = (file, args, options) => {
    if (args[1] === 'merge') diffs.log.push(`merge ${String(args[args.indexOf('--match-head-commit') + 1])}`);
    return gh(file, args, options);
  };
  return diffs;
}

/** What the thinker does with `neptunia tasks risk`. */
const assess = (world: DevelopmentWorld, id: string, risk: string, reason: string): void => {
  world.board.call(WORKER, 'task.risk', { id, risk, reason });
};

/** Her filed fix, whose thinker assesses it `risk` on its first turn, or not at all with null; its id. */
async function herFix(
  world: DevelopmentWorld,
  risk: string | null,
  reason = 'One constant in one reader.'
): Promise<string> {
  const answer = await herCalls(world.caller)('task.propose', { ...FIX_REQUEST, kind: 'fix' });
  assert.equal(answer.status, 'ok', answer.summary ?? '');
  const id = String((answer.data as { task: { id: string } }).task.id);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1 && risk !== null) assess(world, id, risk, reason);
  };
  return id;
}

/** Green at the pull request's head and the mode the test names, then one pass of the worker. */
async function greenIn(world: DevelopmentWorld, mode: 'auto' | 'approve', worker = world.worker()): Promise<void> {
  if (world.pr !== null) world.pr.checks = ['SUCCESS'];
  world.mode = mode;
  await settle(worker);
}

type RiskEvent = { actor: string; risk: string; reason: string };

function riskEvents(world: DevelopmentWorld, id: string): Array<RiskEvent> {
  return world.board
    .eventsSince()
    .filter((row) => row.task_id === id && row.type === 'task.risk')
    .map((row) => {
      // The contract of the event: the board writes `new` as the JSON of `{ risk, reason }`.
      const written = JSON.parse(row.new ?? '{}') as { risk: string; reason: string };
      return { actor: row.actor, risk: written.risk, reason: written.reason };
    });
}

const taskOf = (world: DevelopmentWorld, id: string) => world.show(id).task;
const herRiskRows = (world: DevelopmentWorld): Array<Row> =>
  world.board.call('persona', 'outbox.pull', { to_whom: SELF }).filter((row) => row.kind === 'risk');

function assertWaitsForTheOwner(world: DevelopmentWorld, id: string): void {
  assert.equal(world.ghPr('merge').length, 0);
  assert.equal(world.pr?.state, 'OPEN');
  assert.equal(world.pr?.isDraft, false, 'the pull request is ready for the owner');
  assert.equal(taskOf(world, id).status, 'needs_validation');
}

function assertMergedBy(world: DevelopmentWorld, id: string, by: 'auto' | 'owner'): void {
  assert.equal(taskOf(world, id).status, 'done');
  assert.equal((taskOf(world, id).metadata?.landed as { decidedBy: string }).decidedBy, by);
}

// ---------- the thinker's assessment ----------

test('her fix assessed `low` by its thinker merges on green in auto, with the assessment on the board', async (t) => {
  // Catches: the rule stops every auto merge, or the thinker's record never reaches the board.
  const world = developmentWorld(t);
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  assert.equal(world.pr?.state, 'MERGED');
  assertMergedBy(world, id, 'auto');
  assert.deepEqual(riskEvents(world, id), [{ actor: WORKER, risk: 'low', reason: 'One constant in one reader.' }]);
});

test('her fix whose thinker recorded no assessment waits for the owner in auto', async (t) => {
  // Catches: the intake's automatic `low`, there for the approval rule, passes for an assessment when the model skipped it.
  const world = developmentWorld(t);
  const id = await herFix(world, null);
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  assertWaitsForTheOwner(world, id);
});

test('an assessment still counts when more than twenty events came after it', async (t) => {
  // Catches: the gate looks for the assessment in `task.show`, whose events stop at the newest twenty.
  const world = developmentWorld(t);
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  for (let n = 0; n < 25; n += 1) world.board.call('boss', 'task.comment', { id, text: `Looked at it, ${n}.` });
  await greenIn(world, 'auto', worker);
  assert.equal(world.pr?.state, 'MERGED');
});

for (const risk of ['normal', 'high']) {
  test(`a thinker's \`${risk}\` on a harmless diff waits for the owner in auto, ready and unmerged`, async (t) => {
    // Catches: auto merges above `low`, or the pull request stays a draft the owner never hears of.
    const world = developmentWorld(t);
    const id = await herFix(world, risk);
    const worker = world.worker();
    await settle(worker);
    await greenIn(world, 'auto', worker);
    assertWaitsForTheOwner(world, id);
    assert.equal(taskOf(world, id).risk, risk);
  });
}

test("the owner's merge closes a high task, attributed to him", async (t) => {
  // Catches: the machine or the worker holds a high task open after the owner merged it on GitHub.
  const world = developmentWorld(t);
  const id = await herFix(world, 'high');
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  if (world.pr !== null) world.pr.state = 'MERGED';
  await settle(worker);
  assertMergedBy(world, id, 'owner');
  assert.equal(taskOf(world, id).risk, 'high');
});

test('a high dev task holds its whole task back in auto', async (t) => {
  // Catches: the gate reads a parent that its child's raise never reached.
  const world = developmentWorld(t);
  const id = await herFix(world, null);
  world.scripts.thinker = (_run, turn) => {
    if (turn !== 1) return;
    assess(world, id, 'low', 'The plan looks small.');
    const child = fileDevTask(world, id, 'A step');
    assess(world, child, 'high', 'The step is not small.');
  };
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  assertWaitsForTheOwner(world, id);
  assert.equal(taskOf(world, id).risk, 'high');
});

// ---------- code does not rely on the model ----------

const DANGEROUS: ReadonlyArray<[string, string]> = [
  ['deploy/neptunia.service', 'deploy'],
  ['src/keys/ring.ts', 'keys'],
  ['package-lock.json', 'dependencies'],
];
for (const [file, category] of DANGEROUS) {
  test(`a diff touching ${file} raises the task to high with ${category} as the reason, once`, async (t) => {
    // Catches: the path is the reason, or every look writes a board event, which wakes the worker's loop for ever.
    const world = developmentWorld(t);
    world.changed = [file];
    const id = ownerTask(world);
    const worker = world.worker();
    await settle(worker);
    await settle(worker);
    assert.equal(taskOf(world, id).risk, 'high');
    const raises = riskEvents(world, id).filter((one) => one.risk === 'high');
    assert.equal(raises.length, 1);
    assert.equal(raises[0]?.actor, WORKER);
    assert.ok(raises[0]?.reason.includes(category), `the reason "${raises[0]?.reason}" names the category`);
    assert.ok(!raises[0]?.reason.includes(file), 'the reason names the category and not the path');
  });
}

test("the thinker's `low` does not undo the danger list, before or after the diff is read", async (t) => {
  // Catches: the last writer wins, so an assessment after the look clears what code found.
  const world = developmentWorld(t);
  world.changed = ['deploy/neptunia.service'];
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  assert.equal(taskOf(world, id).risk, 'high');
  let code = 'passed';
  try {
    assess(world, id, 'low', 'The unit file is only a comment.');
  } catch (error) {
    code = error instanceof BoardError ? error.code : String(error);
  }
  assert.equal(code, 'risk-lowered');
  await greenIn(world, 'auto', worker);
  assertWaitsForTheOwner(world, id);
  assert.equal(taskOf(world, id).risk, 'high');
});

test("an owner's own `low` does not take a dangerous diff past the gate, and she hears nothing of his task", async (t) => {
  // Catches: the rule looks only at her proposals, or the gate trusts a level set before the diff existed.
  const world = developmentWorld(t);
  world.changed = ['.github/workflows/ci.yml'];
  const id = ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  assertWaitsForTheOwner(world, id);
  assert.deepEqual(herRiskRows(world), []);
});

test('approve mode at a dangerous diff is unchanged: ready, unmerged, and no word to her that risk is why', async (t) => {
  // Catches: approve starts behaving by risk, or she is told risk holds a task the mode holds anyway.
  const world = developmentWorld(t);
  world.changed = ['src/board/machine.ts'];
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'approve', worker);
  assertWaitsForTheOwner(world, id);
  assert.equal(taskOf(world, id).risk, 'high');
  assert.deepEqual(herRiskRows(world), []);
});

const MOVED: ReadonlyArray<[string, Array<Change>, string]> = [
  ['a rename out of a listed folder', [{ path: 'src/util/ring.ts', from: 'src/keys/ring.ts' }], 'keys'],
  ['a rename into a listed folder', [{ path: 'deploy/notes.md', from: 'docs/notes.md' }], 'deploy'],
  ['a deletion in a listed folder', [{ path: 'src/subharness/place.ts', isDeleted: true }], 'subharness'],
];
for (const [label, changes, category] of MOVED) {
  test(`${label} counts, and auto does not merge it`, async (t) => {
    // Catches: `git diff --name-only` with its default rename detection hides the old name of a file moved out of danger.
    const world = developmentWorld(t);
    const diffs = withDiffs(world);
    diffs.heads.set(HEAD, changes);
    const id = await herFix(world, 'low');
    const worker = world.worker();
    await settle(worker);
    await greenIn(world, 'auto', worker);
    assertWaitsForTheOwner(world, id);
    assert.equal(taskOf(world, id).risk, 'high');
    assert.ok(riskEvents(world, id).some((one) => one.reason.includes(category)));
  });
}

// ---------- the exact head ----------

test('a new head is read again: a dangerous push after a harmless look does not merge', async (t) => {
  // Catches: a verdict kept from the first look, or read once at the pull request's opening, clears the later commit.
  const world = developmentWorld(t);
  const diffs = withDiffs(world);
  diffs.heads.set(NEXT_HEAD, [{ path: 'deploy/neptunia.service' }]);
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  assert.equal(taskOf(world, id).risk, 'low');
  world.scripts.thinker = () => {
    world.head = NEXT_HEAD;
  };
  world.board.call('boss', 'task.review', { id, decision: 'changes', comment: 'Do it another way.' });
  await settle(worker);
  world.advance(31 * MINUTE);
  world.board.reap();
  await settle(worker);
  assert.equal(world.pr?.head, NEXT_HEAD);
  await greenIn(world, 'auto', worker);
  assertWaitsForTheOwner(world, id);
  assert.equal(taskOf(world, id).risk, 'high');
});

test('the last diff read before a merge names the head that merge names', async (t) => {
  // Catches: a diff of the worktree's `HEAD` or of the branch name, which is not the commit `--match-head-commit` takes.
  const world = developmentWorld(t);
  const diffs = withDiffs(world);
  await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  const merge = diffs.log.findIndex((one) => one.startsWith('merge '));
  assert.equal(diffs.log[merge], `merge ${HEAD}`);
  const lastRead = diffs.log.slice(0, merge).findLast((one) => one.startsWith('diff '));
  assert.equal(lastRead, `diff ${HEAD}`);
});

test('a push between the diff and the merge is refused by the head the merge names', async (t) => {
  // Catches: a merge that drops the exact head, so a commit nobody read lands behind a clean diff.
  const world = developmentWorld(t);
  const diffs = withDiffs(world);
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  diffs.afterNextRead = () => {
    if (world.pr !== null) world.pr.head = NEXT_HEAD;
  };
  await greenIn(world, 'auto', worker);
  assert.equal(diffs.afterNextRead, null, 'the look read the diff');
  assert.equal(world.pr?.state, 'OPEN');
  assert.equal(taskOf(world, id).status, 'needs_validation');
  assert.equal(taskOf(world, id).metadata?.merged ?? null, null);
});

test('a diff git cannot read merges nothing', async (t) => {
  // Catches: a failed diff has no paths, no paths read as harmless, and the gate opens on the failure.
  const world = developmentWorld(t);
  const diffs = withDiffs(world);
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  diffs.isBroken = true;
  await greenIn(world, 'auto', worker);
  assert.ok(diffs.log.filter((one) => one.startsWith('diff ')).length > 1, 'the look read the diff');
  assert.equal(world.ghPr('merge').length, 0);
  assert.equal(world.pr?.state, 'OPEN');
  assert.equal(taskOf(world, id).status, 'needs_validation');
});

// ---------- what she hears ----------

/** The rows her selfimprovement wake would show, as its facts carry them. */
async function herNews(world: DevelopmentWorld) {
  const { entries, outbox } = await proposalsOf(world.caller);
  const facts = await buildSelfimprovementFacts({
    now: T0,
    since: null,
    journal: null,
    granted: [],
    skills: [],
    proposals: entries,
    outbox,
    landed: [],
  });
  return facts.news.outbox;
}

test('her wake shows the category when her fix waits for the owner by the danger list, and no path', async (t) => {
  // Catches: she never learns why her fix stopped, or the row carries the paths of a deploy or key change into her wake.
  const world = developmentWorld(t);
  world.changed = ['src/keys/ring.ts'];
  const id = await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  const [row] = (await herNews(world)).filter((one) => one.kind === 'risk');
  assert.equal(row?.taskId, id);
  assert.equal(row?.blockedReason, 'keys');
  assert.ok(!JSON.stringify(herRiskRows(world)).includes('ring.ts'));
});

test("a thinker's `high` reaches her as `assessed`, never with the thinker's words", async (t) => {
  // Catches: the free text of a model's reason, which may quote a secret or a path, goes straight into her turn.
  const world = developmentWorld(t);
  const id = await herFix(world, 'high', SECRET_REASON);
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  const [row] = (await herNews(world)).filter((one) => one.kind === 'risk');
  assert.equal(row?.taskId, id);
  assert.equal(row?.blockedReason, 'assessed');
  assert.ok(!JSON.stringify(herRiskRows(world)).includes('secret-corner'));
});

test('nothing reaches her while the checks are pending, because nothing waits for the owner yet', async (t) => {
  // Catches: the row is written at the raise, so she reads that a red pull request waits for the owner. The second half
  // holds that the row does come once CI is green.
  const world = developmentWorld(t);
  world.changed = ['deploy/neptunia.service'];
  await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  world.mode = 'auto';
  await settle(worker);
  assert.deepEqual(herRiskRows(world), []);
  await greenIn(world, 'auto', worker);
  assert.equal(herRiskRows(world).length, 1);
});

test('she hears once: not at the next look, not after a restart, not after her wake took the row', async (t) => {
  // Catches: a row per look, a "told" kept in the process's memory, or a new row as soon as the old one is delivered.
  const world = developmentWorld(t);
  world.changed = ['deploy/neptunia.service'];
  await herFix(world, 'low');
  const worker = world.worker();
  await settle(worker);
  await greenIn(world, 'auto', worker);
  await settle(worker);
  await settle(world.worker());
  const rows = herRiskRows(world);
  assert.equal(rows.length, 1);
  await ackOutbox(world.caller, [Number(rows[0]?.seq)]);
  await settle(worker);
  await settle(world.worker());
  assert.deepEqual(herRiskRows(world), []);
});
