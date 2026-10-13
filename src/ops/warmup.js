// Operations: `/nep warmup`: the sample-based memory warmup (src/memory/warmup.js). `people`/`status` only read; the rest write under data/.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { log } from '../log.js';
import { NONE, isoDay, humanizeAgo, formatWarmupPhase, outcomeText, channelTopWritersText } from './shared.js';
import { defineOp, perEnv } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, isWarmingUp, warmup, slash, warmupBusyText, assertNotPaused, requireGuildId, tokenResolver } = env;

  function formatWarmupPeople(report) {
    if (!report.ok) return outcomeText(report, 'not done');
    const lines = report.people.map((p, i) => {
      const topChannels = Object.entries(p.byChannel)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cid, count]) => `${cid}:${count}`)
        .join(', ');
      return `${i + 1}. ${p.name} (id:${p.id}) — ${p.messages} messages, ${isoDay(p.firstTs)}..${isoDay(p.lastTs)}, top channels: ${topChannels || '-'}`;
    });
    if (lines.length === 0) lines.push(NONE);
    lines.push('');
    lines.push(`channels read: ${report.totals.channelsRead}`);
    lines.push(`messages read: ${report.totals.messagesRead}`);
    lines.push(`people below the threshold: ${report.totals.belowThreshold}`);
    return lines.join('\n');
  }

  async function cmdWarmupPeople(_args, context) {
    const guildId = requireGuildId(context);
    return formatWarmupPeople(await warmup.peopleReport(guildId));
  }

  /** `/nep warmup run`: starts the whole run and answers at once. A run that ends early without
   * throwing (`{ ok: false }`: a missing prompt, no guild, ...) is logged with its reason. */
  async function cmdWarmupRun(_args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();
    if (isWarmingUp()) return warmupBusyText();

    // Fire and forget: a full run takes many minutes, far beyond an interaction's lifetime.
    // Progress is persisted after every request; /nep warmup status follows it.
    warmup
      .run(guildId)
      .then((result) => {
        if (!result?.ok) log.warn('admin: warmup run ended early', { reason: outcomeText(result, null) });
      })
      .catch((err) => log.warn('admin: warmup run failed', { error: err }));
    return `warmup started: channels, then people, then the server. Follow it with ${slash('warmup status')}.`;
  }

  /** `/nep warmup stop`: ends any warmup work in flight for good -- the full run, a
   * `users`/`channels` bulk redo, or a synchronous one-off -- including cancelling the model call
   * actually in progress (see src/memory/warmup.js#stop). Reads no `data/` itself, so not
   * guarded by assertNotPaused(). */
  function cmdWarmupStop() {
    const result = warmup.stop();
    return result.ok ? 'warmup stopped' : 'no warmup in flight';
  }

  /** `/nep warmup users user:<member>`: a short summary of what was actually written -- sample
   * size, tokens, counts of interests/details/episodes/aliases, and the first ~300 chars of the
   * character field. Relays `outcome.message` unchanged when nothing was written (missing prompt
   * file, no messages in the window, a bad model answer, a stop mid-flight, ...). */
  function formatWarmupUserWritten(outcome) {
    if (!outcome.ok) return outcomeText(outcome, 'not done');
    const { member, answer, sample, tokensUsed, chunks } = outcome;
    const a = answer ?? {};
    const characterExcerpt = String(a.character ?? '').slice(0, 300) || '(empty)';
    const chunkNote = chunks > 1 ? `, ${chunks} chunks` : '';
    return [
      `profiled ${member.name} (id:${member.id})`,
      `sample: ${sample?.ownCount ?? '?'} own / ${sample?.contextCount ?? '?'} context lines${chunkNote}`,
      `tokens used: ${tokensUsed ?? '?'}`,
      `interests: ${a.interests?.length ?? 0}, details: ${a.details?.length ?? 0}, episodes: ${a.episodes?.length ?? 0}, aliases: ${a.aliases?.length ?? 0}`,
      `character: ${characterExcerpt}`,
    ].join('\n');
  }

  /** `/nep warmup users [user]`: a `user` given
   * -> (re)profiles exactly that member now, synchronously; omitted -> starts a background redo of
   * every qualifying member, sharing every rail with the full run. */
  async function cmdWarmupUsers(args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();

    const userId = args?.userId;
    if (userId) {
      const result = await warmup.runPerson(guildId, userId);
      return formatWarmupUserWritten(result.ok ? result.outcome : result);
    }

    const result = await warmup.runUsers(guildId);
    if (!result.ok) return outcomeText(result, 'not started');
    return `started ${result.count} members`;
  }

  /** `/nep warmup channels channel:<channel>`: the note actually written (purpose/topics/tone),
   * plus the counters and top writers `store.setChannelFacts` just filled in -- the same lines as
   * `/nep memory channel` (writers as `name (count)`, an id with no profile skipped; the last
   * message as a date). Relays `outcome.message` unchanged when nothing was written. */
  function formatWarmupChannelWritten(outcome, guildId) {
    if (!outcome.ok) return outcomeText(outcome, 'not done');
    const { channel, result, facts } = outcome;
    const lines = [
      `described #${channel.name} (id:${channel.id})`,
      `purpose: ${result.purpose || '(empty)'}`,
      `topics: ${result.topics || '(empty)'}`,
      `tone: ${result.tone || '(empty)'}`,
    ];
    if (facts) {
      lines.push(`messages seen: ${facts.messageCount}`);
      lines.push(`last message: ${isoDay(facts.lastMessageAt)}`);
      const writers = channelTopWritersText(facts.topWriters, tokenResolver(guildId).nameOf);
      if (writers) lines.push(`top writers: ${writers}`);
    }
    return lines.join('\n');
  }

  /** `/nep warmup channels [channel]`: a
   * `channel` given -> (re)describes exactly that channel now, synchronously; omitted -> starts a
   * background redo of every readable channel, sharing every rail with the full run. */
  async function cmdWarmupChannels(args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();

    const channelId = args?.channelId;
    if (channelId) {
      const result = await warmup.runChannel(guildId, channelId);
      return formatWarmupChannelWritten(result.ok ? result.outcome : result, guildId);
    }

    const result = await warmup.runChannels(guildId);
    if (!result.ok) return outcomeText(result, 'not started');
    return `started ${result.count} channels`;
  }

  /** `/nep warmup server`: counts of what was written (patterns/starters lengths, injokes, lore
   * entries). Relays `outcome.message` unchanged when nothing was written. */
  function formatWarmupServerWritten(outcome) {
    if (!outcome.ok) return outcomeText(outcome, 'not done');
    const c = outcome.counts;
    return `server notes updated: patterns ${c.patternsChars} chars, starters ${c.startersChars} chars, injokes ${c.injokes}, lore entries ${c.lore}`;
  }

  async function cmdWarmupServer(_args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();

    const result = await warmup.runServer(guildId);
    return formatWarmupServerWritten(result.ok ? result.outcome : result);
  }

  async function cmdWarmupStatus(_args, context) {
    const guildId = requireGuildId(context);
    const s = await warmup.status(guildId); // synchronous in the real runner; awaiting a plain value is harmless
    return [
      `phase: ${formatWarmupPhase(s)}`,
      `last activity: ${humanizeAgo(s.activity?.lastActivityAt, Date.now())}`,
      `channels: ${s.doneChannels}/${s.channelsEligible ?? '?'}`,
      `people: ${s.donePeople}/${s.peopleEligible ?? '?'}`,
      `server: ${s.doneServer ? 'done' : 'pending'}`,
      `tokens used: ${s.tokensUsed} / ${hot.config.warmup?.maxTokens ?? '-'}`,
      `requests: ${s.requests}`,
      `started: ${s.startedAt ?? '-'}`,
      `finished: ${s.finishedAt ?? '-'}`,
      `aborted: ${s.aborted ?? 'no'}`,
      `next target: ${s.nextTarget ?? '-'}`,
    ].join('\n');
  }

  /** `/nep warmup reset`: clears warmup progress only (stored profiles/channel/guild data
   * untouched). Writes `state.json`, so refused while paused like the other warmup commands. */
  function cmdWarmupReset() {
    assertNotPaused();
    const result = warmup.reset();
    return result.ok ? 'Warmup progress reset (stored profiles/channel/guild data untouched).' : outcomeText(result, 'not done');
  }

  /** Wraps a `warmup.*` handler so both report the same thing when the dependency is absent. */
  function withWarmup(fn) {
    return (args, context) => {
      if (!warmup) return 'warmup is not available';
      return fn(args, context);
    };
  }

  return { formatWarmupPeople, cmdWarmupPeople, cmdWarmupRun, cmdWarmupStop, formatWarmupUserWritten, cmdWarmupUsers, formatWarmupChannelWritten, cmdWarmupChannels, formatWarmupServerWritten, cmdWarmupServer, cmdWarmupStatus, cmdWarmupReset, withWarmup };
});

defineOp({
  name: 'warmup.run',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(handlers(ctx.env).cmdWarmupRun)(args, ctx),
});
defineOp({
  name: 'warmup.users',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(handlers(ctx.env).cmdWarmupUsers)(args, ctx),
});
defineOp({
  name: 'warmup.channels',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(handlers(ctx.env).cmdWarmupChannels)(args, ctx),
});
defineOp({
  name: 'warmup.server',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(handlers(ctx.env).cmdWarmupServer)(args, ctx),
});
defineOp({
  name: 'warmup.people',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(handlers(ctx.env).cmdWarmupPeople)(args, ctx),
});
defineOp({
  name: 'warmup.status',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(handlers(ctx.env).cmdWarmupStatus)(args, ctx),
});
defineOp({
  name: 'warmup.stop',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(() => handlers(ctx.env).cmdWarmupStop())(args, ctx),
});
defineOp({
  name: 'warmup.reset',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).withWarmup(() => handlers(ctx.env).cmdWarmupReset())(args, ctx),
});
