// The pictures and GIFs of a turn: the image prompt the dry run shows, one picture and her `draw.create` tool, the day's
// GIF count, a `<gif>` resolved against the library, the GIF's post, and the GIF picker that may answer her first
// message with a GIF. createTurnRunner (src/behavior/turn.js) builds it once per runner with createDrawGif; the act,
// the dry act, her calls and the attempt call its functions.

import { imageFileName } from '../behavior/mirror.ts';
import { setSettings } from '../behavior/diary.ts';
import {
  block,
  classifierTranscript,
  fillPromptTemplate,
  freezePerBucket,
  gifFieldChars,
  ownGifLines,
  stableThenTail,
} from '../behavior/prompt.js';
import {
  captionedEntries,
  gifPickSettings,
  parseGifPick,
  pickCandidates,
  pickContext,
  renderGifLibrary,
} from '../behavior/gif-pick.js';
import type { PictureGate } from '../behavior/diary-turn.ts';
import { DIARY_PICTURES_DAILY } from '../behavior/diary.ts';
import { limitOf } from '../behavior/limits.js';
import { replyMarker } from '../format.js';
import type { Reads } from '../interface/reads.ts';
import { ImageCapError, ImageGenError, UnsupportedImageModelError } from '../llm/images.js';
import { cacheTtlMs, railReason, roleRequestOptions } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { drawPicture, drawPromptOf } from '../media/draw.js';
import { freshAttachmentUrl as sharedFreshAttachmentUrl, gifPostUrl, countGifPost } from '../media/gif-post.js';
import { gifPostsToday, rankGifs } from '../memory/index.js';
import type { ConversationInfo, ConversationRef, MessageRef } from '../protocol/adapter.ts';
import { bumpDaily, utcDay } from '../time.js';
import { CODE } from '../tools/codes.ts';
import { refusalStatus } from '../tools/executors.ts';
import { messageRefOf, postingConversation } from '../tools/impl/shared.ts';
import { NO_OP, closeResult, portError, postedOf } from './journal.ts';
import type { JournalOp, PortResult } from './journal.ts';
import { sendArgs, withLink } from './targets.ts';
import { askedFor } from './triggers.ts';
import type { TriggerKind } from './triggers.ts';

/** The live config, as far as the pictures and GIFs read it; the settings functions read their own sections. */
export type DrawGifConfig = {
  features?: { imageGeneration?: unknown; gifs?: unknown; gifPicker?: unknown; promptCache?: unknown } | null;
  diary?: unknown;
  gifs?: { halfLifeDays?: number; ownMarkHours?: number } | null;
  context?: { replyQuoteChars?: number } | null;
};

/** The labels the GIF picker reads (prompts.labels). */
type GifLabels = {
  gifs?: unknown;
  transcript?: { replyTo?: unknown } | null;
  elsewhere?: { link?: unknown } | null;
} & object;

/** The prompt files the pictures and GIFs read (hot.prompts). */
type DrawGifPrompts = { labels?: GifLabels; 'gif-pick'?: unknown } & object;

/** The library entry of a GIF (src/memory/gifs.js), as its post reads it. */
type GifEntry = {
  id: string;
  url: string;
  kind?: string;
  key?: string;
  messageId?: string;
  channelId?: string;
  itemId?: string;
};

/** A `<gif>` of hers: its handle and the `#n` it replies to. */
type GifCall = { id: string; replyTo?: number | null };

/** A `<gif>` resolved against the library. */
export type ResolvedGif = GifCall & { entry: GifEntry };

/** The memory store, as the pictures and GIFs read and write it. */
export type DrawGifStore = {
  state: { data: object; markDirty: () => void };
  findGif: (guildId: string, handle: string) => GifEntry | null | undefined;
  getGifs?: (guildId: string) => unknown;
  getMediaCache?: (guildId: string) => object | null | undefined;
  recordOwnGif?: (guildId: string, key: string, at: number) => void;
};

/** The language model client (src/llm/openrouter.js#createLlm), as the GIF picker uses it. */
type DrawGifLlm = {
  complete: (messages: Array<{ role: string; content: unknown }>, options: object) => Promise<unknown>;
};

/** The image client (src/llm/images.js#createImageGen). */
type DrawGifImages = NonNullable<Parameters<typeof drawPicture>[0]>['images'];

