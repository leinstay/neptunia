// Loads the skills from disk at the moment of use: `<trackedDir>/<name>/SKILL.md` for the tracked layer and
// `<localDir>/<name>/SKILL.md` for the local one, each call reading the folders anew. A local skill replaces the
// tracked skill of the same name whole. A folder without a `SKILL.md`, a README and any loose file are ignored; a
// file that does not parse, or whose `name` differs from its folder, is a problem and no skill, and never stops the
// others. The skills port (port.ts) is the caller.

import fs from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from './format.ts';
import { packageHash, snapshotPackage } from './package.ts';
import type { ParsedSkill, SkillFileCode } from './format.ts';

export type LoadedSkill = ParsedSkill & { layer: 'tracked' | 'local'; dir: string };
export type SkillProblem = { dir: string; code: SkillFileCode | 'name-mismatch' | 'unreadable' };

const FILE = 'SKILL.md';

/** The skills and problems of one layer's folder; a missing folder holds nothing. */
function readLayer(
  root: string,
  layer: 'tracked' | 'local'
): { skills: Array<LoadedSkill>; problems: Array<SkillProblem> } {
  const skills: Array<LoadedSkill> = [];
  const problems: Array<SkillProblem> = [];
  let entries: Array<fs.Dirent>;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No folder is no skill of this layer.
    return { skills, problems };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, FILE);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // A folder with no SKILL.md is not a skill; one that cannot be read is named.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push({ dir: entry.name, code: 'unreadable' });
      continue;
    }
    const parsed = parseSkillFile(text);
    if (!parsed.ok) problems.push({ dir: entry.name, code: parsed.code });
    else if (parsed.skill.name !== entry.name) problems.push({ dir: entry.name, code: 'name-mismatch' });
    else {
      const skillDir = path.join(root, entry.name);
      const contentHash = packageHash(skillDir, text, parsed.skill.contentHash);
      if (contentHash !== parsed.skill.contentHash) snapshotPackage(skillDir, text, contentHash);
      skills.push({ ...parsed.skill, contentHash, layer, dir: entry.name });
    }
  }
  return { skills, problems };
}

export function loadSkills(folders: { trackedDir?: string; localDir: string }): {
  skills: Array<LoadedSkill>;
  problems: Array<SkillProblem>;
} {
  const tracked =
    folders.trackedDir === undefined ? { skills: [], problems: [] } : readLayer(folders.trackedDir, 'tracked');
  const local = readLayer(folders.localDir, 'local');
  const byName = new Map<string, LoadedSkill>();
  for (const skill of [...tracked.skills, ...local.skills]) byName.set(skill.name, skill);
  const skills = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const problems = [...tracked.problems, ...local.problems].sort((a, b) =>
    a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
  );
  return { skills, problems };
}
