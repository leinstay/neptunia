// What the watcher's `Trash` section lists (`collectTrash` of src/watcher/trash.ts): leftovers by category, each with a name,
// a category and a reason, read-only and bounded. It is the one place the watcher looks at a development checkout, and it
// reports names, never contents. A category it cannot read is named as unavailable. Folders are synthetic, and every
// command goes through a fake `run` that answers from a table, so no real user, unit or repository is read, except by the
// one test of `service watcher evidence`, whose fake `run` still answers for all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { tempDir } from './fixtures/tmp.ts';
import { PLANTED_KEY } from './fixtures/watcher-rig.ts';

const trash = () => import('../src/watcher/trash.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const DAY_MS = 86_400_000;
const unixOf = (at: number): number => Math.floor(at / 1000);

const CATEGORIES = [
  'units',
  'identities',
  'state-folders',
  'stray-files',
  'dangling-symlinks',
  'retired-config-keys',
  'unloaded-files',
  'dead-branches',
  'dead-worktrees',
  'old-worktrees',
];

type Answer = string | null;
type Table = {
  passwd?: Answer;
  group?: Answer;
  ps?: Answer;
  varLib?: Answer;
  /** unit name to what `is-enabled` prints */
  enabled?: Readonly<Record<string, Answer>>;
  /** owner name to what `find -user` or `find -group` prints */
  owned?: Readonly<Record<string, Answer>>;
  /** folder to what `git status --porcelain` prints */
  status?: Readonly<Record<string, Answer>>;
  merged?: Answer;
  refs?: Answer;
  worktrees?: Answer;
};
type Call = { command: string; args: ReadonlyArray<string> };

/** A `run` that answers each read from `table`; a null or an unknown command fails as a missing tool does. */
function fakeRun(table: Table): {
  calls: Array<Call>;
  run: (command: string, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>;
} {
  const calls: Array<Call> = [];
  const answerOf = (command: string, args: ReadonlyArray<string>): Answer | undefined => {
    const has = (word: string): boolean => args.includes(word);
    if (command === 'getent') return has('passwd') ? table.passwd : table.group;
    if (command === 'ps') return table.ps;
    if (command === 'ls' && has('/var/lib')) return table.varLib;
    if (command === 'systemctl' && has('is-enabled')) return table.enabled?.[args.at(-1) ?? ''];
    if (command === 'find') {
      const at = Math.max(args.indexOf('-user'), args.indexOf('-group'));
      return table.owned?.[args[at + 1] ?? ''];
    }
    if (command === 'git') {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      if (has('status')) return table.status?.[dir];
      if (has('--merged')) return table.merged;
      if (has('for-each-ref')) return table.refs;
      if (has('worktree')) return table.worktrees;
    }
    return undefined;
  };
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args });
      const answer = answerOf(command, args);
      return Promise.resolve(
        answer === null || answer === undefined
          ? { code: 1, stdout: '', stderr: 'unavailable here' }
          : { code: 0, stdout: answer, stderr: '' }
      );
    },
  };
}

/** Empty folders: an install with its local settings, and a unit folder. */
function folders() {
  const root = tempDir('nep-trash-');
  const installDir = path.join(root, 'install');
  const unitDir = path.join(root, 'units');
  const data = path.join(root, 'data');
  fs.mkdirSync(installDir);
  fs.mkdirSync(unitDir);
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  return {
    root,
    installDir,
    unitDir,
    data,
    env: { NEPTUNIA_PRIVATE_DIR: data, NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: root } as Record<string, string>,
  };
}

/** An answer for every read that finds nothing, so a test fills in only what it is about. */
const clean = (table: Table = {}): Table => ({
  passwd: '',
  group: '',
  ps: '',
  varLib: '',
  merged: '',
  refs: '',
  worktrees: '',
  ...table,
});

async function collect(
  where: ReturnType<typeof folders>,
  table: Table,
  options: { checkout?: string | null; tasks?: () => ReadonlyArray<string> | null } = {}
) {
  const { collectTrash } = await trash();
  const fake = fakeRun(table);
  const result = await collectTrash({
    installDir: where.installDir,
    checkout: options.checkout ?? null,
    unitDir: where.unitDir,
    env: where.env,
    run: fake.run,
    now: () => NOW,
    tasks: options.tasks ?? (() => []),
  });
  return { result, calls: fake.calls };
}

type Result = Awaited<ReturnType<typeof collect>>['result'];
const namesIn = (result: Result, category: string): Array<string> =>
  result.items
    .filter((item) => item.category === category)
    .map((item) => item.name)
    .sort();
