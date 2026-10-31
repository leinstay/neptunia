// The task board's state machine as data: the statuses, the transitions, the roles that may make each and what each
// requires. src/board/board.ts works out the facts of a call (the caller's roles, the task's conditions) and asks
// `authorize`. The roles are generic: a deployment maps its principals to them in `clients.json` (`boardRoles`).

export const STATUSES = [
  'proposed',
  'triaged',
  'approved',
  'rejected',
  'in_progress',
  'needs_answer',
  'needs_validation',
  'done',
  'failed',
  'cancelled',
] as const;
export type Status = (typeof STATUSES)[number];
export const OPEN: ReadonlyArray<Status> = [
  'proposed',
  'triaged',
  'approved',
  'in_progress',
  'needs_answer',
  'needs_validation',
];
export const CLOSED: ReadonlyArray<Status> = ['rejected', 'done', 'failed', 'cancelled'];
// A move into one of these writes an outbox row to the task's subscriber.
export const NOTIFY: ReadonlyArray<Status> = ['done', 'failed', 'cancelled', 'needs_answer'];

// The roles `clients.json` grants. `owner` holds every right of `reviewer` as well as its own.
export const BOARD_ROLES = ['owner', 'reviewer', 'worker', 'scheduler', 'persona', 'watcher', 'errand-runner'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];
// Derived per task by board.ts, never granted by clients.json: the lease holder, the requester, the question's
// addressee, and the board's own reaper.
export type DerivedRole = 'holder' | 'requester' | 'answerer' | 'reaper';
export type Role = BoardRole | DerivedRole;

// risk-low: the task's risk is low. errand: the task is on the errand lane. ci-green: metadata.ci is 'green'.
// no-ci: the task's project has `ci: false` in `board.projects`. tests-pass: metadata.tests is 'pass'.
export const CONDITIONS = ['risk-low', 'errand', 'ci-green', 'no-ci', 'tests-pass'] as const;
export type Condition = (typeof CONDITIONS)[number];
export type Via = 'transition' | 'approve' | 'claim' | 'ask' | 'answer' | 'reaper' | 'release' | 'retry';
// triage-fields: role and estimate set. close-reason: a close_reason given. result: a pr, diff or summary result
// recorded. comment: a comment saying what to fix. why: a close_reason or the last attempt's outcome.
export type Requirement = 'triage-fields' | 'close-reason' | 'result' | 'comment' | 'why';

export const ERROR_CODES = [
  'invalid-transition',
  'stale',
  'not-found',
  'forbidden',
  'claimed',
  'invalid',
  'blocked',
  'board-unavailable',
] as const;
export type BoardErrorCode = (typeof ERROR_CODES)[number];

