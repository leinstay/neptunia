// How a turn used her skills, worked out from the tool calls of the turn alone: one row per skill and kind at most.
// `discovered` for every skill her request indexed, `read` for a `skill.read` of an indexed skill, `tried` when a tool
// of the skill is called after the read, `succeeded` when every such call ended ok, `corrected` when one of them failed
// and the same tool was called again later, `declined` when she read it and called none of its tools. Pure; the turn
// runner passes the rows to the skills port (port.ts) once the turn is over.

import type { SkillUse, UseKind } from '../memory/db/skills.ts';

export type IndexedSkill = { name: string; versionId: string; tools: ReadonlyArray<string> };
/** One tool call of the turn; `name` is the argument of `skill.read`. */
export type TurnCall = { tool: string; name?: string; ok: boolean };

const READ_TOOL = 'skill.read';

/** The kinds one skill earned in the turn. */
function kindsOf(skill: IndexedSkill, calls: ReadonlyArray<TurnCall>): Array<UseKind> {
  const kinds: Array<UseKind> = ['discovered'];
  const readAt = calls.findIndex((call) => call.tool === READ_TOOL && call.name === skill.name);
  if (readAt < 0) return kinds;
  kinds.push('read');
  const after = calls.slice(readAt + 1).filter((call) => skill.tools.includes(call.tool));
  if (after.length === 0) {
    kinds.push('declined');
    return kinds;
  }
  kinds.push('tried');
  if (after.every((call) => call.ok)) kinds.push('succeeded');
  if (after.some((call, index) => !call.ok && after.slice(index + 1).some((later) => later.tool === call.tool))) {
    kinds.push('corrected');
  }
  return kinds;
}

export function skillUsesOfTurn(turn: {
  turnId: string;
  at: number;
  index: ReadonlyArray<IndexedSkill>;
  calls: ReadonlyArray<TurnCall>;
}): Array<SkillUse> {
  return turn.index.flatMap((skill) =>
    kindsOf(skill, turn.calls).map((kind) => ({
      skill: skill.name,
      versionId: skill.versionId,
      turnId: turn.turnId,
      kind,
      at: turn.at,
    }))
  );
}
