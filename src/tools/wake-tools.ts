// What a heartbeat accepts (docs/inner-life.md "Heartbeat"). It lets her read her memory first and ends in one
// decision: one intention recorded or a skip. Every turn offers the one tools array, her skills included, and a call
// outside the heartbeat's set is refused by name with the heartbeat's own code. Pure: the kind comes from the turn, the
// names from the registry.

import { CODE } from './codes.ts';

/** The calls that change an intention: what a heartbeat decides with. */
export const HEARTBEAT_INTENT_SKILLS = Object.freeze(['intention.set', 'intention.update', 'intention.cancel']);
/** Memory inspection available while deciding; external reads and other effects remain deferred. */
export const HEARTBEAT_READ_SKILLS = Object.freeze([
  'memory.search',
  'memory.read',
  'memory.archive.read',
  'memory.journal.read',
  'conversation.read',
  'intention.list',
]);
type WakeRule = { accepts: ReadonlyArray<string>; decides: ReadonlyArray<string>; refusal: string };

const RULES: Readonly<Record<string, WakeRule>> = Object.freeze({
  heartbeat: {
    accepts: [...HEARTBEAT_READ_SKILLS, ...HEARTBEAT_INTENT_SKILLS],
    decides: HEARTBEAT_INTENT_SKILLS,
    refusal: CODE.HEARTBEAT_ONLY,
  },
});

const ruleOf = (kind: unknown): WakeRule | null =>
  typeof kind === 'string' && Object.hasOwn(RULES, kind) ? (RULES[kind] ?? null) : null;

/** Whether a turn of wake `kind` (null: no wake, or a kind with no set of its own) takes a call of `skill`. */
export function wakeAccepts(kind: unknown, skill: string): boolean {
  const rule = ruleOf(kind);
  return rule === null || rule.accepts.includes(skill);
}

/** The code a call of `skill` is refused with on a turn of wake `kind`, null when the turn takes it. */
export function wakeRefusalCode(kind: unknown, skill: string): string | null {
  if (wakeAccepts(kind, skill)) return null;
  return ruleOf(kind)?.refusal ?? null;
}

/** The code of the wake's second decision of one step; null for a kind with no such rule. */
export function oneDecisionCode(kind: unknown): string | null {
  return ruleOf(kind)?.refusal ?? null;
}

/** Whether a call of `skill` that went through is the decision that ends a turn of wake `kind`. */
export function endsWake(kind: unknown, skill: string): boolean {
  return ruleOf(kind)?.decides.includes(skill) ?? false;
}

/**
 * The key of a call a restarted turn of the same wake must not repeat: a heartbeat's `intention.set`, by the
 * wake's chain, which is one wake's alone. Null for any other call.
 */
export function wakeCallKey(kind: unknown, chainId: unknown, skill: string): string | null {
  if (typeof chainId !== 'string' || chainId === '') return null;
  const once = kind === 'heartbeat' && skill === 'intention.set';
  return once ? `wake:${chainId}:${skill}` : null;
}
