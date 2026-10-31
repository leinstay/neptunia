// The task board's operations over its tables in the memory database (src/board/schema.ts). `Board.call` runs one
// operation in one BEGIN IMMEDIATE transaction, writes its events in it, and stores the answer of a mutation that
// carries an idempotency key for 24 hours. The rights come from the `boardRoles` of the caller's entry in the private
// layer's `clients.json`, read at every call, and from the roles the board derives per task (src/board/machine.ts).
// A board that is not at its schema version answers `board-unavailable` to everything. `readBoard` is the offline
// inspection of tools/memory-db.mjs. Nothing here logs.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agentCosts } from './costs.ts';
import {
  AUTO_TRIAGE_FIELDS,
  BUDGET_FIELDS,
  RETRY_FIELDS,
  UPDATABLE,
  aliased,
  applyFields,
  int,
  invalid,
  jsonText,
  leaseMinutes,
  normalizeAutoTriage,
  normalizeField,
  num,
  pickFields,
  str,
  text,
} from './fields.ts';
import type { Args, SqlValue, TriageFields } from './fields.ts';
import { APPROVAL_TARGETS, BOARD_ROLES, BoardError, CLOSED, NOTIFY, STATUSES, authorize } from './machine.ts';
import type { BoardRole, Condition, Role, Rule, Status, Via } from './machine.ts';
import { BOARD_MIGRATIONS, boardVersion } from './schema.ts';
import type { BoardDb } from './schema.ts';

// ---------- settings ----------

export type AutoTriage = { role: string; budget: number; steps: number; estimate: number };
export type BoardProject = { autoTriage?: Partial<AutoTriage>; ci?: boolean };
export type BoardSettings = {
  leaseTtlMinutes: number;
  autoTriage: AutoTriage;
  projects: Readonly<Record<string, BoardProject>>;
};

/** `board.*` when missing (config.json carries the same). */
const BOARD_DEFAULTS: BoardSettings = Object.freeze({
  leaseTtlMinutes: 30,
  autoTriage: Object.freeze({ role: 'dev', budget: 4, steps: 80, estimate: 30 }),
  projects: Object.freeze({}),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const shortTriage = (fields: TriageFields): Partial<AutoTriage> => {
  const out: Partial<AutoTriage> = {};
  if (typeof fields.role === 'string') out.role = fields.role;
  if (typeof fields.budget_usd === 'number') out.budget = fields.budget_usd;
  if (typeof fields.step_cap === 'number') out.steps = fields.step_cap;
  if (typeof fields.estimate_minutes === 'number') out.estimate = fields.estimate_minutes;
  return out;
};

/**
 * `board.leaseTtlMinutes`, `board.autoTriage` and `board.projects` of a config, read at the moment of use. Throws an
 * Error naming the key for an auto-triage entry with an unknown or invalid field.
 */
export function boardSettings(config: unknown): BoardSettings {
  const board = isObject(config) && isObject(config.board) ? config.board : {};
  const ttl = board.leaseTtlMinutes;
  const leaseTtlMinutes =
    typeof ttl === 'number' && Number.isInteger(ttl) && ttl >= 1 && ttl <= 24 * 60
      ? ttl
      : BOARD_DEFAULTS.leaseTtlMinutes;
  const autoTriage = {
    ...BOARD_DEFAULTS.autoTriage,
    ...shortTriage(normalizeAutoTriage(board.autoTriage, 'board.autoTriage')),
  };
  const projects: Record<string, BoardProject> = {};
  for (const [name, entry] of Object.entries(isObject(board.projects) ? board.projects : {})) {
    const own = isObject(entry) ? entry : {};
    projects[name] = {
      autoTriage: shortTriage(normalizeAutoTriage(own.autoTriage, `board.projects.${name}.autoTriage`)),
      ...(typeof own.ci === 'boolean' ? { ci: own.ci } : {}),
    };
  }
  return { leaseTtlMinutes, autoTriage, projects };
}

// ---------- records ----------

export type TaskRecord = {
  id: string;
  lane: 'dev' | 'errand';
  project: string | null;
  title: string;
  description: string | null;
  acceptance: string | null;
  requester: string;
  priority: number;
  risk: 'low' | 'normal' | 'high';
  role: string | null;
  budget_usd: number | null;
  step_cap: number | null;
  estimate_minutes: number | null;
  status: Status;
  close_reason: string | null;
  defer_until: string | null;
  is_blocked: number;
  revision: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  subscriber: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
  lease_generation: number;
  blocked_reason: string | null;
  unblocks: string | null;
};
export type HandoffTest = { command: string; passed: number; failed: number };
// What a holder hands over with task.submit: the result, the evidence for it, the changed artifacts, the tests run
// with their counts, and what is still open.
export type Handoff = {
  result: string;
  evidence: Array<string>;
  artifacts: Array<string>;
  tests: Array<HandoffTest>;
  open_issues: Array<string>;
};
// The answer of task.orient: what the caller holds, what it blocked, what waits for its review, what it is asked.
export type Orientation = {
  held: Array<TaskRecord>;
  blocked: Array<TaskRecord>;
  reviews: Array<TaskRecord>;
  questions: Array<Row>;
};
export type Row = Readonly<Record<string, unknown>>;
export type EventRow = {
  seq: number;
  task_id: string | null;
  actor: string;
  type: string;
  old: string | null;
  new: string | null;
  created_at: string;
};
export type CommentRow = { id: string; task_id: string; author: string; text: string; created_at: string };
export type TaskView = {
  task: TaskRecord;
  ready: boolean;
  dependencies: Array<Row>;
  dependents: Array<Row>;
  attempts: Array<Row>;
  questions: Array<Row>;
  approvals: Array<Row>;
  results: Array<Row>;
  handoff: Handoff | null;
  comments: Array<CommentRow>;
  events: Array<EventRow>;
};
export type BoardResults = {
  'task.add': TaskRecord;
  'task.list': Array<TaskRecord>;
  'task.show': TaskView;
  'task.update': TaskRecord;
  'task.transition': TaskRecord;
  'task.claim': TaskRecord;
  'task.heartbeat': TaskRecord;
  'task.release': TaskRecord;
  'task.retry': TaskRecord;
  'task.depend': TaskRecord;
  'task.undepend': TaskRecord;
  'task.ask': { question: Row; task: TaskRecord };
  'task.answer': { question: Row; task: TaskRecord };
  'task.escalate': { question: Row; task: TaskRecord };
  'task.approve': { approval: Row; task: TaskRecord };
  'task.result': { result: Row; task: TaskRecord };
  'task.comment': { comment: CommentRow; task: TaskRecord };
  'task.block': TaskRecord;
  'task.unblock': TaskRecord;
  'task.submit': { result: Row; handoff: Handoff; task: TaskRecord };
  'task.review': { review: Row; task: TaskRecord };
  'task.orient': Orientation;
  'attempt.start': Row;
  'attempt.end': Row;
  'run.start': Row;
  'run.end': Row;
  'costs.agents': Readonly<Record<string, unknown>>;
  'outbox.pull': Array<Row>;
};
export type BoardOp = keyof BoardResults;

// A board_tasks row as stored: the record with its metadata still JSON text.
type TaskRow = Omit<TaskRecord, 'metadata'> & { metadata: string | null };

// The columns of board_tasks are the TaskRow fields (board v2), so a row read from it is one.
const asTask = (row: Record<string, unknown>): TaskRow => row as unknown as TaskRow;

function parseTask(row: TaskRow): TaskRecord {
  // The stored metadata is always the JSON of an object (fields.ts#applyFields and task.add write it).
  return { ...row, metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null };
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
const RESULT_KINDS: ReadonlyArray<string> = ['summary', 'diff', 'pr', 'answer', 'file', 'prompt', 'spec'];
const SUBMIT_KINDS: ReadonlyArray<string> = ['summary', 'diff', 'pr'];
// A move into one of these ends the lease (as does a move into a closed status).
const LEASE_ENDS: ReadonlyArray<Status> = ['needs_answer', 'needs_validation', 'blocked', 'approved'];
const DEP_TYPES: ReadonlyArray<string> = ['blocks', 'parent-child', 'discovered-from', 'related'];
const OUTCOMES: ReadonlyArray<string> = ['done', 'failed', 'stopped', 'stalled', 'over-budget', 'needs_answer'];
// The errand mirror sends its errand's state as the outcome, and a cancelled run is a stopped attempt.
const OUTCOME_ALIASES: Readonly<Record<string, string>> = { cancelled: 'stopped' };
const ATTEMPT_START_FIELDS = ['role', 'model', 'provider_pin', 'worktree', 'branch', 'db_path'] as const;
const ATTEMPT_END_FIELDS: ReadonlyArray<string> = [
  'exit_code',
  'finish_reason',
  'steps',
  'tokens_in',
  'tokens_out',
  'tokens_reasoning',
  'cache_read',
  'cache_write',
  'cost_est_usd',
  'cost_billed_usd',
  'rejected_asks',
  'failed_tools',
  'loop_signals',
  'stall_signals',
  'outcome',
];
const ATTEMPT_INTEGERS: ReadonlyArray<string> = [
  'exit_code',
  'steps',
  'tokens_in',
  'tokens_out',
  'tokens_reasoning',
  'cache_read',
  'cache_write',
  'rejected_asks',
  'failed_tools',
];
const RUN_END_INTEGERS: ReadonlyArray<string> = [
  'steps',
  'tokens_in',
  'tokens_out',
  'cache_read',
  'cache_write',
  'context_mean',
  'context_peak',
  'compactions',
];

const READ_OPS: ReadonlySet<string> = new Set(['task.list', 'task.show', 'task.orient', 'costs.agents']);
const HANDOFF_LISTS = ['evidence', 'artifacts', 'open_issues'] as const;
const HANDOFF_KEYS: ReadonlyArray<string> = ['result', ...HANDOFF_LISTS, 'tests'];
const HANDOFF_MAX = 2000000;

// ---------- rights ----------

/** The board roles of every client of `clients.json`, by name; empty when the file is missing or unreadable. */
function readGrants(privateDir: string): Map<string, ReadonlySet<BoardRole>> {
  const grants = new Map<string, ReadonlySet<BoardRole>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(privateDir, 'clients.json'), 'utf8'));
  } catch {
    // A missing or broken clients.json grants no one anything.
    return grants;
  }
  if (!isObject(parsed)) return grants;
  for (const [name, entry] of Object.entries(parsed)) {
    const list = isObject(entry) && Array.isArray(entry.boardRoles) ? entry.boardRoles : [];
    const roles = new Set<BoardRole>(BOARD_ROLES.filter((role) => list.includes(role)));
    if (roles.size > 0) grants.set(name, roles);
  }
  return grants;
}

