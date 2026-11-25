// The core's words: no line of src/ names Discord, a "helper" model or an "organ", and no line of src/ or interfaces/
// names the slash command's table or its settings, except the lines this file allows. The allowlist holds what stays on
// purpose: the frozen migrations, the readers of the legacy namespace and the stored values they read, the entry point
// that loads the Discord package, the limit kinds the journal stores, and the old names of the keys the config moves
// drop. An entry names a file and a pattern of the line, never a line number, and every entry must still match a line,
// so a stale entry fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExceptions,
  checkProse,
  checkWording,
  countViolations,
  isProseFile,
  isWordingFile,
  runCheck,
} from '../../scripts/prose-check.ts';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hardLines = (text: string, rule: string) =>
  checkProse(text)
    .violations.filter((v) => v.rule === rule)
    .map((v) => v.line);

const warnLines = (text: string, rule: string) =>
  checkProse(text)
    .warnings.filter((w) => w.rule === rule)
    .map((w) => w.line);

test('dash: catches an em dash, an en dash and a spaced double hyphen in prose', () => {
  const text = 'One clause — another clause.\n\nPages 3–5 are long.\n\nA clause -- and another.\n';
  assert.deepEqual(hardLines(text, 'dash'), [1, 3, 5]);
});

test('dash: lets through dashes in code spans, fenced blocks, link targets, quotes and comments', () => {
  const text = [
    'Use `a — b` and `--flag` here, see [the page](https://example.com/a–b).',
    '',
    '```text',
    'a — b -- c',
    '```',
    '',
    '> quoted — text',
    '',
    '<!-- a comment — with a dash',
    'on two lines — still a comment -->',
    '',
    'Plain text with a-hyphen and a command --flag.',
    '',
  ].join('\n');
  assert.deepEqual(hardLines(text, 'dash'), []);
});

test('dash: still catches a dash in a table row', () => {
  assert.deepEqual(hardLines('| a | b — c |\n|---|---|\n', 'dash'), [1]);
});

test('label: catches a bold label, a plain label in a list item and a label paragraph', () => {
  const text = [
    '- **Performance:** load times are faster.',
    '- **Security**: encryption was added.',
    '- Cache: keeps requests cheap.',
    '',
    'Retries: hide brief outages from users.',
    '',
    '- `runTurn`: opens a turn when an event passes.',
  ].join('\n');
  assert.deepEqual(hardLines(text, 'label'), [1, 2, 3, 5, 7]);
});

test('label: lets through a table row, a lead-in, a long clause, a bare value and a bold label with a period', () => {
  const text = [
    '| Tool | What it does |',
    '|---|---|',
    '| Cache: fast | Keeps requests cheap. |',
    '',
    'These are the settings:',
    '',
    '- **Settings:**',
    '- Default: `30`',
    '- The cache that keeps requests cheap for every single turn: it matters.',
    '- **Read-only on data.** No tool writes there.',
    '- The time is 12:30 today.',
    '',
    '## Step 1: install it',
    '',
    '```text',
    'Cache: keeps requests cheap.',
    '```',
  ].join('\n');
  assert.deepEqual(hardLines(text, 'label'), []);
});

test('slash: catches words joined by a slash and a plain path', () => {
  const text = 'Use and/or here.\n\nThe docs/comments/commits are read, and src/memory too.\n';
  assert.deepEqual(hardLines(text, 'slash'), [1, 3]);
});

test('slash: lets through backticked paths, fractions, acronyms, links and urls', () => {
  const text = [
    'See `docs/prompt-contract.md` and `src/**` for the paths.',
    '',
    'A ratio of 1/2 or 3/4, an I/O bound TCP/IP stack and CI/CD.',
    '',
    'Read [the guide](docs/README.md) or [docs/README.md](README.md) or https://example.com/a/b and <https://example.com/x/y>.',
    '',
    '```sh',
    'cd docs/x && cat a/b',
    '```',
  ].join('\n');
  assert.deepEqual(hardLines(text, 'slash'), []);
});

test('warnings: three sentences in a row that open with the same word', () => {
  const text = 'The door drops it. The cache holds it. The runner reads it. Then it ends.\n';
  assert.deepEqual(warnLines(text, 'repeated-opener'), [1]);
});

test('warnings: two sentences with the same opener are not reported', () => {
  const text = 'The door drops it. The cache holds it. Then it ends.\n';
  assert.deepEqual(warnLines(text, 'repeated-opener'), []);
});

test('warnings: a transition opener and a sentence over 40 words', () => {
  const long = Array.from({ length: 41 }, (_, i) => `word${i}`).join(' ');
  const ok = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const text = `Notably, it works.\n\nIt was fine. Moreover it grew.\n\n${long}.\n\n${ok}.\n`;
  assert.deepEqual(warnLines(text, 'transition-opener'), [1, 3]);
  assert.deepEqual(warnLines(text, 'long-sentence'), [5]);
});

