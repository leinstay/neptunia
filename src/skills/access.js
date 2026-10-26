// The persona's access to her skills: two levels, allowed or not, granted the same way people's
// rights are -- `/nep access grant|revoke` (src/ops/access.js) with her (the bot's own user) as
// the target, stored in the same place, `bot.access[<skill name>].users` (src/ops/grants.js).
// Default deny; only a grant naming her user id opens a skill for her: a grant to everyone or to
// a role is people's and opens nothing for her, so no grant she could make for others widens her
// own rights. For her a grant may open an owner-only operation (it still runs only when an owner
// asks: src/skills/gateway.js), except the irreversible and administrative ones no grant opens
// for her yet (NOT_GRANTABLE_TO_PERSONA). Her reply tags of today are carried over without a grant, in the
// current conversation only, so nothing she does now is blocked (the skills design, "carry
// permissions over"): `<msg>` and `<gif>` are `message.create`, `<react>` is `message.react.add`,
// a picture is `draw.create` -- the operations the owner's `/nep message` and `/nep draw` run. Two switches, read by the caller from the live config: `features.skills`
// false refuses every skill, and `skills.safeMode` true lets only the carried-over tags pass; a
// skill behind a feature switch of its own (FEATURE_SKILLS) is refused while that switch is off.
// Wake envelopes (schema v11 stage, spec 2026-10-24-memory-schema-v7, sections 6 and 11): an inner turn's call is
// also checked against the envelope of its wake kind, `innerLife.wakes.<kind>` (`tools`: `"*"` or a list of skill
// names, `family.*` naming a family; `maxActs`: the most calls that change something per turn; `maxTasks`: the most
// errands per turn; `inputTokens`: the input budget the envelope declares). The default of every kind is `"*"` with no
// caps, today's behaviour. The check runs at the resolved call (skillAccess, through the gateway) and again where a
// skill reaches another capability inside its own operation (NESTED_CAPABILITIES: a picture or a voice message is a
// post), so a skill the envelope allows cannot post where the envelope forbids posting. A refusal is the access code
// `not-allowed` with the envelope's key as its reason.
// Pure over the live config the caller reads at the moment of use.

import { isPlainObject } from '../config.js';
import { CODE } from './codes.js';
import { SKILL_DEFINITIONS } from './definitions.js';

/** The skills behind the persona's current reply tags, allowed in the current conversation without a grant. */
export const CARRIED_OVER = Object.freeze(['message.create', 'message.react.add', 'draw.create', 'voice.say']);

/**
 * The operations no grant opens for the persona yet (the owner's decision, 2026-10-14): the
 * irreversible and the administrative ones. Refused by `/nep access grant` with her as the target
 * (a group or `*` skips them) and again at every call (skillAccess: `not-grantable`), whatever
 * is stored. Everything else -- owner-only operations included -- is grantable to her.
 */
export const NOT_GRANTABLE_TO_PERSONA = Object.freeze([
  'memory.restore',
  'rule.remove',
  'config.set',
  'config.unset',
  'model.set',
  'route.set',
  'route.remove',
  'access.grant',
  'access.revoke',
  'bot.pause',
  'bot.resume',
  // Her inner life's kill switch is the owner's alone (src/ops/inner.js).
  'inner.stop',
  'inner.start',
]);

/**
 * The skills that exist for the persona only while a feature switch is exactly true (skill name
 * -> `features.<key>`): off, they are refused (`feature-off`), never listed to her and never
 * offered to a classifier, so a request is as it was before them.
 */
export const FEATURE_SKILLS = Object.freeze(
  Object.fromEntries(
    SKILL_DEFINITIONS.filter((definition) => definition.feature !== null).map((definition) => [
      definition.name,
      definition.feature,
    ])
  )
);

/** The policy version of the wake envelopes (recorded on every wake run). */
export const WAKE_POLICY_VERSION = 1;

