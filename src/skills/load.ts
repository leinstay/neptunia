// Loads the skills from disk at the moment of use: `<localDir>/<name>/SKILL.md`, each call reading the folder anew. A
// folder without a `SKILL.md`, a README and any loose file are ignored; a
// file that does not parse, one whose `name` differs from its folder, one named like a tool (`toolNames`: a skill is an
// entry of the same tools array, so two functions would share a name), a package that cannot run or one holding a
// symbolic link (package.ts) is a problem and no skill, and never stops the others. A folder that is itself a link is
// ignored. The skills port (port.ts) is the caller.

import fs from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from './format.ts';
import { packageHasLink, packageHash, packageProblem, snapshotPackage } from './package.ts';
import type { PackageCode } from './package.ts';
import type { ParsedSkill, SkillFileCode } from './format.ts';

export type LoadedSkill = ParsedSkill & { dir: string };
export type SkillProblem = {
  dir: string;
  code: SkillFileCode | PackageCode | 'name-mismatch' | 'unreadable' | 'tool-name';
};

const FILE = 'SKILL.md';

export function loadSkills(folders: { localDir: string; toolNames?: ReadonlySet<string> }): {
  skills: Array<LoadedSkill>;
  problems: Array<SkillProblem>;
} {
  const root = folders.localDir;
  const toolNames = folders.toolNames ?? new Set<string>();
  const skills: Array<LoadedSkill> = [];
  const problems: Array<SkillProblem> = [];
  let entries: Array<fs.Dirent>;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No folder is no skill.
    return { skills, problems };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, FILE);
    if (packageHasLink(path.join(root, entry.name))) {
      problems.push({ dir: entry.name, code: 'symlink' });
      continue;
    }
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
    else if (toolNames.has(parsed.skill.name)) problems.push({ dir: entry.name, code: 'tool-name' });
    else {
      const skillDir = path.join(root, entry.name);
      const incomplete = packageProblem(skillDir);
      if (incomplete !== null) {
        problems.push({ dir: entry.name, code: incomplete });
        continue;
      }
      const contentHash = packageHash(skillDir, text, parsed.skill.contentHash);
      if (contentHash !== parsed.skill.contentHash) snapshotPackage(skillDir, text, contentHash);
      skills.push({ ...parsed.skill, contentHash, dir: entry.name });
    }
  }
  const byName = (a: { dir: string }, b: { dir: string }): number => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
  return { skills: skills.sort(byName), problems: problems.sort(byName) };
}
