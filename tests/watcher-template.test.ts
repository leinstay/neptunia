// Every watcher report is one Markdown file in one exact template (`checkTemplate` of src/watcher/report.ts): the title
// with its day, the fixed metadata block, the twelve sections, the same four subheadings in each, and the coverage block
// at the end. A text outside it is refused with a code, the run fails, and the last successful view stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readReport } from '../src/watcher/read.ts';
import * as reads from '../src/watcher/read.ts';
import * as reports from '../src/watcher/report.ts';
import {
  DAY,
  MINUTE,
  METADATA,
  SUBHEADINGS,
  coverageBlock,
  answerOf,
  inspectionDeps,
  inspectionRig,
  said,
  sectionOf,
  templateOf,
  watcherBoard,
} from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';
import { HEADINGS, PLANTED_KEY } from './fixtures/watcher-rig.ts';

const inspection = () => import('../src/watcher/inspection.ts');

const codeOf = (text: string): string => {
  const checked = reports.checkTemplate(text);
  return checked.ok ? 'passed' : checked.code;
};
const swapped = <T>(list: ReadonlyArray<T>, a: number, b: number): Array<T> => {
  const next = [...list];
  [next[a], next[b]] = [list[b], list[a]];
  return next;
};

test('a report in the template passes, and the check gives back its day and metadata in fixed names', () => {
  // Bug: the check passes the shape, but a caller has to scrape the run id and the interval out of the text again.
  const checked = reports.checkTemplate(templateOf());
  assert.ok(checked.ok);
  assert.equal(checked.day, DAY);
  // The whole shape is the point: these are the fixed names every caller reads the metadata by, none of them optional.
  assert.deepEqual(checked.metadata, {
    observationInterval: '2026-11-03T06:00:00.000Z to 2026-11-04T06:00:00.000Z',
    runId: 'run-template',
    backend: 'claude',
    model: 'model-m',
    effort: 'medium',
    account: 'the persona account',
    sources: 'model_requests, service journal',
    risk: 'none',
    newFindings: 0,
    repeats: 0,
  });
});

test('the sections are the twelve of the owner, exact and in order', () => {
  // Bug: a section is renamed in one place, and the check, the prompt and the readers hold different lists.
  assert.deepEqual(
    [...reports.REPORT_HEADINGS],
    [
      'Her day',
      'Service runs',
      'Memory',
      'Errors',
      'Misunderstandings',
      'Project',
      'Modules and structure',
      'Trash',
      'The server',
      'Wishes',
      'Tasks filed',
      'For the owner',
    ]
  );
});

test('findings of any length pass under their subheadings, and a heading quoted in a fence is no heading', () => {
  // Bug: a strict template refuses a real report that lists findings or quotes a log with `## ` in it.
  const text = templateOf({
    bodies: {
      Memory: {
        'Observed defects': '- [high] cursor-stalled: the cursor stalled\n- [low] two-failed: two sessions failed',
        'Inspected without a finding': '- the scope cursors\n\nBoth scopes were read.',
        'Unavailable checks': '```\n## Summary\n### Notes\n```',
      },
    },
  });
  assert.equal(codeOf(text), 'passed');
});

/** The metadata with one row's value replaced. */
const withRow = (label: string, value: string): Array<readonly [string, string]> =>
  METADATA.map((row) => (row[0] === label ? ([label, value] as const) : row));

const SECTIONS = {
  'an extra section': [
    templateOf({ sections: [...HEADINGS.slice(0, 2), 'Summary', ...HEADINGS.slice(2)] }),
    'extra-heading',
  ],
  'an extra subheading': [templateOf({ subheadings: [...SUBHEADINGS, 'Notes'] }), 'extra-heading'],
  'a section twice': [templateOf({ sections: [...HEADINGS, 'Memory'] }), 'extra-heading'],
  'a missing section': [templateOf({ sections: HEADINGS.filter((name) => name !== 'The server') }), 'missing-heading'],
  'a missing subheading': [templateOf({ subheadings: SUBHEADINGS.slice(0, 3) }), 'missing-heading'],
  'two sections swapped': [templateOf({ sections: swapped(HEADINGS, 1, 2) }), 'heading-order'],
  'two subheadings swapped': [templateOf({ subheadings: swapped(SUBHEADINGS, 0, 1) }), 'heading-order'],
  'a section at level three': [templateOf().replace('## Memory\n', '### Memory\n'), 'heading-level'],
  'a section at level one': [templateOf().replace('## Memory\n', '# Memory\n'), 'heading-level'],
  'a subheading at level two': [
    templateOf().replace('### Observed defects\n', '## Observed defects\n'),
    'heading-level',
  ],
  'a heading at level four': [templateOf({ bodies: { Memory: '#### Deep\n\ntext' } }), 'heading-level'],
} as const;