/**
 * The capabilities a skill reaches inside its own operation, as the skills that stand for them: a picture and a voice
 * message are posts (`message.create`). Checked against a wake's envelope before the operation runs and again where
 * it posts (src/skills/executors.js, src/ops/shared.js#postingConversation).
 */
export const NESTED_CAPABILITIES = Object.freeze({
  'draw.create': Object.freeze(['message.create']),
  'voice.say': Object.freeze(['message.create']),
});

const EFFECTS_OF = new Map(SKILL_DEFINITIONS.map((definition) => [definition.name, definition.effects]));
const capOf = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * The envelope of wake kind `kind` (`innerLife.wakes.<kind>`, read now): `{ tools, maxActs, maxTasks, inputTokens }`,
 * `tools` `'*'` or a list of names; a missing or malformed value is today's behaviour (`'*'`, no cap).
 */
export function wakeEnvelope(config, kind) {
  const given =
    isPlainObject(config?.innerLife?.wakes) && typeof kind === 'string' && isPlainObject(config.innerLife.wakes[kind])
      ? config.innerLife.wakes[kind]
      : {};
  const tools = Array.isArray(given.tools) ? given.tools.filter((name) => typeof name === 'string' && name) : '*';
  return {
    tools,
    maxActs: capOf(given.maxActs),
    maxTasks: capOf(given.maxTasks),
    inputTokens: Number.isInteger(given.inputTokens) && given.inputTokens > 0 ? given.inputTokens : null,
  };
}

/** Whether `envelope.tools` names `skill` (`'*'`, the name itself, or `<family>.*`). */
export function envelopeAllows(envelope, skill) {
  if (envelope.tools === '*') return true;
  const family = String(skill).split('.')[0];
  return envelope.tools.includes(skill) || envelope.tools.includes(`${family}.*`) || envelope.tools.includes('*');
}

/** A call that counts as done or proposed (src/behavior/turn.js `innerActions`). */
const counted = (action) => action && (action.status === 'executed' || action.status === 'proposed');

/**
 * Null when the wake envelope of `wakeKind` lets `skill` run now, else `{ allowed: false, reason: 'not-allowed', detail }`
 * (`detail`: `innerLife.wakes.<kind>.tools|maxActs|maxTasks`). No wake kind (not an inner turn): null. `actions` are
 * the turn's calls so far (`{ skill, status }`): a call that changes something counts against `maxActs`, an errand
 * (`task.run`) against `maxTasks`. With `nested` true only the allowlist is checked (the call itself was counted).
 */
export function wakeEnvelopeRefusal({ config, wakeKind = null, skill, actions = null, nested = false }) {
  if (typeof wakeKind !== 'string' || !wakeKind) return null;
  const envelope = wakeEnvelope(config, wakeKind);
  const deny = (key) => ({ allowed: false, reason: CODE.NOT_ALLOWED, detail: `innerLife.wakes.${wakeKind}.${key}` });
  if (!envelopeAllows(envelope, skill)) return deny('tools');
  if (nested) return null;
  const done = (Array.isArray(actions) ? actions : []).filter(counted);
  if (
    envelope.maxActs !== null &&
    (EFFECTS_OF.get(skill) ?? 'write') !== 'read' &&
    done.filter((action) => (EFFECTS_OF.get(action.skill) ?? 'write') !== 'read').length >= envelope.maxActs
  )
    return deny('maxActs');
  if (
    envelope.maxTasks !== null &&
    skill === 'task.run' &&
    done.filter((action) => action.skill === 'task.run').length >= envelope.maxTasks
  )
    return deny('maxTasks');
  return null;
}

/**
 * The envelope check of the capabilities `skill` reaches inside its operation (NESTED_CAPABILITIES), or of one
 * `capability` given: null, or the first refusal.
 */
