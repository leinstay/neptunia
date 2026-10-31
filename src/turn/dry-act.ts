// The dry run's stand-in for the act: every reaction, message, GIF and diary picture the turn would make is logged,
// journaled as a rehearsed operation and mirrored to `bot.dryRunChannelId`, and nothing reaches the conversation.
// createTurnRunner (src/behavior/turn.js) builds it once per runner with createDryAct; the attempt calls dryAct in
// place of act while features.dryRun is on.

import { mirrorChannelLabel } from '../behavior/limits.js';
import { renderCustomEmoji } from '../behavior/emoji.js';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.js';
import type { ConversationInfo } from '../protocol/adapter.ts';
import type { DrawGif } from './draw-gif.ts';
import type { JournalNotes } from './journal-notes.ts';
import { snapshotOfDraft } from './routing.ts';
import type { Sends } from './sends.ts';
import { authorNameFor, mirrorPartChars, reactionChannel, replyTarget, splitForMirror, withLink } from './targets.ts';
import type { TriggerKind } from './triggers.ts';

/** The labels a jump link is joined with (prompts.labels). */
type DryLabels = Parameters<typeof withLink>[2];

/** What createDryAct reads: the dependencies and the functions of the other topic modules it calls. */
export type DryActContext = {
  hot: { readonly prompts: { labels?: DryLabels } | null | undefined };
  ifaceReads: Reads;
  iface: unknown;
  clock: () => number;
  lastPostAt: Map<string, number>;
  journalOp: JournalNotes['journalOp'];
  renderPost: Sends['renderPost'];
  emojiLookup: Sends['emojiLookup'];
  mirror: Sends['mirror'];
  pickGifSafely: DrawGif['pickGifSafely'];
  drawPromptFor: DrawGif['drawPromptFor'];
};

/** The parsed answer of the model, as the dry act reads it. */
type DryParsed = {
  reactions: ReadonlyArray<{ to: number; emoji: string }>;
  messages: ReadonlyArray<{ text: string; replyTo?: number | null }>;
  /** The turn's own `<gif>`, which the attempt resolved against the library (resolveGif) before the act. */
  gif: DryGif | null | undefined;
};

/** A GIF the dry act would post: resolved against the library, with its stored URL. */
type DryGif = { replyTo?: number | null; entry: { id: string; kind?: string; url: string } };

type RenderArgs = Parameters<Sends['renderPost']>[1];

export type DryActArgs = {
  channel: ConversationInfo;
  guildId: string;
  parsed: DryParsed;
  idByIndex: ReadonlyMap<number, string>;
  history?: Parameters<DrawGif['pickGifSafely']>[0]['history'];
  mode: string;
  triggerKind: TriggerKind | null;
  trigger?: Parameters<DrawGif['pickGifSafely']>[0]['trigger'];
  plain: boolean;
  selfName: string;
  pulledIds: ReadonlyMap<string, string>;
  lines: NonNullable<RenderArgs['lines']> & ReadonlyArray<{ id?: string; authorName?: string | null }>;
  knownNames: RenderArgs['knownNames'];
  directory?: RenderArgs['directory'];
  handles?: RenderArgs['handles'];
  channelHandles?: RenderArgs['channelHandles'];
  linkFor: (pulledId: string | null) => string | null;
  part?: { index: number; total: number } | null;
  gifPick?: boolean;
  diaryDraws?: ReadonlyArray<{ text: string; self?: unknown }> | null;
  diarySet?: boolean;
  draft?: (Parameters<JournalNotes['journalOp']>[0] & { snapshot?: Snapshot | null }) | null;
};

export type DryAct = { dryAct: (args: DryActArgs) => Promise<void> };

