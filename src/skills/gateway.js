// The rights gateway every persona skill call passes before it may run (the skills design, phase
// 0: nothing executes here). The persona is her own principal; the requester (the member whose
// message led to the call), the current conversation and the audience come from the server,
// never from the model's arguments. `allow` is not a blanket pass: after access, the arguments,
// the target, the requester's own right for shared state and the budget are checked, in that
// order, right before execution. Pure: the caller passes the live config and state.json's data
// read at the moment of use, the target message the server resolved, and the image client whose
// daily caps are the drawing budget. Codes are kebab-case; `reason` is a short machine-readable
// detail (a schema path, a config key, an ops refusal code), never wording.

import { getOp as registryGetOp } from '../ops/registry.js';
import { rightsRefusal } from '../ops/rights.js';
import { skillRegistry, describeSkill } from './registry.js';
import { skillAccess, skillsOn } from './access.js';
import { schemaError } from './schema.js';

/** A refusal. */
function refused(code, reason) {
  return { ok: false, code, reason };
}

/** The conversation a call aims at: its `conversationId` argument, else the current one. */
function targetConversation(args, audience) {
  const given = args && typeof args === 'object' ? args.conversationId : undefined;
  return given === undefined || given === null ? audience?.conversationId ?? null : given;
}

/** True when the persona may act in `conversationId`: the current conversation, or one of `skills.conversations`. */
function conversationAllowed(conversationId, audience, config) {
  if (conversationId === null || conversationId === undefined) return false;
  const id = String(conversationId);
  if (audience?.conversationId != null && id === String(audience.conversationId)) return true;
  const list = Array.isArray(config?.skills?.conversations) ? config.skills.conversations : [];
  return list.map(String).includes(id);
}

/** Null when `skill`'s target rule holds for this call, else the refusal. */
function targetRefusal(skill, args, audience, context) {
  if (skill.targets !== 'allowed-conversations' && skill.targets !== 'self-messages') return null;
  const conversationId = targetConversation(args, audience);
  if (!conversationAllowed(conversationId, audience, context?.config)) return refused('conversation-not-allowed', String(conversationId ?? ''));
  if (skill.targets === 'allowed-conversations') return null;

  // self-messages: the server resolved the target message; its author must be the persona.
  const message = context?.targetMessage;
  if (!message || typeof message !== 'object') return refused('unknown-message', 'unresolved');
  if (String(message.id) !== String(args.messageId)) return refused('unknown-message', 'id');
  if (String(message.conversationId) !== String(conversationId)) return refused('unknown-message', 'conversation');
  const selfId = context?.selfId;
  if (selfId === undefined || selfId === null || selfId === '' || String(message.authorId) !== String(selfId)) return refused('not-own-message', 'author');
  return null;
}

/** Null when the requester (if any) holds the right for a shared-state skill's operation, else the refusal. */
function requesterRefusal(skill, requester, context) {
  if (!skill.sharedState || !requester) return null;
  const getOp = context?.getOp ?? registryGetOp;
  const op = skill.op ? getOp(skill.op) : null;
  if (!op) return refused('requester-denied', 'no-operation');
  const code = rightsRefusal(op, { userId: requester.id, roleIds: requester.roleIds, config: context?.config });
  return code ? refused('requester-denied', code) : null;
}

/**
 * The budget of each paid skill: a function of the call's context and requester answering the
 * caps as src/llm/images.js#quota does (`{ spent, userSpent }`), or null when unavailable.
 */
const BUDGETS = Object.freeze({
  draw: (context, requester) => (typeof context?.images?.quota === 'function' ? context.images.quota({ userId: requester?.id ?? null }) : null),
});

/** Null when a paid skill still has budget today, else the refusal. Fails closed. */
function budgetRefusal(skill, requester, context) {
  if (skill.costClass !== 'paid') return null;
  const budget = Object.hasOwn(BUDGETS, skill.name) ? BUDGETS[skill.name](context, requester) : null;
  if (!budget || typeof budget !== 'object') return refused('no-budget', 'unavailable');
  if (budget.spent === true) return refused('daily-cap', 'image.maxPerDay');
  if (budget.userSpent === true) return refused('daily-cap', 'image.maxPerUserPerDay');
  return null;
}

