// The owner's console in the core: what runs a command of the `cli` principal once bin/neptunia.ts parsed it by the
// table (src/interface/commands/table.ts). src/interface/neptunia-cli.ts hands it every command of that principal
// but `status`, `header` and the interface switches, which it answers itself. A command that maps onto an operation
// runs it through `runOp` with the owner's context (`asOwner`, src/tools/types.ts#OpContext), so the rights check
// passes it as the owner even while `bot.owners` is empty, and the operation's own owner checks do too. The rest read
// what the core holds: the live config, the usage accumulator, the memory database's read connection and the reply
// metric. The console asks no model and calls no `fetch`, except the key limits of `/usage` and the probes of
// `/doctor live`, which are the status card's own reads.
//
// Every answer is plain text with a status: `ok` when the command ran, else the operation's own (`denied`,
// `invalid`, `failed`). A refused answer starts with the command as the owner typed it, so it names the id, the tool
// or the path it refused. The text is for the owner alone and never reaches her memory or a request.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { coreHealth } from '../../health/core.ts';
import { memoryHealth } from '../../health/memory.ts';
import { serverHealth, systemProbe, worse } from '../../health/server.ts';
import type { HealthStatus } from '../../health/server.ts';
import { DEVELOPMENT_ROLES, ERRAND_ROLES, MEMORY_ROLE } from '../../llm/roles.js';
import { backupDatabase, backupName, backupSettings, backupsIn, partialOf } from '../../memory/db/backup.js';
import { skillFeatureOn } from '../../tools/access.ts';
import { grantedSkillNames } from '../../tools/discovery.ts';
import { ownValueAt, splitPath } from '../../tools/impl/shared.ts';
import { skillRegistry } from '../../tools/registry.ts';
import { callMethod, listOf, objOf } from '../../tools/types.ts';
import type { Counters, DaysSum, RoleRow } from '../../tools/impl/usage.ts';

/** One command's answer: the text the owner reads and its outcome. */
export type Answer = { text: string; status: string };

/** An operation's result as src/tools/impl/index.ts#runOp answers it. */
type OpResult = { status: string; code: string; summary: string; data: unknown };

export type ConsoleDeps = {
  /** One operation for a caller, the rights check included (src/admin.js#runSkillOp). */
  runOp(op: string, args: Record<string, unknown>, context: Record<string, unknown>): Promise<OpResult>;
  /** The owner's reads that are no operation (src/admin.js#ownerReads): each a reply text, or a thrown refusal. */
  ownerReads: {
    lessons(context: Record<string, unknown>): string;
    aliases(args: Record<string, unknown>, context: Record<string, unknown>): string;
  };
  guildId(): string | null;
  /** Her own id on the interface that said who she is, null before one did. */
  selfId(): string | null;
  /** The hot settings (src/hot.js): `config` is read at each use. */
  hot: unknown;
  /** The private directory, where config.local.json lives. */
  privateDir: string;
  dataDir: string;
  /** The memory database (src/memory/db/service.js): `database()` is its read connection, null while it is closed. */
  memoryDb: unknown;
  usage: { byRole(): Array<RoleRow>; sumDays(days: number): DaysSum } | null;
  /** The speed figures (src/tools/impl/metrics.ts): `samples('reply', 24)` are the reply durations of the last day. */
  metrics: unknown;
  /** A conversation's newest stored lines, oldest first. */
  conversationLines(conversationId: string, count: number): ReadonlyArray<{ author: string; text: string }>;
  now(): number;
};

/** How many stored lines `/memory conversation` prints. */
const CONVERSATION_LINES = 30;

/** The window of `/health memory`: people who spoke within it and about whom nothing was written in it. */
const HEALTH_DAYS = 7;

/** The days of a `/usage` window. */
const WINDOW_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Dollars as the chat prints them: four decimals under a dollar, two above. */
export const money = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

