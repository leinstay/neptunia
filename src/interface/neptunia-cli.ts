// The core's side of the commands over the link: what answers a `command.requested` event. src/core.js hands each one
// here before the event door sees it, so a command never reaches her memory, her turns or her requests. The link
// (link.ts) lets a command through only from the `cli` principal (the `neptunia` chat and `neptunia -p`, the owner),
// from an interface principal granted `commands` (a unit's slash commands, `/nep`), or from an `agent` principal (a
// development agent of the task board, `neptunia task`).
//
// A command of an `agent` principal, and a `task.*` command of the `cli` principal, is a board command: it runs as
// the principal's name through `tasks` (src/board/commands.ts, run in the memory writer by src/board/writer.ts), so
// the board's rights decide it, and it answers whether the core is paused or not.
//
// A command of an interface principal is a `/nep` command key with its arguments: it runs through the admin's
// `runCommand`, the rights of its requester checked as on the in-process path. A command of the `cli` principal is a
// command of the chat's table (src/interface/commands/table.ts), parsed by the chat, and runs with the owner's rights:
// `status` (the short summary), `header` (the chat's opening line, no row of the table), `help`, and
// `interface.list`, `interface.enable` and `interface.disable` (`args.name`) are answered here, every other one by the
// owner's console (src/interface/commands/console.ts). Every answer is plain text with a status: `ok` when the command
// ran, else the operation's own status (`denied`, `invalid`, `failed`). `status` and `header` read what the core holds
// already (today's usage, the inner life, the errands, the interfaces, the model roles that are down by
// src/llm/role-health.ts) and call no model.
//
// `createCommandIntake` stands between each link and the event door: a `command.requested` envelope is checked,
// acknowledged at once and run on the desk, and its answer goes back as a `command.result` action over the same link;
// every other envelope goes through the door. It also remembers the link of the owner's chat that sent the last line,
// where the core sends her replies in `cli:dm:owner` (`chat()`).

import fs from 'node:fs';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { COMMANDS } from './commands/table.ts';
import { ackOf, validateEvent } from '../protocol/index.js';
import type { Adapter } from '../protocol/adapter.ts';
import type { RoleDown } from '../llm/role-health.ts';
import type { Logger } from '../protocol/serve.ts';
import type { Envelope } from '../protocol/wire.ts';
import type { TaskAnswer } from '../board/commands.ts';
import type { AdapterLink, From, LinkDoor } from './link.ts';
import type { Principal } from './principals.ts';

/** One command's answer: the text the owner reads and its outcome. */
export type Answer = { text: string; status: string };

/** A command as the event carries it. */
export type CommandEvent = {
  name: string;
  args: Record<string, unknown>;
  conversation: { id: string; communityId?: string | null };
  requester: { id: string; roles: ReadonlyArray<string> };
};

type OpResult = { status: string; summary: string; data?: unknown };

/** One interface as `interface.list` shows it. */
export type InterfaceRow = { name: string; enabled: boolean; connected: boolean };

/** What the summary and the header are made of, read by the core at the moment of the command. */
export type StatusFacts = {
  version: string;
  instance: string;
  coreModel: string;
  paused: { since: string | null } | null;
  /** Today's requests and spend, in total and for the core model role. */
  spend: { requests: number; cost: number; coreCost: number };
  interfaces: ReadonlyArray<InterfaceRow>;
  /** The model roles that are down or still failing, each with why. */
  failingRoles: ReadonlyArray<{ role: string; reason: string }>;
  next: { kind: string; at: number } | null;
  intentions: { pending: number; waiting: number; proposed: number } | null;
  errands: { open: number; latest: ReadonlyArray<{ id: string; state: string; agent: string }> };
  slept: number;
};

