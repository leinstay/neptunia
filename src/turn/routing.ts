// Which channels a turn can name: the `<channel_directory>` input, the snapshot an attempt took and whether a chat
// belongs to a root. src/behavior/turn.ts asks these per attempt.

import { isReadable } from '../behavior/snapshot.ts';
import type { Snapshot } from '../behavior/snapshot.ts';

/**
 * `<channel_directory>`'s input: every channel of the snapshot's root the persona may read (never a thread), as
 * `{ id, name }`. None without a listing (a private chat, an interface that offers none).
 */
export function channelDirectoryOf(
  snapshot: Snapshot | null | undefined
): Array<{ id: string; name: string | null | undefined }> {
  return (snapshot?.chats ?? [])
    .filter((entry) => isReadable(entry))
    .map((entry) => ({ id: entry.id, name: entry.name }));
}

/** Whether a chat belongs to a root (a channel or a thread), not a private chat. */
export const inRoot = (channel: { rootId?: string | null } | null | undefined): boolean =>
  channel?.rootId !== null && channel?.rootId !== undefined;

/** The snapshot a turn attempt took, kept on its draft. */
export function snapshotOfDraft(draft: { snapshot?: Snapshot | null } | null | undefined): Snapshot | null {
  return draft?.snapshot ?? null;
}
