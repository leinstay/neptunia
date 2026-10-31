// The rights gateway every persona skill call passes before it may run. The persona is her own
// principal; the requester (the member whose message led to the call), the current conversation
// and the audience come from the server, never from the model's arguments. A grant is not a
// blanket pass: after access, the arguments, the requester's own right and the budget are
// checked, in that order, right before execution (the operation then applies its own rules when
// it runs). The effects of her ordinary reply pass `checkReplyEffect`, carried over. Pure: the
// caller passes the live config (her grants included, `bot.access`) read at the moment of use,
// the bot's own user id, the image client whose daily caps are the drawing budget, and the errand
// tasks whose caps are an errand's budget (src/errands/store.ts#budget). Codes are
// kebab-case; `reason` is a short machine-readable detail (a schema path, a config key, an ops
// refusal code), never wording. `abilityRoute` decides where a call of a model role that runs as her tool goes when
// the role is down (src/llm/role-health.ts): to the core model when it declares the role's ability, else nowhere.

import { getOp as registryGetOp } from './impl/registry.ts';
import type { Op } from './impl/registry.ts';
import { rightsRefusal } from './impl/rights.ts';
import { skillRegistry, describeSkill } from './registry.ts';
import { CARRIED_OVER, skillAccess, skillFeatureOn, skillsOn } from './access.ts';
import { schemaError } from './schema.ts';
import { skillArgs } from './discovery.ts';
import { MINUTE_MS } from '../time.js';
import { SELF_OWNED_OPS } from './impl/effects.ts';
import { CODE } from './codes.ts';
import { CORE_ROLE, ROLE_ABILITY, modelAbilities, roleModel } from '../llm/roles.js';
import type { RoleDownReason, RoleHealth } from '../llm/role-health.ts';
import { idText, isObj, objOf } from './types.ts';
import type { Skill, SkillMap } from './types.ts';
import type { WakeAction } from './access.ts';

/** A refusal of a call: its code and a short machine-readable detail. */
export type Refusal = { ok: false; code: string; reason: string };

/** The member whose message led to a call. */
export type Requester = { id?: string | null; roleIds?: ReadonlyArray<string> };

/** Where a call is made: the current conversation and who is in it. */
export type Audience = { conversationId?: string | null; memberIds?: ReadonlyArray<string> };

/** What a budget answers: whether a cap is spent, and which one when it is not the drawing's. */
type Budget = { spent?: boolean; userSpent?: boolean; code?: string; key?: string };

/**
 * What the gateway reads from the caller beside the config: the registry and operation lookup, the clients whose
 * caps are the budgets, the turn's wake and its last destructive run. Every field is optional but `config`.
 */
export type GateContext = {
  config?: unknown;
  selfId?: string | null;
  images?: { quota?: (who: { userId: string | null }) => unknown };
  speech?: { quota?: () => unknown };
  tasks?: { budget?: (agent: unknown) => unknown };
  registry?: SkillMap;
  getOp?: (name: string) => Pick<Op, 'name' | 'rights'> | null;
  mixedRequesters?: boolean;
  ownInitiative?: boolean;
  wakeKind?: string;
  wakeActions?: ReadonlyArray<WakeAction>;
  lastRunAt?: number | null;
  now?: number;
};

function refused(code: string, reason: string): Refusal {
  return { ok: false, code, reason };
}

/** The conversation a call aims at: its `channel` argument (an id the server resolved), else the current one. */
function targetConversation(args: unknown, audience: Audience | null): string | null {
  const given = isObj(args) ? args.channel : undefined;
  return given === undefined || given === null ? (audience?.conversationId ?? null) : idText(given);
}

/**
 * The one rule for a call nobody asked for (a spontaneous turn, the diary): only a read (the
 * owner's decision, 2026-10-14). Her own initiative -- an inner turn, `context.ownInitiative` --
 * is lifted in requesterRefusal: there her grants alone decide (the owner's decision, 2026-10-18).
 * Null when `skill` may run, else the refusal.
 */
function noRequesterRefusal(skill: Skill): Refusal | null {
  return skill.kind === 'read' ? null : refused(CODE.NO_REQUESTER, CODE.NO_REQUESTER);
}

