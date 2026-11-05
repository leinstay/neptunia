// The people of a memory session's batch (session.ts): the accounts and participants that wrote its lines, the handles
// `people:add` names, and the people the request shows in `<people>`. Her own account names her lines and is never one
// of the people she reads about, nor an author to add (identity-links.ts). Pure reads on the connection it is given.

import { nativeOf } from './ids.ts';
import type { Db, Row } from './types.ts';

const parseJson = (text: unknown): unknown => {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** An account a batch touches: its person, its native id and its first name. */
export type BatchAccount = { personId: unknown; isSelf: boolean; native: string; name: string };
/** An author of a batch who may be added as a person: an account or a participant. */
export type BatchAuthor = { kind: 'account' | 'participant'; id: string; hasPerson: boolean };
/** A person a batch touches: the id, the native id and the name, with the count of lines. */
export type BatchPerson = { id: string; native: string; name: string; count: number };

/**
 * The accounts that wrote a batch's lines. Her own account keeps its name for the line and has no person she reads
 * about, even on an edit of her line, which is stored `seen`.
 */
function batchAccountsOf(db: Db, batch: ReadonlyArray<Row>): Map<string, BatchAccount> {
  const accounts = new Map<string, BatchAccount>();
  for (const id of new Set(batch.map((line) => line.author_account as string).filter(Boolean))) {
    const row = db.prepare('SELECT id, person_id, native_id, names, kind FROM accounts WHERE id = ?').get(id);
    if (!row) continue;
    const names = parseJson(row.names);
    const isSelf = row.kind === 'self';
    accounts.set(id, {
      personId: isSelf ? null : row.person_id,
      isSelf,
      native: (row.native_id ?? nativeOf(id)) as string,
      name:
        Array.isArray(names) && typeof names[0] === 'string' && names[0] ? names[0] : ((row.native_id ?? id) as string),
    });
  }
  return accounts;
}

/** The author of a line who may become a person: its participant, else its account unless the account is hers. */
function authorOf(
  line: Row,
  accounts: Map<string, BatchAccount>,
  participants: Map<string, { name: string }>
): { kind: 'account' | 'participant'; id: string } | null {
  const participant = line.author_participant as string;
  if (participant && participants.has(participant)) return { kind: 'participant', id: participant };
  const account = line.author_account as string;
  return account && accounts.get(account)?.isSelf === false ? { kind: 'account', id: account } : null;
}

/**
 * The names and ids of the accounts and people a batch touches, and its authors: every account and participant (schema
 * v8) that wrote a line of it apart from her, in order of their first line, each with a handle `aN` (`authors`: handle ->
 * `{ kind: 'account' | 'participant', id, hasPerson }`), the handles `people:add` names (docs/prompt-contract.md).
 */
export function peopleOf(
  db: Db,
  batch: ReadonlyArray<Row>,
  selfName: unknown
): {
  accounts: Map<string, BatchAccount>;
  participants: Map<string, { name: string }>;
  authors: Map<string, BatchAuthor>;
  people: Array<BatchPerson>;
  selfName: unknown;
} {
  const accounts = batchAccountsOf(db, batch);
  const participants = new Map<string, { name: string }>();
  for (const id of new Set(batch.map((line) => line.author_participant as string).filter(Boolean))) {
    const row = db.prepare('SELECT id, display FROM participants WHERE id = ?').get(id);
    if (row) participants.set(id, { name: (row.display as string) || '?' });
  }
  const authors = new Map<string, BatchAuthor>();
  const handled = new Set<string>();
  for (const line of batch) {
    if (line.kind === 'said') continue;
    const entry = authorOf(line, accounts, participants);
    if (!entry || handled.has(entry.id)) continue;
    handled.add(entry.id);
    authors.set(`a${authors.size + 1}`, {
      ...entry,
      hasPerson: entry.kind === 'account' ? Boolean(accounts.get(entry.id)?.personId) : false,
    });
  }
  const byPerson = new Map<unknown, BatchPerson>();
  for (const line of batch) {
    if (line.kind === 'said') continue;
    const account = accounts.get(line.author_account as string);
    if (!account?.personId) continue;
    const entry: BatchPerson = byPerson.get(account.personId) ?? {
      id: account.personId as string,
      native: account.native,
      name: account.name,
      count: 0,
    };
    entry.count += 1;
    byPerson.set(account.personId, entry);
  }
  return {
    accounts,
    participants,
    authors,
    people: [...byPerson.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    selfName,
  };
}
