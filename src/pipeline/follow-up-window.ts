// A channel's follow-up window and the checks in front of the address classifier. The window is (re)opened and
// extended to `now` whenever the persona sends a message there (the self-message branch of handleMessage, the same
// place turns.notePost() is called), never here. An untagged message that arrives while the window is open is not
// answered blindly: it goes through address.md first (see docs/prompt-contract.md, "The address classifier"). Its
// answer is `yes` (said to the persona: a follow-up turn), `overheard` (about the persona, said to someone else or to
// the room: an overheard turn, or a follow-up with mention.followUpOverheard off) or `no`.
//
// The Map is mirrored into `store.state.data.followUpWindows` (timestamps and a counter only, never message text) so a
// restart does not close every open window; createFollowUpWindows loads the saved entries back when it is built.
// createMessageHandler (src/behavior/pipeline.js) builds it once.

import { followUpPreFilter, isFollowUpOpen } from '../behavior/mention.js';
import { log } from '../log.js';
import { MINUTE_MS } from '../time.js';
import type {
  Conv,
  Line,
  MentionConfig,
  Ping,
  PipelineConfig,
  PipelineHot,
  PipelineState,
  PipelineTurns,
} from './types.ts';

/** One channel's window: when the persona opened it, her last answer there and the "no" verdicts since. */
export type FollowUpWindow = { openedAt: number; lastAnswerAt: number; noStreak: number };

/** What the checks in front of the classifier decided (followUpGate). */
export type FollowUpGate =
  | { kind: 'skip'; reason: string }
  | { kind: 'handled' }
  | { kind: 'classify'; config: PipelineConfig; state: FollowUpWindow };

/** What createFollowUpWindows reads: the dependencies of createMessageHandler and the turn check. */
export type FollowUpWindowsContext = {
  hot: PipelineHot;
  store: { state?: PipelineState } | null | undefined;
  now: () => number;
  turns: PipelineTurns;
  turnBlocked: (channelId: string, config: PipelineConfig) => boolean;
};

export type FollowUpWindows = {
  windowOf: (channelId: string) => FollowUpWindow | undefined;
  noteFollowUpSend: (channelId: string, ts: number) => void;
  bumpFollowUpNoStreak: (channelId: string, state: FollowUpWindow, mentionCfg: MentionConfig) => void;
  followUpOff: (config: PipelineConfig) => boolean;
  followUpMuted: () => 'paused' | null;
  followUpGate: (channel: Conv, normalized: Line, selfId: string) => FollowUpGate;
  followUpStale: (ping: Ping, config: PipelineConfig) => 'closed' | null;
};

