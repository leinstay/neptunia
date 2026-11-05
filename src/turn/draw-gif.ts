// The pictures and GIFs of a turn: one picture and her `draw.create` tool, the post of the GIF the media pick chose
// (src/behavior/media-pick.ts) and the grace its answer gets. createTurnRunner (src/behavior/turn.ts) builds it once per
// runner with createDrawGif; the act and her calls call its functions.

import { placeOfConversation } from '../memory/addresses.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { PublicationBoundary } from '../tools/publication.ts';
import { turnBoundary, bindPublicationPort } from '../tools/publication.ts';
import type { Context } from '../memory/db/scope.ts';
import { imageFileName } from '../behavior/mirror.ts';
import { setSettings } from '../behavior/selfreflection.ts';
import { mediaPickSettings } from '../behavior/media-pick.ts';
import type { MediaPickResult } from '../behavior/media-pick.ts';
import type { PictureGate } from '../behavior/selfreflection-turn.ts';
import type { Reads } from '../interface/reads.ts';
import type { Untyped } from '../tools/types.ts';
import { ImageGenError, UnsupportedImageModelError } from '../llm/images.ts';
import { log } from '../log.ts';
import { drawPicture } from '../media/draw.ts';
import { freshAttachmentUrl as sharedFreshAttachmentUrl, gifPostForm, gifPostUrl } from '../media/gif-post.ts';
import type { GifForm } from '../media/gif-post.ts';
import type { ConversationInfo, ConversationRef, MessageRef } from '../protocol/adapter.ts';
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
  selfreflection?: unknown;
};

/** The prompt files the pictures and GIFs read (hot.prompts). */
type DrawGifPrompts = { labels?: Parameters<typeof withLink>[2] } & object;

/** The library entry of a GIF (src/memory/gifs.ts), as its post reads it. */
type GifEntry = {
  id: string;
  url: string;
  kind?: string;
  key?: string;
  messageId?: string;
  placeId?: string;
  itemId?: string;
  file?: string;
};

/** The GIF the pick chose: its entry and the `#n` it replies to. */
export type ResolvedGif = { replyTo?: number | null; entry: GifEntry };

/** The memory store, as the pictures and GIFs read and write it. */
export type DrawGifStore = {
  state: { data: object; markDirty: () => void };
  recordOwnGif?: (placeId: string, key: string, at: number) => unknown;
};

/** The image client (src/llm/images.ts#createImageGen). */
type DrawGifImages = NonNullable<Parameters<typeof drawPicture>[0]>['images'];

/** A picture as the image client made it (src/llm/images.ts#createImageGen's generate). */
type Picture = { buffer?: Buffer; mediaType: string; cost: number | null; seconds: number };

/** The interface port (src/interface/port.ts), as the pictures and GIFs post through it. */
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

/** A selfreflection post's staged picture. */
type Staged = { picture: Picture; self: boolean; text: string };

/** What an attempt's draft holds that a picture reads and writes. */
type DrawDraft = {
  memoryContext?: Context;
  staged?: Array<Staged>;
  selfreflection?: { set?: unknown } | null;
  avatar?: { reference?: string | null };
  limits?: { add: (limit: { kind: string; where: string }) => void } | null;
};

/** What createDrawGif reads: the dependencies and the runner functions and state the pictures and GIFs use. */
export type DrawGifContext = {
  hot: { readonly config: DrawGifConfig; readonly prompts: DrawGifPrompts };
  store: DrawGifStore;
  dataDir: string | null;
  images: DrawGifImages | null | undefined;
  imageFetcher: NonNullable<Parameters<typeof drawPicture>[0]>['imageFetcher'];
  ifaceReads: Reads;
  iface: DrawGifPort;
  routes: { report: <TValue>(role: string, model: string | null, made: Promise<TValue>) => Promise<TValue> };
  selfIdOf: () => string;
  clock: () => number;
  schedule: (run: () => void, ms: number) => () => void;
  conversationOf: (channel: PostChannel) => ConversationRef;
  messageOf: (channel: PostChannel, messageId: string) => MessageRef;
  checkEffect: (skill: string, args: unknown, at: { channel: PostChannel; trigger?: unknown }) => EffectVerdict;
  lastPostAt: Map<string, number>;
  selfreflectionPictureGate: (config: DrawGifConfig, channel: ConversationInfo, now: number) => PictureGate;
};

