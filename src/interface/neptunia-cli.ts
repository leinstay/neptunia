// The core's side of the commands over the link: what answers a `command.requested` event. src/core.ts hands each one
// here before the event door sees it, so a command never reaches her memory, her turns or her requests. The link
// (link.ts) lets a command through only from the `cli` principal (the `neptunia` chat and `neptunia -p`, the owner) or
// from an `agent` principal (a development agent of the task board, `neptunia tasks`).
//
// A command of an `agent` principal, and a `task.*` command of the `cli` principal, is a board command: it runs as
// the principal's name through `tasks` (src/board/commands.ts, run in the memory writer by src/board/writer.ts), so
// the board's rights decide it, and it answers whether the core is paused or not.
//
// A command of the `cli` principal is a command of the chat's table (src/interface/commands/table.ts), parsed by the chat, and runs with the owner's rights:
// `status` (the short summary), `header` (the chat's opening line, no row of the table), `help`, and
// `interfaces.list`, `interfaces.enable` and `interfaces.disable` (`args.name`) are answered here, every other one by the
// owner's console (src/interface/commands/console.ts). Every answer is plain text with a status: `ok` when the command
// ran, else the operation's own status (`denied`, `invalid`, `failed`). `status` and `header` read what the core holds
// already (today's usage, the inner life, the errands, the interfaces, the model roles that are down by
// src/llm/role-health.ts) and call no model.
//
// `createCommandIntake` stands between each link and the event door: a `command.requested` envelope is checked,
// acknowledged at once and run on the desk, and its answer goes back as a `command.result` action over the same link;
// every other envelope goes through the door. It also remembers the link of the owner's chat that sent the last line,
// where the core sends her replies in `cli:dm:owner` (`chat()`). With that link gone, `chat()` names the newest open
// chat, a client that asked for the turn events with `turn.replay`, and null with none: a client that only runs commands
// takes no post. src/interface/cli-chat.ts keeps a post while `chat()` is null.
//
// `neptunia -p` with text waits for the end of the turn over its line, which the link has no event for. The intake
// keeps the link of each line of the command line, and `turnEnded` answers it with a `command.result` whose `replyRef`
// is the line's message id: status `ok` when she spoke or chose silence, else the turn's outcome, and the turn's reason
// as the text. A line taken while the core is paused has no turn yet, so it is answered `paused` at once. A client
// waiting for no such result ignores it.
//
// Every line of the command line goes through the door when it arrives, and src/interface/chat-turns.ts tracks the state of its
// turn for the client. The `turn.*` commands of the `cli` principal reach it, and a `chatCommands` dependency answers the chat's other reads (sessions, approvals, checkpoints).

import fs from 'node:fs';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { createChatTurns } from './chat-turns.ts';
// The reading of a line's links, wired by the composition root with the intake.
export { lineLinksOf } from './cli-line-links.ts';
import { COMMANDS } from './commands/table.ts';
import { createDialogBroker } from './commands/dialogs.ts';
import type { DialogBroker, Question } from './commands/dialogs.ts';
import type { Dialog } from '../keys/commands.ts';
import { ackOf, validateEvent } from '../protocol/index.ts';
import type { Adapter } from '../protocol/adapter.ts';
import type { RoleDown } from '../llm/role-health.ts';
import type { Logger } from '../protocol/serve.ts';
import type { Envelope } from '../protocol/wire.ts';
import type { TaskAnswer } from '../board/commands.ts';
import type { AdapterLink, From, LinkDoor } from './link.ts';
import type { Principal } from './principals.ts';
import { SKILL_COMMAND_PREFIX, skillCommandOf } from '../skills/agent-commands.ts';
import type { BoardCaller } from '../tools/operations/board.ts';
import type { SkillsAccess } from '../skills/port.ts';

/** One command's answer: the text the owner reads and its outcome. */
export type Answer = { text: string; status: string; code?: string };

/** A command as the event carries it. */
export type CommandEvent = {
  name: string;
  args: Record<string, unknown>;
  chat: { id: string; rootId?: string | null };
  requester: { id: string; roles: ReadonlyArray<string> };
  /** The answer to a question the command asked: the dialog it belongs to and the text. Never part of `args`. */
  dialogId?: string;
  answer?: string;
};

