// How the persona's words are rendered and timed before they go out: a post's mentions, custom emoji, jump links and
// channel links, the wait for the trigger's author to fall quiet, the name of her diary's place for `<senses>`, and one
// dry-run mirror message. createTurnRunner (src/behavior/turn.js) builds it once per runner with createSends; the act,
// the dry act, her calls and the attempt call its functions.

import { settleWait } from '../behavior/activity.js';
import { messageLinkOf } from '../behavior/elsewhere.ts';
import type { IndexedEmoji } from '../behavior/emoji-index.ts';
import { renderCustomEmoji } from '../behavior/emoji.js';
import { resolveHandles } from '../behavior/handles.js';
import { mirrorDryRun } from '../behavior/limits.js';
import { diaryPlaces, readMirrors } from '../behavior/mirror.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { log } from '../log.js';
import { linkChannels, linkMessageNumbers } from '../memory/mentions.ts';
import { resolveMentions } from './mentions.ts';
import { inCommunity } from './routing.ts';
import { SETTLE_STEP_MS, paceSettings } from './settings.ts';
import { withLink } from './targets.ts';

/** The live config, as far as the sends read it. */
export type SendsConfig = {
  features?: { messageLinks?: unknown; channelLinks?: unknown; customEmoji?: unknown; diary?: unknown } | null;
  bot?: { dryRunChannelId?: string } | null;
};

/** The labels a post's jump link is joined with (prompts.labels). */
type SendsLabels = { elsewhere?: { link?: unknown } | null } | null | undefined;

/** The interface port (src/interface/port.js), as the dry-run mirror posts through it. */
type MirrorPort = Parameters<typeof mirrorDryRun>[0]['port'];

/** What createSends reads: the dependencies and the runner state the sends use. */
export type SendsContext = {
  hot: { readonly config: SendsConfig; readonly prompts: { labels?: SendsLabels } | null | undefined };
  store: unknown;
  emoji: { byName: (name: string) => IndexedEmoji | null } | null | undefined;
  conversationName: (id: string) => string | null | undefined;
  clock: () => number;
  schedule: (run: () => void, ms: number) => unknown;
  activity: { lastAt: (channelId: string, authorId: string) => number | null } | null;
  iface: MirrorPort;
};

/** What a channel a post is rendered for holds. */
type PostChannel = { id: string; communityId?: string | null };

/** How a post's `#n` numbers and mentions are resolved. */
type RenderArgs = {
  channel: PostChannel;
  snapshot?: Snapshot | null;
  guildId: string | null;
  privateChat: boolean;
  idByIndex: ReadonlyMap<number, string> | null | undefined;
  pulledIds?: ReadonlyMap<string, string> | null;
  lines?: Parameters<typeof resolveMentions>[1] | null;
  knownNames?: Parameters<typeof resolveMentions>[2] | null;
  directory?: (() => Parameters<typeof resolveMentions>[3]) | null;
  handles?: Map<string, string> | null;
  channelHandles?: unknown;
  link?: string | null;
  quiet?: boolean;
};

/** A post as it is sent: its text, the text before any link, and the members it mentions. */
export type RenderedPost = { text: string; spoken: string; userIds: Array<string | undefined> };

export type Sends = {
  emojiLookup: () => ((name: string) => IndexedEmoji | null) | null;
  renderPost: (written: string, args: RenderArgs) => RenderedPost;
  settleAuthor: (
    channelId: string,
    trigger: { authorId?: string | null; ts?: unknown } | null | undefined
  ) => Promise<number>;
  diaryChannelName: (
    guildId: string,
    config: SendsConfig,
    snapshot?: Snapshot | null,
    own?: { id: string; name?: string | null } | null
  ) => string | null;
  mirror: (header: string, body: string) => Promise<boolean>;
};