/** A picture as the image client made it (src/llm/images.js#createImageGen's generate). */
type Picture = { buffer?: Buffer; mediaType: string; cost: number | null; seconds: number };

/** The interface port (src/interface/port.js), as the pictures and GIFs post through it. */
type DrawGifPort = { send: (ref: ConversationRef, payload: object) => Promise<PortResult> };

/** The gateway's verdict on one effect of her reply. */
type EffectVerdict = { ok: boolean; code?: string; reason?: string };

/** A channel the pictures and GIFs post in: the turn's, or one named by its id. */
type PostChannel = { id: string } & Partial<ConversationInfo>;

/** What a `draw.create` call answers her. */
type DrawResult = {
  status: string;
  code?: string;
  reason?: string;
  ref?: unknown;
  at?: number;
  error?: unknown;
  data: { text: string };
};

/** A diary post's staged picture. */
type Staged = { picture: Picture; self: boolean; text: string };

/** What an attempt's draft holds that a picture reads and writes. */
type DrawDraft = {
  staged?: Array<Staged>;
  diary?: { set?: unknown } | null;
  avatar?: { reference?: string | null };
  limits?: { add: (limit: { kind: string; where: string }) => void } | null;
};

/** What createDrawGif reads: the dependencies and the runner functions and state the pictures and GIFs use. */
export type DrawGifContext = {
  hot: { readonly config: DrawGifConfig; readonly prompts: DrawGifPrompts };
  store: DrawGifStore;
  llm: DrawGifLlm;
  images: DrawGifImages | null | undefined;
  imageFetcher: NonNullable<Parameters<typeof drawPicture>[0]>['imageFetcher'];
  ifaceReads: Reads;
  iface: DrawGifPort;
  routes: { report: <TValue>(role: string, model: string | null, made: Promise<TValue>) => Promise<TValue> };
  selfIdOf: () => string;
  clock: () => number;
  schedule: (run: () => void, ms: number) => () => void;
  /** The guild's stable freeze (src/behavior/prompt.js#freezePerBucket); each key holds one kind of value. */
  stableFreezeOf: <TValue>(guildId: string) => Map<string, { bucket: number; signature: string; value: TValue }>;
  conversationOf: (channel: PostChannel) => ConversationRef;
  messageOf: (channel: PostChannel, messageId: string) => MessageRef;
  checkEffect: (skill: string, args: unknown, at: { channel: PostChannel; trigger?: unknown }) => EffectVerdict;
  lastPostAt: Map<string, number>;
  diaryPictureGate: (config: DrawGifConfig, channel: ConversationInfo, now: number) => PictureGate;
};

/** The trigger of a turn, as a picture or a GIF reads it. */
type DrawTrigger = { id?: string; authorId?: string | null } | null;

type PickArgs = {
  channelId: string;
  guildId: string;
  messages: ReadonlyArray<{ text: string; replyTo?: number | null }>;
  gif: unknown;
  history: Array<{ id?: string } & object>;
  selfName: string;
  idByIndex?: Map<number, string>;
  trigger?: DrawTrigger;
};

export type DrawGif = {
  drawPromptFor: (selfName: string, draw: { text: string; self?: unknown }) => string;
  drawTool: (
    args: { self?: unknown; text?: unknown; channelId?: unknown; replyTo?: unknown } | null | undefined,
    at: {
      channel: ConversationInfo;
      guildId?: string | null;
      trigger?: DrawTrigger;
      triggerKind?: TriggerKind | null;
      selfName: string;
      draft?: DrawDraft | null;
      mode?: string | null;
      plain?: boolean;
    },
    model?: string | null
  ) => Promise<DrawResult>;
  resolveGif: (
    guildId: string,
    gif: GifCall | null | undefined,
    channelId: string,
    limits?: DrawDraft['limits']
  ) => ResolvedGif | null;
  postGif: (
    channel: PostChannel,
    guildId: string,
    gif: ResolvedGif,
    replyId: string | null,
    link: string | null,
    options?: { openOp?: () => JournalOp | Readonly<JournalOp>; trigger?: DrawTrigger }
  ) => Promise<{ message: ReturnType<typeof postedOf>; op: JournalOp | Readonly<JournalOp> } | null>;
  pickedInTime: (
    picking: Promise<ResolvedGif | null>,
    at: { channelId: string; draft?: DrawDraft | null }
  ) => Promise<ResolvedGif | null>;
  pickGifSafely: (args: PickArgs) => Promise<ResolvedGif | null>;
};