/** One interface as `interfaces.list` shows it. */
export type InterfaceRow = { name: string; enabled: boolean; connected: boolean };

/** What the summary and the header are made of, read by the core at the moment of the command. */
export type StatusFacts = {
  version: string;
  instance: string;
  coreModel: string;
  paused: { since: string | null; reason?: string } | null;
  /** Today's requests and spend, in total and for the core model role. */
  spend: { requests: number; cost: number; coreCost: number };
  interfaces: ReadonlyArray<InterfaceRow>;
  /** The model roles that are down or still failing, each with why. */
  failingRoles: ReadonlyArray<{ role: string; reason: string }>;
  next: { kind: string; at: number } | null;
  intentions: { pending: number; waiting: number } | null;
  errands: { open: number; latest: ReadonlyArray<{ id: string; state: string; agent: string }> };
  slept: number;
};

export type CommandDeps = {
  /** The owner's console: every command of the table this desk does not answer itself. */
  console: {
    run(
      name: string,
      args: Record<string, unknown>,
      requester: { id: string },
      dialog?: Dialog | null
    ): Promise<Answer>;
  };
  /** The open questions of commands; the desk makes its own while none is given. */
  dialogs?: DialogBroker;
  now?: () => number;
  interfaces: {
    list(): ReadonlyArray<InterfaceRow>;
    enable(name: string): void;
    disable(name: string): Promise<{ drained: number; unknown: number }>;
  };
  facts(): StatusFacts;
  /** The board's `task.*` commands, run under a principal's name. */
  tasks: { command(principal: string, name: string, args: Record<string, unknown>): Promise<TaskAnswer> };
  /** Her skills: an agent lists the pending versions and files a package (`skill.pending`); absent, the command fails. */
  skills?: SkillsAccess | null;
  /** The board `skill.pending { name, task }` binds a package on, as the calling agent. */
  board?: BoardCaller | null;
};

/** The prefix of the board's commands. */
const TASK_PREFIX = 'task.';

const money = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const clock = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The interfaces on one line: each name, up or down, and disabled when the owner switched it off. */
function interfacesLine(rows: ReadonlyArray<InterfaceRow>): string {
  if (rows.length === 0) return 'none';
  return rows
    .map((row) => `${row.name} ${row.connected ? 'up' : 'down'}${row.enabled ? '' : ' (disabled)'}`)
    .join(', ');
}

/** The short summary of `/status`, one fact per line. Pure. */
export function statusText(facts: StatusFacts): string {
  const { spend } = facts;
  const intentions = facts.intentions;
  const { errands } = facts;
  const latest = errands.latest.map((errand) => `${errand.id} ${errand.agent} ${errand.state}`).join(', ');
  return [
    facts.paused === null
      ? 'running'
      : `paused since ${facts.paused.since ?? 'an unknown time'}${facts.paused.reason === undefined ? '' : ` (${facts.paused.reason})`}`,
    `spend today ${money(spend.cost)} over ${spend.requests} requests: core model ${money(spend.coreCost)}, ` +
      `other roles ${money(Math.max(0, spend.cost - spend.coreCost))}`,
    `interfaces: ${interfacesLine(facts.interfaces)}`,
    ...facts.failingRoles.map((row) => `model role ${row.role} failing: ${row.reason}`),
    `next wake: ${facts.next === null ? 'none' : `${facts.next.kind} at ${clock(facts.next.at)}`}`,
    intentions === null
      ? 'intentions: off'
      : `intentions: ${intentions.pending} pending, ${intentions.waiting} waiting`,
    `errands: ${errands.open} open${latest === '' ? '' : `; latest ${latest}`}`,
    `slept wakes since the start: ${facts.slept}`,
  ].join('\n');
}

/** The chat's opening line: the instance, the core version and model, today's spend, the next wake, the errands. */
export function headerText(facts: StatusFacts): string {
  const on = facts.interfaces.filter((row) => row.connected).map((row) => row.name);
  return [
    `${facts.instance} · neptunia ${facts.version} · core model ${facts.coreModel}${facts.paused === null ? '' : ' · paused'}`,
    `spend today ${money(facts.spend.cost)} · interfaces on: ${on.length === 0 ? 'none' : on.join(', ')} · ` +
      `next wake: ${facts.next === null ? 'none' : `${facts.next.kind} at ${clock(facts.next.at)}`} · ` +
      `open errands: ${facts.errands.open}`,
  ].join('\n');
}

