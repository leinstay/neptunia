// The oracle of the skills table: the skill definitions the owner's command tree derives
// (tests/oracles/skills-derive.js), adapted to the shape the registry loads (src/skills/registry.js#loadSkills:
// `dispatch` in place of `command`). Tests only.

import { deriveSkillDefinitions, commandSources } from './skills-derive.js';

/** One derived definition in the registry's shape: `command` becomes `dispatch` (`toOp` for `toCall`, no key). */
export function adaptDerived(definition) {
  const { command, ...rest } = definition;
  if (!command) return rest;
  return {
    ...rest,
    dispatch: Object.freeze({
      op: definition.op,
      body: command.body,
      options: command.options,
      toOp(given) {
        const call = command.toCall(given);
        return { op: call.op, args: call.args };
      },
    }),
  };
}

/** The definitions derived from a command tree, adapted. */
export function derivedDefinitions({ ops, table, resolve }) {
  return deriveSkillDefinitions({ ops, sources: commandSources({ table, resolve }), resolve }).map(adaptDerived);
}

/** The feature switches of the skills as access.js listed them before the table, copied here. */
export const ORACLE_FEATURE_SKILLS = Object.freeze({
  'intent.set': 'intentions',
  'intent.update': 'intentions',
  'intent.cancel': 'intentions',
  'intent.list': 'intentions',
  'inner.stop': 'innerLife',
  'inner.start': 'innerLife',
  'inner.status': 'innerLife',
  'media.look': 'coreTools',
  'media.find': 'coreTools',
});

/** The definitions with the feature switch of each, as the registry carries it. */
export function withFeatures(definitions) {
  return definitions.map((definition) => ({ ...definition, feature: Object.hasOwn(ORACLE_FEATURE_SKILLS, definition.name) ? ORACLE_FEATURE_SKILLS[definition.name] : null }));
}
