// The facts of the inner life (docs/inner-life.md "Feedback on her own turn"): `feedbackFacts` reads from a turn's
// result what did not go through, and the state keeps each fact until a model answer carried it (`told`). The drain
// (src/behavior/inner/drain.ts) keeps a turn's facts, the turn runner (src/behavior/turn.js) shows the kept ones on
// an addressed turn, and `createLocalFacts` keeps them in process when no inner life runs. Pure.

import { isFiniteNumber, listOf, objOf } from '../../tools/types.ts';
import { CODE } from '../../tools/codes.ts';
import { DELIVERY_SKILLS } from './settings.ts';
import type { Fact, FactInput, FactPayload, FactScope, FactsApi } from './types.ts';

/** The statuses of a call that did not go well (src/tools/executors.ts), as `callFailed` names them. */
const CALL_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'partial',
  'invalid',
  'denied',
  'not_configured',
  'refused',
  'unknown',
  'timeout',
]);

/**
 * What did not go through in one inner turn, from its result (src/behavior/turn.js's
 * `{ outcome, inner: { actions, intentIds, loop } }`), as a list of facts, each
 * `{ kind, ... }` (FEEDBACK_KINDS), in this order: one `callFailed` per call whose status was not `ok`
 * and not `presented` in a later step of the turn (`failed`, `partial`, `invalid`, `denied`, `not_configured`, `refused`, `unknown`, `timeout`; `skill`, `status`, `code`, and the
 * operation's own `text` when it said one; a tag of hers refused by the gate is the `message.create` it was lowered into); one `doneWithoutDelivery` per intention an executed `intention.update`
 * closed as done (`state` `done` on the action, its `intentionId`, else the one id in `named`)
 * while no delivery call (`posting`, DELIVERY_SKILLS) was executed in the turn (`named` defaults
 * to the result's `inner.intentIds`; `intentionId`,
 * `purpose` from `intentions` when known); `loopCut` when the loop ended by its step or time
 * bound with calls dropped (`cut`, `droppedCalls`, `steps`); one `diagnostic` per parser diagnostic of her output that
 * no later step showed her (`inner.diagnostics`; `diagnostic` its kind). [] when nothing is wrong. Pure.
 */
export function feedbackFacts(
  turnResult: unknown,
  {
    named = null,
    posting = DELIVERY_SKILLS,
    intentions = [],
  }: {
    named?: ReadonlyArray<unknown> | null;
    posting?: ReadonlyArray<unknown>;
    intentions?: ReadonlyArray<unknown>;
  } = {}
): Array<FactPayload> {
  const inner = objOf(objOf(turnResult).inner);
  const actions = listOf(inner.actions).map(objOf);
  const facts: Array<FactPayload> = [];
  const purposeOf = (id: string) => {
    const record = objOf(listOf(intentions).find((item) => item && String(objOf(item).id) === String(id)));
    return typeof record.purpose === 'string' ? record.purpose : '';
  };
  for (const action of actions) {
    if (typeof action.skill !== 'string') continue;
    // A call whose result a later step of the turn showed her is told already.
    if (action.status === 'proposed' || action.presented === true) continue;
    const refused = action.status === 'refused';
    const result = typeof action.result === 'string' ? action.result : 'ok';
    if (!refused && result === 'ok') continue;
    const status = refused
      ? 'refused'
      : result === 'timeout' || action.code === CODE.TIMEOUT
        ? 'timeout'
        : CALL_STATUSES.has(result)
          ? result
          : 'failed';
    facts.push({
      kind: 'callFailed',
      skill: action.skill,
      status,
      code: typeof action.code === 'string' && action.code ? action.code : null,
      ...(typeof action.text === 'string' && action.text ? { text: action.text } : {}),
    });
  }
  const delivered = actions.some(
    (action) => action.status === 'executed' && action.result === 'ok' && posting.includes(action.skill)
  );
  if (!delivered) {
    const ids = listOf(named ?? inner.intentIds).map(String);
    const closed: Array<string> = [];
    for (const action of actions) {
      if (
        action.skill !== 'intention.update' ||
        action.status !== 'executed' ||
        action.result !== 'ok' ||
        action.state !== 'done'
      )
        continue;
      const id =
        typeof action.intentionId === 'string' && action.intentionId
          ? action.intentionId
          : ids.length === 1
            ? ids[0]
            : null;
      if (id && !closed.includes(id)) closed.push(id);
    }
    for (const id of closed) facts.push({ kind: 'doneWithoutDelivery', intentionId: id, purpose: purposeOf(id) });
  }
  const loop = objOf(inner.loop);
  if (typeof loop.cut === 'string' && loop.cut && isFiniteNumber(loop.droppedCalls) && loop.droppedCalls > 0) {
    facts.push({
      kind: 'loopCut',
      cut: loop.cut,
      droppedCalls: loop.droppedCalls,
      steps: isFiniteNumber(loop.steps) ? loop.steps : 0,
    });
  }
  // What the parser did with her output that no later step told her (src/llm/parse.js diagnostics).
  for (const entry of listOf(inner.diagnostics)) {
    const diagnostic = objOf(entry);
    if (typeof diagnostic.kind === 'string') {
      const { kind, ...rest } = diagnostic;
      facts.push({ kind: 'diagnostic', diagnostic: kind, ...rest });
    }
  }
  return facts;
}

