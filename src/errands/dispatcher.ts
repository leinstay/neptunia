// The dispatcher: one request on the model role `dispatcher` that picks the agent of an errand that names none. It
// sends `prompts/dispatcher.md` as the system message and, as the user message, the goal in `<goal>` and the roster in
// `<agents>`, one `labels.errands.roster` line per candidate with its name and its profile's `description`. The answer
// is one `<agent>` tag holding one roster name, or the tag empty when no agent fits (docs/prompt-contract.md). Anything
// else names no agent. The dispatcher sees the goal and the roster alone, and the goal goes to the agent as she wrote
// it. The role takes no reasoning effort (src/llm/route-text.ts#TEXT_ROLES leaves it out). Logs carry counts and names.

import { fill } from '../format.ts';
import { roleRequestOptions, railReason } from '../llm/openrouter.ts';
import { DISPATCHER_ROLE, dispatcherModel } from '../llm/roles.ts';
import { escapeStored } from '../turn/request/text.ts';
import { objOf, textOf } from '../tools/types.ts';
import type { Logger } from './types.ts';

/** One candidate agent of a dispatch: its name and its profile's description. */
export type RosterEntry = { name: string; description: string };

/** What a dispatch answers: the agent, null when none fits, or `ok: false` when the request gave no answer. */
export type DispatchAnswer = { ok: true; agent: string | null } | { ok: false };

/** One dispatch of an errand's goal over a roster. */
export type Dispatch = (input: { goal: string; roster: ReadonlyArray<RosterEntry> }) => Promise<DispatchAnswer>;

/** The output cap of a dispatch: one short tag. */
const DISPATCH_MAX_OUTPUT_TOKENS = 200;

const AGENT_TAG = /<agent>([\s\S]*?)<\/agent>/g;

/** The roster name in the answer's one `<agent>` tag; null for an empty tag, two tags, no tag or a name off the roster. */
export function parseDispatcherAnswer(text: unknown, roster: ReadonlyArray<RosterEntry>): string | null {
  if (typeof text !== 'string') return null;
  const tags = [...text.matchAll(AGENT_TAG)];
  if (tags.length !== 1) return null;
  const name = (tags[0]?.[1] ?? '').trim();
  return roster.some((entry) => entry.name === name) ? name : null;
}

type DispatcherDeps = {
  llm: { complete(messages: unknown, options?: unknown): Promise<unknown> };
  hot: { config: unknown; prompts?: Record<string, unknown> };
  log: Logger;
};

/** The dispatcher over the model client `llm`; the prompt, the labels and the route are read at each dispatch. */
export function createDispatcher({ llm, hot, log }: DispatcherDeps): Dispatch {
  return async function dispatch({ goal, roster }) {
    const prompt = hot.prompts?.dispatcher;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      log.warn('dispatcher: no prompt', {});
      return { ok: false };
    }
    const line = textOf(objOf(objOf(hot.prompts?.labels).errands).roster);
    const user = [
      '<goal>',
      escapeStored(goal),
      '</goal>',
      '<agents>',
      ...roster.map((entry) => fill(line, { name: entry.name, description: escapeStored(entry.description) })),
      '</agents>',
    ].join('\n');
    const config = hot.config;
    let completion: unknown;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: prompt },
          { role: 'user', content: user },
        ],
        {
          model: dispatcherModel(config),
          ...roleRequestOptions(config, {
            role: DISPATCHER_ROLE,
            maxOutputTokens: DISPATCH_MAX_OUTPUT_TOKENS,
            purpose: 'dispatch',
          }),
        }
      );
    } catch (err) {
      log.warn('dispatcher: failed', { candidates: roster.length, reason: railReason(err) });
      return { ok: false };
    }
    const agent = parseDispatcherAnswer(objOf(completion).text, roster);
    log.info('dispatcher: answered', { candidates: roster.length, agent });
    return { ok: true, agent };
  };
}