/** Whether `op` is one of the persona's own expressive operations (no requester's right asked). */
const isSelfOwned = (op: string | null): boolean => op !== null && SELF_OWNED_OPS.includes(op);

/**
 * Null when the requester may have this skill run for them, else the refusal (`requester-denied`
 * with the rights code). A skill on an owner's operation -- one backed by an operation (src/tools/definitions.ts)
 * or one on an owner-only operation -- runs only for a requester who may run that operation
 * themselves (src/tools/impl/rights.ts, the owner commands' own check: an owner passes everything, an
 * owner-only operation only an owner, a member as their grants say); with no requester (nobody
 * asked: a spontaneous turn, the diary) only a read, and only one open to everyone (`no-requester`
 * for a write). Her own expressive operations (src/tools/impl/effects.ts#SELF_OWNED_OPS) skip the
 * requester's right -- hers alone decides -- but not the two rules on who asked: no write for
 * several people, only a read for nobody. Any other shared-state skill checks a requester's right
 * on its operation; with none the persona acts on her own. A carried-over skill aimed at the current
 * conversation (`carriedOver`) runs with no requester too, as the reply tags did.
 */
function requesterRefusal(
  skill: Skill,
  requester: Requester | null,
  context: GateContext | undefined,
  carriedOver = false
): Refusal | null {
  // A turn answering several people at once: no write runs on their mixed authority.
  if (context?.mixedRequesters === true && skill.kind !== 'read')
    return refused(CODE.MIXED_REQUESTERS, CODE.MIXED_REQUESTERS);
  const owners = skill.opBacked === true || skill.ownerOnly === true;
  if (!owners && (!skill.sharedState || !requester)) return null;
  // Her own initiative (an inner turn, src/behavior/inner.ts: nobody asked, the owner let her act
  // unasked): her grants, checked before this, alone decide.
  if (!requester && context?.ownInitiative === true) return null;
  // A carried-over skill in the current conversation (her reply tags of old) runs unasked as it always did.
  if (!requester && carriedOver) return null;
  const unasked = owners && !requester ? noRequesterRefusal(skill) : null;
  if (unasked) return unasked;
  if (isSelfOwned(skill.op)) return null;
  const getOp = context?.getOp ?? registryGetOp;
  const op = skill.op ? getOp(skill.op) : null;
  if (!op) return refused(CODE.REQUESTER_DENIED, 'no-operation');
  const code = rightsRefusal(op, {
    userId: requester?.id ?? null,
    roleIds: requester?.roleIds ?? [],
    config: context?.config,
  });
  return code ? refused(CODE.REQUESTER_DENIED, code) : null;
}

/**
 * The budget of each paid skill: a function of the call's context, requester and arguments
 * answering the caps as src/llm/images.js#quota does (`{ spent, userSpent }`; `code` and `key`
 * naming the refusal and the cap that is spent when they are not the drawing's), or null when
 * unavailable.
 */
const drawBudget = (context: GateContext, requester: Requester | null): unknown =>
  typeof context.images?.quota === 'function' ? context.images.quota({ userId: requester?.id ?? null }) : null;
/** An errand's budget: its agent's caps (open tasks, tasks and dollars a day), `context.tasks`. */
const taskBudget = (context: GateContext, _requester: Requester | null, args: unknown): unknown =>
  typeof context.tasks?.budget === 'function' ? context.tasks.budget(objOf(args).agent) : null;
/** A voice message's budget: today's count against `speech.maxPerDay`, `context.speech`. */
const speechBudget = (context: GateContext): unknown =>
  typeof context.speech?.quota === 'function' ? context.speech.quota() : null;
const BUDGETS: Readonly<Record<string, (context: GateContext, requester: Requester | null, args: unknown) => unknown>> =
  Object.freeze({ 'draw.create': drawBudget, 'voice.say': speechBudget, 'errand.run': taskBudget });

/** Minutes between two destructive calls from one channel (`tools.destructiveCooldownMinutes`; config.json's value). */
const DESTRUCTIVE_COOLDOWN_MINUTES = 10;

