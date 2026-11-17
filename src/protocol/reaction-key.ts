// The key one reaction is shown under, shared by the interface that reports a reaction and the core that stores who put
// it: a custom emoji as the protocol token `<emoji:ID>`, a unicode one as itself.

/**
 * The key one reaction is shown under: a custom emoji as `<emoji:ID>`, a unicode one as itself, the same string the
 * interface gives a reaction's `emoji` in a message, so the store and the transcript meet on it. Null without a name.
 */
export function reactionKey(emoji: { id?: string | null; name?: string | null } | null | undefined): string | null {
  if (!emoji?.name) return null;
  return emoji.id ? `<emoji:${emoji.id}>` : emoji.name;
}
