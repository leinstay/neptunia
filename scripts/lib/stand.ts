// The replay stand of scripts/replay-stand.ts: every mode of scripts/replay.ts run over the invented data folder of
// scripts/lib/stand-world.ts, offline, with the clock, the random UUIDs and `Math.random` fixed
// (scripts/lib/stand-preload.ts), and every model request answered by `answerRequests` from
// scripts/fixtures/replay-stand/answers.json. `runStand` runs the cases at one checkout, the engine, and keeps for each
// case its exit code, its stdout and every file it wrote. `compareStands` compares two such runs case by case: every
// request of every step part by part (the model, the purpose, the system text, each block of the user text, the
// messages after it, the tool names, each tool's schema and the tool choice), and every other file, stdout and the exit
// code byte for byte.
//
// A checkout with `scripts/turn-replay.ts` runs the stored-turn cases and the cuts through that command, with the same
// arguments, so the stand compares the same scenarios on the commits before and after the stored-turn mode joined
// scripts/replay.ts. A case whose turns run at a moment of the past reads the memory of that moment: the copy cut at a
// stored turn's start with the checkout's own `--cut`, handed over as `--snapshot`. The stored-turn cases read the
// copy whole, because `--answers archive` and `--compare` read the archived requests a cut removes, and the inner
// turn and the diary day run at the stand's moment, after every line.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { STAND_AT, WORLD } from './stand-world.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures', 'replay-stand');
const PRELOAD = path.join(HERE, 'stand-preload.ts');

/** How long one case may run before it is stopped and reported. */
const CASE_TIMEOUT_MS = 60_000;

/** How many cases run at once. */
const PARALLEL = 6;

/** The paths a case's arguments name. */
export type CaseDirs = {
  data: string;
  out: string;
  answers: string;
  oracle: string;
  fixtures: string;
};

/** One case: what it checks and its arguments. */
export type StandCase = {
  name: string;
  scenario: string;
  argv: (dirs: CaseDirs) => Array<string>;
  /** The stored-turn mode, run by `scripts/turn-replay.ts` on a checkout that has it. */
  stored?: boolean;
  /**
   * The stored turn whose start is the moment the case's turns read memory at: the copy is cut there first with the
   * checkout's own `--cut` and handed to the case as `--snapshot`.
   */
  moment?: string;
};

const T = WORLD.turns;
const answered = (dirs: CaseDirs) => ['--answers-dir', dirs.answers];
const turn =
  (id: string, ...rest: Array<string>) =>
  (dirs: CaseDirs) => [
    '--data',
    dirs.data,
    '--turn',
    id,
    '--seed',
    'stand',
    '--out',
    dirs.out,
    ...rest.flatMap((arg) =>
      arg === '<answers>' ? answered(dirs) : arg === '<prompts>' ? [path.join(dirs.fixtures, 'prompts')] : [arg]
    ),
  ];

