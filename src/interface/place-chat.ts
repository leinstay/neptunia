// The chat an interface speaks to for a stored place, for a read or a send of the core: the address the place holds
// (`places.native_id`, the chat id the interface gave in a message), handed back as it is, for a direct chat as for a
// channel. Nothing here parses or builds an address. A direct chat whose place holds no address yet, because no message
// of it was observed since addresses were stored or she writes to the person first, is opened once through the
// interface's `dm.chat` read for its partner's account, and the answer is stored on the place through the one writer
// (`note`), so the next read takes it from the place. Called by conversation.read (src/turn/in-turn-tools.ts) and by
// the posting checks (src/tools/operations/shared.ts).

import { CODE } from '../tools/codes.ts';
import type { PlaceRef } from '../memory/db/frame-reads.ts';
import type { ChatRef } from '../protocol/adapter.ts';
import type { Reads } from './reads.ts';

/** The chat of a place, or the code of why there is none: the interface's own, or `unknown-conversation`. */
export type PlaceChat = { ok: true; chat: ChatRef } | { ok: false; code: string };

const UNKNOWN: PlaceChat = { ok: false, code: CODE.UNKNOWN_CONVERSATION };

/**
 * The chat of the stored place `placeId`, whose row `ref` holds (frame-reads.ts#placeRefOf), null without a row.
 * `reads` opens a direct chat that holds no address; `note(placeId, address)` stores what it answered.
 */
export async function chatOfStoredPlace({
  placeId,
  ref,
  reads,
  note,
}: {
  placeId: string;
  ref: PlaceRef | null;
  reads: Pick<Reads, 'answer'> | null;
  note: ((placeId: string, address: string) => Promise<unknown>) | null;
}): Promise<PlaceChat> {
  if (ref === null) return UNKNOWN;
  if (ref.nativeId !== null) return { ok: true, chat: { iface: ref.iface, chatId: ref.nativeId } };
  if (ref.kind !== 'dm' || ref.partnerNativeId === null || reads === null) return UNKNOWN;
  const opened = await reads.answer('dmChatOf', { iface: ref.iface, accountId: ref.partnerNativeId });
  if (opened.status !== 'ok') return { ok: false, code: opened.code };
  try {
    await note?.(placeId, opened.chatId);
  } catch {
    // The chat is used now all the same; a place left without its address is opened again at its next read.
  }
  return { ok: true, chat: { iface: ref.iface, chatId: opened.chatId } };
}