export type CommandDeps = {
  /** The owner's console: every command of the table this desk does not answer itself. */
  console: { run(name: string, args: Record<string, unknown>, requester: { id: string }): Promise<Answer> };
  admin: {
    runCommand(commandKey: string, args: Record<string, unknown>, context: Record<string, unknown>): Promise<OpResult>;
  };
  interfaces: {
    list(): ReadonlyArray<InterfaceRow>;
    enable(name: string): void;
    disable(name: string): Promise<{ drained: number; unknown: number }>;
  };
  facts(): StatusFacts;
  guildId(): string | null;
  /** The board's `task.*` commands, run under a principal's name. */
  tasks: { command(principal: string, name: string, args: Record<string, unknown>): Promise<TaskAnswer> };
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
  const latest = facts.errands.latest.map((errand) => `${errand.id} ${errand.agent} ${errand.state}`).join(', ');
  return [
    facts.paused === null ? 'running' : `paused since ${facts.paused.since ?? 'an unknown time'}`,
    `spend today ${money(spend.cost)} over ${spend.requests} requests: core model ${money(spend.coreCost)}, ` +
      `other roles ${money(Math.max(0, spend.cost - spend.coreCost))}`,
    `interfaces: ${interfacesLine(facts.interfaces)}`,
    ...facts.failingRoles.map((row) => `model role ${row.role} failing: ${row.reason}`),
    `next wake: ${facts.next === null ? 'none' : `${facts.next.kind} at ${clock(facts.next.at)}`}`,
    intentions === null
      ? 'intentions: off'
      : `intentions: ${intentions.pending} pending, ${intentions.waiting} waiting, ${intentions.proposed} proposed`,
    `errands: ${facts.errands.open} open${latest === '' ? '' : `; latest ${latest}`}`,
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

export function createCommandDesk(deps: CommandDeps): {
  run(event: CommandEvent, principal: Pick<Principal, 'kind' | 'name'>): Promise<Answer>;
} {
  async function interfaceCommand(name: string, args: Record<string, unknown>): Promise<Answer> {
    if (name === 'interface.list') {
      const rows = deps.interfaces.list();
      const lines = rows.map(
        (row) =>
          `${row.name}  ${row.enabled ? 'enabled' : 'disabled'}  ${row.connected ? 'connected' : 'not connected'}`
      );
      return { text: lines.length === 0 ? 'No interface is known.' : lines.join('\n'), status: 'ok' };
    }
    const target = typeof args.name === 'string' ? args.name : '';
    if (target === '') return { text: `usage: /${name.replace('.', ' ')} <name>`, status: 'invalid' };
    if (name === 'interface.enable') {
      deps.interfaces.enable(target);
      return { text: `${target} is enabled.`, status: 'ok' };
    }
    const drained = await deps.interfaces.disable(target);
    return {
      text: `${target} is disabled: ${drained.drained} actions finished, ${drained.unknown} ended unknown.`,
      status: 'ok',
    };
  }

  async function cliCommand(event: CommandEvent): Promise<Answer> {
    const { name, args } = event;
    if (name === 'help') return { text: helpText(), status: 'ok' };
    if (name === 'status') return { text: statusText(deps.facts()), status: 'ok' };
    if (name === 'header') return { text: headerText(deps.facts()), status: 'ok' };
    if (name === 'interface.list' || name === 'interface.enable' || name === 'interface.disable')
      return interfaceCommand(name, args);
    return deps.console.run(name, args, event.requester);
  }

  async function nepCommand(event: CommandEvent): Promise<Answer> {
    const context = {
      guildId: event.conversation.communityId ?? null,
      channelId: event.conversation.id,
      userId: event.requester.id,
      roleIds: event.requester.roles,
    };
    const result = await deps.admin.runCommand(event.name, event.args, context);
    if (result.status === 'ok') return { text: result.summary, status: 'ok' };
    if (result.status === 'denied') return { text: 'Not allowed', status: 'denied' };
    return { text: `Error: ${result.summary}`, status: result.status };
  }

  async function boardCommand(event: CommandEvent, principal: string): Promise<Answer> {
    const answer = await deps.tasks.command(principal, event.name, event.args);
    return { text: answer.text, status: answer.status };
  }

  return {
    async run(event, principal) {
      try {
        if (principal.kind === 'agent' || (principal.kind === 'cli' && event.name.startsWith(TASK_PREFIX)))
          return await boardCommand(event, principal.name);
        return principal.kind === 'cli' ? await cliCommand(event) : await nepCommand(event);
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
  inner(guildId: string | null): unknown;
  errands(guildId: string | null): ReadonlyArray<unknown>;
  guildId(): string | null;
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
  const guildId = sources.guildId();
  const inner = looseOf(sources.inner(guildId));
  const next = looseOf(inner.next);
  const intentions = inner.intentions === null || inner.intentions === undefined ? null : looseOf(inner.intentions);
  const errands = sources.errands(guildId).map(looseOf);
  const open = errands.filter((errand) => errand.state === 'queued' || errand.state === 'running');
  const name = looseOf(config.bot).name;
  return {
    version: sources.version,
    instance: typeof name === 'string' && name !== '' ? name : 'neptunia',
    coreModel: String(roleModel(config, 'core') ?? 'unset'),
    paused: state.paused === true ? { since: typeof state.pausedAt === 'string' ? state.pausedAt : null } : null,
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
            proposed: numberOf(intentions.proposed),
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
 * The summary's facts from the core's own objects (src/core.js): the hot config, the store's state, today's usage
 * (src/tools/impl/usage.ts), the interface links, the inner life's status and the errand stores. Each is read at the
 * call; one that lacks a method reads as empty.
 */
export function coreStatusFacts(core: {
  hot: unknown;
  store: unknown;
  usage: unknown;
  interfaces: unknown;
  inner: unknown;
  errands: unknown;
  guildId: () => unknown;
  roleHealth: { failing(config: unknown): Array<RoleDown> } | null;
}): StatusFacts {
  const list = (value: unknown): Array<unknown> => (Array.isArray(value) ? (value as Array<unknown>) : []);
  const guildId = (): string | null => {
    const id = core.guildId();
    return typeof id === 'string' && id !== '' ? id : null;
  };
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
    inner: (id) => (id === null ? null : callOf(core.inner, 'status')?.(id)),
    errands: (id) => list(callOf(callOf(core.errands, 'get')?.(id), 'recent')?.(100)),
    guildId,
    failingRoles: () => core.roleHealth?.failing(looseOf(core.hot).config) ?? [],
  });
}

/** The desk the intake runs commands on, null until the core built it. */
type Desk = ReturnType<typeof createCommandDesk>;

export function createCommandIntake(deps: {
  door: LinkDoor;
  ready(): Promise<unknown>;
  desk(): Desk | null;
  log: Logger;
}): { doorOf(link: () => AdapterLink): LinkDoor; chat(): Adapter | null } {
  let chatLink: AdapterLink | null = null;

  async function take(link: AdapterLink, value: Envelope, body: Loose): Promise<Envelope> {
    await deps.ready();
    const verdict = validateEvent(body);
    const desk = deps.desk();
    if (!verdict.ok || desk === null) return ackOf(value, 'invalid', verdict.ok ? 'not-ready' : verdict.reason);
    // The event passed validation as a command.requested: its fields are those of CommandEvent.
    const event = body as unknown as CommandEvent & { replyRef: string };
    const principal = link.principal() ?? { kind: 'interface', name: '' };
    void desk
      .run(event, principal)
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
          if (body.kind === 'message.received' && current.principal()?.kind === 'cli') chatLink = current;
          // The link hands the door only envelopes it parsed and authenticated.
          if (body.kind === 'command.requested') return take(current, value as Envelope, body);
          return deps.door.receive(value, from);
        },
      };
    },
    chat: () => (chatLink !== null && !chatLink.isClosed() ? chatLink.adapter : null),
  };
}
