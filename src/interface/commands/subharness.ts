// The owner's `/subharness`, `/agent mode` and `/simulation` commands: what the console (console.ts) runs for
// `subharness.*`, `agent.mode` and `simulation.*` over keys.json (src/subharness/, src/simulation/). A refused change answers `failed` with the command as
// the owner typed it and the reason; a change answers `ok` with what it did. The text is for the owner alone, carries a
// key's name and never its value, and never reaches a request. Only the owner's chat reaches the console, so a mode is
// never changed by an agent.

import { accountCommand } from '../../subharness/account.ts';
import type { AccountAction } from '../../subharness/account.ts';
import { agentPaths, setAgentMode, setAgentModel, statusText, subharnessView } from '../../subharness/control.ts';
import { memoryPath, memoryPathText, setMemoryPath } from '../../subharness/memory-path.ts';
import { memoryGaps } from '../../subharness/memory-writer.ts';
import {
  SUBSCRIPTION_ROLES,
  clearSubscriptionPath,
  setSubscriptionPath,
  subscriptionPath,
  subscriptionPathText,
} from '../../subharness/subscription-path.ts';
import type { SubscriptionRole } from '../../subharness/subscription-path.ts';
import type { EnableDeps, SubharnessAgent, SubharnessResult } from '../../subharness/control.ts';
import { disableSimulation, enableSimulation, simulationStatus } from '../../simulation/key.ts';

/** An answer: its text and status, and on a refused change the code that says why. */
export type SubharnessAnswer = { text: string; status: string; code?: string };

/** What the core hands the console for a model selection: the run and the fetch of the check, and the unit hook. */
export type ConsoleSubharness = Omit<EnableDeps, 'privateDir'>;

/**
 * The deps of `subharnessCommand` over a console's private directory. Without a runner the check cannot run: a selection
 * then finds a runner that throws, and the command answers `failed` before anything is saved.
 */
export function subharnessDeps(console: { privateDir: string; subharness?: ConsoleSubharness }): EnableDeps {
  const given = console.subharness;
  const unavailable = (): never => {
    throw new Error('no backend runner');
  };
  return { runBackend: unavailable, fetch: unavailable, ...given, privateDir: console.privateDir };
}

/** The command as the owner typed it. */
function typedOf(name: string, args: Readonly<Record<string, unknown>>): string {
  const words = ['/' + name.replaceAll('.', ' ')];
  for (const [key, value] of Object.entries(args))
    if (typeof value === 'string' && value !== '')
      words.push(key === 'key' || key === 'effort' || key === 'provider' ? `--${key} ${value}` : value);
  return words.join(' ');
}

const failed = (name: string, args: Readonly<Record<string, unknown>>, why: string): SubharnessAnswer => ({
  text: `${typedOf(name, args)}: ${why}`,
  status: 'failed',
});

