// The Markdown reports of `--skills` and `--loop-triggers`: per scenario its summary and per turn the short table the
// stored-turn mode prints (scripts/lib/turn-report.ts#reportTable), and per trigger the same table. Counts, names,
// sizes and the persona's messages, as runs.jsonl holds them.

import { reportTable } from './turn-report.ts';
import type { TurnReport } from './turn-report.ts';
import type { TurnRecord } from './replay-records.ts';
import type { Rec } from './replay-types.ts';

/** A value in a table cell: one line, pipes escaped. */
function cell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.replace(/\s+/g, ' ').replaceAll('|', '\\|');
}

/** The heading of a turn's record: its run, and its step and turn for a multi-step scenario. */
const turnTitle = (record: TurnRecord): string =>
  [
    `run ${record.run + 1}`,
    record.step === undefined ? null : `step ${record.step}`,
    record.turn === undefined ? null : `turn ${record.turn}`,
  ]
    .filter(Boolean)
    .join(', ');

/** The report of a `--skills` run: per scenario its summary, a failure, and each turn's table and messages. */
export function renderSkillsReport(
  entries: ReadonlyArray<{ id: string; summary: Rec | null; records: ReadonlyArray<TurnRecord>; error?: string }>
): string {
  const out = ['# Skill scenarios', ''];
  out.push('| scenario | runs | turns | calls | no call | spoke | calls by name |', '|---|---|---|---|---|---|---|');
  for (const entry of entries) {
    const s = entry.summary;
    out.push(
      s === null
        ? `| ${entry.id} | failed: ${cell(entry.error)} | | | | | |`
        : `| ${entry.id} | ${s.runs} | ${s.turns} | ${s.calls} | ${s.noCall} | ${s.spoke} | ${cell(s.byName)} |`
    );
  }
  out.push('');
  for (const entry of entries) {
    out.push(`## ${entry.id}`, '');
    if (entry.error) out.push(`failed: ${cell(entry.error)}`, '');
    if (Array.isArray(entry.summary?.patterns))
      out.push(`patterns: ${(entry.summary.patterns as Array<string>).join(' | ')}`, '');
    if (typeof entry.summary?.limit === 'string') out.push(`limit: ${entry.summary.limit}`, '');
    for (const record of entry.records) {
      out.push(`### ${turnTitle(record)}`, '', '```text', reportTable(record.report), '```', '');
      for (const text of record.messages) out.push(`> ${cell(text)}`);
      if (record.messages.length > 0) out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The report of a `--loop-triggers` run: a table of the triggers, then each trigger's short table. */
export function renderLoopTriggersReport(
  lines: ReadonlyArray<Rec>,
  { failed = [] }: { failed?: ReadonlyArray<Rec> }
): string {
  const out = [
    '# Loop triggers',
    '',
    `${lines.length} turn(s)${failed.length > 0 ? `, ${failed.length} failed` : ''}`,
    '',
  ];
  out.push('| id | trigger | kind | steps | calls | outcome |', '|---|---|---|---|---|---|');
  for (const line of lines) {
    const report = line.report as TurnReport;
    out.push(
      `| ${line.id} | ${line.triggerId} | ${line.kind} | ${report.stepCount} | ${report.callCount} | ${report.outcome ?? '-'} |`
    );
  }
  out.push('');
  for (const item of failed) out.push(`failed: ${item.id}: ${cell(item.error)}`);
  if (failed.length > 0) out.push('');
  for (const line of lines)
    out.push(`## ${line.id}: ${line.triggerId}`, '', '```text', reportTable(line.report as TurnReport), '```', '');
  return `${out.join('\n').trimEnd()}\n`;
}
