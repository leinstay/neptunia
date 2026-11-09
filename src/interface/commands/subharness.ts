// The owner's `/subharness` and `/agent mode` commands: what the console (console.ts) runs for `subharness.*` and
// `agent.mode` over the routing of config.json (src/subharness/routing.ts). A refused change answers `failed` with the command as
// the owner typed it and the reason; a change answers `ok` with what it did. The text is for the owner alone, carries a
// key's name and never its value, and never reaches a request. Only the owner's chat reaches the console, so a mode is
// never changed by an agent.

import { accountCommand } from '../../subharness/account.ts';
import type { AccountAction } from '../../subharness/account.ts';
import { agentPaths, setAgentMode, setAgentModel, statusText, subharnessView } from '../../subharness/control.ts';
import { harnessPathOf, memoryPathText } from '../../subharness/memory-path.ts';
import { memoryGaps } from '../../subharness/memory-writer.ts';
import type { EnableDeps, SubharnessAgent, SubharnessResult } from '../../subharness/control.ts';

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

type Sources = Awaited<ReturnType<typeof subharnessView>>['sources'];

/**
 * The row of her core or her memory writer: the first route of its chain as a path, marked when its source cannot run
 * now. The memory writer's row names the controls its backend lacks, and Codex has no thinking control for the core.
 */
function pathRow(privateDir: string, role: 'core' | 'memory', sources: Sources): string {
  const path = harnessPathOf(privateDir, role);
  if (path.kind === 'direct') return `  ${role}  ${memoryPathText(path)}`;
  const state = sources.find((one) => one.backend === path.backend);
  const unavailable = state === undefined || state.available ? '' : '  unavailable';
  const gaps =
    role === 'memory'
      ? memoryGaps(path.backend).map((gap) => `  no ${gap} control`)
      : path.backend === 'codex'
        ? ['  no thinking control']
        : [];
  return `  ${role}  ${memoryPathText(path)}${unavailable}${gaps.join('')}`;
}

/** `subharness.status`: the sources, every agent's line, her memory writer's path, then the core's route. */
async function statusOf(privateDir: string): Promise<string> {
  const view = await subharnessView(privateDir);
  return [
    statusText(view, agentPaths(privateDir)),
    pathRow(privateDir, 'memory', view.sources),
    pathRow(privateDir, 'core', view.sources),
  ].join('\n');
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
    case 'subharness.model':
      return agentModel(deps, name, args);
    case 'agent.mode':
      return agentMode(deps, name, args);
    default:
      return failed(name, args, 'no such command; type /help');
  }
}