/** One line per command of the table, each starting `/<name>`. */
const helpText = (): string => COMMANDS.map((command) => `/${command.name}  ${command.help}`).join('\n');

const failed = (err: unknown): Answer => {
  const status: unknown = err !== null && typeof err === 'object' ? Reflect.get(err, 'status') : null;
  return {
    text: `Error: ${err instanceof Error ? err.message : String(err)}`,
    status: typeof status === 'string' ? status : 'error',
  };
};

/** What a command answers: a result, or a question the owner answers with a second request. */
export type Reply = Answer | Question;

export function createCommandDesk(deps: CommandDeps): {
  run(event: CommandEvent, principal: Pick<Principal, 'kind' | 'name'>): Promise<Reply>;
} {
  const dialogs = deps.dialogs ?? createDialogBroker({ now: deps.now ?? Date.now });

  async function interfaceCommand(name: string, args: Record<string, unknown>): Promise<Answer> {
    if (name === 'interfaces.list') {
      const rows = deps.interfaces.list();
      const lines = rows.map(
        (row) =>
          `${row.name}  ${row.enabled ? 'enabled' : 'disabled'}  ${row.connected ? 'connected' : 'not connected'}`
      );
      return { text: lines.length === 0 ? 'No interface is known.' : lines.join('\n'), status: 'ok' };
    }
    const target = typeof args.name === 'string' ? args.name : '';
    if (target === '') return { text: `usage: /${name.replace('.', ' ')} <name>`, status: 'invalid' };
    if (name === 'interfaces.enable') {
      deps.interfaces.enable(target);
      return { text: `${target} is enabled.`, status: 'ok' };
    }
    const disabled = await deps.interfaces.disable(target);
    return {
      text: `${target} is disabled: ${disabled.drained} actions finished, ${disabled.unknown} ended unknown.`,
      status: 'ok',
    };
  }

  async function cliCommand(event: CommandEvent): Promise<Reply> {
    const { name, args } = event;
    if (event.dialogId !== undefined) {
      const next = dialogs.answer(name, event.dialogId, event.answer ?? '');
      return (
        (await next) ?? {
          text: 'that question is closed (it expired, or the core restarted): run the command again',
          status: 'invalid',
        }
      );
    }
    if (name === 'help') return { text: helpText(), status: 'ok' };
    if (name === 'status') return { text: statusText(deps.facts()), status: 'ok' };
    if (name === 'header') return { text: headerText(deps.facts()), status: 'ok' };
    if (name === 'interfaces.list' || name === 'interfaces.enable' || name === 'interfaces.disable')
      return interfaceCommand(name, args);
    return dialogs.start(name, (dialog) => deps.console.run(name, args, event.requester, dialog));
  }

  async function skillCommandOfAgent(event: CommandEvent, principal: string): Promise<Answer> {
    if (deps.skills == null) return { text: 'skills are not available here', status: 'failed' };
    const answer = await skillCommandOf(deps.skills, { name: principal }, event.name, event.args, {
      board: deps.board,
    });
    return { text: answer.text, status: answer.status };
  }

  async function boardCommand(event: CommandEvent, principal: string): Promise<Answer> {
    const answer = await deps.tasks.command(principal, event.name, event.args);
    return { text: answer.text, status: answer.status };
  }

  return {
    async run(event, principal) {
      try {
        if (principal.kind === 'agent' && event.name.startsWith(SKILL_COMMAND_PREFIX))
          return await skillCommandOfAgent(event, principal.name);
        if (principal.kind === 'agent' || (principal.kind === 'cli' && event.name.startsWith(TASK_PREFIX)))
          return await boardCommand(event, principal.name);
        if (principal.kind === 'cli') return await cliCommand(event);
        return { text: 'commands come from the owner or an agent', status: 'denied' };
      } catch (err) {
        log.warn('commands: command failed', { command: event.name, error: err });
        return failed(err);
      }
    },
  };
}

