// The message writer resolves verified history into chat-qualified families.

import { nativeLocatorOf } from './source-locator.ts';
import { locatorText } from './message-locator.ts';
import type { NativeMessageLocator } from './recall.ts';
import type { Db, Row } from './types.ts';

export type MessageFamily = {
  iface: string;
  conversation_id: string;
  message_id: string;
  generation: number;
  authority_id: string;
  native_kind: string;
  native_key: string;
};

/** Whether the catalog exists yet: a migration before it, or a test's old schema, has none. */
export const hasMessageFamilies = (db: Db): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'message_families'").get() !==
  undefined;

export function familyError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

const address = (row: MessageFamily): string =>
  JSON.stringify([row.iface, row.conversation_id, row.message_id, row.generation]);
const identity = (row: MessageFamily): string =>
  JSON.stringify([row.authority_id, row.native_kind, row.native_key, row.generation]);

function extraOf(row: Row): Row {
  try {
    const value: unknown = JSON.parse(typeof row.extra === 'string' ? row.extra : '{}');
    // JSON objects expose unknown properties after the object and array guards.
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
  } catch {
    return {};
  }
}

/** Every retained revision contributes to the historical family agreement. */
function familiesOf(rows: Array<Row>): Array<MessageFamily> {
  const byAddress = new Map<string, MessageFamily>();
  const byIdentity = new Map<string, string>();
  for (const row of rows) {
    const locator = nativeLocatorOf(row, extraOf(row));
    if (!locator || !locatorText(row.authority_id) || !locatorText(row.native_kind) || !locatorText(row.native_id))
      continue;
    const family: MessageFamily = {
      iface: locator.iface,
      conversation_id: locator.chatId,
      message_id: locator.messageId,
      generation: typeof row.generation === 'number' ? row.generation : 1,
      authority_id: row.authority_id,
      native_kind: row.native_kind,
      native_key: row.native_id,
    };
    const key = address(family);
    const tuple = identity(family);
    const previous = byAddress.get(key);
    if ((previous && identity(previous) !== tuple) || (byIdentity.has(tuple) && byIdentity.get(tuple) !== key))
      throw familyError('CONVERSATION_CONFLICT');
    byAddress.set(key, family);
    byIdentity.set(tuple, key);
  }
  return [...byAddress.values()];
}

// Rows stored before the chat rename name the chat `chatId`, rows written since `chatId`.
const locatorChat = `CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$."$messageLocator".chatId'), json_extract(extra, '$."$messageLocator".conversationId')) END`;
const locatorMessage = `CASE WHEN json_valid(extra) THEN json_extract(extra, '$."$messageLocator".messageId') END`;

/** Resolves one historical address, then checks every retained revision of its candidate families. */
export function historicalFamily(db: Db, locator: NativeMessageLocator, generation: number): MessageFamily | undefined {
  const marked = db
    .prepare(
      `SELECT * FROM sources WHERE iface = ? AND ${locatorChat} = ? AND ${locatorMessage} = ? AND generation = ?`
    )
    .all(locator.iface, locator.chatId, locator.messageId, generation);
  const legacy = db
    .prepare('SELECT * FROM sources WHERE iface = ? AND native_id = ? AND generation = ?')
    .all(locator.iface, locator.messageId, generation);
  const matching = [...marked, ...legacy].filter((row) => {
    const actual = nativeLocatorOf(row, extraOf(row));
    return (
      actual?.iface === locator.iface && actual.chatId === locator.chatId && actual.messageId === locator.messageId
    );
  });
  const candidates = familiesOf(matching);
  const retained = candidates.flatMap((family) =>
    db
      .prepare(
        `SELECT * FROM sources
    WHERE authority_id = ? AND native_kind = ? AND native_id = ? AND generation = ?`
      )
      .all(family.authority_id, family.native_kind, family.native_key, family.generation)
  );
  return familiesOf(retained).find(
    (family) =>
      family.iface === locator.iface &&
      family.conversation_id === locator.chatId &&
      family.message_id === locator.messageId &&
      family.generation === generation
  );
}

export function insertFamily(db: Db, row: MessageFamily): void {
  const collision = db
    .prepare(
      `SELECT iface, conversation_id, message_id FROM message_families
    WHERE authority_id = ? AND native_kind = ? AND native_key = ? AND generation = ?`
    )
    .get(row.authority_id, row.native_kind, row.native_key, row.generation);
  if (
    collision &&
    (collision.iface !== row.iface ||
      collision.conversation_id !== row.conversation_id ||
      collision.message_id !== row.message_id)
  )
    throw familyError('CONVERSATION_CONFLICT');
  db.prepare(
    `INSERT INTO message_families
    (iface, conversation_id, message_id, generation, authority_id, native_kind, native_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.iface,
    row.conversation_id,
    row.message_id,
    row.generation,
    row.authority_id,
    row.native_kind,
    row.native_key
  );
}
