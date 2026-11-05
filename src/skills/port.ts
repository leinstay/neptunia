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
  activateNamedVersion,
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
  /** The skill folders the loader refused, with the reason. */
  problems(): Array<SkillProblem>;
  show(name: string): { row: SkillListRow; text: string | null } | null;
  pending(): Array<VersionView & { skill: string }>;
  review(name: string): { active: VersionView | null; candidates: Array<VersionView> } | null;
  activate(name: string, by: string): ReturnType<typeof activateSkill>;
  /** Activates exactly this version of `name`, as a task's settlement does (task-activation.ts). */
  activateVersion(
    name: string,
    versionId: string,
    by: string
  ): ReturnType<typeof activateNamedVersion> | { ok: false; code: 'db-closed' };
  rollback(name: string, by: string): ReturnType<typeof rollbackSkill>;
  reject(name: string, by: string): ReturnType<typeof rejectPending>;
  disable(name: string, by: string): ReturnType<typeof setDisabled>;
  enable(name: string, by: string): ReturnType<typeof setDisabled>;
  record(uses: ReadonlyArray<SkillUse>): number;
};

/**
 * The port as its callers hold it: each method answers at once (the port over a handle) or later (the core's client
 * over the memory writer, client.ts). A caller awaits every answer.
 */
export type SkillsAccess = {
  [TMethod in keyof SkillsPort]: (
    ...args: Parameters<SkillsPort[TMethod]>
  ) => ReturnType<SkillsPort[TMethod]> | Promise<ReturnType<SkillsPort[TMethod]>>;
};

/** What the reading side needs from the world: the grants and the tool registry now, the review window, the clock. */
export type SkillsReadDeps = {
  now: () => number;
  granted: () => ReadonlySet<string>;
  registered: () => ReadonlySet<string>;
  reviewDays: () => number;
};

/** The reads of the registry over any connection with a `db` (the writer's, or the core's read connection). */
export type SkillsReads = {
  list(): Array<SkillListRow>;
  active(): Array<ActiveSkill>;
  show(name: string): { row: SkillListRow; text: string | null } | null;
  pending(): Array<VersionView & { skill: string }>;
  review(name: string): { active: VersionView | null; candidates: Array<VersionView> } | null;
};

/** The reads of `handle`, each answering from what the registry holds at that moment. */
export function skillsReads(handle: { db: object }, deps: SkillsReadDeps): SkillsReads {
  function list(): Array<SkillListRow> {
    const grants = { granted: deps.granted(), registered: deps.registered() };
    const due = new Set(reviewsDue(handle, { now: deps.now(), days: deps.reviewDays() }).map((one) => one.skill));
    return listSkills(handle).map((row) => {
      // The version that would run: the active one, else the newest candidate.
      const running = row.active ?? reviewOf(handle, row.name)?.candidates.at(-1) ?? null;
      return { ...row, missing: missingTools(running?.tools ?? [], grants), reviewDue: due.has(row.name) };
    });
  }
  return {
    list,
    active() {
      const out: Array<ActiveSkill> = [];
      for (const row of list()) {
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
    show(name) {
      const row = list().find((one) => one.name === name);
      return row === undefined ? null : { row, text: row.active?.source ?? null };
    },
    pending: () => pendingVersions(handle),
    review: (name) => reviewOf(handle, name),
  };
}

export function createSkillsPort(deps: {
  handle: SkillsHandle;
  now: () => number;
  load: () => { skills: Array<LoadedSkill>; problems: Array<SkillProblem> };
  granted: () => ReadonlySet<string>;
  registered: () => ReadonlySet<string>;
  reviewDays: () => number;
}): SkillsPort {
  const { handle } = deps;
  const reads = skillsReads(handle, deps);

  function sync(): { skills: number; versions: number; stale: number } {
    return syncSkills(handle, deps.load().skills, { at: deps.now() });
  }

  return {
    sync,
    active() {
      sync();
      return reads.active();
    },
    list() {
      sync();
      return reads.list();
    },
    problems: () => deps.load().problems,
    show(name) {
      sync();
      return reads.show(name);
    },
    pending() {
      sync();
      return reads.pending();
    },
    review(name) {
      sync();
      return reads.review(name);
    },
    activate(name, by) {
      sync();
      return activateSkill(handle, name, { at: deps.now(), by });
    },
    activateVersion(name, versionId, by) {
      sync();
      return activateNamedVersion(handle, name, versionId, { at: deps.now(), by });
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
