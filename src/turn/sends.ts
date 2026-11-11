// How the persona's words are rendered and timed before they go out: a post's mentions, custom emoji, jump links and
// channel links in the forms the place's interface declares (plain names and the owner's line numbers where it declares
// none), the wait for the trigger's author to fall quiet and the name of her selfreflection's place for `<senses>`.
// createTurnRunner (src/behavior/turn.ts) builds it once per runner with createSends; the act, her calls and the
// attempt call its functions.

import type { Chat } from '../protocol/events.ts';
import { settleWait } from '../behavior/activity.ts';
import { messageLinkOf } from '../behavior/elsewhere.ts';
import {
  portAt,
  portChannelLinks,
  portCustomEmoji,
  portIface,
  portMentions,
  portMessageUrl,
} from '../interface/capabilities.ts';
import type { IndexedEmoji } from '../behavior/emoji-index.ts';
import { renderCustomEmoji } from '../behavior/emoji.ts';
import { CHANNEL_HANDLE_PREFIX, HANDLE_PREFIX, idText, resolveHandles, widenHandles } from '../behavior/handles.ts';
import { selfreflectionPlaces, readMirrors } from '../behavior/mirror.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { log } from '../log.ts';
import { accountOf, personOfMember, placeRefOf } from '../memory/addresses.ts';
import { linkChannels, linkMessageNumbers, outsideUrls } from '../memory/mentions.ts';
import { resolveMentions } from './mentions.ts';
import { inRoot } from './routing.ts';
import { SETTLE_STEP_MS, paceSettings } from './settings.ts';
import { withLink } from './targets.ts';
import { outgoingRefs } from './request/refs.ts';
import type { LineOf } from './request/refs.ts';
import type { HandleTarget } from './request/types.ts';

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

/** The channel a post is rendered for, as the interface described it: its id, its root for a link, its interface. */
type PostChannel = Pick<Chat, 'id' | 'rootId'> & { iface?: string };

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
  /** Where each handle of the request may mention its person (src/behavior/handles.ts#handleBook); absent: `handles` alone. */
  targets?: ReadonlyMap<string, HandleTarget> | null;
  /** The interface of the place the post goes to, when it is not the turn's own (a `message.create` elsewhere). */
  destination?: string | null;
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
  emojiLookup: (at?: { iface?: unknown } | null) => ((name: string) => IndexedEmoji | null) | null;
  renderPost: (written: string, args: RenderArgs) => RenderedPost;
  settleAuthor: (
    placeId: string,
    trigger: { authorId?: string | null; ts?: unknown } | null | undefined
  ) => Promise<number>;
  settles: (trigger: { authorId?: string | null } | null | undefined) => boolean;
  selfreflectionChannelName: (
    placeId: string,
    config: SendsConfig,
    snapshot?: Snapshot | null,
    own?: { id: string; name?: string | null } | null
  ) => string | null;
};

/** The token a member's mention or a channel's link takes once rendered (src/behavior/handles.ts#resolveHandles). */
const MENTION_TOKEN_RE = /<@!?([^>\s]+)>/g;
const CHANNEL_TOKEN_RE = /<#([^>\s]+)>/g;

// `@` + a person's handle, whole (src/behavior/handles.ts): no word character right before the `@` or after the token.
const PERSON_HANDLE_RE = new RegExp(`(?<![\\p{L}\\p{N}_])@(${HANDLE_PREFIX}[0-9a-z]+)(?![\\p{L}\\p{N}_])`, 'gu');

/**
 * The request's handles on the interface a post goes to: each handle whose person has an account there to that
 * account's platform id, and the handles of people with no account there to the name of their entry, which the post
 * carries in place of the handle. Without targets, the request's own map as it is.
 */
function handlesOn(
  handles: ReadonlyMap<string, string>,
  targets: ReadonlyMap<string, HandleTarget> | null,
  iface: string
): { ids: Map<string, string>; names: Map<string, string> } {
  const ids = new Map(handles);
  const names = new Map<string, string>();
  for (const [handle, target] of targets ?? []) {
    const there = target.accounts.find((account) => account.iface === iface);
    if (there) ids.set(handle, there.native);
    else {
      ids.delete(handle);
      if (target.name) names.set(handle, target.name);
    }
  }
  return { ids, names };
}

/** `text` with each whole `@handle` of `names` written as that name, outside URLs. */
function namedHandles(text: string, names: ReadonlyMap<string, string>): string {
  if (names.size === 0) return text;
  return outsideUrls(text, (part) =>
    part.replace(PERSON_HANDLE_RE, (token, handle: string) => names.get(handle) ?? token)
  );
}

