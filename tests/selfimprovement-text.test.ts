// The words of the selfimprovement wake's facts (src/behavior/selfimprovement-text.ts): every phrase comes from the
// labels the test hands in, the facts are data, and a block without its header label is left out whole. The labels
// here are synthetic and each carries its placeholders; no test pins the shipped wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfimprovementLines, selfimprovementReason } from '../src/behavior/selfimprovement-text.ts';
import type { SelfimprovementFacts } from '../src/behavior/selfimprovement-view.ts';

const LABELS = {
  header: 'HEADER {days}d',
  cause: 'CAUSE {shape}',
  noShapes: 'NOSHAPES',
  shape: 'SHAPE n={count} [{steps}] fail={failures} retry={retries} cost={cost} at={when} turns={turns}',
  moreShapes: 'MORE {count}',
  unused: 'UNUSED {tools}',
  skills: 'SKILLS',
  skill: 'SKILL {name}{state} d={discovered} r={read} t={tried} s={succeeded} c={corrected} x={declined}',
  skillOff: ' (off)',
  proposals: 'PROPOSALS',
  proposal: 'PROPOSAL {id} {kind} {title} {status}{reason}',
  proposalReason: ' because {reason}',
  news: 'NEWS',
  question: 'QUESTION {task} {text}{answered}',
  questionAnswered: ' (answered)',
  review: 'REVIEW {task} {decision} {scope}{note}',
  reviewNote: ' note {note}',
  board: 'BOARD {task} {kind} {status}{reason}',
  stepsJoin: ' > ',
};

const counts = { discovered: 4, read: 3, tried: 2, succeeded: 1, corrected: 0, declined: 1 };

function facts(patch: Partial<SelfimprovementFacts> = {}): SelfimprovementFacts {
  return {
    from: 0,
    days: 14,
    shapes: [],
    moreShapes: 0,
    // The facts gained `repeated`, `failures` and `proposals[n].blocked` with the separated wake.
    repeated: [],
    failures: [],
    unusedTools: [],
    skills: [],
    proposals: [],
    news: { questions: [], reviews: [], outbox: [], landed: [] },
    outboxSeqs: [],
    ...patch,
  };
}

const when = (ts: unknown): string => `T${String(ts)}`;

test('a shape line carries its steps with argument names, counts, cost to four places, the moment and the turn ids', () => {
  // Catches a placeholder wired to the wrong field, a cost printed unrounded, or steps joined without the label's glue.
  const lines = selfimprovementLines(
    facts({
      shapes: [
        {
          key: 'k',
          steps: [
            { tool: 'web.search', args: ['query'] },
            { tool: 'web.read', args: ['id', 'url'] },
          ],
          count: 5,
          failures: 2,
          retries: 1,
          costUsd: 0.123456,
          example: { turnId: 'turn-9', at: 1700 },
          turnIds: ['turn-9', 'turn-8'],
        },
      ],
    }),
    LABELS,
    when,
    null
  );
  assert.deepEqual(lines, [
    'HEADER 14d',
    'SHAPE n=5 [web.search(query) > web.read(id, url)] fail=2 retry=1 cost=0.1235 at=T1700 turns=turn-9, turn-8',
  ]);
});

test('a failure reason adds the cause line first and the other reasons do not', () => {
  const given = facts();
  assert.equal(selfimprovementLines(given, LABELS, when, 'failures:web.search(query)')[0], 'CAUSE web.search(query)');
  assert.equal(selfimprovementLines(given, LABELS, when, 'weekly')[0], 'HEADER 14d');
  assert.equal(selfimprovementLines(given, LABELS, when, null)[0], 'HEADER 14d');
});

