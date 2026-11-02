// The mechanics step of `neptunia setup` (src/setup/run.ts, docs/setup.md): her three ticking mechanics, `heartbeat`,
// `selfreflection` and `selfimprovement`, each switched on or off at the terminal, and the time of day of the daily
// selfimprovement wake (`selfimprovement.at`). Each question offers the value in force, so an empty answer keeps it.
// `selfimprovement` on needs a connected subharness backend, `selfimprovement.repository` and a push right to it
// through her gh login (src/selfimprovement/repository.ts); without them it is stored off and the step is `refused`.
// The answers go into `<private>/config.local/config.json`, every other key kept, and nothing is written when no
// answer changes a value. The watcher step (src/setup/watcher.ts) asks its questions through the same two helpers.

import { readConfig } from '../config.ts';
import { localConfigPath } from '../config/files.ts';
import { readLabels } from '../hot.ts';
import { readKeys } from '../keys/file.ts';
import { innerSettings } from '../behavior/inner/settings.ts';
import { checkRepository } from '../selfimprovement/repository.ts';
import type { GhRunner } from '../selfimprovement/repository.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { isClockTime } from '../time.ts';
import { objOf } from '../tools/types.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/impl/shared.ts';

/** Asks the owner at the terminal; `offered` is shown as the default and an empty answer takes it. */
export type Ask = (question: string, offered: string | null) => Promise<string>;

export type MechanicsStepDeps = { ask: Ask; gh: GhRunner };
export type MechanicsStepOutcome = { state: 'done' | 'already' | 'refused'; detail: string };

/** How many times one question is asked before the value in force is kept. */
const TRIES = 3;

/**
 * Asks `question` until the answer, trimmed and lowercased, passes `isValid`; '' takes `offered`. After three answers
 * that do not, the value in force (`offered`) is kept.
 */
async function askValid(ask: Ask, question: string, offered: string, isValid: (answer: string) => boolean) {
  for (let tried = 0; tried < TRIES; tried += 1) {
    const raw = (await ask(question, offered)).trim();
    const answer = raw === '' ? offered : raw;
    if (isValid(answer)) return answer;
  }
  return offered;
}

/** An on or off question: true for `on`, false for `off`, `current` after three answers that are neither. */
export async function askSwitch(ask: Ask, question: string, current: boolean): Promise<boolean> {
  const answer = await askValid(ask, question, current ? 'on' : 'off', (one) => /^(on|off)$/i.test(one));
  return answer.toLowerCase() === 'on';
}

/** A time of day `HH:MM` from `00:00` to `23:59`; `current` after three answers that are none. */
export function askHour(ask: Ask, question: string, current: string): Promise<string> {
  return askValid(ask, question, current, isClockTime);
}

/** What is missing for selfimprovement, in one line, or null when its checks pass. */
async function selfimprovementMissing(
  options: { rootDir: string; privateDir: string },
  config: unknown,
  gh: GhRunner
): Promise<string | null> {
  if (readKeys(options.privateDir).subharness.backends.length === 0)
    return 'selfimprovement stays off: no subharness backend is connected (setup subharness)';
  const { repository } = selfimprovementSettings(config);
  const check = await checkRepository(repository, gh, readLabels(options.rootDir, options.privateDir));
  return check.code === 'ok' ? null : `selfimprovement stays off: ${check.line}`;
}

export async function mechanicsStep(
  options: { rootDir: string; privateDir: string },
  deps: MechanicsStepDeps
): Promise<MechanicsStepOutcome> {
  const config = readConfig(options.rootDir, { privateDir: options.privateDir });
  const inForce = {
    heartbeat: objOf(config.heartbeat).enabled !== false,
    selfreflection: objOf(config.selfreflection).enabled !== false,
    selfimprovement: objOf(config.selfimprovement).enabled !== false,
    at: innerSettings(config).wakes.selfimprovement.at,
  };
  const heartbeat = await askSwitch(
    deps.ask,
    'heartbeat: her own wakes for her wishes and plans (on or off):',
    inForce.heartbeat
  );
  const selfreflection = await askSwitch(deps.ask, 'selfreflection: her diary (on or off):', inForce.selfreflection);
  let selfimprovement = await askSwitch(
    deps.ask,
    'selfimprovement: her daily look at her own work and the fixes she files (on or off):',
    inForce.selfimprovement
  );
  let at = inForce.at;
  let refusal: string | null = null;
  if (selfimprovement) {
    refusal = await selfimprovementMissing(options, config, deps.gh);
    if (refusal === null) at = await askHour(deps.ask, 'The time of her daily selfimprovement wake, HH:MM UTC:', at);
    else selfimprovement = false;
  }
  const answers = { heartbeat, selfreflection, selfimprovement };
  const changed =
    heartbeat !== inForce.heartbeat ||
    selfreflection !== inForce.selfreflection ||
    selfimprovement !== inForce.selfimprovement ||
    at !== inForce.at;
  const summary = `heartbeat ${heartbeat ? 'on' : 'off'}, selfreflection ${selfreflection ? 'on' : 'off'}, selfimprovement ${selfimprovement ? `on at ${at} UTC` : 'off'}`;
  if (changed) {
    const file = localConfigPath(options.privateDir);
    let local = readLocalConfig(file);
    for (const [name, value] of Object.entries(answers)) local = setPath(local, [name, 'enabled'], value);
    local = setPath(local, ['selfimprovement', 'at'], at);
    writeLocalConfig(file, local);
  }
  if (refusal !== null) return { state: 'refused', detail: `${refusal}; ${summary}` };
  return changed ? { state: 'done', detail: summary } : { state: 'already', detail: summary };
}