/**
 * Null unless a destructive skill (src/tools/impl/effects.ts) ran from this channel less than
 * `tools.destructiveCooldownMinutes` ago (`context.lastRunAt`, the caller's record, against
 * `context.now`), else `cooldown`.
 */
function cooldownRefusal(skill: Skill, context: GateContext): Refusal | null {
  const { lastRunAt, now } = context;
  if (skill.effects !== 'destructive' || typeof lastRunAt !== 'number' || typeof now !== 'number') return null;
  if (!Number.isFinite(lastRunAt) || !Number.isFinite(now)) return null;
  const given = objOf(objOf(context.config).tools).destructiveCooldownMinutes;
  const minutes = typeof given === 'number' ? given : DESTRUCTIVE_COOLDOWN_MINUTES;
  return now - lastRunAt < minutes * MINUTE_MS ? refused(CODE.COOLDOWN, 'tools.destructiveCooldownMinutes') : null;
}

/** Null when a paid skill still has budget today, else the refusal. Fails closed. */
function budgetRefusal(skill: Skill, requester: Requester | null, context: GateContext, args: unknown): Refusal | null {
  if (skill.costClass !== 'paid') return null;
  const ask = BUDGETS[skill.name];
  const answer = Object.hasOwn(BUDGETS, skill.name) && ask !== undefined ? ask(context, requester, args) : null;
  if (!isObj(answer)) return refused(CODE.NO_BUDGET, 'unavailable');
  const budget: Budget = answer;
  if (budget.spent === true)
    return refused(
      typeof budget.code === 'string' && budget.code ? budget.code : CODE.DAILY_CAP,
      typeof budget.key === 'string' && budget.key ? budget.key : 'image.maxPerDay'
    );
  if (budget.userSpent === true) return refused(CODE.DAILY_CAP, 'image.maxPerUserPerDay');
  return null;
}

/**
 * Whether the persona may make one skill call now. Checks, in order: the principal is the
 * persona; `features.tools` is on (off: everything refused); the registry has the skill; she
 * may use it (src/tools/access.ts#skillAccess: a carried-over skill aimed at the current
 * conversation -- no `channel` argument, or the current one -- else a grant to her user id, never
 * in safe mode); the arguments match its schema; the requester's own right (requesterRefusal:
 * every operation only for a requester who may run it, with no requester only a read open to
 * everyone, no write when the turn answers several people, `context.mixedRequesters`); a
 * destructive skill's cooldown in this channel (`context.lastRunAt`, `context.now`); a paid
 * skill's budget. Where a message may go and whose message may be changed is
 * the operation's own rule (src/tools/impl/message.ts), checked when it runs. Never throws.
 * `wakeKind` and `wakeActions` (an inner turn, with `ownInitiative`): the wake envelope is checked with the access.
 */
