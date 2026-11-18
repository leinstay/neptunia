// What a heartbeat accepts (docs/inner-life.md "Heartbeat"). It lets her make every call that only looks, on her memory,
// a chat, the web or a picture, hand off an errand, whose result her call waits for, and change intentions, each change
// saved when it is made, until an answer makes no call. Every turn offers the one tools array, her skills included, and a call
// outside the heartbeat's set is refused by name with the heartbeat's own code. Pure: the kind comes from the turn, the
// names from the registry.

import { CODE } from './codes.ts';
import { JOBS, SKILL_DEFINITIONS } from './definitions.ts';

/** The calls that change an intention: what a heartbeat acts with. */
export const HEARTBEAT_INTENT_SKILLS = Object.freeze(['intention.set', 'intention.update', 'intention.cancel']);
/** Every tool whose definition declares `effects` `read`: what a heartbeat looks with. */
const READ_SKILLS = Object.freeze(
  SKILL_DEFINITIONS.filter((definition) => definition.effects === 'read').map((definition) => definition.name)
);
/** The errand calls a service turn takes, a heartbeat and a diary entry alike. */
export const SERVICE_ERRAND_SKILLS = Object.freeze([...JOBS, 'errand.read']);
type WakeRule = { accepts: ReadonlyArray<string>; goesOnAfter: ReadonlyArray<string>; refusal: string };

const RULES: Readonly<Record<string, WakeRule>> = Object.freeze({
  heartbeat: {
    accepts: [...READ_SKILLS, ...SERVICE_ERRAND_SKILLS, ...HEARTBEAT_INTENT_SKILLS],
    goesOnAfter: HEARTBEAT_INTENT_SKILLS,
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

/**
 * Whether a call of `skill` that went through leaves a turn of wake `kind` a result to read and a next request: a
 * heartbeat's intention change, so the persona may make another one before an answer with no call ends the turn.
 * A call of the final request has no next request, and also goes through when this holds.
 */
export function wakeGoesOn(kind: unknown, skill: string): boolean {
  return ruleOf(kind)?.goesOnAfter.includes(skill) ?? false;
}

/**
 * The key of a call a restarted turn of the same wake must not repeat: the `nth` `intention.set` of a heartbeat, by
 * the wake's chain, which is one wake's alone, and n. A restart that repeats the first call gets the first result, and
 * a second call makes a second intention. Null for any other call.
 */
export function wakeCallKey(kind: unknown, chainId: unknown, skill: string, nth: number): string | null {
  if (typeof chainId !== 'string' || chainId === '') return null;
  const once = kind === 'heartbeat' && skill === 'intention.set';
  return once ? `wake:${chainId}:${skill}:${nth}` : null;
}
