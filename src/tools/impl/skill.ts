// Operations `skill.read` and `skill.disable`: her side of her skills (src/skills/). `skill.read { name }` answers the
// whole stored text of the active version of a skill, the text she was shown a line of in `<skills>`. `skill.disable
// { name }` is her own switch: the skill leaves her index until the owner brings it back with `/skills enable`. Both
// run against the skills the core gives the operations' environment (`env.skills`); a core with none answers
// `failed`. Neither is granted to her in the tracked config: the owner opens them with `/tools grant`. A skill that
// is not active or is disabled cannot be read.

import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { textOf } from '../types.ts';
import type { Obj } from '../types.ts';

const unavailable = () => ({
  status: 'failed',
  code: CODE.NOT_CONFIGURED,
  summary: 'skills: not available here',
  data: null,
});

const handlers = perEnv((env) => {
  /** The skill name of the arguments, or the refusal of a call without one. */
  function nameOf(args: Obj): string {
    const name = textOf(args.name).trim();
    if (!name) throw invalid('name: the skill to use');
    return name;
  }

  async function cmdRead(args: Obj) {
    const name = nameOf(args);
    const skills = env.skills;
    if (skills == null) return unavailable();
    const shown = await skills.show(name);
    const active = shown?.row.active ?? null;
    if (shown === null || active === null || shown.text === null || shown.row.disabled) {
      return { status: 'failed', code: CODE.NOT_FOUND, summary: `no active skill named ${name}`, data: null };
    }
    return {
      status: 'ok',
      code: CODE.OK,
      summary: shown.text,
      data: { name, versionId: active.versionId, text: shown.text },
    };
  }

  async function cmdDisable(args: Obj) {
    const name = nameOf(args);
    const skills = env.skills;
    if (skills == null) return unavailable();
    const done = await skills.disable(name, 'persona');
    if (!done.ok) {
      return { status: 'failed', code: CODE.NOT_FOUND, summary: `no skill named ${name}`, data: null };
    }
    const text = done.changed ? `${name} is off for you until the owner turns it on` : `${name} was already off`;
    return { status: 'ok', code: CODE.OK, summary: text, data: { name, changed: done.changed } };
  }

  return { cmdRead, cmdDisable };
});

defineOp({
  name: 'skill.read',
  rights: { kind: 'read', member: false },
  run: (args, ctx) => handlers(ctx.env).cmdRead(args),
});
defineOp({
  name: 'skill.disable',
  rights: { kind: 'write', member: false },
  run: (args, ctx) => handlers(ctx.env).cmdDisable(args),
});
