// What an agent principal may ask of the skills on the core socket: `skill.pending` lists the versions waiting for an
// activation and `skill.activate { name }` activates the newest candidate of that skill as `agent:<name>`. Nothing
// else is offered: an agent never rolls back, disables or rejects. Answers are the socket's `{ status, text, data }`.
// `skillCommand` runs over a port that answers at once, `skillCommandOf` over the core's access, which answers later.

import type { SkillsAccess, SkillsPort } from './port.ts';

export type SkillCommandAnswer = { status: 'ok' | 'invalid' | 'failed'; text: string; data: unknown };

/** The prefix of the commands this module answers. */
export const SKILL_COMMAND_PREFIX = 'skill.';

type Activation = ReturnType<SkillsPort['activate']>;

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

const answerOfActivation = (name: string, done: Activation): SkillCommandAnswer =>
  done.ok
    ? { status: 'ok', text: `${name} is active`, data: { name, versionId: done.versionId, previous: done.previous } }
    : { status: 'failed', text: `skill.activate ${name}: ${done.code}`, data: null };

const noName: SkillCommandAnswer = { status: 'invalid', text: 'skill.activate needs a skill name', data: null };

export function skillCommand(
  port: SkillsPort,
  caller: { name: string },
  command: string,
  args: Readonly<Record<string, unknown>>
): SkillCommandAnswer {
  if (command === 'skill.pending') return answerOfPending(port.pending(), args);
  if (command === 'skill.activate') {
    const name = args.name;
    if (typeof name !== 'string' || name === '') return noName;
    return answerOfActivation(name, port.activate(name, `agent:${caller.name}`));
  }
  return { status: 'invalid', text: `unknown skill command ${command}`, data: null };
}

/** The same commands over the core's skills access. */
export async function skillCommandOf(
  access: SkillsAccess,
  caller: { name: string },
  command: string,
  args: Readonly<Record<string, unknown>>
): Promise<SkillCommandAnswer> {
  if (command === 'skill.pending') return answerOfPending(await access.pending(), args);
  if (command === 'skill.activate') {
    const name = args.name;
    if (typeof name !== 'string' || name === '') return noName;
    return answerOfActivation(name, await access.activate(name, `agent:${caller.name}`));
  }
  return { status: 'invalid', text: `unknown skill command ${command}`, data: null };
}
