// The mechanics step of `neptunia setup` (src/setup/run.ts, docs/setup.md): her two ticking mechanics, `heartbeat` and
// `diary`, and the humanizer, each switched on or off at the terminal. Each question offers the value in force, so an empty answer
// keeps it. The answers go into `<private>/config.local/config.json`, every other key kept, and nothing is written when
// no answer changes a value.

import { readConfig } from '../config.ts';
import { updateLocalSettings } from '../service/local-settings.ts';
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
async function askSwitch(ask: Ask, question: string, current: boolean): Promise<boolean> {
  const answer = await askValid(ask, question, current ? 'on' : 'off', (one) => /^(on|off)$/i.test(one));
  return answer.toLowerCase() === 'on';
}

export async function mechanicsStep(
  options: { rootDir: string; privateDir: string },
  deps: MechanicsStepDeps
): Promise<MechanicsStepOutcome> {
  const config = readConfig(options.rootDir, { privateDir: options.privateDir });
  const inForce = {
    heartbeat: objOf(config.heartbeat).enabled !== false,
    diary: objOf(config.diary).enabled !== false,
    humanizer: objOf(config.humanizer).enabled === true,
  };
  const heartbeat = await askSwitch(
    deps.ask,
    'heartbeat: her own wakes for her wishes and plans (on or off):',
    inForce.heartbeat
  );
  const diary = await askSwitch(deps.ask, 'diary: her diary (on or off):', inForce.diary);
  const humanizer = await askSwitch(
    deps.ask,
    'humanizer: check her longer texts and write them again before they are posted (on or off):',
    inForce.humanizer
  );
  const answers = { heartbeat, diary, humanizer };
  const changed = heartbeat !== inForce.heartbeat || diary !== inForce.diary || humanizer !== inForce.humanizer;
  const summary = `heartbeat ${heartbeat ? 'on' : 'off'}, diary ${diary ? 'on' : 'off'}, humanizer ${humanizer ? 'on' : 'off'}`;
  if (changed)
    updateLocalSettings(options.privateDir, (saved) => {
      let local = saved;
      for (const [name, value] of Object.entries(answers)) local = setPath(local, [name, 'enabled'], value);
      return local;
    });
  return changed ? { state: 'done', detail: summary } : { state: 'already', detail: summary };
}