export function checkSkill({
  skill: name,
  args,
  principal,
  requester = null,
  audience,
  context = {},
}: {
  skill: string;
  args: unknown;
  principal: { kind?: string } | null | undefined;
  requester?: Requester | null;
  audience?: Audience | null;
  context?: GateContext;
}): { ok: true } | Refusal {
  if (principal?.kind !== 'persona') return refused(CODE.UNKNOWN_PRINCIPAL, idText(principal?.kind));
  if (!skillsOn(context.config)) return refused(CODE.SKILLS_OFF, 'features.tools');
  const registry = context.registry ?? skillRegistry();
  const skill = registry.get(name);
  if (!skill) return refused(CODE.UNKNOWN_SKILL, idText(name));
  const given = objOf(args);

  const access = skillAccess({
    skill,
    selfId: context.selfId ?? null,
    config: context.config,
    conversationId: targetConversation(args, null),
    currentConversationId: audience?.conversationId ?? null,
    // An inner turn's wake envelope (src/tools/access.ts#wakeEnvelopeRefusal): its kind and the turn's calls so far.
    wakeKind: context.ownInitiative === true && typeof context.wakeKind === 'string' ? context.wakeKind : null,
    wakeActions: Array.isArray(context.wakeActions) ? context.wakeActions : null,
  });
  if (!access.allowed)
    return refused(access.reason, access.detail ?? (access.reason === CODE.SAFE_MODE ? 'tools.safeMode' : skill.name));

  // A file-only post: her text (the body argument) left empty beside a file (src/tools/executors.ts#resolveCall); a GIF-only post: no text beside a `gif`.
  const bodyArg = skill.dispatch?.body ?? null;
  const body = bodyArg === null ? undefined : given[bodyArg];
  const gifOnly =
    bodyArg !== null &&
    (body === '' || body === undefined) &&
    ((typeof given.gif === 'string' && given.gif !== '') || (typeof given.media === 'string' && given.media !== ''));
  const fileOnly = gifOnly || (bodyArg !== null && body === '' && typeof given.file === 'string' && given.file !== '');
  const argsError = fileOnly
    ? schemaError(Object.fromEntries(Object.entries(given).filter(([key]) => key !== bodyArg)), {
        ...skill.argsSchema,
        required: (skill.argsSchema.required ?? []).filter((key) => key !== bodyArg),
      })
    : schemaError(args, skill.argsSchema);
  if (argsError) return refused(CODE.INVALID_ARGS, argsError);

  return (
    requesterRefusal(skill, requester, context, access.reason === 'carried-over') ??
    cooldownRefusal(skill, context) ??
    budgetRefusal(skill, requester, context, args) ?? { ok: true }
  );
}

/**
 * Whether one effect of the persona's ordinary reply may happen now -- a `<msg>` or `<gif>`
 * (`message.create`), a `<react>` (`message.react.add`), a `draw.create` call, always in the
 * current conversation: carried over without a grant (src/tools/access.ts#CARRIED_OVER), even in
 * safe mode; refused only under the full stop (`features.tools` false: she goes silent). Never
 * throws.
 */
export function checkReplyEffect({
  skill,
  principal,
  config,
}: {
  skill: string;
  principal: { kind?: string } | null | undefined;
  config: unknown;
}): { ok: true } | Refusal {
  if (principal?.kind !== 'persona') return refused(CODE.UNKNOWN_PRINCIPAL, idText(principal?.kind));
  if (!skillsOn(config)) return refused(CODE.SKILLS_OFF, 'features.tools');
  if (!CARRIED_OVER.includes(skill)) return refused(CODE.UNKNOWN_SKILL, idText(skill));
  return { ok: true };
}

/**
 * The catalogue as the persona would see it for `requester` in `audience`'s conversation (the
 * discovery step: what she can do is what is granted to her): one row per registry skill whose
 * feature switch is on (src/tools/access.ts#skillFeatureOn), in order, `{ name, title,
 * whenToUse, allowed, reason }`, the texts from the skills layer (`texts`: `hot.prompts.tools`,
 * '' when missing). `reason` is skillAccess's (`carried-over`, `allowed`, `not-allowed`,
 * `safe-mode`, `skills-off`), or `requester-denied` for an allowed skill this requester may not
 * have run (requesterRefusal). `args` is what the skill takes (src/tools/discovery.ts#skillArgs:
 * the command's option names, for `<skills>` to list); the arguments' values, targets and budget
 * are per call and left to `checkSkill`.
 */
export function listSkills({
  config,
  selfId = null,
  texts,
  requester = null,
  audience = {},
  registry = skillRegistry(),
  getOp,
}: {
  config: unknown;
  selfId?: string | null;
  texts?: unknown;
  requester?: Requester | null;
  audience?: Audience;
  registry?: SkillMap;
  getOp?: GateContext['getOp'];
}): Array<ListedSkill> {
  const rows: Array<ListedSkill> = [];
  for (const skill of registry.values()) {
    // A skill whose feature switch is off does not exist for her: no row.
    if (!skillFeatureOn(skill.name, config)) continue;
    const { title, whenToUse } = describeSkill(skill, texts);
    const current = audience?.conversationId ?? null;
    let { allowed, reason } = skillAccess({
      skill,
      config,
      selfId,
      conversationId: current,
      currentConversationId: current,
    });
    if (allowed && requesterRefusal(skill, requester, { config, ...(getOp ? { getOp } : {}) })) {
      allowed = false;
      reason = CODE.REQUESTER_DENIED;
    }
    rows.push({ name: skill.name, title, whenToUse, allowed, reason, args: skillArgs(skill) });
  }
  return rows;
}

