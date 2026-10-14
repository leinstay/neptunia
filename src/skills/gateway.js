// The rights gateway every persona skill call passes before it may run. The persona is her own
// principal; the requester (the member whose message led to the call), the current conversation
// and the audience come from the server, never from the model's arguments. A grant is not a
// blanket pass: after access, the arguments, the requester's own right and the budget are
// checked, in that order, right before execution (the operation then applies its own rules when
// it runs). The effects of her ordinary reply pass `checkReplyEffect`, carried over. Pure: the
// caller passes the live config (her grants included, `bot.access`) read at the moment of use,
// the bot's own user id, and the image client whose daily caps are the drawing budget. Codes are
// kebab-case; `reason` is a short machine-readable detail (a schema path, a config key, an ops
// refusal code), never wording.

import { getOp as registryGetOp } from '../ops/registry.js';
import { rightsRefusal } from '../ops/rights.js';
import { skillRegistry, describeSkill } from './registry.js';
import { CARRIED_OVER, skillAccess, skillsOn } from './access.js';
import { schemaError } from './schema.js';
import { skillArgs } from './discovery.js';
import { MINUTE_MS } from '../time.js';
import { SELF_OWNED_OPS } from '../ops/effects.js';

/** A refusal. */
function refused(code, reason) {
  return { ok: false, code, reason };
}

/** The conversation a call aims at: its `channel` argument (an id the server resolved), else the current one. */
function targetConversation(args, audience) {
  const given = args && typeof args === 'object' ? args.channel : undefined;
  return given === undefined || given === null ? audience?.conversationId ?? null : given;
}

/**
 * The one rule for a call nobody asked for (a spontaneous turn, the diary, her own initiative):
 * only a read, for now (the owner's decision, 2026-10-14) -- lifting it for her own initiative
 * later is this one place. Null when `skill` may run, else the refusal.
 */
function noRequesterRefusal(skill) {
  return skill.kind === 'read' ? null : refused('requester-denied', 'no-requester');
}

/**
 * Null when the requester may have this skill run for them, else the refusal (`requester-denied`
 * with the rights code). A skill on an owner's operation -- a derived one (src/skills/derive.js)
 * or one on an owner-only operation -- runs only for a requester who may run that operation
 * themselves (src/ops/rights.js, the owner commands' own check: an owner passes everything, an
 * owner-only operation only an owner, a member as their grants say); with no requester (nobody
 * asked: a spontaneous turn, the diary) only a read, and only one open to everyone (`no-requester`
 * for a write). Her own expressive operations (src/ops/effects.js#SELF_OWNED_OPS) skip the
 * requester's right -- hers alone decides -- but not the two rules on who asked: no write for
 * several people, only a read for nobody. Any other shared-state skill checks a requester's right
 * on its operation; with none the persona acts on her own.
 */
function requesterRefusal(skill, requester, context) {
  // A turn answering several people at once: no write runs on their mixed authority.
  if (context?.mixedRequesters === true && skill.kind !== 'read') return refused('requester-denied', 'mixed-requesters');
  const owners = skill.derived === true || skill.ownerOnly === true;
  if (!owners && (!skill.sharedState || !requester)) return null;
  const unasked = owners && !requester ? noRequesterRefusal(skill) : null;
  if (unasked) return unasked;
  if (SELF_OWNED_OPS.includes(skill.op)) return null;
  const getOp = context?.getOp ?? registryGetOp;
  const op = skill.op ? getOp(skill.op) : null;
  if (!op) return refused('requester-denied', 'no-operation');
  const code = rightsRefusal(op, { userId: requester?.id ?? null, roleIds: requester?.roleIds ?? [], config: context?.config });
  return code ? refused('requester-denied', code) : null;
}

/**
 * The budget of each paid skill: a function of the call's context and requester answering the
 * caps as src/llm/images.js#quota does (`{ spent, userSpent }`), or null when unavailable.
 */
const drawBudget = (context, requester) => (typeof context?.images?.quota === 'function' ? context.images.quota({ userId: requester?.id ?? null }) : null);
const BUDGETS = Object.freeze({ 'draw.create': drawBudget });

/** Minutes between two destructive calls from one channel (`skills.destructiveCooldownMinutes`; config.json's value). */
const DESTRUCTIVE_COOLDOWN_MINUTES = 10;

/**
 * Null unless a destructive skill (src/ops/effects.js) ran from this channel less than
 * `skills.destructiveCooldownMinutes` ago (`context.lastRunAt`, the caller's record, against
 * `context.now`), else `cooldown`.
 */
