// Operations: `/nep task skills name` -- her read skill `skills.describe`: one skill in full (its
// title, when to use it, when not to, its arguments and whether it is switched on for her), or a
// family (`memory`, `intent`, ...) as one line per skill. The text is the very rendering a core row of
// her tool list gets (src/behavior/prompt.js#skillsInventoryText over src/tools/discovery.ts#describeRows),
// from the registry and the skills layer read now. A name that is no skill is `unknown-skill` with the closest
// skill names (`labels.skills.tools.describe.closest`). A read, open to every member while
// features.memberCommands is on, as the search tools are.

import { fill } from '../../format.js';
import { skillsInventoryText } from '../../behavior/prompt.js';
import { describeRows } from '../discovery.ts';
import { skillRegistry } from '../registry.ts';
import { CODE } from '../codes.ts';
import { defineOp, perEnv, invalid } from './registry.ts';

const handlers = perEnv((env) => {
  const { hot } = env;

  /** `/nep task skills name`. */
  function cmdDescribe(args) {
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) throw invalid('name: a skill name or a family');
    const labels = hot.prompts?.labels ?? {};
    const { rows, closest } = describeRows({
      config: hot.config,
      selfId: env.selfId() ?? null,
      registry: skillRegistry(),
      texts: hot.prompts?.skills,
      name,
    });
    if (rows.length === 0) {
      const label = labels.skills?.tools?.describe?.closest;
      const text =
        closest.length > 0 && typeof label === 'string' && label ? fill(label, { names: closest.join(', ') }) : '';
      return { status: 'invalid', code: CODE.UNKNOWN_SKILL, summary: text, data: { text, closest } };
    }
    const text = skillsInventoryText(rows, labels);
    return { status: 'ok', code: CODE.OK, summary: text, data: { text, rows } };
  }

  return { cmdDescribe };
});

defineOp({
  name: 'skills.describe',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdDescribe(args, ctx),
});
