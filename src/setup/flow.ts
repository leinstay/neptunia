// The one setup flow a chat launch enters when readiness finds a gap (bin/neptunia.ts): it runs the step of the first
// incomplete requirement, reads the health again, and goes on until nothing is missing. Only what is incomplete runs. A
// cancelled or failed step stops the flow there, and a step that said done with its gap still open stops it too, so a
// provider that keeps refusing never spins it. Answers a step remembers wait in `<data>/setup/answers.json` for the next
// launch and go once the flow ends ready. A step never remembers a secret.
//
// `setupFlowSteps` holds the real steps, for a chat launch at a terminal. Each mends its one gap: the identity with no
// core, the whole install only while no unit is there, a stopped core by starting it, and the core model through the same
// commands as the chat, which record their check. A broken config, a refused token or a memory that is down have a repair
// no step can do for the owner, so their step fails with that repair and changes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { createKeyStore } from '../keys/store.ts';
import { CLI_CLIENT, OWNER_CLIENT, provisionClients } from './clients.ts';
import type { Ask } from './mechanics.ts';
import { REPAIRS, REQUIREMENTS, evaluateReadiness } from './readiness.ts';
import type { LinkAsk, ReadinessHealth, Requirement } from './readiness.ts';
import { coreStep, runSetup } from './run.ts';
import type { SetupDeps, SetupOptions } from './run.ts';

export type FlowContext = {
  ask: Ask;
  remember(key: string, value: string): void;
  remembered(key: string): string | null;
};

/** What a step came to: `done` is a claim the flow checks against the health. */
export type FlowStep = (context: FlowContext) => Promise<'done' | 'cancelled' | { failed: string }>;

export type SetupFlowDeps = {
  dataDir: string;
  health(): Promise<ReadinessHealth>;
  steps: Readonly<Record<Requirement, FlowStep>>;
  ask: Ask;
};

export type FlowOutcome = {
  status: 'ready' | 'cancelled' | 'failed';
  at: Requirement | null;
  detail: string;
};

const answersFile = (dataDir: string): string => path.join(dataDir, 'setup', 'answers.json');

function readAnswers(dataDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(answersFile(dataDir), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  } catch {
    // No answers yet, or a torn file: the steps ask again.
    return {};
  }
}

function contextOf({ dataDir, ask }: SetupFlowDeps): FlowContext {
  return {
    ask,
    remember(key, value) {
      const file = answersFile(dataDir);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${JSON.stringify({ ...readAnswers(dataDir), [key]: value })}\n`, { mode: 0o600 });
    },
    remembered: (key) => readAnswers(dataDir)[key] ?? null,
  };
}

export async function runSetupFlow(deps: SetupFlowDeps): Promise<FlowOutcome> {
  const context = contextOf(deps);
  const tried = new Set<Requirement>();
  // Each requirement runs at most once, so the walk ends; one read more sees what the last step did.
  for (let round = 0; round <= REQUIREMENTS.length; round += 1) {
    const readiness = evaluateReadiness(await deps.health());
    const at = readiness.first;
    if (at === null) {
      fs.rmSync(answersFile(deps.dataDir), { force: true });
      return { status: 'ready', at: null, detail: '' };
    }
    if (tried.has(at)) return { status: 'failed', at, detail: readiness.failed[0]?.repair ?? '' };
    tried.add(at);
    const outcome = await deps.steps[at](context);
    if (outcome === 'cancelled') return { status: 'cancelled', at, detail: '' };
    if (outcome !== 'done') return { status: 'failed', at, detail: outcome.failed };
  }
  return { status: 'failed', at: null, detail: 'the setup flow did not settle' };
}

const MODEL_ANSWER = 'core-model.model';

const failedWith =
  (repair: string): FlowStep =>
  () =>
    Promise.resolve({ failed: repair });

/** The core's command answered: done, or failed with its words. */
async function commanded(askCore: LinkAsk, command: Parameters<LinkAsk>[0]): Promise<'done' | { failed: string }> {
  const answer = await askCore(command);
  return answer.status === 'ok' ? 'done' : { failed: answer.text };
}

/** The first core key, whose command asks for the models too; or the model of the core role, checked before it is saved. */
async function coreModelStep(options: SetupOptions, askCore: LinkAsk, context: FlowContext) {
  if (createKeyStore({ privateDir: options.privateDir }).coreNames().length === 0) {
    const name = (await context.ask('The name of the first core key:', 'core-1')).trim();
    if (name === '') return 'cancelled';
    return commanded(askCore, { name: 'keys.core.add', args: { name } });
  }
  const offered = context.remembered(MODEL_ANSWER);
  const model = (
    await context.ask('The core model, as OpenRouter names it (blank checks the one set):', offered)
  ).trim();
  if (model === '') return commanded(askCore, { name: 'keys.check', args: { role: 'core' } });
  context.remember(MODEL_ANSWER, model);
  return commanded(askCore, { name: 'model.set', args: { role: 'core', model } });
}

export function setupFlowSteps(
  options: SetupOptions,
  deps: SetupDeps & { askCore: LinkAsk }
): Readonly<Record<Requirement, FlowStep>> {
  return {
    'cli-identity': () => {
      provisionClients(options.privateDir, [CLI_CLIENT, OWNER_CLIENT]);
      return Promise.resolve('done');
    },
    'local-config': failedWith(REPAIRS['config-invalid']),
    services: async () => {
      // The chat comes after the flow ends, so setup's own does not open here.
      const report = await runSetup(options, { ...deps, openChat: () => Promise.resolve() });
      const stopped = report.steps.find((one) => one.state === 'failed');
      return stopped === undefined ? 'done' : { failed: `${stopped.step}: ${stopped.detail}` };
    },
    'core-running': async () => {
      const outcome = await coreStep(options, deps);
      return outcome.state === 'failed' ? { failed: outcome.detail } : 'done';
    },
    'cli-link': failedWith(REPAIRS['token-rejected']),
    'core-model': (context) => coreModelStep(options, deps.askCore, context),
    memory: failedWith(REPAIRS['memory-writer-down']),
  };
}
