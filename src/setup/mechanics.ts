// The mechanics step of `neptunia setup` (src/setup/run.ts, docs/setup.md): her two ticking mechanics, `heartbeat` and
// `selfreflection`, each switched on or off at the terminal. Each question offers the value in force, so an empty answer
// keeps it. The answers go into `<private>/config.local/config.json`, every other key kept, and nothing is written when
// no answer changes a value. The watcher step (src/setup/watcher.ts) asks through `askSwitch` and `askSchedule` of this file.

import { readConfig } from '../config.ts';
import { updateLocalSettings } from '../service/local-settings.ts';
import { formatSchedule, parseSchedule } from '../service/schedule.ts';
import type { ServiceSchedule } from '../service/schedule.ts';
import { objOf } from '../tools/types.ts';
import { setPath } from '../tools/operations/shared.ts';

/** Asks the owner at the terminal; `offered` is shown as the default and an empty answer takes it. */
export type Ask = (question: string, offered: string | null) => Promise<string>;

export type MechanicsStepDeps = { ask: Ask };
export type MechanicsStepOutcome = { state: 'done' | 'already'; detail: string };

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

/** What an answer to a schedule question means: `at 06:00,18:00`, `every 6h`, or the daily times alone. */
const scheduleOfAnswer = (answer: string): ServiceSchedule | null =>
  parseSchedule(answer) ?? parseSchedule(`at ${answer}`);

/** A schedule with the validation of `neptunia services <name> setup`; `current` after three answers that are none. */
export async function askSchedule(ask: Ask, question: string, current: ServiceSchedule): Promise<ServiceSchedule> {
  const offered = formatSchedule(current);
  const answer = await askValid(ask, question, offered, (one) => scheduleOfAnswer(one) !== null);
  return scheduleOfAnswer(answer) ?? current;
}

export async function mechanicsStep(
  options: { rootDir: string; privateDir: string },
  deps: MechanicsStepDeps
): Promise<MechanicsStepOutcome> {
  const config = readConfig(options.rootDir, { privateDir: options.privateDir });
  const inForce = {
    heartbeat: objOf(config.heartbeat).enabled !== false,
    selfreflection: objOf(config.selfreflection).enabled !== false,
  };
  const heartbeat = await askSwitch(
    deps.ask,
    'heartbeat: her own wakes for her wishes and plans (on or off):',
    inForce.heartbeat
  );
  const selfreflection = await askSwitch(
    deps.ask,
    'selfreflection: her selfreflection (on or off):',
    inForce.selfreflection
  );
  const answers = { heartbeat, selfreflection };
  const changed = heartbeat !== inForce.heartbeat || selfreflection !== inForce.selfreflection;
  const summary = `heartbeat ${heartbeat ? 'on' : 'off'}, selfreflection ${selfreflection ? 'on' : 'off'}`;
  if (changed)
    updateLocalSettings(options.privateDir, (saved) => {
      let local = saved;
      for (const [name, value] of Object.entries(answers)) local = setPath(local, [name, 'enabled'], value);
      return local;
    });
  return changed ? { state: 'done', detail: summary } : { state: 'already', detail: summary };
}
