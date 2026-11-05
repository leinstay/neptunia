// The owner's console in the core: what runs a command of the `cli` principal once bin/neptunia.ts parsed it by the
// table (src/interface/commands/table.ts). src/interface/neptunia-cli.ts hands it every command of that principal
// but `status`, `header` and the interface switches, which it answers itself. A command that maps onto an operation
// runs it through `runOp` with the owner's context (`asOwner`, src/tools/types.ts#OpContext), so the rights check
// passes it as the owner even while `bot.owners` is empty, and the operation's own owner checks do too. The rest read
// what the core holds: the live config, the usage accumulator, the memory database's read connection and the reply
// metric. The console asks no model and calls no `fetch`, except the key limits of `/usage`, the probes of
// `/doctor live`, which are the status card's own reads, and the checks of the key commands (src/keys/commands.ts).
//
// Every answer is plain text with a status: `ok` when the command ran, else the operation's own (`denied`,
// `invalid`, `failed`). A refused answer starts with the command as the owner typed it, so it names the id, the tool
// or the path it refused. The text is for the owner alone and never reaches her memory or a request.

import { accountNodeOf } from '../../memory/db/person-links.ts';
import { nativeAuthorityOf } from '../../protocol/identity.ts';
import type { Db } from '../../memory/db/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { moveConfigKeys } from '../../config-moves.ts';
import { cutConfigKeys } from '../../config/cut.ts';
import { checkConfig } from '../../config/check.ts';
import { localConfigPath } from '../../config/files.ts';
import { CONFIG_SCHEMA } from '../../config/schema.ts';
import { coreHealth } from '../../health/core.ts';
import { memoryHealth } from '../../health/memory.ts';
import { serverHealth, systemProbe, worse } from '../../health/server.ts';
import type { HealthStatus } from '../../health/server.ts';
import type { Dialog } from '../../keys/commands.ts';
import { setInterfaceToken } from './interface-token.ts';
import { DEVELOPMENT_ROLES, ERRAND_ROLES, MEMORY_ROLE } from '../../llm/roles.ts';
import { backupDatabase, backupName, backupSettings, backupsIn, partialOf } from '../../memory/db/backup.ts';
import { grantedSkillNames } from '../../tools/discovery.ts';
import { ownValueAt, splitPath } from '../../tools/impl/shared.ts';
import { skillRegistry } from '../../tools/registry.ts';
import type { SkillsAccess } from '../../skills/port.ts';
import type { ConsoleSubharness } from './subharness.ts';
import { coreSelection, readCoreCheck } from '../../setup/model-check.ts';
import type { CoreReadiness } from '../../setup/readiness.ts';
import { mirrorCommand } from './mirror.ts';
import type { MirrorDesk } from '../../behavior/mirror-desk.ts';
import { searchCommand } from './search.ts';
import { skillsCommand } from './skills.ts';
import { MODULE_ACTIONS, moduleCommand } from './module-setup.ts';
import type { ModuleAction } from './module-setup.ts';
import { accountLinks } from '../../memory/db/person-links.ts';
import { serviceCommand } from '../../keys/services.ts';
import { simulationCommand, subharnessCommand, subharnessDeps } from './subharness.ts';
import { serviceFamily } from '../../service/commands.ts';
import type { WakeClock } from '../../service/commands.ts';
import type { ServiceName } from '../../service/schedule.ts';
import { spawnRun } from '../../setup/install.ts';
import type { RunManager } from '../../service/manager.ts';
import { SUBHARNESS_AGENTS } from '../../subharness/control.ts';
import { DEFAULT_BASE_URL } from '../../subharness/models.ts';
import { modelRoleRegistry, roleSources } from '../../subharness/model-capabilities.ts';
import { usageLines } from '../../subharness/usage.ts';
import type { BackendUsage } from '../../subharness/usage.ts';
import { callMethod, listOf, objOf } from '../../tools/types.ts';
import type { Counters, DaysSum, RoleRow } from '../../tools/impl/usage.ts';

/** One command's answer: the text the owner reads and its outcome. */
export type Answer = { text: string; status: string; code?: string };

/** An operation's result as src/tools/impl/index.ts#runOp answers it. */
type OpResult = { status: string; code: string; summary: string; data: unknown };