export class BoardError extends Error {
  readonly code: BoardErrorCode;
  constructor(code: BoardErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export type Rule = { from: Status; to: Status; via: ReadonlyArray<Via>; requires: ReadonlyArray<Requirement> };

// One entry of a rule's who-list: a role, the conditions the task must also meet, and the requirements that replace
// the rule's own when this entry is the one that matches.
type Who = { role: Role; when: ReadonlyArray<Condition>; requires?: ReadonlyArray<Requirement> };
// A rule with `when` exists only for a task that meets those conditions; elsewhere the move is invalid-transition.
type Transition = {
  from: Status;
  to: Status;
  via: ReadonlyArray<Via>;
  when: ReadonlyArray<Condition>;
  who: ReadonlyArray<Who>;
  requires: ReadonlyArray<Requirement>;
};

const any = (...roles: ReadonlyArray<Role>): Array<Who> => roles.map((role) => ({ role, when: [] }));
const RUNNER: Who = { role: 'errand-runner', when: ['errand'] };

function rule(
  from: Status,
  to: Status,
  via: ReadonlyArray<Via>,
  who: ReadonlyArray<Who>,
  { requires = [], when = [] }: { requires?: ReadonlyArray<Requirement>; when?: ReadonlyArray<Condition> } = {}
): Transition {
  return { from, to, via, who, requires, when };
}

const TRANSITIONS: ReadonlyArray<Transition> = [
  rule('proposed', 'triaged', ['transition'], [...any('reviewer', 'scheduler'), { ...RUNNER, requires: [] }], {
    requires: ['triage-fields'],
  }),
  rule('proposed', 'rejected', ['transition', 'approve'], any('owner', 'reviewer'), { requires: ['close-reason'] }),
  rule('triaged', 'approved', ['approve'], [...any('owner'), { role: 'reviewer', when: ['risk-low'] }, RUNNER]),
  rule('triaged', 'approved', ['transition'], [RUNNER], { when: ['errand'] }),
  rule('proposed', 'approved', ['transition', 'approve'], [RUNNER], { when: ['errand'] }),
  rule('triaged', 'rejected', ['transition', 'approve'], any('owner', 'reviewer'), { requires: ['close-reason'] }),
  // The reviewer never claims: it briefs and reviews the work, the workers do it.
  rule('approved', 'in_progress', ['claim'], [...any('owner', 'scheduler', 'worker'), RUNNER]),
  rule('in_progress', 'needs_answer', ['ask'], any('holder')),
  rule('needs_answer', 'in_progress', ['answer'], any('answerer', 'owner')),
  rule('in_progress', 'needs_validation', ['transition'], any('holder'), { requires: ['result'] }),
  // The reviewer merges at any risk once CI is green; on a project without CI its recorded passing tests stand in.
  rule(
    'needs_validation',
    'done',
    ['approve'],
    [...any('owner'), { role: 'reviewer', when: ['ci-green'] }, { role: 'reviewer', when: ['no-ci', 'tests-pass'] }]
  ),
  rule('needs_validation', 'in_progress', ['transition', 'approve'], any('owner', 'reviewer'), {
    requires: ['comment'],
  }),
  rule('in_progress', 'done', ['transition'], [RUNNER], { when: ['errand'] }),
  rule('in_progress', 'failed', ['transition'], [...any('holder', 'scheduler'), RUNNER], { requires: ['why'] }),
  ...OPEN.map((from) =>
    rule(from, 'cancelled', ['transition'], [...any('owner', 'reviewer', 'requester'), RUNNER], {
      requires: ['close-reason'],
    })
  ),
  rule('approved', 'approved', ['reaper'], any('reaper')),
  rule('in_progress', 'approved', ['reaper'], any('reaper')),
  rule('in_progress', 'approved', ['release'], any('holder', 'owner')),
  // A failed task runs again: the lease cleared, the close reason dropped, its attempts kept.
  rule('failed', 'approved', ['retry'], any('owner', 'reviewer')),
];

/** Which status an approval moves the task to, by scope and decision; a deploy approval only records. */
export const APPROVAL_TARGETS: Readonly<
  Record<'plan' | 'merge' | 'deploy', Partial<Record<'approve' | 'reject', Status>>>
> = {
  plan: { approve: 'approved', reject: 'rejected' },
  merge: { approve: 'done', reject: 'in_progress' },
  deploy: {},
};

function findTransition(from: Status, to: Status, via: Via, conditions: ReadonlySet<Condition>): Transition | null {
  return (
    TRANSITIONS.find(
      (t) => t.from === from && t.to === to && t.via.includes(via) && t.when.every((c) => conditions.has(c))
    ) ?? null
  );
}

/**
 * The rule for a move, its `requires` replaced by the matching entry's own when it has one. Throws BoardError
 * 'invalid-transition' when no rule exists for the move under these conditions, 'forbidden' when no entry of its
 * who-list matches the roles.
 */
export function authorize(move: {
  from: Status;
  to: Status;
  via: Via;
  roles: ReadonlySet<Role>;
  conditions: ReadonlySet<Condition>;
}): Rule {
  const { from, to, via, roles, conditions } = move;
  const found = findTransition(from, to, via, conditions);
  if (found === null) throw new BoardError('invalid-transition', `${from} -> ${to} is not allowed through ${via}`);
  const expanded = new Set<Role>(roles);
  if (expanded.has('owner')) expanded.add('reviewer');
  const entry = found.who.find((who) => expanded.has(who.role) && who.when.every((c) => conditions.has(c)));
  if (entry === undefined) {
    throw new BoardError('forbidden', `${[...roles].join(',') || 'caller'} may not move ${from} -> ${to}`);
  }
  return { from, to, via: found.via, requires: entry.requires ?? found.requires };
}
