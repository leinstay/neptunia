// The core's words: no line of src/ names Discord, a "helper" model or an "organ", and no line of src/ or interfaces/
// names the slash command's table or its settings, except the lines this file allows. The allowlist holds what stays on
// purpose: the frozen migrations, the readers of the legacy namespace and the stored values they read, the entry point
// that loads the Discord package, the limit kinds the journal stores, and the old names of the keys the config moves
// drop. An entry names a file and a pattern of the line, never a line number, and every entry must still match a line,
// so a stale entry fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const INTERFACES = path.join(ROOT, 'interfaces');

type Allowed = { file: string; pattern: RegExp; why: string };

const DISCORD_ALLOWED: ReadonlyArray<Allowed> = [
  { file: 'src/memory/db/schema.js', pattern: /discord/i, why: 'frozen migrations and their notes' },
  { file: 'src/memory/db/legacy-namespace.ts', pattern: /discord/i, why: 'the legacy namespace' },
  { file: 'src/memory/db/ids.ts', pattern: /`[^`]*discord[^`]*`/, why: 'stored legacy ids and the stored iface value' },
  { file: 'src/memory/db/upsert.js', pattern: /`src:discord:/, why: 'a stored legacy message ref' },
  { file: 'src/memory/db/map/participation.js', pattern: /`src:discord:/, why: 'a stored legacy message ref' },
  { file: 'src/memory/db/map/versions.js', pattern: /`desc:(person:)?discord:/, why: 'stored legacy description ids' },
  { file: 'src/index.js', pattern: /discord/i, why: 'the entry point loads the Discord package and its token' },
  {
    file: 'src/tools/impl/metrics.ts',
    pattern: /'discord search'|`?discordMs`?/,
    why: 'the /nep metrics name and an old log field',
  },
  {
    file: 'src/interface/fake.js',
    pattern: /https:\/\/discord\.com\/channels\//,
    why: "the fake's jump links the tests read",
  },
];

const HELPER_ALLOWED: ReadonlyArray<Allowed> = [
  { file: 'src/llm/limits.js', pattern: /'helper-(timeout|fallback)'/, why: 'limit kinds the journal stores' },
  { file: 'src/turn/phases/request/wait.ts', pattern: /`?helper-timeout`?/, why: 'a limit kind the journal stores' },
  { file: 'src/behavior/planner.js', pattern: /`?helper-fallback`?/, why: 'a limit kind the journal stores' },
  { file: 'src/behavior/participation-pick.js', pattern: /`?helper-timeout`?/, why: 'a limit kind the journal stores' },
  { file: 'src/turn/act.ts', pattern: /`?helper-timeout`?/, why: 'a limit kind the journal stores' },
  { file: 'src/turn/draw-gif.ts', pattern: /`?helper-timeout`?/, why: 'a limit kind the journal stores' },
  { file: 'src/turn/lookup.ts', pattern: /`?helper-fallback`?/, why: 'a limit kind the journal stores' },
  { file: 'src/behavior/missed.js', pattern: /'missed: helper failed'/, why: 'a log line name' },
  { file: 'src/config-moves.ts', pattern: /helperTimeoutMs/, why: 'the old name of a moved config key' },
];

// `/nep` is gone (PR 7b of stage 7): its table, its key map and its two settings have no reader left.
const SLASH_COMMAND_ALLOWED: ReadonlyArray<Allowed> = [
  { file: 'src/config-moves.ts', pattern: /commandName|adminCommands/, why: 'the old names of dropped config keys' },
];

// An interface package's own `node_modules` holds its platform SDK, which is no code of ours.
function sourceFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...sourceFiles(full));
    } else files.push(full);
  }
  return files;
}

type Hit = { file: string; line: number; text: string };

function hitsOf(word: RegExp, dirs: ReadonlyArray<string> = [SRC]): Array<Hit> {
  const hits: Array<Hit> = [];
  for (const full of dirs.flatMap(sourceFiles)) {
    const file = path.relative(ROOT, full).split(path.sep).join('/');
    const lines = readFileSync(full, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (word.test(text)) hits.push({ file, line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

const isAllowed = (hit: Hit, allowed: ReadonlyArray<Allowed>): boolean =>
  allowed.some((entry) => entry.file === hit.file && entry.pattern.test(hit.text));

function checkWord(word: RegExp, allowed: ReadonlyArray<Allowed>, dirs: ReadonlyArray<string> = [SRC]): void {
  const hits = hitsOf(word, dirs);
  const outside = hits.filter((hit) => !isAllowed(hit, allowed)).map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
  assert.deepEqual(outside, []);
  const stale = allowed.filter((entry) => !hits.some((hit) => isAllowed(hit, [entry])));
  assert.deepEqual(stale, []);
}

test('names Discord in src/ only on the allowed lines', () => {
  checkWord(/discord/i, DISCORD_ALLOWED);
});

test('names no helper model in src/ outside the stored limit kinds, a log name and a moved key', () => {
  checkWord(/helper/i, HELPER_ALLOWED);
});

test('names no organ in src/', () => {
  checkWord(/\borgans?\b/i, []);
});

test('names no slash-command table, key map or command setting in src/ or interfaces/', () => {
  checkWord(/\bcommandName\b|\badminCommands\b|\bCOMMAND_TABLE\b|\bCOMMAND_TO_OP\b/, SLASH_COMMAND_ALLOWED, [
    SRC,
    INTERFACES,
  ]);
});