for (const [name, [text, code]] of Object.entries(SECTIONS)) {
  test(`${name} is refused as ${code}`, () => {
    // Bug: one report per day has its own layout, and a reader of last week's reports compares unlike things.
    assert.equal(codeOf(text), code);
  });
}

const TOP = {
  'text before the title': [`Here is the report.\n\n${templateOf()}`, 'preamble'],
  'a blank report': ['', 'bad-title'],
  'a title with no day': [templateOf({ title: '# Watcher report' }), 'bad-title'],
  'a title with no real date': [templateOf({ day: '2026-13-40' }), 'bad-title'],
  'a title in other words': [templateOf({ title: `# Report of ${DAY}` }), 'bad-title'],
  'a title at another level': [templateOf({ title: `## Watcher report ${DAY}` }), 'bad-title'],
  'a metadata row missing': [templateOf({ metadata: METADATA.slice(1) }), 'bad-metadata'],
  'metadata in another order': [templateOf({ metadata: swapped(METADATA, 0, 1) }), 'bad-metadata'],
  'an extra metadata row': [templateOf({ metadata: [...METADATA, ['Mood', 'good']] }), 'bad-metadata'],
  'a blank metadata value': [
    templateOf({ metadata: [['Observation interval', ' '], ...METADATA.slice(1)] }),
    'bad-metadata',
  ],
  'a metadata row in other words': [
    templateOf({ metadata: [['Interval', 'x'], ...METADATA.slice(1)] }),
    'bad-metadata',
  ],
  'a risk that is no level': [templateOf({ metadata: withRow('Risk', 'severe') }), 'bad-metadata'],
  'a risk in brackets': [templateOf({ metadata: withRow('Risk', '[high]') }), 'bad-metadata'],
  'counts that are no numbers': [templateOf({ metadata: withRow('New findings', 'many, repeats: 1') }), 'bad-metadata'],
  'counts with no repeats': [templateOf({ metadata: withRow('New findings', '2') }), 'bad-metadata'],
  'the word none in another row': [templateOf({ metadata: withRow('Effective account', 'none') }), 'bad-metadata'],
  'text after the metadata': [templateOf().replace('\n\n## Her day\n', '\n\nA note.\n\n## Her day\n'), 'stray-text'],
  'text between a section and its first subheading': [
    templateOf().replace('## Memory\n', '## Memory\n\nA note.\n'),
    'stray-text',
  ],
} as const;

for (const [name, [text, code]] of Object.entries(TOP)) {
  test(`${name} is refused as ${code}`, () => {
    // Bug: a parser reads the metadata by position, so one wandering line attributes the report to the wrong run.
    assert.equal(codeOf(text), code);
  });
}

const EMPTY = 'none';
for (const [name, body, code] of [
  ['nothing at all', '', 'empty-subsection'],
  ['None with a capital', 'None', 'empty-word'],
  ['none with a full stop', 'none.', 'empty-word'],
  ['nothing found', 'nothing found', 'empty-word'],
  ['n/a', 'n/a', 'empty-word'],
  ['none beside a finding', 'none\n\nthe cursor stalled', 'empty-word'],
] as const) {
  test(`an empty subsection saying ${name} is refused as ${code}`, () => {
    // Bug: "nothing" is written five ways, and counting the checks with no finding across a month needs a guess.
    assert.equal(codeOf(templateOf({ bodies: { Memory: { 'Unavailable checks': body } } })), code);
  });
}

test('an empty subsection says exactly the one fixed word', () => {
  // Bug: the check refuses the fixed word itself, or the fixture and the contract name different words.
  assert.equal(codeOf(templateOf({ bodies: { Memory: { 'Suspicious evidence': EMPTY } } })), 'passed');
});