const missing = (result: Result, category: string): boolean =>
  result.unavailable.some((one) => one.category === category);

const writeUnit = (dir: string, name: string, body: string): void => {
  fs.writeFileSync(path.join(dir, name), `[Service]\n${body}\n`);
};

// ---- units -------------------------------------------------------------------------------------------------------

test('a unit whose binary is gone or whose script is gone is listed, and a whole one is not', async () => {
  // Bug: a unit left behind by an old install fails every night, and the report never names it.
  const where = folders();
  const binary = path.join(where.root, 'tool');
  fs.writeFileSync(binary, '');
  const script = path.join(where.root, 'script.ts');
  fs.writeFileSync(script, '');
  writeUnit(where.unitDir, 'neptunia-whole.service', `ExecStart=${binary} ${script} worker`);
  writeUnit(where.unitDir, 'neptunia-nobinary.service', `ExecStart=-${where.root}/gone/tool`);
  writeUnit(where.unitDir, 'neptunia-noscript.service', `ExecStart=${binary} ${where.root}/gone.ts worker`);
  const { result } = await collect(
    where,
    clean({
      enabled: {
        'neptunia-whole.service': 'enabled',
        'neptunia-nobinary.service': 'enabled',
        'neptunia-noscript.service': 'enabled',
      },
    })
  );
  assert.deepEqual(namesIn(result, 'units'), ['neptunia-nobinary.service', 'neptunia-noscript.service']);
  assert.notEqual(result.items[0]?.reason.trim(), '');
});

test('a disabled unit nothing references is listed, and one a timer starts is not', async () => {
  // Bug: every oneshot that a timer starts reads "disabled", so the list is noise the first day.
  const where = folders();
  const binary = path.join(where.root, 'tool');
  fs.writeFileSync(binary, '');
  writeUnit(where.unitDir, 'neptunia-old.service', `ExecStart=${binary}`);
  writeUnit(where.unitDir, 'neptunia-worker.service', `ExecStart=${binary}`);
  fs.writeFileSync(path.join(where.unitDir, 'neptunia-worker.timer'), '[Timer]\nUnit=neptunia-worker.service\n');
  const { result } = await collect(
    where,
    clean({
      enabled: {
        'neptunia-old.service': 'disabled',
        'neptunia-worker.service': 'disabled',
        'neptunia-worker.timer': 'enabled',
      },
    })
  );
  assert.deepEqual(namesIn(result, 'units'), ['neptunia-old.service']);
});

test('a unit of another product is none of its business', async () => {
  // Bug: the collector walks the whole unit folder and calls someone's service trash.
  const where = folders();
  writeUnit(where.unitDir, 'ssh.service', 'ExecStart=/gone/sshd');
  const { result } = await collect(where, clean({ enabled: { 'ssh.service': 'disabled' } }));
  assert.deepEqual(namesIn(result, 'units'), []);
});

test('a manager that does not answer still leaves the broken units listed, and names what it could not read', async () => {
  // Bug: "disabled" cannot be told, so the whole category reads empty, or every unit reads as trash.
  const where = folders();
  const binary = path.join(where.root, 'tool');
  fs.writeFileSync(binary, '');
  writeUnit(where.unitDir, 'neptunia-whole.service', `ExecStart=${binary}`);
  writeUnit(where.unitDir, 'neptunia-nobinary.service', `ExecStart=${where.root}/gone/tool`);
  const { result } = await collect(where, clean());
  assert.deepEqual(namesIn(result, 'units'), ['neptunia-nobinary.service']);
  assert.equal(missing(result, 'units'), true);
});

test('a unit folder that cannot be read is a named unavailable item', async () => {
  // Bug: a missing folder reads as "no stale units", a clean bill for what was never looked at.
  const where = folders();
  fs.rmSync(where.unitDir, { recursive: true });
  const { result } = await collect(where, clean());
  assert.equal(missing(result, 'units'), true);
});

// ---- users, groups and state folders -------------------------------------------------------------------------------