/** The model group a role's spend counts under (plan 4.3: base, errands, development, memory). */
function groupOf(role: string): string {
  if (role === MEMORY_ROLE) return 'memory';
  if (ERRAND_ROLES.includes(role)) return 'errands';
  if (DEVELOPMENT_ROLES.includes(role)) return 'development';
  return 'base';
}

/** One row of counters: requests, tokens and dollars. */
const countersLine = (row: Counters): string =>
  `${row.requests} requests, ${row.promptTokens} in, ${row.cachedTokens} cached, ${row.completionTokens} out, ${money(row.cost)}`;

/** The role rows grouped by model group, each group with its total, each role by its name. */
export function roleRowsText(rows: ReadonlyArray<RoleRow>): Array<string> {
  if (rows.length === 0) return ['no request'];
  const groups = new Map<string, Array<RoleRow>>();
  for (const row of rows) groups.set(groupOf(row.role), [...(groups.get(groupOf(row.role)) ?? []), row]);
  const lines: Array<string> = [];
  for (const [group, members] of groups) {
    const cost = members.reduce((sum, row) => sum + row.cost, 0);
    const requests = members.reduce((sum, row) => sum + row.requests, 0);
    lines.push(`${group}: ${requests} requests, ${money(cost)}`);
    for (const row of members) lines.push(`  ${row.role}: ${countersLine(row)}`);
  }
  return lines;
}

/** The card's fields (status.show's `{ fields }`) as sections of text, `replace` naming new values. */
function cardSections(data: unknown, replace: Readonly<Record<string, string>>): string {
  const fields = isRecord(data) && Array.isArray(data.fields) ? (data.fields as Array<unknown>) : [];
  return fields
    .filter(isRecord)
    .map((field) => {
      const name = text(field.name);
      return `[${name}]\n${replace[name] ?? text(field.value)}`;
    })
    .join('\n\n');
}

/** The probe lines of the status card (src/tools/impl/status.ts#probeLine) mark a failed probe so. */
const FAILED_PROBE = '· failed';

/** A route's role as the owner typed it: `any`, or none, is a route of every role. */
const anyRole = (role: unknown): unknown => (role === 'any' ? undefined : role);

/** The command as the owner typed it, for the head of a refused answer. */
function typed(name: string, args: Readonly<Record<string, unknown>>): string {
  const values = Object.values(args).filter((value) => value !== undefined && value !== '');
  return ['/' + name.replaceAll('.', ' '), ...values.map(String)].join(' ');
}