/** The handle of `id` in a request's handle map, as she wrote it with `sigil`, or null when the map holds none. */
function writtenHandle(handles: unknown, id: string, sigil: string): string | null {
  if (!(handles instanceof Map)) return null;
  for (const [handle, mapped] of handles as Map<string, unknown>) if (String(mapped) === id) return `${sigil}${handle}`;
  return null;
}

/** `text` with each mention token read as the member's name, else the handle she wrote, else as it stands. */
function namedMembers(text: string, handles: unknown, nameOf: (id: string) => string | null): string {
  return text.replace(MENTION_TOKEN_RE, (token, id: string) => nameOf(id) ?? writtenHandle(handles, id, '@') ?? token);
}

/** `text` with each channel link token read as the channel's name, else the handle she wrote, else as it stands. */
function namedChannels(text: string, handles: unknown, nameOf: (id: string) => string | null): string {
  return text.replace(CHANNEL_TOKEN_RE, (token, id: string) => nameOf(id) ?? writtenHandle(handles, id, '#') ?? token);
}

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
      // The chat reference whose interface addresses the links.
      at: { iface: string };
      // The stored place the post goes to, whose lines the owner's chat numbers.
      placeId: string | null;
    }
  ): string {
    const { chat, dmChat, idByIndex, pulledIds } = slots;
    if (!idByIndex) return text;
    const root = dmChat || !slots.root ? null : slots.root;
    const placePort = portAt(iface, slots.at);
    const numberOf = portMessageUrl(placePort) === null ? ownerNumberOf(slots.placeId) : null;
    return linkMessageNumbers(text, (n) => {
      const messageId = idByIndex.get(n);
      if (!messageId) return null;
      if (numberOf) return pulledIds?.has(messageId) ? null : numberOf(messageId);
      return messageLinkOf(placePort, root, pulledIds?.get(messageId) ?? chat, messageId);
    });
  }

  /**
   * On a place whose interface gives a message no address: the `#N` the owner's chat draws on a stored line of the place
   * (`store.lineNumberOf`), null for a line it does not hold or a store that numbers none.
   */
  function ownerNumberOf(placeId: string | null): ((messageId: string) => string | null) | null {
    const known = store as { lineNumberOf?(place: string, messageId: string): number | null } | null;
    if (placeId === null || typeof known?.lineNumberOf !== 'function') return null;
    return (messageId) => {
      const number = known.lineNumberOf?.(placeId, messageId) ?? null;
      return number === null ? null : `#${number}`;
    };
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
    // A channel handle this request did not show: the handle of one of the root's text channels, from any request.
    const widened = handles
      ? widenHandles(
          handles,
          channels.map((entry) => String(entry.id)),
          CHANNEL_HANDLE_PREFIX
        )
      : null;
    return linkChannels(text, channels, widened);
  }

  /**
   * `written` with each line identity in the interface's form (src/turn/request/refs.ts#outgoingRefs): a line of this
   * place becomes the reply target, a line of another place on this interface its jump link, and anything else, the
   * command line included, the quote with its path and time.
   */
  function withRefs(written: string, refs: PostRefs | null | undefined): { text: string; replyTo: string | null } {
    if (!refs || typeof written !== 'string') return { text: written, replyTo: null };
    const here = placeRefOf(store, refs.placeId)?.iface ?? null;
    const labels = (hot.prompts?.labels ?? {}) as Parameters<typeof outgoingRefs>[1]['labels'];
    return outgoingRefs(written, {
      placeId: refs.placeId,
      lineOf: refs.lineOf,
      linkOf: (line) => {
        const there = line.dm ? null : placeRefOf(store, line.placeId);
        const chat = there === null || there.kind === 'dm' ? null : there.nativeId;
        if (here === null || chat === null || there?.iface !== here) return null;
        return messageLinkOf(portAt(iface, { iface: here }), rootOfPlace(line.placeId), chat, line.messageId);
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

  /**
   * `shown` (handle -> platform id) with, behind it, the handle every member of `natives` (platform ids of the served
   * interface) has in any request: cut from the person behind the account, else the account (widenHandles), each to
   * its platform id.
   */
  function widenedMembers(shown: ReadonlyMap<string, string>, natives: ReadonlyArray<string>): Map<string, string> {
    const nativeOf = new Map<string, string>();
    for (const native of natives) {
      const key = personOfMember(store, native) ?? accountOf(store, native);
      if (!nativeOf.has(key)) nativeOf.set(key, native);
    }
    const widened = new Map(shown);
    for (const [handle, key] of widenHandles(null, nativeOf.keys()))
      if (!widened.has(handle)) widened.set(handle, nativeOf.get(key) ?? key);
    return widened;
  }

  /**
   * The custom emoji lookup, or null when there is no index, features.customEmoji is off (read now) or the interface of
   * `at` (a chat reference, the served interface when none) declares no custom emoji.
   */
  function emojiLookup(at: { iface?: unknown } | null = null): ((name: string) => IndexedEmoji | null) | null {
    return emoji && portCustomEmoji(portAt(iface, at)) ? emoji.byName : null;
  }

  /** The chat reference of `channel` for the port: the interface it names, else the served one. */
  function refOf(channel: PostChannel): { iface: string } {
    return { iface: portIface(channel) || portIface(iface) };
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
      placeId,
      dmChat,
      idByIndex,
      pulledIds,
      lines,
      knownNames,
      directory = null,
      handles = null,
      targets = null,
      destination = null,
      channelHandles = null,
      link = null,
      quiet = false,
      refs = null,
    }: RenderArgs
  ): RenderedPost {
    const referred = withRefs(written, refs);
    written = referred.text;
    // Mentions take the form of the interface the post goes to; everything else that of the turn's place.
    const there = destination ?? refOf(channel).iface;
    let mentioned: { text: string; accountIds: Array<string | undefined>; unknown?: number };
    if (handles instanceof Map) {
      // A handle names a person: their account on the interface the post goes to, else the name of their entry.
      const on = handlesOn(handles, targets, there);
      written = namedHandles(written, on.names);
      let resolved = resolveHandles(written, on.ids);
      // A handle this request did not show: the handle of a member the core knows (mentionDirectory), from any request.
      if (resolved.unknown > 0 && typeof directory === 'function')
        resolved = resolveHandles(
          written,
          widenedMembers(
            on.ids,
            [...(directory() ?? [])].flatMap((entry) => idText(entry?.id))
          )
        );
      mentioned = resolved;
      if (resolved.unknown > 0 && !quiet)
        log.info('turn: unknown handle', { channel: channel.id, count: resolved.unknown });
    } else {
      const fallback = typeof directory === 'function' && String(written ?? '').includes('@') ? directory() : [];
      mentioned = resolveMentions(written, lines ?? [], knownNames ?? [], fallback);
    }
    const placePort = portAt(iface, refOf(channel));
    if (!portMentions(portAt(iface, { iface: there })))
      mentioned = { text: namedMembers(mentioned.text, handles, nameOfMember), accountIds: [] };
    const spoken = renderCustomEmoji(mentioned.text, emojiLookup(refOf(channel)));
    const linked = withChannelLinks(
      channel,
      withMessageLinks(spoken, {
        root: channel.rootId ?? null,
        chat: channel.id,
        dmChat,
        idByIndex,
        pulledIds,
        at: refOf(channel),
        placeId: placeId ?? null,
      }),
      channelHandles,
      snapshot
    );
    const shown = portChannelLinks(placePort) ? linked : namedChannels(linked, channelHandles, channelNameOf);
    const text = withLink(shown, link, hot.prompts?.labels);
    return { text, spoken, accountIds: mentioned.accountIds, replyTo: referred.replyTo };

    /** A member's name from the request: a line's author, a profile shown, then the directory. */
    function nameOfMember(id: string): string | null {
      const authored = [...(lines ?? [])].find((line) => idText(line.authorId)[0] === id)?.authorName;
      if (typeof authored === 'string' && authored) return authored;
      const named = [...(knownNames ?? []), ...(directory?.() ?? [])].find((one) => idText(one?.id)[0] === id);
      return typeof named?.name === 'string' && named.name ? named.name : null;
    }

    /** A channel's name: the turn's snapshot, then the name the interface gave the chat. */
    function channelNameOf(id: string): string | null {
      const listed = snapshot?.chats.find((chat) => String(chat.id) === id)?.name;
      return typeof listed === 'string' && listed ? listed : (chatName(id) ?? null);
    }
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

  /** Whether a turn answering `trigger` waits for its author (settleAuthor): a tracker, an author, pace.settleMs on. */
  function settles(trigger: { authorId?: string | null } | null | undefined): boolean {
    return Boolean(activity && trigger?.authorId) && paceSettings(hot.config).settleMs > 0;
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

  return { emojiLookup, renderPost, settleAuthor, settles, selfreflectionChannelName };
}