/**
 * Whether the persona may make one skill call now. Checks, in order: the principal is the
 * persona; `features.skills` is on (off: everything refused); the registry has the skill; it is
 * not owner-only; she may use it (src/skills/access.js#skillAccess: a carried-over reply tag in
 * the current conversation, else an allow record, never in safe mode); the arguments match its
 * schema; its target rule (`allowed-conversations`: the current conversation or one of
 * `skills.conversations`; `self-messages`: that, and the server-resolved target message is in it
 * and the persona's own); a shared-state skill's requester holds the right for its operation
 * (src/ops/rights.js, the owner commands' own check; no requester passes); a paid skill's budget.
 * Never throws.
 * @param {{ skill: string, args: object, principal: { kind: string }, requester: { id: string, isOwner?: boolean, roleIds?: string[] } | null,
 *   audience: { conversationId: string, memberIds?: string[] }, context: { config: object, state: object, selfId?: string,
 *   targetMessage?: { id: string, authorId: string, conversationId: string }, images?: object, registry?: Map<string, object>, getOp?: Function } }} call
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
export function checkSkill({ skill: name, args, principal, requester = null, audience, context = {} }) {
  if (principal?.kind !== 'persona') return refused('unknown-principal', String(principal?.kind ?? ''));
  if (!skillsOn(context.config)) return refused('skills-off', 'features.skills');
  const registry = context.registry ?? skillRegistry();
  const skill = registry.get(name);
  if (!skill) return refused('unknown-skill', String(name ?? ''));
  if (skill.ownerOnly === true) return refused('owner-only', skill.name);

  const access = skillAccess({
    skill,
    state: context.state,
    config: context.config,
    conversationId: targetConversation(args, null),
    currentConversationId: audience?.conversationId ?? null,
  });
  if (!access.allowed) return refused(access.reason, access.reason === 'safe-mode' ? 'skills.safeMode' : skill.name);

  const argsError = schemaError(args, skill.argsSchema);
  if (argsError) return refused('invalid-args', argsError);

  return targetRefusal(skill, args, audience, context) ?? requesterRefusal(skill, requester, context) ?? budgetRefusal(skill, requester, context) ?? { ok: true };
}

/**
 * The catalogue as the persona would see it for `requester` in `audience`'s conversation (the
 * discovery step, the `skills.list` skill): one row per registry skill, in order, `{ name, title,
 * whenToUse, allowed, reason }`, the texts from the skills layer (`texts`: `hot.prompts.skills`).
 * `reason` is skillAccess's (`carried-over`, `allowed`, `not-allowed`, `safe-mode`, `skills-off`),
 * or `requester-denied` for a shared-state skill the requester has no right for. An owner-only
 * skill is no persona skill and has no row. Arguments, targets and budget are per call and left
 * to `checkSkill`.
 * @param {{ config: object, state: object, texts?: object, requester?: object|null, audience?: { conversationId?: string },
 *   registry?: Map<string, object>, getOp?: Function }} args
 * @returns {{ name: string, title: string, whenToUse: string, allowed: boolean, reason: string }[]}
 */
export function listSkills({ config, state, texts, requester = null, audience = {}, registry = skillRegistry(), getOp }) {
  const rows = [];
  for (const skill of registry.values()) {
    if (skill.ownerOnly === true) continue;
    const { title, whenToUse } = describeSkill(skill, texts);
    const current = audience?.conversationId ?? null;
    let { allowed, reason } = skillAccess({ skill, state, config, conversationId: current, currentConversationId: current });
    if (allowed && requesterRefusal(skill, requester, { config, getOp })) {
      allowed = false;
      reason = 'requester-denied';
    }
    rows.push({ name: skill.name, title, whenToUse, allowed, reason });
  }
  return rows;
}
