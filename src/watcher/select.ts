// `neptunia services watcher select`: one read-only statement of the watcher agent over the live memory database.
// `selectRefusal` turns away anything but one SELECT before the database is opened, and `selectRows` answers the rows as
// bounded JSON with what looks like a key masked. src/service/watcher.ts holds the read-only connection and calls these.

import type { Db } from '../memory/db/types.ts';
import { maskCredentials } from './report.ts';
import { WATCHER_EVIDENCE_MAX_CHARS } from './requests.ts';

const SELECT_ROWS_MAX = 500;
/** The longest cell a read keeps. */
const SELECT_CELL_MAX = 4000;

/** The statement with its strings, quoted names and comments blanked, so only its own words and semicolons are left. */
const bareSql = (sql: string): string =>
  sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim();

/** Why a statement is no single read; null when it may reach the database. */
export function selectRefusal(sql: string): string | null {
  const bare = bareSql(sql).replace(/;\s*$/, '');
  if (bare.includes(';')) return 'one statement only';
  return /^(?:select|with)\b/i.test(bare) ? null : 'only a SELECT reads here';
}

function maskedCell(value: unknown): { value: unknown; cut: boolean } {
  if (value instanceof Uint8Array) return { value: `[${value.length} bytes]`, cut: false };
  if (typeof value === 'bigint') return { value: String(value), cut: false };
  if (typeof value !== 'string') return { value, cut: false };
  const { text } = maskCredentials(value);
  return text.length > SELECT_CELL_MAX
    ? { value: `${text.slice(0, SELECT_CELL_MAX)}...`, cut: true }
    : { value: text, cut: false };
}

/**
 * The rows of one statement as JSON, `{ rows, truncated }`, its text inside `WATCHER_EVIDENCE_MAX_CHARS`. What looks like a
 * key is masked, a long cell is cut and a binary one becomes its length. The caller holds the read-only connection.
 */
export function selectRows(db: Db, sql: string): string {
  const rows: Array<Record<string, unknown>> = [];
  let chars = JSON.stringify({ rows: [], truncated: true }).length;
  let truncated = false;
  for (const row of db.prepare(sql).iterate()) {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(row)) {
      const cell = maskedCell(value);
      kept[maskCredentials(name).text] = cell.value;
      if (cell.cut) truncated = true;
    }
    chars += JSON.stringify(kept).length + 1;
    if (rows.length >= SELECT_ROWS_MAX || chars > WATCHER_EVIDENCE_MAX_CHARS) {
      truncated = true;
      break;
    }
    rows.push(kept);
  }
  return JSON.stringify({ rows, truncated });
}
