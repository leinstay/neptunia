// Limit notices: when a rail (daily request cap, token cap, image caps,
// private reply caps) refuses a directly requested action, the bot posts one
// plain line naming the limit and the numbers, so the requester knows it was
// a limit and not silence in character. The wording lives in labels.json
// (`limits.notice`); the limit name is the config key. A call while the bot
// is paused (`/nep pause`) gets the pause notice (`limits.paused`, no
// placeholders) the same way. See docs/prompt-contract.md. The pure
// functions come first; `postLimitNotice` and `postPauseNotice` (one sender,
// `sendNotice`) are the one copy of the posting side,
// shared by the turn runner (src/behavior/turn.js) and the message pipeline
// (src/behavior/pipeline.js).

import { fill } from '../format.js';
import { log } from '../log.js';

/**
 * The notice line: `labels.limits.notice` with `{limit}` (the config key),
 * `{used}` and `{cap}` filled. An empty string when the label is missing, so
 * a deployment without it simply posts nothing.
 * @param {object} labels
 * @param {{ key: string, used: number, cap: number }} limit
 * @returns {string}
 */
export function limitNotice(labels, { key, used, cap }) {
  const template = labels?.limits?.notice;
  if (typeof template !== 'string' || !template) return '';
  return fill(template, { limit: key, used, cap });
}

/**
 * The pause notice line: `labels.limits.paused` as is (it has no
 * placeholders). An empty string when the label is missing, blank or not a
 * string, so a deployment without it stays silent while paused.
 * @param {object} labels
 * @returns {string}
 */
export function pauseNotice(labels) {
  const text = labels?.limits?.paused;
  return typeof text === 'string' && text.trim() ? text : '';
}

/**
 * The least minutes between two pause notices in one channel:
 * `mention.pauseNoticeMinutes` (`config` read by the caller now) floored at
 * 0, or 10 (the config.json value) when it is missing or not a number. 0
 * lets every call get one.
 * @param {object} config
 * @returns {number}
 */
export function pauseNoticeMinutes(config) {
  const value = config?.mention?.pauseNoticeMinutes;
  return Number.isFinite(value) ? Math.max(0, value) : 10;
}

/**
 * Whether `content` is a line `limitNotice` produced from the current label
 * -- the template with every `{name}` placeholder matching any non-empty text
 * and everything else matched literally, anchored at both ends -- or the
 * current pause notice (`pauseNotice`), surrounding whitespace ignored in
 * both. Such a line is bookkeeping, not the persona's speech, so the caller
 * keeps it out of memory and follow-up windows. False when neither label is
 * set.
 * @param {object} labels
 * @param {unknown} content
 * @returns {boolean}
 */
export function isLimitNotice(labels, content) {
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
 * @param {unknown} err
 * @returns {{ key: string, used: number, cap: number } | null}
 */
export function limitOf(err) {
  if (!err || typeof err !== 'object') return null;
  const { key, used, cap } = err;
  if (typeof key !== 'string' || !key) return null;
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return null;
  return { key, used, cap };
}

/**
 * Post the limit notice for `limit` in `channel`: one plain message, no
 * mentions, quoting `trigger` as a platform reply when `asReply` (the caller
 * passes false for a follow-up, which never posts as a reply). `labels` is the caller's `hot.prompts.labels`,
 * read at the moment of use. A missing label or limit posts
 * nothing. Never throws: a failed send is logged.
 * @param {{ channel: { id: string, name?: string|null }, trigger?: { id?: string }|null,
 *   limit: { key: string, used: number, cap: number }|null, asReply: boolean, labels: object,
 *   port: import('../protocol/adapter.ts').Adapter }} args
 *   `port` is the interface adapter the notice goes out through.
 * @returns {Promise<'sent'|'none'|'failed'>}
 */
export async function postLimitNotice({ channel, trigger, limit, asReply, labels, port }) {
  const text = limit ? limitNotice(labels, limit) : '';
  if (!text) return 'none';
  return sendNotice({
    channel,
    trigger,
    text,
    asReply,
    port,
    sentLog: ['limits: notice sent', { key: limit.key }],
  });
}

/**
 * Post the pause notice (`pauseNotice`) in `channel` for a call that arrived
 * while the bot is paused, exactly like `postLimitNotice` (one plain message,
 * no mentions, quoting `trigger` when `asReply`). `kind` is how the persona was called (a
 * trigger kind or `private`), for the log. A missing label posts nothing.
 * Never throws.
 * @param {{ channel: { id: string, name?: string|null }, trigger?: { id?: string }|null, kind: string,
 *   asReply: boolean, labels: object, port: import('../protocol/adapter.ts').Adapter }} args
 * @returns {Promise<'sent'|'none'|'failed'>}
 */
export async function postPauseNotice({ channel, trigger, kind, asReply, labels, port }) {
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
 * @param {{ channel: { id: string, name?: string|null }, trigger?: { id?: string }|null, text: string, asReply: boolean,
 *   port: import('../protocol/adapter.ts').Adapter, sentLog: [string, object] }} args
 * @returns {Promise<'sent'|'failed'>}
 */
async function sendNotice({ channel, trigger, text, asReply, port, sentLog }) {
  try {
    const replyId = asReply ? (trigger?.id ?? null) : null;
    const conversation = { iface: port.iface, conversationId: channel.id };
    const delivery = await port.send(conversation, {
      text,
      ...(replyId ? { replyTo: { ...conversation, messageId: replyId } } : {}),
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