export function nestedRefusal({ config, wakeKind = null, skill = null, capability = null }) {
  const names = capability ? [capability] : (NESTED_CAPABILITIES[skill] ?? []);
  for (const name of names) {
    const refusal = wakeEnvelopeRefusal({ config, wakeKind, skill: name, nested: true });
    if (refusal) return refusal;
  }
  return null;
}

/** Whether skill `name` exists now: no switch of its own (FEATURE_SKILLS), or its switch exactly true. */
export function skillFeatureOn(name, config) {
  const key = Object.hasOwn(FEATURE_SKILLS, name) ? FEATURE_SKILLS[name] : null;
  return key === null || config?.features?.[key] === true;
}

/** True when `features.skills` is not false (a missing key counts as on). */
export function skillsOn(config) {
  return config?.features?.skills !== false;
}

/** True when `skills.safeMode` is exactly true. */
export function safeModeOn(config) {
  return config?.skills?.safeMode === true;
}

/**
 * True when `bot.access[name]` grants the skill to the persona: its `users` list her user id
 * (`selfId`, ids compared as strings). No id, no stored grant or a malformed one: false.
 * @param {object} config  The live merged config.
 * @param {string|null|undefined} selfId  The bot's own user id.
 * @param {string} name  A skill name (an operation's).
 * @returns {boolean}
 */
export function grantedToPersona(config, selfId, name) {
  if (selfId === undefined || selfId === null || selfId === '') return false;
  const access = config?.bot?.access;
  const entry = isPlainObject(access) && Object.hasOwn(access, name) ? access[name] : null;
  return isPlainObject(entry) && Array.isArray(entry.users) && entry.users.map(String).includes(String(selfId));
}

/**
 * Whether the persona may use `skill` now, before its arguments and targets are looked at:
 * `{ allowed, reason }` with, in order, `skills-off` (features.skills false), `carried-over` (a
 * current tag aimed at the current conversation: `conversationId` absent or equal to
 * `currentConversationId`), `safe-mode` (skills.safeMode: nothing else passes), `not-grantable`
 * (NOT_GRANTABLE_TO_PERSONA, whatever is stored), `allowed` (a
 * grant to her user id under its name, grantedToPersona), else `not-allowed`. An
 * owner-only skill is granted like any other: who may have it run is the requester's right
 * (src/skills/gateway.js). On an inner turn (`wakeKind`) the wake envelope goes before the carried-over tags
 * (wakeEnvelopeRefusal over `wakeActions`, the turn's calls so far): `not-allowed` with its `detail`.
 * @param {{ skill: object, config: object, selfId?: string|null, conversationId?: string|null, currentConversationId?: string|null,
 *   wakeKind?: string|null, wakeActions?: object[]|null }} args
 * @returns {{ allowed: boolean, reason: string, detail?: string }}
 */
export function skillAccess({
  skill,
  config,
  selfId = null,
  conversationId = null,
  currentConversationId = null,
  wakeKind = null,
  wakeActions = null,
}) {
  if (!skillsOn(config)) return { allowed: false, reason: CODE.SKILLS_OFF };
  if (!skillFeatureOn(skill.name, config)) return { allowed: false, reason: CODE.FEATURE_OFF };
  const envelope = wakeEnvelopeRefusal({ config, wakeKind, skill: skill.name, actions: wakeActions });
  if (envelope) return envelope;
  const target = conversationId ?? currentConversationId;
  const here =
    target === null || target === undefined
      ? currentConversationId == null
      : String(target) === String(currentConversationId);
  if (CARRIED_OVER.includes(skill.name) && here) return { allowed: true, reason: 'carried-over' };
  if (safeModeOn(config)) return { allowed: false, reason: CODE.SAFE_MODE };
  if (NOT_GRANTABLE_TO_PERSONA.includes(skill.name)) return { allowed: false, reason: CODE.NOT_GRANTABLE };
  if (grantedToPersona(config, selfId, skill.name)) return { allowed: true, reason: 'allowed' };
  return { allowed: false, reason: CODE.NOT_ALLOWED };
}