/** The cases of the stand, in the order they are reported. */
export const STAND_CASES: ReadonlyArray<StandCase> = [
  {
    name: 'message-mention',
    scenario: 'the message mode on a line that names the persona, with --show-request',
    argv: (dirs) => [WORLD.tea, WORLD.mention, '--show-request', ...answered(dirs)],
    moment: T.mention,
  },
  {
    name: 'message-reply',
    scenario: "the message mode on a line that answers the persona's line, its kind read off the journal",
    argv: (dirs) => [WORLD.tea, WORLD.reply, ...answered(dirs)],
    moment: T.discord,
  },
  {
    name: 'dump',
    scenario: '--show-request of a turn whose request dump the journal kept',
    argv: () => ['--show-request', T.dump],
  },
  {
    name: 'dump-steps',
    scenario: '--show-request --steps of the same turn, with its later step',
    argv: () => ['--show-request', T.dump, '--steps'],
  },
  {
    name: 'rebuilt',
    scenario: "--show-request of the Discord turn, rebuilt from the journal's turn.start",
    argv: () => ['--show-request', T.discord],
    moment: T.discord,
  },
  {
    name: 'skills',
    scenario: "--skills: one turn, a * grant, three steps with a burst and a line of the persona's, an errand result",
    argv: (dirs) => ['--skills', path.join(dirs.fixtures, 'scenarios.json'), '--out', dirs.out, ...answered(dirs)],
    moment: T.discord,
  },
  {
    name: 'skills-dry',
    scenario: '--skills --dry',
    argv: (dirs) => ['--skills', path.join(dirs.fixtures, 'scenarios.json'), '--dry', '--out', dirs.out],
    moment: T.discord,
  },
  {
    name: 'skills-dry-variants',
    scenario: '--skills --dry with two --variant',
    argv: (dirs) => [
      '--skills',
      path.join(dirs.fixtures, 'scenarios.json'),
      '--dry',
      '--variant',
      '--core stand/stand/core-a',
      '--variant',
      '--core stand/stand/core-b',
      '--out',
      dirs.out,
    ],
    moment: T.discord,
  },
  {
    name: 'loop-triggers',
    scenario: '--loop-triggers over a file naming the reply',
    argv: (dirs) => [
      '--loop-triggers',
      '--triggers',
      path.join(dirs.fixtures, 'triggers.txt'),
      '--out',
      dirs.out,
      ...answered(dirs),
    ],
    moment: T.discord,
  },
  {
    name: 'loop-trigger-mention',
    scenario: '--loop-triggers on the mention named on the command line',
    argv: (dirs) => ['--loop-triggers', WORLD.tea, WORLD.mention, '--out', dirs.out, ...answered(dirs)],
    moment: T.mention,
  },
  {
    name: 'diary-day',
    scenario: '--diary-day, a seeded day',
    argv: (dirs) => ['--diary-day', '--seed', 'stand', '--out', dirs.out, '--spend', '1', ...answered(dirs)],
  },
  {
    name: 'diary-kind',
    scenario: '--diary-day --diary-kind picture --samples 2',
    argv: (dirs) => [
      '--diary-day',
      '--diary-kind',
      'picture',
      '--samples',
      '2',
      '--seed',
      'stand',
      '--out',
      dirs.out,
      '--spend',
      '1',
      ...answered(dirs),
    ],
  },
  {
    name: 'inner-heartbeat',
    scenario: '--inner heartbeat --samples 2',
    argv: (dirs) => [
      '--inner',
      'heartbeat',
      '--samples',
      '2',
      '--seed',
      'stand',
      '--out',
      path.join(dirs.out, 'inner.md'),
      ...answered(dirs),
    ],
  },
  {
    name: 'turn-cli-archive',
    scenario: 'the command line turn answered from the archive',
    argv: turn(T.cli, '--answers', 'archive'),
    stored: true,
  },
  {
    name: 'turn-discord-archive',
    scenario: 'the Discord turn answered from the archive',
    argv: turn(T.discord, '--answers', 'archive'),
    stored: true,
  },
  {
    name: 'turn-diary-archive',
    scenario: 'the diary turn answered from the archive',
    argv: turn(T.diary, '--answers', 'archive'),
    stored: true,
  },
  {
    name: 'turn-cli-files',
    scenario: 'the command line turn answered from files',
    argv: turn(T.cli, '<answers>'),
    stored: true,
  },
  {
    name: 'turn-discord-files',
    scenario: 'the Discord turn answered from files',
    argv: turn(T.discord, '<answers>'),
    stored: true,
  },
  {
    name: 'turn-diary-files',
    scenario: 'the diary turn answered from files',
    argv: turn(T.diary, '<answers>'),
    stored: true,
  },
  {
    name: 'turn-diary-kind',
    scenario: 'the diary turn answered from files with --kind picture',
    argv: turn(T.diary, '--kind', 'picture', '<answers>'),
    stored: true,
  },
  {
    name: 'turn-discord-samples',
    scenario: 'the Discord turn answered from files, --samples 2',
    argv: turn(T.discord, '--samples', '2', '<answers>'),
    stored: true,
  },
  {
    name: 'turn-prompts-archive',
    scenario: 'the command line turn under --prompts, answered from the archive',
    argv: turn(T.cli, '--prompts', '<prompts>', '--answers', 'archive'),
    stored: true,
  },
  {
    name: 'turn-cli-compare',
    scenario: 'the command line turn --compare with its archived request',
    argv: (dirs) => [...turn(T.cli, '<answers>')(dirs), '--compare', '--oracle', dirs.oracle],
    stored: true,
  },
  {
    name: 'turn-diary-compare',
    scenario: 'the diary turn --compare with its archived requests',
    argv: (dirs) => [...turn(T.diary, '<answers>')(dirs), '--compare', '--oracle', dirs.oracle],
    stored: true,
  },
  {
    name: 'cut',
    scenario: '--cut of the copy at the Discord turn',
    argv: (dirs) => ['--data', dirs.data, '--cut', T.discord, '--into', path.join(dirs.out, 'cut')],
    stored: true,
  },
];

