// Her active skills as the skills port gives them, each with what keeps her from using it: `missingTools` names the tools
// of a skill that are not registered or not granted, for `/skills` to show. A skill with nothing missing is an entry of
// her tools array (src/tools/tools-json.ts#skillEntries).

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