export type ConsoleDeps = {
  /** One operation for a caller, the rights check included (src/admin.ts#runSkillOp). */
  runOp(op: string, args: Record<string, unknown>, context: Record<string, unknown>): Promise<OpResult>;
  /** The owner's reads that are no operation (src/admin.ts#ownerReads): each a reply text, or a thrown refusal. */
  ownerReads: {
    lessons(context: Record<string, unknown>): string;
    aliases(args: Record<string, unknown>, context: Record<string, unknown>): string;
  };
  /** Every place the core serves or holds memory of: a command names one unless there is exactly one. */
  places(): ReadonlyArray<string>;
  /** Her own id on the interface that said who she is, null before one did. */
  selfId(): string | null;
  /** The hot settings (src/hot.ts): `config` is read at each use. */
  hot: unknown;
  /** The private directory, where config.local/config.json lives. */
  privateDir: string;
  dataDir: string;
  /** What the chat's status line reads: what the core already knows, with no probe (src/core.ts). */
  statusBrief?: () => unknown;
  /** The memory writer as its last probe left it, for `status.readiness`; `unknown` before the first. */
  memoryWriter?: () => 'ok' | 'down' | 'unknown';
  /** The memory database (src/memory/db/service.ts): `database()` is its read connection, null while it is closed. */
  memoryDb: unknown;
  usage: { byRole(): Array<RoleRow>; sumDays(days: number): DaysSum } | null;
  /** The speed figures (src/tools/impl/metrics.ts): `samples('reply', 24)` are the reply durations of the last day. */
  metrics: unknown;
  /** A conversation's newest stored lines, oldest first. */
  conversationLines(conversationId: string, count: number): ReadonlyArray<{ author: string; text: string }>;
  now(): number;
  /** Her skills (src/skills/port.ts); `/skills` fails while there is none. */
  skills?: SkillsAccess | null;
  /**
   * The key commands (src/keys/commands.ts). `enabled()` is true while the core takes its keys from `keys.json`: only then
   * does `model set` check the model on the role's key before it saves; before that it is the plain operation.
   */
  keys?: {
    enabled(): boolean;
    run(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer>;
  } | null;
  /**
   * What a model selection checks with (src/subharness/selection.ts): one run of codex or claude, `fetch` for opencode,
   * and `applyMode`, which puts a mode into the agent's unit. Absent, a selection answers `failed` and saves nothing.
   */
  subharness?: ConsoleSubharness;
  /** What each backend's own account says (src/subharness/usage.ts), for `/usage`. A read starts no model run. */
  backendUsage?: () => Promise<ReadonlyArray<BackendUsage>>;
  /** The name and value of the key a role's direct requests go out on (src/keys/ring.ts), for `/model sources`. */
  roleKey?: (role: string) => { name: string; value: string } | null;
  /** The diary's mirrors (src/behavior/mirror-desk.ts); `/mirror` fails while there is none. */
  mirrors?: MirrorDesk | null;
  /** How `/services` and `/doctor server` reach the service manager, the machine's own when absent. A test always gives its own. */
  serviceManager?: RunManager;
  /** What the core knows of one of its wakes, for `/services <name> status`. */
  wakeClock?: (name: ServiceName) => WakeClock | null;
};

/** The engine checkout, where the shipped interface packages and their setup contracts are. */
const PLACE_REQUIRED_CODE = 'PLACE_REQUIRED';

const ENGINE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

type OwnCommandDeps = Pick<ConsoleDeps, 'dataDir' | 'hot' | 'memoryDb' | 'memoryWriter' | 'runOp' | 'statusBrief'>;

/** The commands answered by a module of their own, or null for any other. */
function ownCommand(
  { dataDir, hot, memoryDb, memoryWriter, runOp, statusBrief: brief }: OwnCommandDeps,
  name: string,
  args: Record<string, unknown>,
  dialog: Dialog | null
): Promise<Answer> | null {
  if (name.startsWith('keys.service.')) return serviceCommand(dataDir, name, args, dialog);
  if (name === 'status.brief') return Promise.resolve({ text: JSON.stringify(brief?.() ?? null), status: 'ok' });
  if (name === 'status.readiness') {
    const read: CoreReadiness = {
      model: { selection: coreSelection(objOf(hot).config), check: readCoreCheck(dataDir) },
      memory: {
        service: callMethod(memoryDb, 'database') == null ? 'down' : 'ok',
        writer: memoryWriter?.() ?? 'unknown',
      },
    };
    return Promise.resolve({ text: JSON.stringify(read), status: 'ok' });
  }
  if (name.startsWith('search.')) return Promise.resolve(searchCommand(dataDir, name, args, ENGINE_ROOT));
  if (name === 'memory.bind' || name === 'memory.unbind') return personLinkCommand(memoryDb, runOp, name, args);
  if (name === 'memory.accounts') return Promise.resolve(accountsCommand(memoryDb, args));
  const action = moduleActionOf(name);
  return action === null ? null : moduleRun(dataDir, name, action, args, dialog);
}

/** `/memory accounts`: the accounts of one person, read through the memory database's read connection. */
function accountsCommand(memoryDb: unknown, args: Record<string, unknown>): Answer {
  const db = callMethod(memoryDb, 'database') as Parameters<typeof accountLinks>[0] | null;
  if (db == null || typeof db.prepare !== 'function')
    return { text: 'the memory database is closed', status: 'failed' };
  const word = (key: string) => (typeof args[key] === 'string' ? args[key] : '');
  const { accounts } = accountLinks(db, word('iface'), word('account'));
  return { text: accounts.map((one) => `${one.iface} ${one.native}`).join('\n'), status: 'ok' };
}

/** `/memory bind` and `/memory unbind`: the one way accounts come to share a person. */
async function personLinkCommand(
  memoryDb: unknown,
  runOp: ConsoleDeps['runOp'],
  name: string,
  args: Record<string, unknown>
): Promise<Answer> {
  const word = (key: string) => (typeof args[key] === 'string' ? args[key] : '');
  const named = word('target');
  const target =
    named === 'self'
      ? { self: true }
      : named === 'owner'
        ? { owner: true }
        : { iface: named, native: word('targetAccount') };
  if (name === 'memory.bind' && 'native' in target && target.native === '')
    return {
      text: 'name the other account: bind <iface> <account> <iface> <account>, or self, or owner',
      status: 'invalid',
    };
  try {
    const accountOfWords = (iface: string, native: string): string | null =>
      accountNodeOf(callMethod(memoryDb, 'database') as Db, {
        interfaceId: iface,
        authorityId: nativeAuthorityOf(iface),
        nativeId: native,
        generation: 1,
      });
    const accountId = accountOfWords(word('iface'), word('account'));
    const other = 'native' in target ? accountOfWords(String(target.iface), String(target.native)) : null;
    if (accountId === null || ('native' in target && other === null))
      return { text: 'she has not met that account yet; bind it after its first message', status: 'invalid' };
    const written = (await (callMethod(memoryDb, 'personLink', {
      op: name === 'memory.bind' ? 'bind' : 'unbind',
      accountId,
      target: 'native' in target ? { accountId: other } : target,
    }) as Promise<unknown>)) as { person?: unknown } | null;
    if (name === 'memory.bind' && 'owner' in target) {
      const set = await runOp('config.set', { path: 'bot.ownerPerson', value: written?.person }, { asOwner: true });
      if (set.status !== 'ok') return { text: `the owner person was not set: ${set.summary}`, status: 'failed' };
    }
    return {
      text: `${word('iface')} ${word('account')}: ${name === 'memory.bind' ? 'bound' : 'unbound'}`,
      status: 'ok',
    };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code === 'UNKNOWN_ACCOUNT'
      ? { text: 'she has not met that account yet; bind it after its first message', status: 'invalid' }
      : { text: 'the binding could not be written', status: 'failed' };
  }
}

/** Runs a command over a module's setup contract: `/skills` for a skill, `/interfaces` for an interface. */
function moduleRun(
  dataDir: string,
  name: string,
  action: ModuleAction,
  args: Record<string, unknown>,
  dialog: Dialog | null
) {
  const kind = name.startsWith('skills.') ? 'skill' : 'interface';
  return moduleCommand({ rootDir: ENGINE_ROOT, dataDir, kind }, action, args, dialog);
}

/** The action of a command over a module's setup contract, or null for any other command. */
function moduleActionOf(name: string): ModuleAction | null {
  const [group, action] = name.split('.');
  if (group !== 'interfaces' && group !== 'skills') return null;
  return MODULE_ACTIONS.find((one) => one === action) ?? null;
}

/** The prefix of the `/skills` commands, which `skillsCommand` answers. */
const SKILLS_PREFIX = 'skills.';

/** The prefix of the `/services` commands, which `serviceFamily` answers. */
const SERVICE_PREFIX = 'services.';

/** The prefix of the `/keys` commands, which the key commands answer. */
const KEYS_PREFIX = 'keys.';
/** The prefixes of `/subharness` and `/simulation`, which `subharnessCommand` and `simulationCommand` answer. */
const SUBHARNESS_PREFIX = 'subharness.';
const isSubharnessCommand = (name: string): boolean => name.startsWith(SUBHARNESS_PREFIX) || name === 'agent.mode';
const SIMULATION_PREFIX = 'simulation.';

/** How many stored lines `/memory conversation` prints. */
const CONVERSATION_LINES = 30;

/** The window of `/doctor memory`: people who spoke within it and about whom nothing was written in it. */
const HEALTH_DAYS = 7;

/** The part of the core's reading each `/doctor` command answers: the whole of it, or one part. */
const DOCTOR_PARTS: Readonly<Record<string, string>> = {
  doctor: '',
  'doctor.server': 'server',
  'doctor.core': 'core',
  'doctor.memory': 'memory',
};

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

/** `/config show`: the private settings file as it is on disk (src/config/files.ts#localConfigPath). */
function configShow(privateDir: string): Answer {
  const file = localConfigPath(privateDir);
  try {
    return { text: fs.readFileSync(file, 'utf8'), status: 'ok' };
  } catch {
    return { text: `no ${path.relative(privateDir, file)}: the shipped settings apply`, status: 'ok' };
  }
}

/**
 * `/config check`: the private settings file against the schema (src/config/check.ts), its keys of an old name moved
 * to the new one first (src/config-moves.ts) and the keys of the config cut taken out (src/config/cut.ts), one line per
 * unknown key or key of the wrong type.
 */
function configCheck(privateDir: string): Answer {
  const file = localConfigPath(privateDir);
  const shown = path.relative(privateDir, file);
  let local: unknown = {};
  try {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    local = raw === '' ? {} : JSON.parse(raw);
  } catch (err) {
    return { text: `${shown} does not parse: ${err instanceof Error ? err.message : String(err)}`, status: 'failed' };
  }
  const settled = isRecord(local) ? cutConfigKeys(moveConfigKeys(local).config).config : local;
  const problems = checkConfig(settled, CONFIG_SCHEMA);
  if (problems.length === 0) return { text: `${shown}: every key is known and of its type`, status: 'ok' };
  const lines = problems.map(({ key, kind }) => (kind === 'unknown' ? `${key}: unknown key` : `${key}: wrong type`));
  return { text: lines.join('\n'), status: 'failed' };
}

/** The commands that read the private settings file and nothing else, by name. */
const LOCAL_CONFIG_READS: Record<string, ((privateDir: string) => Answer) | undefined> = {
  'config.show': configShow,
  'config.check': configCheck,
};

/** The command as the owner typed it, for the head of a refused answer. */
function typed(name: string, args: Readonly<Record<string, unknown>>): string {
  const values = Object.values(args).filter((value) => value !== undefined && value !== '');
  return ['/' + name.replaceAll('.', ' '), ...values.map(String)].join(' ');
}

/**
 * The answer of a `model set` that neither the key commands nor the `model.set` operation take, or null. An agent's
 * model and effort live in its subharness, checked with one reply there, and so does the memory writer's with `--via`.
 * `--provider` and `--effort` are checked on the role's key, so they need the key commands of `keys.json`.
 */
function modelSetElsewhere(deps: ConsoleDeps, args: Record<string, unknown>): Promise<Answer> | null {
  const typedLine = `/model set ${text(args.role)}`;
  const refuse = (why: string): Promise<Answer> => Promise.resolve({ text: `${typedLine}: ${why}`, status: 'invalid' });
  const isAgent = SUBHARNESS_AGENTS.some((agent) => agent === args.role);
  const flags = args.effort === undefined ? {} : { effort: args.effort };
  if (text(args.via) !== '') {
    if (!isAgent && args.role !== 'memory')
      return Promise.resolve({
        text: `${typedLine}: ${text(args.role)} has no subharness path; only an agent or memory takes --via`,
        status: 'invalid',
        code: 'role-unsupported',
      });
    if (text(args.provider) !== '') return refuse('a role on a subharness takes no --provider');
    if (text(args.model) === '') return refuse(`name the model: /model set ${text(args.role)} <model> --via <backend>`);
    if (isAgent) {
      const given = { agent: args.role, model: args.model, via: args.via, ...flags };
      return subharnessCommand(subharnessDeps(deps), 'subharness.model', given);
    }
    const given = { backend: args.via, model: args.model, ...flags };
    return subharnessCommand(subharnessDeps(deps), 'subharness.memory', given);
  }
  if (isAgent) {
    if (text(args.provider) !== '') return refuse('an agent takes no --provider');
    if (text(args.model) === '') return refuse('name the model: /model set <agent> <model>');
    const given = { agent: args.role, model: args.model, ...flags };
    return subharnessCommand(subharnessDeps(deps), 'subharness.model', given);
  }
  const hasFlags = text(args.provider) !== '' || text(args.effort) !== '';
  if (hasFlags && deps.keys?.enabled() !== true) return refuse('--provider and --effort need the keys of keys.json');
  return null;
}

/** The native blocks of `/usage`. A failed read costs this section alone, and its error text can hold a value, so it stays out. */
async function nativeUsage(deps: ConsoleDeps): Promise<Array<string>> {
  if (deps.backendUsage === undefined) return [];
  try {
    return ['', 'backend accounts:', ...usageLines(await deps.backendUsage(), deps.now())];
  } catch {
    return ['', 'backend accounts: could not be read'];
  }
}

/** `/model sources`: what can serve a role, as JSON for the chooser. It sends no model request and no key value leaves. */
async function modelSources(deps: ConsoleDeps, args: Record<string, unknown>): Promise<Answer> {
  const role = text(args.role);
  if (!modelRoleRegistry().some((one) => one.role === role))
    return { text: `/model sources: ${role} is no model role`, status: 'invalid' };
  const key = deps.roleKey?.(role) ?? null;
  const read = await roleSources(
    {
      privateDir: deps.privateDir,
      fetch: deps.subharness?.fetch ?? fetch,
      baseUrl: deps.subharness?.baseUrl ?? DEFAULT_BASE_URL,
      openRouterKey: key?.value ?? null,
      openRouterKeyName: key?.name ?? null,
      ...(deps.subharness?.helpOf === undefined ? {} : { helpOf: deps.subharness.helpOf }),
    },
    role
  );
  return { text: JSON.stringify(read), status: 'ok' };
}

/** The answer of a `/model` command that has its own path, or null for the ones that go on down the console. */
function modelCommand(deps: ConsoleDeps, name: string, args: Record<string, unknown>): Promise<Answer> | null {
  if (name === 'model.sources') return modelSources(deps, args);
  return name === 'model.set' ? modelSetElsewhere(deps, args) : null;
}

/** `/services`: the family's one handler, over the core's hot settings and its clocks. */
function serviceRun(
  deps: ConsoleDeps,
  config: () => unknown,
  name: string,
  args: Record<string, unknown>
): Promise<Answer> {
  const { privateDir, dataDir, wakeClock } = deps;
  const now = (): number => deps.now();
  const given = {
    rootDir: ENGINE_ROOT,
    privateDir,
    dataDir,
    config,
    now,
    env: process.env,
    run: deps.serviceManager ?? spawnRun,
    coreUp: true,
  };
  return serviceFamily(wakeClock === undefined ? given : { ...given, wakeClock }, name, args);
}

/** The place a command addresses: the one it names, else the only one there is, else none. */
function placeOf(deps: Pick<ConsoleDeps, 'places'>, args: Record<string, unknown>): string | null {
  const named = text(args.place);
  if (named !== '') return named;
  const places = deps.places();
  return places.length === 1 ? (places[0] ?? null) : null;
}

/** The answer to a command that needs a place and named none: the places it can name. */
function placeChoices(deps: Pick<ConsoleDeps, 'places'>): string {
  const places = deps.places();
  return places.length === 0
    ? 'no place is served yet; name one with --place <id>'
    : `name a place with --place <id>: ${places.join(', ')}`;
}

/** The context of an operation the owner runs from the console (src/tools/types.ts#OpContext.asOwner). */
function ownerContextOf(
  deps: Pick<ConsoleDeps, 'places'>,
  requester: { id: string },
  args: Record<string, unknown>
): Record<string, unknown> {
  return { placeId: placeOf(deps, args), accountId: requester.id, roleIds: [], actor: 'owner', asOwner: true };
}

export function createConsole(deps: ConsoleDeps): {
  run(name: string, args: Record<string, unknown>, requester: { id: string }, dialog?: Dialog | null): Promise<Answer>;
} {
  const config = (): unknown => objOf(deps.hot).config;
  // The read connection is a DatabaseSync (src/memory/db/open.ts), null while the database is closed.
  const database = (): DatabaseSync | null => (callMethod(deps.memoryDb, 'database') as DatabaseSync | null) ?? null;
  const replyDurations = (): Array<number> =>
    listOf(callMethod(deps.metrics, 'samples', 'reply', 24)).filter((ms): ms is number => typeof ms === 'number');
  const memoryFile = (): string => {
    const file = objOf(objOf(config()).memoryDb).file;
    return path.join(deps.dataDir, typeof file === 'string' && file !== '' ? file : 'memory.db');
  };

  const ownerContext = (requester: { id: string }, args: Record<string, unknown> = {}): Record<string, unknown> =>
    ownerContextOf(deps, requester, args);

  /** One operation as the owner, its result as an answer. */
  async function op(
    name: string,
    opName: string,
    opArgs: Record<string, unknown>,
    args: Record<string, unknown>,
    requester: { id: string }
  ): Promise<Answer> {
    const context = ownerContext(requester, args);
    const result = await deps.runOp(opName, opArgs, context);
    if (result.code === PLACE_REQUIRED_CODE)
      return { text: `${typed(name, args)}: ${placeChoices(deps)}`, status: result.status };
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
    if (part === '' || part === 'server')
      parts.push(await serverHealth(systemProbe(settings, deps.dataDir, deps.serviceManager), { now }));
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

  function usage(window: string, keys: string, native: ReadonlyArray<string>): Answer {
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
        ...native,
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
      const state = granted.has(tool) ? 'granted' : '-';
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
    if (kind === 'user' && id !== undefined) return { command, accountId: id };
    const self = deps.selfId();
    if (self === null) return refused(name, args, 'no interface has said who the persona is yet', 'failed');
    return { command, accountId: self };
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
    pause: () => ['bot.pause', {}],
    resume: () => ['bot.resume', {}],
    'config.set': (args) => ['config.set', { path: args.path, value: args.value }],
    'config.unset': (args) => ['config.unset', { path: args.path }],
    'model.show': () => ['model.show', {}],
    'model.set': (args) => ['model.set', { role: args.role, id: args.model }],
    'routes.list': () => ['route.list', {}],
    'routes.set': (args) => [
      'route.set',
      {
        model: args.model,
        providers: args.providers,
        role: anyRole(args.role),
        fallbacks: args.fallbacks === undefined ? undefined : args.fallbacks === 'true',
        byok: args.byok,
      },
    ],
    'routes.remove': (args) => ['route.remove', { model: args.model, role: anyRole(args.role) }],
    'memory.profile': (args) => ['memory.profile.read', { accountId: args.user, section: args.section }],
    'memory.recent': () => ['memory.recent.read', {}],
    'memory.affinity': (args) => ['memory.affinity.read', { accountId: args.user }],
    'memory.search': (args) => ['memory.search', { question: args.query }],
    'memory.restore': (args) => ['memory.restore', { itemId: args.id }],
    'memory.journal': (args) => ['memory.journal.read', args.day === undefined ? {} : { day: args.day }],
    'memory.private': (args) => ['memory.private.read', { accountId: args.user }],
    'memory.archive': (args) => ['memory.archive.read', args.kind === undefined ? {} : { kind: args.kind }],
    'memory.server': () => ['memory.server.read', {}],
    'memory.lore.add': (args) => ['lore.add', { title: args.title, keys: args.keys, text: args.text }],
    'memory.lore.list': (args) => ['lore.list', { query: args.query }],
    'memory.lore.show': (args) => ['lore.show', { id: args.id }],
    'memory.lore.remove': (args) => ['lore.remove', { id: args.id }],
    'memory.aliases.add': (args) => ['alias.add', { accountId: args.user, name: args.name }],
    'memory.aliases.remove': (args) => ['alias.remove', { accountId: args.user, name: args.name }],
    'memory.lessons.add': (args) => ['learning.add', { text: args.text }],
    'memory.lessons.remove': (args) => ['learning.remove', { id: Number(args.id) }],
    'rules.add': (args) => ['rule.add', { text: args.text }],
    'rules.list': () => ['rule.list', {}],
    'rules.remove': (args) => ['rule.remove', { number: Number(args.number) }],
    'tools.describe': (args) => ['tools.describe', { name: args.tool }],
  };

  async function run(name: string, args: Record<string, unknown>, requester: { id: string }): Promise<Answer> {
    const part = DOCTOR_PARTS[name];
    if (part !== undefined) return health(part);
    switch (name) {
      case 'status.full':
        return statusFull(requester);
      case 'doctor.live':
        return doctorLive(requester);
      case 'usage':
        return usage(text(args.window), await keyLimits(requester), await nativeUsage(deps));
      case 'intentions.show':
        return intentionShow(name, args, requester);
      case 'config.get':
        return configGet(name, args);
      case 'memory.backup':
        return memoryBackup(name, args);
      case 'memory.conversation':
        return memoryConversation(args);
      case 'memory.lessons.list':
        return ownerRead(name, args, () => deps.ownerReads.lessons(ownerContext(requester, args)));
      case 'memory.aliases.list':
        return ownerRead(name, args, () =>
          deps.ownerReads.aliases({ accountId: args.user }, ownerContext(requester, args))
        );
      case 'tools.list':
        return toolsList();
      case 'tools.grant':
      case 'tools.revoke': {
        const given = grantArgs(name, args);
        if ('status' in given && typeof given.status === 'string') return given as Answer;
        return op(name, name === 'tools.grant' ? 'access.grant' : 'access.revoke', given, args, requester);
      }
      case 'interfaces.command':
        return refused(name, args, `the interface ${text(args.name)} has no commands of its own`);
      default: {
        const read = LOCAL_CONFIG_READS[name];
        if (read !== undefined) return read(deps.privateDir);
        const operation = OPERATIONS[name];
        if (operation === undefined) return refused(name, args, 'no such command; type /help');
        const [opName, opArgs] = operation(args);
        return op(name, opName, opArgs, args, requester);
      }
    }
  }

  // `/skills`, `/subharness`, `/agent mode`, `/simulation` and `/interfaces token set` have a module of their own; every other
  // command is answered above.
  return {
    run: (name, args, requester, dialog = null) => {
      const routed = modelCommand(deps, name, args);
      if (routed !== null) return routed;
      if (deps.keys != null && (name.startsWith(KEYS_PREFIX) || (name === 'model.set' && deps.keys.enabled())))
        return deps.keys.run(name, args, dialog);
      if (name.startsWith('mirror.')) return mirrorCommand(deps.mirrors, name, args, requester);
      const owned = ownCommand(deps, name, args, dialog);
      if (owned !== null) return owned;
      if (name.startsWith(SERVICE_PREFIX)) return serviceRun(deps, config, name, args);
      if (name === 'logs.watcher') return serviceRun(deps, config, 'service.watcher.report', args);
      if (name.startsWith(SKILLS_PREFIX)) return skillsCommand(deps.skills, name, args);
      if (isSubharnessCommand(name)) return subharnessCommand(subharnessDeps(deps), name, args);
      if (name.startsWith(SIMULATION_PREFIX)) return simulationCommand(deps.privateDir, name, args);
      if (name === 'interfaces.token.set')
        return setInterfaceToken({ privateDir: deps.privateDir, iface: text(args.name), dialog });
      return run(name, args, requester);
    },
  };
}
