// `neptunia task <command> [options]` (bin/neptunia.ts hands it `runTask`): the task board's command line, a client
// of the core's socket. It takes the commands and flags of the ledger's `task` command line, maps each to the board
// command of the same op (src/board/commands.ts) and prints the core's answer: the plain text, or with `--json` the
// answer's JSON. `update`, `triage`, `move`, `cancel`, `fail` and `result` read the task first, as the ledger's did, for
// its revision or its status. `inbox` pulls the caller's outbox rows and acknowledges them.
//
// The token is `NEPTUNIA_TASK_TOKEN` itself, else the token file of the client `NEPTUNIA_TASK_CLIENT`
// (`<private>/clients/<name>.token`). The socket is `--socket <path>`, else the core's (`<data>/run/core.sock`). The
// client says hello under the agents' namespace `agent`, so its token must stand for an `agent` principal of
// clients.json, and the board's roles of that client decide what it may do.
//
// Exit codes: 0 when the core answers `ok`; 1 for any other answer, with `<status>: <text>` on stderr, and when no
// token is set or no core listens, with `unavailable: ...`; 2 for a usage error (an unknown command, a missing id, a
// missing required flag), found before connecting.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { answerText } from '../src/board/text.ts';
import { coreSocketPath } from '../src/interface/socket.ts';
import { resolvePaths } from '../src/paths.js';
import { ROOT_DIR } from '../src/config.js';
import type { Adapter, Capabilities } from '../src/protocol/adapter.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { CommandResult, Logger } from '../src/protocol/serve.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../src/protocol/wire.ts';

export const TASK_USAGE = `usage: neptunia task <command> [options]   (--socket PATH; default the core's socket)

  task add --lane dev --project core --title "..." [--description -] [--acceptance -] [--priority 2]
           [--risk normal] [--role implementer] [--budget 3] [--steps 60] [--estimate 40] [--defer ISO]
           [--requester owner] [--subscriber lead] [--parent T-xxxxxx] [--auto [--no-brief]]
           # --auto: triaged and approved at once; role, budget, steps, estimate left out come from the config
           # with a reviewer on the board a dev task stops at triaged until it is briefed; --no-brief approves at once
  task list [--lane dev] [--status approved[,triaged]] [--project core] [--requester owner] [--ready] [--json]
  task show T-xxxxxx [--full] [--json]      # --full: result bodies, questions and answers whole; prompts and specs last
  task update T-xxxxxx [--title ..] [--priority N] [--risk ..] [--role ..] [--budget N] [--steps N]
           [--estimate N] [--defer ISO|none] [--description -] [--acceptance -] [--meta key=value]...
           # a closed task: only --budget, --steps, --estimate (the owner, a reviewer)
  task triage T-xxxxxx --role implementer --estimate 40 --budget 3 [--steps 60]
  task approve T-xxxxxx [--scope plan|merge|deploy] [--note "..."] [--reject]
  task reject T-xxxxxx --reason "..."
  task cancel T-xxxxxx --reason "..."          task fail T-xxxxxx [--reason "..."]
  task retry T-xxxxxx [--note "..."] [--budget N] [--steps N]   # a failed task back to approved, its attempts kept
  task move T-xxxxxx <status> [--reason ".."] [--comment ".."]
  task next --lane dev --role <role>           # claims the first ready task of the role; prints nothing ready
  task claim T-xxxxxx [--ttl 30]   task heartbeat T-xxxxxx --generation N [--ttl 30]
  task release T-xxxxxx --generation N
  task block T-xxxxxx --generation N --reason "..." --unblocks "..."   task unblock T-xxxxxx --note "..."
  task submit T-xxxxxx --generation N --handoff <file|->   # the handoff JSON: result, evidence, artifacts, tests, open_issues
  task review T-xxxxxx --accept | --changes --comment "..."
  task orient                                  # what the caller holds, blocked, reviews and is asked
  task depend T-xxxxxx --on T-yyyyyy [--type blocks]   task undepend T-xxxxxx --on T-yyyyyy
  task ask T-xxxxxx --to owner [--generation N] "..."   task answer Q-xxxxxx "..."
  task escalate Q-xxxxxx [--note "..."]        # the question's addressee hands it up to the owner
  task comment T-xxxxxx "..."                  task result T-xxxxxx --kind pr --uri https://... [--body -] [--no-submit]
                                               [--generation N]
  task events [--from <seq>] [--limit N] [--json]
  task inbox [--json]                          # the caller's outbox rows, acknowledged on read
  task costs [--now ISO] [--json]              # the agents: runs, tokens, USD today / 7 / 30 UTC days
Common: --json, --key <idempotency key>, --socket <path>.
Token: NEPTUNIA_TASK_TOKEN, else the token file of the client NEPTUNIA_TASK_CLIENT.`;

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'ready',
  'no-submit',
  'reject',
  'help',
  'full',
  'auto',
  'no-brief',
  'accept',
  'changes',
]);
const AGENT_IFACE = 'agent';

