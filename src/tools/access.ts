// The persona's access to her skills: two levels, allowed or not, granted the same way people's
// rights are -- `/nep access grant|revoke` (src/tools/operations/access.ts) with her (the bot's own user) as
// the target, stored in the same place, `bot.access[<skill name>].users` (src/tools/operations/grants.ts).
// Default deny; only a grant naming her user id opens a skill for her: a grant to everyone or to
// a role is people's and opens nothing for her, so no grant she could make for others widens her
// own rights. For her a grant may open an owner-only operation (it still runs only when an owner
// asks: src/tools/gateway.ts), except the irreversible and administrative ones no grant opens
// for her yet (NOT_GRANTABLE_TO_PERSONA). Her reply tags of today are carried over without a grant, in the
// current chat only, so nothing she does now is blocked (the skills design, "carry
// permissions over"): `<msg>` and `<gif>` are `message.create`, `<react>` is `message.react.add`,
// a picture is `draw.create` -- the operations the owner's `/nep message` and `/nep draw` run. One switch, read by the caller from the live config:
// `tools.safeMode` true lets only the carried-over tags pass.
// Wake envelopes (schema v11 stage, spec 2026-10-24-memory-schema-v7, sections 6 and 11): an inner turn's call is
// also checked against the envelope of its wake kind, `wakes.kinds.<kind>`, and for the heartbeat and the
// selfimprovement wake the same keys of their own sections, `heartbeat.tools` and `selfimprovement.tools` (`tools`: `"*"` or a list of skill
// names, `family.*` naming a family; `maxActs`: the most calls that change something per turn; `maxTasks`: the most
// errands per turn; `inputTokens`: the input budget the envelope declares). The default of every kind is `"*"` with no
// caps, today's behaviour. The check runs at the resolved call (skillAccess, through the gateway) and again where a
// skill reaches another capability inside its own operation (NESTED_CAPABILITIES: a picture or a voice message is a
// post), so a skill the envelope allows cannot post where the envelope forbids posting. A refusal is the access code
// `not-allowed` with the envelope's key as its reason.
// Pure over the live config the caller reads at the moment of use.

import { CODE } from './codes.ts';
import { SKILL_DEFINITIONS, toolsWith } from './definitions.ts';
import { grantNamesFor as namesFor } from './operations/grants.ts';
import { idText, isObj, objOf } from './types.ts';
import type { Obj, SkillVerdict } from './types.ts';

/** The skills behind the persona's current reply tags, allowed in the current chat without a grant: the trait `carried`. */
export const CARRIED_OVER: ReadonlyArray<string> = toolsWith('carried');

/**
 * The operations no grant opens for the persona yet (the owner's decision, 2026-10-14): the
 * irreversible and the administrative ones and the owner's narrow reads of one subject, the trait `ungrantable`. Refused by `/nep access grant` with her as the
 * target (a group or `*` skips them) and again at every call (skillAccess: `not-grantable`), whatever
 * is stored. Everything else -- owner-only operations included -- is grantable to her.
 */
export const NOT_GRANTABLE_TO_PERSONA: ReadonlyArray<string> = toolsWith('ungrantable');

/** The policy version of the wake envelopes (recorded on every wake run). */
export const WAKE_POLICY_VERSION = 1;

/**
 * The capabilities a skill reaches inside its own operation, as the skills that stand for them: a tool with the trait
 * `attaches` (a picture, a voice message) posts, so it reaches `message.create`. Checked against a wake's envelope before the operation runs and again where
 * it posts (src/tools/executors.ts, src/tools/operations/shared.ts#postingChat).
 */
export const NESTED_CAPABILITIES: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze(
  Object.fromEntries(toolsWith('attaches').map((name) => [name, Object.freeze(['message.create'])]))
);

