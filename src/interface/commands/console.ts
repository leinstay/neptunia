// The owner's console in the core: what runs a command of the `cli` principal once bin/neptunia.ts parsed it by the
// table (src/interface/commands/table.ts). src/interface/neptunia-cli.ts hands it every command of that principal
// but `status`, `header` and the interface switches, which it answers itself. A command whose leaf in the table
// declares an operation (`operationOf`) runs it through `runOp` with the owner's context (`asOwner`,
// src/tools/types.ts#OpContext), so the rights check passes it as the owner even before any other account is his, and the
// operation's own owner checks do too. The rest read
// what the core holds: the live config, the usage accumulator, the memory database's read connection and the reply
// metric. The console asks no model and calls no `fetch`, except the key limits of `/usage`, the probes of
// `/doctor live`, which are the status card's own reads, and the checks of the key commands (src/keys/commands.ts).
//
// Every answer is plain text with a status: `ok` when the command ran, else the operation's own (`denied`,
// `invalid`, `failed`). A refused answer starts with the command as the owner typed it, so it names the id, the tool
// or the path it refused. The text is for the owner alone and never reaches her memory or a request.

import { accountNodeOf } from '../../memory/db/person-links.ts';
import { SELF_PERSON } from '../../memory/db/ids.ts';
import type { BindConfirm, BindResult, BindTarget } from '../../memory/db/person-bind.ts';
import { nativeAuthorityOf } from '../../protocol/identity.ts';
import type { Db } from '../../memory/db/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { checkConfig } from '../../config/check.ts';
import { localConfigPath } from '../../config/files.ts';
import { CONFIG_SCHEMA } from '../../config/schema.ts';
import { coreHealth } from '../../health/core.ts';
import { memoryHealth } from '../../health/memory.ts';
import { serverHealth, systemProbe, worse } from '../../health/server.ts';
import type { HealthStatus } from '../../health/server.ts';
import type { Dialog } from '../../keys/commands.ts';
import type { Track } from '../../loop-watch.ts';
import { setInterfaceToken } from './interface-token.ts';
import { DEVELOPMENT_ROLES, ERRAND_ROLES, MEMORY_ROLE } from '../../llm/roles.ts';
import { grantedSkillNames } from '../../tools/discovery.ts';
import { ownerPersonOf } from '../../tools/operations/grants.ts';
import { ownValueAt, splitPath } from '../../tools/operations/shared.ts';
import { skillRegistry } from '../../tools/registry.ts';
import type { SkillsAccess } from '../../skills/port.ts';
import type { ConsoleSubharness } from './subharness.ts';
import { coreSelection, readCoreCheck } from '../../setup/model-check.ts';
import type { CoreReadiness } from '../../setup/readiness.ts';
import { mirrorCommand } from './mirror.ts';
import { operationOf } from './table.ts';
import type { MirrorDesk } from '../../behavior/mirror-desk.ts';
import { searchCommand } from './search.ts';
import { skillsCommand } from './skills.ts';
import { MODULE_ACTIONS, moduleCommand } from './module-setup.ts';
import type { ModuleAction } from './module-setup.ts';
import { isSetupComplete, pairAfterSetup, pairCommand } from './interfaces-pair.ts';
import type { PairCommands } from './interfaces-pair.ts';
import { isMemoryBrowserCommand, memoryBrowserCommand } from './memory.ts';
import { serviceCommand } from '../../keys/services.ts';
import { probeProxy } from '../../net/proxy.ts';
import { proxyCommand } from './proxy.ts';
import type { ProxyCommandDeps } from './proxy.ts';
import { simulationCommand, subharnessCommand, subharnessDeps } from './subharness.ts';
import { serviceFamily } from '../../service/commands.ts';
import type { WakeClock } from '../../service/commands.ts';
import type { ServiceName } from '../../service/schedule.ts';
import { spawnRun } from '../../setup/install.ts';
import type { RunManager } from '../../service/manager.ts';
import { backendOfRouteName, routeName, routeNamesText } from '../../subharness/route-names.ts';
import { SUBHARNESS_AGENTS } from '../../subharness/control.ts';
import { DEFAULT_BASE_URL } from '../../subharness/models.ts';
import { modelRoleRegistry, roleSources } from '../../subharness/model-capabilities.ts';
import { usageLines } from '../../subharness/usage.ts';
import type { BackendUsage } from '../../subharness/usage.ts';
import { callMethod, listOf, objOf } from '../../tools/types.ts';
import type { Counters, DaysSum, RoleRow } from '../../tools/operations/usage.ts';

