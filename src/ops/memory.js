// Operations: `/nep memory` and `/nep private`: what the persona remembers -- one member's profile and private layer, the channel map, the server notes, the recent lines, the archive and the journal. Nothing here deletes stored memory.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import fs from 'node:fs';
import path from 'node:path';
import {
  emptyAffinity,
  affinityBand,
  roundScore,
  sortEpisodesForDisplay,
  channelActivity,
  ARCHIVE_KINDS,
  archiveEntry,
  journalLine,
  turnView,
  DEFAULT_VAULT_DIR,
  SNAPSHOTS_DIR,
} from '../memory/index.js';
import { JOURNAL_KINDS, MEMORY_SHOW_SECTIONS } from './catalog.js';
import { isOwnerId } from './grants.js';
import { effectiveAffinity, privateRepliesToday } from '../behavior/private.js';
import { log } from '../log.js';
import { clampAtBoundary } from '../memory/clamp.js';
import { DAY_MS, utcDay, zonedDay } from '../time.js';
import { formatClock } from '../format.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import {
  JOURNAL_N_DEFAULT,
  JOURNAL_N_MAX,
  JOURNAL_DAY_RE,
  treeSize,
  NONE,
  isoDay,
  todayUtc,
  onOff,
  MEMORY_SHOW_DEFAULT_LIMIT,
  MEMORY_SHOW_MAX_LIMIT,
  dateMs,
  buildProfileSummary,
  orderedSectionLines,
  rawMemoryShowView,
  interestLine,
  detailLine,
  episodeLine,
  aliasLine,
  affinityView,
  channelTopWritersText,
  channelTableLine,
  numberedNotes,
  archivedText,
  messageRefOf,
} from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';
import { CODE } from '../skills/codes.js';

