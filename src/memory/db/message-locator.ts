// Verified message routes shared by the observation writer, record mapper and stored-memory reader.

export type MessageLocator = Readonly<{
  v: 1;
  origin: 'protocol-message' | 'record-v1';
  iface: string;
  chatId: string;
  messageId: string;
}>;

export function locatorText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

export function messageLocator(value: unknown, iface: unknown): MessageLocator | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // The object and array guard permits property reads while every value remains unknown.
  const entry = value as Record<string, unknown>;
  // Rows stored before the chat rename carry `conversationId`; rows written since carry `chatId`.
  const chatId = entry.chatId ?? entry.conversationId;
  if (
    entry.v !== 1 ||
    (entry.origin !== 'protocol-message' && entry.origin !== 'record-v1') ||
    !locatorText(entry.iface) ||
    entry.iface.includes('/') ||
    entry.iface !== iface ||
    !locatorText(chatId) ||
    !locatorText(entry.messageId)
  )
    return null;
  return {
    v: 1,
    origin: entry.origin,
    iface: entry.iface,
    chatId,
    messageId: entry.messageId,
  };
}

/**
 * SQL for the platform's message id a `sources` row under `alias` holds in its message route
 * (`extra.$messageLocator.messageId`), NULL for a row without one. A line written through message families keeps a key
 * of the core's own in `native_id`, so a reader that hands a line's id to an interface, or matches it with an
 * interface's lines, takes this id first.
 */
export const routeMessageSql = (alias: string): string =>
  `CASE WHEN json_valid(${alias}.extra) THEN json_extract(${alias}.extra, '$."$messageLocator".messageId') END`;

/** SQL for the platform's message id of the line a `sources` row under `alias` replies to (`extra.$messageReply`). */
export const replyMessageSql = (alias: string): string =>
  `CASE WHEN json_valid(${alias}.extra) THEN json_extract(${alias}.extra, '$."$messageReply".messageId') END`;

/** A random uuid, the shape of the key message families write in `native_id` (`randomUUID`). */
const CORE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a stored line's message id is one its interface gave and takes back as an anchor: the route gave it, or it is
 * the row's `native_id` and no key the core made itself. A line stored before message routes keeps the platform's id in
 * `native_id`; a line the core wrote itself keeps only a uuid there.
 */
export function interfaceTakes(routeMessage: unknown, nativeId: unknown): boolean {
  if (locatorText(routeMessage)) return true;
  return locatorText(nativeId) && !CORE_KEY.test(nativeId);
}
