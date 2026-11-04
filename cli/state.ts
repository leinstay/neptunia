// The chat's state as pure functions over plain values: the input line, its history, the slash menu, folded answers and the
// status line. Nothing here touches a terminal, so each behaviour is tested without one. cli/app.ts draws it.

export type MenuCommand = { name: string; help: string };
export type StatusBrief = {
  core: { state: 'running' | 'paused' | 'unavailable'; reason: string | null };
  memory: { path: string; model: string | null; probe: 'ok' | 'failed' | 'unknown'; checkedAt: number | null };
  interfaces: ReadonlyArray<{ name: string; enabled: boolean; connected: boolean }>;
};

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

/** Removes the whole character before the cursor, an astral one included. */
export function backspace(state: InputState): InputState {
  if (state.cursor === 0) return state;
  const before = [...state.text.slice(0, state.cursor)];
  before.pop();
  const head = before.join('');
  return { ...state, text: head + state.text.slice(state.cursor), cursor: head.length };
}

export function moveCursor(state: InputState, delta: -1 | 1): InputState {
  const chars = delta < 0 ? [...state.text.slice(0, state.cursor)] : [...state.text.slice(state.cursor)];
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
export function foldedText(text: string, expanded: boolean): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (expanded || lines.length <= FOLD_LINES) return { text, hidden: 0 };
  return { text: lines.slice(0, FOLD_LINES).join('\n'), hidden: lines.length - FOLD_LINES };
}

/** Lines of a panel that hold what the owner typed in its search. */
export function filterLines(lines: ReadonlyArray<string>, asked: string): Array<string> {
  const wanted = asked.trim().toLowerCase();
  return wanted === '' ? [...lines] : lines.filter((line) => line.toLowerCase().includes(wanted));
}

/**
 * The compact status: the link, the core with its reason, the memory writer with its last probe, each interface. What is not
 * known says so: a configured credential is never shown as a live connection, and a poll too old says `stale`.
 */
export function statusLine(
  brief: StatusBrief | null,
  { connected, polledAt, now }: { connected: boolean; polledAt: number | null; now: number }
): string {
  if (!connected) return 'Core: connection lost\nMemory: unknown\nInterfaces: unknown';
  if (brief === null || polledAt === null) return 'Core: checking…\nMemory: checking…\nInterfaces: checking…';
  const stale = now - polledAt > STALE_AFTER_MS ? ' (outdated)' : '';
  const reason = brief.core.reason === null ? '' : ` (${brief.core.reason})`;
  const probe = { ok: 'ready', failed: 'check failed', unknown: 'not checked' }[brief.memory.probe];
  const memory = [probe, brief.memory.model, brief.memory.path].filter(Boolean).join(' · ');
  const interfaces = brief.interfaces
    .filter((one) => one.enabled)
    .map(
      (one) =>
        `${one.name.charAt(0).toUpperCase()}${one.name.slice(1)} (${one.connected ? 'connected' : 'disconnected'})`
    );
  return [
    `Core: ${brief.core.state}${reason}`,
    `Memory: ${memory}`,
    `Interfaces: ${interfaces.join(', ') || 'none enabled'}`,
  ]
    .map((line) => line + stale)
    .join('\n');
}
