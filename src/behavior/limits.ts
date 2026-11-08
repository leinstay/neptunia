// Limit notices: when a rail (daily request cap, token cap, image caps,
// private reply caps) refuses a directly requested action, the bot posts one
// plain line naming the limit and the numbers, so the requester knows it was
// a limit and not silence in character. The wording lives in labels.json
// (`limits.notice`); the limit name is the config key. A call while the bot
// is paused (`/nep pause`) gets the pause notice (`limits.paused`, no
// placeholders) the same way. See docs/prompt-contract.md. The pure
// functions come first; `postLimitNotice` and `postPauseNotice` (one sender,
// `sendNotice`) are the one copy of the posting side,
// shared by the turn runner (src/behavior/turn.ts) and the message pipeline
// (src/behavior/pipeline.ts).

import { fill } from '../format.ts';
import { log } from '../log.ts';
import type { Untyped } from '../tools/types.ts';
import type { Adapter } from '../protocol/adapter.ts';

/**
 * The notice line: `labels.limits.notice` with `{limit}` (the config key),
 * `{used}` and `{cap}` filled. An empty string when the label is missing, so
 * a deployment without it simply posts nothing.
 */
export function limitNotice(
  labels: Record<string, Untyped>,
  { key, used, cap }: { key: string; used: number; cap: number }
): string {
  const template = labels?.limits?.notice;
  if (typeof template !== 'string' || !template) return '';
  return fill(template, { limit: key, used, cap });
}

/**
 * The pause notice line: `labels.limits.paused` as is (it has no
 * placeholders). An empty string when the label is missing, blank or not a
 * string, so a deployment without it stays silent while paused.
 */
export function pauseNotice(labels: Record<string, Untyped>): string {
  const text = labels?.limits?.paused;
  return typeof text === 'string' && text.trim() ? text : '';
}

/** The least minutes between two pause notices in one channel. Production value, config cut of 2026-10-31. */
export const PAUSE_NOTICE_MINUTES = 10;

/**
 * Whether `content` is a line `limitNotice` produced from the current label
 * -- the template with every `{name}` placeholder matching any non-empty text
 * and everything else matched literally, anchored at both ends -- or the
 * current pause notice (`pauseNotice`), surrounding whitespace ignored in
 * both. Such a line is bookkeeping, not the persona's speech, so the caller
 * keeps it out of memory and follow-up windows. False when neither label is
 * set.
 */
export function isLimitNotice(labels: Record<string, Untyped>, content: unknown): boolean {
  if (typeof content !== 'string' || !content) return false;
  const paused = pauseNotice(labels);
  if (paused && content.trim() === paused.trim()) return true;
  const template = labels?.limits?.notice;
  if (typeof template !== 'string' || !template) return false;
  const pattern = template
    .split(/(\{\w+\})/)
    .map((part, index) => (index % 2 === 1 ? '.+?' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}$`, 'su').test(content.trim());
}

/**
 * The limit a rail error carries (`DailyCapError`, `TokenLimitError`,
 * `ImageCapError` set `key`, `used`, `cap`), or null for any other error.
 */
export function limitOf(err: unknown): { key: string; used: number; cap: number } | null {
  if (!err || typeof err !== 'object') return null;
  const { key, used, cap } = err as { key?: unknown; used?: unknown; cap?: unknown };
  if (typeof key !== 'string' || !key) return null;
  if (typeof used !== 'number' || !Number.isFinite(used) || typeof cap !== 'number' || !Number.isFinite(cap))
    return null;
  return { key, used, cap };
}

/**
 * Post the limit notice for `limit` in `channel`: one plain message, no
 * mentions, quoting `trigger` as a platform reply when `asReply` (the caller
 * passes false for a follow-up, which never posts as a reply). `labels` is the caller's `hot.prompts.labels`,
 * read at the moment of use. A missing label or limit posts
 * nothing. Never throws: a failed send is logged.
 *   `port` is the interface adapter the notice goes out through.
 */
export async function postLimitNotice({
  channel,
  trigger,
  limit,
  asReply,
  labels,
  port,
}: {
  channel: { id: string; name?: string | null };
  trigger?: { id?: string } | null;
  limit: { key: string; used: number; cap: number } | null;
  asReply: boolean;
  labels: Record<string, Untyped>;
  port: Adapter;
}): Promise<'sent' | 'none' | 'failed'> {
  const text = limit ? limitNotice(labels, limit) : '';
  if (!text) return 'none';
  return sendNotice({
    channel,
    trigger,
    text,
    asReply,
    port,
    sentLog: ['limits: notice sent', { key: limit?.key }],
  });
}

/**
 * Post the pause notice (`pauseNotice`) in `channel` for a call that arrived
 * while the bot is paused, exactly like `postLimitNotice` (one plain message,
 * no mentions, quoting `trigger` when `asReply`). `kind` is how the persona was called (a
 * trigger kind or `private`), for the log. A missing label posts nothing.
 * Never throws.
 */
export async function postPauseNotice({
  channel,
  trigger,
  kind,
  asReply,
  labels,
  port,
}: {
  channel: { id: string; name?: string | null };
  trigger?: { id?: string } | null;
  kind: string;
  asReply: boolean;
  labels: Record<string, Untyped>;
  port: Adapter;
}): Promise<'sent' | 'none' | 'failed'> {
  const text = pauseNotice(labels);
  if (!text) return 'none';
  return sendNotice({
    channel,
    trigger,
    text,
    asReply,
    port,
    sentLog: ['limits: pause notice', { kind }],
  });
}

/**
 * The one sender behind both notices: send `text` through `port` (a reply
 * to `trigger` when `asReply`, no mentions) and log `sentLog`, `[event, fields]` with the channel id added. A send
 * the adapter does not answer `ok` is `failed`. Never throws.
 */
async function sendNotice({
  channel,
  trigger,
  text,
  asReply,
  port,
  sentLog,
}: {
  channel: { id: string; name?: string | null };
  trigger?: { id?: string } | null;
  text: string;
  asReply: boolean;
  port: Adapter;
  sentLog: [string, Untyped];
}): Promise<'sent' | 'failed'> {
  try {
    const replyId = asReply ? (trigger?.id ?? null) : null;
    const chat = { iface: port.iface, chatId: channel.id };
    const delivery = await port.send(chat, {
      text,
      ...(replyId ? { replyTo: { ...chat, messageId: replyId } } : {}),
      mentions: { users: [], repliedUser: false },
    });
    if (delivery.status !== 'ok') {
      log.warn('limits: notice failed', { channel: channel.id, status: delivery.status, code: delivery.error?.code });
      return 'failed';
    }
    log.info(sentLog[0], { channel: channel.id, ...sentLog[1] });
    return 'sent';
  } catch (err) {
    log.warn('limits: notice failed', { channel: channel.id, error: err });
    return 'failed';
  }
}