export function createDryAct(ctx: DryActContext): DryAct {
  const {
    hot,
    ifaceReads,
    iface,
    clock,
    lastPostAt,
    journalOp,
    renderPost,
    emojiLookup,
    mirror,
    pickGifSafely,
    drawPromptFor,
  } = ctx;

  /**
   * Dry-run stand-in for `act()`: does everything `act()` would have decided
   * to do, but never touches the target channel -- no sendTyping, no send, no
   * react, no artificial timing. Logs one line per would-be action and, when
   * `bot.dryRunChannelId` is configured, mirrors it there in plain language.
   * The same routing as act(): a reaction on a pulled line names its channel
   * (`source`) or is dropped where the bot may not react there, a message, the
   * GIF or the picture answering a pulled line carries its jump link
   * (`linkFor`) and no reply. Like act(), a reaction stamps no `lastPostAt`.
   * The mirror header names the mode, the trigger kind (none on a spontaneous
   * turn), then `react to <name>` for a reaction and `to <name>` for a message
   * that answers a line (a reply or a linked pulled line); nothing more for
   * one that answers none. A turn answering one part of a split message
   * names its part (`part <index>/<total>`) after the trigger kind. The
   * messages are the model's as written (nothing rewrites them); nothing is
   * counted or stamped: nothing was posted. The GIF picker runs as in act()
   * (pickGif, its request included): a GIF it picks is logged and mirrored
   * first, as the GIF that would be posted in place of the first message, then
   * the other messages. `history`: the chat lines the picker's `<context>`
   * reads; `trigger`: the message the turn answers (the picker's answered line).
   * `diaryDraws`: a diary post's `draw.create` calls (`{ text, self }`), each logged
   * `dry-run: would draw` and mirrored; with `diarySet` (a set kind) logged with `set: true` and its place in the set.
   * `plain`: the turn quotes no chat line (postsPlain); `lines`: the lines shown of the pulled
   * channels, then this chat's history (names and authors); `knownNames`: the stored names
   * `@name` resolves by too (storedNames); `directory`: the fallback behind them (mentionDirectory);
   * `handles`: the request's handle -> member id map, in place of all three (renderPost).
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function dryAct({
    channel,
    guildId,
    parsed,
    idByIndex,
    history = [],
    mode,
    triggerKind,
    trigger = null,
    plain,
    selfName,
    pulledIds,
    lines,
    knownNames,
    directory = null,
    handles = null,
    channelHandles = null,
    linkFor,
    part = null,
    gifPick = true,
    diaryDraws = null,
    diarySet = false,
    draft = null,
  }: DryActArgs): Promise<void> {
    const channelName = channel.name ?? null;
    const where = mirrorChannelLabel(channel);
    // Every triggered turn shares the mode `reply`: the header names its
    // trigger kind (a call, a follow-up, an overheard line...); a spontaneous
    // turn has none.
    const partMark = part ? ` · part ${part.index}/${part.total}` : '';
    const head = `[dry-run] ${where} · ${mode}${triggerKind ? ` · ${triggerKind}` : ''}${partMark}`;
    const labels = hot.prompts?.labels;
    // The journal: every would-be action as an operation that started and succeeded, marked dryRun.
    const rehearse = async (name: string, fields: Record<string, unknown> = {}, result: object = {}): Promise<void> => {
      const op = journalOp(draft, name, 'persona', { ...fields, dryRun: true });
      if (!op.opId) return;
      await op.started();
      await op.succeeded(result);
    };

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const route = await reactionChannel(ifaceReads, channel, targetId, pulledIds);
      if (!route.target) {
        log.info('turn: reaction dropped', { channel: channel.id, source: route.source, reason: route.reason });
        continue;
      }
      await rehearse(
        'react',
        { input: { to: targetId, emoji: reaction.emoji }, sourceMessageIds: [targetId] },
        { to: targetId, emoji: reaction.emoji }
      );
      const authorName = authorNameFor(lines, targetId) ?? '—';
      // The ONE deliberate exception to "never log message contents": this is
      // the persona's own output, not a user's, and only while dry-run is on.
      log.info('dry-run: would react', {
        channel: channel.id,
        channelName,
        source: route.source,
        to: targetId,
        emoji: reaction.emoji,
      });
      const elsewhere = route.source ? ` in ${mirrorChannelLabel(route.target)}` : '';
      await mirror(`${head} · react to ${authorName}`, `reacts with ${reaction.emoji} to ${authorName}${elsewhere}`);
    }

    const dryGif = async (gif: DryGif): Promise<void> => {
      const { replyId, pulledId } = replyTarget(gif.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const { entry } = gif;
      // The persona's own pick from the library, dry-run only: the handle and the stored URL.
      await rehearse('gif', { input: { gif: entry.id }, sourceMessageIds: replyId ? [replyId] : [] });
      log.info('dry-run: would send gif', {
        channel: channel.id,
        channelName,
        mode,
        replyTo: replyId,
        link,
        gif: entry.id,
        kind: entry.kind,
        url: entry.url,
      });
      await mirror(`${head} · gif ${entry.id}`, withLink(entry.url, link, labels));
      lastPostAt.set(channel.id, clock());
    };

    const picked = gifPick
      ? await pickGifSafely({
          channelId: channel.id,
          guildId,
          messages: parsed.messages,
          gif: parsed.gif,
          history,
          selfName,
          idByIndex,
          trigger,
        })
      : null;
    // A picked GIF would be posted in place of the first message; the rest follow as written.
    if (picked) await dryGif(picked);
    const messages = picked ? parsed.messages.slice(1) : parsed.messages;
    const gif = picked ? null : parsed.gif;
    for (const message of messages) {
      const { replyId, pulledId } = replyTarget(message.replyTo, { plain, idByIndex, pulledIds });
      const answeredId = replyId ?? pulledId;
      const to = answeredId ? ` · to ${authorNameFor(lines, answeredId) ?? '—'}` : '';
      const link = linkFor(pulledId);
      // Same deliberate exception as above: the persona's own output, dry-run only.
      const { text } = renderPost(message.text, {
        channel,
        snapshot: snapshotOfDraft(draft),
        guildId,
        privateChat: false,
        idByIndex,
        pulledIds,
        lines,
        knownNames,
        directory,
        handles,
        channelHandles,
        link,
      });
      await rehearse('post', { intent: { replyTo: replyId, text }, sourceMessageIds: replyId ? [replyId] : [] });
      log.info('dry-run: would send', {
        channel: channel.id,
        channelName,
        mode,
        trigger: triggerKind ?? null,
        replyTo: replyId,
        link,
        text,
      });
      // The mirror shows @name as the model wrote it: resolving it to a real
      // mention here would ping someone in a channel meant to be invisible to them.
      await mirror(`${head}${to}`, withLink(renderCustomEmoji(message.text, emojiLookup()), link, labels));
      lastPostAt.set(channel.id, clock());
    }

    if (gif) await dryGif(gif);

    // A diary post (`diaryDraws`): every picture it would generate, in order. Her calls elsewhere are logged by the caller.
    const dryDraws = diaryDraws ?? [];
    for (const [index, drawn] of dryDraws.entries()) {
      const self = drawn.self === true;
      // The FULL image prompt (prompt files + the persona's request), so the
      // owner can check the prompt files in dry-run. Same deliberate exception:
      // the persona's own output, dry-run only. Nothing is generated.
      const prompt = drawPromptFor(selfName, drawn);
      await rehearse('draw', { input: { self, ...(diarySet ? { set: true } : {}) } });
      log.info('dry-run: would draw', {
        channel: channel.id,
        channelName,
        mode,
        self,
        prompt,
        ...(diarySet ? { set: true } : {}),
      });
      // A full prompt outgrows one message of the interface: mirrored in numbered parts.
      const setMark = diarySet ? ` · set ${index + 1}/${dryDraws.length}` : '';
      const header = `${head} · draw${self ? ' (self)' : ''}${setMark}`;
      const parts = splitForMirror(prompt, mirrorPartChars(iface, header.length));
      for (const [i, part] of parts.entries()) {
        await mirror(parts.length > 1 ? `${header} (${i + 1}/${parts.length})` : header, part);
      }
      lastPostAt.set(channel.id, clock());
    }
  }

  return { dryAct };
}