type Answer = { text: string; calls?: Array<{ name: string; arguments: unknown }> };
type Answers = { default: string; byPurpose: Record<string, Array<Answer>> };

/**
 * Answers every request a run writes to `dir` (scripts/lib/answers-dir.ts) until `done()`: the k-th request of a
 * purpose with the k-th answer of that purpose in `answers`, past them with its last, and a purpose with none with the
 * default text.
 */
function answerRequests(dir: string, answers: Answers, done: () => boolean): Promise<void> {
  const asked = new Map<string, number>();
  let next = 1;
  return new Promise((resolve) => {
    const tick = () => {
      for (;;) {
        const id = String(next).padStart(3, '0');
        const req = path.join(dir, `req-${id}.json`);
        if (!fs.existsSync(req)) break;
        const purpose = String((JSON.parse(fs.readFileSync(req, 'utf8')) as Request).purpose ?? '');
        const index = asked.get(purpose) ?? 0;
        asked.set(purpose, index + 1);
        const list = answers.byPurpose[purpose] ?? [];
        const answer = list[Math.min(index, list.length - 1)] ?? { text: answers.default };
        if (answer.calls !== undefined)
          fs.writeFileSync(path.join(dir, `ans-${id}.tool-calls.json`), JSON.stringify(answer.calls));
        fs.writeFileSync(path.join(dir, `ans-${id}.txt.tmp`), answer.text);
        fs.renameSync(path.join(dir, `ans-${id}.txt.tmp`), path.join(dir, `ans-${id}.txt`));
        next += 1;
      }
      if (done()) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

/** The rows of every table of a database file, in order, as text: a cut copy compared by content. */
function tablesText(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    return tables
      .map((name) => {
        const rows = db
          .prepare(`SELECT * FROM "${name}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
        return `## ${name}\n${rows.join('\n')}`;
      })
      .join('\n');
  } finally {
    db.close();
  }
}

/** Every file under `dir`, relative, in name order, with its text (a database as its tables). */
function filesOf(dir: string, rel = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let entries: Array<fs.Dirent> = [];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesOf(dir, child));
    else if (/\.db-(?:wal|shm)$|\.lock$/.test(entry.name)) continue;
    else if (entry.name.endsWith('.db')) out.push([child, tablesText(path.join(dir, child))]);
    else out.push([child, fs.readFileSync(path.join(dir, child), 'utf8')]);
  }
  return out;
}

/** What one case left: its exit code, stdout and files, every absolute path of the run spelled as a placeholder. */
export type CaseResult = {
  name: string;
  scenario: string;
  /** The command the case ran, relative to the checkout. */
  entry: string;
  exit: number | null;
  stdout: string;
  files: Record<string, string>;
};

/**
 * One command of the checkout `engine` under the preload, its requests answered in `answers` when given. Returns its
 * exit code, stdout and stderr; a run past CASE_TIMEOUT_MS is killed.
 */
async function runEngine(input: {
  engine: string;
  caseDir: string;
  data: string;
  discordFile: string;
  argv: Array<string>;
  answers: string | null;
}): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', PRELOAD, ...input.argv], {
    cwd: input.engine,
    env: {
      PATH: process.env.PATH,
      HOME: input.caseDir,
      TMPDIR: input.caseDir,
      TZ: 'UTC',
      NEPTUNIA_DATA_DIR: input.data,
      REPLAY_STAND_AT: new Date(STAND_AT).toISOString(),
      REPLAY_STAND_DISCORD: input.discordFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const timer = setTimeout(() => child.kill('SIGKILL'), CASE_TIMEOUT_MS);
  const answers = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'answers.json'), 'utf8')) as Answers;
  const answering = input.answers === null ? null : answerRequests(input.answers, answers, () => exited);
  const exit = await new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      exited = true;
      resolve(code);
    })
  );
  clearTimeout(timer);
  await answering;
  return { exit, stdout, stderr };
}