type Loose = Record<string, unknown>;
const looseOf = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});
const numberOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Where the core keeps what the summary reads, each read at the moment of the command. */
export type FactSources = {
  version: string;
  config(): unknown;
  state(): unknown;
  usageRows(): ReadonlyArray<{ role: string; requests: number; cost: number }>;
  interfaces(): ReadonlyArray<InterfaceRow>;
  inner(): unknown;
  errands(): ReadonlyArray<unknown>;
  /** The model roles that are down (src/llm/role-health.ts#createRoleHealth's `failing`). */
  failingRoles(): ReadonlyArray<RoleDown>;
};

/** How many errands the summary names by id. */
const LATEST_ERRANDS = 3;

/** The facts of the summary and the header from the core's own state: no read of an interface, no model call. */
export function statusFactsOf(sources: FactSources): StatusFacts {
  const config = looseOf(sources.config());
  const state = looseOf(sources.state());
  const rows = sources.usageRows();
  const inner = looseOf(sources.inner());
  const next = looseOf(inner.next);
  const intentions = inner.intentions === null || inner.intentions === undefined ? null : looseOf(inner.intentions);
  const errands = sources.errands().map(looseOf);
  const open = errands.filter((errand) => errand.state === 'queued' || errand.state === 'running');
  const name = looseOf(config.bot).name;
  return {
    version: sources.version,
    instance: typeof name === 'string' && name !== '' ? name : 'neptunia',
    coreModel: String(roleModel(config, 'core') ?? 'unset'),
    paused:
      state.paused === true
        ? {
            since: typeof state.pausedAt === 'string' ? state.pausedAt : null,
            ...(typeof state.pausedReason === 'string' ? { reason: state.pausedReason } : {}),
          }
        : null,
    spend: {
      requests: rows.reduce((sum, row) => sum + numberOf(row.requests), 0),
      cost: rows.reduce((sum, row) => sum + numberOf(row.cost), 0),
      coreCost: rows.filter((row) => row.role === 'core').reduce((sum, row) => sum + numberOf(row.cost), 0),
    },
    interfaces: sources.interfaces(),
    failingRoles: sources.failingRoles().map((row) => ({ role: row.role, reason: row.reason })),
    next: typeof next.at === 'number' && typeof next.kind === 'string' ? { kind: next.kind, at: next.at } : null,
    intentions:
      intentions === null
        ? null
        : {
            pending: numberOf(intentions.pending),
            waiting: numberOf(intentions.waiting),
          },
    errands: {
      open: open.length,
      latest: errands
        .slice(0, LATEST_ERRANDS)
        .map((errand) => ({ id: String(errand.id), state: String(errand.state), agent: String(errand.agent) })),
    },
    slept: numberOf(inner.slept),
  };
}