export function createConsole(deps: ConsoleDeps): {
  run(name: string, args: Record<string, unknown>, requester: { id: string }): Promise<Answer>;
} {
  const config = (): unknown => objOf(deps.hot).config;
  // The read connection is a DatabaseSync (src/memory/db/open.js), null while the database is closed.
  const database = (): DatabaseSync | null => (callMethod(deps.memoryDb, 'database') as DatabaseSync | null) ?? null;
  const replyDurations = (): Array<number> =>
    listOf(callMethod(deps.metrics, 'samples', 'reply', 24)).filter((ms): ms is number => typeof ms === 'number');
  const memoryFile = (): string => {
    const file = objOf(objOf(config()).memoryDb).file;
    return path.join(deps.dataDir, typeof file === 'string' && file !== '' ? file : 'memory.db');
  };

  /** The context of an operation the owner runs from the console (src/tools/types.ts#OpContext.asOwner). */
  const ownerContext = (requester: { id: string }): Record<string, unknown> => ({
    guildId: deps.guildId(),
    userId: requester.id,
    roleIds: [],
    actor: 'owner',
    asOwner: true,
  });

  /** One operation as the owner, its result as an answer. */
  async function op(
    name: string,
    opName: string,
    opArgs: Record<string, unknown>,
    args: Record<string, unknown>,
    requester: { id: string }
  ): Promise<Answer> {
    const context = ownerContext(requester);
    const result = await deps.runOp(opName, opArgs, context);
    const said = result.summary !== '' ? result.summary : text(isRecord(result.data) ? result.data.text : '');
    if (result.status === 'ok') return { text: said === '' ? 'done' : said, status: 'ok' };
    return { text: `${typed(name, args)}: ${said === '' ? result.code : said}`, status: result.status };
  }

  const refused = (name: string, args: Record<string, unknown>, why: string, status = 'invalid'): Answer => ({
    text: `${typed(name, args)}: ${why}`,
    status,
  });

  async function statusFull(requester: { id: string }): Promise<Answer> {
    const context = ownerContext(requester);
    const result = await deps.runOp('status.show', { offline: true }, context);
    if (result.status !== 'ok') return { text: `/status full: ${result.summary}`, status: result.status };
    // The costs of the day in the console's dollars, so a cent under a dollar stays readable.
    const costs = roleRowsText(deps.usage?.byRole() ?? []).join('\n');
    return { text: cardSections(result.data, { 'costs.base': costs }), status: 'ok' };
  }

  async function doctorLive(requester: { id: string }): Promise<Answer> {
    const context = ownerContext(requester);
    const result = await deps.runOp('status.show', { field: 'models.base' }, context);
    if (result.status !== 'ok') return { text: result.summary, status: result.status };
    const probes = cardSections(result.data, {});
    return { text: probes, status: probes.includes(FAILED_PROBE) ? 'failed' : 'ok' };
  }

  /** The card's `keys.base` field: each key's limit and spend, read with the status card's GETs. */
  async function keyLimits(requester: { id: string }): Promise<string> {
    const context = ownerContext(requester);
    const result = await deps.runOp('status.show', { field: 'keys.base' }, context);
    if (result.status !== 'ok') return result.summary;
    return cardSections(result.data, {}).replace(/^\[keys\.base\]\n/, '');
  }

  async function health(part: string): Promise<Answer> {
    const db = database();
    const settings = config();
    const parts: Array<{ status: HealthStatus; text: string }> = [];
    const now = deps.now();
    if (part === '' || part === 'server') parts.push(await serverHealth(systemProbe(settings, deps.dataDir), { now }));
    if (part === '' || part === 'core' || part === 'memory') {
      if (db === null) return { text: 'the memory database is not open', status: 'failed' };
      if (part !== 'memory') parts.push(coreHealth(db, { now, turnDurationsMs: replyDurations() }));
      if (part !== 'core') {
        const backupsDir = backupSettings(settings, deps.dataDir).dir;
        parts.push(memoryHealth(db, { now, days: HEALTH_DAYS, backupsDir }));
      }
    }
    const status = parts.reduce<HealthStatus>((all, one) => worse(all, one.status), 'ok');
    return { text: parts.map((one) => one.text).join('\n\n'), status: status === 'fail' ? 'failed' : 'ok' };
  }

  function usage(window: string, keys: string): Answer {
    const days = WINDOW_DAYS[window] ?? 1;
    const sum = deps.usage?.sumDays(days) ?? null;
    if (sum === null) return { text: 'no usage accumulator', status: 'failed' };
    const head = days === 1 ? `usage today (${sum.since})` : `usage over the last ${days} days, since ${sum.since}`;
    return {
      text: [
        `${head}: ${countersLine(sum.total)}`,
        ...roleRowsText(sum.rows),
        '',
        'by interface:',
        ...(sum.interfaces.length === 0
          ? ['  none named']
          : sum.interfaces.map((row) => `  ${row.iface}: ${countersLine(row)}`)),
        '',
        'key limits:',
        keys,
      ].join('\n'),
      status: 'ok',
    };
  }

  function configGet(name: string, args: Record<string, unknown>): Answer {
    const settings = config();
    const found = ownValueAt(settings, splitPath(text(args.path), settings));
    if (!found.found) return refused(name, args, 'no such setting');
    return { text: JSON.stringify(found.value, null, 2) ?? 'null', status: 'ok' };
  }

  function configShow(): Answer {
    try {
      return { text: fs.readFileSync(path.join(deps.privateDir, 'config.local.json'), 'utf8'), status: 'ok' };
    } catch {
      return { text: 'no config.local.json: the shipped settings apply', status: 'ok' };
    }
  }

  function memoryBackup(name: string, args: Record<string, unknown>): Answer {
    const { dir } = backupSettings(config(), deps.dataDir);
    const made = backupName(deps.now());
    const partial = path.join(dir, partialOf(made));
    try {
      fs.mkdirSync(dir, { recursive: true });
      backupDatabase({ db: memoryFile(), to: partial, data: deps.dataDir, now: () => deps.now() });
      fs.renameSync(partial, path.join(dir, made));
    } catch (err) {
      fs.rmSync(partial, { recursive: true, force: true });
      return refused(name, args, err instanceof Error ? err.message : String(err), 'failed');
    }
    return {
      text: [`backup ${made} in ${dir}`, 'kept:', ...backupsIn(dir).map((one) => `  ${one}`)].join('\n'),
      status: 'ok',
    };
  }

  function memoryConversation(args: Record<string, unknown>): Answer {
    const lines = deps.conversationLines(text(args.conversation), CONVERSATION_LINES);
    if (lines.length === 0) return { text: 'no stored line in that conversation', status: 'ok' };
    return { text: lines.map((line) => `${line.author || '?'}: ${line.text}`).join('\n'), status: 'ok' };
  }

  /** One of the owner's reads that is no operation, its refusal as an answer. */
  function ownerRead(name: string, args: Record<string, unknown>, read: () => string): Answer {
    try {
      return { text: read(), status: 'ok' };
    } catch (err) {
      const status = objOf(err).status;
      return refused(
        name,
        args,
        err instanceof Error ? err.message : String(err),
        typeof status === 'string' ? status : 'failed'
      );
    }
  }

  function toolsList(): Answer {
    const settings = config();
    const registry = skillRegistry();
    const granted = new Set(grantedSkillNames({ config: settings, selfId: deps.selfId(), registry }));
    const lines = [...registry.keys()].sort().map((tool) => {
      const state = !skillFeatureOn(tool, settings) ? 'off by its feature switch' : granted.has(tool) ? 'granted' : '-';
      return `${tool}  ${state}`;
    });
    return { text: lines.join('\n'), status: 'ok' };
  }

  /** `/tools grant|revoke <tool> [target]`: her grant without a target, else everyone, a role or a user. */
  function grantArgs(name: string, args: Record<string, unknown>): Record<string, unknown> | Answer {
    const target = text(args.target);
    const command = text(args.tool);
    if (target === 'everyone') return { command };
    const [kind, id] = target.split(' ');
    if (kind === 'role' && id !== undefined) return { command, roleId: id };
    if (kind === 'user' && id !== undefined) return { command, userId: id };
    const self = deps.selfId();
    if (self === null) return refused(name, args, 'no interface has said who the persona is yet', 'failed');
    return { command, userId: self };
  }

  async function intentionShow(name: string, args: Record<string, unknown>, requester: { id: string }) {
    const listed = await op(name, 'intention.list', {}, args, requester);
    if (listed.status !== 'ok') return listed;
    const id = text(args.id);
    const line = listed.text.split('\n').find((one) => one.startsWith(`${id} `));
    return line === undefined ? refused(name, args, 'no open intention has that id') : { text: line, status: 'ok' };
  }

  /** The operation and its arguments each command of the table runs. */
  const OPERATIONS: Readonly<Record<string, (args: Record<string, unknown>) => [string, Record<string, unknown>]>> = {
    'errands.list': () => ['errand.list', {}],
    'errands.show': (args) => ['errand.status', { id: args.id }],
    'errands.cancel': (args) => ['errand.cancel', { id: args.id }],
    'intentions.list': () => ['intention.list', {}],
    'intentions.cancel': (args) => ['intention.cancel', { id: args.id }],
    'wakes.list': () => ['inner.status', {}],
    'wakes.stop': () => ['inner.stop', {}],
    'wakes.start': () => ['inner.start', {}],
    pause: () => ['bot.pause', {}],
    resume: () => ['bot.resume', {}],
    'config.set': (args) => ['config.set', { path: args.path, value: args.value }],
    'config.unset': (args) => ['config.unset', { path: args.path }],
    'model.show': () => ['model.show', {}],
    'model.set': (args) => ['model.set', { role: args.role, id: args.model }],
    'route.list': () => ['route.list', {}],
    'route.set': (args) => [
      'route.set',
      {
        model: args.model,
        providers: args.providers,
        role: anyRole(args.role),
        fallbacks: args.fallbacks === undefined ? undefined : args.fallbacks === 'true',
        byok: args.byok,
      },
    ],
    'route.remove': (args) => ['route.remove', { model: args.model, role: anyRole(args.role) }],
    'memory.profile': (args) => ['memory.profile.read', { userId: args.user, section: args.section }],
    'memory.recent': () => ['memory.recent.read', {}],
    'memory.affinity': (args) => ['memory.affinity.read', { userId: args.user }],
    'memory.search': (args) => ['memory.search', { question: args.query }],
    'memory.restore': (args) => ['memory.restore', { itemId: args.id }],
    'memory.journal': (args) => ['memory.journal.read', args.day === undefined ? {} : { day: args.day }],
    'memory.private': (args) => ['memory.private.read', { userId: args.user }],
    'memory.archive': (args) => ['memory.archive.read', args.kind === undefined ? {} : { kind: args.kind }],
    'memory.server': () => ['memory.server.read', {}],
    'memory.lore.add': (args) => ['lore.add', { title: args.title, keys: args.keys, text: args.text }],
    'memory.lore.list': (args) => ['lore.list', { query: args.query }],
    'memory.lore.show': (args) => ['lore.show', { id: args.id }],
    'memory.lore.remove': (args) => ['lore.remove', { id: args.id }],
    'memory.aliases.add': (args) => ['alias.add', { userId: args.user, name: args.name }],
    'memory.aliases.remove': (args) => ['alias.remove', { userId: args.user, name: args.name }],
    'memory.lessons.add': (args) => ['learning.add', { text: args.text }],
    'memory.lessons.remove': (args) => ['learning.remove', { id: Number(args.id) }],
    'rules.add': (args) => ['rule.add', { text: args.text }],
    'rules.list': () => ['rule.list', {}],
    'rules.remove': (args) => ['rule.remove', { number: Number(args.number) }],
    'tools.describe': (args) => ['tools.describe', { name: args.tool }],
  };

  async function run(name: string, args: Record<string, unknown>, requester: { id: string }): Promise<Answer> {
    switch (name) {
      case 'status.full':
        return statusFull(requester);
      case 'doctor.live':
        return doctorLive(requester);
      case 'health':
        return health(text(args.part));
      case 'usage':
        return usage(text(args.window), await keyLimits(requester));
      case 'intentions.show':
        return intentionShow(name, args, requester);
      case 'config.get':
        return configGet(name, args);
      case 'config.show':
        return configShow();
      case 'memory.backup':
        return memoryBackup(name, args);
      case 'memory.conversation':
        return memoryConversation(args);
      case 'memory.lessons.list':
        return ownerRead(name, args, () => deps.ownerReads.lessons(ownerContext(requester)));
      case 'memory.aliases.list':
        return ownerRead(name, args, () => deps.ownerReads.aliases({ userId: args.user }, ownerContext(requester)));
      case 'tools.list':
        return toolsList();
      case 'tools.grant':
      case 'tools.revoke': {
        const given = grantArgs(name, args);
        if ('status' in given && typeof given.status === 'string') return given as Answer;
        return op(name, name === 'tools.grant' ? 'access.grant' : 'access.revoke', given, args, requester);
      }
      case 'interface.command':
        return refused(name, args, `the interface ${text(args.name)} has no commands of its own`);
      default: {
        const operation = OPERATIONS[name];
        if (operation === undefined) return refused(name, args, 'no such command; type /help');
        const [opName, opArgs] = operation(args);
        return op(name, opName, opArgs, args, requester);
      }
    }
  }

  return { run };
}
