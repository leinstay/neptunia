// What an agent principal may ask of the skills on the core socket: `skill.pending` lists the pending versions,
// `skill.pending { name }` checks the package under `data/skills/<name>/`, answering what is wrong with it or that it is
// pending, and `skill.pending { name, task }` also binds that exact version to the task (task-activation.ts), as the
// caller. An agent never activates, rolls back, disables or rejects: her done task activates what it bound, and the owner
// has `/skills`. Answers are the socket's `{ status, text, data }`. `skillCommand` runs over a port that answers at once,
// `skillCommandOf` over the core's access, which answers later.

import type { BoardCaller } from '../tools/operations/board.ts';
import { SKILL_NAME } from './format.ts';
import type { SkillProblem } from './load.ts';
import type { SkillsAccess, SkillsPort } from './port.ts';
import { bindPackage } from './task-activation.ts';

export type SkillCommandAnswer = { status: 'ok' | 'invalid' | 'failed'; text: string; data: unknown };

/** The prefix of the commands this module answers. */
export const SKILL_COMMAND_PREFIX = 'skill.';

type Pending = Awaited<ReturnType<SkillsAccess['pending']>>;

/** The pending versions as text: JSON for `--json`, else one line each (skill, version, tools, task). */
function answerOfPending(pending: Pending, args: Readonly<Record<string, unknown>>): SkillCommandAnswer {
  const lines = pending.map(
    (one) => `${one.skill} ${one.version} tools: ${one.tools.join(', ') || 'none'} task: ${one.task ?? 'none'}`
  );
  const text =
    args.json === true ? JSON.stringify(pending, null, 2) : lines.length === 0 ? 'nothing pending' : lines.join('\n');
  return { status: 'ok', text, data: pending };
}

/** The answer to filing `name`, over what the core's next read of the folders found. */
function answerOfFiling(
  name: string,
  problems: ReadonlyArray<SkillProblem>,
  pending: Pending,
  known: boolean
): SkillCommandAnswer {
  const problem = problems.find((one) => one.dir === name);
  if (problem !== undefined)
    return { status: 'invalid', text: `skill.pending ${name}: ${problem.code}`, data: { code: problem.code } };
  const waiting = pending.find((one) => one.skill === name);
  if (waiting !== undefined) return { status: 'ok', text: `${name} ${waiting.version} is pending`, data: waiting };
  return known
    ? { status: 'ok', text: `${name} has no new version`, data: null }
    : { status: 'failed', text: `skill.pending ${name}: no-package`, data: null };
}

const badName = (name: unknown): SkillCommandAnswer => ({
  status: 'invalid',
  text: `skill.pending needs a skill name, got ${typeof name === 'string' ? name : typeof name}`,
  data: null,
});

const unknownCommand = (command: string): SkillCommandAnswer => ({
  status: 'invalid',
  text: `unknown skill command ${command}`,
  data: null,
});

export function skillCommand(
  port: SkillsPort,
  _caller: { name: string },
  command: string,
  args: Readonly<Record<string, unknown>>
): SkillCommandAnswer {
  if (command !== 'skill.pending') return unknownCommand(command);
  const name = args.name;
  if (name === undefined) return answerOfPending(port.pending(), args);
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) return badName(name);
  const pending = port.pending();
  return answerOfFiling(
    name,
    port.problems(),
    pending,
    port.list().some((row) => row.name === name)
  );
}

/** The answer to binding `name` to the task `taskId`. */
async function answerOfBinding(
  deps: { skills: SkillsAccess; board: BoardCaller; principal: string },
  taskId: string,
  name: string
): Promise<SkillCommandAnswer> {
  const bound = await bindPackage(deps, { taskId, name });
  if (bound.ok) return { status: 'ok', text: `${name} ${bound.versionId} is bound to ${taskId}`, data: bound };
  const status = bound.code === 'no-package' ? 'failed' : 'invalid';
  return { status, text: `skill.pending ${name}: ${bound.code}`, data: { code: bound.code } };
}

/** The same commands over the core's skills access; `task` needs the board. */
export async function skillCommandOf(
  access: SkillsAccess,
  caller: { name: string },
  command: string,
  args: Readonly<Record<string, unknown>>,
  options: { board?: BoardCaller | null } = {}
): Promise<SkillCommandAnswer> {
  if (command !== 'skill.pending') return unknownCommand(command);
  const name = args.name;
  if (name === undefined) return answerOfPending(await access.pending(), args);
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) return badName(name);
  if (typeof args.task === 'string') {
    if (options.board == null) return { status: 'failed', text: 'the board is not available here', data: null };
    return answerOfBinding({ skills: access, board: options.board, principal: caller.name }, args.task, name);
  }
  const pending = await access.pending();
  const rows = await access.list();
  return answerOfFiling(
    name,
    await access.problems(),
    pending,
    rows.some((row) => row.name === name)
  );
}