test('with no facts, or no header label, the block is empty', () => {
  // Catches a block printed without its header, which would leave loose lines in <wake>.
  assert.deepEqual(selfimprovementLines(null, LABELS, when, null), []);
  assert.deepEqual(selfimprovementLines(undefined, LABELS, when, null), []);
  assert.deepEqual(selfimprovementLines(facts(), { ...LABELS, header: '' }, when, null), []);
  assert.deepEqual(selfimprovementLines(facts(), { noShapes: 'NOSHAPES' }, when, null), []);
  assert.deepEqual(selfimprovementLines(facts(), undefined, when, null), []);
});

test('empty facts give the header and the no-shapes line and none of the optional sections', () => {
  assert.deepEqual(selfimprovementLines(facts(), LABELS, when, null), ['HEADER 14d', 'NOSHAPES']);
});

test('shapes beyond the shown ones add a line with how many were left out', () => {
  const shape = {
    key: 'k',
    steps: [{ tool: 'a.b', args: [] }],
    count: 1,
    failures: 0,
    retries: 0,
    costUsd: 0,
    example: { turnId: 't', at: 1 },
    turnIds: ['t'],
  };
  const lines = selfimprovementLines(facts({ shapes: [shape], moreShapes: 7 }), LABELS, when, null);
  assert.equal(lines.at(-1), 'MORE 7');
  assert.equal(lines[1], 'SHAPE n=1 [a.b()] fail=0 retry=0 cost=0.0000 at=T1 turns=t');
});

test('unused tools, skills with their counts, proposals and news each get their lines in that order', () => {
  const lines = selfimprovementLines(
    facts({
      unusedTools: ['pings.set', 'web.read'],
      skills: [
        { name: 'look-it-up', active: true, counts },
        { name: 'idle', active: false, counts: { ...counts, read: 0 } },
      ],
      proposals: [
        {
          id: 't1',
          kind: 'skill',
          title: 'A skill',
          status: 'closed',
          closeReason: 'declined by owner',
          blocked: null,
        },
        { id: 't2', kind: null, title: 'Plain', status: 'open', closeReason: null, blocked: null },
      ],
      news: {
        questions: [
          { taskId: 't1', questionId: 'q1', text: 'Which sites?', answered: true },
          { taskId: 't2', questionId: 'q2', text: 'When?', answered: false },
        ],
        reviews: [{ taskId: 't1', decision: 'rejected', scope: 'skill', note: 'too broad' }],
        outbox: [{ seq: 4, taskId: 't2', kind: 'closed', status: 'done', closeReason: 'merged' }],
        landed: [],
      },
    }),
    LABELS,
    when,
    null
  );
  assert.deepEqual(lines, [
    'HEADER 14d',
    'NOSHAPES',
    'UNUSED pings.set, web.read',
    'SKILLS',
    'SKILL look-it-up d=4 r=3 t=2 s=1 c=0 x=1',
    'SKILL idle (off) d=4 r=0 t=2 s=1 c=0 x=1',
    'PROPOSALS',
    'PROPOSAL t1 skill A skill closed because declined by owner',
    'PROPOSAL t2  Plain open',
    'NEWS',
    'QUESTION t1 Which sites? (answered)',
    'QUESTION t2 When?',
    'REVIEW t1 rejected skill note too broad',
    'BOARD t2 closed done because merged',
  ]);
});

test('a review without scope or note and an outbox row without status print no leftover placeholder', () => {
  const lines = selfimprovementLines(
    facts({
      news: {
        questions: [],
        reviews: [{ taskId: 't1', decision: 'approved', scope: null, note: null }],
        outbox: [{ seq: 1, taskId: 't1', kind: 'answered', status: null, closeReason: null }],
        landed: [],
      },
    }),
    LABELS,
    when,
    null
  );
  assert.deepEqual(lines.slice(-2), ['REVIEW t1 approved ', 'BOARD t1 answered ']);
  assert.equal(lines.join('\n').includes('{'), false);
});