/** One case at the checkout `engine` in its own folder under `root`, over a copy of the world at `world`. */
async function runCase(
  stand: StandCase,
  { engine, root, world, discordFile }: { engine: string; root: string; world: string; discordFile: string }
): Promise<CaseResult> {
  const caseDir = path.join(root, stand.name);
  const dirs: CaseDirs = {
    data: path.join(caseDir, 'data'),
    out: path.join(caseDir, 'out'),
    answers: path.join(caseDir, 'answers'),
    oracle: path.join(caseDir, 'oracle', 'memory.db'),
    fixtures: FIXTURES,
  };
  fs.cpSync(world, dirs.data, { recursive: true });
  fs.mkdirSync(path.dirname(dirs.oracle), { recursive: true });
  fs.copyFileSync(path.join(world, 'memory.db'), dirs.oracle);
  fs.mkdirSync(dirs.out, { recursive: true });
  fs.mkdirSync(dirs.answers, { recursive: true });
  const storedEntry = fs.existsSync(path.join(engine, 'scripts', 'turn-replay.ts'))
    ? 'scripts/turn-replay.ts'
    : 'scripts/replay.ts';
  const entry = stand.stored === true ? storedEntry : 'scripts/replay.ts';
  const run = (argv: Array<string>, answering: boolean) =>
    runEngine({ engine, caseDir, data: dirs.data, discordFile, argv, answers: answering ? dirs.answers : null });
  let snapshot: Array<string> = [];
  if (stand.moment !== undefined) {
    const moment = path.join(caseDir, 'moment');
    const cut = await run([storedEntry, '--data', dirs.data, '--cut', stand.moment, '--into', moment], false);
    if (cut.exit !== 0) throw new Error(`replay-stand: ${stand.name}: the cut at ${stand.moment} failed`);
    snapshot = ['--snapshot', moment];
  }
  const { exit, stdout, stderr } = await run([entry, ...stand.argv(dirs), ...snapshot], true);
  fs.writeFileSync(path.join(caseDir, 'stderr.txt'), stderr);
  const spell = (text: string) => text.replaceAll(caseDir, '<case>').replaceAll(engine, '<engine>');
  const files: Record<string, string> = {};
  for (const dir of ['out', 'answers'] as const)
    for (const [rel, text] of filesOf(path.join(caseDir, dir))) files[`${dir}/${rel}`] = spell(text);
  return { name: stand.name, scenario: stand.scenario, entry, exit, stdout: spell(stdout), files };
}

/**
 * The world written by a child process under the preload, so its ids, times and draws are the same in every run:
 * `node --import <preload> scripts/replay-stand.ts world <dir> <discord file>`, which calls `buildStandWorld`.
 */
