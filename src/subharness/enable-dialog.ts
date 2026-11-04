// The dialog of `/subharness enable`: after the backend passes its check, the owner is asked, one agent at a time,
// which model it runs on. The list comes from the backend (src/subharness/models.ts) and free text is allowed. Each
// answer is checked with one reply before the next question, a refused model asks the same question again, and nothing
// is stored until the last answer: then the backend, its key's name and the four models are written together.
// An open dialog lives in the memory of the core, so a restart ends it and the owner enables again.

import { randomUUID } from 'node:crypto';
import { askAnswer } from './ask.ts';
import type { AskAnswer } from './ask.ts';
import { checkEnable, commitEnable } from './control.ts';
import type { Checked, EnableDeps, SubharnessResult } from './control.ts';
import { checkModel, listModels } from './models.ts';

/** The agents the dialog asks about, in order: the ones every deployment runs. The thinker is set with `model`. */
const ASKED_AGENTS = ['scout', 'server', 'dev', 'watcher'] as const;

/** One open dialog: what passed the check, the models given so far. */
type Open = { checked: Checked; given: Record<string, string> };

/** The dialogs by id; the oldest goes when there are more than this many. */
const OPEN_LIMIT = 8;
const open = new Map<string, Open>();

const refusal = (message: string): SubharnessResult => ({ ok: false, code: 'dialog-closed', changed: false, message });

/** The question of the agent at `index`, over the models the backend offers. */
async function questionOf(deps: EnableDeps, dialogId: string, state: Open, note = ''): Promise<AskAnswer> {
  const agent = ASKED_AGENTS[Object.keys(state.given).length] ?? '';
  const choices = await listModels(deps, state.checked.name, state.checked.keyValue);
  const hint = choices.length === 0 ? ' Type the model name.' : ' Pick one or type another name.';
  return askAnswer({
    dialogId,
    prompt: `${note}Which model does ${agent} run on?${hint}`,
    ...(choices.length === 0 ? {} : { choices }),
  });
}

/** Starts the dialog of an enable: the check first, then the first question. A refusal or a no-op ends here. */
export async function startEnable(
  deps: EnableDeps,
  backend: string,
  key?: string,
  newId: () => string = randomUUID
): Promise<SubharnessResult | AskAnswer> {
  const checked = await checkEnable(deps, backend, key);
  if ('ok' in checked) return checked;
  const dialogId = newId();
  const state: Open = { checked, given: {} };
  open.set(dialogId, state);
  for (const old of [...open.keys()].slice(0, Math.max(0, open.size - OPEN_LIMIT))) open.delete(old);
  return questionOf(deps, dialogId, state);
}

/** Takes the owner's answer to the open question `dialogId`: the next question, a refusal asked again, or the end. */
export async function answerEnable(
  deps: EnableDeps,
  dialogId: string,
  answer: string
): Promise<SubharnessResult | AskAnswer> {
  const state = open.get(dialogId);
  if (state === undefined) return refusal('that question is no longer open: run subharness enable again');
  const model = answer.trim();
  if (model === '') return questionOf(deps, dialogId, state, 'No model given. ');
  const failed = await checkModel(deps, state.checked.name, state.checked.keyValue, model);
  if (failed !== null) return questionOf(deps, dialogId, state, `${failed.message}. `);
  const agent = ASKED_AGENTS[Object.keys(state.given).length] ?? '';
  state.given[agent] = model;
  if (Object.keys(state.given).length < ASKED_AGENTS.length) return questionOf(deps, dialogId, state);
  open.delete(dialogId);
  const done = commitEnable(deps.privateDir, state.checked, state.given);
  return {
    ...done,
    message: `${done.message}; ${ASKED_AGENTS.map((one) => `${one} on ${state.given[one] ?? ''}`).join(', ')}`,
  };
}