// ---------- reads shared with the offline inspection ----------

const isoOf = (ms: number): string => new Date(ms).toISOString();

function isReady(task: TaskRow, nowIso: string): boolean {
  return (
    task.status === 'approved' &&
    task.is_blocked === 0 &&
    !task.lease_owner &&
    (!task.defer_until || task.defer_until <= nowIso)
  );
}

function listTasks(db: BoardDb, args: Args, nowIso: string): Array<TaskRecord> {
  const where: Array<string> = [];
  const params: Array<string> = [];
  for (const name of ['lane', 'project', 'requester']) {
    const value = args[name];
    if (typeof value === 'string' || typeof value === 'number') {
      where.push(`${name} = ?`);
      params.push(String(value));
    }
  }
  if (args.status !== undefined && args.status !== null && args.status !== '') {
    const list = Array.isArray(args.status) ? args.status.map(String) : text(args.status).split(',');
    for (const s of list) if (!(STATUSES as ReadonlyArray<string>).includes(s)) throw invalid(`unknown status ${s}`);
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (args.ready) {
    where.push(
      "status = 'approved' AND is_blocked = 0 AND lease_owner IS NULL AND (defer_until IS NULL OR defer_until <= ?)"
    );
    params.push(nowIso);
  }
  // created_at ties within a millisecond and ids are random: rowid keeps the filing order (here and in task.show).
  const sql = `SELECT * FROM board_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority, created_at, rowid`;
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => parseTask(asTask(row)));
}

