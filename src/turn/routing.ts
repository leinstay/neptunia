// Which channels a turn can name: the `<channel_directory>` input, the snapshot an attempt took and whether a chat
// belongs to a root. src/behavior/turn.ts asks these per attempt.

import type { Snapshot } from '../behavior/snapshot.ts';

/** Whether a chat belongs to a root (a channel or a thread), not a private chat. */
export const inRoot = (channel: { rootId?: string | null } | null | undefined): boolean =>
  channel?.rootId !== null && channel?.rootId !== undefined;

/** The snapshot a turn attempt took, kept on its draft. */
export function snapshotOfDraft(draft: { snapshot?: Snapshot | null } | null | undefined): Snapshot | null {
  return draft?.snapshot ?? null;
}
