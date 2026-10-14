// Operations: `/nep diary`: the channel where the persona posts on its own (src/behavior/diary.js). Owner-only, as the diary group has always been (rights.ownerOnly below).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { canAttach, canRead, canSend } from '../discord/collect.js';
import { backfillDiary } from '../behavior/diary.js';
import { log } from '../log.js';
import { formatClock } from '../discord/format.js';
import { unsetPath, reloadNote } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, store, client, diary, assertNotPaused, freshenIfPaused, resolvedGuildId, requireGuildId, editLocalConfig, writeLocalPath } = env;

  /** The post kinds the diary may use: the keys of `diary.kinds` with a weight above zero, read now. */
  function diaryKindKeys() {
    return Object.entries(hot.config.diary?.kinds ?? {})
      .filter(([, weight]) => Number(weight) > 0)
      .map(([key]) => key);
  }

  /** Today's slots as local `HH:MM` times (a done one marked), one line; [] without a plan. */
  function diaryPlanLines(status) {
    if (!status || !Array.isArray(status.slots)) return [];
    const timezone = hot.config.bot?.timezone || 'UTC';
    const done = new Set(Array.isArray(status.done) ? status.done : []);
    const slots = status.slots.map((slot) => `${formatClock(slot, timezone)}${done.has(slot) ? ' done' : ''}`);
    return [`today${status.day ? ` (${status.day})` : ''}: ${slots.length > 0 ? slots.join(', ') : 'no posts planned'}`];
  }

  /**
   * `/nep diary set`: the channel must be one the bot can see, read, send and attach files in;
   * then `diary.channelId` is written to config.local.json, an empty `diary.json` is filled from
   * the persona's own past posts there (src/behavior/diary.js#backfillDiary), and the reply names
   * the channel, the backfilled count and today's plan when the diary is running.
   */
  async function cmdDiarySet(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const channelId = String(args?.channelId ?? '').trim();
    if (!channelId) throw invalid('a channel is required');
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw invalid(`no channel ${channelId}`, 'not-found');
    if (!canRead(channel)) throw new Error(`cannot view or read the history of ${channelId}; nothing was changed`);
    if (!canSend(channel)) throw new Error(`cannot send messages in ${channelId}; nothing was changed`);
    if (!canAttach(channel)) throw new Error(`cannot attach files in ${channelId}; nothing was changed`);

    const ok = writeLocalPath('diary.channelId', channelId);
    let backfilled = 0;
    let note = '';
    try {
      backfilled = await backfillDiary({
        store,
        channel,
        guildId,
        selfId: client.user?.id,
        config: hot.config,
        labels: hot.prompts?.labels,
      });
    } catch (err) {
      log.warn('admin: diary backfill failed', { error: err });
      note = ' (the backfill failed; it is retried before the first post)';
    }
    const lines = [`Diary channel set to ${channelId} ${reloadNote(ok)}; backfilled ${backfilled} posts${note}.`];
    lines.push(...diaryPlanLines(diary?.status?.()));
    return lines.join('\n');
  }

  /**
   * `/nep diary show`: the channel, today's slots, posts and pictures used today, each window's
   * hunger with the quiet streak, the history size.
   */
  function cmdDiaryShow(args, context) {
    freshenIfPaused();
    const status = diary?.status?.() ?? null;
    const channelId = hot.config.diary?.channelId || '';
    const guildId = resolvedGuildId(context);
    const history = status?.history ?? (guildId ? store.getDiary(guildId).posts.length : '-');
    const lines = [`diary channel: ${channelId || 'off'}`, ...diaryPlanLines(status)];
    if (status) {
      lines.push(`posts today: ${status.posts ?? 0}`, `pictures today: ${status.pictures ?? 0}`);
      const hunger = Array.isArray(status.hunger) && status.hunger.length > 0 ? status.hunger.join('/') : '-';
      lines.push(`hunger: ${hunger} (quiet streak ${status.quietStreak ?? 0})`);
    }
    lines.push(`history: ${history}`);
    return lines.join('\n');
  }

  /** `/nep diary off`: clears `diary.channelId`; `diary.json` stays. */
  function cmdDiaryOff() {
    const ok = editLocalConfig((local) => unsetPath(local, 'diary.channelId'));
    return `Diary off ${reloadNote(ok)}; its memory file is kept.`;
  }

  /**
   * `/nep diary post [kind] [topic]`: one forced post now; an unknown kind is refused with the list.
   * Only a post that went out (`spoke`) is `ok`; any other outcome is a `failed` result with the
   * same line, its code `not-configured` when the diary has no channel or is switched off (or is
   * not running at all), `daily-cap` for a cap, else the outcome itself -- so nobody, the persona
   * included (her skills), is told a post went out when it did not.
   */
  async function cmdDiaryPost(args) {
    assertNotPaused();
    if (typeof diary?.force !== 'function') throw Object.assign(new Error('diary not running'), { code: 'not-configured' });
    const kind = String(args?.kind ?? '').trim() || undefined;
    const kinds = diaryKindKeys();
    if (kind !== undefined && !kinds.includes(kind)) {
      throw invalid(`unknown kind: ${kind} (kinds: ${kinds.join(', ')})`);
    }
    // The owner's topic nudges the post's subject; blank is none (src/behavior/diary.js#diaryTopic clamps it).
    const topic = String(args?.topic ?? '').trim();
    const outcome = await diary.force(topic ? { kind, topic } : { kind });
    const text = typeof outcome === 'string' ? outcome : (outcome?.outcome ?? JSON.stringify(outcome) ?? 'ok');
    // A refusal by a cap names the setting and the day's counts; any other reason is shown as its code.
    const limit = outcome && typeof outcome === 'object' ? outcome.limit : null;
    const reason = limit?.key
      ? ` (${limit.key} ${limit.used}/${limit.cap})`
      : outcome && typeof outcome === 'object' && outcome.reason ? ` (${outcome.reason})` : '';
    const line = `diary post${kind ? ` ${kind}` : ''}: ${text}${reason}`;
    const result = outcome && typeof outcome === 'object' ? outcome.outcome : outcome;
    if (result === 'spoke' || result === undefined || result === null) return line;
    const why = outcome && typeof outcome === 'object' ? outcome.reason : null;
    const code = why === 'no-channel' || why === 'off' ? 'not-configured' : limit?.key ? 'daily-cap' : String(result);
    return { status: 'failed', code, summary: line, data: null };
  }

  return { diaryKindKeys, diaryPlanLines, cmdDiarySet, cmdDiaryShow, cmdDiaryOff, cmdDiaryPost };
});

defineOp({
  name: 'diary.set',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdDiarySet(args, ctx),
});
defineOp({
  name: 'diary.show',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdDiaryShow(args, ctx),
});
defineOp({
  name: 'diary.off',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdDiaryOff(),
});
defineOp({
  name: 'diary.post',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdDiaryPost(args),
});
