// Operations: `/nep skill allow|deny|list`: the owner opens or closes one of the persona's skills
// (src/skills/registry.js). Two levels only: a skill is allowed or not; a "yes" in chat never
// grants anything, only this command, whose caller Discord authenticated, checked against
// `bot.owners` by runOp and again here. The record lives in state.json (`skills.allowed`,
// src/skills/access.js); every change is journaled as a `system` record `skill-access`. Allowing
// runs nothing: a request made before the allow is never replayed.

import { isOwnerId } from '../discord/access.js';
import { log } from '../log.js';
import { skillRegistry } from '../skills/registry.js';
import { CARRIED_OVER, allowSkill, allowedSkills, denySkill, safeModeOn, skillsOn } from '../skills/access.js';
import { defineOp, perEnv, invalid, denied } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, store, now, assertNotPaused, resolvedGuildId, journalSystem } = env;

  /** The caller, refused unless an owner (read now): the handler's own check behind runOp's. */
  function requireOwner(name, context) {
    if (!isOwnerId(hot.config, context?.userId)) throw denied(`${name} is owner-only`);
    return String(context.userId);
  }

  /** The registry skill `args.name`, or an `invalid` error. */
  function requireSkill(args) {
    const name = String(args?.name ?? '').trim();
    if (!name) throw invalid('a skill name is required');
    const skill = skillRegistry().get(name);
    if (!skill) throw invalid(`unknown skill: ${name}`, 'unknown-skill');
    return skill;
  }

  /** The access change written now (state.json flushed) and journaled. */
  async function record(skill, allowed, by, context) {
    store.state.markDirty();
    store.flush?.();
    log.info('skills: access changed', { name: skill.name, allowed, userId: by });
    await journalSystem(resolvedGuildId(context), { event: 'skill-access', skill: skill.name, allowed, by });
  }

  async function cmdSkillAllow(args, context) {
    const by = requireOwner('skill.allow', context);
    const skill = requireSkill(args);
    assertNotPaused();
    allowSkill(store.state.data, skill.name, { by, at: new Date(now()).toISOString() });
    await record(skill, true, by, context);
    return `Allowed ${skill.name} for the persona`;
  }

  async function cmdSkillDeny(args, context) {
    const by = requireOwner('skill.deny', context);
    const skill = requireSkill(args);
    assertNotPaused();
    const carried = CARRIED_OVER.includes(skill.name) ? ' (still carried over in the current conversation)' : '';
    if (!denySkill(store.state.data, skill.name)) return `${skill.name} was not allowed${carried}`;
    await record(skill, false, by, context);
    return `Denied ${skill.name} for the persona${carried}`;
  }

  /** Every registry skill with its access and why: owner-only, carried over, allowed by whom when, or not allowed. */
  function cmdSkillList(args, context) {
    requireOwner('skill.list', context);
    const config = hot.config;
    const records = allowedSkills(store.state.data);
    const lines = [];
    if (!skillsOn(config)) lines.push('features.skills is off: every skill is refused');
    else if (safeModeOn(config)) lines.push('skills.safeMode is on: only the carried-over reply tags pass');
    for (const skill of skillRegistry().values()) {
      const record = records[skill.name];
      const carried = CARRIED_OVER.includes(skill.name);
      let state;
      if (skill.ownerOnly) state = 'owner-only';
      else if (record) state = `allowed by user id:${record.by} at ${record.at}${carried ? '; carried over in the current conversation' : ''}`;
      else if (carried) state = 'carried over (current conversation only)';
      else state = 'not allowed';
      lines.push(`${skill.name}: ${state}`);
    }
    return lines.join('\n');
  }

  return { cmdSkillAllow, cmdSkillDeny, cmdSkillList };
});

defineOp({
  name: 'skill.allow',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdSkillAllow(args, ctx),
});
defineOp({
  name: 'skill.deny',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdSkillDeny(args, ctx),
});
defineOp({
  name: 'skill.list',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdSkillList(args, ctx),
});