function latestHandoff(db: BoardDb, taskId: string): Handoff | null {
  const row = db
    .prepare(
      "SELECT body FROM board_results WHERE task_id = ? AND kind = 'handoff' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
    .get(taskId);
  // Only task.submit and a submitting task.result write a handoff row, and its body is the JSON of a filled Handoff.
  return typeof row?.body === 'string' ? (JSON.parse(row.body) as Handoff) : null;
}

function viewOf(db: BoardDb, task: TaskRow, nowIso: string): TaskView {
  const all = (sql: string): Array<Row> => db.prepare(sql).all(task.id);
  return {
    task: parseTask(task),
    ready: isReady(task, nowIso),
    dependencies: all('SELECT * FROM board_dependencies WHERE task_id = ? ORDER BY created_at, rowid'),
    dependents: all('SELECT * FROM board_dependencies WHERE depends_on_id = ? ORDER BY created_at, rowid'),
    attempts: all('SELECT * FROM board_attempts WHERE task_id = ? ORDER BY n'),
    questions: all('SELECT * FROM board_questions WHERE task_id = ? ORDER BY created_at, rowid'),
    approvals: all('SELECT * FROM board_reviews WHERE task_id = ? ORDER BY created_at, rowid'),
    results: all('SELECT * FROM board_results WHERE task_id = ? ORDER BY created_at, rowid'),
    handoff: latestHandoff(db, task.id),
    // The rows of board_comments and board_events have exactly the CommentRow and EventRow columns (schema v1).
    comments: all('SELECT * FROM board_comments WHERE task_id = ? ORDER BY created_at, rowid') as Array<CommentRow>,
    events: all(
      'SELECT * FROM (SELECT * FROM board_events WHERE task_id = ? ORDER BY seq DESC LIMIT 20) ORDER BY seq'
    ) as Array<EventRow>,
  };
}

function findTask(db: BoardDb, id: unknown): TaskRow {
  if (typeof id !== 'string') throw invalid('id is required');
  const row = db.prepare('SELECT * FROM board_tasks WHERE id = ?').get(id);
  if (row === undefined) throw new BoardError('not-found', `no task ${id}`);
  return asTask(row);
}

function requireVersion(db: BoardDb): void {
  const version = boardVersion(db);
  if (version !== BOARD_MIGRATIONS.length) {
    throw new BoardError(
      'board-unavailable',
      `the board is at version ${version}, the engine expects ${BOARD_MIGRATIONS.length}`
    );
  }
}

/**
 * The board read without a principal, for inspection with the core down (tools/memory-db.mjs `board list` and
 * `board show`): the answers of `task.list` with no filter and of `task.show`. Throws BoardError 'board-unavailable'
 * when the board is not at its version and 'not-found' for an unknown id.
 */
export function readBoard(db: BoardDb, now: () => number): { list(): Array<TaskRecord>; show(id: string): TaskView } {
  return {
    list() {
      requireVersion(db);
      return listTasks(db, {}, isoOf(now()));
    },
    show(id) {
      requireVersion(db);
      return viewOf(db, findTask(db, id), isoOf(now()));
    },
  };
}

// ---------- the board ----------

export type BoardOptions = {
  db: BoardDb;
  privateDir: string;
  now: () => number;
  settings: () => BoardSettings;
};

type Handler = (board: Board, principal: string, args: Args) => unknown;

// What one call reads once at its start: the grants of clients.json and the settings.
type CallContext = { grants: Map<string, ReadonlySet<BoardRole>>; settings: BoardSettings };

export class Board {
  readonly db: BoardDb;
  readonly privateDir: string;
  readonly clock: () => number;
  readonly settingsOf: () => BoardSettings;
  context: CallContext;

  constructor(options: BoardOptions) {
    this.db = options.db;
    this.privateDir = options.privateDir;
    this.clock = options.now;
    this.settingsOf = options.settings;
    this.context = { grants: new Map(), settings: BOARD_DEFAULTS };
  }

  /**
   * One operation in one BEGIN IMMEDIATE transaction, the idempotency key honoured for 24 hours. Throws BoardError:
   * 'board-unavailable' first when the board is not at its version, then 'forbidden' for a principal with no board
   * role (a watcher may only read), before any argument is checked.
   */
  call<TOp extends BoardOp>(
    principal: string,
    op: TOp,
    args: Readonly<Record<string, unknown>> = {},
    idempotency: string | null = null
  ): BoardResults[TOp] {
    requireVersion(this.db);
    const grants = readGrants(this.privateDir);
    const own = grants.get(principal);
    if (own === undefined) throw new BoardError('forbidden', `${principal} holds no board role`);
    const handler: Handler | undefined = OPS[op];
    if (handler === undefined) throw invalid(`unknown op ${String(op)}`);
    const isMutation = !READ_OPS.has(op);
    if (isMutation && ![...own].some((role) => role !== 'watcher')) {
      throw new BoardError('forbidden', `${principal} may only read the board`);
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw invalid('args must be an object');
    this.context = { grants, settings: this.settingsOf() };
    return this.transaction(() => {
      const key = idempotency && isMutation ? `${principal}:${String(idempotency)}` : null;
      if (key) {
        const row = this.db.prepare('SELECT response, created_at FROM board_idempotency WHERE key = ?').get(key);
        if (row && Date.parse(String(row.created_at)) > this.clock() - IDEMPOTENCY_MS) {
          // The stored response is the JSON of this op's own earlier answer.
          return JSON.parse(String(row.response)) as BoardResults[TOp];
        }
      }
      // Each handler of OPS answers its op's BoardResults entry.
      const result = handler(this, principal, args) as BoardResults[TOp];
      if (key) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO board_idempotency (key, principal, response, created_at) VALUES (?, ?, ?, ?)'
          )
          .run(key, principal, JSON.stringify(result ?? null), this.now());
      }
      return result;
    });
  }

  /**
   * Returns tasks whose lease expired to approved, each with its generation raised so the late holder is refused, and
   * purges idempotency keys past 24 hours; the expired ids.
   */
  reap(): Array<string> {
    requireVersion(this.db);
    return this.transaction(() => {
      const expired = this.db
        .prepare(
          "SELECT * FROM board_tasks WHERE lease_owner IS NOT NULL AND lease_expires_at < ? AND status IN ('approved','in_progress')"
        )
        .all(this.now())
        .map(asTask);
      for (const task of expired) {
        authorize({
          from: task.status,
          to: 'approved',
          via: 'reaper',
          roles: new Set<Role>(['reaper']),
          conditions: new Set(),
        });
        this.event(task.id, 'reaper', 'lease.expired', { owner: task.lease_owner, expires_at: task.lease_expires_at });
        this.move(task, 'approved', 'reaper', { lease_generation: task.lease_generation + 1 });
      }
      this.db.prepare('DELETE FROM board_idempotency WHERE created_at < ?').run(isoOf(this.clock() - IDEMPOTENCY_MS));
      return expired.map((t) => t.id);
    });
  }

  /** The events after `from`, in order, at most `limit`. */
  eventsSince(from = 0, limit = 1000): Array<EventRow> {
    requireVersion(this.db);
    // board_events rows have exactly the EventRow columns (schema v1).
    return this.db
      .prepare('SELECT * FROM board_events WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(Number(from) || 0, limit) as Array<EventRow>;
  }

  // BEGIN IMMEDIATE takes the write lock at the start, so two connections never interleave a read and a write.
  transaction<TResult>(fn: () => TResult): TResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed statement may have rolled the transaction back already.
      }
      throw error;
    }
  }

  now(): string {
    return isoOf(this.clock());
  }

  later(minutes: number): string {
    return isoOf(this.clock() + minutes * 60000);
  }

  grantsOf(principal: string): ReadonlySet<BoardRole> {
    return this.context.grants.get(principal) ?? new Set();
  }

  /** Whether `principal` speaks for `name` (a requester, a subscriber, a question's addressee). */
  actsFor(principal: string, name: string | null | undefined): boolean {
    if (!name) return false;
    if (name === principal || name.startsWith(`${principal}:`)) return true;
    const grants = this.grantsOf(principal);
    if (name === 'owner') return grants.has('owner');
    if (name === 'reviewer') return grants.has('reviewer');
    return name.startsWith('persona:') && grants.has('persona');
  }

  /** Whether any client of clients.json holds `reviewer`: then a dev task filed with `auto` waits for its brief. */
  hasReviewer(): boolean {
    return [...this.context.grants.values()].some((roles) => roles.has('reviewer'));
  }

  newId(prefix: string, table: string): string {
    for (;;) {
      let id = `${prefix}-`;
      for (const b of randomBytes(6)) id += BASE32[b & 31];
      if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
    }
  }

  getTask(id: unknown): TaskRow {
    return findTask(this.db, id);
  }

  row(sql: string, ...params: Array<unknown>): Row {
    const found = this.db.prepare(sql).get(...params);
    if (found === undefined) throw new BoardError('not-found', 'the row just written is gone');
    // A plain copy: node:sqlite's rows have no prototype, and a replayed answer (JSON) must equal the first one.
    return { ...found };
  }

  event(taskId: string | null, actor: string, type: string, oldValue: unknown = null, newValue: unknown = null): void {
    const enc = (v: unknown): string | null =>
      v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);
    this.db
      .prepare('INSERT INTO board_events (task_id, actor, type, old, new, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, actor, type, enc(oldValue), enc(newValue), this.now());
  }

  notify(taskId: string, toWhom: string | null, kind: string, payload: unknown): void {
    if (!toWhom) return;
    this.db
      .prepare('INSERT INTO board_outbox (task_id, to_whom, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, toWhom, kind, JSON.stringify(payload), this.now());
  }

  /**
   * Refuses a holder's call whose generation is not the task's: 'stale-lease' for another integer, 'invalid' for a
   * value that is not one. A call without a generation passes. Runs before any status check and any write.
   */
  checkGeneration(task: TaskRow, generation: unknown): void {
    if (generation === undefined || generation === null) return;
    if (typeof generation !== 'number' || !Number.isInteger(generation)) {
      throw invalid('generation must be an integer');
    }
    if (generation !== task.lease_generation) {
      throw new BoardError(
        'stale-lease',
        `generation ${generation} of ${task.id} is stale, the lease is at ${task.lease_generation}`
      );
    }
  }

  checkRevision(task: TaskRow, revision: unknown, required: boolean): void {
    if (revision === undefined || revision === null) {
      if (required) throw invalid('revision is required');
      return;
    }
    if (Number(revision) !== task.revision) {
      throw new BoardError('stale', `revision ${text(revision)} is stale, the task is at ${task.revision}`);
    }
  }

  /** Writes the given columns, bumps the revision unless told not to, and refuses a concurrent change. */
  write(task: TaskRow, fields: Readonly<Record<string, SqlValue>>, { bump = true } = {}): TaskRow {
    const cols = Object.keys(fields);
    const sets = cols.map((c) => `${c} = ?`);
    if (bump) sets.push('revision = revision + 1');
    sets.push('updated_at = ?');
    const info = this.db
      .prepare(`UPDATE board_tasks SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
      .run(...cols.map((c) => fields[c]), this.now(), task.id, task.revision);
    if (Number(info.changes) !== 1) throw new BoardError('stale', `task ${task.id} changed underneath`);
    return this.getTask(task.id);
  }

  roles(principal: string, task: TaskRow): Set<Role> {
    const roles = new Set<Role>(this.grantsOf(principal));
    if (task.lease_owner && task.lease_owner === principal) roles.add('holder');
    if (this.actsFor(principal, task.requester)) roles.add('requester');
    return roles;
  }

  conditions(task: TaskRow): Set<Condition> {
    const out = new Set<Condition>();
    if (task.risk === 'low') out.add('risk-low');
    if (task.lane === 'errand') out.add('errand');
    const meta = parseTask(task).metadata;
    if (meta?.ci === 'green') out.add('ci-green');
    if (task.project !== null && this.context.settings.projects[task.project]?.ci === false) out.add('no-ci');
    if (meta?.tests === 'pass') out.add('tests-pass');
    return out;
  }

  /** The errand runner works the errand lane: it runs attempts and records results on any errand task. */
  isErrandRunner(principal: string, task: TaskRow): boolean {
    return this.grantsOf(principal).has('errand-runner') && task.lane === 'errand';
  }

  authorizeMove(principal: string, task: TaskRow, to: Status, via: Via, roles = this.roles(principal, task)): Rule {
    return authorize({ from: task.status, to, via, roles, conditions: this.conditions(task) });
  }

  /** Who may edit a task's fields, dependencies and results: the owner, a reviewer, a scheduler, its requester and holder. */
  requireEditor(principal: string, task: TaskRow): void {
    const roles = this.roles(principal, task);
    const editors: ReadonlyArray<Role> = ['owner', 'reviewer', 'scheduler', 'requester', 'holder'];
    if (!editors.some((r) => roles.has(r))) throw new BoardError('forbidden', `${principal} may not change ${task.id}`);
  }

  /** The principal who parked the task in its current status (the event that moved it there). */
  parkedBy(task: TaskRow): string | null {
    const found = this.db
      .prepare(
        "SELECT actor FROM board_events WHERE task_id = ? AND type = 'status' AND new = ? ORDER BY seq DESC LIMIT 1"
      )
      .get(task.id, task.status);
    return typeof found?.actor === 'string' ? found.actor : null;
  }

  /**
   * Moves the task to `to` with extra columns; writes the event, the outbox row and the blocked projection. Throws
   * BoardError 'blocked' for a move to done while a child of the task is open.
   */
  move(task: TaskRow, to: Status, actor: string, fields: Readonly<Record<string, SqlValue>> = {}): TaskRow {
    if (to === 'done') this.refuseOpenChildren(task);
    const extra: Record<string, SqlValue> = { ...fields, status: to };
    if (CLOSED.includes(to) || LEASE_ENDS.includes(to)) {
      Object.assign(extra, { lease_owner: null, lease_expires_at: null, heartbeat_at: null });
    }
    const updated = this.write(task, extra);
    if (task.status !== to) this.event(task.id, actor, 'status', task.status, to);
    if (NOTIFY.includes(to)) {
      this.notify(task.id, updated.subscriber, to, {
        task: updated.id,
        title: updated.title,
        status: to,
        close_reason: updated.close_reason,
      });
    }
    if (CLOSED.includes(to)) this.refreshDependents(task.id, actor);
    return updated;
  }

  refuseOpenChildren(task: TaskRow): void {
    const placeholders = CLOSED.map(() => '?').join(',');
    const open = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM board_dependencies d JOIN board_tasks c ON c.id = d.task_id
      WHERE d.depends_on_id = ? AND d.type = 'parent-child' AND c.status NOT IN (${placeholders})`
        )
        .get(task.id, ...CLOSED)?.n ?? 0
    );
    if (open > 0) throw new BoardError('blocked', `${task.id} has ${open} open child task(s)`);
  }

  /**
   * Whether `principal` may review `task`: it holds owner or reviewer and is not the task's requester. The owner
   * reviews what it filed itself, unless it also holds `persona`: the persona never reviews its own task.
   */
  mayReview(principal: string, task: TaskRow): boolean {
    const grants = this.grantsOf(principal);
    if (!grants.has('owner') && !grants.has('reviewer')) return false;
    if (!this.actsFor(principal, task.requester)) return true;
    return grants.has('owner') && !grants.has('persona');
  }

  refreshBlocked(taskId: string, actor: string): void {
    const placeholders = CLOSED.map(() => '?').join(',');
    const open = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM board_dependencies d JOIN board_tasks b ON b.id = d.depends_on_id
      WHERE d.task_id = ? AND d.type = 'blocks' AND b.status NOT IN (${placeholders})`
        )
        .get(taskId, ...CLOSED)?.n ?? 0
    );
    const value = open > 0 ? 1 : 0;
    const task = this.getTask(taskId);
    if (task.is_blocked !== value) {
      this.db
        .prepare('UPDATE board_tasks SET is_blocked = ?, updated_at = ? WHERE id = ?')
        .run(value, this.now(), taskId);
      this.event(taskId, actor, 'blocked', String(task.is_blocked), String(value));
    }
  }

  refreshDependents(blockerId: string, actor: string): void {
    const rows = this.db
      .prepare("SELECT task_id FROM board_dependencies WHERE depends_on_id = ? AND type = 'blocks'")
      .all(blockerId);
    for (const row of rows) this.refreshBlocked(String(row.task_id), actor);
  }

  /** The lease handed back to `owner` (after an answer or a rework order), or cleared. */
  leaseTo(owner: string | null): Record<string, SqlValue> {
    if (!owner) return { lease_owner: null, lease_expires_at: null, heartbeat_at: null };
    return {
      lease_owner: owner,
      lease_expires_at: this.later(this.context.settings.leaseTtlMinutes),
      heartbeat_at: this.now(),
    };
  }

  checkRequires(found: Rule, task: TaskRow, args: Args): void {
    for (const need of found.requires) {
      switch (need) {
        case 'triage-fields': {
          const missing = (['role', 'estimate_minutes'] as const).filter((f) => task[f] === null);
          if (missing.length) throw invalid(`triage needs ${missing.join(', ')}`);
          break;
        }
        case 'close-reason':
          if (!str(args.close_reason, 'close_reason')) throw invalid('close_reason is required');
          break;
        case 'comment':
          if (!str(args.comment, 'comment')) throw invalid('a comment saying what to fix is required');
          break;
        case 'result': {
          const kinds = ['handoff', ...SUBMIT_KINDS];
          const n = this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM board_results WHERE task_id = ? AND kind IN (${kinds.map(() => '?').join(',')})`
            )
            .get(task.id, ...kinds)?.n;
          if (!n) throw invalid('a handoff, or a pr, diff or summary result, is required first');
          break;
        }
        case 'why':
          if (!str(args.close_reason, 'close_reason') && !this.lastOutcome(task.id)) {
            throw invalid('close_reason or an ended attempt with an outcome is required');
          }
          break;
      }
    }
  }

  lastOutcome(taskId: string): string | null {
    const found = this.db
      .prepare('SELECT outcome FROM board_attempts WHERE task_id = ? AND outcome IS NOT NULL ORDER BY n DESC LIMIT 1')
      .get(taskId);
    return typeof found?.outcome === 'string' ? found.outcome : null;
  }

  /** The status change behind task.transition and the moving approvals: authorize, check, apply its side effects. */
  transitionTo(principal: string, task: TaskRow, to: Status, via: Via, args: Args): TaskRow {
    const found = this.authorizeMove(principal, task, to, via);
    this.checkRequires(found, task, args);
    const fields: Record<string, SqlValue> = {};
    if (CLOSED.includes(to)) {
      fields.close_reason =
        str(args.close_reason, 'close_reason') ?? (to === 'failed' ? this.lastOutcome(task.id) : null);
    }
    if (task.status === 'needs_validation' && to === 'in_progress') {
      this.addComment(principal, task, str(args.comment, 'comment') ?? '');
      Object.assign(fields, this.leaseTo(this.parkedBy(task)));
    }
    return this.move(task, to, principal, fields);
  }

  addComment(principal: string, task: TaskRow, text: string): string {
    const id = this.newId('C', 'board_comments');
    this.db
      .prepare('INSERT INTO board_comments (id, task_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, task.id, principal, text, this.now());
    this.event(task.id, principal, 'comment', null, { id, text });
    return id;
  }

  /** Whether `target` is reachable from `from` over blocking dependencies. */
  reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    const next = this.db.prepare("SELECT depends_on_id FROM board_dependencies WHERE task_id = ? AND type = 'blocks'");
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const row of next.all(id)) stack.push(String(row.depends_on_id));
    }
    return false;
  }

  /** The defaults `auto` fills: the board-wide auto triage, then the project's own, as task fields. */
  triageDefaults(project: string | null): TriageFields {
    const { autoTriage, projects } = this.context.settings;
    const own = (project !== null ? projects[project]?.autoTriage : undefined) ?? {};
    const merged = { ...autoTriage, ...own };
    return { role: merged.role, budget_usd: merged.budget, step_cap: merged.steps, estimate_minutes: merged.estimate };
  }
}

