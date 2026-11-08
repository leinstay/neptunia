// How the persona's words are rendered and timed before they go out: a post's mentions, custom emoji, jump links and
// channel links, the wait for the trigger's author to fall quiet and the name of her selfreflection's place for `<senses>`.
// createTurnRunner (src/behavior/turn.ts) builds it once per runner with createSends; the act, her calls and the
// attempt call its functions.

import type { Chat } from '../protocol/events.ts';
import { settleWait } from '../behavior/activity.ts';
import { messageLinkOf } from '../behavior/elsewhere.ts';
import type { IndexedEmoji } from '../behavior/emoji-index.ts';
import { renderCustomEmoji } from '../behavior/emoji.ts';
import { resolveHandles } from '../behavior/handles.ts';
import { selfreflectionPlaces, readMirrors } from '../behavior/mirror.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { log } from '../log.ts';
import { nativeOfAny } from '../memory/db/ids.ts';
import { linkChannels, linkMessageNumbers } from '../memory/mentions.ts';
import { resolveMentions } from './mentions.ts';
import { inRoot } from './routing.ts';
import { SETTLE_STEP_MS, paceSettings } from './settings.ts';
import { withLink } from './targets.ts';
import { outgoingRefs } from './request/refs.ts';
import type { LineOf } from './request/refs.ts';

/** The live config, as far as the sends read it. */
export type SendsConfig = Record<string, unknown>;

/** The labels a post's jump link is joined with (prompts.labels). */
type SendsLabels = { elsewhere?: { link?: unknown } | null } | null | undefined;

/** The interface port (src/interface/port.ts), as a jump link names its interface. */
type MirrorPort = Parameters<typeof messageLinkOf>[0];

/** What createSends reads: the dependencies and the runner state the sends use. */
export type SendsContext = {
  hot: { readonly config: SendsConfig; readonly prompts: { labels?: SendsLabels } | null | undefined };
  store: unknown;
  emoji: { byName: (name: string) => IndexedEmoji | null } | null | undefined;
  chatName: (id: string) => string | null | undefined;
  clock: () => number;
  schedule: (run: () => void, ms: number) => unknown;
  activity: { lastAt: (placeId: string, authorId: string) => number | null } | null;
  iface: MirrorPort;
};

/** The channel a post is rendered for, as the interface described it: its id, and its root for a link. */
type PostChannel = Pick<Chat, 'id' | 'rootId'>;

/** How a post's `#n` numbers and mentions are resolved. */
type RenderArgs = {
  channel: PostChannel;
  snapshot?: Snapshot | null;
  placeId: string | null;
  dmChat: boolean;
  idByIndex: ReadonlyMap<number, string> | null | undefined;
  pulledIds?: ReadonlyMap<string, string> | null;
  lines?: Parameters<typeof resolveMentions>[1] | null;
  knownNames?: Parameters<typeof resolveMentions>[2] | null;
  directory?: (() => Parameters<typeof resolveMentions>[3]) | null;
  handles?: Map<string, string> | null;
  channelHandles?: unknown;
  link?: string | null;
  quiet?: boolean;
  /** How a line's identity in her words is read back (src/turn/request/refs.ts); absent: identities go out as written. */
  refs?: PostRefs | null;
};

/** A request on the frame's reader of lines, the stored id of the place she posts in and the zone a quote dates in. */
export type PostRefs = { lineOf: LineOf; placeId: string; timezone: string };

/** A post as it is sent: its text, the text before any link, and the members it mentions. */
export type RenderedPost = {
  text: string;
  spoken: string;
  accountIds: Array<string | undefined>;
  /** A line of this place her words named by its identity: the post goes out as a reply to it. */
  replyTo?: string | null;
};

export type Sends = {
  emojiLookup: () => ((name: string) => IndexedEmoji | null) | null;
  renderPost: (written: string, args: RenderArgs) => RenderedPost;
  settleAuthor: (
    placeId: string,
    trigger: { authorId?: string | null; ts?: unknown } | null | undefined
  ) => Promise<number>;
  selfreflectionChannelName: (
    placeId: string,
    config: SendsConfig,
    snapshot?: Snapshot | null,
    own?: { id: string; name?: string | null } | null
  ) => string | null;
};

