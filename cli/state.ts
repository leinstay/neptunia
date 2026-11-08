// The chat's state as pure functions over plain values: the input line, its history, the slash menu, folded answers and the
// status line. Nothing here touches a terminal, so each behaviour is tested without one. cli/app.ts draws it.
import { graphemes } from './layout.ts';

export type MenuCommand = { name: string; help: string };
/** A role's model and route as the core reads them (src/interface/commands/status-brief.ts); `bound`: a key or a harness carries it. */
export type RoleFacts = { model: string | null; route: string; bound: boolean };
export type StatusBrief = {
  core: { state: 'running' | 'paused' | 'unavailable'; reason: string | null } & RoleFacts;
  memory: { session: string; probe: 'ok' | 'failed' | 'unknown'; checkedAt: number | null } & RoleFacts;
  analyzer: RoleFacts;
  interfaces: ReadonlyArray<{ name: string; enabled: boolean; connected: boolean }>;
};

/**
 * The four state words of the header, the same on every line (the owner's choice of 2026-11-08): it works, the owner
 * paused it, it is switched off, or something that should work does not.
 */
export const STATE_WORDS = { active: 'active', paused: 'paused', disabled: 'disabled', error: 'error' } as const;
type StateWord = (typeof STATE_WORDS)[keyof typeof STATE_WORDS];

/** A compact status past this age says it is stale: the poll is every 15 seconds. */
export const STALE_AFTER_MS = 60_000;
/** An answer longer than this folds until the owner expands it. */
export const FOLD_LINES = 20;

export type InputState = { text: string; cursor: number; history: ReadonlyArray<string>; browsing: number | null };

export const emptyInput = (history: ReadonlyArray<string> = []): InputState => ({
  text: '',
  cursor: 0,
  history,
  browsing: null,
});

/** Inserts typed or pasted text at the cursor: a paste keeps its newlines and its characters whole. */
export function insert(state: InputState, typed: string): InputState {
  const text = state.text.slice(0, state.cursor) + typed + state.text.slice(state.cursor);
  return { ...state, text, cursor: state.cursor + typed.length, browsing: null };
}

/** Removes the whole grapheme before the cursor, a joined emoji or a letter with its accent included. */
export function backspace(state: InputState): InputState {
  if (state.cursor === 0) return state;
  const head = graphemes(state.text.slice(0, state.cursor)).slice(0, -1).join('');
  return { ...state, text: head + state.text.slice(state.cursor), cursor: head.length };
}

export function moveCursor(state: InputState, delta: -1 | 1): InputState {
  const chars = delta < 0 ? graphemes(state.text.slice(0, state.cursor)) : graphemes(state.text.slice(state.cursor));
  const size = (delta < 0 ? chars.at(-1) : chars[0])?.length ?? 0;
  return { ...state, cursor: state.cursor + delta * size };
}

/** Steps through the history, newest first; past the newest the line is empty again. */
export function browse(state: InputState, delta: -1 | 1): InputState {
  const count = state.history.length;
  if (count === 0) return state;
  const from = state.browsing ?? -1;
  const next = delta < 0 ? Math.min(from + 1, count - 1) : from - 1;
  if (next < 0) return { ...state, text: '', cursor: 0, browsing: null };
  const text = state.history[next] ?? '';
  return { ...state, text, cursor: text.length, browsing: next };
}

/** The line is sent: it goes first in the history unless it repeats the last, and a secret is never kept. */
export function submit(state: InputState, { secret }: { secret: boolean }): { line: string; next: InputState } {
  const line = state.text;
  const keep = !secret && line.trim() !== '' && state.history[0] !== line;
  return { line, next: emptyInput(keep ? [line, ...state.history].slice(0, 1000) : state.history) };
}

/** The commands a line starting with `/` can still become, whose name or help holds what was typed. */
export function menuOf(text: string, commands: ReadonlyArray<MenuCommand>): Array<MenuCommand> {
  if (!text.startsWith('/')) return [];
  const asked = text.slice(1).toLowerCase();
  const byName = commands.filter((command) => command.name.startsWith(asked));
  const rest = commands.filter(
    (command) => !command.name.startsWith(asked) && command.help.toLowerCase().includes(asked)
  );
  return [...byName, ...rest];
}

/** An answer as drawn: past the limit its first lines and how many more, unless expanded. */
export function foldedText(
  text: string,
  expanded: boolean,
  limit: number = FOLD_LINES
): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (expanded || lines.length <= limit) return { text, hidden: 0 };
  return { text: lines.slice(0, limit).join('\n'), hidden: lines.length - limit };
}

/** Lines of a panel that hold what the owner typed in its search. */
export function filterLines(lines: ReadonlyArray<string>, asked: string): Array<string> {
  const wanted = asked.trim().toLowerCase();
  return wanted === '' ? [...lines] : lines.filter((line) => line.toLowerCase().includes(wanted));
}

function coreState(core: StatusBrief['core']): StateWord {
  if (core.state === 'paused') return STATE_WORDS.paused;
  return core.state === 'running' && core.bound ? STATE_WORDS.active : STATE_WORDS.error;
}

function memoryState(memory: StatusBrief['memory']): StateWord {
  if (memory.session === 'off') return STATE_WORDS.disabled;
  return !memory.bound || memory.probe === 'failed' ? STATE_WORDS.error : STATE_WORDS.active;
}

function analyzerState(analyzer: StatusBrief['analyzer']): StateWord {
  if (analyzer.model === null) return STATE_WORDS.disabled;
  return analyzer.bound ? STATE_WORDS.active : STATE_WORDS.error;
}

/** `<Role>: <state> · <model> · via <route>`, the model named once and the reason of a pause beside its state. */
function roleLine(label: string, state: string, facts: RoleFacts | undefined): string {
  if (facts === undefined) return `${label}: ${state}`;
  return [`${label}: ${state}`, facts.model, `via ${facts.route}`].filter(Boolean).join(' · ');
}

/**
 * The header's status: one line per role (core, memory, analyzer) with its state, its model and its route, and one for the
 * enabled interfaces. What is not known says so: a configured credential is never shown as a live connection, a lost link
 * marks every line, and a poll too old says `outdated`. The view cuts each line to the width.
 */
export function statusLine(
  brief: StatusBrief | null,
  { connected, polledAt, now }: { connected: boolean; polledAt: number | null; now: number }
): string {
  const labels = ['Core', 'Memory', 'Analyzer', 'Interfaces'];
  if (!connected) return labels.map((label) => `${label}: ${STATE_WORDS.error} (connection lost)`).join('\n');
  if (brief === null || polledAt === null) return labels.map((label) => `${label}: …`).join('\n');
  const stale = now - polledAt > STALE_AFTER_MS ? ' (outdated)' : '';
  const reason = brief.core.reason === null ? '' : ` (${brief.core.reason})`;
  const interfaces = brief.interfaces
    .filter((one) => one.enabled)
    .map(
      (one) =>
        `${one.name.charAt(0).toUpperCase()}${one.name.slice(1)} (${one.connected ? STATE_WORDS.active : STATE_WORDS.error})`
    );
  // A core older than this chat sends no analyzer.
  const analyzer = (brief as Partial<StatusBrief>).analyzer;
  return [
    roleLine('Core', `${coreState(brief.core)}${reason}`, brief.core),
    roleLine('Memory', memoryState(brief.memory), brief.memory),
    analyzer === undefined ? 'Analyzer: …' : roleLine('Analyzer', analyzerState(analyzer), analyzer),
    `Interfaces: ${interfaces.join(', ') || STATE_WORDS.disabled}`,
  ]
    .map((line) => line + stale)
    .join('\n');
}
