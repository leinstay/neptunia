// The owner's `/subharness` and `/simulation` commands: what the console (console.ts) runs for `subharness.*` and
// `simulation.*` over keys.json (src/subharness/, src/simulation/). A refused change answers `failed` with the command as
// the owner typed it and the reason; a change answers `ok` with what it did. The text is for the owner alone, carries a
// key's name and never its value, and never reaches a request. Only the owner's chat reaches the console, so a mode is
// never changed by an agent.

import {
  agentModels,
  agentPaths,
  disableSubharness,
  enableSubharness,
  setAgentMode,
  setAgentModel,
  statusText,
  subharnessView,
  useBackend,
} from '../../subharness/control.ts';
import type { Dialog } from '../../keys/commands.ts';
import { answerEnable, startEnable } from '../../subharness/enable-dialog.ts';
import { memoryPath, memoryPathText, setMemoryPath } from '../../subharness/memory-path.ts';
import type { EnableDeps, SubharnessAgent, SubharnessResult } from '../../subharness/control.ts';
import { disableSimulation, enableSimulation, simulationStatus } from '../../simulation/key.ts';

/** An answer: its text and status, and the question when the status is `ask` (src/subharness/ask.ts). */
export type SubharnessAnswer = {
  text: string;
  status: string;
  dialogId?: string;
  prompt?: string;
  choices?: Array<string>;
};

/** What the core hands the console for `/subharness enable`: the run and the fetch of the check, and the unit hook. */
export type ConsoleSubharness = Omit<EnableDeps, 'privateDir'>;

/**
 * The deps of `subharnessCommand` over a console's private directory. Without a runner the check cannot run: `enable`
 * then finds a runner that throws, and the command answers `failed` before anything starts.
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
    if (key !== 'dialogId' && key !== 'answer' && typeof value === 'string' && value !== '')
      words.push(key === 'key' || key === 'effort' ? `--${key} ${value}` : value);
  return words.join(' ');
}

const failed = (name: string, args: Readonly<Record<string, unknown>>, why: string): SubharnessAnswer => ({
  text: `${typedOf(name, args)}: ${why}`,
  status: 'failed',
});

/** A result as an answer: `ok` with its message, or `failed` with the command as typed. */
function answerOf(name: string, args: Readonly<Record<string, unknown>>, result: SubharnessResult): SubharnessAnswer {
  return result.ok ? { text: result.message, status: 'ok' } : failed(name, args, result.message);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `subharness.model`: an agent's model, and its effort when given, after one reply from it. */
async function agentModel(
  deps: EnableDeps,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SubharnessAnswer> {
  const effort = text(args.effort);
  try {
    const result = await setAgentModel(deps, text(args.agent), text(args.model), effort === '' ? undefined : effort);
    return answerOf(name, args, result);
  } catch {
    return failed(name, args, 'the check cannot run here: this core has no backend runner');
  }
}

/** `subharness.enable`: the check, and in the core the dialog of the agents' models, before the backend is stored. */
async function enable(
  deps: EnableDeps,
  name: string,
  args: Readonly<Record<string, unknown>>,
  dialog: Dialog | null
): Promise<SubharnessAnswer> {
  const key = text(args.key);
  try {
    if (!deps.asksModels)
      return answerOf(name, args, await enableSubharness(deps, text(args.backend), key === '' ? undefined : key));
    const given = text(args.dialogId);
    const next =
      given === ''
        ? await startEnable(deps, text(args.backend), key === '' ? undefined : key)
        : await answerEnable(deps, given, text(args.answer));
    if (dialog === null) return 'dialogId' in next ? next : answerOf(name, args, next);
    // The link's dialog carries the questions: an answer of the chat reaches the command waiting here.
    let step = next;
    while ('dialogId' in step) {
      const answer = await dialog.ask(step.prompt, step.choices === undefined ? {} : { choices: step.choices });
      step = await answerEnable(deps, step.dialogId, answer);
    }
    return answerOf(name, args, step);
  } catch {
    return failed(name, args, 'the check cannot run here: this core has no backend runner');
  }
}

/** `subharness.status`: the backends, every agent's line, and last her memory writer's path. */
async function statusOf(privateDir: string): Promise<string> {
  const agents = statusText(await subharnessView(privateDir), agentModels(privateDir), agentPaths(privateDir));
  return `${agents}\n  memory  ${memoryPathText(memoryPath(privateDir))}`;
}

/** `subharness.memory`: the memory writer's path through a backend, after one reply on its model and effort. */
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

/**
 * Runs `subharness.<sub>`. `deps` is null while the core has no subharness to give: every command then answers `failed`.
 * A mode change also puts the mode into the agent's unit when `deps.applyMode` is there.
 */
export async function subharnessCommand(
  deps: EnableDeps | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>,
  dialog: Dialog | null = null
): Promise<SubharnessAnswer> {
  if (deps == null) return failed(name, args, 'the subharness is not available here');
  const privateDir = deps.privateDir;
  switch (name) {
    case 'subharness.status':
      return { text: await statusOf(privateDir), status: 'ok' };
    case 'subharness.memory':
      return memoryWriterPath(deps, name, args);
    case 'subharness.enable':
      return enable(deps, name, args, dialog);
    case 'subharness.model':
      return agentModel(deps, name, args);
    case 'subharness.use':
      return answerOf(name, args, await useBackend(privateDir, text(args.agent), text(args.backend)));
    case 'subharness.disable':
      return answerOf(name, args, await disableSubharness(privateDir, text(args.backend)));
    case 'subharness.mode': {
      const agent = text(args.agent);
      const mode = text(args.mode);
      const result = await setAgentMode(privateDir, agent, mode === '' ? undefined : mode);
      if (!result.ok || !result.changed || result.mode === null || deps.applyMode === undefined)
        return answerOf(name, args, result);
      const unit = await deps.applyMode(agent as SubharnessAgent, result.mode);
      return { text: unit === null ? result.message : `${result.message}. ${unit}`, status: 'ok' };
    }
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