/** One command's answer: the text the owner reads and its outcome. */
export type Answer = { text: string; status: string; code?: string };

/** An operation's result as src/tools/operations/index.ts#runOp answers it. */
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
  /** The event loop watch's `track` (src/loop-watch.ts): names the owner's long operations. */
  track?: Track;
  /** What the chat's status line reads: what the core already knows, with no probe (src/core.ts). */
  statusBrief?: () => unknown;
  /** The memory writer as its last probe left it, for `status.readiness`; `unknown` before the first. */
  memoryWriter?: () => 'ok' | 'down' | 'unknown';
  /** The memory database (src/memory/db/service.ts): `database()` is its read connection, null while it is closed. */
  memoryDb: unknown;
  /** The owner's pairing of his accounts (src/interface/owner-pairing.ts), for `/interfaces pair` and the setup's end. */
  pairing?: PairCommands | null;
  usage: { byRole(): Array<RoleRow>; sumDays(days: number): DaysSum } | null;
  /** The speed figures (src/tools/operations/metrics.ts): `samples('reply', 24)` are the reply durations of the last day. */
  metrics: unknown;
  /** A chat's newest stored lines, oldest first. */
  chatLines(chatId: string, count: number): ReadonlyArray<{ author: string; text: string }>;
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
  /** The selfreflection's mirrors (src/behavior/mirror-desk.ts); `/mirror` fails while there is none. */
  mirrors?: MirrorDesk | null;
  /** How `/services` and `/doctor server` reach the service manager, the machine's own when absent. A test always gives its own. */
  serviceManager?: RunManager;
  /** What the core knows of one of its wakes, for `/services <name> status`. */
  wakeClock?: (name: ServiceName) => WakeClock | null;
  /** The core's proxy monitor for `/proxy` (src/interface/commands/proxy.ts); absent, the route reads `off`. */
  proxy?: Pick<ProxyCommandDeps, 'route'> & Partial<Pick<ProxyCommandDeps, 'probe'>>;
};

/** The engine checkout, where the shipped interface packages and their setup contracts are. */
const PLACE_REQUIRED_CODE = 'PLACE_REQUIRED';

const ENGINE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

type OwnCommandDeps = Pick<
  ConsoleDeps,
  'dataDir' | 'hot' | 'memoryDb' | 'memoryWriter' | 'runOp' | 'statusBrief' | 'proxy' | 'pairing'
>;

/** The commands answered by a module of their own, or null for any other. */
function ownCommand(
  { dataDir, hot, memoryDb, memoryWriter, runOp, statusBrief: brief, proxy, pairing }: OwnCommandDeps,
  name: string,
  args: Record<string, unknown>,
  dialog: Dialog | null
): Promise<Answer> | null {
  if (name.startsWith('keys.service.')) return serviceCommand(dataDir, name, args, dialog);
  if (name.startsWith('proxy.'))
    return proxyCommand(
      {
        dataDir,
        probe: proxy?.probe ?? probeProxy,
        route: proxy?.route ?? (() => 'off'),
        config: () => objOf(hot).config,
      },
      name,
      args,
      dialog
    );
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
  if (name === 'memory.bind') return personLinkCommand({ memoryDb, runOp, hot }, args, dialog);
  if ((name === 'memory.users.names.add' || name === 'memory.users.names.remove') && personWord(memoryDb, args.user))
    return ownerNameCommand(memoryDb, name, args);
  const paired = pairCommand(pairing, name, args);
  if (paired !== null) return paired;
  const action = moduleActionOf(name);
  if (action === null) return null;
  const ran = moduleRun(dataDir, name, action, args, dialog);
  if (name !== 'interfaces.setup') return ran;
  const iface = text(args.name);
  const ref = { rootDir: ENGINE_ROOT, dataDir, kind: 'interface' as const, name: iface };
  return ran.then((answer) =>
    answer.status !== 'ok'
      ? answer
      : pairAfterSetup({ pairing, hot, iface, complete: isSetupComplete(ref), setupText: answer.text, dialog })
  );
}