export function createSends(ctx: SendsContext): Sends {
  const { hot, store, emoji, conversationName, clock, schedule, activity, iface } = ctx;

  /**
   * `text` with every transcript number `#n` of this turn's numbering (`idByIndex`, chat and
   * pulled lines) turned into the jump link of that message (src/memory/mentions.ts#linkMessageNumbers):
   * features.messageLinks on (read now; a missing key counts as on). A pulled line links in its own
   * channel (`pulledIds`), any other in `channelId`; a private chat uses `@me` for the guild.
   */
  function withMessageLinks(
    text: string,
    {
      guildId,
      channelId,
      privateChat,
      idByIndex,
      pulledIds,
    }: {
      guildId: string | null;
      channelId: string;
      privateChat: boolean;
      idByIndex: ReadonlyMap<number, string> | null | undefined;
      pulledIds?: ReadonlyMap<string, string> | null;
    }
  ): string {
    if (hot.config.features?.messageLinks === false || !idByIndex) return text;
    const community = privateChat || !guildId ? null : guildId;
    return linkMessageNumbers(text, (n) => {
      const messageId = idByIndex.get(n);
      if (!messageId) return null;
      return messageLinkOf(iface, community, pulledIds?.get(messageId) ?? channelId, messageId);
    });
  }

  /**
   * `text` with every `#handle` of `channelHandles` (the request's handle -> channel id) and, with
   * features.channelLinks on (read now; a missing key counts as on), every `#name` of one of the
   * community's text channels (the turn's snapshot) turned into its `<#id>` link (src/memory/mentions.ts#linkChannels; a
   * handle first, exactly). A private chat has no guild: only its handles, if any, are linked.
   */
  function withChannelLinks(
    channel: PostChannel,
    text: string,
    channelHandles: unknown = null,
    snapshot: Snapshot | null = null
  ): string {
    // A Map of the request is handle -> channel id (src/behavior/prompt.js).
    const handles = channelHandles instanceof Map ? (channelHandles as Map<string, string>) : null;
    if (hot.config.features?.channelLinks === false) return handles ? linkChannels(text, [], handles) : text;
    if (!snapshot || !inCommunity(channel)) return handles ? linkChannels(text, [], handles) : text;
    const channels = snapshot.conversations.map((entry) => ({ id: entry.id, name: entry.name }));
    return linkChannels(text, channels, handles);
  }

  /** The custom emoji lookup, or null when there is no index or features.customEmoji is off (read now). */
  function emojiLookup(): ((name: string) => IndexedEmoji | null) | null {
    return emoji && hot.config.features?.customEmoji !== false ? emoji.byName : null;
  }

  /**
   * The persona's `text` as it is posted -- a `<msg>`, or the text of her `message.create` /
   * `message.edit` call: with `handles` (the request's handle -> member id map,
   * features.mentionHandles on) only an exact `@handle` becomes a mention and no name is ever
   * matched (src/behavior/handles.js#resolveHandles; a handle-shaped token the map does not hold
   * stays text and is logged `turn: unknown handle` with `count`, unless `quiet`); without them
   * `@name` resolved over `lines`, then `knownNames`, then the fallback
   * `directory` (a thunk, only called when the text has an `@`; resolveMentions), custom
   * emoji after the mentions (`<@id>` has no `:name:` in it to break), transcript numbers into jump
   * links (withMessageLinks), channel names into channel links (withChannelLinks), then `link`
   * joined (withLink). Resolves
   * `text` (as sent), `spoken` (before any link: what the typing time is taken from) and
   * `userIds` (the members it mentions: the only ones a send may notify, allowedMentions).
   */
  function renderPost(
    written: string,
    {
      channel,
      snapshot = null,
      guildId,
      privateChat,
      idByIndex,
      pulledIds,
      lines,
      knownNames,
      directory = null,
      handles = null,
      channelHandles = null,
      link = null,
      quiet = false,
    }: RenderArgs
  ): RenderedPost {
    let mentioned: { text: string; userIds: Array<string | undefined>; unknown?: number };
    if (handles instanceof Map) {
      const resolved = resolveHandles(written, handles);
      mentioned = resolved;
      if (resolved.unknown > 0 && !quiet)
        log.info('turn: unknown handle', { channel: channel.id, count: resolved.unknown });
    } else {
      const fallback = typeof directory === 'function' && String(written ?? '').includes('@') ? directory() : [];
      mentioned = resolveMentions(written, lines ?? [], knownNames ?? [], fallback);
    }
    const spoken = renderCustomEmoji(mentioned.text, emojiLookup());
    const text = withLink(
      withChannelLinks(
        channel,
        withMessageLinks(spoken, { guildId, channelId: channel.id, privateChat, idByIndex, pulledIds }),
        channelHandles,
        snapshot
      ),
      link,
      hot.prompts?.labels
    );
    return { text, spoken, userIds: mentioned.userIds };
  }

  /**
   * Wait until `trigger`'s author has been quiet in `channelId` for pace.settleMs (read at every
   * check), never past pace.settleMaxMs from the trigger message's time (the start of the wait
   * when that is unknown), checking the activity again at least every SETTLE_STEP_MS so a new
   * message of theirs restarts the count; the pauses run on the injected `schedule`. Resolves
   * the milliseconds actually waited: 0 with no activity tracker, no trigger author or settle
   * off. Never rejects: a failing check ends the wait.
   */
  async function settleAuthor(
    channelId: string,
    trigger: { authorId?: string | null; ts?: unknown } | null | undefined
  ): Promise<number> {
    const authorId = trigger?.authorId;
    if (!activity || !authorId) return 0;
    const settleStartedAt = clock();
    // Number.isFinite is true only for a number.
    const triggerAt = Number.isFinite(trigger.ts) ? (trigger.ts as number) : settleStartedAt;
    try {
      for (;;) {
        const { settleMs, settleMaxMs } = paceSettings(hot.config);
        const wait = settleWait({
          now: clock(),
          triggerAt,
          lastAt: activity.lastAt(channelId, authorId),
          settleMs,
          settleMaxMs,
        });
        if (!(wait > 0)) break;
        await new Promise<void>((resolve) => {
          schedule(resolve, Math.min(wait, SETTLE_STEP_MS));
        });
      }
    } catch (err) {
      log.warn('turn: settle failed', { channel: channelId, error: err });
    }
    return clock() - settleStartedAt;
  }

  /**
   * The bare name of her diary's place for `<senses>`: a diary turn's own conversation (`own`), else the first of
   * mirror.ts#diaryPlaces, as the snapshot, the directory or memory names it; null with none or `features.diary` off.
   */
  function diaryChannelName(
    guildId: string,
    config: SendsConfig,
    snapshot: Snapshot | null = null,
    own: { id: string; name?: string | null } | null = null
  ): string | null {
    const found = own ? { conversationId: String(own.id), name: own.name } : readMirrors(store, diaryPlaces, [])[0];
    const place = config.features?.diary === false ? null : (found ?? null);
    if (!place) return null;
    const name = snapshot?.get(place.conversationId)?.name ?? conversationName(place.conversationId) ?? place.name;
    return typeof name === 'string' && name ? name : null;
  }

  /** One dry-run mirror message (src/behavior/limits.js#mirrorDryRun), `bot.dryRunChannelId` read now. */
  function mirror(header: string, body: string): Promise<boolean> {
    return mirrorDryRun({ port: iface, dryRunChannelId: hot.config.bot?.dryRunChannelId || '', header, body });
  }

  return { emojiLookup, renderPost, settleAuthor, diaryChannelName, mirror };
}