/** The trigger of a turn, as a picture or a GIF reads it. */
type DrawTrigger = { id?: string; authorId?: string | null } | null;

export type DrawGif = {
  drawTool: (
    args: { self?: unknown; text?: unknown; placeId?: unknown; replyTo?: unknown } | null | undefined,
    at: {
      channel: ConversationInfo;
      placeId?: string | null;
      trigger?: DrawTrigger;
      triggerKind?: TriggerKind | null;
      selfName: string;
      draft?: DrawDraft | null;
      mode?: string | null;
      plain?: boolean;
    },
    model?: string | null
  ) => Promise<DrawResult>;
  postGif: (
    channel: PostChannel,
    gif: ResolvedGif,
    replyId: string | null,
    link: string | null,
    options: {
      forms: ReadonlyArray<GifForm>;
      openOp?: () => JournalOp | Readonly<JournalOp>;
      trigger?: DrawTrigger;
      publicationBoundary?: PublicationBoundary;
    }
  ) => Promise<{ message: ReturnType<typeof postedOf>; op: JournalOp | Readonly<JournalOp> } | null>;
  pickedInTime: (
    picking: Promise<MediaPickResult>,
    at: { placeId: string; draft?: DrawDraft | null }
  ) => Promise<MediaPickResult>;
};

