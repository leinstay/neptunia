// The map from a Claude session id to the agent and the run that started it, one JSON line per run in
// `<private>/subharness/sessions.jsonl`. Every agent shares one account home, so a transcript alone cannot say whose it is:
// src/subharness/run.ts appends the row before the run starts, and the watcher's evidence (src/service/watcher.ts) reads it.
// A row holds ids and names, never a brief.

import fs from 'node:fs';
import path from 'node:path';

export type SessionRow = { sessionId: string; agent: string; backend: string; runId: string | null; at: number };

const mapFile = (privateDir: string): string => path.join(privateDir, 'subharness', 'sessions.jsonl');

/** Appends one row; throws when the file cannot be written, and the caller decides what that means. */
export function recordSession(privateDir: string, row: SessionRow): void {
  fs.mkdirSync(path.dirname(mapFile(privateDir)), { recursive: true });
  fs.appendFileSync(mapFile(privateDir), `${JSON.stringify(row)}\n`);
}

/** Every row, oldest first; none for a missing file. A torn line is skipped. */
export function readSessionMap(privateDir: string): Array<SessionRow> {
  let text: string;
  try {
    text = fs.readFileSync(mapFile(privateDir), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      const row = JSON.parse(line) as SessionRow;
      return typeof row.sessionId === 'string' && typeof row.agent === 'string' ? [row] : [];
    } catch {
      return [];
    }
  });
}