test('a user and a group with the prefix that own no process and no file are listed, and live ones are not', async () => {
  // Bug: an interface user left after a rename keeps its rights for ever, or a live one is called trash.
  const where = folders();
  const { result } = await collect(
    where,
    clean({
      passwd: [
        'root:x:0:0::/root:/bin/sh',
        'neptunia-ps:x:1:1::/home/a:/bin/sh',
        'neptunia-file:x:2:2::/home/b:/bin/sh',
        'neptunia-dead:x:3:3::/home/c:/bin/sh',
      ].join('\n'),
      group: ['root:x:0:', 'neptunia-ps:x:1:', 'neptunia-file:x:2:', 'neptunia-dead-group:x:4:'].join('\n'),
      ps: 'neptunia-ps neptunia-ps\nroot root\n',
      owned: {
        'neptunia-file': '/some/live/file\n',
        'neptunia-dead': '',
        'neptunia-dead-group': '',
      },
    })
  );
  assert.deepEqual(namesIn(result, 'identities'), ['neptunia-dead', 'neptunia-dead-group']);
});

test('an owner whose files cannot be searched is not called trash, and the search stays bounded', async () => {
  // Bug: a refused `find` reads as "owns nothing" and a live user is reported, or the search walks the whole disk.
  const where = folders();
  const { result, calls } = await collect(
    where,
    clean({ passwd: 'neptunia-unknown:x:3:3::/home/c:/bin/sh', owned: { 'neptunia-unknown': null } })
  );
  assert.deepEqual(namesIn(result, 'identities'), []);
  assert.equal(missing(result, 'identities'), true);
  for (const call of calls.filter((one) => one.command === 'find')) assert.notEqual(call.args[0], '/');
});

test('a state folder with the prefix that no unit names is listed, and a named one is not', async () => {
  // Bug: the state of a removed service sits under /var/lib with its data, unnoticed.
  const where = folders();
  fs.writeFileSync(
    path.join(where.unitDir, 'neptunia-core.service'),
    '[Service]\nExecStart=/bin/sh\nStateDirectory=neptunia-core\nReadWritePaths=/var/lib/neptunia-data\n'
  );
  const { result } = await collect(
    where,
    clean({
      enabled: { 'neptunia-core.service': 'enabled' },
      varLib: 'neptunia-core\nneptunia-data\nneptunia-old\nsystemd\n',
    })
  );
  assert.deepEqual(namesIn(result, 'state-folders'), ['/var/lib/neptunia-old']);
});

test('tools that cannot be asked make identities and state folders unavailable, not empty', async () => {
  // Bug: a machine without getent, or a unit that hides /var/lib, reads as nothing left over.
  const where = folders();
  const { result } = await collect(where, clean({ passwd: null, group: null, ps: null, varLib: null }));
  assert.equal(missing(result, 'identities'), true);
  assert.equal(missing(result, 'state-folders'), true);
});

// ---- the working folders ---------------------------------------------------------------------------------------------

test('untracked files of the install are listed by name, and their contents are read nowhere', async () => {
  // Bug: the collector opens the file to describe it, and a stray dump with chat lines reaches the report.
  const where = folders();
  fs.writeFileSync(path.join(where.installDir, 'stray.log'), 'SECRET-CONTENT');
  const { result } = await collect(
    where,
    clean({ status: { [where.installDir]: '?? stray.log\n?? old-folder/\n M src/changed.ts\n' } })
  );
  assert.deepEqual(namesIn(result, 'stray-files'), ['old-folder/', 'stray.log']);
  assert.equal(JSON.stringify(result).includes('SECRET-CONTENT'), false);
});

test('a name shaped like a credential is masked in the item', async () => {
  // Bug: names only, but one file is named after the key it holds, and the key reaches the report through its name.
  const where = folders();
  const { result } = await collect(where, clean({ status: { [where.installDir]: `?? ${PLANTED_KEY}.txt\n` } }));
  assert.equal(namesIn(result, 'stray-files').length, 1);
  assert.equal(JSON.stringify(result).includes(PLANTED_KEY), false);
});

test('an install with no git is unavailable for stray files', async () => {
  // Bug: a package install reads as "nothing stray", when it has no way to know.
  const where = folders();
  const { result } = await collect(where, clean({ status: { [where.installDir]: null } }));
  assert.equal(missing(result, 'stray-files'), true);
});

test('a dangling symlink is listed by its relative path, and a whole one and node_modules are not', async () => {
  // Bug: every worktree link under node_modules is reported, or a link broken by a move stays unseen.
  const where = folders();
  fs.mkdirSync(path.join(where.installDir, 'a'));
  fs.symlinkSync(path.join(where.root, 'gone'), path.join(where.installDir, 'a', 'broken'));
  fs.writeFileSync(path.join(where.installDir, 'real'), '');
  fs.symlinkSync(path.join(where.installDir, 'real'), path.join(where.installDir, 'whole'));
  fs.mkdirSync(path.join(where.installDir, 'node_modules'));
  fs.symlinkSync(path.join(where.root, 'gone'), path.join(where.installDir, 'node_modules', 'pkg'));
  const { result } = await collect(where, clean());
  assert.deepEqual(namesIn(result, 'dangling-symlinks'), [path.join('a', 'broken')]);
});