test('warnings never appear as violations', () => {
  const text = 'Additionally, it works. Additionally, more. Additionally, again.\n';
  const out = checkProse(text);
  assert.deepEqual(out.violations, []);
  assert.ok(out.warnings.length > 0);
});

test('an empty file and a file of only code have no findings', () => {
  assert.deepEqual(checkProse(''), { violations: [], warnings: [] });
  assert.deepEqual(checkProse('```js\nconst a = b / c; // —\n```\n'), { violations: [], warnings: [] });
});

test('countViolations: counts per file and rule and leaves clean files out', () => {
  const counts = countViolations({
    'a.md': [
      { line: 1, rule: 'dash' },
      { line: 4, rule: 'dash' },
      { line: 5, rule: 'slash' },
    ],
    'b.md': [],
  });
  assert.deepEqual(counts, { 'a.md': { dash: 2, slash: 1 } });
});

test('runCheck: a violation the baseline lacks fails, one it records passes', () => {
  const files = { 'docs/a.md': 'Bad — dash.\n' };
  assert.equal(runCheck(files, {}).status, 1);
  assert.equal(runCheck(files, { 'docs/a.md': { dash: 1 } }).status, 0);
});

test('runCheck: a count below the baseline fails until the baseline is rewritten', () => {
  const files = { 'docs/a.md': 'Clean text.\n' };
  const out = runCheck(files, { 'docs/a.md': { dash: 2 } });
  assert.equal(out.status, 1);
  assert.deepEqual(out.shrank, [{ file: 'docs/a.md', code: 'dash', was: 2, now: 0 }]);
});

test('runCheck: warnings alone leave the status at zero', () => {
  const out = runCheck({ 'docs/a.md': 'Moreover, it works.\n' }, {});
  assert.equal(out.status, 0);
  const warned = out.warnings['docs/a.md'];
  assert.equal(warned.length, 1);
});

