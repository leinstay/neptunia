// The core's skills, wired once (src/core.ts calls it): the access over the memory writer (client.ts), her active skills
// for the tools array of a request and the sweep that settles her done skill tasks (task-activation.ts). The packages
// are `<data>/skills/<name>/`, read at each call, and the grants, the labels and `skills.reviewDays` are read from `hot` at
// the moment of use, never kept.

import path from 'node:path';
import type { SkillUse, SkillsUpdate } from '../memory/db/skills.ts';
import { apiNameOf } from '../tools/definitions.ts';
import { grantedSkillNames } from '../tools/discovery.ts';
import type { BoardCaller } from '../board/writer.ts';
import { skillRegistry } from '../tools/registry.ts';
import { createSkillsClient } from './client.ts';
import type { ActiveSkill } from './index-block.ts';
import { loadSkills } from './load.ts';
import type { SkillsAccess } from './port.ts';
import { skillsSettings } from './settings.ts';
import { settleSkillTasks } from './task-activation.ts';
import type { SettledTask } from './task-activation.ts';

export type SkillsWiring = {
  access: SkillsAccess;
  /** Her active skills, those with a tool missing too; none when they cannot be read. Never throws. */
  active: () => Promise<ReadonlyArray<ActiveSkill>>;
  /** Writes the use rows of a turn; resolves how many were written. */
  record: (uses: ReadonlyArray<SkillUse>) => Promise<number>;
  /** One sweep over her done skill tasks, as the board's `development` principal. */
  settle: () => Promise<Array<SettledTask>>;
};

/** Every name a tool answers to, dotted and as the tools array names it: a skill may take none of them. */
function toolNames(): Set<string> {
  const names = new Set<string>();
  for (const [name, skill] of skillRegistry()) {
    names.add(name);
    const api = skill.api ?? apiNameOf(name);
    if (api) names.add(api);
  }
  return names;
}

export type SkillsWiringDeps = {
  hot: { readonly config: unknown; readonly prompts?: unknown };
  memoryDb: { memoryWrite(update: SkillsUpdate): Promise<unknown>; database(): object | null };
  board: BoardCaller;
  selfId: () => string | null;
  rootDir: string;
  privateDir: string;
  now: () => number;
  log: { warn(message: string, fields: Record<string, unknown>): void };
};

export function wireSkills(deps: SkillsWiringDeps): SkillsWiring {
  const { hot, memoryDb } = deps;
  const granted = (): Array<string> =>
    grantedSkillNames({ config: hot.config, selfId: deps.selfId(), registry: skillRegistry() });
  // A skill named like a tool is refused at every load and logged once per folder while the process runs.
  const toolNamed = new Set<string>();
  const load = (): ReturnType<typeof loadSkills> => {
    const loaded = loadSkills({ localDir: path.join(deps.privateDir, 'skills'), toolNames: toolNames() });
    for (const problem of loaded.problems)
      if (problem.code === 'tool-name' && !toolNamed.has(problem.dir)) {
        toolNamed.add(problem.dir);
        deps.log.warn('skills: refused at load', { skill: problem.dir, code: problem.code });
      }
    return loaded;
  };
  const access = createSkillsClient({
    write: (update) => memoryDb.memoryWrite(update),
    read: () => {
      const db = memoryDb.database();
      return db === null ? null : { db };
    },
    now: deps.now,
    load,
    granted: () => new Set(granted()),
    registered: () => new Set(skillRegistry().keys()),
    reviewDays: () => skillsSettings(hot.config).reviewDays,
  });
  return {
    access,
    record: async (uses) => access.record(uses),
    // Nothing to settle while the memory database is not open, as with the reaper's beat beside it in src/core.ts.
    settle: async () =>
      memoryDb.database() === null
        ? []
        : await settleSkillTasks({ skills: access, board: deps.board, principal: 'development' }),
    active: async () => {
      try {
        return await access.active();
      } catch (error) {
        deps.log.warn('skills: active not read', { error });
        return [];
      }
    },
  };
}
