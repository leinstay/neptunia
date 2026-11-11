// The watcher's list of accepted findings: findings the owner knows and chose to leave. One file, `accepted.md` in the
// watcher's folder under the data folder, one `- ` line per finding. Only `acceptLine` and `unacceptLine` write it, each
// by a temp file and a rename, and the watcher only reads it (src/watcher/inspection.ts hands it to the brief). A missing
// file is an empty list. A text with a line break is kept as one line.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WATCHER_DIR } from './read.ts';

export type AcceptResult = { ok: true; line: number } | { ok: false; code: 'empty' | 'duplicate'; line?: number };
export type UnacceptResult = { ok: true; text: string } | { ok: false; code: 'no-line'; count: number };

/** The file of the list under the data folder. */
export const acceptedFileOf = (dataDir: string): string => path.join(dataDir, DEFAULT_WATCHER_DIR, 'accepted.md');

/** The lines of the list in file order, each without its `- `; none for a missing file. */
export function acceptedLines(dataDir: string): Array<string> {
  let text: string;
  try {
    text = fs.readFileSync(acceptedFileOf(dataDir), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== '');
}

function writeList(dataDir: string, lines: ReadonlyArray<string>): void {
  const file = acceptedFileOf(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, lines.map((line) => `- ${line}\n`).join(''));
  fs.renameSync(temp, file);
}

/** Adds `text`, its line breaks folded to single spaces, as the last line; refuses an empty text and one already listed. */
export function acceptLine(dataDir: string, text: string): AcceptResult {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return { ok: false, code: 'empty' };
  const lines = acceptedLines(dataDir);
  const held = lines.indexOf(line);
  if (held >= 0) return { ok: false, code: 'duplicate', line: held + 1 };
  writeList(dataDir, [...lines, line]);
  return { ok: true, line: lines.length + 1 };
}

/** Removes line `line` (counted from 1) and answers with its text; a number outside the list changes nothing. */
export function unacceptLine(dataDir: string, line: number): UnacceptResult {
  const lines = acceptedLines(dataDir);
  const text = Number.isInteger(line) ? lines[line - 1] : undefined;
  if (line < 1 || text === undefined) return { ok: false, code: 'no-line', count: lines.length };
  writeList(
    dataDir,
    lines.filter((_, index) => index !== line - 1)
  );
  return { ok: true, text };
}