test('isProseFile: picks the root, docs, interface, tools and github documents and leaves prompts out', () => {
  for (const p of [
    'README.md',
    'docs/memory.md',
    'docs/sub/deep.md',
    'interfaces/discord/README.md',
    'scripts/README.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ])
    assert.equal(isProseFile(p), true, p);
  for (const p of [
    'prompts/main.md',
    'agents/dev/prompt.md',
    'tests/fixtures/x.md',
    'scripts/fixtures/x.md',
    'src/a.js',
    'docs/diagram.png',
  ])
    assert.equal(isProseFile(p), false, p);
});

// ---- the wording rules: the persona's pronouns and the word owner ----

const wordingLines = (text: string, file: string, rule: string) =>
  checkWording(text, file)
    .filter((f) => f.rule === rule)
    .map((f) => f.line);

test('wording: a pronoun in a comment or a string of code is a candidate, a name of the code is not', () => {
  const source = ['const her = 1; // she replies', "const label = 'her turn ended';", 'herself();'].join('\n');
  assert.deepEqual(wordingLines(source, 'src/a.ts', 'persona-pronoun'), [1, 2]);
});

test('wording: each pronoun of a line counts once per word', () => {
  const source = '// he told him that his and hers were herself and himself';
  assert.equal(wordingLines(source, 'src/a.ts', 'persona-pronoun').length, 6);
});

test('wording: the word owner in a comment or a string is a candidate, a longer word is not', () => {
  const source = [
    '// the owner decides',
    "const sql = 'SELECT owner_kind FROM media_links';",
    'const ownerReads = 1;',
    "const s = `the owner's key`;",
    '// owners and co-owners',
  ].join('\n');
  assert.deepEqual(wordingLines(source, 'src/a.ts', 'owner-word'), [1, 4, 5, 5]);
});

test('wording: the path of an imported or exported module is a name of the code', () => {
  const source = [
    "import { placeOwnerOf } from './place-owner.ts';",
    "export { holder } from './profile-owner.ts';",
    "import type { LineOwner } from './line-owner.ts';",
    "const lazy = await import('./owner-names.ts');",
    "const label = 'the owner chat';",
  ].join('\n');
  assert.deepEqual(wordingLines(source, 'src/a.ts', 'owner-word'), [5]);
});

test('wording: a comment over several lines reports the line of each word', () => {
  const source = '/*\n * one line\n * she waits\n */\nconst x = 1;';
  assert.deepEqual(wordingLines(source, 'src/a.ts', 'persona-pronoun'), [3]);
});

test('wording: a comment before a keyword such as else is read too', () => {
  const source = 'if (a) {\n  b();\n}\n// she waits\nelse {\n  c();\n}';
  assert.deepEqual(wordingLines(source, 'src/a.ts', 'persona-pronoun'), [4]);
});

test('wording: a text file counts every line', () => {
  assert.deepEqual(wordingLines('One.\nShe writes.\n', 'prompts/a.md', 'persona-pronoun'), [2]);
  assert.deepEqual(wordingLines('{"a": "the owner only"}', 'config/labels.json', 'owner-word'), [1]);
});

test('wording: an exception exempts the matching line of its file and rule only', () => {
  const texts = { 'config/config.json': '"pronouns": ["she", "he"]\nshe writes', 'docs/a.md': '"pronouns": ["she"]' };
  const byFile = {
    'config/config.json': checkWording(texts['config/config.json'], 'config/config.json'),
    'docs/a.md': checkWording(texts['docs/a.md'], 'docs/a.md'),
  };
  const exceptions = [
    {
      file: 'config/config.json',
      rule: 'persona-pronoun',
      text: '"pronouns":',
      reason: 'a list of pronouns as language data',
    },
  ];
  const { kept, unused } = applyExceptions(byFile, exceptions, texts);
  assert.deepEqual(
    kept['config/config.json'].map((f) => f.line),
    [2]
  );
  assert.equal(kept['docs/a.md'].length, 1);
  assert.deepEqual(unused, []);
});

test('wording: an exception that matches nothing is reported as unused', () => {
  const exception = { file: 'docs/a.md', rule: 'owner-word', text: 'gone', reason: 'r' };
  const { unused } = applyExceptions({ 'docs/a.md': checkWording('the owner', 'docs/a.md') }, [exception], {
    'docs/a.md': 'the owner',
  });
  assert.deepEqual(unused, [exception]);
});

test('wording: two exceptions that match the same line are both used', () => {
  const texts = { 'docs/a.md': 'the owner and the owner' };
  const first = { file: 'docs/a.md', rule: 'owner-word', text: 'the owner and', reason: 'r' };
  const second = { file: 'docs/a.md', rule: 'owner-word', text: 'and the owner', reason: 'r' };
  const { kept, unused } = applyExceptions(
    { 'docs/a.md': checkWording(texts['docs/a.md'], 'docs/a.md') },
    [first, second],
    texts
  );
  assert.deepEqual(kept['docs/a.md'], []);
  assert.deepEqual(unused, []);
});

test('isWordingFile: covers code, prompts, settings and documents and leaves out the baselines and the lock file', () => {
  for (const f of [
    'src/a.ts',
    'tests/x.test.ts',
    'prompts/system.md',
    'config/labels.json',
    'docs/a.md',
    'AGENTS.md',
    'agents/scout/prompt.md',
    'bin/neptunia.ts',
  ]) {
    assert.equal(isWordingFile(f), true, f);
  }
  for (const f of [
    'scripts/config/wording-baseline.json',
    'scripts/config/wording-exceptions.json',
    'package-lock.json',
    'src/a.png',
    'data/x.md',
  ]) {
    assert.equal(isWordingFile(f), false, f);
  }
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SRC = path.join(ROOT, 'src');

type Allowed = { file: string; pattern: RegExp; why: string };

const DISCORD_ALLOWED: ReadonlyArray<Allowed> = [
  {
    file: 'src/memory/db/schema-baseline.ts',
    pattern: /discord/i,
    why: 'the seed rows of the interfaces a new install knows',
  },
  { file: 'src/memory/db/ids.ts', pattern: /`[^`]*discord[^`]*`/, why: 'stored legacy ids and the stored iface value' },
  // Qualified message writes keep the upsert module independent from a platform namespace.
  {
    file: 'src/setup/run.ts',
    // The family reads the interface before its command.
    pattern: /'interfaces discord (set token|enable)'/,
    why: 'the setup guide names the interface the owner enables first',
  },
  { file: 'src/web/lookup.ts', pattern: /discordapp\.(com|net)/, why: 'media hosts the link reader never reads' },
];

const HELPER_ALLOWED: ReadonlyArray<Allowed> = [
  // Changed: src/development/edges.ts is gone with the development worker (maintainer, 2026-11-16).
  { file: 'src/llm/limits.ts', pattern: /'helper-(timeout|fallback)'/, why: 'limit kinds the journal stores' },
  { file: 'src/turn/phases/request/wait.ts', pattern: /`?helper-timeout`?/, why: 'a limit kind the journal stores' },
  { file: 'src/turn/act.ts', pattern: /`?helper-timeout`?/, why: 'a limit kind the journal stores' },
  { file: 'src/turn/draw-gif.ts', pattern: /`?helper-timeout`?/, why: 'a limit kind the journal stores' },
  { file: 'src/behavior/missed.ts', pattern: /'missed: helper failed'/, why: 'a log line name' },
];

// An interface package's own `node_modules` holds its platform SDK, which is no code of ours.
function sourceFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Changed: src/mnemonic/ holds word lists, which are data and no code, so no word of this file's checks applies to it.
      if (entry.name !== 'node_modules' && !(entry.name === 'mnemonic' && path.basename(path.dirname(full)) === 'src'))
        files.push(...sourceFiles(full));
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
