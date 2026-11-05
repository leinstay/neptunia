// What the watcher's `Trash` section lists: leftovers by category, with a name, a reason and where each sits. It is the one
// place the watcher looks at a development checkout, which only `services watcher evidence` passes in, and an install with
// none reports its own half. Every command is a read through the injected `run`, nothing is deleted, and no leftover's
// contents are opened: names, link targets' existence and file times only, a name shaped like a key masked. A category
// that cannot be read is named in `unavailable`, so an empty one means it was looked at. The owner decides what goes.

import fs from 'node:fs';
import path from 'node:path';
import { localConfigPath } from '../config/files.ts';
import { moveConfigKeys } from '../config-moves.ts';
import { cutConfigKeys } from '../config/cut.ts';
import { maskCredentials } from './report.ts';

export type TrashCategory =
  | 'units'
  | 'identities'
  | 'state-folders'
  | 'stray-files'
  | 'dangling-symlinks'
  | 'retired-config-keys'
  | 'unloaded-files'
  | 'dead-branches'
  | 'dead-worktrees'
  | 'old-worktrees';
export type TrashWhere = 'install' | 'checkout' | 'system';
export type TrashItem = { name: string; category: TrashCategory; reason: string; where: TrashWhere };
export type TrashGap = { category: TrashCategory; where: TrashWhere; reason: string };
export type Trash = { items: Array<TrashItem>; unavailable: Array<TrashGap> };

type RunResult = { code: number; stdout: string; stderr: string };
export type TrashInput = {
  installDir: string;
  checkout: string | null;
  unitDir: string;
  env: Readonly<Record<string, string | undefined>>;
  run: (command: string, args: ReadonlyArray<string>) => Promise<RunResult>;
  now: () => number;
  /** The ids of the tasks still open; null when the board cannot be read. */
  tasks?: () => ReadonlyArray<string> | null;
};

/** The most items of one category in one place. */
export const TRASH_ITEM_LIMIT = 50;
/** A worktree folder this long untouched, with no open task, is old. */
export const OLD_WORKTREE_DAYS = 30;
/** A branch with no commit for this long is abandoned. */
export const ABANDONED_BRANCH_DAYS = 14;

const DAY_MS = 86_400_000;
const PREFIX = 'neptunia-';
const WALK_LIMIT = 100_000;
const NOT_WALKED: ReadonlySet<string> = new Set(['node_modules', '.git', '.worktrees', '.claude']);
const LONG_LIVED: ReadonlySet<string> = new Set(['main', 'master']);
// Where a removed identity's files would be; a search of the whole disk would stall the inspection.
const OWNER_ROOTS = ['/home', '/var/lib', '/srv', '/opt', '/etc'];
const SCRIPT = /\.(?:ts|mts|js|mjs|cjs|sh|py)$/;

/** What a category adds to: the cut at the limit happens here, once. */
type Sink = { item(name: string, reason: string): void; missing(reason: string): void };

function sinkOf(out: Trash, category: TrashCategory, where: TrashWhere): Sink {
  let count = 0;
  const missing = (reason: string): void => {
    out.unavailable.push({ category, where, reason });
  };
  return {
    item(name, reason) {
      count += 1;
      if (count === TRASH_ITEM_LIMIT + 1) missing(`more than ${TRASH_ITEM_LIMIT}, and the list is cut there`);
      if (count > TRASH_ITEM_LIMIT) return;
      out.items.push({ name: maskCredentials(name).text, category, reason, where });
    },
    missing,
  };
}

/** One category: whatever it throws is that category's gap and never the collection's. */
async function category(
  out: Trash,
  name: TrashCategory,
  where: TrashWhere,
  work: (sink: Sink) => void | Promise<void>
): Promise<void> {
  const sink = sinkOf(out, name, where);
  try {
    await work(sink);
  } catch {
    sink.missing('the read failed');
  }
}

const linesOf = (text: string): Array<string> =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The text of each unit of ours in the folder; null when the folder cannot be read. */
function readUnits(unitDir: string): Map<string, string> | null {
  try {
    const names = fs.readdirSync(unitDir).filter((name) => name.startsWith(PREFIX));
    return new Map(names.map((name) => [name, fs.readFileSync(path.join(unitDir, name), 'utf8')]));
  } catch {
    return null;
  }
}

