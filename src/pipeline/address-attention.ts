// Attention, the cost rail in front of the address classifier: an unflagged line of a group place goes to the classifier
// only while the persona wrote in that place within `address.attentionMinutes`, read at the moment of use. Her own
// message opens or extends it (the self-message branch of handleMessage, the same place turns.notePost() is called),
// and a verdict never closes it. The times are mirrored into `store.state.data.addressAttention`, numbers only, so a
// restart does not make her deaf to the talk she just joined. createMessageHandler (src/behavior/pipeline.ts) builds it
// once.

import { followUpPreFilter, inAttention } from '../behavior/mention.ts';
import { log } from '../log.ts';
import { MINUTE_MS } from '../time.ts';
import type { Conv, Line, Ping, PipelineConfig, PipelineHot, PipelineState } from './types.ts';

/** What the checks in front of the classifier decided (addressGate). */
export type AddressGate =
  { kind: 'skip'; reason: string } | { kind: 'handled' } | { kind: 'classify'; config: PipelineConfig };

/** What createAddressAttention reads: the dependencies of createMessageHandler. */
export type AddressAttentionContext = {
  hot: PipelineHot;
  store: { state?: PipelineState } | null | undefined;
  now: () => number;
};

export type AddressAttention = {
  noteAttention: (iface: string, placeId: string, ts: number) => void;
  followUpMuted: () => 'paused' | null;
  addressGate: (channel: Conv, normalized: Line, selfId: string) => AddressGate;
  followUpStale: (ping: Ping, config?: PipelineConfig) => 'closed' | null;
};

/** One place's key: two interfaces may share a native id. */
const keyOf = (iface: string, placeId: string): string => JSON.stringify([iface, placeId]);

export function createAddressAttention({ hot, store, now }: AddressAttentionContext): AddressAttention {
  const lastPosts = new Map<string, number>();
  const minutes = (): number => hot.config.address?.attentionMinutes ?? 0;

  /** Startup: load the saved times back, dropping a malformed one or one already outside the window. */
  function loadAttention(): void {
    const data = store?.state?.data;
    const saved = data?.addressAttention;
    if (!data || !saved || typeof saved !== 'object') return;
    const paused = Boolean(data.paused);
    let dropped = 0;
    for (const [key, at] of Object.entries(saved)) {
      if (Number.isFinite(at) && now() - at < minutes() * MINUTE_MS) lastPosts.set(key, at);
      else {
        if (!paused) delete saved[key];
        dropped += 1;
      }
    }
    if (dropped > 0 && !paused) store?.state?.markDirty?.();
  }
  loadAttention();

  /** Her own message in a place: called wherever it is observed. */
  function noteAttention(iface: string, placeId: string, ts: number): void {
    const key = keyOf(iface, placeId);
    lastPosts.set(key, ts);
    const state = store?.state;
    if (!state?.data) return;
    state.data.addressAttention = { ...state.data.addressAttention, [key]: ts };
    state.markDirty?.();
  }

  /** Why the persona is mute right now: `'paused'` (`/nep pause`) or null. */
  function followUpMuted(): 'paused' | null {
    return store?.state?.data?.paused ? 'paused' : null;
  }

  /**
   * The checks in front of the classifier for an unflagged line, read from the hot config now: `skip` outside attention
   * or where she cannot send, `handled` when the pre-filter already gave a `no` (logged), `classify` when the model
   * must be asked.
   */
  function addressGate(channel: Conv, normalized: Line, selfId: string): AddressGate {
    const placeId = channel.id;
    if (!inAttention(lastPosts.get(keyOf(channel.iface, placeId)), now(), minutes()))
      return { kind: 'skip', reason: 'closed' };
    // A turn that blocks this one does not stop the classifier: its "yes" waits in the pending queue.
    if (!channel.permissions.send) return { kind: 'skip', reason: 'cannot-send' };
    if (followUpPreFilter(normalized, selfId)) {
      log.info('follow-up: verdict', {
        channel: placeId,
        author: normalized.authorId,
        verdict: 'no',
        answer: 'no',
        ms: 0,
      });
      return { kind: 'handled' };
    }
    return { kind: 'classify', config: hot.config };
  }

  /**
   * Why a deferred follow-up or overheard line is no longer to be answered at pickup, read now: `closed`, attention of
   * its place has passed. Null: still to answer. A post of the persona there after the line does not make it answered by
   * itself, because the turn that posted may have fetched its history before the line arrived. Whether that turn had the
   * line in view is the drain's spokeAfterSeeing check, made before this one.
   */
  function followUpStale(ping: Ping): 'closed' | null {
    const key = keyOf(ping.channel.iface, ping.placeId);
    return inAttention(lastPosts.get(key), now(), minutes()) ? null : 'closed';
  }

  return { noteAttention, followUpMuted, addressGate, followUpStale };
}