test('a missing label drops its line and leaves no empty line or the word undefined', () => {
  // Catches a label lookup that prints "undefined" or an empty line when a deployment's labels lack a key.
  const partial: Record<string, string> = { ...LABELS };
  delete partial.shape;
  delete partial.unused;
  const lines = selfimprovementLines(
    facts({
      shapes: [
        {
          key: 'k',
          steps: [{ tool: 'a.b', args: [] }],
          count: 1,
          failures: 0,
          retries: 0,
          costUsd: 0,
          example: { turnId: 't', at: 1 },
          turnIds: ['t'],
        },
      ],
      unusedTools: ['x.y'],
    }),
    partial,
    when,
    null
  );
  assert.deepEqual(lines, ['HEADER 14d']);
});

test('board text with line breaks is folded to one line so it cannot start a line of its own', () => {
  // Catches a board title or note that carries a newline into <wake>, where it would read as a new fact.
  const lines = selfimprovementLines(
    facts({
      proposals: [
        { id: 't1', kind: 'fix', title: 'first\nSECOND LINE', status: 'open', closeReason: 'a\n\nb', blocked: null },
      ],
      news: {
        questions: [{ taskId: 't1', questionId: 'q', text: 'one\ntwo', answered: false }],
        reviews: [{ taskId: 't1', decision: 'rejected', scope: null, note: 'x\ny' }],
        outbox: [],
        landed: [],
      },
    }),
    LABELS,
    when,
    'failures:a\nb'
  );
  assert.equal(
    lines.some((line) => line.includes('\n')),
    false
  );
  assert.ok(lines.includes('PROPOSAL t1 fix first SECOND LINE open because a b'));
  assert.ok(lines.includes('CAUSE a b'));
});

test('selfimprovementReason reads the reason of the selfimprovement item and nothing else', () => {
  assert.equal(
    selfimprovementReason([
      { kind: 'heartbeat', reason: 'tick' },
      { kind: 'selfimprovement', reason: 'failures:k' },
    ]),
    'failures:k'
  );
  assert.equal(selfimprovementReason([{ kind: 'heartbeat', reason: 'tick' }]), null);
  assert.equal(selfimprovementReason([{ kind: 'selfimprovement' }]), null);
  assert.equal(selfimprovementReason([{ kind: 'selfimprovement', reason: 4 }, null, 'text']), null);
  assert.equal(selfimprovementReason(undefined), null);
  assert.equal(selfimprovementReason([]), null);
});

// The watcher's report (spec 2026-11-02, "`selfimprovement` daily, after the watcher"): one block under one label,
// `watcher`, with `{day}`, `{forOwner}` and `{tasksFiled}`.

const WATCHER = { day: '2026-11-02', forOwner: 'Look at the retries.', tasksFiled: '- T3 fix: retries' };
const WITH_WATCHER = { ...LABELS, watcher: 'WATCHER {day} | {forOwner} | {tasksFiled}' };

test('a watcher report in the facts becomes one block filled from its label', () => {
  // Catches: the report reaches the facts but no line of the wake, or a placeholder is left unfilled.
  const lines = selfimprovementLines(facts({ watcher: WATCHER }), WITH_WATCHER, when, null);
  assert.ok(lines.includes('WATCHER 2026-11-02 | Look at the retries. | - T3 fix: retries'), lines.join('\n'));
});

test('with no watcher report the block is absent and the other lines stay', () => {
  // Catches: a null report prints the label with empty placeholders, telling her of a report that does not exist.
  const lines = selfimprovementLines(facts({ watcher: null }), WITH_WATCHER, when, null);
  assert.deepEqual(lines, ['HEADER 14d', 'NOSHAPES']);
});

test('without the watcher label the report is left out and the other lines stay', () => {
  // Catches: a deployment whose labels lack the key gets the report's raw text, or loses the whole selfimprovement block.
  const lines = selfimprovementLines(facts({ watcher: WATCHER }), LABELS, when, null);
  assert.deepEqual(lines, ['HEADER 14d', 'NOSHAPES']);
});