test('a config key of a retired name is listed by name and never with its value', async () => {
  // Bug: a setting nothing reads looks in force to the owner, or its value is copied into the report.
  const where = folders();
  fs.writeFileSync(
    localConfigPath(where.data),
    JSON.stringify({ watcher: { at: '06:30' }, heartbeat: { enabled: true } })
  );
  const { result } = await collect(where, clean());
  assert.deepEqual(namesIn(result, 'retired-config-keys'), ['watcher.at']);
  assert.equal(JSON.stringify(result).includes('06:30'), false);
});

for (const [name, change] of [
  ['that is not JSON', (file: string) => fs.writeFileSync(file, '{')],
  ['that is gone', (file: string) => fs.rmSync(file)],
] as const) {
  test(`a settings file ${name} leaves retired keys unavailable or empty for a named reason, never a throw`, async () => {
    // Bug: the whole collection dies on one broken file, and the watcher loses every other category.
    const where = folders();
    change(localConfigPath(where.data));
    const { result } = await collect(where, clean());
    assert.deepEqual(namesIn(result, 'retired-config-keys'), []);
    if (name === 'that is not JSON') assert.equal(missing(result, 'retired-config-keys'), true);
  });
}

test('prompt and agent files nothing loads are listed, and loaded ones are not', async () => {
  // Bug: a retired prompt reads as live text, and the next person edits a file no request ever sends.
  const where = folders();
  const { installDir } = where;
  for (const dir of ['prompts', 'src', path.join('agents', 'dev')]) {
    fs.mkdirSync(path.join(installDir, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(installDir, 'src', 'a.ts'), "const text = hot.prompts['loaded-one'];\n");
  fs.writeFileSync(path.join(installDir, 'prompts', 'loaded-one.md'), 'x');
  fs.writeFileSync(path.join(installDir, 'prompts', 'forgotten.md'), 'x');
  const agent = path.join(installDir, 'agents', 'dev');
  fs.writeFileSync(path.join(agent, 'profile.json'), JSON.stringify({ id: 'dev', prompt: 'prompt.md' }));
  fs.writeFileSync(path.join(agent, 'prompt.md'), 'x');
  fs.writeFileSync(path.join(agent, 'old-prompt.md'), 'x');
  const { result } = await collect(where, clean());
  assert.deepEqual(namesIn(result, 'unloaded-files'), [
    path.join('agents', 'dev', 'old-prompt.md'),
    path.join('prompts', 'forgotten.md'),
  ]);
});

// ---- the development checkout --------------------------------------------------------------------------------------

function checkoutOf(where: ReturnType<typeof folders>): string {
  const checkout = path.join(where.root, 'checkout');
  fs.mkdirSync(checkout);
  return checkout;
}

test('merged branches, abandoned branches and dead worktrees of the checkout are listed; the live ones are not', async () => {
  // Bug: branches pile up in the checkout, or the main branch and a fresh one are called trash.
  const where = folders();
  const checkout = checkoutOf(where);
  const { result } = await collect(
    where,
    clean({
      status: { [where.installDir]: '', [checkout]: '' },
      merged: 'main\nspec-merged\n',
      refs: [
        `main ${unixOf(NOW)}`,
        `spec-merged ${unixOf(NOW)}`,
        `spec-abandoned ${unixOf(NOW - 365 * DAY_MS)}`,
        `spec-fresh ${unixOf(NOW - DAY_MS)}`,
      ].join('\n'),
      worktrees: [
        `worktree ${checkout}\nHEAD a\nbranch refs/heads/main\n`,
        `worktree /work/on-merged\nHEAD b\nbranch refs/heads/spec-merged\n`,
        `worktree /work/gone\nHEAD c\nbranch refs/heads/spec-fresh\nprunable gitdir file points to non-existent location\n`,
        `worktree /work/fresh\nHEAD d\nbranch refs/heads/spec-fresh\n`,
      ].join('\n'),
    }),
    { checkout }
  );
  assert.deepEqual(namesIn(result, 'dead-branches'), ['spec-abandoned', 'spec-merged']);
  assert.deepEqual(namesIn(result, 'dead-worktrees'), ['/work/gone', '/work/on-merged']);
  assert.ok(
    result.items.filter((item) => item.category === 'dead-branches').every((item) => item.where === 'checkout')
  );
});

test('an old folder under .worktrees with no task is listed; a fresh one and one with a task are not', async () => {
  // Bug: a finished task's worktree holds gigabytes for a year, or a run in progress is called trash.
  const where = folders();
  const checkout = checkoutOf(where);
  const old = new Date(NOW - 365 * DAY_MS);
  for (const name of ['T-orphan', 'T-open', 'T-fresh']) {
    fs.mkdirSync(path.join(checkout, '.worktrees', name), { recursive: true });
  }
  fs.utimesSync(path.join(checkout, '.worktrees', 'T-orphan'), old, old);
  fs.utimesSync(path.join(checkout, '.worktrees', 'T-open'), old, old);
  fs.utimesSync(path.join(checkout, '.worktrees', 'T-fresh'), new Date(NOW), new Date(NOW));
  const { result } = await collect(where, clean({ status: { [where.installDir]: '', [checkout]: '' } }), {
    checkout,
    tasks: () => ['T-open'],
  });
  assert.deepEqual(namesIn(result, 'old-worktrees'), [path.join('.worktrees', 'T-orphan')]);
});

test('with the board out of reach, old worktrees are unavailable rather than called orphans', async () => {
  // Bug: no task list reads as "no task", and every worktree is reported on the day the core is down.
  const where = folders();
  const checkout = checkoutOf(where);
  fs.mkdirSync(path.join(checkout, '.worktrees', 'T-1'), { recursive: true });
  const { result } = await collect(where, clean({ status: { [where.installDir]: '', [checkout]: '' } }), {
    checkout,
    tasks: () => null,
  });
  assert.deepEqual(namesIn(result, 'old-worktrees'), []);
  assert.equal(missing(result, 'old-worktrees'), true);
});

test('the checkout gets its own stray files and symlinks, each marked with where it is', async () => {
  // Bug: two folders' leftovers read as one, and the owner looks for a file in the wrong tree.
  const where = folders();
  const checkout = checkoutOf(where);
  fs.symlinkSync(path.join(where.root, 'gone'), path.join(checkout, 'broken'));
  const { result } = await collect(
    where,
    clean({ status: { [where.installDir]: '?? in-install\n', [checkout]: '?? in-checkout\n' } }),
    { checkout }
  );
  const where_ = (name: string) => result.items.find((item) => item.name === name)?.where;
  assert.equal(where_('in-install'), 'install');
  assert.equal(where_('in-checkout'), 'checkout');
  assert.equal(where_('broken'), 'checkout');
});

test('with no checkout configured nothing asks about one and the install half still reports', async () => {
  // Bug: a public install, which has no development checkout, fails the section or searches a folder it does not have.
  const where = folders();
  const { result, calls } = await collect(where, clean({ status: { [where.installDir]: '?? stray.log\n' } }), {
    checkout: null,
  });
  assert.deepEqual(namesIn(result, 'stray-files'), ['stray.log']);
  assert.equal(
    result.items.some((item) => item.where === 'checkout'),
    false
  );
  const git = calls.filter((call) => call.command === 'git');
  for (const call of git) assert.equal(call.args[call.args.indexOf('-C') + 1], where.installDir);
  for (const word of ['--merged', 'for-each-ref', 'worktree']) {
    assert.equal(
      git.some((call) => call.args.includes(word)),
      false,
      word
    );
  }
});

test('a checkout git cannot read makes its categories unavailable, and the install half stands', async () => {
  // Bug: a broken checkout takes the install's findings with it, or reads as "no dead branches".
  const where = folders();
  const checkout = checkoutOf(where);
  const { result } = await collect(
    where,
    clean({
      status: { [where.installDir]: '?? stray.log\n', [checkout]: null },
      merged: null,
      refs: null,
      worktrees: null,
    }),
    { checkout }
  );
  assert.deepEqual(namesIn(result, 'stray-files'), ['stray.log']);
  for (const category of ['stray-files', 'dead-branches', 'dead-worktrees']) {
    assert.ok(
      result.unavailable.some((one) => one.category === category && one.where === 'checkout'),
      category
    );
  }
});

// ---- the whole collector ----------------------------------------------------------------------------------------------

test('with nothing readable every category is a named unavailable item, each with its reason', async () => {
  // Bug: one category forgets its failure path and reads silently empty, which is the report's worst lie.
  const where = folders();
  const checkout = checkoutOf(where);
  fs.rmSync(where.unitDir, { recursive: true });
  fs.rmSync(where.installDir, { recursive: true });
  fs.rmSync(checkout, { recursive: true });
  fs.writeFileSync(localConfigPath(where.data), '{');
  const { result } = await collect(where, {}, { checkout, tasks: () => null });
  assert.deepEqual(result.items, []);
  const named = new Set(result.unavailable.map((one) => one.category));
  assert.deepEqual([...named].sort(), [...CATEGORIES].sort());
  for (const one of result.unavailable) assert.notEqual(one.reason.trim(), '', one.category);
});

test('a run that throws is an unavailable category, never a rejected collection', async () => {
  // Bug: one tool crash loses the whole section, and the watcher reports nothing about any of it.
  const { collectTrash } = await trash();
  const where = folders();
  const result = await collectTrash({
    installDir: where.installDir,
    checkout: null,
    unitDir: where.unitDir,
    env: where.env,
    run: () => Promise.reject(new Error('spawn failed')),
    now: () => NOW,
    tasks: () => [],
  });
  assert.equal(
    result.unavailable.some((one) => one.category === 'identities'),
    true
  );
});

test('a category over its limit is cut and says so', async () => {
  // Bug: a folder of ten thousand stray files fills the evidence page, or the cut reads as the whole list.
  const { TRASH_ITEM_LIMIT } = await trash();
  const where = folders();
  const lines = Array.from({ length: TRASH_ITEM_LIMIT + 5 }, (_, i) => `?? stray-${i}`).join('\n');
  const { result } = await collect(where, clean({ status: { [where.installDir]: lines } }));
  assert.equal(namesIn(result, 'stray-files').length, TRASH_ITEM_LIMIT);
  assert.equal(missing(result, 'stray-files'), true);
});

test('nothing is changed: every command is a read, and the leftovers are still there', async () => {
  // Bug: a helpful `git worktree prune` or `rm` arrives in a report collector, and a watcher deletes what it was to list.
  const where = folders();
  const checkout = checkoutOf(where);
  const broken = path.join(where.installDir, 'broken');
  fs.symlinkSync(path.join(where.root, 'gone'), broken);
  writeUnit(where.unitDir, 'neptunia-old.service', `ExecStart=${where.root}/gone/tool`);
  const { calls } = await collect(
    where,
    clean({
      status: { [where.installDir]: '?? stray\n', [checkout]: '' },
      enabled: { 'neptunia-old.service': 'disabled' },
      passwd: 'neptunia-dead:x:3:3::/home/c:/bin/sh',
      owned: { 'neptunia-dead': '' },
      merged: 'spec-merged\n',
    }),
    { checkout }
  );
  const allowed = new Set(['getent', 'ps', 'ls', 'find', 'systemctl', 'git']);
  for (const { command, args } of calls) {
    assert.ok(allowed.has(command), command);
    const line = args.join(' ');
    assert.doesNotMatch(
      line,
      /(^| )(-delete|-exec|prune|clean|gc|fetch|remove|-d|-D|stop|disable|reset-failed|daemon-reload)( |$)/
    );
  }
  assert.equal(fs.lstatSync(broken).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(where.unitDir, 'neptunia-old.service')), true);
});

// ---- through service watcher evidence --------------------------------------------------------------------------------

test('service watcher evidence carries the trash, with the configured checkout in it', async () => {
  // Bug: the collector exists and the agent's one read path does not reach it, so `Trash` is written from guesses.
  const where = folders();
  const checkout = checkoutOf(where);
  fs.writeFileSync(localConfigPath(where.data), JSON.stringify({ selfimprovement: { checkout } }));
  const fake = fakeRun(clean({ status: { [checkout]: '?? in-checkout\n' } }));
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: where.data,
      dataDir: where.data,
      config: () => readConfig(REPO, { privateDir: where.data }),
      now: () => NOW,
      env: where.env,
      coreUp: false,
      run: fake.run,
    },
    'service.watcher.evidence',
    {}
  );
  assert.equal(answer.status, 'ok', answer.text.slice(0, 200));
  const page = JSON.parse(answer.text) as { trash: Result };
  const item = page.trash.items.find((one) => one.name === 'in-checkout');
  assert.equal(item?.category, 'stray-files');
  assert.equal(item?.where, 'checkout');
});