/** Why a unit's `ExecStart` cannot run, or null: its binary or a script it names is gone. */
function brokenStart(text: string): string | null {
  const dir = /^WorkingDirectory=(.+)$/m.exec(text)?.[1]?.trim();
  for (const [, line] of text.matchAll(/^ExecStart=(.*)$/gm)) {
    const words = (line ?? '').replace(/^[-@:+!]+/, '').split(/\s+/);
    const [binary, ...rest] = words;
    if (binary !== undefined && path.isAbsolute(binary) && !fs.existsSync(binary)) return 'its binary is gone';
    for (const word of rest) {
      if (!SCRIPT.test(word) || /[%$]/.test(word)) continue;
      if (!path.isAbsolute(word) && dir === undefined) continue;
      if (!fs.existsSync(path.resolve(dir ?? '/', word))) return 'its script is gone';
    }
  }
  return null;
}

/** Whether another unit names this one, or a timer of its name starts it. */
function isReferenced(name: string, units: ReadonlyMap<string, string>): boolean {
  const timer = name.replace(/\.service$/, '.timer');
  if (timer !== name && units.has(timer)) return true;
  return [...units].some(([other, text]) => other !== name && text.includes(name));
}

async function collectUnits(input: TrashInput, units: ReadonlyMap<string, string> | null, sink: Sink): Promise<void> {
  if (units === null) {
    sink.missing('the unit folder cannot be read');
    return;
  }
  const scope = input.env.NEPTUNIA_UNIT_SCOPE === 'user' ? ['--user'] : [];
  let unanswered = false;
  for (const [name, text] of units) {
    const broken = brokenStart(text);
    if (broken !== null) {
      sink.item(name, broken);
      continue;
    }
    // A template has no state of its own, its instances do.
    if (name.includes('@.')) continue;
    const word = (await input.run('systemctl', [...scope, 'is-enabled', name])).stdout.trim();
    if (word === '') unanswered = true;
    else if (word === 'disabled' && !isReferenced(name, units)) sink.item(name, 'disabled, and nothing starts it');
  }
  if (unanswered) sink.missing('the manager did not say whether each unit is enabled');
}

/** The names with our prefix in `getent <database>`, or null. */
async function namesInDatabase(input: TrashInput, database: string): Promise<Array<string> | null> {
  const answer = await input.run('getent', [database]);
  if (answer.code !== 0) return null;
  return linesOf(answer.stdout)
    .map((line) => line.split(':')[0] ?? '')
    .filter((name) => name.startsWith(PREFIX));
}

/** Whether `flag name` owns a file under the roots: null when the search gave no answer. A refused search proves nothing. */
async function ownsFiles(input: TrashInput, flag: '-user' | '-group', name: string): Promise<boolean | null> {
  const answer = await input.run('find', [...OWNER_ROOTS, '-xdev', '-maxdepth', '4', flag, name, '-print', '-quit']);
  if (answer.stdout.trim() !== '') return true;
  return answer.code === 0 ? false : null;
}

async function collectIdentities(input: TrashInput, sink: Sink): Promise<void> {
  const users = await namesInDatabase(input, 'passwd');
  const groups = await namesInDatabase(input, 'group');
  const ps = await input.run('ps', ['-eo', 'user=,group=']);
  if (users === null || groups === null || ps.code !== 0) {
    sink.missing('the users, the groups or the processes cannot be listed');
    return;
  }
  const running = new Set(ps.stdout.split(/\s+/));
  let unsearched = false;
  for (const name of new Set([...users, ...groups])) {
    if (running.has(name)) continue;
    const owns = [
      ...(users.includes(name) ? [await ownsFiles(input, '-user', name)] : []),
      ...(groups.includes(name) ? [await ownsFiles(input, '-group', name)] : []),
    ];
    if (owns.includes(true)) continue;
    if (owns.includes(null)) unsearched = true;
    else sink.item(name, 'owns no process and no file under the searched folders');
  }
  if (unsearched) sink.missing('an owner could not be searched for');
}

async function collectStateFolders(
  input: TrashInput,
  units: ReadonlyMap<string, string> | null,
  sink: Sink
): Promise<void> {
  const answer = await input.run('ls', ['-1', '/var/lib']);
  if (answer.code !== 0 || units === null) {
    sink.missing('/var/lib or the unit folder cannot be read');
    return;
  }
  const texts = [...units.values()];
  for (const name of linesOf(answer.stdout)) {
    if (name.startsWith(PREFIX) && !texts.some((text) => text.includes(name))) {
      sink.item(`/var/lib/${name}`, 'no unit names it');
    }
  }
}

