// What a heartbeat and a selfimprovement wake accept (docs/inner-life.md "Heartbeat and selfimprovement"). Both let her
// read her memory first and end in one decision: a heartbeat records one intention or a skip, a selfimprovement wake
// files one task or a skip. Every turn offers the one tools array, her skills included, and a call outside the wake's
// set is refused by name with the wake's own code. `task.cancel`, `task.comment`, `task.answer` and `task.unblock` belong to the selfimprovement wake alone, on
// every other turn too. Pure: the kind comes from the turn, the names from the registry.

import { CODE } from './codes.ts';

/** The calls that change an intention: what a heartbeat decides with. */
export const HEARTBEAT_INTENT_SKILLS = Object.freeze(['intention.set', 'intention.update', 'intention.cancel']);
/** Memory inspection available while deciding; external reads and other effects remain deferred. */
export const HEARTBEAT_READ_SKILLS = Object.freeze([
  'memory.search',
  'memory.profile.read',
  'memory.affinity.read',
  'memory.channel.read',
  'memory.server.read',
  'memory.recent.read',
  'memory.archive.read',
  'memory.journal.read',
  'conversation.read',
  'intention.list',
  'lore.list',
  'lore.show',
  'tools.describe',
]);
/** Her answers on a task of hers: they do not end the wake, and only this wake has them. */
const TASK_ANSWER_SKILLS: ReadonlyArray<string> = Object.freeze([
  'task.cancel',
  'task.comment',
  'task.answer',
  'task.unblock',
]);
/** The call a selfimprovement wake decides with. */
const FILING = 'task.propose';

type WakeRule = { accepts: ReadonlyArray<string>; decides: ReadonlyArray<string>; refusal: string };

const RULES: Readonly<Record<string, WakeRule>> = Object.freeze({
  heartbeat: {
    accepts: [...HEARTBEAT_READ_SKILLS, ...HEARTBEAT_INTENT_SKILLS],
    decides: HEARTBEAT_INTENT_SKILLS,
    refusal: CODE.HEARTBEAT_ONLY,
  },
  selfimprovement: {
    accepts: [...HEARTBEAT_READ_SKILLS, 'task.status', ...TASK_ANSWER_SKILLS, FILING],
    decides: [FILING],
    refusal: CODE.SELFIMPROVEMENT_ONLY,
  },
});

const ruleOf = (kind: unknown): WakeRule | null =>
  typeof kind === 'string' && Object.hasOwn(RULES, kind) ? (RULES[kind] ?? null) : null;

/** Whether a turn of wake `kind` (null: no wake, or a kind with no set of its own) takes a call of `skill`. */
export function wakeAccepts(kind: unknown, skill: string): boolean {
  const rule = ruleOf(kind);
  return rule === null ? !TASK_ANSWER_SKILLS.includes(skill) : rule.accepts.includes(skill);
}

/** The code a call of `skill` is refused with on a turn of wake `kind`, null when the turn takes it. */
export function wakeRefusalCode(kind: unknown, skill: string): string | null {
  if (wakeAccepts(kind, skill)) return null;
  return ruleOf(kind)?.refusal ?? CODE.SELFIMPROVEMENT_ONLY;
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
 * The key of a call a restarted turn of the same wake must not repeat: a heartbeat's `intention.set` and a
 * selfimprovement wake's `task.propose`, by the wake's chain, which is one wake's alone. Null for any other call.
 */
export function wakeCallKey(kind: unknown, chainId: unknown, skill: string): string | null {
  if (typeof chainId !== 'string' || chainId === '') return null;
  const once = (kind === 'heartbeat' && skill === 'intention.set') || (kind === 'selfimprovement' && skill === FILING);
  return once ? `wake:${chainId}:${skill}` : null;
}
