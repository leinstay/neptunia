// The real store of the chat sessions. Sessions are one private JSON file of their own, `<private>/cli/sessions.json`,
// and never a row of memory: nothing she recalls reads them, and no memory write is involved. The lines come from
// `readLines`, a read of the memory database's stored sources (src/memory/db/chat-lines.ts). A write goes to a
// temporary file and renames over the old one, so a crash leaves the old file or the new one.

import fs from 'node:fs';
import path from 'node:path';
import type { ChatStore, SessionRow, SourceLine } from './sessions.ts';

const isRow = (value: unknown): value is SessionRow => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<SessionRow>;
  return (
    typeof row.id === 'string' &&
    typeof row.placeId === 'string' &&
    typeof row.authority === 'string' &&
    Array.isArray(row.spans)
  );
};

/** The rows of the file. A file that is absent holds none; one that cannot be read throws, so nothing writes over it. */
function readRows(file: string): Array<SessionRow> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file} holds no list of sessions; move it away to start a new one`);
  return parsed.filter(isRow);
}

export function createChatStore({
  file,
  readLines,
}: {
  file: string;
  readLines: (placeId: string) => ReadonlyArray<SourceLine>;
}): ChatStore {
  let rows: Array<SessionRow> | null = null;
  const loaded = (): Array<SessionRow> => (rows ??= readRows(file));
  return {
    lines: readLines,
    sessions: () => loaded(),
    saveSession(row) {
      const next = [...loaded().filter((one) => one.id !== row.id), row];
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
      rows = next;
    },
  };
}