async function collectStray(input: TrashInput, dir: string, sink: Sink): Promise<void> {
  const answer = await input.run('git', ['-C', dir, 'status', '--porcelain']);
  if (answer.code !== 0) {
    sink.missing('git cannot read this folder');
    return;
  }
  for (const line of answer.stdout.split('\n')) {
    if (line.startsWith('?? ')) sink.item(line.slice(3).trim().replace(/^"|"$/g, ''), 'untracked');
  }
}

function collectDangling(dir: string, sink: Sink): void {
  const stack = [dir];
  let seen = 0;
  let closed = false;
  fs.statSync(dir);
  while (stack.length > 0) {
    const here = stack.pop() ?? '';
    let entries: Array<fs.Dirent> = [];
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      closed = true;
    }
    for (const entry of entries) {
      seen += 1;
      const full = path.join(here, entry.name);
      if (entry.isDirectory() && !NOT_WALKED.has(entry.name)) stack.push(full);
      else if (entry.isSymbolicLink() && !fs.existsSync(full))
        sink.item(path.relative(dir, full), 'its target is gone');
    }
    if (seen > WALK_LIMIT) {
      sink.missing(`the walk stopped after ${WALK_LIMIT} entries`);
      return;
    }
  }
  if (closed) sink.missing('a folder could not be read');
}