const EFFECTS_OF = new Map(SKILL_DEFINITIONS.map((definition) => [definition.name, definition.effects]));
/** The wake kinds whose limits are keys of their own section (`heartbeat.tools`), not of `wakes.kinds.<kind>`. */
const OWN_LIMITS: ReadonlyArray<string> = ['heartbeat', 'selfimprovement'];
const own = (kind: unknown): boolean => typeof kind === 'string' && OWN_LIMITS.includes(kind);
const capOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** What a wake kind lets her do in one turn: the tools named, and the caps (null: none). */
export type WakeEnvelope = {
  tools: '*' | Array<string>;
  maxActs: number | null;
  maxTasks: number | null;
  inputTokens: number | null;
};

/** One call of the turn so far, as the envelope counts it. */
export type WakeAction = { skill?: string; status?: string };

/**
 * The envelope of wake kind `kind` (`wakes.kinds.<kind>`, or the kind's own section for `heartbeat` and
 * `selfimprovement`, read now): `{ tools, maxActs, maxTasks, inputTokens }`,
 * `tools` `'*'` or a list of names; a missing or malformed value is today's behaviour (`'*'`, no cap).
 */
export function wakeEnvelope(config: unknown, kind: unknown): WakeEnvelope {
  const kinds = objOf(objOf(config).wakes).kinds;
  const given: Obj = own(kind)
    ? objOf(objOf(config)[String(kind)])
    : isObj(kinds) && typeof kind === 'string'
      ? objOf(kinds[kind])
      : {};
  const tools = Array.isArray(given.tools)
    ? given.tools.filter((name): name is string => typeof name === 'string' && name !== '')
    : '*';
  const tokens = given.inputTokens;
  return {
    tools,
    maxActs: capOf(given.maxActs),
    maxTasks: capOf(given.maxTasks),
    inputTokens: typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0 ? tokens : null,
  };
}

/** Whether `envelope.tools` names `skill` (`'*'`, the name itself, or `<family>.*`). */
export function envelopeAllows(envelope: { tools: '*' | ReadonlyArray<string> }, skill: string): boolean {
  if (envelope.tools === '*') return true;
  const family = skill.split('.')[0];
  return (
    namesFor(skill).some((name) => envelope.tools.includes(name)) ||
    envelope.tools.includes(`${family}.*`) ||
    envelope.tools.includes('*')
  );
}

/** A call that counts as done or proposed (src/behavior/turn.ts `innerActions`). */
const counted = (action: WakeAction | null | undefined): boolean =>
  action?.status === 'executed' || action?.status === 'proposed';

/**
 * Null when the wake envelope of `wakeKind` lets `skill` run now, else `{ allowed: false, reason: 'not-allowed', detail }`
 * (`detail`: the refusing setting, `wakes.kinds.<kind>.tools`, `maxActs` or `maxTasks`, or `<kind>.<field>` for a kind
 * of OWN_LIMITS). No wake kind (not an inner turn): null. `actions` are
 * the turn's calls so far (`{ skill, status }`): a call that changes something counts against `maxActs`, an errand
 * (`errand.run`) against `maxTasks`. With `nested` true only the allowlist is checked (the call itself was counted).
 */
export function wakeEnvelopeRefusal({
  config,
  wakeKind = null,
  skill,
  actions = null,
  nested = false,
}: {
  config: unknown;
  wakeKind?: string | null;
  skill: string;
  actions?: ReadonlyArray<WakeAction> | null;
  nested?: boolean;
}): SkillVerdict | null {
  if (typeof wakeKind !== 'string' || !wakeKind) return null;
  const envelope = wakeEnvelope(config, wakeKind);
  const deny = (key: string): SkillVerdict => ({
    allowed: false,
    reason: CODE.NOT_ALLOWED,
    detail: own(wakeKind) ? `${wakeKind}.${key}` : `wakes.kinds.${wakeKind}.${key}`,
  });
  if (!envelopeAllows(envelope, skill)) return deny('tools');
  if (nested) return null;
  const done = (actions ?? []).filter(counted);
  const changes = (name: string | undefined): boolean => (EFFECTS_OF.get(name ?? '') ?? 'write') !== 'read';
  if (
    envelope.maxActs !== null &&
    changes(skill) &&
    done.filter((action) => changes(action.skill)).length >= envelope.maxActs
  )
    return deny('maxActs');
  if (
    envelope.maxTasks !== null &&
    skill === 'errand.run' &&
    done.filter((action) => action.skill === 'errand.run').length >= envelope.maxTasks
  )
    return deny('maxTasks');
  return null;
}

