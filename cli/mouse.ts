// The mouse where a terminal has one: SGR reports parsed and taken out of the input before Ink sees them, whether tracking
// may go on at all, and a click turned into a caret offset. Tracking takes the terminal's own selection away, so the chat
// selects and copies itself (cli/chat-controller.ts). The setting `cli.mouse` turns tracking off, and it stays off for a
// plain or linear screen. cli/index.ts wraps stdin with it, and cli/app.ts takes the reports.
import { Readable } from 'node:stream';
import { graphemes, wrapCells, cellWidth } from './layout.ts';

export type MouseReport = {
  kind: 'press' | 'drag' | 'release' | 'wheel-up' | 'wheel-down';
  button: number;
  column: number;
  row: number;
};

// eslint-disable-next-line no-control-regex
const REPORT = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
// eslint-disable-next-line no-control-regex
const REPORTS = /\u001b\[<\d+;\d+;\d+[Mm]/g;
// eslint-disable-next-line no-control-regex
const PARTIAL = /\u001b\[(?:<[\d;]*)?$/;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
/** The bit a terminal adds to the button of a motion report while that button is held (button-event tracking, 1002). */
const MOTION = 32;
/** As long as Ink itself waits for the rest of an escape sequence. A lone Esc passes at once, and Ink keeps it apart from a late `[<`. */
const PARTIAL_WAIT_MS = 20;

/** One report, null for anything else: a typed `[<` is text. */
export function parseMouse(input: string): MouseReport | null {
  const found = REPORT.exec(input);
  if (found === null) return null;
  const button = Number(found[1]);
  const column = Number(found[2]);
  const row = Number(found[3]);
  if (button === WHEEL_UP) return { kind: 'wheel-up', button, column, row };
  if (button === WHEEL_DOWN) return { kind: 'wheel-down', button, column, row };
  if ((button & MOTION) !== 0) return { kind: 'drag', button: button - MOTION, column, row };
  return { kind: found[4] === 'M' ? 'press' : 'release', button, column, row };
}

/** Whether tracking may go on: a capable terminal, outside the plain and linear modes. */
export function mouseAvailable({
  tty,
  term,
  linear,
  plain,
}: {
  tty: boolean;
  term: string;
  linear: boolean;
  plain: boolean;
}): boolean {
  return tty && term !== '' && term !== 'dumb' && !linear && !plain;
}

/** The text offset of a cell of wrapped text: past the end clamps, and the right half of a wide glyph stands before it. */
export function caretFromCell(text: string, cell: { row: number; col: number }, width: number): number {
  const rows = wrapCells(text, width);
  const row = rows[cell.row];
  if (row === undefined) return text.length;
  let cells = 0;
  let offset = row.start;
  for (const glyph of graphemes(row.text)) {
    cells += cellWidth(glyph);
    if (cells > cell.col) return offset;
    offset += glyph.length;
  }
  return offset;
}

export type MouseSource = { onReport(listener: (report: MouseReport) => void): () => void };

/**
 * A stdin for Ink with the mouse reports taken out and given to listeners, whatever the chunks split them. Ink would drop a
 * report itself, so without this filter a terminal's stray report never reaches the draft either.
 */
export function mouseFilter(source: NodeJS.ReadStream): {
  input: NodeJS.ReadStream;
  reports: MouseSource;
  close(): void;
} {
  const listeners = new Set<(report: MouseReport) => void>();
  const input = Object.assign(new Readable({ read() {} }), {
    isTTY: source.isTTY,
    setRawMode(mode: boolean) {
      source.setRawMode?.(mode);
      return input;
    },
    ref() {
      source.ref?.();
      return input;
    },
    unref() {
      source.unref?.();
      return input;
    },
  });
  let pending = '';
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    if (pending !== '') input.push(Buffer.from(pending, 'latin1'));
    pending = '';
  };
  const onData = (chunk: Buffer | string): void => {
    clearTimeout(timer);
    // Latin-1 keeps every byte as one character, so a split UTF-8 character passes through whole.
    const text = pending + (typeof chunk === 'string' ? Buffer.from(chunk) : chunk).toString('latin1');
    pending = '';
    for (const found of text.match(REPORTS) ?? []) {
      const report = parseMouse(found);
      if (report !== null) for (const listener of listeners) listener(report);
    }
    const rest = text.replace(REPORTS, '');
    const partial = PARTIAL.exec(rest);
    const whole = partial === null ? rest : rest.slice(0, partial.index);
    if (whole !== '') input.push(Buffer.from(whole, 'latin1'));
    if (partial !== null) {
      pending = partial[0];
      timer = setTimeout(flush, PARTIAL_WAIT_MS);
    }
  };
  source.on('data', onData);
  return {
    input: input as unknown as NodeJS.ReadStream,
    reports: {
      onReport(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    close() {
      clearTimeout(timer);
      source.off('data', onData);
      source.pause();
    },
  };
}