/** A board over the memory database's connection; nothing is read until the first call. */
export function openBoard(options: BoardOptions): Board {
  return new Board(options);
}

// ---------- the operations ----------

function questionOf(board: Board, args: Args): Row {
  const qid = str(args.question_id ?? args.id, 'question_id', { required: true });
  const question = board.db.prepare('SELECT * FROM board_questions WHERE id = ?').get(qid);
  if (question === undefined) throw new BoardError('not-found', `no question ${qid}`);
  if (question.answered_at) throw invalid(`${qid} is already answered`);
  return question;
}

// Who a new task is filed for and who hears of it: the caller's own names, `owner`, or a name it acts for.
function filingOf(
  board: Board,
  principal: string,
  args: Args
): { lane: 'dev' | 'errand'; requester: string; subscriber: string } {
  if (args.auto !== undefined && typeof args.auto !== 'boolean') throw invalid('auto must be true or false');
  if (args.no_brief !== undefined && typeof args.no_brief !== 'boolean') {
    throw invalid('no_brief must be true or false');
  }
  const lane = args.lane ?? 'dev';
  if (lane !== 'dev' && lane !== 'errand') throw invalid('lane must be dev or errand');
  const requester = str(args.requester, 'requester') ?? principal;
  if (requester !== 'owner' && !board.actsFor(principal, requester)) {
    throw new BoardError('forbidden', `${principal} may not file for ${requester}`);
  }
  const subscriber = str(args.subscriber, 'subscriber') ?? principal;
  if (subscriber !== 'owner' && !board.actsFor(principal, subscriber)) {
    throw new BoardError('forbidden', `${principal} may not subscribe ${subscriber}`);
  }
  return { lane, requester, subscriber };
}