const handlers = perEnv((env) => {
  const {
    hot,
    store,
    discord,
    archive,
    journal,
    dataDir,
    assertNotPaused,
    freshenIfPaused,
    requireGuildId,
    tokenResolver,
    requireProfile,
  } = env;

  /**
   * Sectioned, human-readable view of one member's profile — see
   * src/ops/catalog.js#MEMORY_SHOW_SECTIONS for the choices and the header
   * comments of `buildProfileSummary`/`orderedSectionLines`/
   * `rawMemoryShowView` for what each section does. `section` defaults to
   * `'summary'`; `order` to `'rank'`; `limit` to 25 (1..100) — anything else
   * given falls back to these defaults rather than throwing, since this is a
   * read-only command. Every section except `'raw'` resolves `<@id>` tokens
   * in free text via `fromTokens(..., 'analyzer')`, the same as the analyzer's
   * own input view.
   */
  function cmdMemoryShow(args, context) {
    freshenIfPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');

    const guildId = requireGuildId(context);
    const profile = requireProfile(guildId, userId);

    const memoryCfg = hot.config?.memory ?? {};
    const section = MEMORY_SHOW_SECTIONS.includes(args?.section) ? args.section : 'summary';
    const order = args?.order === 'recent' ? 'recent' : 'rank';
    const limit =
      Number.isInteger(args?.limit) && args.limit >= 1 && args.limit <= MEMORY_SHOW_MAX_LIMIT
        ? args.limit
        : MEMORY_SHOW_DEFAULT_LIMIT;
    const { nameOf, resolve } = tokenResolver(guildId);

    if (section === 'raw') return rawMemoryShowView(profile, memoryCfg);

    if (section === 'character') return resolve(profile.character) || '(empty)';
    if (section === 'style') return resolve(profile.style) || '(empty)';
    if (section === 'relationship') return resolve(profile.relationship) || '(empty)';

    if (section === 'affinity') return affinityView(profile.affinity, resolve);

    if (section === 'aliases') {
      const lines = orderedSectionLines(profile.aliases ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.aliasHalfLifeDays,
        maxShown: memoryCfg.maxAliases,
        formatLine: aliasLine,
        dateOf: (a) => dateMs(a.lastSeen ?? a.firstSeen),
      });
      return lines.length ? lines.join('\n') : NONE;
    }

    if (section === 'interests') {
      const lines = orderedSectionLines(profile.interests ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.interestHalfLifeDays,
        maxShown: memoryCfg.maxInterests,
        formatLine: (it) => interestLine(it, resolve),
        dateOf: (it) => dateMs(it.lastSeen ?? it.firstSeen),
      });
      return lines.length ? lines.join('\n') : NONE;
    }

    if (section === 'details') {
      const lines = orderedSectionLines(profile.details ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.detailHalfLifeDays,
        maxShown: memoryCfg.maxDetails,
        formatLine: (d) => detailLine(d, resolve),
        dateOf: (d) => dateMs(d.lastSeen ?? d.firstSeen),
      });
      return lines.length ? lines.join('\n') : NONE;
    }

    if (section === 'episodes') {
      const episodes = profile.episodes ?? [];
      if (!episodes.length) return NONE;
      const ordered =
        order === 'recent'
          ? [...episodes].sort((a, b) => dateMs(b.addedAt ?? b.date) - dateMs(a.addedAt ?? a.date))
          : sortEpisodesForDisplay(episodes);
      return ordered
        .slice(0, limit)
        .map((ep) => episodeLine(ep, resolve))
        .join('\n');
    }

    return buildProfileSummary(profile, memoryCfg, nameOf);
  }

  /** `hot.config.memory.mainChannelIds`, normalized to a string Set -- mirrors
   * src/memory/update.js#mainChannelSet. */
  function mainChannelIdSet() {
    return new Set((hot.config?.memory?.mainChannelIds ?? []).map(String));
  }

  /**
   * `/nep memory channel [channel]`: with a channel, that channel's full stored note (Discord
   * facts, the stored purpose/topics/tone, counters, activity verdict and top
   * writers); without one, a compact table of every stored channel, sorted by last message desc.
   * `<@id>` tokens in `purpose`/`topics`/`tone` are resolved the same way `memory.show` resolves
   * free-text fields (`fromTokens(..., 'analyzer')`).
   */
  function cmdMemoryChannel(args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const activityCfg = hot.config?.context?.channelActivity ?? {};
    const now = Date.now();
    const { nameOf, resolve } = tokenResolver(guildId);

    const channelId = args?.channelId;
    if (channelId) {
      const channel = store.getChannel(guildId, channelId);
      if (!channel) throw invalid(`no channel entry for ${channelId}`, CODE.NOT_FOUND);

      const activity = channelActivity(channel, now, activityCfg);
      const isMain = mainChannelIdSet().has(String(channelId));
      const writers = channelTopWritersText(channel.topWriters, nameOf);

      return [
        `name: ${channel.name || '-'}`,
        `category: ${channel.category || '-'}`,
        `topic: ${channel.topic || '-'}`,
        `main: ${onOff(isMain)}`,
        `purpose: ${resolve(channel.purpose) || '(empty)'}`,
        `topics: ${resolve(channel.topics) || '(empty)'}`,
        `tone: ${resolve(channel.tone) || '(empty)'}`,
        `messages: ${channel.messageCount ?? 0}`,
        `first message: ${isoDay(channel.firstMessageAt)}`,
        `last message: ${isoDay(channel.lastMessageAt)}`,
        `activity: ${activity}`,
        `top writers: ${writers || NONE}`,
        `updatedAt: ${channel.updatedAt ?? '-'}`,
      ].join('\n');
    }

    const channels = store.listChannels(guildId);
    if (channels.length === 0) return NONE;

    return [...channels]
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .map((channel) => channelTableLine(channel, channelActivity(channel, now, activityCfg)))
      .join('\n');
  }

  /**
   * `/nep memory server`: the stored guild-wide notes (`patterns`, `starters`, numbered
   * in-jokes and self facts -- src/memory/store.js#getGuild) plus counts of what else this guild has
   * stored (profiles, channel notes, lore entries) and when the guild notes were last updated.
   * `<@id>` tokens are resolved the same way `memory.show`/`memory.channel` resolve free text.
   */
  function cmdMemoryServer(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const guild = store.getGuild(guildId);
    const { resolve } = tokenResolver(guildId);

    return [
      `patterns: ${resolve(guild.patterns) || '(empty)'}`,
      `starters: ${resolve(guild.starters) || '(empty)'}`,
      `in-jokes:\n${numberedNotes(guild.injokes, resolve)}`,
      `self facts:\n${numberedNotes(guild.self, resolve)}`,
      `profiles stored: ${store.countUsers(guildId)}`,
      `channel notes stored: ${store.listChannels(guildId).length}`,
      `lore entries: ${store.getLore(guildId).length}`,
      `updatedAt: ${guild.updatedAt ?? '-'}`,
    ].join('\n');
  }

  /**
   * `/nep memory recent`: the guild's live recent lines (src/memory/recent.js#liveRecent over
   * `memory.recentHours`), newest moment first, one per line: date and time in `bot.timezone`, the
   * source channel (`#name` when a channel note stores one, else its id), the weight and the text
   * with `<@id>` tokens resolved like the other memory views. Expired lines are not shown. Read
   * only, so it works while paused (`freshenIfPaused`); the reply is chunked by
   * interfaces/discord/commands.js#respond like every long view.
   */
  function cmdMemoryRecent(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const settings = recentSettings(hot.config);
    if (!settings) return 'recent memory is off';

    const live = liveRecent(store.getRecent(guildId).lines, { now: Date.now(), hours: settings.hours });
    if (live.length === 0) return 'no live recent lines';

    const timezone = hot.config?.bot?.timezone || 'UTC';
    const { resolve } = tokenResolver(guildId);
    const channelText = (channelId) => {
      const name = store.getChannel(guildId, channelId)?.name;
      return name ? `#${name}` : String(channelId);
    };
    const lines = [...live]
      .sort((a, b) => b.at - a.at || (Number(b.id) || 0) - (Number(a.id) || 0))
      .map(
        (line) =>
          `${zonedDay(line.at, timezone)} ${formatClock(line.at, timezone)}  ${channelText(line.channelId)}  w${line.weight}  ${resolve(line.text)}`
      );
    return [`recent lines: ${live.length} live, window ${settings.hours} h`, ...lines].join('\n');
  }

  /**
   * `/nep memory archive [user] [kind] [n]`: the newest `n` (1..100, default 20) entries of the
   * guild's archive (src/memory/archive.js), newest first: with a member, those scoped to them;
   * without one, the server-level ones (no member scope). `kind` narrows to one item kind. The
   * private archives are never read here. One line each: the UTC day the item left, the event,
   * the kind, the item id and its text (tokens resolved, cut to 160 characters). Read only; the
   * archive is streamed and only the newest `n` are kept in memory.
   */
  async function cmdMemoryArchive(args, context) {
    const guildId = requireGuildId(context);
    if (!archive) return 'the archive is not available';
    const kind = args?.kind ?? null;
    if (kind !== null && !ARCHIVE_KINDS.includes(kind))
      throw invalid(`unknown kind; one of: ${ARCHIVE_KINDS.join(', ')}`);
    const n = Number.isInteger(args?.n) ? Math.min(100, Math.max(1, args.n)) : 20;
    const userId = args?.userId ? String(args.userId) : null;
    const newest = [];
    for await (const entry of archive.iterate(guildId, {
      scope: userId ? { user: userId } : null,
      kinds: kind ? [kind] : null,
    })) {
      if (!userId && typeof entry?.scope?.user === 'string') continue;
      newest.push(entry);
      if (newest.length > n) newest.shift();
    }
    if (newest.length === 0) return NONE;
    const { resolve } = tokenResolver(guildId);
    return newest
      .reverse()
      .map(
        (entry) =>
          `${String(entry.recordedAt ?? '').slice(0, 10)}  ${entry.event}  ${entry.itemKind}  ${entry.itemId}  ${clampAtBoundary(archivedText(entry, resolve), 160)}`
      )
      .join('\n');
  }

  /**
   * `/nep memory restore <itemId>`: the item's newest archived version back into its hot list
   * (store.restoreArchived: under its own id, not pinned), then a `restored` line in the archive
   * (by `owner`). Idempotent: an item already hot changes nothing and writes nothing. Refused
   * while paused.
   */
  async function cmdMemoryRestore(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const itemId = String(args?.itemId ?? '').trim();
    if (!itemId) throw invalid('an item id is required');
    if (!archive || typeof store.restoreArchived !== 'function') throw new Error('the archive is not available');
    const versions = (await archive.find(guildId, itemId)).filter((entry) => entry.event !== 'restored');
    if (versions.length === 0) throw invalid(`no archived item ${itemId}`, CODE.NOT_FOUND);
    const latest = versions.at(-1);
    const result = store.restoreArchived(guildId, latest);
    if (!result.restored) {
      if (result.reason === 'hot') return `${latest.itemKind} ${itemId} is already in memory; nothing changed`;
      if (result.reason === 'no-profile') throw new Error(`no stored memory to restore ${itemId} into`);
      throw new Error(`a ${latest.itemKind} cannot be restored`);
    }
    const item = typeof result.item === 'string' ? { itemId: latest.itemId, text: result.item } : result.item;
    const line = archiveEntry(item, {
      itemKind: latest.itemKind,
      event: 'restored',
      scope: latest.scope,
      by: 'owner',
      participants: latest.participants,
    });
    const privateUserId = latest.scope?.private === true ? latest.scope.user : null;
    try {
      await archive.append(guildId, [line], privateUserId ? { privateUserId } : {});
    } catch (error) {
      return `restored ${latest.itemKind} ${itemId}; the archive line failed (${error?.code ?? 'error'})`;
    }
    return `restored ${latest.itemKind} ${itemId}`;
  }

  /**
   * `/nep memory journal [day] [kind] [n] [message]`: the last `n` (1..50, default 20) journal records of
   * one UTC day (default today), of one kind or all, as short lines (src/memory/journal.js#journalLine).
   * With `message` (`messageId`: an id or a message link; the persona's call gives `#N`, resolved
   * to the id by src/skills/executors.js#resolveCall) the turn that posted that message instead,
   * whole (journal.findTurn over the message's snowflake time, shown by turnView), the other
   * options ignored; a message no turn of the guild journal posted is `not-found`.
   * Owner-only (src/ops/grants.js); read only, so it works while paused.
   */
  async function cmdMemoryJournal(args, context) {
    if (!journal) return 'the journal is not available';
    const guildId = requireGuildId(context);
    if (args?.messageId !== undefined && args?.messageId !== null && args?.messageId !== '') {
      const { messageId } = messageRefOf(args.messageId);
      if (!/^\d{1,20}$/.test(messageId)) throw invalid('a message id or link is required', CODE.UNKNOWN_MESSAGE);
      const at = discord.snowflakeTime(messageId);
      const found = typeof journal.findTurn === 'function' ? await journal.findTurn(guildId, { messageId, at }) : null;
      if (!found)
        throw invalid(
          `no turn of the persona posted message ${messageId} (searched ${utcDay(at)} and ${utcDay(at + DAY_MS)})`,
          CODE.NOT_FOUND
        );
      return turnView(found);
    }
    const day = args?.day ?? utcDay(Date.now());
    if (typeof day !== 'string' || !JOURNAL_DAY_RE.test(day)) throw invalid('day must be YYYY-MM-DD');
    const kind = args?.kind ?? 'all';
    if (!JOURNAL_KINDS.includes(kind)) throw invalid(`kind must be one of: ${JOURNAL_KINDS.join(', ')}`);
    const n = args?.n ?? JOURNAL_N_DEFAULT;
    if (!Number.isInteger(n) || n < 1 || n > JOURNAL_N_MAX) throw invalid(`n must be 1..${JOURNAL_N_MAX}`);

    const records = await journal.read(guildId, { day, kind: kind === 'all' ? null : kind, n });
    if (records.length === 0) return `no journal records on ${day}${kind === 'all' ? '' : ` (${kind})`}`;
    return [
      `journal ${day}${kind === 'all' ? '' : ` (${kind})`}: last ${records.length}`,
      ...records.map(journalLine),
    ].join('\n');
  }

  /**
   * `/nep memory snapshot`: a consistent copy of `data/` for the tools (tools/replay.mjs): the store flushed, then every entry of `data/` but `snapshots/` and the vault copied to
   * `data/snapshots/<UTC time>/` while the journal holds its writes (journal.withWriterLock).
   * Owner-only (src/ops/grants.js). Nothing under `data/` is changed but the new directory.
   */
  async function cmdMemorySnapshot() {
    if (!dataDir) return 'the memory snapshot is not available';
    store.flush();
    const root = path.join(dataDir, SNAPSHOTS_DIR);
    const dest = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
    // The vault (memory.vaultDir, read now) is the owner's copy of what was forgotten: never copied.
    const vaultTop = path
      .relative(dataDir, path.resolve(dataDir, hot.config?.memory?.vaultDir ?? DEFAULT_VAULT_DIR))
      .split(path.sep)[0];
    const copy = async () => {
      await fs.promises.mkdir(dest, { recursive: true });
      for (const name of await fs.promises.readdir(dataDir)) {
        if (name === SNAPSHOTS_DIR || name === vaultTop) continue;
        await fs.promises.cp(path.join(dataDir, name), path.join(dest, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      return treeSize(dest);
    };
    const { bytes, files } =
      typeof journal?.withWriterLock === 'function' ? await journal.withWriterLock(copy) : await copy();
    log.info('admin: memory snapshot', { files, bytes });
    return `Snapshot written: ${dest} (${files} files, ${bytes} bytes).`;
  }

  /**
   * `/nep private show`: one member's private layer, with the same line
   * formats as `memory show`'s sections, under the public profile's current
   * name (the user id when there is none). Adds the private and the effective
   * attitude (src/behavior/private.js#effectiveAffinity -- what the persona
   * feels in the DM), today's DM reply count against the member's cap (the
   * numbers the gate decides on, src/behavior/private.js#privateRepliesToday). No "shown cap"
   * divider: in a DM the private items are ranked together with the public
   * ones. No private layer -> a plain answer, not an error.
   */
  function cmdPrivateShow(args, context) {
    freshenIfPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    const publicProfile = store.getUser(guildId, userId);
    const name = publicProfile?.names?.[0];
    const label = name ? `${name} (id:${userId})` : String(userId);

    const priv = store.getPrivate(guildId, userId);
    if (!priv) return `No private memory for this member: ${label}.`;

    const memoryCfg = hot.config?.memory ?? {};
    const { resolve } = tokenResolver(guildId);

    const privateAffinity = priv.affinity ?? emptyAffinity();
    const effective = effectiveAffinity(publicProfile?.affinity, privateAffinity);
    const privateReason = resolve(privateAffinity.reason);

    const replies = privateRepliesToday({
      config: hot.config,
      isOwner: isOwnerId(hot.config, userId),
      replies: priv.replies,
      today: todayUtc(),
    });

    const section = (title, items, lines) => [
      `${title} (${items.length} stored):`,
      ...lines.map((line) => `  ${line}`),
    ];
    const interests = priv.interests ?? [];
    const details = priv.details ?? [];
    const episodes = priv.episodes ?? [];

    return [
      `private memory: ${label}`,
      `private affinity: ${roundScore(privateAffinity.score ?? 0)} (${affinityBand(privateAffinity.score ?? 0)})${privateReason ? ` — ${privateReason}` : ''}`,
      `effective affinity: ${roundScore(effective.score)} (${affinityBand(effective.score)})`,
      `replies today: ${replies.used} / ${replies.cap}`,
      `first seen: ${priv.firstSeen ? priv.firstSeen.slice(0, 10) : '-'} · last seen: ${priv.lastSeen ? priv.lastSeen.slice(0, 10) : '-'}`,
      `relationship: ${resolve(priv.relationship) || '(empty)'}`,
      ...section(
        'interests',
        interests,
        orderedSectionLines(interests, {
          order: 'rank',
          limit: MEMORY_SHOW_DEFAULT_LIMIT,
          halfLifeDays: memoryCfg.interestHalfLifeDays,
          formatLine: (it) => interestLine(it, resolve),
          dateOf: (it) => dateMs(it.lastSeen ?? it.firstSeen),
        })
      ),
      ...section(
        'details',
        details,
        orderedSectionLines(details, {
          order: 'rank',
          limit: MEMORY_SHOW_DEFAULT_LIMIT,
          halfLifeDays: memoryCfg.detailHalfLifeDays,
          formatLine: (d) => detailLine(d, resolve),
          dateOf: (d) => dateMs(d.lastSeen ?? d.firstSeen),
        })
      ),
      ...section(
        'episodes',
        episodes,
        sortEpisodesForDisplay(episodes)
          .slice(0, MEMORY_SHOW_DEFAULT_LIMIT)
          .map((ep) => episodeLine(ep, resolve))
      ),
    ].join('\n');
  }

  /** `/nep memory affinity`: the attitude view (`affinityView`) of a member who has a profile.
   * Read only: the attitude changes only through the memory analyzer, for nobody by hand. */
  function cmdMemoryAffinity(args, context) {
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);
    freshenIfPaused();
    const profile = requireProfile(guildId, userId);
    return affinityView(profile.affinity, tokenResolver(guildId).resolve);
  }

  return {
    cmdMemoryShow,
    mainChannelIdSet,
    cmdMemoryChannel,
    cmdMemoryServer,
    cmdMemoryRecent,
    cmdMemoryArchive,
    cmdMemoryRestore,
    cmdMemoryJournal,
    cmdMemorySnapshot,
    cmdPrivateShow,
    cmdMemoryAffinity,
  };
});

defineOp({
  name: 'memory.profile.read',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryShow(args, ctx),
});
defineOp({
  name: 'memory.channel.read',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryChannel(args, ctx),
});
defineOp({
  name: 'memory.server.read',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryServer(args, ctx),
});
defineOp({
  name: 'memory.recent.read',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryRecent(args, ctx),
});
defineOp({
  name: 'memory.affinity.read',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryAffinity({ userId: args?.userId }, ctx),
});
defineOp({
  name: 'memory.journal.read',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryJournal(args, ctx),
});
defineOp({
  name: 'memory.archive.read',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryArchive(args, ctx),
});
defineOp({
  name: 'memory.restore',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryRestore(args, ctx),
});
defineOp({
  name: 'memory.snapshot',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemorySnapshot(),
});
defineOp({
  name: 'memory.private.read',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdPrivateShow(args, ctx),
});
