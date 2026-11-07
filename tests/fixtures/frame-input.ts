// A `FrameInput` of a mention in a room, for the tests that build a turn frame (src/turn/request/frame.ts). Each case
// overrides what makes it its own kind of turn. The ids are made up.
import type { FrameInput } from '../../src/turn/request/frame.ts';

export const NOW = Date.parse('2026-11-07T12:00:00.000Z');

/** A room's chain as `placeChainInDb` reads it, the place itself first. */
export const ROOM_CHAIN: FrameInput['chain'] = [
  { id: 'place:room', kind: 'channel', name: 'γενικά' },
  { id: 'place:root', kind: 'server', name: 'Αγορά' },
];

/** The chain of a one-to-one chat: a single row with no name. */
export const DM_CHAIN: FrameInput['chain'] = [{ id: 'place:dm', kind: 'dm', name: null }];

export const AUTHOR = { personId: 'person:eleni', accountId: 'account:eleni', name: 'Eleni' };
export const PARTNER = { personId: 'person:zoe', accountId: 'account:zoe', name: 'Zoé' };

/** What a one-to-one chat adds: the interface's word for it and the partner with the partner's native id. */
export const DM: NonNullable<FrameInput['dm']> = { word: 'private', nativeId: '1234', partner: PARTNER };

export function frameInput(overrides: Partial<FrameInput> = {}): FrameInput {
  return {
    mode: 'reply',
    triggerKind: 'mention',
    wakeKind: null,
    interface: 'fake',
    chain: ROOM_CHAIN,
    dm: null,
    trigger: { messageId: 'm1', authorId: '1111' },
    author: AUTHOR,
    now: NOW,
    timezone: 'UTC',
    ...overrides,
  };
}

/** The input of a wake with no place of its own. */
export function wakeInput(wakeKind: FrameInput['wakeKind'], overrides: Partial<FrameInput> = {}): FrameInput {
  return frameInput({ mode: 'inner', triggerKind: 'inner', wakeKind, chain: [], trigger: null, author: null, ...overrides });
}