// health: allow function-length until 2027-04-01 -- the pictures and GIFs share the runner state of src/behavior/turn.ts, moved whole in stage 5b
export function createDrawGif(ctx: DrawGifContext): DrawGif {
  const {
    hot,
    store,
    dataDir,
    images,
    imageFetcher,
    ifaceReads,
    iface,
    routes,
    selfIdOf,
    clock,
    schedule,
    conversationOf,
    messageOf,
    checkEffect,
    lastPostAt,
    selfreflectionPictureGate,
  } = ctx;

  /**
   * One picture (src/media/draw.ts#drawPicture): her scene verbatim into the drawing prompt, the avatar reference for a
   * picture she is in, one generation. `accountId` is the member whose rail counts it (null: nobody's); `avatar` the
   * holder a selfreflection set reuses the avatar through; `model` the core model's id when the call is routed there (null: the
   * drawing role's own, whose outcome the role health is told). Throws what the image client throws (ImageCapError,
   * ImageGenError).
   */
  function makePicture({
    scene,
    self,
    selfName,
    placeId = null,
    accountId = null,
    avatar = null,
    model = null,
  }: {
    scene: string;
    self: boolean;
    selfName: string;
    placeId?: string | null;
    accountId?: string | null;
    avatar?: { reference?: string | null } | null;
    model?: string | null;
  }): Promise<{ picture: object; referenceMissing: boolean }> {
    const made = drawPicture({
      // drawTool asks makePicture only once it found the image client.
      images: images!,
      hot,
      // The persona's large avatar, asked of the interface only when the picture needs the reference.
      avatarUrl: async () => {
        const found = await ifaceReads.memberInfo({ placeId, accountId: selfIdOf() });
        return found?.member?.avatar.largeUrl ?? null;
      },
      imageFetcher,
      now: clock,
      input: { scene, selfName, self, withTime: true, accountId, avatar, model },
    });
    return routes.report('drawing', model, made);
  }

  /**
   * `draw.create` as an in-turn tool of hers (`args`: the operation's, `{ text, self, placeId?, replyTo? }`): the
   * picture through makePicture, the scene verbatim, with the local time, then one upload through the port. It posts
   * where `message.create` would: the channel she names, else the replied message's (a link names it; a channel and a
   * reply that disagree are refused `unknown-message`), else this one, checked before anything is generated, on `model`
   * (the core model's id when its route moved it, else null) (src/tools/impl/shared.ts#postingConversation, `attach`).
   * A reply quotes the message in that channel. The picture is charged to the asking member's rail when the turn was
   * asked (askedFor), to nobody's otherwise. Every failure is a result she reads, never a limit notice: an image cap is
   * `image-cap-daily` or `image-cap-user-daily`, a generation failure `image-moderation`, `image-timeout` or
   * `image-error`, a refused publication its gateway code, and the port's answer to the upload passes through
   * (`unknown` when it may have gone out: never generated again). In a selfreflection turn (`mode` 'selfreflection') the picture is
   * staged into `draft.staged` as `{ picture, self, text }` instead of posted (ok, code `staged`), and refused
   * `daily-cap` (reason `pictures`, selfreflectionPictureGate: no image client or no Attach Files) while the post may carry none, `loop-cap` past what the post's kind takes (one picture, or `selfreflection.set.pictures[1]`
   * for a set kind: `draft.selfreflection.set`). Never throws.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.ts in stage 5b, a pure move
  async function drawTool(
    args: Parameters<DrawGif['drawTool']>[0],
    {
      channel,
      placeId = null,
      trigger = null,
      triggerKind = null,
      selfName,
      draft = null,
      mode = null,
      plain = false,
    }: Parameters<DrawGif['drawTool']>[1],
    model: string | null = null
  ): Promise<DrawResult> {
    const publicationBoundary = turnBoundary(draft, conversationOf(channel));
    const port = bindPublicationPort(iface, publicationBoundary);
    const none = { text: '' };
    const failed = (status: string, code: string | undefined, extra: object = {}): DrawResult => ({
      status,
      code,
      ...extra,
      data: none,
    });
    if (!images) return failed('not_configured', CODE.NOT_CONFIGURED);
    const self = args?.self === true;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's argument may be any JSON value, read as text
    const scene = String(args?.text ?? '');
    const asked = askedFor(trigger, triggerKind);
    const staging = mode === 'selfreflection';
    if (staging) {
      // A selfreflection post's pictures: the gate is asked at every picture.
      const gate = selfreflectionPictureGate(hot.config, channel, clock());
      if (!gate.allowed) return failed(refusalStatus(CODE.DAILY_CAP), CODE.DAILY_CAP, { reason: 'pictures' });
      if (
        (draft?.staged?.length ?? 0) >=
        (draft?.selfreflection?.set ? setSettings(hot.config.selfreflection).pictures[1] : 1)
      )
        return failed(refusalStatus(CODE.LOOP_CAP), CODE.LOOP_CAP, { reason: 'extra-call' });
    }
    try {
      let conversationId = String(channel.id);
      let replyId: string | null = null;
      if (!staging) {
        // A turn that quotes no chat line (a follow-up, an overheard line, a later part of a split message) posts its picture plain.
        const reply = args?.replyTo && !plain ? await messageRefOf(args.replyTo, ifaceReads) : null;
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's argument may be any JSON value, read as text
        const given = args?.placeId ? String(args.placeId) : null;
        if (given && reply?.placeId && given !== reply.placeId) return failed('invalid', CODE.UNKNOWN_MESSAGE);
        conversationId = await postingConversation({
          reads: ifaceReads,
          store,
          iface: channel.iface,
          conversationId: given ?? reply?.placeId ?? null,
          context: { placeId: placeOfConversation(store, channel), publicationBoundary },
          need: 'attach',
        });
        replyId = reply?.messageId ?? null;
        // The current channel: where no file can be posted nothing is generated (or paid for).
        if (conversationId === String(channel.id) && !channel.permissions.attach)
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
          placeId,
          // askedFor is true only for a turn with a trigger.
          accountId: asked ? (trigger!.authorId ?? null) : null,
          model,
          ...(staging && draft ? { avatar: (draft.avatar ??= {}) } : {}),
        });
      } catch (err) {
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
      // src/media/draw.ts#drawPicture hands on the image client's picture (src/llm/images.ts, generate).
      const picture = made.picture as Picture;
      const { referenceMissing } = made;
      if (referenceMissing) log.warn('turn: avatar reference unavailable', { channel: channel.id });
      if (staging) {
        (draft ? (draft.staged ??= []) : []).push({ picture, self, text: scene });
        return { status: 'ok', code: CODE.STAGED, data: none };
      }
      const name = imageFileName(picture.mediaType);
      // Checked again right before the publication: generated or not, a refused picture is not posted.
      const after = checkEffect('message.create', sendArgs({ media: name, replyId }), { channel, trigger });
      // A refusal carries its gateway code.
      if (!after.ok) return failed(refusalStatus(after.code!), after.code, { reason: after.reason });
      const target = conversationId === String(channel.id) ? channel : { id: conversationId };
      const result = await port.send(conversationOf(target), {
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

  /** The bytes of a GIF's cached file, null when it cannot be read. */
  function cachedFile(entry: GifEntry): { name: string; data: Buffer } | null {
    if (!dataDir || !entry.file) return null;
    try {
      return { name: path.basename(entry.file), data: fs.readFileSync(path.join(dataDir, entry.file)) };
    } catch (err) {
      log.warn('turn: gif file unreadable', { gif: entry.id, error: err });
      return null;
    }
  }

  /** What a GIF posts as in the interface's form, and what the gateway checks of it; null when there is no form for it. */
  async function gifBody(channel: PostChannel, entry: GifEntry, link: string | null, forms: ReadonlyArray<GifForm>) {
    const form = gifPostForm({ kind: entry.kind ?? 'link', ...(entry.file ? { file: entry.file } : {}) }, forms);
    if (form === null) return null;
    const file = form === 'file' ? cachedFile(entry) : null;
    if (file) {
      return {
        form: 'file',
        fresh: false,
        check: { media: file.name },
        content: { attachments: [{ name: file.name, data: file.data }] },
      };
    }
    if (form === 'file' && !forms.includes('link')) return null;
    const fresh = entry.kind === 'attachment' ? await freshAttachmentUrl(channel, entry) : null;
    const text = withLink(gifPostUrl(entry, fresh), link, hot.prompts?.labels);
    return { form: 'link', fresh: Boolean(fresh), check: { text }, content: { text } };
  }

  /**
   * Post the GIF the media pick chose, in place of the first message, in the form the interface takes it
   * (src/media/gif-post.ts#gifPostForm, `forms`): its cached file, a link GIF as its stored URL (the platform embeds tenor
   * and giphy links), an attached one as a fresh URL of its attachment, the stored one when that fails. A file that
   * cannot be read goes through its link on an interface that declares links. Stamped once sent on its library entry for
   * the place it went to (store.recordOwnGif). Never throws; resolves `{ message, op }` once sent (`message`: postedOf the
   * port's answer; `op`: its journal operation), else null, a refused post included, so the first message goes as written.
   * The post is a `message.create` (checkEffect, right before it; a refusal posts nothing), made through the port; its
   * journal operation (`openOp()`, by sendGif) starts only once the check passed. `replyId`: the chat line it quotes as a
   * platform reply (replyTarget), or null; `link`: the jump link it carries after its URL (withLink, so the URL comes
   * first and still embeds), or null; `trigger`: the turn's (the requester).
   */
  async function postGif(
    channel: PostChannel,
    gif: ResolvedGif,
    replyId: string | null,
    link: string | null,
    { forms, openOp = () => NO_OP, trigger = null, publicationBoundary }: Parameters<DrawGif['postGif']>[4]
  ): Promise<{ message: ReturnType<typeof postedOf>; op: JournalOp | Readonly<JournalOp> } | null> {
    const { entry } = gif;
    let op: JournalOp | Readonly<JournalOp> = NO_OP;
    try {
      const body = await gifBody(channel, entry, link, forms);
      if (!body) return null;
      if (!checkEffect('message.create', sendArgs({ ...body.check, replyId }), { channel, trigger }).ok) return null;
      op = openOp();
      if (op.opId) await op.started();
      const result = await bindPublicationPort(iface, publicationBoundary).send(conversationOf(channel), {
        ...body.content,
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
      if (entry.key && typeof store.recordOwnGif === 'function') store.recordOwnGif(channel.id, entry.key, clock());
      lastPostAt.set(channel.id, clock());
      log.info('turn: gif sent', {
        channel: channel.id,
        gif: entry.id,
        kind: entry.kind,
        form: body.form,
        fresh: body.fresh,
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
   * What `picking` answers within the pick's grace (mediaPickSettings, read now; on `schedule`) from now, else `none`: the
   * pick is left behind for this turn, logged `media-pick: late` (`channel`, `graceMs`) and journaled as a `helper-timeout`
   * limit on `media-pick`. An answer already there wins over a grace of 0. `graceMs` null -> `picking` itself.
   */
  async function pickedInTime(
    picking: Promise<MediaPickResult>,
    { placeId, draft }: { placeId: string; draft?: DrawDraft | null }
  ): Promise<MediaPickResult> {
    const { graceMs } = mediaPickSettings(hot.config as Record<string, Untyped>);
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
    log.info('media-pick: late', { channel: placeId, graceMs });
    draft?.limits?.add({ kind: 'helper-timeout', where: 'media-pick' });
    return { kind: 'none' };
  }

  return { drawTool, postGif, pickedInTime };
}