for (const sub of ['Observed defects', 'Suspicious evidence']) {
  for (const [name, line] of [
    ['no level', '- retry-rail: the rail loops'],
    ['no key', '- [high] the rail loops'],
    ['a key with no text', '- [high] retry-rail:'],
    ['the level none', '- [none] retry-rail: the rail loops'],
    ['an unknown level', '- [urgent] retry-rail: the rail loops'],
    ['a level in capitals', '- [HIGH] retry-rail: the rail loops'],
    ['a plain sentence', 'The rail loops.'],
    ['a good line and a loose one', '- [high] retry-rail: the rail loops\nIt loops at night.'],
  ] as const) {
    test(`a line with ${name} under ${sub} is refused as bad-risk`, () => {
      // Bug: a finding with no level slips through, so the day's highest risk is computed from part of the report.
      assert.equal(codeOf(templateOf({ bodies: { Memory: { [sub]: line } } })), 'bad-risk');
    });
  }
  for (const level of ['critical', 'high', 'medium', 'low']) {
    test(`a line at ${level} under ${sub} passes`, () => {
      // Bug: the list of levels in the check misses one the prompt offers, and every report using it fails.
      assert.equal(
        codeOf(templateOf({ bodies: { Wishes: { [sub]: `- [${level}] retry-rail: it loops` } } })),
        'passed'
      );
    });
  }
}

for (const sub of ['Inspected without a finding', 'Unavailable checks']) {
  test(`a line under ${sub} carrying a level is refused as bad-risk`, () => {
    // Bug: a defect hides among the checks with no finding, and the risk line never counts it.
    assert.equal(codeOf(templateOf({ bodies: { Memory: { [sub]: '- [high] retry-rail: it loops' } } })), 'bad-risk');
  });
}

test('the engine filing lines under Observed defects of Tasks filed carry no level and pass', () => {
  // Bug: the risk rule covers the section the engine writes, so every report with a task is refused after its own stamp.
  const lines = '- T-1 (fix, rail): Rail\n- deferred (fix, other): Other\n- already T-2 (chore, third): Third';
  assert.equal(codeOf(templateOf({ bodies: { 'Tasks filed': { 'Observed defects': lines } } })), 'passed');
});

const END = {
  'no coverage block': [templateOf({ end: '' }), 'coverage-missing'],
  'the block inside a section': [
    templateOf({ end: '', bodies: { Memory: coverageBlock().trimEnd() } }),
    'coverage-misplaced',
  ],
  'a second block': [templateOf({ end: `${coverageBlock()}\n${coverageBlock()}` }), 'coverage-misplaced'],
  'text after the block': [`${templateOf()}\nOne more thought.\n`, 'trailing-content'],
  'a heading after the block': [`${templateOf()}\n## Summary\n\nDone.\n`, 'trailing-content'],
} as const;

for (const [name, [text, code]] of Object.entries(END)) {
  test(`${name} is refused as ${code}`, () => {
    // Bug: the coverage block floats, or what follows it is read by nobody and passes unchecked.
    assert.equal(codeOf(text), code);
  });
}

test('a credential-shaped string anywhere is refused and the detail never quotes it', () => {
  // Bug: the template check replaces the secret check, or repeats the line it refused into a log.
  for (const text of [
    templateOf({ bodies: { 'The server': `journal: ${PLANTED_KEY}` } }),
    templateOf({ metadata: withRow('Effective account', PLANTED_KEY) }),
  ]) {
    const checked = reports.checkTemplate(text);
    assert.ok(!checked.ok);
    assert.equal(checked.code, 'secret');
    assert.equal(checked.detail.includes(PLANTED_KEY), false);
  }
});

test('a refusal names the heading or row by its template name, never the text that caused it', () => {
  // Bug: an unknown heading is copied into the detail, and from there into the status line and the journal.
  const checked = reports.checkTemplate(templateOf({ sections: [...HEADINGS, 'MARK-FROM-THE-AGENT'] }));
  assert.ok(!checked.ok);
  assert.equal(checked.detail.includes('MARK-FROM-THE-AGENT'), false);
});

// ---- through an inspection --------------------------------------------------------------------------------------------

async function good(rig: InspectionRig): Promise<string> {
  const { runInspection } = await inspection();
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve(said(answerOf({ Memory: 'MARK-GOOD' }))) })
  );
  rig.clock.t += MINUTE;
  assert.equal(result.state, 'succeeded');
  return result.runId;
}

