// The command window: every slash command of the session in the order it ran, each under its command line and its time,
// between the chat and the input. It takes half of the rows the header and the input leave, so the chat keeps the other
// half, and it scrolls apart from the chat. An interactive panel of the newest command draws in its place. The hint under
// it follows Claude Code's footers ("Esc to cancel" under its /help panel): the key, then "to" and what it does.
// cli/chat-controller.ts measures it, and cli/app.ts draws it.
import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { TranscriptRows } from './chat-view.ts';
import { THEME } from './theme.ts';
import { cellWidth } from './layout.ts';
import { displaySafe, lineLead } from './transcript.ts';
import type { TranscriptEntry, TranscriptRow } from './transcript.ts';

/** One command the owner ran: the line as typed, when, and its answer, null while it is on its way. */
export type CommandResult = { id: string; line: string; at: number; answer: string | null };

/** The rule above the window's rows. */
const RULE_ROWS = 1;
/** The hint under them, left out while a panel draws its own keys. */
const HINT_ROWS = 1;
export const WINDOW_HINT = 'Esc to close';
const WAITING = '…';

/** The rows the open window takes of the `free` rows the header and the input leave: half, rounded down. */
export function windowHeight(free: number, isOpen: boolean): number {
  return isOpen ? Math.floor(Math.max(0, free) / 2) : 0;
}

/**
 * Which of its frame rows the window draws at this height: the rule and the hint while a row of text still fits between
 * them, the rule alone with one row less, and neither below that. A live panel shows its own keys, so it takes no hint.
 */
export function windowChrome(height: number, hasPanel: boolean): { rule: boolean; hint: boolean } {
  const hint = !hasPanel && height >= RULE_ROWS + HINT_ROWS + 1;
  return { rule: height >= RULE_ROWS + 1, hint };
}

/** The rows inside the window: what its rule and its hint leave. */
export function windowBody(height: number, hasPanel: boolean): number {
  const { rule, hint } = windowChrome(height, hasPanel);
  return Math.max(0, height - (rule ? RULE_ROWS : 0) - (hint ? HINT_ROWS : 0));
}

const LINE_SUFFIX = ':line';
const kept = new WeakMap<CommandResult, { key: string; entries: Array<TranscriptEntry> }>();

/**
 * The window's entries: the command line under the lead of its time and its number among the session's commands, as the
 * chat leads its lines, then its answer as it arrived in the same column, with every control character made visible. Kept
 * per result, so the wrapped rows of an unchanged result are reused.
 */
export function resultEntries(results: ReadonlyArray<CommandResult>, timeZone?: string): Array<TranscriptEntry> {
  return results.flatMap((result, index) => {
    const key = `${index}|${timeZone ?? ''}`;
    const found = kept.get(result);
    if (found?.key === key && found !== undefined) return found.entries;
    const answer = result.answer ?? WAITING;
    const lead = lineLead(result.at, index + 1, timeZone);
    const entries: Array<TranscriptEntry> = [
      { id: `${result.id}${LINE_SUFFIX}`, text: displaySafe(result.line), lead },
      ...(answer === ''
        ? []
        : [{ id: `${result.id}:answer`, text: displaySafe(answer.replaceAll('\r\n', '\n')), indent: cellWidth(lead) }]),
    ];
    kept.set(result, { key, entries });
    return entries;
  });
}

/** The command line's rows in the owner's style, the answer's as her text. */
const whoOf = (entryId: string): 'owner' | 'her' => (entryId.endsWith(LINE_SUFFIX) ? 'owner' : 'her');

export function CommandWindow({
  height,
  columns,
  rows,
  marks,
  panel,
}: {
  height: number;
  columns: number;
  rows: ReadonlyArray<TranscriptRow>;
  marks: ReadonlyArray<{ from: number; to: number } | null>;
  /** the live panel of the newest command, drawn in place of the rows */
  panel: ReactElement | null;
}): ReactElement {
  const body = windowBody(height, panel !== null);
  const { rule, hint } = windowChrome(height, panel !== null);
  return h(
    Box,
    { flexDirection: 'column', height, flexShrink: 0, overflow: 'hidden' },
    rule ? h(Text, { ...THEME.muted, wrap: 'truncate' }, '─'.repeat(Math.max(1, columns))) : null,
    h(
      Box,
      { flexDirection: 'column', height: body, overflow: 'hidden' },
      panel ?? h(TranscriptRows, { rows, marks, whoOf })
    ),
    hint ? h(Text, { ...THEME.muted, wrap: 'truncate' }, WINDOW_HINT) : null
  );
}