type Flags = Record<string, string | boolean | Array<string>>;
type Parsed = { flags: Flags; positionals: Array<string> };
type Args = Record<string, unknown>;
/** One board command: its name and arguments. */
type Request = { name: string; args: Args };
/** The core's answer of one command. */
type Answer = { status: string; text: string };
type Ask = (request: Request) => Promise<Answer>;

/** A command line the board's command line refuses before it connects: exit 2. */
class UsageError extends Error {}

/** A refusal of the core: exit 1 with `<status>: <text>`. */
class Refused extends Error {
  readonly status: string;
  constructor(status: string, text: string) {
    super(text);
    this.status = status;
  }
}

function parseArgs(argv: ReadonlyArray<string>): Parsed {
  const flags: Flags = {};
  const positionals: Array<string> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--') || token.length <= 2) {
      positionals.push(token);
      continue;
    }
    let name = token.slice(2);
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = value === undefined ? true : value !== 'false';
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      i += 1;
      value = argv[i] ?? '';
    }
    if (name === 'meta') {
      const list = flags.meta;
      flags.meta = [...(Array.isArray(list) ? list : []), value];
    } else {
      flags[name] = value;
    }
  }
  return { flags, positionals };
}

const flagText = (flags: Flags, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
};

function needId(positionals: ReadonlyArray<string>, prefix: string): string {
  const id = positionals[0];
  if (!id?.startsWith(`${prefix}-`)) throw new UsageError(`a ${prefix}-xxxxxx id is required`);
  return id;
}

function needText(positionals: ReadonlyArray<string>, index: number, what: string): string {
  const text = positionals.slice(index).join(' ');
  if (!text) throw new UsageError(`${what} is required`);
  return text;
}

