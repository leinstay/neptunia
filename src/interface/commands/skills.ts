// The owner's `/skills` commands: what the console (console.ts) runs for `skills.list`, `show`, `review`, `pending`,
// `activate`, `rollback`, `reject`, `enable` and `disable`, over the skills access the core hands it (the port of
// src/skills/port.ts, or its client over the memory writer). Every change is made as the principal `owner`. A refused
// change answers `failed` with the command as the owner typed it and the registry's code, so it names the skill. The
// text is for the owner alone and never reaches a request.

import type { VersionView } from '../../memory/db/skills.ts';
import type { SkillListRow, SkillsAccess } from '../../skills/port.ts';

export type SkillsAnswer = { text: string; status: string };

const OWNER = 'owner';

/** The command as the owner typed it. */
const typedOf = (name: string, skill: string): string =>
  `/${name.replaceAll('.', ' ')}${skill === '' ? '' : ` ${skill}`}`;

const failed = (name: string, skill: string, why: string): SkillsAnswer => ({
  text: `${typedOf(name, skill)}: ${why}`,
  status: 'failed',
});

/** A moment of the registry (ISO text) as the owner reads it: UTC to the minute. */
const minute = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

/** The states of a row: whether a version is active, and the switches and gaps that keep it out of her index. */
function statesOf(row: SkillListRow): Array<string> {
  const states = [row.active === null ? 'candidate only' : 'active'];
  if (row.disabled) states.push(`disabled by ${row.disabledBy ?? 'unknown'}`);
  if (row.lifecycle === 'stale') states.push('stale, the file is gone');
  if (row.missing.length > 0) {
    states.push(`unavailable: ${row.missing.map((one) => `${one.tool} ${one.reason}`).join(', ')}`);
  }
  return states;
}

function listLine(row: SkillListRow): string {
  const parts = [row.name, statesOf(row).join('; ')];
  if (row.active !== null)
    parts.push(`${row.active.version} by ${row.active.activatedBy} at ${minute(row.active.activatedAt)}`);
  if (row.rollbackTo !== null) parts.push(`rollback to ${row.rollbackTo.version}`);
  if (row.candidates > 0) parts.push(`${row.candidates} pending`);
  if (row.reviewDue) parts.push('due for review');
  return parts.join('  ');
}

const countsLine = (view: VersionView): string =>
  Object.entries(view.uses)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');

/** One version for `/skills review`: its label, status, tools, task, uses and its text. */
function versionBlock(title: string, view: VersionView): string {
  const head = `${title} ${view.version} (${view.status}), tools: ${view.tools.join(', ') || 'none'}, task: ${view.task ?? 'none'}`;
  return [head, `uses: ${countsLine(view)}`, view.source].join('\n');
}

async function change(
  name: string,
  skill: string,
  run: () => Promise<{ ok: true; text: string } | { ok: false; code: string }>
): Promise<SkillsAnswer> {
  const done = await run();
  return done.ok ? { text: done.text, status: 'ok' } : failed(name, skill, done.code);
}

/** Runs the command `name` (`skills.<sub>`) with its arguments; null access answers `failed`. */
export async function skillsCommand(
  access: SkillsAccess | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<SkillsAnswer> {
  const skill = typeof args.name === 'string' ? args.name : '';
  if (access == null) return failed(name, skill, 'skills are not available here');
  switch (name) {
    case 'skills.list': {
      const rows = await access.list();
      const refused = (await access.problems()).map((one) => `refused: ${one.dir} (${one.code})`);
      const lines = [...(rows.length === 0 ? ['no skill yet'] : rows.map(listLine)), ...refused];
      return { text: lines.join('\n'), status: 'ok' };
    }
    case 'skills.pending': {
      const pending = await access.pending();
      if (pending.length === 0) return { text: 'nothing waits for an activation', status: 'ok' };
      const lines = pending.map(
        (one) =>
          `${one.skill}  ${one.version}  tools: ${one.tools.join(', ') || 'none'}  task: ${one.task ?? 'none'}  since ${minute(one.createdAt)}`
      );
      return { text: lines.join('\n'), status: 'ok' };
    }
    case 'skills.show': {
      const shown = await access.show(skill);
      if (shown === null) return failed(name, skill, `no skill named ${skill}`);
      const head = listLine(shown.row);
      if (shown.text === null) return { text: `${head}\nno active version`, status: 'ok' };
      return { text: `${head}\ntools: ${shown.row.active?.tools.join(', ') || 'none'}\n${shown.text}`, status: 'ok' };
    }
    case 'skills.review': {
      const review = await access.review(skill);
      if (review === null) return failed(name, skill, `no skill named ${skill}`);
      const blocks = [
        review.active === null ? 'no active version' : versionBlock('active', review.active),
        ...review.candidates.map((one) => versionBlock('pending', one)),
      ];
      return { text: blocks.join('\n\n'), status: 'ok' };
    }
    case 'skills.activate':
      return change(name, skill, async () => {
        const done = await access.activate(skill, OWNER);
        return done.ok ? { ok: true, text: `${skill} is active, version ${done.versionId}` } : done;
      });
    case 'skills.rollback':
      return change(name, skill, async () => {
        const done = await access.rollback(skill, OWNER);
        return done.ok ? { ok: true, text: `${skill} is back on ${done.active}` } : done;
      });
    case 'skills.reject':
      return change(name, skill, async () => {
        const done = await access.reject(skill, OWNER);
        return done.ok ? { ok: true, text: `${done.rejected} pending version rejected for ${skill}` } : done;
      });
    case 'skills.enable':
    case 'skills.disable': {
      const disabling = name === 'skills.disable';
      return change(name, skill, async () => {
        const done = await (disabling ? access.disable(skill, OWNER) : access.enable(skill, OWNER));
        if (!done.ok) return done;
        const state = disabling ? 'off' : 'on';
        return { ok: true, text: done.changed ? `${skill} is ${state}` : `${skill} was already ${state}` };
      });
    }
    default:
      return failed(name, skill, 'no such command; type /help');
  }
}