/** One row of the catalogue as she would see it. */
export type ListedSkill = {
  name: string;
  title: string;
  whenToUse: string;
  allowed: boolean;
  reason: string;
  args: ReturnType<typeof skillArgs>;
};

/** The model roles that run as her tools and fall back to the core model, in the order her route line names them. */
export const TOOL_ROLES = Object.freeze(['vision', 'video', 'drawing', 'speech'] as const);

/** Where one call of a model role goes: its own model, the core model, or nowhere. */
export type AbilityRoute =
  | { kind: 'role'; role: string; model: string }
  | { kind: 'core'; role: string; ability: string; model: string; reason: RoleDownReason }
  | { kind: 'unavailable'; role: string; ability: string; reason: RoleDownReason };

const isToolRole = (role: string): boolean => TOOL_ROLES.some((name) => name === role);

/** The ability a model role serves (src/llm/roles.js#ROLE_ABILITY), `text` for one that names none. */
function abilityOf(role: string): string {
  const table: Readonly<Record<string, string>> = ROLE_ABILITY;
  return Object.hasOwn(table, role) ? (table[role] ?? 'text') : 'text';
}

/**
 * The route of one call of `role` now: its own model while `health` says it is up; when it is down, the core model if
 * the core declares the role's ability (`models.abilities.<model id>`), else `unavailable` with why the role is down.
 * Only the tool roles (TOOL_ROLES) fall back: the analyzer and the embedding role always go to their own model.
 */
export function abilityRoute({
  config,
  role,
  health,
}: {
  config: unknown;
  role: string;
  health: RoleHealth | null;
}): AbilityRoute {
  // roleModel and modelAbilities read the config as an object; any other value has no models and gives the defaults.
  const models = config !== null && typeof config === 'object' ? config : undefined;
  const own = { kind: 'role', role, model: String(roleModel(models, role) ?? '') } as const;
  const down = isToolRole(role) ? (health?.down(config, role) ?? null) : null;
  if (down === null) return own;
  const ability = abilityOf(role);
  const core = String(roleModel(models, CORE_ROLE) ?? '');
  return modelAbilities(models, core).includes(ability)
    ? { kind: 'core', role, ability, model: core, reason: down.reason }
    : { kind: 'unavailable', role, ability, reason: down.reason };
}

/**
 * One call of `role` on its route: `call` runs with the core model's id when the route is the core, with null for the
 * role's own model, and not at all when it is `unavailable`. `call` tells `health` how its own model's request went;
 * when that put the role down, the same call is routed again at once. Resolves the route the value came from.
 */
export async function callOnRoute<TValue>({
  config,
  role,
  health,
  call,
}: {
  config: unknown;
  role: string;
  health: RoleHealth | null;
  call: (model: string | null) => Promise<TValue>;
}): Promise<{ route: AbilityRoute; value: TValue | null }> {
  const first = abilityRoute({ config, role, health });
  if (first.kind === 'unavailable') return { route: first, value: null };
  const value = await call(first.kind === 'core' ? first.model : null);
  if (first.kind === 'core') return { route: first, value };
  const again = abilityRoute({ config, role, health });
  if (again.kind === 'role') return { route: first, value };
  return { route: again, value: again.kind === 'core' ? await call(again.model) : null };
}

/** The result of a call that did not happen because its role is down and the core model lacks the ability. */
export function abilityUnavailable(route: { ability: string; reason: RoleDownReason }): {
  status: 'failed';
  code: string;
  values: { ability: string; why: RoleDownReason };
  route: 'unavailable';
  data: { text: string };
} {
  return {
    status: 'failed',
    code: CODE.ABILITY_UNAVAILABLE,
    values: { ability: route.ability, why: route.reason },
    route: 'unavailable',
    data: { text: '' },
  };
}