/** The completion's text, when the client answered with one. */
function textOf(completion: unknown): unknown {
  // The client answers a record whose `text` is the model's words.
  return (completion as { text?: unknown } | null | undefined)?.text;
}

// health: allow function-length until 2027-04-01 -- the pictures and GIFs share the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createDrawGif(ctx: DrawGifContext): DrawGif {
  const {
    hot,
    store,
    llm,
    images,
    imageFetcher,
    ifaceReads,
    iface,
    routes,
    selfIdOf,
    clock,
    schedule,
    stableFreezeOf,
    conversationOf,
    messageOf,
    checkEffect,
    lastPostAt,
    diaryPictureGate,
  } = ctx;

  /**
   * The image prompt for `draw` (a `draw.create` call's `{ text, self }`), as the core builds it
   * (src/media/draw.js#drawPromptOf): prompts read now, the request clamped to
   * image.maxPromptChars, the local date and time now (`bot.timezone`, read now) as its
   * `{{when}}` -- every picture, so its light and season follow the clock. Only the dry run
   * shows it; a live picture is made by `makePicture`.
   */
  function drawPromptFor(selfName: string, draw: { text: string; self?: unknown }): string {
    return drawPromptOf({ hot, selfName, scene: draw.text, self: draw.self === true, withTime: true, now: clock });
  }

  /**
   * One picture (src/media/draw.js#drawPicture): her scene verbatim into the drawing prompt, the avatar reference for a
   * picture she is in, one generation. `userId` is the member whose rail counts it (null: nobody's); `avatar` the
   * holder a diary set reuses the avatar through; `model` the core model's id when the call is routed there (null: the
   * drawing role's own, whose outcome the role health is told). Throws what the image client throws (ImageCapError,
   * ImageGenError).
   */
  function makePicture({
    scene,
    self,
    selfName,
    guildId = null,
    userId = null,
    avatar = null,
    model = null,
  }: {
    scene: string;
    self: boolean;
    selfName: string;
    guildId?: string | null;
    userId?: string | null;
    avatar?: { reference?: string | null } | null;
    model?: string | null;
  }): Promise<{ picture: object; referenceMissing: boolean }> {
    const made = drawPicture({
      // drawTool asks makePicture only once it found the image client.
      images: images!,
      hot,
      // The persona's large avatar, asked of the interface only when the picture needs the reference.
      avatarUrl: async () => {
        const found = await ifaceReads.memberInfo({ communityId: guildId, memberId: selfIdOf() });
        return found?.member?.avatar.largeUrl ?? null;
      },
      imageFetcher,
      now: clock,
      input: { scene, selfName, self, withTime: true, userId, avatar, model },
    });
    return routes.report('drawing', model, made);
  }

  /**
   * `draw.create` as an in-turn tool of hers (`args`: the operation's, `{ text, self, channelId?, replyTo? }`): the
   * picture through makePicture, the scene verbatim, with the local time, then one upload through the port. It posts
   * where `message.create` would: the channel she names, else the replied message's (a link names it; a channel and a
   * reply that disagree are refused `unknown-message`), else this one, checked before anything is generated, on `model`
   * (the core model's id when its route moved it, else null) (src/tools/impl/shared.ts#postingConversation, `attach`).
   * A reply quotes the message in that channel. The picture is charged to the asking member's rail when the turn was
   * asked (askedFor), to nobody's otherwise. Every failure is a result she reads, never a limit notice: an image cap is
   * `image-cap-daily` or `image-cap-user-daily`, a generation failure `image-moderation`, `image-timeout` or
   * `image-error`, a refused publication its gateway code, and the port's answer to the upload passes through
   * (`unknown` when it may have gone out: never generated again). In a diary turn (`mode` 'diary') the picture is
   * staged into `draft.staged` as `{ picture, self, text }` instead of posted (ok, code `staged`), counted against the
   * day's diary pictures as it is generated, and refused `daily-cap` (reason: the gate that closed, diaryPictureGate)
   * while the post may carry none, `loop-cap` past what the post's kind takes (one picture, or `diary.set.pictures[1]`
   * for a set kind: `draft.diary.set`). Never throws.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function drawTool(
    args: Parameters<DrawGif['drawTool']>[0],
    {
      channel,
      guildId = null,
      trigger = null,
      triggerKind = null,
      selfName,
      draft = null,
      mode = null,
      plain = false,
    }: Parameters<DrawGif['drawTool']>[1],
    model: string | null = null
  ): Promise<DrawResult> {
    const none = { text: '' };
    const failed = (status: string, code: string | undefined, extra: object = {}): DrawResult => ({
      status,
      code,
      ...extra,
      data: none,
    });
    if (!images) return failed('not_configured', CODE.NOT_CONFIGURED);
    if (hot.config.features?.imageGeneration === false) return failed('denied', CODE.FEATURE_OFF);
    const self = args?.self === true;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's argument may be any JSON value, read as text
    const scene = String(args?.text ?? '');
    const asked = askedFor(trigger, triggerKind);
    const staging = mode === 'diary';
    if (staging) {
      // A diary post's pictures: the gate is asked at every picture (the day's count moves as they are made).
      const gate = diaryPictureGate(hot.config, channel, clock());
      if (!gate.allowed)
        return failed(refusalStatus(CODE.DAILY_CAP), CODE.DAILY_CAP, { reason: gate.limit?.key ?? 'image.maxPerDay' });
      if ((draft?.staged?.length ?? 0) >= (draft?.diary?.set ? setSettings(hot.config.diary).pictures[1] : 1))
        return failed(refusalStatus(CODE.LOOP_CAP), CODE.LOOP_CAP, { reason: 'extra-call' });
    }
    try {
      let channelId = String(channel.id);
      let replyId: string | null = null;
      if (!staging) {
        // A turn that quotes no chat line (a follow-up, an overheard line, a later part of a split message) posts its picture plain.
        const reply = args?.replyTo && !plain ? await messageRefOf(args.replyTo, ifaceReads) : null;
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's argument may be any JSON value, read as text
        const given = args?.channelId ? String(args.channelId) : null;
        if (given && reply?.channelId && given !== reply.channelId) return failed('invalid', CODE.UNKNOWN_MESSAGE);
        channelId = await postingConversation({
          reads: ifaceReads,
          iface: channel.iface,
          guildId,
          channelId: given ?? reply?.channelId ?? null,
          context: { channelId: String(channel.id) },
          need: 'attach',
        });
        replyId = reply?.messageId ?? null;
        // The current channel: where no file can be posted nothing is generated (or paid for).
        if (channelId === String(channel.id) && !channel.permissions.attach)
          return failed('failed', CODE.CHANNEL_NO_PERMISSION);
      }
      // Nothing is paid for a picture its publication may not have.
      const before = checkEffect('message.create', sendArgs({ media: imageFileName(null), replyId }), {
        channel,
        trigger,
      });
      // A refusal carries its gateway code.
      if (!before.ok) return failed(refusalStatus(before.code!), before.code, { reason: before.reason });
      let made;
      try {
        made = await makePicture({
          scene,
          self,
          selfName,
          guildId,
          // askedFor is true only for a turn with a trigger.
          userId: asked ? (trigger!.authorId ?? null) : null,
          model,
          ...(staging && draft ? { avatar: (draft.avatar ??= {}) } : {}),
        });
      } catch (err) {
        if (err instanceof ImageCapError) {
          const limit = limitOf(err);
          log.info('turn: draw refused by a limit', {
            channel: channel.id,
            key: limit?.key ?? null,
            used: limit?.used ?? null,
            cap: limit?.cap ?? null,
            spontaneous: !trigger,
            asked,
          });
          return failed('failed', err.reason === 'userDaily' ? CODE.IMAGE_CAP_USER_DAILY : CODE.IMAGE_CAP_DAILY);
        }
        if (err instanceof UnsupportedImageModelError) return failed('failed', CODE.UNSUPPORTED_MODEL);
        if (err instanceof ImageGenError) {
          log.warn('turn: draw error', { channel: channel.id, reason: err.reason, status: err.statusCode ?? null });
          return failed(
            'failed',
            err.reason === 'moderation'
              ? CODE.IMAGE_MODERATION
              : err.reason === 'timeout'
                ? CODE.IMAGE_TIMEOUT
                : CODE.IMAGE_ERROR
          );
        }
        throw err;
      }
      // src/media/draw.js#drawPicture hands on the image client's picture (src/llm/images.js, generate).
      const picture = made.picture as Picture;
      const { referenceMissing } = made;
      if (referenceMissing) log.warn('turn: avatar reference unavailable', { channel: channel.id });
      if (staging) {
        (draft ? (draft.staged ??= []) : []).push({ picture, self, text: scene });
        // Counted when it is generated, posted or not.
        bumpDaily(store.state.data, DIARY_PICTURES_DAILY, clock());
        store.state.markDirty();
        return { status: 'ok', code: CODE.STAGED, data: none };
      }
      const name = imageFileName(picture.mediaType);
      // Checked again right before the publication: generated or not, a refused picture is not posted.
      const after = checkEffect('message.create', sendArgs({ media: name, replyId }), { channel, trigger });
      // A refusal carries its gateway code.
      if (!after.ok) return failed(refusalStatus(after.code!), after.code, { reason: after.reason });
      const target = channelId === String(channel.id) ? channel : { id: channelId };
      const result = await iface.send(conversationOf(target), {
        attachments: [{ name, data: picture.buffer, contentType: picture.mediaType }],
        ...(replyId ? { replyTo: messageOf(target, replyId) } : {}),
      });
      if (result?.status !== 'ok') {
        log.warn('turn: draw error', { channel: channel.id, error: portError(result) });
        return failed(
          result?.status === 'unknown' ? 'unknown' : 'failed',
          result?.error?.code ?? result?.status ?? CODE.ERROR,
          { error: result?.error ?? null }
        );
      }
      log.info('turn: drew', {
        channel: channel.id,
        seconds: picture.seconds,
        cost: picture.cost,
        self,
        bytes: picture.buffer?.length ?? 0,
      });
      return {
        status: 'ok',
        ref: result.ref ?? null,
        ...(Number.isFinite(result.at) ? { at: result.at as number } : {}),
        data: none,
      };
    } catch (err) {
      // A thrown value is anything; an operation's refusal (src/tools/impl/shared.ts, OpError) carries its result.
      const opError = err as { name?: unknown; status: string; code: string } | null;
      if (opError?.name === 'OpError') return failed(opError.status, opError.code);
      log.warn('turn: draw error', { channel: channel.id, error: err });
      return failed('failed', CODE.ERROR);
    }
  }

  /** Today's UTC date `YYYY-MM-DD` on the injected clock (the daily GIF counter). */
  function todayDate(): string {
    return utcDay(clock());
  }

  /** GIFs the persona posted today against `gifs.maxPerDay` (src/memory/gif-watch.js#gifPostsToday); reads only. */
  function gifsToday(): { used: number; cap: number } {
    return gifPostsToday(store.state.data, hot.config, todayDate());
  }

  /** Count one posted GIF against `gifs.maxPerDay` (the counter restarts on a new UTC day). */
  function countGif(): void {
    countGifPost(store.state.data, clock());
    store.state.markDirty();
  }

  /**
   * The persona's `<gif>` resolved against the guild's library: `{ id,
   * replyTo, entry }`, or null (logged with its reason, never a URL) when
   * features.gifs is false, the handle is unknown, or `gifs.maxPerDay`
   * (default 40, read now) is spent -- the last told to `limits` (optional) as a `daily-cap`.
   */
  function resolveGif(
    guildId: string,
    gif: GifCall | null | undefined,
    channelId: string,
    limits: DrawDraft['limits'] = null
  ): ResolvedGif | null {
    if (!gif) return null;
    let reason: string | null = null;
    let entry: GifEntry | null | undefined = null;
    if (hot.config.features?.gifs === false) reason = 'off';
    else {
      entry = store.findGif(guildId, gif.id);
      const posts = gifsToday();
      if (!entry) reason = 'unknown';
      else if (posts.used >= posts.cap) reason = 'daily';
    }
    if (reason) {
      if (reason === 'daily') limits?.add({ kind: 'daily-cap', where: 'gifs.maxPerDay' });
      log.info('turn: gif dropped', { channel: channelId, reason, usedToday: gifsToday().used });
      return null;
    }
    // No reason means the library found the entry.
    return { ...gif, entry: entry! };
  }

  /**
   * A fresh URL of an attached GIF: its original message is fetched again
   * (an attachment's address may expire) and the attachment found by id, in the
   * message itself or in a forwarded snapshot. Null when anything fails.
   */
  async function freshAttachmentUrl(channel: PostChannel, entry: GifEntry): Promise<string | null> {
    return sharedFreshAttachmentUrl({
      reads: ifaceReads,
      channel: conversationOf(channel),
      entry,
      onError: (err: unknown) =>
        log.warn('turn: gif refetch failed', { channel: channel.id, gif: entry.id, error: err }),
    });
  }

  /**
   * Post the persona's GIF (after its messages, or in place of the first one
   * when the GIF picker chose it): a link GIF as its stored
   * URL (the platform embeds tenor and giphy links), an attached one as a fresh URL of
   * its attachment, the stored one when that fails. Counted against
   * `gifs.maxPerDay` once sent, and stamped on its library entry of
   * `guildId` (store.recordOwnGif: `ownLast`/`ownUses`, the `<gifs>` list's
   * own-post mark). Never throws; resolves `{ message, op }` once sent
   * (`message`: postedOf the port's answer; `op`: its journal operation),
   * else null. The post is a `message.create` with the URL as its text
   * (checkEffect, right before it; a refusal posts nothing and resolves null),
   * made through the port; its journal operation (`openOp()`, by sendGif)
   * starts only once the check passed.
   * `replyId`: the chat line it quotes as a platform reply (replyTarget), or
   * null; `link`: the jump link it carries after its URL (withLink, so the
   * URL comes first and still embeds), or null; `trigger`: the turn's (the requester).
   */
  async function postGif(
    channel: PostChannel,
    guildId: string,
    gif: ResolvedGif,
    replyId: string | null,
    link: string | null,
    { openOp = () => NO_OP, trigger = null }: NonNullable<Parameters<DrawGif['postGif']>[5]> = {}
  ): Promise<{ message: ReturnType<typeof postedOf>; op: JournalOp | Readonly<JournalOp> } | null> {
    const { entry } = gif;
    let op: JournalOp | Readonly<JournalOp> = NO_OP;
    try {
      const fresh = entry.kind === 'attachment' ? await freshAttachmentUrl(channel, entry) : null;
      const text = withLink(gifPostUrl(entry, fresh), link, hot.prompts?.labels);
      if (!checkEffect('message.create', sendArgs({ text, replyId }), { channel, trigger }).ok) return null;
      op = openOp();
      if (op.opId) await op.started();
      const result = await iface.send(conversationOf(channel), {
        text,
        ...(replyId ? { replyTo: messageOf(channel, replyId) } : {}),
      });
      // The port answers every send with a result.
      if (result!.status !== 'ok') {
        if (op.opId) await closeResult(op, result);
        log.warn('turn: gif failed', { channel: channel.id, gif: entry.id, error: portError(result) });
        return null;
      }
      const message = postedOf(result);
      if (op.opId) await op.succeeded({ messageId: message.id });
      countGif();
      if (entry.key && typeof store.recordOwnGif === 'function') store.recordOwnGif(guildId, entry.key, clock());
      lastPostAt.set(channel.id, clock());
      log.info('turn: gif sent', {
        channel: channel.id,
        gif: entry.id,
        kind: entry.kind,
        fresh: Boolean(fresh),
        ...(link ? { link: true } : {}),
      });
      return { message, op };
    } catch (err) {
      if (op.opId) await op.failed(CODE.ERROR);
      log.warn('turn: gif failed', { channel: channel.id, gif: entry.id, error: err });
      return null;
    }
  }

  /**
   * The GIF picker (src/behavior/gif-pick.js), on the turn's FIRST message as
   * the model wrote it (a picked GIF takes its place; the rest are posted as
   * written): with features.gifPicker and features.gifs on (a missing key counts as
   * on), prompts['gif-pick'] present, the guild's library readable, room left
   * under `gifs.maxPerDay` (gifsToday) and pickCandidates saying yes (a first
   * message of at most `gifs.pick.maxChars` code points, no `<gif>` of the
   * turn's own -- the model's own GIF is never second-guessed --, at least one
   * captioned entry), ONE `analyzer` request on the classifier model
   * (role `analyzer`, purpose `gif-pick`, its answer capped at
   * `gifs.pick.maxOutputTokens`): system = the prompt with `{{name}}`, user =
   * `<gifs>` (renderGifLibrary over the WHOLE captioned library in rank order, with no own-post
   * mark, `gifs.reactionChars` and `gifs.actionChars` read now: the stable bulk first, the part
   * tagged for the provider's prompt cache; with `features.promptCache` exactly true it is held
   * per cache bucket in the guild's stable freeze, like the reply's `<gifs>`, see
   * src/behavior/prompt.js#freezePerBucket, so a GIF post or a use that reranks the library
   * rewrites the cached prefix at most once per `llm.cache.ttl`), then the per-call tail:
   * `<gifs_recent>` (ownGifLines: the listed GIFs the persona posted within `gifs.ownMarkHours`,
   * with how long ago, from the live library), `<context>` (pickContext: the last `gifs.pick.contextMessages` lines of
   * `history`, preceded by the line the first message answers when that one is
   * older -- its `reply` target, else the trigger --, as classifierTranscript
   * renders them; no block for 0), `<reply>` (the first message, preceded by
   * `transcript.replyTo` naming the `#n` of the line it answers when that line
   * is in `<context>`). A handle it lists (parseGifPick) resolves through resolveGif,
   * replying where the first message would have; `none` or anything else
   * resolves null. Logs `gifs: picked` (`handle`: whether one was named,
   * `library`: how many entries were listed) or `gifs: pick failed` with the
   * rail's code. Counts only. `gif`: the turn's own resolved GIF; `idByIndex`: the request's `#n` -> message id;
   * `trigger`: the message the turn answers, if any. Answers the GIF to post in place of the first message
   * (resolveGif's shape), or null.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function pickGif({
    channelId,
    guildId,
    messages,
    gif,
    history,
    selfName,
    idByIndex = new Map(),
    trigger = null,
  }: PickArgs): Promise<ResolvedGif | null> {
    const config = hot.config;
    if (config.features?.gifPicker === false || config.features?.gifs === false) return null;
    const prompt = hot.prompts?.['gif-pick'];
    if (typeof prompt !== 'string' || prompt.trim() === '') return null;
    if (typeof store.getGifs !== 'function' || typeof store.findGif !== 'function' || messages.length === 0)
      return null;
    const settings = gifPickSettings(config);
    const first = messages[0];
    const gifsCfg = config.gifs ?? {};
    const chars = gifFieldChars(gifsCfg);
    const labels = hot.prompts?.labels;
    const at = clock();
    // The library as the first pick of this cache bucket rendered it (no clock in it); the
    // signature lets an edit of its labels or settings show at once.
    const freeze =
      config.features?.promptCache === true
        ? stableFreezeOf<{ library: Array<string>; handles: Array<string> }>(guildId)
        : null;
    const { library, handles } = freezePerBucket<{ library: Array<string>; handles: Array<string> }>(
      freeze,
      'gif-pick',
      { now: at, bucketMs: cacheTtlMs(config), signature: JSON.stringify([labels?.gifs ?? null, gifsCfg]) },
      () => {
        const mediaCache = typeof store.getMediaCache === 'function' ? (store.getMediaCache(guildId) ?? null) : null;
        const listed = captionedEntries(
          // The check above found getGifs on the store.
          rankGifs(store.getGifs!(guildId), gifsCfg.halfLifeDays ?? 30),
          mediaCache,
          chars.actionChars
        );
        return {
          // Passed as it is: without labels the picker fails, and pickGifSafely logs it.
          library: renderGifLibrary(listed, mediaCache, labels!, { now: 0, ownMarkHours: 0, ...chars }),
          // The library's entries (src/memory/gifs.js) each carry their handle.
          handles: listed.map((entry) => (entry as { id: string }).id),
        };
      }
    );
    if (!pickCandidates({ text: first.text, postsGif: Boolean(gif), captioned: library.length }, settings)) return null;
    const posts = gifsToday();
    if (posts.used >= posts.cap) return null;
    // The line the first message answers: its reply target (a pulled line is not in `history`), else the trigger.
    const replyId =
      first.replyTo !== null && first.replyTo !== undefined ? (idByIndex.get(first.replyTo) ?? null) : null;
    const answeredId = replyId ?? trigger?.id ?? null;
    const context = pickContext(history, { contextMessages: settings.contextMessages, answeredId });
    const contextBody =
      context.messages.length > 0
        ? // Passed as it is: without labels the picker fails, and pickGifSafely logs it.
          classifierTranscript(context.messages, { config, selfName, labels: labels! })
        : '';
    // The reply is marked as a transcript line replying to that line would be: its #n, author and a quote.
    const answersMark =
      context.answeredIndex !== null && labels?.transcript?.replyTo
        ? replyMarker(context.messages[context.answeredIndex - 1], context.answeredIndex, {
            labels,
            selfName,
            replyQuoteChars: config.context?.replyQuoteChars,
          })
        : '';
    const replyBody = answersMark ? `${answersMark} ${first.text}` : first.text;
    // Which of the listed GIFs the persona posted lately, with how long ago: per call, in the tail.
    const recent = labels
      ? ownGifLines(store.getGifs(guildId), handles, labels, { ownMarkHours: gifsCfg.ownMarkHours ?? 24, now: at })
      : [];
    let completion: unknown;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { name: selfName ?? '' }) },
          {
            role: 'user',
            content: stableThenTail(
              block('gifs', library.join('\n')),
              [block('gifs_recent', recent.join('\n')), block('context', contextBody), block('reply', replyBody)],
              '\n\n'
            ),
          },
        ],
        {
          model: roleModel(config, 'analyzer', 'gif-pick'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'gif-pick',
          }),
        }
      );
    } catch (err) {
      log.warn('gifs: pick failed', {
        channel: channelId,
        reason: railReason(err),
        // A thrown value is anything; an HTTP error of the client carries its status.
        status: (err as { statusCode?: unknown } | null)?.statusCode ?? null,
      });
      return null;
    }
    const handle = parseGifPick(textOf(completion), handles);
    log.info('gifs: picked', { channel: channelId, handle: handle !== null, library: library.length });
    if (handle === null) return null;
    return resolveGif(guildId, { id: handle, replyTo: first.replyTo ?? null }, channelId);
  }

  /**
   * What `picking` (pickGifSafely's promise) answers within `gifs.pick.graceMs` (gifPickSettings,
   * read now; on `schedule`) from now, else null: the picker is left behind for this turn, logged
   * `gifs: pick late` (`channel`, `graceMs`) and journaled as a `helper-timeout` limit on
   * `gif-pick`. An answer already there wins over a grace of 0. `graceMs` null -> `picking` itself.
   */
  async function pickedInTime(
    picking: Promise<ResolvedGif | null>,
    { channelId, draft }: { channelId: string; draft?: DrawDraft | null }
  ): Promise<ResolvedGif | null> {
    const { graceMs } = gifPickSettings(hot.config);
    if (graceMs === null) return picking;
    const LATE = Symbol('late');
    let cancel: (() => void) | null = null;
    const timer = new Promise<typeof LATE>((resolve) => {
      cancel = schedule(() => resolve(LATE), graceMs);
    });
    const answer = await Promise.race([picking.then((value) => ({ value })), timer]);
    // The executor of `timer` ran synchronously and set `cancel`.
    (cancel as (() => void) | null)?.();
    if (answer !== LATE) return answer.value;
    log.info('gifs: pick late', { channel: channelId, graceMs });
    draft?.limits?.add({ kind: 'helper-timeout', where: 'gif-pick' });
    return null;
  }

  /** pickGif that never rejects: an unexpected failure (`gifs: pick failed`) posts the messages as written. */
  function pickGifSafely(args: PickArgs): Promise<ResolvedGif | null> {
    return pickGif(args).catch((err: unknown) => {
      log.warn('gifs: pick failed', { channel: args.channelId, error: err });
      return null;
    });
  }

  return { drawPromptFor, drawTool, resolveGif, postGif, pickedInTime, pickGifSafely };
}
