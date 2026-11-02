// The small markdown renderer of the console (bin/markdown.ts): `renderMarkdown(text, { color })` turns the report's
// markdown into text for a terminal. Without color the markers are only removed; with color the emphasis is ANSI:
// bold \x1b[1m..\x1b[22m, italic \x1b[3m..\x1b[23m, code span \x1b[36m..\x1b[39m, headings bold. No wrapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../bin/markdown.ts';

const plain = (text: string): string => renderMarkdown(text, { color: false });
const colored = (text: string): string => renderMarkdown(text, { color: true });
const lines = (text: string): Array<string> => text.split('\n');

test('headings lose their hash marks and keep their text on a line of their own', () => {
  const out = lines(plain('# Title\n\n## Her day\n\nbody'));
  assert.ok(out.includes('Title'));
  assert.ok(out.includes('Her day'));
  assert.equal(
    out.some((line) => line.startsWith('#')),
    false
  );
});

test('a colored heading is bold', () => {
  assert.ok(colored('## Memory').includes('\x1b[1mMemory\x1b[22m'));
});

test('bullets become a bullet character and keep nesting by indent; ordered items keep their number', () => {
  const out = lines(plain('- one\n  - nested\n- two\n\n1. first\n2. second'));
  assert.ok(out.includes('• one'));
  assert.ok(out.includes('  • nested'));
  assert.ok(out.includes('• two'));
  assert.ok(out.includes('1. first'));
  assert.ok(out.includes('2. second'));
});

test('bold and italic markers are removed without color and become escapes with color', () => {
  assert.equal(
    plain('a **bold** and *italic* and __strong__ and _slanted_ word'),
    'a bold and italic and strong and slanted word'
  );
  const out = colored('a **bold** and *italic* word');
  assert.ok(out.includes('\x1b[1mbold\x1b[22m'));
  assert.ok(out.includes('\x1b[3mitalic\x1b[23m'));
});

test('underscores inside a word are no emphasis, so a snake_case_name keeps its underscores', () => {
  assert.equal(
    plain('the snake_case_name stays and so does my_var_2'),
    'the snake_case_name stays and so does my_var_2'
  );
});

test('a lone star around spaces is arithmetic, not emphasis', () => {
  assert.equal(plain('3 * 4 * 5 is 60'), '3 * 4 * 5 is 60');
});

test('an unclosed marker stays literal instead of swallowing the rest of the line', () => {
  assert.equal(plain('a **never closed and more'), 'a **never closed and more');
});

test('a code span keeps its text verbatim, emphasis markers inside it included', () => {
  assert.equal(plain('run `npm run **x** test` now'), 'run npm run **x** test now');
  assert.ok(colored('run `a_b` now').includes('\x1b[36ma_b\x1b[39m'));
});

test('a fenced block is printed verbatim and indented, with no fences and no emphasis inside', () => {
  const out = lines(plain('before\n\n```ts\nconst a = **b**;\n  # not a heading\n```\n\nafter'));
  assert.equal(
    out.some((line) => line.includes('```')),
    false
  );
  assert.ok(out.some((line) => /^ {4}const a = \*\*b\*\*;$/.test(line)));
  assert.ok(out.some((line) => /^ {4} {2}# not a heading$/.test(line)));
  assert.ok(out.includes('before') && out.includes('after'));
});

test('a table is aligned: every row has the same width, cells hold their text and the separator row is a rule', () => {
  const out = lines(plain('| Unit | Restarts |\n| --- | ---: |\n| core | 0 |\n| neptunia-agent-scout | 12 |\n'));
  const rows = out.filter((line) => line.includes('core') || line.includes('Unit') || line.includes('scout'));
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.length)).size, 1, 'rows are padded to one width');
  assert.ok(rows.some((row) => row.includes('neptunia-agent-scout') && row.includes('12')));
  assert.equal(
    out.some((line) => line.includes('---')),
    false,
    'the markdown separator is not printed'
  );
  assert.ok(
    out.some((line) => line.includes('─')),
    'a rule line separates the header'
  );
});

test('emphasis inside a table cell is rendered and does not break the alignment', () => {
  const out = lines(plain('| a | b |\n| - | - |\n| **x** | y |'));
  const rows = out.filter((line) => line.includes('x') || line.includes('a'));
  assert.equal(new Set(rows.map((row) => row.length)).size, 1);
  assert.equal(out.join('\n').includes('**'), false);
});

test('plain paragraphs and blank lines pass through, and the text ends without a stray extra blank line', () => {
  assert.equal(plain('first\n\nsecond\n'), 'first\n\nsecond');
});

test('an empty text renders as an empty text', () => {
  assert.equal(plain(''), '');
});