async function buildWorld(world: string, discordFile: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--import', PRELOAD, path.join(HERE, '..', 'replay-stand.ts'), 'world', world, discordFile],
    {
      env: {
        PATH: process.env.PATH,
        TMPDIR: path.dirname(world),
        TZ: 'UTC',
        REPLAY_STAND_AT: new Date(STAND_AT).toISOString(),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  if (code !== 0) throw new Error(`replay-stand: the world was not built: ${stderr.trim().split('\n').at(-1) ?? ''}`);
}

/**
 * Runs `cases` (every case when null) at the checkout `engine` under `root`, which must not exist, and writes their
 * results to `<root>/results.json`.
 */
export async function runStand(
  engine: string,
  root: string,
  cases: ReadonlyArray<string> | null = null
): Promise<Array<CaseResult>> {
  if (fs.existsSync(root)) throw new Error(`replay-stand: ${root} exists`);
  const world = path.join(root, 'world');
  const discordFile = path.join(root, 'discord.json');
  fs.mkdirSync(root, { recursive: true });
  await buildWorld(world, discordFile);
  const chosen = STAND_CASES.filter((one) => cases === null || cases.includes(one.name));
  const results: Array<CaseResult> = [];
  let next = 0;
  const worker = async () => {
    while (next < chosen.length) {
      const at = next;
      next += 1;
      results[at] = await runCase(chosen[at], { engine: path.resolve(engine), root, world, discordFile });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  fs.writeFileSync(path.join(root, 'results.json'), `${JSON.stringify(results)}\n`);
  return results;
}

/** A request file as scripts/lib/answers-dir.ts#requestJson writes it. */
type Request = {
  model?: string;
  purpose?: string | null;
  system?: string | null;
  messages?: Array<{ role?: string; content?: string }>;
  tools?: Array<{ function?: { name?: string }; name?: string }>;
  toolChoice?: unknown;
};

/** The top-level blocks of a user text (`<name ...>` to `</name>`) and the text outside them. */
function blocksOf(text: string): Map<string, string> {
  const parts = new Map<string, string>();
  let outside = '';
  let rest = text;
  for (;;) {
    const open = /<([a-z_]+)(?:\s[^>]*)?>/.exec(rest);
    if (open === null) break;
    const close = rest.indexOf(`</${open[1]}>`, open.index);
    if (close < 0) break;
    outside += rest.slice(0, open.index);
    const end = close + open[1].length + 3;
    const key = `<${open[1]}>`;
    parts.set(parts.has(key) ? `${key} ${parts.size}` : key, rest.slice(open.index, end));
    rest = rest.slice(end);
  }
  parts.set('text outside the blocks', outside + rest);
  return parts;
}

const toolName = (tool: NonNullable<Request['tools']>[number]): string => String(tool.function?.name ?? tool.name);

/** A request split into the parts the compare names, each part's text. */
export function requestParts(request: Request): Map<string, string> {
  const parts = new Map<string, string>();
  parts.set('model', String(request.model));
  parts.set('purpose', String(request.purpose));
  parts.set('system text', String(request.system));
  const messages = request.messages ?? [];
  const first = messages.findIndex((message) => message.role === 'user');
  if (first >= 0) for (const [key, text] of blocksOf(String(messages[first].content))) parts.set(key, text);
  messages.forEach((message, i) => {
    if (i !== first) parts.set(`message ${i + 1} (${String(message.role)})`, JSON.stringify(message));
  });
  const tools = request.tools ?? [];
  parts.set('tool names', tools.map(toolName).join(' '));
  for (const tool of tools) parts.set(`tool schema ${toolName(tool)}`, JSON.stringify(tool));
  parts.set('tool choice', JSON.stringify(request.toolChoice ?? null));
  return parts;
}

/** How one part of the paired requests of a case compared: equal, differs, or held by one side alone. */
export type PartCount = { equal: number; differs: number; onlyA: number; onlyB: number };

/** The compare of one case. */
export type CaseCompare = {
  name: string;
  scenario: string;
  requests: [number, number];
  pairs: number;
  pairsEqual: number;
  parts: Record<string, PartCount>;
  files: { equal: number; differs: Array<string>; onlyA: Array<string>; onlyB: Array<string> };
  /** `other entry` when the two runs ran the case through different commands, whose stdout differs in form. */
  stdout: 'equal' | 'differs' | 'other entry';
  exit: [number | null, number | null];
  result: 'identical' | 'identical but stdout' | 'differs';
};

const REQUEST_FILE = /^answers\/req-\d+\.json$/;

/**
 * The request files of a case, grouped by purpose and turn, each group's steps in the order they went out. A request
 * whose messages go on after the user text is a later step of the turn before it (the tool loop's next request), any
 * other opens a turn. Two runs are paired turn by turn and step by step, so a step one run adds leaves the turns after
 * it paired as they are.
 */
function requestsByTurn(result: CaseResult): Map<string, Array<Request>> {
  const out = new Map<string, Array<Request>>();
  const turns = new Map<string, number>();
  for (const [rel, text] of Object.entries(result.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!REQUEST_FILE.test(rel)) continue;
    const request = JSON.parse(text) as Request;
    const purpose = String(request.purpose);
    const messages = request.messages ?? [];
    const later = messages.findIndex((message) => message.role === 'user') < messages.length - 1;
    const turn = (turns.get(purpose) ?? 0) + (later && turns.has(purpose) ? 0 : 1);
    turns.set(purpose, turn);
    const key = `${purpose} turn ${turn}`;
    out.set(key, [...(out.get(key) ?? []), request]);
  }
  return out;
}

/** Compares one case of two runs (see the head of this file). */
export function compareCase(a: CaseResult, b: CaseResult): CaseCompare {
  const left = requestsByTurn(a);
  const right = requestsByTurn(b);
  const { parts, pairs, pairsEqual } = compareRequests(left, right);
  const files = compareFiles(a.files, b.files);
  const stdout = a.stdout === b.stdout ? 'equal' : a.entry === b.entry ? 'differs' : 'other entry';
  const total = (m: Map<string, Array<Request>>) => [...m.values()].reduce((n, list) => n + list.length, 0);
  const requests: [number, number] = [total(left), total(right)];
  const same =
    requests[0] === requests[1] &&
    pairsEqual === pairs &&
    files.differs.length + files.onlyA.length + files.onlyB.length === 0 &&
    a.exit === b.exit;
  return {
    name: a.name,
    scenario: a.scenario,
    requests,
    pairs,
    pairsEqual,
    parts,
    files,
    stdout,
    exit: [a.exit, b.exit],
    result: !same || stdout === 'differs' ? 'differs' : stdout === 'equal' ? 'identical' : 'identical but stdout',
  };
}

/** How two parts compare: equal, different, or held by one side alone. */
const howOf = (x: string | undefined, y: string | undefined): keyof PartCount =>
  x === undefined ? 'onlyB' : y === undefined ? 'onlyA' : x === y ? 'equal' : 'differs';

/** The name a part is counted under: every tool schema together, every message after the user text by its role. */
const countedAs = (key: string): string =>
  key.startsWith('tool schema ') ? 'each tool schema' : key.replace(/^message \d+ /, 'message after the text ');

/** The requests of two runs of a case compared turn by turn and step by step, part by part. */
function compareRequests(
  left: Map<string, Array<Request>>,
  right: Map<string, Array<Request>>
): { parts: Record<string, PartCount>; pairs: number; pairsEqual: number } {
  const parts: Record<string, PartCount> = {};
  const count = (part: string, how: keyof PartCount) => {
    const counted = (parts[part] ??= { equal: 0, differs: 0, onlyA: 0, onlyB: 0 });
    counted[how] += 1;
  };
  let pairs = 0;
  let pairsEqual = 0;
  for (const turn of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(turn) ?? [];
    const y = right.get(turn) ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      if (x[i] === undefined || y[i] === undefined) {
        count('requests', x[i] === undefined ? 'onlyB' : 'onlyA');
        continue;
      }
      pairs += 1;
      count('requests', 'equal');
      const px = requestParts(x[i]);
      const py = requestParts(y[i]);
      const hows = [...new Set([...px.keys(), ...py.keys()])].map((key) => {
        const how = howOf(px.get(key), py.get(key));
        count(countedAs(key), how);
        return how;
      });
      if (hows.every((how) => how === 'equal')) pairsEqual += 1;
    }
  }
  return { parts, pairs, pairsEqual };
}

/** The files of two runs of a case but the request files, compared byte for byte. */
function compareFiles(a: Record<string, string>, b: Record<string, string>): CaseCompare['files'] {
  const files = { equal: 0, differs: [] as Array<string>, onlyA: [] as Array<string>, onlyB: [] as Array<string> };
  for (const rel of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (REQUEST_FILE.test(rel)) continue;
    if (!(rel in b)) files.onlyA.push(rel);
    else if (!(rel in a)) files.onlyB.push(rel);
    else if (a[rel] === b[rel]) files.equal += 1;
    else files.differs.push(rel);
  }
  return files;
}

/** Compares two runs of the stand case by case; a case only one run holds is reported as missing. */
export function compareStands(a: ReadonlyArray<CaseResult>, b: ReadonlyArray<CaseResult>): Array<CaseCompare> {
  const byName = new Map(b.map((result) => [result.name, result]));
  return a.map((result) => {
    const other = byName.get(result.name);
    if (other === undefined) throw new Error(`replay-stand: the second run has no case ${result.name}`);
    return compareCase(result, other);
  });
}

/** The compare as Markdown: one row per case, then the parts of every paired request summed over the cases. */
export function compareTable(rows: ReadonlyArray<CaseCompare>): string {
  const lines = [
    '| case | scenario | requests | equal pairs | parts that differ | other files | stdout | exit | result |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const differing = Object.entries(row.parts)
      .filter(([, n]) => n.differs + n.onlyA + n.onlyB > 0)
      .map(([part, n]) => `${part} (${n.differs + n.onlyA + n.onlyB})`)
      .join(', ');
    const { files } = row;
    const other = [
      `${files.equal} equal`,
      ...(files.differs.length > 0 ? [`differ: ${files.differs.join(' ')}`] : []),
      ...(files.onlyA.length > 0 ? [`only first: ${files.onlyA.join(' ')}`] : []),
      ...(files.onlyB.length > 0 ? [`only second: ${files.onlyB.join(' ')}`] : []),
    ].join(', ');
    lines.push(
      `| ${row.name} | ${row.scenario} | ${row.requests[0]}, ${row.requests[1]} | ${row.pairsEqual} of ${row.pairs} | ${differing} | ${other} | ${row.stdout} | ${row.exit[0]}, ${row.exit[1]} | ${row.result} |`
    );
  }
  const sums = new Map<string, PartCount>();
  for (const row of rows)
    for (const [part, n] of Object.entries(row.parts)) {
      const sum = sums.get(part) ?? { equal: 0, differs: 0, onlyA: 0, onlyB: 0 };
      sums.set(part, {
        equal: sum.equal + n.equal,
        differs: sum.differs + n.differs,
        onlyA: sum.onlyA + n.onlyA,
        onlyB: sum.onlyB + n.onlyB,
      });
    }
  lines.push('', '| part | equal | differs | only first | only second |', '|---|---|---|---|---|');
  for (const [part, n] of [...sums].sort(([x], [y]) => (x < y ? -1 : 1)))
    lines.push(`| ${part} | ${n.equal} | ${n.differs} | ${n.onlyA} | ${n.onlyB} |`);
  const count = (result: CaseCompare['result']) => rows.filter((row) => row.result === result).length;
  lines.push(
    '',
    `${count('identical')} of ${rows.length} cases identical, ${count('identical but stdout')} identical but the stdout of another command, ${count('differs')} differ`
  );
  return lines.join('\n');
}