export function createFollowUpWindows({
  hot,
  store,
  now,
  turns,
  turnBlocked,
}: FollowUpWindowsContext): FollowUpWindows {
  const followUpWindows = new Map<string, FollowUpWindow>(); // channelId -> { openedAt, lastAnswerAt, noStreak }

  /** Mirror one window into state.json (a fresh copy, numbers only). */
  function persistFollowUpWindow(channelId: string, window: FollowUpWindow): void {
    const state = store?.state;
    if (!state?.data) return;
    if (!state.data.followUpWindows || typeof state.data.followUpWindows !== 'object') state.data.followUpWindows = {};
    state.data.followUpWindows[channelId] = {
      openedAt: window.openedAt,
      lastAnswerAt: window.lastAnswerAt,
      noStreak: window.noStreak,
    };
    state.markDirty?.();
  }

  /** Close a window: drop it from the Map and delete its key from state.json. */
  function closeFollowUpWindow(channelId: string): void {
    followUpWindows.delete(channelId);
    const saved = store?.state?.data?.followUpWindows;
    if (saved && typeof saved === 'object' && Object.hasOwn(saved, channelId)) {
      delete saved[channelId];
      // A saved window lives in the state, so the state is there.
      (store?.state as PipelineState).markDirty?.();
    }
  }

  /**
   * Startup: load the saved windows back, dropping (and deleting from state)
   * any whose last answer is already older than `mention.followUpMinutes`
   * (read now) or that is malformed. Started paused (`/nep pause`), the
   * dropped ones are only left out of the Map: state.json is not touched.
   */
  function loadFollowUpWindows(): void {
    const saved = store?.state?.data?.followUpWindows;
    if (!saved || typeof saved !== 'object') return;
    // Saved windows live in the state's data, so both are there.
    const state = store?.state as PipelineState & { data: NonNullable<PipelineState['data']> };
    const paused = Boolean(state.data.paused);
    const minutes = hot.config.mention?.followUpMinutes ?? 15;
    const t = now();
    let dropped = 0;
    for (const [channelId, entry] of Object.entries(saved)) {
      const valid =
        entry &&
        Number.isFinite(entry.openedAt) &&
        Number.isFinite(entry.lastAnswerAt) &&
        Number.isFinite(entry.noStreak);
      if (valid && t - entry.lastAnswerAt < minutes * MINUTE_MS) {
        followUpWindows.set(channelId, {
          openedAt: entry.openedAt,
          lastAnswerAt: entry.lastAnswerAt,
          noStreak: entry.noStreak,
        });
      } else {
        if (!paused) delete saved[channelId];
        dropped += 1;
      }
    }
    if (dropped > 0 && !paused) state.markDirty?.();
    if (followUpWindows.size > 0 || dropped > 0) {
      log.info('follow-up: windows restored', {
        restored: followUpWindows.size,
        dropped,
        ...(paused ? { paused: true } : {}),
      });
    }
  }
  loadFollowUpWindows();

  /** (Re)opens/extends the window -- called wherever the persona's own message is observed. */
  function noteFollowUpSend(channelId: string, ts: number): void {
    const window = { openedAt: ts, lastAnswerAt: ts, noStreak: 0 };
    followUpWindows.set(channelId, window);
    persistFollowUpWindow(channelId, window);
  }

  /** One "no" verdict (pre-filter or model): bump the streak, close the window once the streak reaches the limit. */
  function bumpFollowUpNoStreak(channelId: string, state: FollowUpWindow, mentionCfg: MentionConfig): void {
    state.noStreak += 1;
    // A window replaced meanwhile (the persona spoke again while a classifier
    // call was in flight) is not the live one: nothing to mirror or close.
    if (followUpWindows.get(channelId) !== state) return;
    if (state.noStreak >= (mentionCfg.followUpNoStreak ?? 5)) {
      log.info('follow-up: window closed', { channel: channelId });
      closeFollowUpWindow(channelId);
    } else {
      persistFollowUpWindow(channelId, state);
    }
  }

  /** Whether the address classifier is switched off (features.followUp or features.mentions false) in `config`. */
  function followUpOff(config: PipelineConfig): boolean {
    const features = config.features ?? {};
    return features.followUp === false || features.mentions === false;
  }

  /**
   * Why the persona is mute right now, as onMessage sees it before any
   * classifier (and a settle wait when it is over): `'paused'` (`/nep
   * pause`) or null.
   */
  function followUpMuted(): 'paused' | null {
    return store?.state?.data?.paused ? 'paused' : null;
  }

  /**
   * The checks in front of the classifier, read from the hot config now:
   * `{ kind: 'skip', reason }` when the classifier does not apply (feature
   * off, no open window, a turn that would refuse this one -- see
   * turnBlocked -- whose "yes" could not be deferred, cannot send), `{ kind: 'handled' }` when the pre-filter
   * already gave a "no" (logged, streak bumped), `{ kind: 'classify', config,
   * state }` when the model must be asked.
   */
  function followUpGate(channel: Conv, normalized: Line, selfId: string): FollowUpGate {
    const config = hot.config;
    if (followUpOff(config)) return { kind: 'skip', reason: 'off' };

    const channelId = channel.id;
    const mentionCfg = config.mention;
    const state = followUpWindows.get(channelId);
    if (!isFollowUpOpen(state, now(), mentionCfg)) {
      if (state) closeFollowUpWindow(channelId); // expired: forget it here and in state.json
      return { kind: 'skip', reason: 'closed' };
    }
    // isFollowUpOpen is false without a window, so there is one here.
    const open = state as FollowUpWindow;
    // A turn that blocks this one (turnBlocked) does not stop the classifier
    // (mention.classifyWhileBusy, missing = on): its "yes" waits in the
    // pending queue (startFollowUpTurn -> deferFollowUp). The paid call is
    // skipped only when that "yes" could not wait: the switch off, or its
    // own channel busy with mention.pendingSameChannel off.
    if (turnBlocked(channelId, config)) {
      const sameChannelDrop = turns.isBusy(channelId) && mentionCfg.pendingSameChannel === false;
      if (mentionCfg.classifyWhileBusy === false || sameChannelDrop) return { kind: 'skip', reason: 'busy' };
    }
    if (!channel.permissions.send) return { kind: 'skip', reason: 'cannot-send' };

    const startedAt = now();
    if (followUpPreFilter(normalized, selfId, mentionCfg)) {
      log.info('follow-up: verdict', {
        channel: channelId,
        author: normalized.authorId,
        verdict: 'no',
        answer: 'no',
        ms: now() - startedAt,
      });
      bumpFollowUpNoStreak(channelId, open, mentionCfg);
      return { kind: 'handled' };
    }
    return { kind: 'classify', config, state: open };
  }

  /**
   * Why a deferred follow-up or overheard line is no longer to be answered
   * at pickup, read now: `closed` -- the window of its channel is not open
   * any more (isFollowUpOpen: mention.followUpMinutes and the no-streak, the
   * rule the classifier used; an expired one is forgotten as the gate does).
   * Null: still to answer. A post of the persona in that channel after the
   * line does not make it answered by itself: the turn that posted may have
   * fetched its history before the line arrived. Whether that turn had the
   * line in view is the drain's spokeAfterSeeing check, made before this one.
   */
  function followUpStale(ping: Ping, config: PipelineConfig): 'closed' | null {
    const window = followUpWindows.get(ping.channelId);
    if (!isFollowUpOpen(window, now(), config.mention)) {
      if (window) closeFollowUpWindow(ping.channelId);
      return 'closed';
    }
    return null;
  }

  /** The window of `channelId`, open or not, as the room classifier checks it. */
  const windowOf = (channelId: string): FollowUpWindow | undefined => followUpWindows.get(channelId);

  return {
    windowOf,
    noteFollowUpSend,
    bumpFollowUpNoStreak,
    followUpOff,
    followUpMuted,
    followUpGate,
    followUpStale,
  };
}
