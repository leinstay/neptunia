// The chat's history file `<private>/cli/history`: one header line, then one JSON record per draft, newest first, so a
// multiline draft stays one entry. A file with no header is the older format, one draft per line and oldest first, and is
// read as such whatever a line looks like. A write goes through a temporary file and a rename. bin/neptunia.ts reads and
// writes it for the chat, and a secret never reaches it.
import fs from 'node:fs';
import path from 'node:path';

export type HistoryAttachment = { name: string; contentType: string; reference: string };
export type HistoryRecord = {
  version: 1;
  text: string;
  attachments: ReadonlyArray<HistoryAttachment>;
  at: number;
};

const HEADER = '{"neptuniaChatHistory":1}';

const isAttachment = (value: unknown): value is HistoryAttachment => {
  const one = value as Partial<HistoryAttachment> | null;
  return typeof one?.name === 'string' && typeof one.contentType === 'string' && typeof one.reference === 'string';
};

function parseRecord(line: string): HistoryRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const one = value as Partial<HistoryRecord> | null;
  if (one?.version !== 1 || typeof one.text !== 'string' || typeof one.at !== 'number') return null;
  if (!Array.isArray(one.attachments) || !one.attachments.every(isAttachment)) return null;
  return { version: 1, text: one.text, attachments: one.attachments, at: one.at };
}

/** The records newest first and how many lines were damaged. A missing file is no history. */
export function readHistory(file: string): { records: Array<HistoryRecord>; skipped: number } {
  let lines: Array<string>;
  try {
    lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return { records: [], skipped: 0 };
  }
  if (lines[0] !== HEADER)
    return {
      records: lines.reverse().map((text) => ({ version: 1, text, attachments: [], at: 0 })),
      skipped: 0,
    };
  const records = lines.slice(1).map(parseRecord);
  const kept = records.filter((one) => one !== null);
  return { records: kept, skipped: records.length - kept.length };
}

/** Replaces the file whole, private to the owner. A failure leaves the old file and no temporary one, and is raised. */
export function writeHistory(
  file: string,
  records: ReadonlyArray<HistoryRecord>,
  { rename = fs.renameSync }: { rename?: (from: string, to: string) => void } = {}
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  const text = [HEADER, ...records.map((one) => JSON.stringify(one))].join('\n');
  try {
    fs.writeFileSync(temporary, `${text}\n`, { mode: 0o600 });
    rename(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** The history after one submitted draft: a secret, a blank draft or a repeat of the newest adds nothing. */
export function addToHistory(
  records: ReadonlyArray<HistoryRecord>,
  draft: { text: string; attachments: ReadonlyArray<HistoryAttachment> },
  { now, limit, secret }: { now: number; limit: number; secret?: boolean }
): ReadonlyArray<HistoryRecord> {
  if (secret === true || draft.text.trim() === '' || records[0]?.text === draft.text) return records;
  const added: HistoryRecord = { version: 1, text: draft.text, attachments: draft.attachments, at: now };
  return [added, ...records].slice(0, limit);
}
