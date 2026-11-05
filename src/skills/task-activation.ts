// Automatic activation of a skill after a development task. `bindPackage` validates the package and writes the exact
// version it found on the open task as `metadata.package`. `settleSkillTasks` is one sweep over her done skill tasks: it
// activates each bound version through the writer as `task:<id>` and marks the task with one comment, so a task is answered
// once however many sweeps see it, and a crash before the activation or before the mark recovers on the next sweep.
//
// The version is the identity: a later edit is a new candidate and retires the bound one, so the sweep refuses it as
// `superseded` and the edit stays pending. Nothing here reads a name from a task's title, walks other candidates or
// touches a grant, and a failed, cancelled or watcher's task never reaches the sweep. A closed task keeps its fields, which
// is why the mark is a comment. The core runs the sweep (src/core.ts), and the worker reaches `bindPackage` over the
// socket's `skill.pending { name, task }` (agent-commands.ts).

import { SELF } from '../board/fields.ts';
import { BoardError } from '../board/machine.ts';
import type { BoardCaller } from '../tools/impl/board.ts';
import { SKILL_NAME } from './format.ts';
import type { SkillsAccess } from './port.ts';

export type SkillTasksDeps = { skills: SkillsAccess; board: BoardCaller; principal: string };

export type SettledCode =
  'activated' | 'already-active' | 'superseded' | 'invalid-package' | 'invalid-name' | 'unknown-version';

export type SettledTask = { taskId: string; skill: string | null; versionId: string | null; code: SettledCode };

/** How often a binding that lost to another writer's revision tries again. */
const STALE_TRIES = 3;
/** The start of the comment that marks a task as settled. */
const MARK = 'skill-activation';

/** Binds the version the folder holds now to the open task; activates nothing. */
export async function bindPackage(
  deps: SkillTasksDeps,
  request: { taskId: string; name: string }
): Promise<{ ok: true; versionId: string } | { ok: false; code: string }> {
  const { taskId, name } = request;
  if (!SKILL_NAME.test(name)) return { ok: false, code: 'invalid-name' };
  const problem = (await deps.skills.problems()).find((one) => one.dir === name);
  if (problem !== undefined) return { ok: false, code: problem.code };
  const pending = await deps.skills.pending();
  const row = (await deps.skills.list()).find((one) => one.name === name);
  const versionId = pending.findLast((one) => one.skill === name)?.versionId ?? row?.active?.versionId;
  if (row?.lifecycle !== 'active' || versionId === undefined) return { ok: false, code: 'no-package' };
  for (let tries = 1; ; tries += 1) {
    const { task } = await deps.board.call(deps.principal, 'task.show', { id: taskId });
    try {
      await deps.board.call(deps.principal, 'task.update', {
        id: taskId,
        revision: task.revision,
        metadata: { package: { skill: name, versionId } },
      });
      return { ok: true, versionId };
    } catch (error) {
      if (!(error instanceof BoardError) || error.code !== 'stale' || tries >= STALE_TRIES) throw error;
    }
  }
}

/** The binding's two fields as far as they are text. */
function bindingOf(raw: unknown): { skill: string | null; versionId: string | null } {
  const { skill, versionId } = (raw ?? {}) as { skill?: unknown; versionId?: unknown };
  return {
    skill: typeof skill === 'string' ? skill : null,
    versionId: typeof versionId === 'string' ? versionId : null,
  };
}

/** What a sweep answers for one task and the words of its mark, or null when the writer took nothing and it waits. */
async function settleOne(
  skills: SkillsAccess,
  taskId: string,
  binding: { skill: string | null; versionId: string | null }
): Promise<{ code: SettledCode; detail?: string } | null> {
  const { skill, versionId } = binding;
  if (skill === null || !SKILL_NAME.test(skill)) return { code: 'invalid-name' };
  if (versionId === null || !versionId.startsWith(`skillver:${skill}:`)) return { code: 'unknown-version' };
  const problem = (await skills.problems()).find((one) => one.dir === skill);
  if (problem !== undefined) return { code: 'invalid-package', detail: problem.code };
  const row = (await skills.list()).find((one) => one.name === skill);
  if (row?.lifecycle !== 'active') return { code: 'invalid-package', detail: 'no-package' };
  const done = await skills.activateVersion(skill, versionId, `task:${taskId}`);
  if (done.ok) return { code: 'activated', detail: versionId };
  if (done.code === 'already-active') return { code: 'already-active', detail: versionId };
  if (done.code === 'not-candidate') return { code: 'superseded', detail: versionId };
  return done.code === 'unknown-version' ? { code: 'unknown-version' } : null;
}

/**
 * One sweep over the done tasks of hers with `metadata.kind` `skill` and a binding, each answered once. A task the writer
 * could not take is not in the answer and waits for the next sweep. A board that does not answer rejects the sweep.
 */
export async function settleSkillTasks(deps: SkillTasksDeps): Promise<Array<SettledTask>> {
  const { skills, board, principal } = deps;
  const settled: Array<SettledTask> = [];
  for (const task of await board.call(principal, 'task.list', { requester: SELF, status: 'done' })) {
    if (task.metadata?.kind !== 'skill' || task.metadata.package === undefined) continue;
    const { comments } = await board.call(principal, 'task.show', { id: task.id });
    if (comments.some((one) => one.author === principal && one.text.startsWith(`${MARK} `))) continue;
    const binding = bindingOf(task.metadata.package);
    const answer = await settleOne(skills, task.id, binding);
    if (answer === null) continue;
    const text = [MARK, answer.code, ...(answer.detail === undefined ? [] : [answer.detail])].join(' ');
    await board.call(principal, 'task.comment', { id: task.id, text });
    settled.push({ taskId: task.id, ...binding, code: answer.code });
  }
  return settled;
}