export function createSends(ctx: SendsContext): Sends {
  const { hot, store, emoji, chatName, clock, schedule, activity, iface } = ctx;

  /**
   * `text` with every transcript number `#n` of this turn's numbering (`idByIndex`, chat and
   * pulled lines) turned into the jump link of that message (src/memory/mentions.ts#linkMessageNumbers):
   * features.messageLinks on (read now; a missing key counts as on). A pulled line links in its own
   * channel (`pulledIds`), any other in `chat`; `root` and `chat` are the values of the address
   * template's slots (src/behavior/elsewhere.ts#messageLinkOf), and a private chat has no root.
   */
  function withMessageLinks(
    text: string,
    slots: {
      root: string | null;
      chat: string;
      dmChat: boolean;
      idByIndex: ReadonlyMap<number, string> | null | undefined;
      pulledIds?: ReadonlyMap<string, string> | null;
    }
  ): string {
    const { chat, dmChat, idByIndex, pulledIds } = slots;
    if (!idByIndex) return text;
    const root = dmChat || !slots.root ? null : slots.root;
    return linkMessageNumbers(text, (n) => {
      const messageId = idByIndex.get(n);
      if (!messageId) return null;
      return messageLinkOf(iface, root, pulledIds?.get(messageId) ?? chat, messageId);
    });
  }

  /**
   * `text` with every `#handle` of `channelHandles` (the request's handle -> channel id) and, with
   * features.channelLinks on (read now; a missing key counts as on), every `#name` of one of the
   * root's text channels (the turn's snapshot) turned into its `<#id>` link (src/memory/mentions.ts#linkChannels; a
   * handle first, exactly). A private chat has no place: only its handles, if any, are linked.
   */
  function withChannelLinks(
    channel: PostChannel,
    text: string,
    channelHandles: unknown = null,
    snapshot: Snapshot | null = null
  ): string {
    // A Map of the request is handle -> channel id (src/behavior/prompt.ts).
    const handles = channelHandles instanceof Map ? (channelHandles as Map<string, string>) : null;
    if (!snapshot || !inRoot(channel)) return handles ? linkChannels(text, [], handles) : text;
    const channels = snapshot.chats.map((entry) => ({ id: entry.id, name: entry.name }));
    return linkChannels(text, channels, handles);
  }

  /**
   * `written` with each line identity in the interface's form (src/turn/request/refs.ts#outgoingRefs): a line of this
   * place becomes the reply target, a line of another place on this interface its jump link, and anything else, the
   * command line included, the quote with its path and time.
   */
  function withRefs(written: string, refs: PostRefs | null | undefined): { text: string; replyTo: string | null } {
    if (!refs || typeof written !== 'string') return { text: written, replyTo: null };
    const here = refs.placeId.slice(0, refs.placeId.indexOf(':'));
    const labels = (hot.prompts?.labels ?? {}) as Parameters<typeof outgoingRefs>[1]['labels'];
    return outgoingRefs(written, {
      placeId: refs.placeId,
      lineOf: refs.lineOf,
      linkOf: (line) => {
        const chat = line.dm ? null : nativeOfAny(line.placeId);
        if (!chat || !line.placeId.startsWith(`${here}:`)) return null;
        return messageLinkOf(iface, rootOfPlace(line.placeId), chat, line.messageId);
      },
      labels,
      timezone: refs.timezone,
    });
  }

  /** The native id of the top place above `placeId` (`store.rootPlaceOf`), null when it is its own top or has none. */
  function rootOfPlace(placeId: string): string | null {
    const known = store as { rootPlaceOf?(id: string): string | null; nativeRootOf?(id: string): string | null };
    const top = known.rootPlaceOf?.(placeId) ?? null;
    return top === null || top === placeId ? null : (known.nativeRootOf?.(top) ?? null);
  }

  /** The custom emoji lookup, or null when there is no index or features.customEmoji is off (read now). */
  function emojiLookup(): ((name: string) => IndexedEmoji | null) | null {
    return emoji ? emoji.byName : null;
  }

  /**
   * The persona's `text` as it is posted -- a `<msg>`, or the text of her `message.create` /
   * `message.edit` call: with `handles` (the request's handle -> member id map,
   * features.mentionHandles on) only an exact `@handle` becomes a mention and no name is ever
   * matched (src/behavior/handles.ts#resolveHandles; a handle-shaped token the map does not hold
   * stays text and is logged `turn: unknown handle` with `count`, unless `quiet`); without them
   * `@name` resolved over `lines`, then `knownNames`, then the fallback
   * `directory` (a thunk, only called when the text has an `@`; resolveMentions), custom
   * emoji after the mentions (`<@id>` has no `:name:` in it to break), transcript numbers into jump
   * links (withMessageLinks), channel names into channel links (withChannelLinks), then `link`
   * joined (withLink). Resolves
   * `text` (as sent), `spoken` (before any link: what the typing time is taken from) and
   * `accountIds` (the members it mentions: the only ones a send may notify, allowedMentions).
   */
  function renderPost(
    written: string,
    {
      channel,
      snapshot = null,
      dmChat,
      idByIndex,
      pulledIds,
      lines,
      knownNames,
      directory = null,
      handles = null,
      channelHandles = null,
      link = null,
      quiet = false,
      refs = null,
    }: RenderArgs
  ): RenderedPost {
    const referred = withRefs(written, refs);
    written = referred.text;
    let mentioned: { text: string; accountIds: Array<string | undefined>; unknown?: number };
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
        withMessageLinks(spoken, {
          root: channel.rootId ?? null,
          chat: channel.id,
          dmChat,
          idByIndex,
          pulledIds,
        }),
        channelHandles,
        snapshot
      ),
      link,
      hot.prompts?.labels
    );
    return { text, spoken, accountIds: mentioned.accountIds, replyTo: referred.replyTo };
  }

  /**
   * Wait until `trigger`'s author has been quiet in `placeId` for pace.settleMs (read at every
   * check), never past pace.settleMaxMs from the trigger message's time (the start of the wait
   * when that is unknown), checking the activity again at least every SETTLE_STEP_MS so a new
   * message of theirs restarts the count; the pauses run on the injected `schedule`. Resolves
   * the milliseconds actually waited: 0 with no activity tracker, no trigger author or settle
   * off. Never rejects: a failing check ends the wait.
   */
  async function settleAuthor(
    placeId: string,
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
          lastAt: activity.lastAt(placeId, authorId),
          settleMs,
          settleMaxMs,
        });
        if (!(wait > 0)) break;
        await new Promise<void>((resolve) => {
          schedule(resolve, Math.min(wait, SETTLE_STEP_MS));
        });
      }
    } catch (err) {
      log.warn('turn: settle failed', { channel: placeId, error: err });
    }
    return clock() - settleStartedAt;
  }

  /**
   * The bare name of her selfreflection's place for `<senses>`: a selfreflection turn's own chat (`own`), else the first of
   * mirror.ts#selfreflectionPlaces, as the snapshot, the directory or memory names it; null with none or `features.selfreflection` off.
   */
  function selfreflectionChannelName(
    placeId: string,
    config: SendsConfig,
    snapshot: Snapshot | null = null,
    own: { id: string; name?: string | null } | null = null
  ): string | null {
    const found = own ? { chatId: String(own.id), name: own.name } : readMirrors(store, selfreflectionPlaces, [])[0];
    const place = found ?? null;
    if (!place) return null;
    const name = snapshot?.get(place.chatId)?.name ?? chatName(place.chatId) ?? place.name;
    return typeof name === 'string' && name ? name : null;
  }

  return { emojiLookup, renderPost, settleAuthor, selfreflectionChannelName };
}
