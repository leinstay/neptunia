// The skills access of the running core: the same calls as the port over a handle (port.ts), each answered later. The
// core holds no writer connection, so every change is one `skills` write of the memory writer
// (src/memory/db/skills.ts#applySkillsWrite) carrying what only the core knows: the skill files it read now and the
// clock. Reads take the core's read connection after a sync write, and the grants and the tool registry are read at the
// call, as the port reads them. A memory database that is not open answers nothing: lists are empty and a change is
// refused with `db-closed`.

import type { SkillUse, SkillsUpdate } from '../memory/db/skills.ts';
import type { LoadedSkill, SkillProblem } from './load.ts';
import { skillsReads } from './port.ts';
import type { SkillsAccess, SkillsReadDeps } from './port.ts';

/** The refusal of a change while the memory database is closed. */
const CLOSED = { ok: false, code: 'db-closed' } as const;

export function createSkillsClient(
  deps: SkillsReadDeps & {
    /** One skills write of the memory writer; rejects when the database is not open. */
    write: (update: SkillsUpdate) => Promise<unknown>;
    /** The core's read connection, null while the database is closed. */
    read: () => { db: object } | null;
    load: () => { skills: Array<LoadedSkill>; problems: Array<SkillProblem> };
  }
): SkillsAccess {
  const sync = async (): Promise<{ skills: number; versions: number; stale: number }> => {
    const files = deps.load().skills.map(({ name, tools, task, contentHash, source }) => ({
      name,
      tools,
      task,
      contentHash,
      source,
    }));
    try {
      return (await deps.write({ kind: 'skills', op: 'sync', files, at: deps.now() })) as {
        skills: number;
        versions: number;
        stale: number;
      };
    } catch {
      // A closed database registers nothing; the reads below answer from what it holds, which is nothing.
      return { skills: 0, versions: 0, stale: 0 };
    }
  };
  /** The reads over the read connection, or null while the database is closed. */
  const reads = () => {
    const handle = deps.read();
    return handle === null ? null : skillsReads(handle, deps);
  };
  /** A change: a sync first, then the write; a closed database refuses it. */
  async function change<TAnswer>(update: SkillsUpdate): Promise<TAnswer> {
    await sync();
    try {
      return (await deps.write(update)) as TAnswer;
    } catch {
      return CLOSED as TAnswer;
    }
  }
  return {
    sync,
    async active() {
      await sync();
      return reads()?.active() ?? [];
    },
    problems: () => deps.load().problems,
    async list() {
      await sync();
      return reads()?.list() ?? [];
    },
    async show(name) {
      await sync();
      return reads()?.show(name) ?? null;
    },
    async pending() {
      await sync();
      return reads()?.pending() ?? [];
    },
    async review(name) {
      await sync();
      return reads()?.review(name) ?? null;
    },
    activate: (name, by) => change({ kind: 'skills', op: 'activate', name, at: deps.now(), by }),
    rollback: (name, by) => change({ kind: 'skills', op: 'rollback', name, at: deps.now(), by }),
    reject: (name, by) => change({ kind: 'skills', op: 'reject', name, at: deps.now(), by }),
    disable: (name, by) => change({ kind: 'skills', op: 'disable', name, disabled: true, at: deps.now(), by }),
    enable: (name, by) => change({ kind: 'skills', op: 'disable', name, disabled: false, at: deps.now(), by }),
    async record(uses: ReadonlyArray<SkillUse>) {
      try {
        return (await deps.write({ kind: 'skills', op: 'uses', uses: [...uses] })) as number;
      } catch {
        return 0;
      }
    },
  };
}