/**
 * Whether a name command names a stored person (`person:self`, `person:<id>`, a `people` row) where it takes an account:
 * the name goes on the person. Nothing is a person while the database is closed.
 */
function personWord(memoryDb: unknown, value: unknown): boolean {
  const db = callMethod(memoryDb, 'database') as Db | null | undefined;
  return (
    typeof value === 'string' && db != null && db.prepare('SELECT 1 FROM people WHERE id = ?').get(value) !== undefined
  );
}

/**
 * `/memory users names add|remove <person> <name>` on a person: the name is written through the one writer as the owner's
 * (`author` `owner`), so it stands apart from what her memory session writes. Her own record is `person:self`.
 */
async function ownerNameCommand(memoryDb: unknown, name: string, args: Record<string, unknown>): Promise<Answer> {
  const given = typeof args.name === 'string' ? args.name.trim() : '';
  if (!given) return { text: 'a name is required', status: 'invalid' };
  const update = { op: 'owner-name', personId: args.user, name: given, remove: name.endsWith('.remove') };
  try {
    await (callMethod(memoryDb, 'writeUnit', update) as Promise<unknown>);
    return { text: `${String(args.user)}: ${update.remove ? 'removed' : 'added'} ${given}`, status: 'ok' };
  } catch {
    return { text: `/${name.replaceAll('.', ' ')}: the name could not be written`, status: 'failed' };
  }
}

/** The Y/n before a merge, naming the person it removes. */
function mergeQuestion({ removed, into }: { removed: BindTarget; into: BindTarget }): string {
  const named = (one: BindTarget): string => (one.name === null ? one.id : `${one.id} (${one.name})`);
  return `This merges ${named(removed)} into ${named(into)} and removes ${removed.id}. Merge? Y/n`;
}

/** Whether an answer to a Y/n is yes: blank, `y` or `yes`, in any case. */
const saysYes = (answer: string): boolean => ['', 'y', 'yes'].includes(answer.trim().toLowerCase());

/** The owner's words of a bind result. */
function bindAnswer(account: string, result: BindResult): Answer {
  switch (result.status) {
    case 'attached':
    case 'bound':
      return { text: `${account}: bound to ${result.person}`, status: 'ok' };
    case 'merged':
      return { text: `${account}: bound to ${result.person}; ${result.removed} merged into it`, status: 'ok' };
    case 'declined':
      return { text: `${account}: nothing changed; ${result.removed} stays`, status: 'ok' };
    case 'unconfirmed':
      return {
        text: `binding ${account} merges ${result.removed} and asks Y/n first: run it in the chat`,
        status: 'invalid',
      };
    case 'refused':
      return { text: `${account} cannot be bound there: ${result.code}`, status: 'invalid' };
    case 'failed':
      return { text: `the binding could not be written: ${result.code}`, status: 'failed' };
  }
}

/**
 * The owner's account on a raw install, while `bot.ownerPerson` names nobody: its own person becomes the owner person.
 */
async function firstOwner(
  { memoryDb, runOp }: Pick<ConsoleDeps, 'memoryDb' | 'runOp'>,
  accountId: string,
  account: string
): Promise<Answer> {
  const written = (await (callMethod(memoryDb, 'personLink', {
    op: 'bind',
    accountId,
    target: { owner: true },
  }) as Promise<unknown>)) as { person?: unknown } | null;
  const set = await runOp('config.set', { path: 'bot.ownerPerson', value: written?.person }, { asOwner: true });
  if (set.status !== 'ok') return { text: `the owner person was not set: ${set.summary}`, status: 'failed' };
  return { text: `${account}: bound`, status: 'ok' };
}

/**
 * `/memory bind <iface> <account> <person>`: the account, by its interface and platform id, binds to a meta-person,
 * `owner` naming the owner's and `self` hers (src/memory/db/person-bind.ts). A merge asks Y/n through the dialog first.
 */