/**
 * The envelope check of the capabilities `skill` reaches inside its operation (NESTED_CAPABILITIES), or of one
 * `capability` given: null, or the first refusal.
 */
export function nestedRefusal({
  config,
  wakeKind = null,
  skill = null,
  capability = null,
}: {
  config: unknown;
  wakeKind?: string | null;
  skill?: string | null;
  capability?: string | null;
}): SkillVerdict | null {
  const names: ReadonlyArray<string> = capability
    ? [capability]
    : skill !== null && Object.hasOwn(NESTED_CAPABILITIES, skill)
      ? (NESTED_CAPABILITIES[skill] ?? [])
      : [];
  for (const name of names) {
    const refusal = wakeEnvelopeRefusal({ config, wakeKind, skill: name, nested: true });
    if (refusal) return refusal;
  }
  return null;
}

/** True when `tools.safeMode` is exactly true. */
export function safeModeOn(config: unknown): boolean {
  return objOf(objOf(config).tools).safeMode === true;
}

/**
 * True when `bot.access[name]` grants the skill to the persona: its `users` list her user id
 * (`selfId`, ids compared as strings). No id, no stored grant or a malformed one: false. `config` is the live merged
 * config, `selfId` the bot's own user id, `name` a skill name (an operation's).
 */
export function grantedToPersona(config: unknown, selfId: string | null | undefined, name: string): boolean {
  if (selfId === undefined || selfId === null || selfId === '') return false;
  const access = objOf(objOf(config).bot).access;
  if (!isObj(access)) return false;
  return namesFor(name).some((key) => {
    const entry = Object.hasOwn(access, key) ? access[key] : null;
    return isObj(entry) && Array.isArray(entry.users) && entry.users.map(idText).includes(selfId);
  });
}

/**
 * Whether the persona may use `skill` now, before its arguments and targets are looked at:
 * `{ allowed, reason }` with, in order, `carried-over` (a
 * current tag aimed at the current chat: `chatId` absent or equal to
 * `currentChatId`), `safe-mode` (tools.safeMode: nothing else passes), `not-grantable`
 * (NOT_GRANTABLE_TO_PERSONA, whatever is stored), `allowed` (a
 * grant to her user id under its name, grantedToPersona), else `not-allowed`. An
 * owner-only skill is granted like any other: who may have it run is the requester's right
 * (src/tools/gateway.ts). On an inner turn (`wakeKind`) the wake envelope goes before the carried-over tags
 * (wakeEnvelopeRefusal over `wakeActions`, the turn's calls so far): `not-allowed` with its `detail`.
 */
export function skillAccess({
  skill,
  config,
  selfId = null,
  chatId = null,
  currentChatId = null,
  wakeKind = null,
  wakeActions = null,
}: {
  skill: { name: string };
  config: unknown;
  selfId?: string | null;
  chatId?: string | null;
  currentChatId?: string | null;
  wakeKind?: string | null;
  wakeActions?: ReadonlyArray<WakeAction> | null;
}): SkillVerdict {
  const envelope = wakeEnvelopeRefusal({ config, wakeKind, skill: skill.name, actions: wakeActions });
  if (envelope) return envelope;
  const target = chatId ?? currentChatId;
  const here =
    target === null || target === undefined ? currentChatId == null : idText(target) === idText(currentChatId);
  if (CARRIED_OVER.includes(skill.name) && here) return { allowed: true, reason: 'carried-over' };
  if (safeModeOn(config)) return { allowed: false, reason: CODE.SAFE_MODE };
  if (NOT_GRANTABLE_TO_PERSONA.includes(skill.name)) return { allowed: false, reason: CODE.NOT_GRANTABLE };
  if (grantedToPersona(config, selfId, skill.name)) return { allowed: true, reason: 'allowed' };
  return { allowed: false, reason: CODE.NOT_ALLOWED };
}
