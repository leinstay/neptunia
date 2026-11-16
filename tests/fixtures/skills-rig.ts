// A skills port over a real memory database in memory and real temporary skill folders, with a clock the test moves
// and the granted and registered tool names it sets. The files a "fake agent" writes are written here the way the
// agent would: a folder with a SKILL.md in `skills.local/`. Synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import {
  activateNamedVersion,
  activateSkill,
  appendUses,
  rejectPending,
  rollbackSkill,
  setDisabled,
  syncSkills,
} from '../../src/memory/db/skills.ts';
import type { SkillsHandle } from '../../src/memory/db/skills.ts';
import { loadSkills } from '../../src/skills/load.ts';
import type { LoadedSkill, SkillProblem } from '../../src/skills/load.ts';
import { skillsReads } from '../../src/skills/port.ts';
import type { SkillsPort } from '../../src/skills/port.ts';
import { tempDir } from './tmp.ts';

/** A skills port over a writer handle: every method but `record` and `sync` syncs the folders first, as the core's client does. */
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
    diskHash: (name) => deps.load().skills.find((one) => one.name === name)?.contentHash ?? null,
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

export const SKILLS_T0 = Date.parse('2026-11-01T09:00:00Z');

/** A SKILL.md text: the front matter of `name`, `description`, `tools` and the prose. */
export function skillText(name: string, description: string, tools: ReadonlyArray<string>, body = 'When it applies, the steps, the way out.', task?: string): string {
  const front = [`name: ${name}`, `description: ${description}`, `tools: [${tools.join(', ')}]`, ...(task === undefined ? [] : [`task: ${task}`])];
  return `---\n${front.join('\n')}\n---\n${body}\n`;
}

export type SkillsRig = {
  handle: SkillsHandle;
  port: SkillsPort;
  clock: { t: number };
  folders: { trackedDir: string; localDir: string };
  /** Writes `skills.local/<name>/SKILL.md`, as an agent does. */
  writeLocal(name: string, text: string): void;
  /** Writes `skills/<name>/SKILL.md`, a tracked skill. */
  writeTracked(name: string, text: string): void;
  /** Her granted tool names and the registry's, which the port reads at each call. */
  granted: Set<string>;
  registered: Set<string>;
};

export function skillsRig(
  t: { after: (fn: () => void) => void },
  options: { granted?: ReadonlyArray<string>; registered?: ReadonlyArray<string>; reviewDays?: number } = {}
): SkillsRig {
  const root = tempDir('nep-skills-rig-');
  const folders = { trackedDir: path.join(root, 'skills'), localDir: path.join(root, 'skills.local') };
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const clock = { t: SKILLS_T0 };
  const granted = new Set(options.granted ?? ['web.search', 'web.read', 'message.create', 'skill.read']);
  const registered = new Set(options.registered ?? ['web.search', 'web.read', 'message.create', 'skill.read', 'pings.set']);
  const port = createSkillsPort({
    handle,
    now: () => clock.t,
    load: () => loadSkills(folders),
    granted: () => granted,
    registered: () => registered,
    reviewDays: () => options.reviewDays ?? 30,
  });
  const write = (dir: string, name: string, text: string): void => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text);
  };
  return {
    handle,
    port,
    clock,
    folders,
    writeLocal: (name, text) => write(folders.localDir, name, text),
    writeTracked: (name, text) => write(folders.trackedDir, name, text),
    granted,
    registered,
  };
}
