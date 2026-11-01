// What an agent principal may ask of the skills on the core socket: `skill.pending` lists the versions waiting for an
// activation and `skill.activate { name }` activates the newest candidate of that skill as `agent:<name>`. Nothing
// else is offered: an agent never rolls back, disables or rejects. Answers are the socket's `{ status, text, data }`.

import type { SkillsPort } from './port.ts';

export type SkillCommandAnswer = { status: 'ok' | 'invalid' | 'failed'; text: string; data: unknown };

export function skillCommand(
  port: SkillsPort,
  caller: { name: string },
  command: string,
  args: Readonly<Record<string, unknown>>
): SkillCommandAnswer {
  if (command === 'skill.pending') {
    const pending = port.pending();
    return { status: 'ok', text: `${pending.length} pending`, data: pending };
  }
  if (command === 'skill.activate') {
    const name = args.name;
    if (typeof name !== 'string' || name === '') {
      return { status: 'invalid', text: 'skill.activate needs a skill name', data: null };
    }
    const done = port.activate(name, `agent:${caller.name}`);
    if (!done.ok) return { status: 'failed', text: `skill.activate ${name}: ${done.code}`, data: null };
    return {
      status: 'ok',
      text: `${name} is active`,
      data: { name, versionId: done.versionId, previous: done.previous },
    };
  }
  return { status: 'invalid', text: `unknown skill command ${command}`, data: null };
}