/** The keys of the settings file that nothing reads under that name, by name and never with a value. */
function collectRetiredKeys(input: TrashInput, sink: Sink): void {
  const privateDir = input.env.NEPTUNIA_PRIVATE_DIR;
  if (privateDir === undefined) {
    sink.missing('the private layer is unknown');
    return;
  }
  let text: string;
  try {
    text = fs.readFileSync(localConfigPath(privateDir), 'utf8');
  } catch {
    return;
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const moved = moveConfigKeys(structuredClone(parsed));
  const cut = cutConfigKeys(structuredClone(parsed));
  const keys = new Set([
    ...moved.moved.map((one) => one.from),
    ...moved.shadowed.map((one) => one.from),
    ...moved.dropped,
    ...moved.toDatabase,
    ...cut.cut,
    ...cut.renamed.map((one) => one.from),
  ]);
  for (const key of keys) sink.item(key, 'nothing reads this name');
}

/** Every code file under a folder as one text, for the search for a name; the leftovers themselves are never opened. */
function sourceText(dir: string): string {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

const mdIn = (dir: string): Array<string> => {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
};

/** The prompt files no source names and the agent files no profile names. */
function collectUnloaded(input: TrashInput, sink: Sink): void {
  const root = input.installDir;
  fs.statSync(root);
  const prompts = mdIn(path.join(root, 'prompts'));
  if (prompts.length > 0) {
    const source = sourceText(path.join(root, 'src'));
    for (const file of prompts) {
      const stem = file.slice(0, -'.md'.length).replace(/[^\w-]/g, '\\$&');
      if (!new RegExp(`(?<![\\w-])${stem}(?![\\w-])`).test(source)) {
        sink.item(path.join('prompts', file), 'no source names it');
      }
    }
  }
  const agents = path.join(root, 'agents');
  const names = fs.existsSync(agents) ? fs.readdirSync(agents) : [];
  for (const agent of names) {
    const profile = path.join(agents, agent, 'profile.json');
    if (!fs.existsSync(profile)) continue;
    const { prompt } = JSON.parse(fs.readFileSync(profile, 'utf8')) as { prompt?: unknown };
    for (const file of mdIn(path.join(agents, agent))) {
      if (file !== prompt) sink.item(path.join('agents', agent, file), 'its profile does not name it');
    }
  }
}

/** The branches merged into main, or null. */
async function mergedBranches(input: TrashInput, checkout: string): Promise<Set<string> | null> {
  const answer = await input.run('git', ['-C', checkout, 'branch', '--merged', 'main', '--format=%(refname:short)']);
  if (answer.code !== 0) return null;
  return new Set(linesOf(answer.stdout).filter((name) => !LONG_LIVED.has(name)));
}

async function collectBranches(
  input: TrashInput,
  checkout: string,
  merged: Set<string> | null,
  sink: Sink
): Promise<void> {
  if (merged === null) sink.missing('git cannot list the merged branches');
  for (const name of merged ?? []) sink.item(name, 'merged into main');
  const refs = await input.run('git', [
    '-C',
    checkout,
    'for-each-ref',
    '--format=%(refname:short) %(committerdate:unix)',
    'refs/heads',
  ]);
  if (refs.code !== 0) {
    sink.missing('git cannot list the branches');
    return;
  }
  const before = input.now() - ABANDONED_BRANCH_DAYS * DAY_MS;
  for (const line of linesOf(refs.stdout)) {
    const [name = '', at] = line.split(' ');
    if (LONG_LIVED.has(name) || merged?.has(name) === true) continue;
    if (Number(at) * 1000 < before) sink.item(name, `no commit for ${ABANDONED_BRANCH_DAYS} days`);
  }
}

async function collectWorktrees(
  input: TrashInput,
  checkout: string,
  merged: Set<string> | null,
  sink: Sink
): Promise<void> {
  const answer = await input.run('git', ['-C', checkout, 'worktree', 'list', '--porcelain']);
  if (answer.code !== 0) {
    sink.missing('git cannot list the worktrees');
    return;
  }
  for (const block of answer.stdout.split(/\n\s*\n/)) {
    const lines = linesOf(block);
    const place = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (place === undefined || place === checkout) continue;
    const branch = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
    if (lines.some((line) => line.startsWith('prunable'))) sink.item(place, 'its folder is gone');
    else if (branch !== undefined && merged?.has(branch) === true) sink.item(place, 'its branch is merged');
  }
}

function collectOldWorktrees(input: TrashInput, checkout: string, sink: Sink): void {
  const tasks = input.tasks?.() ?? null;
  if (tasks === null) {
    sink.missing('the board cannot say which tasks are open');
    return;
  }
  fs.statSync(checkout);
  const folder = path.join(checkout, '.worktrees');
  if (!fs.existsSync(folder)) return;
  const before = input.now() - OLD_WORKTREE_DAYS * DAY_MS;
  for (const name of fs.readdirSync(folder)) {
    if (tasks.includes(name) || fs.statSync(path.join(folder, name)).mtimeMs >= before) continue;
    sink.item(path.join('.worktrees', name), `untouched for ${OLD_WORKTREE_DAYS} days, with no open task`);
  }
}

/** The categories of a development checkout, each marked `checkout`. */
async function collectCheckout(input: TrashInput, checkout: string, out: Trash): Promise<void> {
  await category(out, 'stray-files', 'checkout', (sink) => collectStray(input, checkout, sink));
  await category(out, 'dangling-symlinks', 'checkout', (sink) => {
    collectDangling(checkout, sink);
  });
  let merged: Set<string> | null = null;
  await category(out, 'dead-branches', 'checkout', async (sink) => {
    merged = await mergedBranches(input, checkout);
    await collectBranches(input, checkout, merged, sink);
  });
  await category(out, 'dead-worktrees', 'checkout', (sink) => collectWorktrees(input, checkout, merged, sink));
  await category(out, 'old-worktrees', 'checkout', (sink) => {
    collectOldWorktrees(input, checkout, sink);
  });
}

/** Everything left over that can be named. Reads only; never rejects. */
export async function collectTrash(input: TrashInput): Promise<Trash> {
  const out: Trash = { items: [], unavailable: [] };
  const units = readUnits(input.unitDir);
  await category(out, 'units', 'system', (sink) => collectUnits(input, units, sink));
  await category(out, 'identities', 'system', (sink) => collectIdentities(input, sink));
  await category(out, 'state-folders', 'system', (sink) => collectStateFolders(input, units, sink));
  await category(out, 'stray-files', 'install', (sink) => collectStray(input, input.installDir, sink));
  await category(out, 'dangling-symlinks', 'install', (sink) => {
    collectDangling(input.installDir, sink);
  });
  await category(out, 'retired-config-keys', 'install', (sink) => {
    collectRetiredKeys(input, sink);
  });
  await category(out, 'unloaded-files', 'install', (sink) => {
    collectUnloaded(input, sink);
  });
  if (input.checkout !== null) await collectCheckout(input, input.checkout, out);
  return out;
}
