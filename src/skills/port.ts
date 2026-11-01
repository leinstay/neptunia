// The skills port: the registry (src/memory/db/skills.ts) over the skill files and her grants, as her tools, the
// owner's `/skills` and an agent's commands use it. Every method but `record` and `sync` reads the folders first, so
// a file an agent wrote a moment ago is a pending version at once. Only an activation puts a version in her index,
// and the activation checks nothing about tools and grants none: availability follows her grants and the tool
// registry at the moment of the call and changes neither. `deps.load`, `granted`, `registered` and `reviewDays` are
// read at each call, never kept.

import { missingTools } from './index-block.ts';
import type { ActiveSkill, MissingTool } from './index-block.ts';
import { parseSkillFile } from './format.ts';
import type { LoadedSkill, SkillProblem } from './load.ts';
import {
  activateSkill,
  appendUses,
  listSkills,
  pendingVersions,
  rejectPending,
  reviewOf,
  reviewsDue,
  rollbackSkill,
  setDisabled,
  syncSkills,
} from '../memory/db/skills.ts';
import type { SkillRow, SkillUse, SkillsHandle, VersionView } from '../memory/db/skills.ts';

export type SkillListRow = SkillRow & { missing: Array<MissingTool>; reviewDue: boolean };

export type SkillsPort = {
  sync(): { skills: number; versions: number; stale: number };
  active(): Array<ActiveSkill>;
  list(): Array<SkillListRow>;
  show(name: string): { row: SkillListRow; text: string | null } | null;
  pending(): Array<VersionView & { skill: string }>;
  review(name: string): { active: VersionView | null; candidates: Array<VersionView> } | null;
  activate(name: string, by: string): ReturnType<typeof activateSkill>;
  rollback(name: string, by: string): ReturnType<typeof rollbackSkill>;
  reject(name: string, by: string): ReturnType<typeof rejectPending>;
  disable(name: string, by: string): ReturnType<typeof setDisabled>;
  enable(name: string, by: string): ReturnType<typeof setDisabled>;
  record(uses: ReadonlyArray<SkillUse>): number;
};

export function createSkillsPort(deps: {
  handle: SkillsHandle;
  now: () => number;
  load: () => { skills: Array<LoadedSkill>; problems: Array<SkillProblem> };
  granted: () => ReadonlySet<string>;
  registered: () => ReadonlySet<string>;
  reviewDays: () => number;
}): SkillsPort {
  const { handle } = deps;
  const state = () => ({ granted: deps.granted(), registered: deps.registered() });

  function sync(): { skills: number; versions: number; stale: number } {
    return syncSkills(handle, deps.load().skills, { at: deps.now() });
  }

  /** The rows of the registry with their availability and review mark, after a sync. */
  function rows(): Array<SkillListRow> {
    sync();
    const grants = state();
    const due = new Set(reviewsDue(handle, { now: deps.now(), days: deps.reviewDays() }).map((one) => one.skill));
    return listSkills(handle).map((row) => {
      // The version that would run: the active one, else the newest candidate.
      const running = row.active ?? reviewOf(handle, row.name)?.candidates.at(-1) ?? null;
      return { ...row, missing: missingTools(running?.tools ?? [], grants), reviewDue: due.has(row.name) };
    });
  }

  return {
    sync,
    active() {
      const out: Array<ActiveSkill> = [];
      for (const row of rows()) {
        if (row.active === null || row.disabled || row.lifecycle !== 'active') continue;
        const parsed = parseSkillFile(row.active.source);
        if (!parsed.ok) continue;
        out.push({
          name: row.name,
          description: parsed.skill.description,
          tools: parsed.skill.tools,
          versionId: row.active.versionId,
          source: row.active.source,
          missing: row.missing,
        });
      }
      return out;
    },
    list: rows,
    show(name) {
      const row = rows().find((one) => one.name === name);
      return row === undefined ? null : { row, text: row.active?.source ?? null };
    },
    pending() {
      sync();
      return pendingVersions(handle);
    },
    review(name) {
      sync();
      return reviewOf(handle, name);
    },
    activate(name, by) {
      sync();
      return activateSkill(handle, name, { at: deps.now(), by });
    },
    rollback(name, by) {
      sync();
      return rollbackSkill(handle, name, { at: deps.now(), by });
    },
    reject(name, by) {
      sync();
      return rejectPending(handle, name, { at: deps.now(), by });
    },
    disable(name, by) {
      sync();
      return setDisabled(handle, name, true, { at: deps.now(), by });
    },
    enable(name, by) {
      sync();
      return setDisabled(handle, name, false, { at: deps.now(), by });
    },
    record(uses) {
      return appendUses(handle, uses);
    },
  };
}
