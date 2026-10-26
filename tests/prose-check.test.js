import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkProse, countViolations, runCheck, isProseFile } from '../tools/prose-check.mjs';

/** @param {string} text @param {string} rule */
const hardLines = (text, rule) =>
  checkProse(text)
    .violations.filter((v) => v.rule === rule)
    .map((v) => v.line);

/** @param {string} text @param {string} rule */
const warnLines = (text, rule) =>
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
  assert.equal(out.warnings['docs/a.md'].length, 1);
});

test('isProseFile: picks the root, docs, interface, tools and github documents and leaves prompts out', () => {
  for (const p of [
    'README.md',
    'docs/memory.md',
    'docs/sub/deep.md',
    'interfaces/discord/README.md',
    'tools/README.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ])
    assert.equal(isProseFile(p), true, p);
  for (const p of [
    'prompts/system-prompt.md',
    'agents/dev/prompt.md',
    'tests/fixtures/x.md',
    'tools/fixtures/x.md',
    'src/a.js',
    'docs/diagram.png',
  ])
    assert.equal(isProseFile(p), false, p);
});