/** `value` as text (String over a value of any type). */
export const asText = (value: unknown): string => String(value);

/** An id as text, or null for none (`null` or `undefined`). */
export const idOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : asText(value);

/** The facts a state holds: its list, or none. */
const factsOf = (state: { facts?: Array<Fact> } | null | undefined): Array<Fact> =>
  Array.isArray(state?.facts) ? state.facts : [];

/** The state's facts that `scope` may see and that are not told yet, oldest first (the callers cut them to FACTS_SHOWN_MAX). `scope`: `{ channelId, privateChat, anywhere }`. */
export function pendingFactsOf(
  state: { facts?: Array<Fact> } | null | undefined,
  { channelId = null, privateChat = false, anywhere = false }: FactScope = {}
): Array<Fact> {
  const here = idOrNull(channelId);
  return factsOf(state).filter((fact) => {
    if (fact.told) return false;
    if (privateChat === true) return fact.privateChat === true && here !== null && fact.channelId === here;
    if (fact.privateChat === true) return false;
    return anywhere || fact.channelId === null || fact.channelId === here;
  });
}

/** `fact` (`{ kind, channelId, privateChat, at, ...payload }`) appended to `state.facts` (an id given). Returns the stored fact. */
export function addFactTo(state: { facts?: Array<Fact> }, fact: FactInput, id: string): Fact {
  const { channelId = null, privateChat = false, at, ...payload } = fact;
  const stored: Fact = {
    ...payload,
    id,
    channelId: idOrNull(channelId),
    privateChat: privateChat === true,
    at: isFiniteNumber(at) ? at : 0,
    told: false,
  };
  state.facts = [...factsOf(state), stored];
  return stored;
}

/** The facts of `ids` marked told at `at`. */
export function markFactsTold(state: { facts?: Array<Fact> } | null | undefined, ids: unknown, at: number): void {
  const set = new Set(listOf(ids).map(String));
  for (const fact of factsOf(state)) if (set.has(fact.id) && !fact.told) fact.told = at;
}

/** The fields of a kept fact that are its bookkeeping, not its payload. */
const BOOKKEEPING = ['id', 'channelId', 'privateChat', 'at', 'told'] as const;

/** A fact as the prompt shows it: its payload without the bookkeeping. */
export function factPayload(fact: Fact): FactPayload {
  const payload: FactPayload = { ...fact };
  for (const key of BOOKKEEPING) delete payload[key];
  return payload;
}

/**
 * The facts of an addressed turn when no inner life keeps them (and of tests): the same three
 * calls as the inner life's `facts`, in process only, one list for every guild.
 */
export function createLocalFacts({ now = Date.now }: { now?: () => number } = {}): FactsApi {
  const state: { facts: Array<Fact> } = { facts: [] };
  let n = 0;
  return {
    enabled: () => true,
    add: (_guildId, fact) => addFactTo(state, { at: now(), ...fact }, `local-${++n}`),
    pending: (_guildId, scope) => pendingFactsOf(state, scope),
    markTold: (_guildId, ids) => {
      markFactsTold(state, ids, now());
      state.facts = state.facts.filter((fact) => !fact.told);
    },
  };
}