// A new task's fields as stored; with `auto`, the triage defaults fill only the fields the caller left out.
function newTaskFields(board: Board, args: Args, project: string | null): Record<string, SqlValue> {
  const fields = pickFields(args, UPDATABLE);
  const row: Record<string, SqlValue> = { title: normalizeField('title', fields.title) };
  for (const name of UPDATABLE) {
    if (name === 'title' || name === 'metadata') continue;
    row[name] = normalizeField(name, fields[name]);
  }
  if (args.auto) {
    const defaults = board.triageDefaults(project);
    for (const name of AUTO_TRIAGE_FIELDS) if (row[name] === null) row[name] = defaults[name] ?? null;
  }
  return row;
}

// A child task depends on its parent with a parent-child row: the parent waits for it at done, its claim does not.
function linkParent(board: Board, principal: string, child: string, parent: string): void {
  board.db
    .prepare(
      `INSERT INTO board_dependencies (task_id, depends_on_id, type, created_by, created_at)
      VALUES (?, ?, 'parent-child', ?, ?)`
    )
    .run(child, parent, principal, board.now());
  board.event(child, principal, 'dependency.added', null, { on: parent, type: 'parent-child' });
}

function addTask(board: Board, principal: string, args: Args): TaskRecord {
  const { lane, requester, subscriber } = filingOf(board, principal, args);
  const project = str(args.project, 'project');
  const row = newTaskFields(board, args, project);
  const parent = args.parent === undefined || args.parent === null ? null : board.getTask(args.parent).id;
  const id = board.newId('T', 'board_tasks');
  const now = board.now();
  board.db
    .prepare(
      `INSERT INTO board_tasks (id, lane, project, title, description, acceptance, requester, priority, risk, role,
      budget_usd, step_cap, estimate_minutes, status, defer_until, subscriber, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      lane,
      project,
      row.title,
      row.description,
      row.acceptance,
      requester,
      row.priority,
      row.risk,
      row.role,
      row.budget_usd,
      row.step_cap,
      row.estimate_minutes,
      row.defer_until,
      subscriber,
      now,
      now,
      jsonText(args.metadata, 'metadata')
    );
  board.event(id, principal, 'task.created', null, { title: row.title, lane, requester });
  board.event(id, principal, 'status', null, 'proposed');
  if (parent !== null) linkParent(board, principal, id, parent);
  if (!args.auto) return parseTask(board.getTask(id));
  // Triage and approval in the same transaction, through the machine's own rules: a caller who may not approve this
  // task is refused and nothing is added.
  board.transitionTo(principal, board.getTask(id), 'triaged', 'transition', {});
  // With a reviewer on the board, a dev task waits at triaged for its brief; the reviewer's own filings and an
  // explicit `no_brief` go on to approved at once.
  if (lane === 'dev' && !args.no_brief && board.hasReviewer() && !board.grantsOf(principal).has('reviewer')) {
    return parseTask(board.getTask(id));
  }
  return approveTask(board, principal, { id, scope: 'plan', note: 'auto' }).task;
}

function updateTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, true);
  const picked = pickFields(args.set ?? args, UPDATABLE);
  if (CLOSED.includes(task.status)) {
    // A closed task keeps its fields, except the budget, the step cap and the estimate, which the owner and a
    // reviewer may change for a retry; the status does not change.
    const names = Object.keys(picked);
    if (!names.length || !names.every((n) => BUDGET_FIELDS.includes(n))) {
      throw new BoardError(
        'invalid-transition',
        `${task.id} is ${task.status}: only ${BUDGET_FIELDS.join(', ')} may change`
      );
    }
    const roles = board.roles(principal, task);
    if (!roles.has('owner') && !roles.has('reviewer')) {
      throw new BoardError('forbidden', `${principal} may not change ${task.id}`);
    }
  } else {
    board.requireEditor(principal, task);
  }
  const fields = applyFields(task.metadata, picked);
  if (!Object.keys(fields).length) throw invalid('nothing to update');
  const old = Object.fromEntries(Object.keys(fields).map((k) => [k, (task as Record<string, unknown>)[k]]));
  const updated = board.write(task, fields);
  board.event(task.id, principal, 'task.updated', old, fields);
  return parseTask(updated);
}

function transitionTask(board: Board, principal: string, args: Args): TaskRecord {
  let task = board.getTask(args.id);
  // The errand runner is the only writer of its errand-lane tasks, so it may move them without a revision; a
  // revision it does give must still match.
  board.checkRevision(task, args.revision, !board.isErrandRunner(principal, task));
  // The target is status; to is its alias (the errand mirror sends it). Both given must agree.
  if (args.status != null && args.to != null && args.status !== args.to) {
    throw invalid(`status ${text(args.status)} and to ${text(args.to)} differ`);
  }
  const to = args.status ?? args.to;
  const status = STATUSES.find((s) => s === to);
  if (status === undefined) throw invalid(`unknown status ${String(to)}`);
  if (isObject(args.set) && Object.keys(args.set).length) {
    board.requireEditor(principal, task);
    const fields = applyFields(task.metadata, pickFields(args.set, UPDATABLE));
    if (Object.keys(fields).length) {
      const old = Object.fromEntries(Object.keys(fields).map((k) => [k, (task as Record<string, unknown>)[k]]));
      // The field change and the move share one revision step: write without a bump, then move.
      task = board.write(task, fields, { bump: false });
      board.event(task.id, principal, 'task.updated', old, fields);
    }
  }
  return parseTask(board.transitionTo(principal, task, status, 'transition', args));
}

function claimTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  // A principal that may claim no task at all (a reviewer) is refused before the lease is looked at.
  board.authorizeMove(principal, { ...task, status: 'approved' }, 'in_progress', 'claim');
  if (task.status === 'in_progress' && task.lease_owner) {
    throw new BoardError('claimed', `${task.id} is held by ${task.lease_owner}`);
  }
  board.authorizeMove(principal, task, 'in_progress', 'claim');
  if (task.is_blocked) throw new BoardError('blocked', `${task.id} waits on an open blocker`);
  const now = board.now();
  if (task.defer_until && task.defer_until > now) {
    throw new BoardError('blocked', `${task.id} is deferred until ${task.defer_until}`);
  }
  const expires = board.later(leaseMinutes(args, board.context.settings.leaseTtlMinutes));
  // The claim itself: one guarded statement, so of two claimers exactly one changes the row.
  const info = board.db
    .prepare(
      `UPDATE board_tasks SET status = 'in_progress', lease_owner = ?, lease_expires_at = ?,
      heartbeat_at = ?, lease_generation = lease_generation + 1, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'approved' AND lease_owner IS NULL AND is_blocked = 0
      AND (defer_until IS NULL OR defer_until <= ?)`
    )
    .run(principal, expires, now, now, task.id, now);
  if (Number(info.changes) !== 1) throw new BoardError('claimed', `${task.id} was claimed by someone else`);
  board.event(task.id, principal, 'status', 'approved', 'in_progress');
  const claimed = board.getTask(task.id);
  board.event(task.id, principal, 'lease.claimed', null, {
    owner: principal,
    expires_at: expires,
    generation: claimed.lease_generation,
  });
  return parseTask(claimed);
}

function heartbeatTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkGeneration(task, args.generation);
  if (task.status !== 'in_progress') throw new BoardError('invalid-transition', `${task.id} is ${task.status}`);
  if (task.lease_owner !== principal) throw new BoardError('forbidden', `${principal} does not hold ${task.id}`);
  const expires = board.later(leaseMinutes(args, board.context.settings.leaseTtlMinutes));
  // A heartbeat only extends the lease: it does not bump the revision.
  const updated = board.write(task, { lease_expires_at: expires, heartbeat_at: board.now() }, { bump: false });
  board.event(task.id, principal, 'lease.heartbeat', task.lease_expires_at, expires);
  return parseTask(updated);
}

function releaseTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkGeneration(task, args.generation);
  board.checkRevision(task, args.revision, false);
  board.authorizeMove(principal, task, 'approved', 'release');
  board.event(task.id, principal, 'lease.released', { owner: task.lease_owner }, null);
  return parseTask(board.move(task, 'approved', principal));
}

// A failed task back to approved: the attempts stay (the next one is numbered after them), the note becomes a comment
// the next attempt sees, a new budget or step cap (`budget`, `steps`) is set with it, and its dependents are blocked
// again.
function retryTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  board.authorizeMove(principal, task, 'approved', 'retry');
  const note = str(args.note, 'note');
  const fields = applyFields(task.metadata, pickFields(args, RETRY_FIELDS));
  board.event(task.id, principal, 'task.retried', { close_reason: task.close_reason }, { note });
  if (note) board.addComment(principal, task, note);
  if (Object.keys(fields).length) {
    const old = Object.fromEntries(Object.keys(fields).map((k) => [k, (task as Record<string, unknown>)[k]]));
    board.event(task.id, principal, 'task.updated', old, fields);
  }
  const updated = board.move(task, 'approved', principal, { ...fields, close_reason: null });
  board.refreshDependents(task.id, principal);
  return parseTask(board.getTask(updated.id));
}

function dependTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  board.requireEditor(principal, task);
  const on = board.getTask(args.on ?? args.depends_on_id).id;
  const type = args.type ?? 'blocks';
  if (typeof type !== 'string' || !DEP_TYPES.includes(type))
    throw invalid(`type must be one of ${DEP_TYPES.join(', ')}`);
  if (on === task.id) throw invalid('a task cannot depend on itself');
  if (type === 'blocks' && board.reaches(on, task.id)) throw invalid(`${on} already depends on ${task.id}: a cycle`);
  board.db
    .prepare(
      `INSERT INTO board_dependencies (task_id, depends_on_id, type, created_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_id, depends_on_id) DO UPDATE SET type = excluded.type`
    )
    .run(task.id, on, type, principal, board.now());
  board.write(task, {});
  board.event(task.id, principal, 'dependency.added', null, { on, type });
  board.refreshBlocked(task.id, principal);
  return parseTask(board.getTask(task.id));
}

function undependTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  board.requireEditor(principal, task);
  const on = String(args.on ?? args.depends_on_id);
  const info = board.db
    .prepare('DELETE FROM board_dependencies WHERE task_id = ? AND depends_on_id = ?')
    .run(task.id, on);
  if (Number(info.changes) !== 1) throw new BoardError('not-found', `${task.id} does not depend on ${on}`);
  board.write(task, {});
  board.event(task.id, principal, 'dependency.removed', { on }, null);
  board.refreshBlocked(task.id, principal);
  return parseTask(board.getTask(task.id));
}

function askTask(board: Board, principal: string, args: Args): { question: Row; task: TaskRecord } {
  const task = board.getTask(args.id);
  board.checkGeneration(task, args.generation);
  board.checkRevision(task, args.revision, false);
  const text = str(args.text, 'text', { required: true });
  const toWhom = str(args.to_whom ?? args.to, 'to_whom', { required: true, max: 200 });
  board.authorizeMove(principal, task, 'needs_answer', 'ask');
  const id = board.newId('Q', 'board_questions');
  board.db
    .prepare(
      `INSERT INTO board_questions (id, task_id, attempt_id, asked_by, text, to_whom, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, task.id, str(args.attempt_id, 'attempt_id'), principal, text, toWhom, board.now());
  board.event(task.id, principal, 'question.asked', null, { id, to_whom: toWhom, text });
  const updated = board.move(task, 'needs_answer', principal);
  return { question: board.row('SELECT * FROM board_questions WHERE id = ?', id), task: parseTask(updated) };
}

function answerTask(board: Board, principal: string, args: Args): { question: Row; task: TaskRecord } {
  // The answerer is the caller; a claimed answerer field is a forgery.
  for (const field of ['answered_by', 'principal', 'as']) {
    if (args[field] !== undefined && args[field] !== principal) {
      throw new BoardError('forbidden', `${field} is not yours to set`);
    }
  }
  const question = questionOf(board, args);
  const qid = String(question.id);
  const text = str(args.text, 'text', { required: true });
  const task = board.getTask(question.task_id);
  board.checkRevision(task, args.revision, false);
  const roles = board.roles(principal, task);
  if (board.actsFor(principal, String(question.to_whom))) roles.add('answerer');
  board.authorizeMove(principal, task, 'in_progress', 'answer', roles);
  const now = board.now();
  board.db
    .prepare('UPDATE board_questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
    .run(text, principal, now, qid);
  board.event(task.id, principal, 'question.answered', null, { id: qid, text });
  const askedBy = typeof question.asked_by === 'string' ? question.asked_by : null;
  const updated = board.move(task, 'in_progress', principal, board.leaseTo(askedBy));
  board.notify(task.id, askedBy, 'answer', { task: task.id, question: qid, text, answered_by: principal });
  return { question: board.row('SELECT * FROM board_questions WHERE id = ?', qid), task: parseTask(updated) };
}

// The question's addressee, an owner or a reviewer hands it up to the owner: the question is re-addressed to `owner`,
// the note (if any) becomes a comment, and the owner's outbox gets a row.
function escalateTask(board: Board, principal: string, args: Args): { question: Row; task: TaskRecord } {
  const question = questionOf(board, args);
  const qid = String(question.id);
  const task = board.getTask(question.task_id);
  board.checkRevision(task, args.revision, false);
  if (task.status !== 'needs_answer') {
    throw new BoardError('invalid-transition', `${task.id} is ${task.status}, not needs_answer`);
  }
  const roles = board.roles(principal, task);
  if (!board.actsFor(principal, String(question.to_whom)) && !roles.has('owner') && !roles.has('reviewer')) {
    throw new BoardError('forbidden', `${principal} may not escalate ${qid}`);
  }
  if (question.to_whom === 'owner') throw invalid(`${qid} is already addressed to the owner`);
  const note = str(args.note, 'note');
  board.db.prepare('UPDATE board_questions SET to_whom = ? WHERE id = ?').run('owner', qid);
  board.event(
    task.id,
    principal,
    'question.escalated',
    { id: qid, to_whom: question.to_whom },
    { id: qid, to_whom: 'owner', note }
  );
  if (note) board.addComment(principal, task, note);
  board.notify(task.id, 'owner', 'question', {
    task: task.id,
    question: qid,
    text: question.text,
    escalated_by: principal,
    note,
  });
  const updated = board.write(task, {});
  return { question: board.row('SELECT * FROM board_questions WHERE id = ?', qid), task: parseTask(updated) };
}

function approveTask(board: Board, principal: string, args: Args): { approval: Row; task: TaskRecord } {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  const scope = args.scope ?? 'plan';
  const decision = args.decision ?? 'approve';
  if (scope !== 'plan' && scope !== 'merge' && scope !== 'deploy') throw invalid('scope must be plan, merge or deploy');
  if (decision !== 'approve' && decision !== 'reject') throw invalid('decision must be approve or reject');
  const note = str(args.note, 'note');
  const to = APPROVAL_TARGETS[scope][decision];
  let updated = task;
  if (to !== undefined) {
    // An approval that moves the task: its note is the close reason of a reject, the fix of a merge reject.
    updated = board.transitionTo(principal, task, to, 'approve', { close_reason: note, comment: note });
  } else {
    // A deploy approval only records, and only the owner gives one.
    if (!board.grantsOf(principal).has('owner')) {
      throw new BoardError('forbidden', `${principal} may not approve a deploy`);
    }
    updated = board.write(task, {});
  }
  const id = board.newId('A', 'board_reviews');
  board.db
    .prepare(
      'INSERT INTO board_reviews (id, task_id, principal, decision, scope, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, task.id, principal, decision, scope, note, board.now());
  board.event(task.id, principal, 'approval', null, { id, scope, decision, note });
  return {
    approval: board.row('SELECT * FROM board_reviews WHERE id = ?', id),
    task: parseTask(board.getTask(updated.id)),
  };
}

function insertResult(
  board: Board,
  principal: string,
  task: TaskRow,
  attemptId: string | null,
  { kind, body, uri }: { kind: string; body: string | null; uri: string | null }
): string {
  const id = board.newId('R', 'board_results');
  board.db
    .prepare(
      'INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, task.id, attemptId, kind, body, uri, board.now());
  board.event(task.id, principal, 'result', null, { id, kind, uri });
  return id;
}

function insertHandoff(
  board: Board,
  principal: string,
  task: TaskRow,
  attemptId: string | null,
  handoff: Handoff
): string {
  const body = JSON.stringify(handoff);
  if (body.length > HANDOFF_MAX) throw invalid('the handoff is too long');
  return insertResult(board, principal, task, attemptId, { kind: 'handoff', body, uri: null });
}

// task_id is an alias of id and text of body (the errand mirror sends them). A result has no metadata column:
// metadata given is accepted and not stored.
function resultTask(board: Board, principal: string, args: Args): { result: Row; task: TaskRecord } {
  const task = board.getTask(aliased(args, 'id', 'task_id'));
  board.checkGeneration(task, args.generation);
  board.checkRevision(task, args.revision, false);
  if (!board.isErrandRunner(principal, task)) board.requireEditor(principal, task);
  const kind = args.kind;
  if (typeof kind !== 'string' || !RESULT_KINDS.includes(kind)) {
    throw invalid(`kind must be one of ${RESULT_KINDS.join(', ')}`);
  }
  const body = str(aliased(args, 'body', 'text'), 'body', { max: 2000000 });
  const uri = str(args.uri, 'uri', { max: 2000 });
  if (!body && !uri) throw invalid('a result needs a body or a uri');
  const attemptId = str(args.attempt_id, 'attempt_id');
  // A submitting result of a submit kind is a handoff with only its result and the uri as its artifact.
  const id =
    args.submit && SUBMIT_KINDS.includes(kind)
      ? insertHandoff(board, principal, task, attemptId, {
          result: body ?? uri ?? '',
          evidence: [],
          artifacts: uri ? [uri] : [],
          tests: [],
          open_issues: [],
        })
      : insertResult(board, principal, task, attemptId, { kind, body, uri });
  let updated = board.write(task, {});
  if (args.submit) updated = board.transitionTo(principal, updated, 'needs_validation', 'transition', {});
  return { result: board.row('SELECT * FROM board_results WHERE id = ?', id), task: parseTask(updated) };
}

function commentTask(board: Board, principal: string, args: Args): { comment: CommentRow; task: TaskRecord } {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  const text = str(args.text, 'text', { required: true }) ?? '';
  const id = board.addComment(principal, task, text);
  const updated = board.write(task, {});
  // A board_comments row has exactly the CommentRow columns (schema v1).
  const comment = board.row('SELECT * FROM board_comments WHERE id = ?', id) as CommentRow;
  return { comment, task: parseTask(updated) };
}

function startAttempt(board: Board, principal: string, args: Args): Row {
  const task = board.getTask(args.task_id ?? args.id);
  board.checkRevision(task, args.revision, false);
  if (task.status !== 'in_progress') {
    throw new BoardError('invalid-transition', `${task.id} is ${task.status}, not in_progress`);
  }
  const roles = board.roles(principal, task);
  const starters: ReadonlyArray<Role> = ['holder', 'owner', 'reviewer', 'scheduler'];
  if (!starters.some((r) => roles.has(r)) && !board.isErrandRunner(principal, task)) {
    throw new BoardError('forbidden', `${principal} does not hold ${task.id}`);
  }
  const n = Number(
    board.db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM board_attempts WHERE task_id = ?').get(task.id)?.n
  );
  const id = board.newId('A', 'board_attempts');
  const fields = Object.fromEntries(ATTEMPT_START_FIELDS.map((f) => [f, str(args[f], f, { max: 2000 })]));
  board.db
    .prepare(
      `INSERT INTO board_attempts (id, task_id, n, principal, role, model, provider_pin, worktree, branch, db_path, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      task.id,
      n,
      principal,
      fields.role,
      fields.model,
      fields.provider_pin,
      fields.worktree,
      fields.branch,
      fields.db_path,
      board.now()
    );
  board.event(task.id, principal, 'attempt.started', null, { id, n, ...fields });
  board.write(task, {});
  return board.row('SELECT * FROM board_attempts WHERE id = ?', id);
}

function attemptField(name: string, value: unknown): SqlValue {
  if (ATTEMPT_INTEGERS.includes(name)) return int(value, name);
  if (name === 'cost_est_usd' || name === 'cost_billed_usd') return num(value, name);
  if (name === 'loop_signals' || name === 'stall_signals') return jsonText(value, name);
  return str(value, name, { max: 2000 });
}

function endAttempt(board: Board, principal: string, given: Args): Row {
  const aid = str(given.attempt_id ?? given.id, 'attempt_id', { required: true });
  const attempt = board.db.prepare('SELECT * FROM board_attempts WHERE id = ?').get(aid);
  if (attempt === undefined) throw new BoardError('not-found', `no attempt ${aid}`);
  if (attempt.ended_at) throw invalid(`${aid} has ended`);
  const task = board.getTask(attempt.task_id);
  board.checkGeneration(task, given.generation);
  if (
    attempt.principal !== principal &&
    !board.grantsOf(principal).has('owner') &&
    !board.isErrandRunner(principal, task)
  ) {
    throw new BoardError('forbidden', `${aid} is not ${principal}'s`);
  }
  // cost_usd is an alias of cost_est_usd, and an outcome alias maps onto the board's (OUTCOME_ALIASES).
  const args: Record<string, unknown> = {
    ...given,
    cost_est_usd: aliased(given, 'cost_est_usd', 'cost_usd') ?? undefined,
  };
  if (typeof args.outcome === 'string' && Object.hasOwn(OUTCOME_ALIASES, args.outcome)) {
    args.outcome = OUTCOME_ALIASES[args.outcome];
  }
  if (args.outcome !== undefined && (typeof args.outcome !== 'string' || !OUTCOMES.includes(args.outcome))) {
    throw invalid(`outcome must be one of ${OUTCOMES.join(', ')}`);
  }
  const fields: Record<string, SqlValue> = {};
  for (const f of ATTEMPT_END_FIELDS) if (args[f] !== undefined) fields[f] = attemptField(f, args[f]);
  fields.ended_at = board.now();
  const cols = Object.keys(fields);
  board.db
    .prepare(`UPDATE board_attempts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), aid);
  board.event(task.id, principal, 'attempt.ended', null, { id: aid, outcome: fields.outcome ?? null });
  board.write(board.getTask(task.id), {});
  return board.row('SELECT * FROM board_attempts WHERE id = ?', aid);
}

// One turn of an agent outside any task (a reviewer's orchestration): its wave (required), its session when known,
// the event seqs that woke it. Only a principal granted `reviewer` records runs; the run's agent is the principal.
function startRun(board: Board, principal: string, args: Args): Row {
  if (!board.grantsOf(principal).has('reviewer')) {
    throw new BoardError('forbidden', `${principal} does not record agent runs`);
  }
  const wave = int(args.wave, 'wave', { min: 1 });
  if (wave === null) throw invalid('wave is required');
  const seqs = args.trigger_seqs ?? null;
  if (seqs !== null && (!Array.isArray(seqs) || seqs.some((n) => !Number.isInteger(n) || Number(n) < 0))) {
    throw invalid('trigger_seqs must be a list of event seqs');
  }
  const id = board.newId('U', 'board_agent_runs');
  board.db
    .prepare(
      `INSERT INTO board_agent_runs (id, agent, session_id, wave, started_at, trigger_seqs)
      VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      principal,
      str(args.session_id, 'session_id', { max: 200 }),
      wave,
      board.now(),
      seqs === null ? null : JSON.stringify(seqs)
    );
  return board.row('SELECT * FROM board_agent_runs WHERE id = ?', id);
}

// The turn's end: its accounting (tokens_out with the reasoning tokens in it), its context mean and peak, its
// compactions, its outcome, and the session when run.start did not know it yet. Once only, by its own agent.
function endRun(board: Board, principal: string, args: Args): Row {
  const rid = str(args.id ?? args.run_id, 'id', { required: true });
  const run = board.db.prepare('SELECT * FROM board_agent_runs WHERE id = ?').get(rid);
  if (run === undefined) throw new BoardError('not-found', `no run ${rid}`);
  if (run.agent !== principal) throw new BoardError('forbidden', `${rid} is not ${principal}'s`);
  if (run.ended_at) throw invalid(`${rid} has ended`);
  const fields: Record<string, SqlValue> = {};
  for (const f of RUN_END_INTEGERS) if (args[f] !== undefined) fields[f] = int(args[f], f, { min: 0 });
  if (args.cost_est_usd !== undefined) fields.cost_est_usd = num(args.cost_est_usd, 'cost_est_usd');
  if (args.outcome !== undefined) fields.outcome = str(args.outcome, 'outcome', { max: 100 });
  const session = str(args.session_id, 'session_id', { max: 200 });
  if (session !== null) {
    if (run.session_id && run.session_id !== session) throw invalid(`${rid} ran in session ${text(run.session_id)}`);
    fields.session_id = session;
  }
  fields.ended_at = board.now();
  const cols = Object.keys(fields);
  board.db
    .prepare(`UPDATE board_agent_runs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), rid);
  return board.row('SELECT * FROM board_agent_runs WHERE id = ?', rid);
}

function costsOf(board: Board, _principal: string, args: Args): Readonly<Record<string, unknown>> {
  let nowMs = board.clock();
  if (args.now !== undefined && args.now !== null) {
    nowMs = typeof args.now === 'number' ? args.now : Date.parse(text(args.now));
    if (!Number.isFinite(nowMs)) throw invalid('now must be an ISO time or epoch milliseconds');
  }
  const recorders = [...board.context.grants].filter(([, roles]) => roles.has('reviewer')).map(([name]) => name);
  return agentCosts(board.db, { nowMs, agents: recorders });
}

// The caller's undelivered outbox rows; `ack` marks the caller's rows up to that seq delivered first.
function pullOutbox(board: Board, principal: string, args: Args): Array<Row> {
  const mine = (row: Row): boolean => board.actsFor(principal, typeof row.to_whom === 'string' ? row.to_whom : null);
  if (args.ack !== undefined && args.ack !== null) {
    const ack = int(args.ack, 'ack', { min: 0 });
    const now = board.now();
    const mark = board.db.prepare('UPDATE board_outbox SET delivered_at = ? WHERE seq = ?');
    for (const row of board.db
      .prepare('SELECT seq, to_whom FROM board_outbox WHERE delivered_at IS NULL AND seq <= ?')
      .all(ack)) {
      if (mine(row)) mark.run(now, row.seq);
    }
  }
  const limit = int(args.limit, 'limit', { min: 0, max: 1000 }) ?? 100;
  const rows = board.db
    .prepare('SELECT * FROM board_outbox WHERE delivered_at IS NULL ORDER BY seq')
    .all()
    .filter(mine)
    .slice(0, limit);
  return rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : null,
  }));
}

// ---------- the workflow: block, submit, review, orient ----------

// The holder stops: the task waits in `blocked` with why and what would unblock it, and the lease ends.
function blockTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkGeneration(task, args.generation);
  board.checkRevision(task, args.revision, false);
  board.authorizeMove(principal, task, 'blocked', 'block');
  const reason = str(args.reason, 'reason', { required: true, max: 2000 });
  const unblocks = str(args.unblocks, 'unblocks', { required: true, max: 2000 });
  board.event(task.id, principal, 'task.blocked', { owner: task.lease_owner }, { reason, unblocks });
  return parseTask(board.move(task, 'blocked', principal, { blocked_reason: reason, unblocks }));
}

// The owner or a reviewer returns a blocked task to approved; the note says what changed and becomes a comment.
function unblockTask(board: Board, principal: string, args: Args): TaskRecord {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  board.authorizeMove(principal, task, 'approved', 'unblock');
  const note = str(args.note, 'note', { required: true }) ?? '';
  board.addComment(principal, task, note);
  return parseTask(board.move(task, 'approved', principal, { blocked_reason: null, unblocks: null }));
}

function stringList(value: unknown, name: string): Array<string> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalid(`handoff.${name} must be a list of strings`);
  }
  return [...(value as Array<string>)];
}

function handoffTests(value: unknown): Array<HandoffTest> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('handoff.tests must be a list');
  return value.map((entry: unknown) => {
    const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    if (
      !isObject(entry) ||
      Object.keys(entry).some((key) => !['command', 'passed', 'failed'].includes(key)) ||
      typeof entry.command !== 'string' ||
      entry.command.trim() === '' ||
      !count(entry.passed) ||
      !count(entry.failed)
    ) {
      throw invalid('each handoff test needs a command and its passed and failed counts');
    }
    return { command: entry.command, passed: entry.passed, failed: entry.failed };
  });
}

/** The handoff of a submit, every list filled; throws BoardError 'invalid' for a missing result or a stray key. */
function parseHandoff(value: unknown): Handoff {
  if (!isObject(value)) throw invalid('handoff is required');
  const stray = Object.keys(value).filter((key) => !HANDOFF_KEYS.includes(key));
  if (stray.length) throw invalid(`handoff has unknown fields: ${stray.join(', ')}`);
  if (typeof value.result !== 'string' || value.result.trim() === '') throw invalid('handoff.result is required');
  return {
    result: value.result,
    evidence: stringList(value.evidence, 'evidence'),
    artifacts: stringList(value.artifacts, 'artifacts'),
    tests: handoffTests(value.tests),
    open_issues: stringList(value.open_issues, 'open_issues'),
  };
}

// The holder hands the work over for review: one handoff row, then needs_validation.
function submitTask(board: Board, principal: string, args: Args): { result: Row; handoff: Handoff; task: TaskRecord } {
  const task = board.getTask(args.id);
  board.checkGeneration(task, args.generation);
  board.checkRevision(task, args.revision, false);
  const found = board.authorizeMove(principal, task, 'needs_validation', 'transition');
  const handoff = parseHandoff(args.handoff);
  const id = insertHandoff(board, principal, task, str(args.attempt_id, 'attempt_id'), handoff);
  board.checkRequires(found, task, {});
  const updated = board.move(task, 'needs_validation', principal);
  return { result: board.row('SELECT * FROM board_results WHERE id = ?', id), handoff, task: parseTask(updated) };
}

// accept closes the task under the merge rule of the machine; changes hands it back to the principal who submitted it,
// with the comment. The requester never reviews its own task (Board#mayReview).
function reviewTask(board: Board, principal: string, args: Args): { review: Row; task: TaskRecord } {
  const task = board.getTask(args.id);
  board.checkRevision(task, args.revision, false);
  const decision = args.decision;
  if (decision !== 'accept' && decision !== 'changes') throw invalid('decision must be accept or changes');
  if (task.status !== 'needs_validation') {
    throw new BoardError('invalid-transition', `${task.id} is ${task.status}, not needs_validation`);
  }
  const comment = str(args.comment, 'comment');
  if (decision === 'changes' && !comment) throw invalid('a comment saying what to fix is required');
  const grants = board.grantsOf(principal);
  if ((grants.has('owner') || grants.has('reviewer')) && !board.mayReview(principal, task)) {
    throw new BoardError('forbidden', `${principal} filed ${task.id} and may not review it`);
  }
  const to = decision === 'accept' ? 'done' : 'in_progress';
  const updated = board.transitionTo(principal, task, to, 'review', { comment });
  const id = board.newId('A', 'board_reviews');
  board.db
    .prepare(
      'INSERT INTO board_reviews (id, task_id, principal, decision, scope, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, task.id, principal, decision, 'merge', comment, board.now());
  board.event(task.id, principal, 'review', null, { id, decision, comment });
  return { review: board.row('SELECT * FROM board_reviews WHERE id = ?', id), task: parseTask(updated) };
}

function orientOf(board: Board, principal: string): Orientation {
  const tasks = (status: Status): Array<TaskRow> =>
    board.db
      .prepare('SELECT * FROM board_tasks WHERE status = ? ORDER BY priority, created_at, rowid')
      .all(status)
      .map(asTask);
  const questions = board.db
    .prepare('SELECT * FROM board_questions WHERE answered_at IS NULL ORDER BY created_at, rowid')
    .all()
    .filter((row) => board.actsFor(principal, typeof row.to_whom === 'string' ? row.to_whom : null));
  return {
    held: tasks('in_progress')
      .filter((task) => task.lease_owner === principal)
      .map(parseTask),
    blocked: tasks('blocked')
      .filter((task) => board.parkedBy(task) === principal)
      .map(parseTask),
    reviews: tasks('needs_validation')
      .filter((task) => board.mayReview(principal, task))
      .map(parseTask),
    questions,
  };
}

const OPS: Readonly<Record<BoardOp, Handler>> = {
  'task.add': addTask,
  'task.list': (board, _principal, args) => listTasks(board.db, args, board.now()),
  'task.show': (board, _principal, args) => viewOf(board.db, board.getTask(args.id), board.now()),
  'task.update': updateTask,
  'task.transition': transitionTask,
  'task.claim': claimTask,
  'task.heartbeat': heartbeatTask,
  'task.release': releaseTask,
  'task.retry': retryTask,
  'task.depend': dependTask,
  'task.undepend': undependTask,
  'task.ask': askTask,
  'task.answer': answerTask,
  'task.escalate': escalateTask,
  'task.approve': approveTask,
  'task.result': resultTask,
  'task.comment': commentTask,
  'attempt.start': startAttempt,
  'attempt.end': endAttempt,
  'run.start': startRun,
  'run.end': endRun,
  'costs.agents': costsOf,
  'outbox.pull': pullOutbox,
  'task.block': blockTask,
  'task.unblock': unblockTask,
  'task.submit': submitTask,
  'task.review': reviewTask,
  'task.orient': (board, principal) => orientOf(board, principal),
};
