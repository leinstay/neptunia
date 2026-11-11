// What the owner is shown of a stored watcher report (`reportView` of src/watcher/report.ts): the stored file keeps the
// `coverage` block and every empty subsection for `checkCoverage` and the risk rules, the view drops them. The wiring to
// `/doctor watcher read` and to her `watcher.read` is checked in tests/watcher-doctor.test.ts and
// tests/tools-operations-watcher.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCoverage, checkTemplate, reportView } from '../src/watcher/report.ts';
import { SUBHEADINGS, templateOf } from './fixtures/watcher-inspection-rig.ts';
import { HEADINGS } from './fixtures/watcher-rig.ts';

const BLOCK = '```coverage';

/** What one subsection holds when it says something; `Misunderstandings` lines cite a turn, as the template needs. */
const SAYS: Readonly<Record<string, string>> = {
  'Decisions needed': '- [low] decide-x: choose the model',
  'Observed defects': '- [low] defect-x: the cursor stalled',
  'Suspicious evidence': '- [low] odd-x: a login at night',
  'Inspected without a finding': 'Read the scope cursors.',
  'Unavailable checks': 'The journal could not be read.',
};
const turned = (heading: string, text: string): string => (heading === 'Misunderstandings' ? `${text} t-abc123` : text);

/** A report where every subsection of every section says something. */
function full(): string {
  const bodies: Record<string, Record<string, string>> = {};
  for (const heading of HEADINGS) {
    const names = heading === 'For the owner' ? ['Decisions needed', ...SUBHEADINGS] : SUBHEADINGS;
    bodies[heading] = Object.fromEntries(
      names.map((name) => [name, name === 'Unavailable checks' ? SAYS[name] : turned(heading, SAYS[name] ?? '')])
    );
  }
  return templateOf({ bodies });
}

/** The non-blank lines of the `## <heading>` section of a view, the heading line first. */
function sectionLines(view: string, heading: string): Array<string> {
  const lines = view.split('\n');
  const start = lines.findIndex(
    (line) => line === `## ${heading}` || line.startsWith(`## ${heading} `) || line.startsWith(`## ${heading}:`)
  );
  assert.notEqual(start, -1, `${heading} has no heading line in the view`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return [lines[start] ?? '', ...(end === -1 ? rest : rest.slice(0, end))].filter((line) => line.trim() !== '');
}

const stored = (text: string): string => {
  assert.ok(checkTemplate(text).ok, 'the sample is a report in the template');
  return text;
};

test('the view of a stored report holds no coverage block, and the stored file still passes checkCoverage', () => {
  // Bug: the owner reads the machine-readable block, or the view is cut from the file so checkCoverage loses its input.
  const text = stored(templateOf());
  const view = reportView(text);
  assert.equal(view.includes(BLOCK), false);
  assert.equal(view.includes('"sources"'), false);
  assert.ok(text.includes(BLOCK));
  assert.ok(checkCoverage(text).ok);
});

test('a section whose four subsections all say none reads as one line, its heading and the word', () => {
  // Bug: eleven empty sections print forty-odd `### ...` and `none` lines the owner has to scroll through.
  const view = reportView(stored(templateOf({ bodies: { Money: { 'Inspected without a finding': 'none' } } })));
  const money = sectionLines(view, 'Money');
  assert.equal(money.length, 1, money.join(' | '));
  assert.match(money[0] ?? '', /^## Money\b.*\bnone$/);
  assert.equal(
    view.split('\n').some((line) => line.startsWith('### ') && line.includes('Observed defects')),
    false
  );
});

test('a section with one subsection that says something keeps that one and drops the three empty ones', () => {
  // Bug: the section collapses because most of it is empty, or keeps all four so the finding hides among `none`.
  const text = stored(
    templateOf({
      bodies: {
        Memory: {
          'Observed defects': '- [high] cursor-stalled: the cursor stalled\n- [low] two-failed: two sessions failed',
        },
      },
    })
  );
  const memory = sectionLines(reportView(text), 'Memory');
  assert.deepEqual(memory, [
    '## Memory',
    '### Observed defects',
    '- [high] cursor-stalled: the cursor stalled',
    '- [low] two-failed: two sessions failed',
  ]);
});

test('a report with nothing empty reads the same in the view, the coverage block aside', () => {
  // Bug: the view rewraps, trims or reorders what it keeps, so the owner reads a different report than the file.
  const text = stored(full());
  const cut = text.slice(0, text.indexOf(BLOCK));
  assert.equal(reportView(text).trimEnd(), cut.trimEnd());
});

test('a report where every section is empty is the title, the metadata and twelve one-line sections', () => {
  // Boundary: the owner's section has a fifth subsection, `Decisions needed`, and has to collapse like the rest.
  const view = reportView(stored(templateOf()));
  for (const heading of HEADINGS) {
    const lines = sectionLines(view, heading);
    assert.equal(lines.length, 1, `${heading}: ${lines.join(' | ')}`);
    assert.match(lines[0] ?? '', new RegExp(`^## ${heading}\\b.*\\bnone$`));
  }
  assert.equal(view.includes('### '), false);
  assert.ok(view.startsWith('# Watcher report 2026-11-04'));
  assert.ok(view.includes('- Run id: run-template'));
});

test('a subsection that holds the word none inside a longer sentence says something and is kept', () => {
  // Bug: the view tests for the word with includes() and drops a finding that merely contains it.
  const body = 'Found none of the stalled cursors, and both scopes moved.';
  const text = stored(templateOf({ bodies: { Memory: { 'Inspected without a finding': body } } }));
  assert.deepEqual(sectionLines(reportView(text), 'Memory'), ['## Memory', '### Inspected without a finding', body]);
});