for (const [name, text, code] of [
  ['an extra heading', templateOf({ subheadings: [...SUBHEADINGS, 'Notes'] }), 'extra-heading'],
  ['the old layout', '## Her day\n\nnothing found\n', 'bad-title'],
  ['content after the end', `${templateOf()}\nOne more thought.\n`, 'trailing-content'],
] as const) {
  test(`an answer with ${name} fails the run as ${code} and keeps the last successful view`, async () => {
    // Bug: the check runs on the side, so a report out of template is saved as the day's success, or files its tasks.
    const { runInspection } = await inspection();
    const { lastRuns } = await import('../src/watcher/lifecycle.ts');
    const rig = inspectionRig();
    const kept = await good(rig);
    const draft = { kind: 'fix', finding: 'x', title: 'Rail', evidence: 'src/a.ts:1', done: 'It holds' };
    const tasks = '```tasks\n' + JSON.stringify([draft]) + '\n```\n';
    const result = await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said(text + tasks)) }));
    assert.equal(result.state, 'failed');
    assert.equal(result.code, code);
    assert.equal(lastRuns(rig.store).lastFailure?.runId, result.runId);
    assert.equal(lastRuns(rig.store).lastSuccess?.runId, kept);
    const day = readReport(rig.reportsDir, DAY);
    assert.ok(day.ok && day.report.text.includes('MARK-GOOD'));
    assert.deepEqual(
      reads.reportVersions(rig.reportsDir, DAY).map((one) => one.runId),
      [kept]
    );
    assert.equal(rig.fake.adds.length, 0);
  });
}

for (const [name, board, word] of [
  ['filed', () => watcherBoard(), 'T-1'],
  ['deferred', () => watcherBoard({ down: () => true }), 'deferred'],
] as const) {
  test(`the saved report keeps the template with a ${name} task line under Tasks filed`, async () => {
    // Bug: the engine's own filing lines go straight under the heading, so every report with a task breaks its template.
    const { runInspection } = await inspection();
    const rig = inspectionRig(undefined, board());
    const draft = { kind: 'fix', finding: 'x', title: 'Rail', evidence: 'src/a.ts:1', done: 'It holds' };
    const result = await runInspection(
      inspectionDeps(rig, { runAgent: () => Promise.resolve(said(answerOf({}, [draft]))) })
    );
    assert.equal(result.state, 'succeeded');
    const day = readReport(rig.reportsDir, DAY);
    assert.ok(day.ok);
    assert.equal(codeOf(day.report.text), 'passed');
    assert.ok(sectionOf(day.report.text, 'Tasks filed').includes(word));
  });
}

test('the engine writes the facts it knows into the metadata, whatever the agent said', async () => {
  // Bug: the model copies yesterday's run id or guesses its own model, and calibration compares the wrong runs.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const claimed = templateOf({
    metadata: [
      ['Observation interval', '2020-01-01T00:00:00.000Z to 2020-01-02T00:00:00.000Z'],
      ['Run id', 'run-invented'],
      ['Selected backend', 'invented-backend'],
      ['Model', 'invented-model'],
      ['Effort', 'invented-effort'],
      ['Effective account', 'the persona account'],
      ['Available sources', 'model_requests'],
      ['Risk', 'critical'],
      ['New findings', '9, repeats: 9'],
    ],
  });
  const result = await runInspection(
    inspectionDeps(rig, {
      selected: { backend: 'claude', model: 'model-zeta', effort: 'medium' },
      runAgent: () => Promise.resolve(said(claimed)),
    })
  );
  const day = readReport(rig.reportsDir, DAY);
  assert.ok(day.ok);
  const checked = reports.checkTemplate(day.report.text);
  assert.ok(checked.ok);
  assert.equal(checked.metadata.runId, result.runId);
  assert.equal(checked.metadata.backend, 'claude');
  assert.equal(checked.metadata.model, 'model-zeta');
  assert.equal(checked.metadata.effort, 'medium');
  assert.ok(checked.metadata.observationInterval.endsWith(new Date(rig.clock.t).toISOString()));
  assert.equal(checked.metadata.observationInterval.includes('2020-01-01'), false);
  assert.equal(checked.metadata.account, 'the persona account');
  assert.equal(checked.metadata.risk, 'none');
  assert.equal(checked.metadata.newFindings, 0);
  assert.equal(checked.metadata.repeats, 0);
});

test('prompt.md asks for the whole template', () => {
  // Bug: the validator requires a layout the prompt never describes, so every live inspection fails its check.
  const prompt = fs.readFileSync(new URL('../agents/watcher/prompt.md', import.meta.url), 'utf8');
  assert.ok(prompt.includes('# Watcher report '));
  for (const [label] of METADATA) assert.ok(prompt.includes(`- ${label}: `), label);
  for (const name of SUBHEADINGS) assert.ok(prompt.includes(`### ${name}`), name);
  assert.ok(prompt.includes('`none`'));
  assert.ok(prompt.includes('[critical|high|medium|low]'));
});