async function personLinkCommand(
  { memoryDb, runOp, hot }: Pick<ConsoleDeps, 'memoryDb' | 'runOp' | 'hot'>,
  args: Record<string, unknown>,
  dialog: Dialog | null
): Promise<Answer> {
  const word = (key: string) => (typeof args[key] === 'string' ? args[key] : '');
  const account = `${word('iface')} ${word('account')}`;
  try {
    const accountId = accountNodeOf(callMethod(memoryDb, 'database') as Db, {
      interfaceId: word('iface'),
      authorityId: nativeAuthorityOf(word('iface')),
      nativeId: word('account'),
      generation: 1,
    });
    if (accountId === null)
      return { text: 'she has not met that account yet; bind it after its first message', status: 'invalid' };
    const named = word('person');
    const owner = ownerPersonOf(objOf(hot).config);
    if (named === 'owner' && owner === null) return await firstOwner({ memoryDb, runOp }, accountId, account);
    const personId = named === 'owner' ? String(owner) : named === 'self' ? SELF_PERSON : named;
    const confirm: BindConfirm | null =
      dialog === null
        ? null
        : async (question) => saysYes(await dialog.ask(mergeQuestion(question), { fallback: 'y' }));
    const result = (await (callMethod(
      memoryDb,
      'personBind',
      { accountId, personId },
      confirm
    ) as Promise<unknown>)) as BindResult;
    return bindAnswer(account, result);
  } catch {
    return { text: 'the binding could not be written', status: 'failed' };
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

/** Whether the key commands answer `name`: the `keys.` commands but `keys.service.*`, and `model.set` while `enabled()`. */
function isKeysCommand(name: string, enabled: () => boolean): boolean {
  if (name.startsWith('keys.service.')) return false;
  return name.startsWith(KEYS_PREFIX) || (name === 'model.set' && enabled());
}
/** The prefixes of `/subharness` and `/simulation`, which `subharnessCommand` and `simulationCommand` answer. */
const SUBHARNESS_PREFIX = 'subharness.';
const isSubharnessCommand = (name: string): boolean => name.startsWith(SUBHARNESS_PREFIX) || name === 'agent.mode';
const SIMULATION_PREFIX = 'simulation.';

/** How many stored lines `/memory conversation` prints. */
const CHAT_LINES = 30;

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

/** The probe lines of the status card (src/tools/operations/status.ts#probeLine) mark a failed probe so. */
const FAILED_PROBE = '· failed';

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
 * `/config check`: the private settings file against the schema (src/config/check.ts), one line per unknown key or
 * key of the wrong type.
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
  const problems = checkConfig(local, CONFIG_SCHEMA);
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

/** The four route names in the order they are told. */
const ROUTE_ORDER = ['api', 'claude', 'codex', 'opencode'] as const;

/** What takes `--via` beside the agents: the memory writer, and the core and the simulation on a subscription. */
const VIA_TARGETS: ReadonlyArray<string> = ['memory', 'core', 'simulation'];

/**
 * The answer of a `model set` with `--via`, null when the route is `direct-api` and the role goes on as with no `--via`,
 * undefined when no `--via` was typed. `--via` takes the route names (src/subharness/route-names.ts), never the stored
 * backend words.
 */
function modelSetVia(
  deps: ConsoleDeps,
  args: Record<string, unknown>,
  isAgent: boolean
): Promise<Answer> | null | undefined {
  const typedLine = `/model set ${text(args.role)}`;
  const refuse = (why: string, code?: string): Promise<Answer> =>
    Promise.resolve({ text: `${typedLine}: ${why}`, status: 'invalid', ...(code === undefined ? {} : { code }) });
  const flags = args.effort === undefined ? {} : { effort: args.effort };
  const pin = text(args.provider) === '' ? {} : { provider: args.provider };
  const typedVia = text(args.via);
  if (typedVia === '') return undefined;
  const via = backendOfRouteName(typedVia);
  if (via === null) return refuse(`${typedVia} is no route; use ${routeNamesText(ROUTE_ORDER)}`, 'unknown-backend');
  if (via === 'api') {
    if (isAgent)
      return refuse(
        `${routeName('api')} cannot run an agent; use ${routeNamesText(['claude', 'codex', 'opencode'])}`,
        'backend-unsupported'
      );
    return args.role === 'simulation'
      ? subharnessCommand(subharnessDeps(deps), 'subharness.subscription', { role: args.role })
      : null;
  }
  if (!isAgent && !VIA_TARGETS.includes(text(args.role)))
    return refuse(
      `${text(args.role)} has no subharness path; only an agent, memory, core or simulation takes --via`,
      'role-unsupported'
    );
  if (!isAgent && text(args.provider) !== '') return refuse(`${text(args.role)} takes no --provider with --via`);
  if (text(args.model) === '') return refuse(`name the model: /model set ${text(args.role)} <model> --via <route>`);
  if (isAgent)
    return subharnessCommand(subharnessDeps(deps), 'subharness.model', {
      agent: args.role,
      model: args.model,
      via,
      ...flags,
      ...pin,
    });
  const given = { backend: via, model: args.model, ...flags };
  if (args.role === 'memory') return subharnessCommand(subharnessDeps(deps), 'subharness.memory', given);
  return subharnessCommand(subharnessDeps(deps), 'subharness.subscription', { role: args.role, ...given });
}

/**
 * The answer of a `model set` that neither the key commands nor the `model.set` operation take, or null. An agent's
 * model and effort live in its subharness, checked with one reply there, and so does the memory writer's with `--via`,
 * and the subscription route of the core or the simulation. `simulation` is no model role: without `--via` it takes
 * only `direct-api` (or the older `api`), which returns it to the API. `--provider` of an agent pins its opencode run to an OpenRouter provider.
 * For any other role `--provider` and `--effort` are checked on the role's key, so they need the key commands of
 * `keys.json`.
 */
function modelSetElsewhere(deps: ConsoleDeps, args: Record<string, unknown>): Promise<Answer> | null {
  const typedLine = `/model set ${text(args.role)}`;
  const refuse = (why: string): Promise<Answer> => Promise.resolve({ text: `${typedLine}: ${why}`, status: 'invalid' });
  const isAgent = SUBHARNESS_AGENTS.some((agent) => agent === args.role);
  const flags = args.effort === undefined ? {} : { effort: args.effort };
  const pin = text(args.provider) === '' ? {} : { provider: args.provider };
  const viaAnswer = modelSetVia(deps, args, isAgent);
  if (viaAnswer !== undefined) return viaAnswer;
  if (args.role === 'simulation') {
    if (text(args.model) !== 'api' && text(args.model) !== routeName('api'))
      return refuse(
        `name a model with --via ${routeName('claude')} or --via ${routeName('codex')}, or ${routeName('api')}`
      );
    return subharnessCommand(subharnessDeps(deps), 'subharness.subscription', { role: args.role });
  }
  if (isAgent) {
    if (text(args.model) === '') return refuse('name the model: /model set <agent> <model>');
    const given = { agent: args.role, model: args.model, ...flags, ...pin };
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
    const parts: Array<{ status: HealthStatus; text: string }> = [];
    const now = deps.now();
    if (part === '' || part === 'server')
      parts.push(await serverHealth(systemProbe(deps.dataDir, deps.serviceManager), { now }));
    if (part === '' || part === 'core' || part === 'memory') {
      if (db === null) return { text: 'the memory database is not open', status: 'failed' };
      if (part !== 'memory') parts.push(coreHealth(db, { now, turnDurationsMs: replyDurations() }));
      if (part !== 'core') parts.push(memoryHealth(db, { now, days: HEALTH_DAYS }));
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
    const setting = ownValueAt(settings, splitPath(text(args.path), settings));
    if (!setting.found) return refused(name, args, 'no such setting');
    return { text: JSON.stringify(setting.value, null, 2) ?? 'null', status: 'ok' };
  }

  function memoryChat(args: Record<string, unknown>): Answer {
    const lines = deps.chatLines(text(args.conversation), CHAT_LINES);
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
      case 'memory.conversation':
        return memoryChat(args);
      case 'memory.lessons.list':
        return ownerRead(name, args, () => deps.ownerReads.lessons(ownerContext(requester, args)));
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
        const operation = operationOf(name, args);
        if (operation === null) return refused(name, args, 'no such command; type /help');
        return op(name, operation.op, operation.args, args, requester);
      }
    }
  }

  // `/skills`, `/subharness`, `/agent mode`, `/simulation` and `/interfaces token set` have a module of their own; every other
  // command is answered above.
  return {
    run: (name, args, requester, dialog = null) => {
      const routed = modelCommand(deps, name, args);
      if (routed !== null) return routed;
      if (deps.keys != null && isKeysCommand(name, () => deps.keys?.enabled() === true))
        return deps.keys.run(name, args, dialog);
      if (name.startsWith('mirror.')) return mirrorCommand(deps.mirrors, name, args, requester);
      if (isMemoryBrowserCommand(name)) return memoryBrowserCommand(deps, name, args, requester);
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
