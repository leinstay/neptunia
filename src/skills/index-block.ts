// Her skill index: the body of the `<skills>` block, one line per skill she can use now, in her words. A skill whose
// tools are not all registered and granted is left out, and `missingTools` names what is missing and why, for
// `/skills` to show. The labels (`skills.index`, `skills.line` in prompts/labels.json) are handed in; the request
// builder (src/turn/request/) adds the tag.

import { fill } from '../format.js';

export type MissingTool = { tool: string; reason: 'not-registered' | 'not-granted' };
export type ActiveSkill = {
  name: string;
  description: string;
  tools: Array<string>;
  versionId: string;
  source: string;
  missing: Array<MissingTool>;
};

/** Each tool of `tools`, in order, that is not registered, else not granted. */
export function missingTools(
  tools: ReadonlyArray<string>,
  state: { granted: ReadonlySet<string>; registered: ReadonlySet<string> }
): Array<MissingTool> {
  const missing: Array<MissingTool> = [];
  for (const tool of tools) {
    if (!state.registered.has(tool)) missing.push({ tool, reason: 'not-registered' });
    else if (!state.granted.has(tool)) missing.push({ tool, reason: 'not-granted' });
  }
  return missing;
}

/** The header and one line per usable skill, or '' when none is usable. */
export function skillIndexBlock(skills: ReadonlyArray<ActiveSkill>, labels: { index: string; line: string }): string {
  const usable = skills.filter((skill) => skill.missing.length === 0);
  if (usable.length === 0) return '';
  return [
    labels.index,
    ...usable.map((skill) => fill(labels.line, { name: skill.name, description: skill.description })),
  ].join('\n');
}