/** The engine's version (package.json), read once: the summary and the header name it. */
const VERSION = ((): string => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const version = looseOf(parsed).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

const callOf = (owner: unknown, name: string): ((...args: Array<unknown>) => unknown) | null => {
  const method = looseOf(owner)[name];
  return typeof method === 'function'
    ? (...args: Array<unknown>) => Reflect.apply(method, owner, args) as unknown
    : null;
};

/**
 * The summary's facts from the core's own objects (src/core.ts): the hot config, the store's state, today's usage
 * (src/tools/operations/usage.ts), the interface links, the inner life's status and the errand stores. Each is read at the
 * call; one that lacks a method reads as empty.
 */
export function coreStatusFacts(core: {
  hot: unknown;
  store: unknown;
  usage: unknown;
  interfaces: unknown;
  inner: unknown;
  errands: unknown;
  roleHealth: { failing(config: unknown): Array<RoleDown> } | null;
}): StatusFacts {
  const list = (value: unknown): Array<unknown> => (Array.isArray(value) ? (value as Array<unknown>) : []);
  return statusFactsOf({
    version: VERSION,
    config: () => looseOf(core.hot).config,
    state: () => looseOf(looseOf(core.store).state).data,
    usageRows: () =>
      list(callOf(core.usage, 'byRole')?.()).map((row) => {
        const fields = looseOf(row);
        return { role: String(fields.role), requests: numberOf(fields.requests), cost: numberOf(fields.cost) };
      }),
    interfaces: () =>
      list(callOf(core.interfaces, 'list')?.()).map((row) => {
        const fields = looseOf(row);
        return { name: String(fields.name), enabled: fields.enabled === true, connected: fields.connected === true };
      }),
    inner: () => callOf(core.inner, 'status')?.(),
    errands: () => list(callOf(callOf(core.errands, 'get')?.(), 'recent')?.(100)),
    failingRoles: () => core.roleHealth?.failing(looseOf(core.hot).config) ?? [],
  });
}

/** The desk the intake runs commands on, null until the core built it. */
type Desk = ReturnType<typeof createCommandDesk>;

/** The most lines of the command line kept waiting for their turn: the owner's, and a pending call may never run. */
const KEPT_LINES = 64;

/** The prefix of the commands that reach the turn control. */
const TURN_PREFIX = 'turn.';

/** The turn outcomes that are an answer to the line: she spoke, or chose silence. */
const ANSWERED: ReadonlySet<string> = new Set(['spoke', 'skip']);

/** What the chat's turns ask of the turn runner. */
type ChatRunner = { isAnyBusy(): boolean; spokeAfterSeeing(chatId: string, lineId: string): boolean };

export function createCommandIntake(deps: {
  door: LinkDoor;
  ready(): Promise<unknown>;
  desk(): Desk | null;
  /** Whether the core holds a new line instead of starting a turn over it; absent, it never does. */
  linesHeld?(): boolean;
  /**
   * The turn runner, as far as the chat's turns ask it: whether a turn runs anywhere now, and whether the last turn that
   * spoke in a chat had a line in view (src/behavior/turn.ts). Absent, no turn runs and none saw a line.
   */
  runner?(): ChatRunner;
  /** The chat's other reads (src/interface/commands/chat-state.ts): an answer, or null for a name it does not own. */
  chatCommands?(name: string, args: Record<string, unknown>): Promise<Answer> | null;
  /** The name of the owner's person (identity-links.ts#ownerConsoleName); absent or null, his line keeps its name. */
  ownerName?(): string | null;
  /** The owner's line with the link items of its URLs (src/interface/cli-line-links.ts); absent, it goes on as sent. */
  lineLinks?: (message: Loose) => Promise<Loose>;
  log: Logger;
}): {
  doorOf(link: () => AdapterLink): LinkDoor;
  chat(): Adapter | null;
  turnEnded(end: {
    trigger: { id: string | null } | null;
    chatId?: string | null;
    outcome: string;
    reason: string | null;
    turnId?: unknown;
  }): void;
  /** The owner's cancel of the turn over the message `triggerId`, null for every other turn. */
  cancelOf(triggerId: string | null): AbortSignal | null;
  noteProgress(triggerId: string | null, step: { name: string; detail: string }): void;
} {
  const turns = createChatTurns({
    door: deps.door,
    linesHeld: () => deps.linesHeld?.() === true,
    isAnyTurnRunning: () => deps.runner?.().isAnyBusy() === true,
    seenByTurn: (chatId, lineId) => deps.runner?.().spokeAfterSeeing(chatId, lineId) === true,
    log: deps.log,
  });
  let chatLink: AdapterLink | null = null;
  const lines = new Map<string, AdapterLink>();
  // The lines' link reads one after another, so a line without links never overtakes an earlier one.
  let linkTail: Promise<unknown> = Promise.resolve();

  /** The envelope of a line with its link items, or as it came when the reading fails. */
  function withLinks(value: unknown, body: Loose, message: Loose): Promise<unknown> {
    const read = deps.lineLinks;
    if (read === undefined) return Promise.resolve(value);
    const next = linkTail.then(async () => {
      try {
        // What the reading needs exists once the core is ready.
        await deps.ready();
        const envelope = looseOf(value);
        return { ...envelope, body: { ...body, message: await read(message) } };
      } catch (err) {
        deps.log.warn('commands: links of a line not read', { error: err });
        return value;
      }
    });
    linkTail = next;
    return next;
  }

  /** Answers the line `id` once, on the link that sent it. */
  function answerLine(id: string, status: string, text: string): void {
    const link = lines.get(id);
    if (!lines.delete(id) || link === undefined) return;
    void link
      .answerCommand({ replyRef: id, text, status })
      .catch((err: unknown) => deps.log.warn('commands: end of turn not sent', { error: err }));
  }

  /** One line of the command line through the door, its link kept for the end of its turn. */
  /** The envelope of a line with the owner's person's name on its author and its chat, when one is known. */
  function named(envelope: unknown): unknown {
    const name = deps.ownerName?.() ?? null;
    const outer = looseOf(envelope);
    const body = looseOf(outer.body);
    const message = looseOf(body.message);
    if (name === null || looseOf(message.author).self === true) return envelope;
    const author = { ...looseOf(message.author), name };
    return { ...outer, body: { ...body, chat: { ...looseOf(body.chat), name }, message: { ...message, author } } };
  }

  async function takeLine(link: AdapterLink, value: unknown, body: Loose, from?: From): Promise<Envelope> {
    const id = looseOf(body.message).id;
    if (typeof id !== 'string') return deps.door.receive(value, from);
    lines.set(id, link);
    for (const oldest of lines.keys()) {
      if (lines.size <= KEPT_LINES) break;
      lines.delete(oldest);
    }
    const message = looseOf(body.message);
    // A malformed line goes to the door alone, which refuses it: it has no turn to track.
    if (!validateEvent(body).ok) return deps.door.receive(value, from);
    const linked = named(await withLinks(value, body, message));
    return turns.take({
      id,
      value: linked as Envelope,
      message,
      ...(from === undefined ? {} : { from }),
      onHeld: () => answerLine(id, 'paused', 'the core is paused: the line waits for /resume'),
      onNoTurn: () => answerLine(id, 'failed', 'no turn of its own followed this line'),
    });
  }

  async function take(link: AdapterLink, value: Envelope, body: Loose): Promise<Envelope> {
    await deps.ready();
    const verdict = validateEvent(body);
    const desk = deps.desk();
    if (!verdict.ok || desk === null) return ackOf(value, 'invalid', verdict.ok ? 'not-ready' : verdict.reason);
    // The event passed validation as a command.requested: its fields are those of CommandEvent.
    const event = body as unknown as CommandEvent & { replyRef: string };
    const principal = link.principal() ?? { kind: 'interface', name: '' };
    if (principal.kind === 'cli' && event.name.startsWith(TURN_PREFIX)) {
      void link
        .answerCommand({ replyRef: event.replyRef, ...turns.command(link, event.name, event.args) })
        .catch((err: unknown) => deps.log.warn('commands: answer not sent', { error: err }));
      return ackOf(value, 'ok');
    }
    const chatAnswer = principal.kind === 'cli' ? deps.chatCommands?.(event.name, event.args) : null;
    void (chatAnswer ?? desk.run(event, principal))
      .then((answer) => link.answerCommand({ replyRef: event.replyRef, ...answer }))
      .catch((err: unknown) => deps.log.warn('commands: answer not sent', { error: err }));
    return ackOf(value, 'ok');
  }

  return {
    doorOf(link) {
      return {
        receive(value: unknown, from?: From): Promise<Envelope> {
          const envelope = looseOf(value);
          const body = envelope.type === 'event' ? looseOf(envelope.body) : {};
          const current = link();
          if (body.kind === 'message.received' && current.principal()?.kind === 'cli') {
            chatLink = current;
            return takeLine(current, value, body, from);
          }
          // The link hands the door only envelopes it parsed and authenticated.
          if (body.kind === 'command.requested') return take(current, value as Envelope, body);
          return deps.door.receive(value, from);
        },
      };
    },
    chat() {
      if (chatLink !== null && !chatLink.isClosed()) return chatLink.adapter;
      return turns.chats().at(-1)?.adapter ?? null;
    },
    cancelOf: (triggerId) => turns.cancelOf(triggerId),
    noteProgress: (triggerId, step) => turns.noteProgress(triggerId, step),
    turnEnded(end) {
      turns.turnEnded(end);
      const id = end.trigger?.id;
      if (typeof id !== 'string') return;
      if (ANSWERED.has(end.outcome)) answerLine(id, 'ok', '');
      else answerLine(id, end.outcome, `her turn ended ${end.outcome}${end.reason === null ? '' : `: ${end.reason}`}`);
    },
  };
}