function needFlag(flags: Flags, name: string): string {
  const value = flagText(flags, name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

/** A number flag as a number, absent when not given; a usage error when it is not a number. */
function numberFlag(flags: Flags, name: string): number | undefined {
  const value = flagText(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}

/** `--generation`, the lease's generation of a holder call, as the core's arguments. */
const generationOf = (flags: Flags): Args => {
  const generation = numberFlag(flags, 'generation');
  return generation === undefined ? {} : { generation };
};

/** A text flag, `-` reading it from stdin. */
const textArg = (value: string | undefined, stdin: () => string): string | undefined =>
  value === undefined ? undefined : value === '-' ? stdin() : value;

const FIELD_FLAGS: Readonly<Record<string, string>> = {
  title: 'title',
  priority: 'priority',
  risk: 'risk',
  role: 'role',
  budget: 'budget_usd',
  steps: 'step_cap',
  estimate: 'estimate_minutes',
  defer: 'defer_until',
};
const NUMBER_FIELDS: ReadonlyArray<string> = ['priority', 'budget_usd', 'step_cap', 'estimate_minutes'];

function fieldsFrom(flags: Flags, stdin: () => string): Args {
  const out: Args = {};
  for (const [flag, field] of Object.entries(FIELD_FLAGS)) {
    const value = flagText(flags, flag);
    if (value !== undefined) out[field] = NUMBER_FIELDS.includes(field) ? numberFlag(flags, flag) : value;
  }
  if (out.defer_until === 'none') out.defer_until = null;
  for (const name of ['description', 'acceptance']) {
    const value = textArg(flagText(flags, name), stdin);
    if (value !== undefined) out[name] = value;
  }
  const meta = flags.meta;
  if (Array.isArray(meta)) {
    const metadata: Args = {};
    for (const pair of meta) {
      const eq = pair.indexOf('=');
      if (eq <= 0) throw new UsageError('--meta takes key=value');
      const value = pair.slice(eq + 1);
      metadata[pair.slice(0, eq)] = value === '' ? null : value;
    }
    out.metadata = metadata;
  }
  return out;
}

/** The handoff of `submit`: the JSON of `--handoff`, a file or `-` for stdin. */
function handoffOf(flags: Flags, stdin: () => string): unknown {
  const given = needFlag(flags, 'handoff');
  const text = given === '-' ? stdin() : fs.readFileSync(given, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError('--handoff must hold a JSON object');
  }
}

type Context = { ask: Ask; flags: Flags; positionals: Array<string>; stdin: () => string };
/** One command: what it sends, built from the line before anything is sent, then run. */
type Command = (context: Context) => Request | Promise<Request | Answer>;

/** Asks `request` and throws Refused unless the core answers ok; the answer's JSON. */
async function asked(ask: Ask, request: Request): Promise<unknown> {
  const answer = await ask({ name: request.name, args: { ...request.args, json: true } });
  if (answer.status !== 'ok') throw new Refused(answer.status, answer.text);
  return JSON.parse(answer.text) as unknown;
}

/** The task `id` as `task.show` answers it: its revision and its status. */
async function fetchTask(ask: Ask, id: string): Promise<{ revision: number; status: string }> {
  const view = await asked(ask, { name: 'task.show', args: { id } });
  const task: unknown = view !== null && typeof view === 'object' ? Reflect.get(view, 'task') : null;
  const revision: unknown = task !== null && typeof task === 'object' ? Reflect.get(task, 'revision') : null;
  const status: unknown = task !== null && typeof task === 'object' ? Reflect.get(task, 'status') : null;
  return { revision: Number(revision), status: String(status) };
}

/** A move of the task to `status` through `task.transition`, at the revision it has now. */
function moveTo(status: string): Command {
  return ({ ask, flags, positionals }) => {
    const id = needId(positionals, 'T');
    const extra: Args = {};
    const reason = flagText(flags, 'reason');
    const comment = flagText(flags, 'comment');
    if (reason) extra.close_reason = reason;
    if (comment) extra.comment = comment;
    return fetchTask(ask, id).then((task) => ({
      name: 'task.transition',
      args: { id, status, revision: task.revision, ...extra },
    }));
  };
}

const ttlOf = (flags: Flags): Args => {
  const ttl = numberFlag(flags, 'ttl');
  return ttl === undefined ? {} : { ttl_minutes: ttl };
};

const COMMANDS: Readonly<Record<string, Command>> = {
  add: ({ flags, stdin }) => {
    const args: Args = {
      lane: flagText(flags, 'lane') ?? 'dev',
      project: flagText(flags, 'project'),
      ...fieldsFrom(flags, stdin),
    };
    if (!args.title) throw new UsageError('--title is required');
    for (const name of ['requester', 'subscriber', 'parent']) {
      const value = flagText(flags, name);
      if (value) args[name] = value;
    }
    if (flags.auto === true) args.auto = true;
    if (flags['no-brief'] === true) args.no_brief = true;
    return { name: 'task.add', args };
  },
  list: ({ flags }) => {
    const args: Args = {};
    for (const name of ['lane', 'status', 'project', 'requester']) {
      const value = flagText(flags, name);
      if (value) args[name] = value;
    }
    if (flags.ready === true) args.ready = true;
    return { name: 'task.list', args };
  },
  show: ({ flags, positionals }) => ({
    name: 'task.show',
    args: { id: needId(positionals, 'T'), ...(flags.full === true ? { full: true } : {}) },
  }),
  update: ({ ask, flags, positionals, stdin }) => {
    const id = needId(positionals, 'T');
    const set = fieldsFrom(flags, stdin);
    if (!Object.keys(set).length) throw new UsageError('nothing to update');
    return fetchTask(ask, id).then((task) => ({ name: 'task.update', args: { id, revision: task.revision, set } }));
  },
  triage: ({ ask, flags, positionals, stdin }) => {
    const id = needId(positionals, 'T');
    const set = fieldsFrom(flags, stdin);
    return fetchTask(ask, id).then((task) => ({
      name: 'task.transition',
      args: { id, status: 'triaged', revision: task.revision, set },
    }));
  },
  approve: ({ flags, positionals }) => ({
    name: 'task.approve',
    args: {
      id: needId(positionals, 'T'),
      scope: flagText(flags, 'scope') ?? 'plan',
      decision: flags.reject === true ? 'reject' : 'approve',
      note: flagText(flags, 'note'),
    },
  }),
  reject: ({ flags, positionals }) => ({
    name: 'task.approve',
    args: { id: needId(positionals, 'T'), scope: 'plan', decision: 'reject', note: needFlag(flags, 'reason') },
  }),
  cancel: moveTo('cancelled'),
  fail: moveTo('failed'),
  move: (context) => {
    const status = context.positionals[1];
    if (!status) throw new UsageError('a status is required');
    return moveTo(status)(context);
  },
  retry: ({ flags, positionals, stdin }) => ({
    name: 'task.retry',
    args: {
      id: needId(positionals, 'T'),
      note: flagText(flags, 'note'),
      ...fieldsFrom(
        { ...(flags.budget ? { budget: flags.budget } : {}), ...(flags.steps ? { steps: flags.steps } : {}) },
        stdin
      ),
    },
  }),
  next: ({ flags }) => ({
    name: 'task.next',
    args: { lane: flagText(flags, 'lane') ?? 'dev', role: needFlag(flags, 'role') },
  }),
  claim: ({ flags, positionals }) => ({ name: 'task.claim', args: { id: needId(positionals, 'T'), ...ttlOf(flags) } }),
  heartbeat: ({ flags, positionals }) => ({
    name: 'task.heartbeat',
    args: { id: needId(positionals, 'T'), ...generationOf(flags), ...ttlOf(flags) },
  }),
  release: ({ flags, positionals }) => ({
    name: 'task.release',
    args: { id: needId(positionals, 'T'), ...generationOf(flags) },
  }),
  block: ({ flags, positionals }) => ({
    name: 'task.block',
    args: {
      id: needId(positionals, 'T'),
      reason: needFlag(flags, 'reason'),
      unblocks: needFlag(flags, 'unblocks'),
      ...generationOf(flags),
    },
  }),
  unblock: ({ flags, positionals }) => ({
    name: 'task.unblock',
    args: { id: needId(positionals, 'T'), note: needFlag(flags, 'note') },
  }),
  submit: ({ flags, positionals, stdin }) => {
    const id = needId(positionals, 'T');
    const attempt = flagText(flags, 'attempt');
    return {
      name: 'task.submit',
      args: {
        id,
        handoff: handoffOf(flags, stdin),
        ...generationOf(flags),
        ...(attempt ? { attempt_id: attempt } : {}),
      },
    };
  },
  review: ({ flags, positionals }) => {
    const id = needId(positionals, 'T');
    if ((flags.accept === true) === (flags.changes === true)) throw new UsageError('one of --accept or --changes');
    const comment = flagText(flags, 'comment');
    if (flags.changes === true && !comment) throw new UsageError('--comment is required with --changes');
    return {
      name: 'task.review',
      args: { id, decision: flags.accept === true ? 'accept' : 'changes', ...(comment ? { comment } : {}) },
    };
  },
  orient: () => ({ name: 'task.orient', args: {} }),
  depend: ({ flags, positionals }) => ({
    name: 'task.depend',
    args: { id: needId(positionals, 'T'), on: needFlag(flags, 'on'), type: flagText(flags, 'type') },
  }),
  undepend: ({ flags, positionals }) => ({
    name: 'task.undepend',
    args: { id: needId(positionals, 'T'), on: needFlag(flags, 'on') },
  }),
  ask: ({ flags, positionals }) => ({
    name: 'task.ask',
    args: {
      id: needId(positionals, 'T'),
      to_whom: needFlag(flags, 'to'),
      text: needText(positionals, 1, 'the question'),
      ...generationOf(flags),
    },
  }),
  answer: ({ positionals }) => ({
    name: 'task.answer',
    args: { question_id: needId(positionals, 'Q'), text: needText(positionals, 1, 'the answer') },
  }),
  escalate: ({ flags, positionals }) => {
    const note = flagText(flags, 'note');
    return { name: 'task.escalate', args: { question_id: needId(positionals, 'Q'), ...(note ? { note } : {}) } };
  },
  comment: ({ positionals }) => ({
    name: 'task.comment',
    args: { id: needId(positionals, 'T'), text: needText(positionals, 1, 'the comment') },
  }),
  result: ({ ask, flags, positionals, stdin }) => {
    const id = needId(positionals, 'T');
    const kind = needFlag(flags, 'kind');
    const body = textArg(flagText(flags, 'body'), stdin);
    return fetchTask(ask, id).then((task) => ({
      name: 'task.result',
      args: {
        id,
        kind,
        uri: flagText(flags, 'uri'),
        body,
        submit:
          flags['no-submit'] !== true && task.status === 'in_progress' && ['pr', 'diff', 'summary'].includes(kind),
        ...generationOf(flags),
      },
    }));
  },
  events: ({ flags }) => ({
    name: 'task.events',
    args: { from: numberFlag(flags, 'from') ?? 0, ...(flags.limit ? { limit: numberFlag(flags, 'limit') } : {}) },
  }),
  costs: ({ flags }) => {
    const now = flagText(flags, 'now');
    return { name: 'task.costs.agents', args: now ? { now } : {} };
  },
  inbox: async ({ ask, flags }) => {
    const rows = await asked(ask, { name: 'task.outbox.pull', args: {} });
    const list = Array.isArray(rows) ? rows : [];
    const last: unknown = list.at(-1);
    const seq: unknown = last !== null && typeof last === 'object' ? Reflect.get(last, 'seq') : null;
    if (typeof seq === 'number') await asked(ask, { name: 'task.outbox.pull', args: { ack: seq, limit: 0 } });
    const text = flags.json === true ? JSON.stringify(list, null, 2) : answerText('task.outbox.pull', list, {});
    return { status: 'ok', text };
  },
};

/** What the board's agents declare to the core: nothing. The core sends an agent only command results. */
const AGENT_CAPABILITIES: Capabilities = {
  operations: [],
  maxChars: 0,
  maxFiles: 0,
  maxFileBytes: 0,
  edit: { ownOnly: true, windowMs: null },
  history: false,
  threads: false,
  reactions: false,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
  reads: [],
};

/** The adapter of an agent's link: every action and read is unsupported. */
function agentAdapter(): Adapter {
  const error = { code: 'unsupported', retryable: false, retryAfterMs: null };
  const read = () => Promise.resolve({ status: 'unsupported' as const, error });
  const effect = () =>
    Promise.resolve({ status: 'unsupported' as const, error: { code: 'unsupported', retryable: false } });
  return {
    iface: AGENT_IFACE,
    capabilities: () => AGENT_CAPABILITIES,
    send: (_conversation, _content, options = {}) =>
      Promise.resolve({
        status: 'unsupported',
        ref: null,
        parts: [],
        at: null,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        error,
      }),
    edit: effect,
    delete: effect,
    react: effect,
    unreact: effect,
    typing: () => Promise.resolve({ status: 'ok' }),
    fetchMessages: read,
    conversationInfo: read,
    conversations: read,
    history: read,
    memberInfo: read,
    searchMessages: read,
    searchMembers: read,
    emoji: read,
    parseLinks: read,
    reactors: read,
  };
}

const quiet: Logger = { info() {}, warn() {}, error() {} };

/** The token of `NEPTUNIA_TASK_TOKEN`, else of the client `NEPTUNIA_TASK_CLIENT`'s file; null with neither. */
function tokenOf(env: NodeJS.ProcessEnv, privateDir: string): { token: string; name: string } | string {
  const name = env.NEPTUNIA_TASK_CLIENT || AGENT_IFACE;
  const given = env.NEPTUNIA_TASK_TOKEN;
  if (given) return { token: given.trim(), name };
  if (!env.NEPTUNIA_TASK_CLIENT) return 'set NEPTUNIA_TASK_TOKEN or NEPTUNIA_TASK_CLIENT';
  const file = path.join(privateDir, 'clients', `${name}.token`);
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token === '' ? `the token file ${file} is empty` : { token, name };
  } catch (err) {
    return `cannot read the token ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
}

/** Connects as the agent `name`; rejects when no core listens. */
async function connect(socketPath: string, name: string, token: string): Promise<{ ask: Ask; close(): void }> {
  const transport = await connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES });
  const answers = new Map<string, (result: Answer) => void>();
  transport.onClose(() => {
    for (const resolve of answers.values()) resolve({ status: 'unavailable', text: 'the link to the core closed' });
    answers.clear();
  });
  const served = serveAdapter({
    transport,
    hello: {
      iface: AGENT_IFACE,
      self: { id: name, name },
      community: null,
      capabilities: AGENT_CAPABILITIES,
      resume: null,
    },
    token,
    adapter: agentAdapter(),
    log: quiet,
    onCommandResult: (result: CommandResult) => {
      const resolve = answers.get(result.replyRef);
      answers.delete(result.replyRef);
      resolve?.({ status: result.status ?? 'ok', text: result.text });
    },
  });
  return {
    async ask(request) {
      const replyRef = randomUUID();
      const answer = new Promise<Answer>((resolve) => answers.set(replyRef, resolve));
      const acked = await served.emit({
        kind: 'command.requested',
        iface: AGENT_IFACE,
        at: Date.now(),
        id: `${AGENT_IFACE}:command:${replyRef}`,
        conversation: { id: `${AGENT_IFACE}:${name}`, kind: 'dm' },
        name: request.name,
        args: request.args,
        requester: { id: name, name, roles: [], owner: false },
        replyRef,
      });
      if (acked !== 'ok') {
        answers.delete(replyRef);
        return {
          status: acked === 'invalid' ? 'invalid' : 'unavailable',
          text: `the core did not take the command (${acked})`,
        };
      }
      return answer;
    },
    close: () => served.close(),
  };
}

/** Runs `neptunia task ...argv`; resolves with the exit code. Prints the answer on stdout, a refusal on stderr. */
export async function runTask(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const out = (text: string): void => void process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  const err = (text: string): void => void process.stderr.write(`${text}\n`);
  const stdin = (): string => fs.readFileSync(0, 'utf8');
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(TASK_USAGE);
    return 2;
  }
  const { flags, positionals } = parsed;
  const name = positionals.shift();
  if (name === undefined || flags.help === true || name === 'help') {
    (name === undefined ? err : out)(TASK_USAGE);
    return name === undefined ? 2 : 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    err(`unknown command ${name}`);
    err(TASK_USAGE);
    return 2;
  }
  // The line's own checks run against a core that answers nothing: a usage error is found before connecting.
  const dry: Ask = () => Promise.resolve({ status: 'ok', text: '{"task":{"revision":0,"status":""}}' });
  try {
    await command({ ask: dry, flags, positionals: [...positionals], stdin: () => '{}' });
  } catch (error) {
    if (error instanceof UsageError) {
      err(error.message);
      err(TASK_USAGE);
      return 2;
    }
    // Any other failure of the dry run (a --handoff file that cannot be read) is found again below.
  }
  const where = resolvePaths({ rootDir: ROOT_DIR });
  const held = tokenOf(env, where.privateDir);
  if (typeof held === 'string') {
    err(`unavailable: ${held}`);
    return 1;
  }
  const socketPath = flagText(flags, 'socket') ?? coreSocketPath(where.dataDir);
  let link: { ask: Ask; close(): void };
  try {
    link = await connect(socketPath, held.name, held.token);
  } catch (error) {
    err(`unavailable: no core listens at ${socketPath} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    return 1;
  }
  const key = flagText(flags, 'key');
  try {
    const built = await command({ ask: link.ask, flags, positionals: [...positionals], stdin });
    const answer =
      'name' in built
        ? await link.ask({
            name: built.name,
            args: {
              ...built.args,
              ...(flags.json === true ? { json: true } : {}),
              ...(key ? { idempotency: key } : {}),
            },
          })
        : built;
    if (answer.status !== 'ok') {
      err(`${answer.status}: ${answer.text}`);
      return 1;
    }
    out(answer.text);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(error.message);
      err(TASK_USAGE);
      return 2;
    }
    if (error instanceof Refused) {
      err(`${error.status}: ${error.message}`);
      return 1;
    }
    err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    link.close();
  }
}
