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