/** A result as an answer: `ok` with its message, or `failed` with the command as typed. */
function answerOf(name: string, args: Readonly<Record<string, unknown>>, result: SubharnessResult): SubharnessAnswer {
  return result.ok
    ? { text: result.message, status: 'ok' }
    : { ...failed(name, args, result.message), code: result.code };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** An agent's source, model, effort and provider pin, after one reply from it; with no `--via` the source stays. */
async function agentModel(
  deps: EnableDeps,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  const effort = text(args.effort);
  const via = text(args.via);
  const provider = text(args.provider);
  try {
    const result = await setAgentModel(
      deps,
      text(args.agent),
      text(args.model),
      effort === '' ? undefined : effort,
      via === '' ? undefined : via,
      provider === '' ? undefined : provider
    );
    return answerOf(name, args, result);
  } catch {
    return failed(name, args, 'the check cannot run here: this core has no backend runner');
  }
}

/** The memory row of the status: the path, marked when its source cannot run now. */
function memoryRow(privateDir: string, sources: Awaited<ReturnType<typeof subharnessView>>['sources']): string {
  const path = memoryPath(privateDir);
  if (path.kind === 'direct') return `  memory  ${memoryPathText(path)}`;
  const state = sources.find((one) => one.backend === path.backend);
  const unavailable = state === undefined || state.available ? '' : '  unavailable';
  const gaps = memoryGaps(path.backend).map((gap) => `  no ${gap} control`);
  return `  memory  ${memoryPathText(path)}${unavailable}${gaps.join('')}`;
}

/** The row of the core's or the simulation's route, marked when its source cannot run now; Codex has no thinking control. */
function routeRow(
  privateDir: string,
  role: SubscriptionRole,
  sources: Awaited<ReturnType<typeof subharnessView>>['sources']
): string {
  const path = subscriptionPath(privateDir, role);
  if (path.kind === 'api') return `  ${role}  ${subscriptionPathText(path)}`;
  const state = sources.find((one) => one.backend === path.backend);
  const unavailable = state === undefined || state.available ? '' : '  unavailable';
  const gap = path.backend === 'codex' ? '  no thinking control' : '';
  return `  ${role}  ${subscriptionPathText(path)}${unavailable}${gap}`;
}

/** `subharness.status`: the sources, every agent's line, her memory writer's path, then the core's and the simulation's. */
async function statusOf(privateDir: string): Promise<string> {
  const view = await subharnessView(privateDir);
  const routes = SUBSCRIPTION_ROLES.map((role) => routeRow(privateDir, role, view.sources));
  return [statusText(view, agentPaths(privateDir)), memoryRow(privateDir, view.sources), ...routes].join('\n');
}

const isSubscriptionRole = (value: unknown): value is SubscriptionRole =>
  SUBSCRIPTION_ROLES.some((role) => role === value);

/**
 * The core's or the simulation's route: through a backend after one reply on its model and effort, or, for the
 * simulation with no backend, back to the API.
 */
async function subscriptionRoute(
  deps: EnableDeps,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  const role = args.role;
  if (!isSubscriptionRole(role)) return failed(name, args, `use ${SUBSCRIPTION_ROLES.join(' or ')}`);
  const backend = text(args.backend);
  if (backend === '') return answerOf(name, args, clearSubscriptionPath(deps.privateDir, role));
  const effort = text(args.effort);
  try {
    const result = await setSubscriptionPath(deps, role, backend, text(args.model), effort === '' ? undefined : effort);
    return answerOf(name, args, result);
  } catch {
    return failed(name, args, 'the check cannot run here: this core has no backend runner');
  }
}

/** The memory writer's path through a backend, after one reply on its model and effort. */
async function memoryWriterPath(
  deps: EnableDeps,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  const effort = text(args.effort);
  try {
    const result = await setMemoryPath(deps, text(args.backend), text(args.model), effort === '' ? undefined : effort);
    return answerOf(name, args, result);
  } catch {
    return failed(name, args, 'the check cannot run here: this core has no backend runner');
  }
}

/** `agent.mode`: shows or sets the mode, and a change goes into the agent's unit when `deps.applyMode` is there. */
async function agentMode(
  deps: EnableDeps,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  const agent = text(args.agent);
  const mode = text(args.mode);
  const result = await setAgentMode(deps.privateDir, agent, mode === '' ? undefined : mode);
  if (!result.ok || !result.changed || result.mode === null || deps.applyMode === undefined)
    return answerOf(name, args, result);
  const unit = await deps.applyMode(agent as SubharnessAgent, result.mode);
  return { text: unit === null ? result.message : `${result.message}. ${unit}`, status: 'ok' };
}

/** The dotted name of an account command, read: its backend and action, null for any other name. */
export function accountRequest(name: string): { backend: string; action: AccountAction } | null {
  const match = /^subharness\.([a-z]+)\.(login|status|logout)$/.exec(name);
  return match === null ? null : { backend: match[1] ?? '', action: match[2] as AccountAction };
}

/**
 * An account command in the core: no terminal is attached and nothing is installed from here, so a vendor's login
 * answers the command to type in a shell, and opencode's, which names a key, goes through.
 */
async function accountInCore(
  privateDir: string,
  request: { backend: string; action: AccountAction },
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  const key = text(args.key);
  const {
    status,
    code,
    text: said,
  } = await accountCommand(
    {
      privateDir,
      hostEnv: process.env,
      ask: null,
      install: () => Promise.reject(new Error('the core installs nothing')),
    },
    request.backend,
    request.action,
    key === '' ? {} : { key }
  );
  return { status, code, text: said };
}

/**
 * Runs `subharness.<sub>` and `agent.mode`. `deps` is null while the core has no subharness to give: every command then
 * answers `failed`.
 */
export async function subharnessCommand(
  deps: EnableDeps | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  if (deps == null) return failed(name, args, 'the subharness is not available here');
  const privateDir = deps.privateDir;
  const account = accountRequest(name);
  if (account !== null) return accountInCore(privateDir, account, args);
  switch (name) {
    case 'subharness.status':
      return { text: await statusOf(privateDir), status: 'ok' };
    case 'subharness.memory':
      return memoryWriterPath(deps, name, args);
    case 'subharness.subscription':
      return subscriptionRoute(deps, name, args);
    case 'subharness.model':
      return agentModel(deps, name, args);
    case 'agent.mode':
      return agentMode(deps, name, args);
    default:
      return failed(name, args, 'no such command; type /help');
  }
}

/** Runs `simulation.<sub>` over the private directory's keys.json. */
export function simulationCommand(
  privateDir: string,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  switch (name) {
    case 'simulation.status': {
      const { on, key } = simulationStatus(privateDir);
      return Promise.resolve({
        text: on ? `simulation: on, key ${key ?? ''}` : 'simulation: off (the paid scripts refuse to run)',
        status: 'ok',
      });
    }
    case 'simulation.enable':
      return Promise.resolve(answerOf(name, args, enableSimulation(privateDir, text(args.key))));
    case 'simulation.disable':
      return Promise.resolve(answerOf(name, args, disableSimulation(privateDir)));
    default:
      return Promise.resolve(failed(name, args, 'no such command; type /help'));
  }
}
