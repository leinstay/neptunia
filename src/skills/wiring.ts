// The core's skills, wired once (src/core.ts calls it): the access over the memory writer (client.ts), the index of her
// active skills for a request with the list of what it showed, and the sources of the selfimprovement wake's facts that
// concern skills and the board. The skill folders are `skills/` in the checkout (tracked) and `skills.local/` in the
// private layer; both are read at each call, and the grants, the labels and `skills.reviewDays` are read from `hot` at
// the moment of use, never kept.

import path from 'node:path';
import { proposalsOf, ackOutbox } from '../behavior/selfimprovement-view.ts';
import { landedFor } from '../selfimprovement/landed.ts';
import type { SelfimprovementSources } from '../behavior/inner/types.ts';
import { SKILL_USE_KINDS, listSkills, useCountsBySkill } from '../memory/db/skills.ts';
import type { SkillUse, SkillsUpdate, UseCounts } from '../memory/db/skills.ts';
import { grantedSkillNames } from '../tools/discovery.ts';
import type { BoardCaller } from '../tools/impl/board.ts';
import { skillRegistry } from '../tools/registry.ts';
import { objOf } from '../tools/types.ts';
import { createSkillsClient } from './client.ts';
import { skillIndexBlock } from './index-block.ts';
import { loadSkills } from './load.ts';
import type { SkillsAccess } from './port.ts';
import { skillsSettings } from './settings.ts';
import type { IndexedSkill } from './uses.ts';

export type SkillsWiring = {
  access: SkillsAccess;
  /** The body of `<skills>` and the skills it showed; null when none is shown. Never throws. */
  index: () => Promise<{ text: string; indexed: Array<IndexedSkill> } | null>;
  /** Writes the use rows of a turn; resolves how many were written. */
  record: (uses: ReadonlyArray<SkillUse>) => Promise<number>;
  selfimprovement: Pick<SelfimprovementSources, 'granted' | 'skills' | 'proposals' | 'ackOutbox' | 'landed'>;
};

/** The tool that opens a line of the index; without her grant of it the index is not shown. */
const READ_TOOL = 'skill.read';

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
  const access = createSkillsClient({
    write: (update) => memoryDb.memoryWrite(update),
    read: () => {
      const db = memoryDb.database();
      return db === null ? null : { db };
    },
    now: deps.now,
    load: () =>
      loadSkills({
        localDir: path.join(deps.privateDir, 'skills'),
      }),
    granted: () => new Set(granted()),
    registered: () => new Set(skillRegistry().keys()),
    reviewDays: () => skillsSettings(hot.config).reviewDays,
  });
  return {
    access,
    record: async (uses) => access.record(uses),
    index: async () => {
      try {
        const labels = objOf(objOf(objOf(hot.prompts).labels).skills);
        if (!granted().includes(READ_TOOL) || typeof labels.index !== 'string' || typeof labels.line !== 'string') {
          return null;
        }
        const active = await access.active();
        const text = skillIndexBlock(active, { index: labels.index, line: labels.line });
        if (text === '') return null;
        const shown = active.filter((skill) => skill.missing.length === 0);
        return { text, indexed: shown.map(({ name, versionId, tools }) => ({ name, versionId, tools })) };
      } catch (error) {
        deps.log.warn('skills: index failed', { error });
        return null;
      }
    },
    selfimprovement: {
      granted,
      skills(since) {
        const db = memoryDb.database();
        if (db === null) return [];
        const counts = useCountsBySkill({ db }, { since });
        const none = Object.fromEntries(SKILL_USE_KINDS.map((kind) => [kind, 0])) as UseCounts;
        return listSkills({ db }).map((row) => ({
          name: row.name,
          active: row.active !== null && !row.disabled,
          counts: counts[row.name] ?? none,
        }));
      },
      proposals: () => proposalsOf(deps.board),
      ackOutbox: (seqs) => ackOutbox(deps.board, seqs),
      landed: async () => (await landedFor(deps.board)).landed,
    },
  };
}