function cooldownRefusal(skill, context) {
  if (skill.effects !== 'destructive' || !Number.isFinite(context?.lastRunAt) || !Number.isFinite(context?.now)) return null;
  const minutes = context.config?.skills?.destructiveCooldownMinutes ?? DESTRUCTIVE_COOLDOWN_MINUTES;
  return context.now - context.lastRunAt < minutes * MINUTE_MS ? refused('cooldown', 'skills.destructiveCooldownMinutes') : null;
}

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
 * persona; `features.skills` is on (off: everything refused); the registry has the skill; she
 * may use it (src/skills/access.js#skillAccess: a carried-over skill aimed at the current
 * conversation -- no `channel` argument, or the current one -- else a grant to her user id, never
 * in safe mode); the arguments match its schema; the requester's own right (requesterRefusal:
 * every operation only for a requester who may run it, with no requester only a read open to
 * everyone, no write when the turn answers several people, `context.mixedRequesters`); a
 * destructive skill's cooldown in this channel (`context.lastRunAt`, `context.now`); a paid
 * skill's budget. Where a message may go and whose message may be changed is
 * the operation's own rule (src/ops/message.js), checked when it runs. Never throws.
 * @param {{ skill: string, args: object, principal: { kind: string }, requester: { id: string, roleIds?: string[] } | null,
 *   audience: { conversationId: string, memberIds?: string[] }, context: { config: object, selfId?: string,
 *   images?: object, registry?: Map<string, object>, getOp?: Function, mixedRequesters?: boolean,
 *   lastRunAt?: number|null, now?: number } }} call
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
export function checkSkill({ skill: name, args, principal, requester = null, audience, context = {} }) {
  if (principal?.kind !== 'persona') return refused('unknown-principal', String(principal?.kind ?? ''));
  if (!skillsOn(context.config)) return refused('skills-off', 'features.skills');
  const registry = context.registry ?? skillRegistry();
  const skill = registry.get(name);
  if (!skill) return refused('unknown-skill', String(name ?? ''));

  const access = skillAccess({
    skill,
    selfId: context.selfId ?? null,
    config: context.config,
    conversationId: targetConversation(args, null),
    currentConversationId: audience?.conversationId ?? null,
  });
  if (!access.allowed) return refused(access.reason, access.reason === 'safe-mode' ? 'skills.safeMode' : skill.name);

  const argsError = schemaError(args, skill.argsSchema);
  if (argsError) return refused('invalid-args', argsError);

  return requesterRefusal(skill, requester, context) ?? cooldownRefusal(skill, context) ?? budgetRefusal(skill, requester, context) ?? { ok: true };
}

/**
 * Whether one effect of the persona's ordinary reply may happen now -- a `<msg>` or `<gif>`
 * (`message.create`), a `<react>` (`message.react.add`), a `<draw>` (`draw.create`), always in the
 * current conversation: carried over without a grant (src/skills/access.js#CARRIED_OVER), even in
 * safe mode; refused only under the full stop (`features.skills` false: she goes silent). Never
 * throws.
 * @param {{ skill: string, principal: { kind: string }, config: object }} effect
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
export function checkReplyEffect({ skill, principal, config }) {
  if (principal?.kind !== 'persona') return refused('unknown-principal', String(principal?.kind ?? ''));
  if (!skillsOn(config)) return refused('skills-off', 'features.skills');
  if (!CARRIED_OVER.includes(skill)) return refused('unknown-skill', String(skill ?? ''));
  return { ok: true };
}

/**
 * The catalogue as the persona would see it for `requester` in `audience`'s conversation (the
 * discovery step: what she can do is what is granted to her): one row per registry skill, in order, `{ name, title,
 * whenToUse, allowed, reason }`, the texts from the skills layer (`texts`: `hot.prompts.skills`,
 * '' when missing). `reason` is skillAccess's (`carried-over`, `allowed`, `not-allowed`,
 * `safe-mode`, `skills-off`), or `requester-denied` for an allowed skill this requester may not
 * have run (requesterRefusal). `args` is what the skill takes (src/skills/discovery.js#skillArgs:
 * the command's option names, for `<skills>` to list); the arguments' values, targets and budget
 * are per call and left to `checkSkill`.
 * @param {{ config: object, selfId?: string|null, texts?: object, requester?: object|null, audience?: { conversationId?: string },
 *   registry?: Map<string, object>, getOp?: Function }} args
 * @returns {{ name: string, title: string, whenToUse: string, allowed: boolean, reason: string, args: object[] }[]}
 */
export function listSkills({ config, selfId = null, texts, requester = null, audience = {}, registry = skillRegistry(), getOp }) {
  const rows = [];
  for (const skill of registry.values()) {
    const { title, whenToUse } = describeSkill(skill, texts);
    const current = audience?.conversationId ?? null;
    let { allowed, reason } = skillAccess({ skill, config, selfId, conversationId: current, currentConversationId: current });
    if (allowed && requesterRefusal(skill, requester, { config, getOp })) {
      allowed = false;
      reason = 'requester-denied';
    }
    rows.push({ name: skill.name, title, whenToUse, allowed, reason, args: skillArgs(skill) });
  }
  return rows;
}
