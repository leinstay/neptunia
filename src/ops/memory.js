// Operations: `/nep memory` and `/nep private`: what the persona remembers -- one member's profile and private layer, the channel map, the server notes, the recent lines, the archive and the journal -- and the only deletes of stored memory (store.forgetUser, store.forgetPrivate, store.wipeGuild).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import fs from 'node:fs';
import path from 'node:path';
import { emptyAffinity, affinityBand, roundScore } from '../memory/affinity.js';
import { sortEpisodesForDisplay } from '../memory/episodes.js';
import { channelActivity } from '../memory/channels.js';
import { JOURNAL_KINDS, MEMORY_SHOW_SECTIONS } from '../discord/commands.js';
import { isOwnerId } from '../discord/access.js';
import { effectiveAffinity, privateRepliesToday } from '../behavior/private.js';
import { PAGE } from '../discord/collect.js';
import { log } from '../log.js';
import { clampAtBoundary } from '../memory/clamp.js';
import { ARCHIVE_KINDS, archiveEntry } from '../memory/archive.js';
import { utcDay, zonedDay } from '../time.js';
import { formatClock } from '../discord/format.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import { journalLine } from '../memory/journal.js';
import { DEFAULT_REDACTION, DEFAULT_VAULT_DIR, SNAPSHOTS_DIR } from '../memory/store.js';
import { JOURNAL_N_DEFAULT, JOURNAL_N_MAX, JOURNAL_DAY_RE, treeSize, NONE, isoDay, todayUtc, onOff, MEMORY_SHOW_DEFAULT_LIMIT, MEMORY_SHOW_MAX_LIMIT, dateMs, buildProfileSummary, orderedSectionLines, rawMemoryShowView, interestLine, detailLine, episodeLine, aliasLine, affinityView, oldestMessageId, outcomeText, channelTopWritersText, channelTableLine, numberedNotes, archivedText, channelWrittenText, serverWrittenText } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, store, client, isWarmingUp, warmup, archive, journal, dataDir, slash, warmupBusyText, assertNotPaused, freshenIfPaused, requireGuildId, tokenResolver, journalSystem, waitForAnalyzer, requireProfile } = env;

  /**
   * Sectioned, human-readable view of one member's profile — see
   * src/discord/commands.js#MEMORY_SHOW_SECTIONS for the choices and the header
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
   * src/memory/update.js#mainChannelSet and src/memory/warmup.js's own copies. */
  function mainChannelIdSet() {
    return new Set((hot.config?.memory?.mainChannelIds ?? []).map(String));
  }

  /**
   * `/nep memory channel [channel]`: with a channel, that channel's full stored note (Discord
   * facts, the analyzer/warmup-written purpose/topics/tone, counters, activity verdict and top
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
      if (!channel) throw invalid(`no channel entry for ${channelId}`, 'not-found');

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
   * src/discord/commands.js#respond like every long view.
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
      .map((line) => `${zonedDay(line.at, timezone)} ${formatClock(line.at, timezone)}  ${channelText(line.channelId)}  w${line.weight}  ${resolve(line.text)}`);
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
    if (kind !== null && !ARCHIVE_KINDS.includes(kind)) throw invalid(`unknown kind; one of: ${ARCHIVE_KINDS.join(', ')}`);
    const n = Number.isInteger(args?.n) ? Math.min(100, Math.max(1, args.n)) : 20;
    const userId = args?.userId ? String(args.userId) : null;
    const newest = [];
    for await (const entry of archive.iterate(guildId, { scope: userId ? { user: userId } : null, kinds: kind ? [kind] : null })) {
      if (!userId && typeof entry?.scope?.user === 'string') continue;
      newest.push(entry);
      if (newest.length > n) newest.shift();
    }
    if (newest.length === 0) return NONE;
    const { resolve } = tokenResolver(guildId);
    return newest
      .reverse()
      .map((entry) => `${String(entry.recordedAt ?? '').slice(0, 10)}  ${entry.event}  ${entry.itemKind}  ${entry.itemId}  ${clampAtBoundary(archivedText(entry, resolve), 160)}`)
      .join('\n');
  }

  /**
   * `/nep memory restore <itemId>`: the item's newest archived version back into its hot list
   * (store.restoreArchived: under its own id, not pinned), then a `restored` line in the archive
   * (by `owner`). Idempotent: an item already hot changes nothing and writes nothing. Waits for
   * a running analyzer batch first; refused while paused.
   */
  async function cmdMemoryRestore(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const itemId = String(args?.itemId ?? '').trim();
    if (!itemId) throw invalid('an item id is required');
    if (!archive || typeof store.restoreArchived !== 'function') throw new Error('the archive is not available');
    await waitForAnalyzer();
    const versions = (await archive.find(guildId, itemId)).filter((entry) => entry.event !== 'restored');
    if (versions.length === 0) throw invalid(`no archived item ${itemId}`, 'not-found');
    const latest = versions.at(-1);
    const result = store.restoreArchived(guildId, latest);
    if (!result.restored) {
      if (result.reason === 'hot') return `${latest.itemKind} ${itemId} is already in memory; nothing changed`;
      if (result.reason === 'no-profile') throw new Error(`no stored memory to restore ${itemId} into`);
      throw new Error(`a ${latest.itemKind} cannot be restored`);
    }
    const item = typeof result.item === 'string' ? { itemId: latest.itemId, text: result.item } : result.item;
    const line = archiveEntry(item, { itemKind: latest.itemKind, event: 'restored', scope: latest.scope, by: 'owner', participants: latest.participants });
    const privateUserId = latest.scope?.private === true ? latest.scope.user : null;
    try {
      await archive.append(guildId, [line], privateUserId ? { privateUserId } : {});
    } catch (error) {
      return `restored ${latest.itemKind} ${itemId}; the archive line failed (${error?.code ?? 'error'})`;
    }
    return `restored ${latest.itemKind} ${itemId}`;
  }

  /** `/nep memory forget`: one member everywhere (store.forgetUser: the vault copy first, then the
   * profile and private layer, the voice items, versions, archive, record and journal lines, the
   * diary redacted, request dumps, snapshots; the ledger last), once a live-analyzer run in flight
   * has landed, under the journal's writer lock. The reply names the vault and the counts per
   * store. A job cut short keeps its marker and finishes at the next start. Refused while paused. */
  async function cmdMemoryForget(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    await waitForAnalyzer();
    let result;
    try {
      result = await store.forgetUser(guildId, userId, {
        journal: journal ?? null,
        vaultDir: hot.config?.memory?.vaultDir ?? DEFAULT_VAULT_DIR,
        redaction: hot.prompts?.labels?.memory?.redaction ?? DEFAULT_REDACTION,
      });
    } catch (err) {
      log.warn('admin: forget unfinished', { code: err?.code ?? null, guildId });
      return `The forget of ${userId} is not finished (see the log): it finishes at the next start, and until then the member is hidden. Vault: ${err?.vault ?? '-'}`;
    }
    await journalSystem(guildId, { event: 'forget', by: 'owner', participants: [String(userId)] });
    const n = (key) => result?.counts?.[key] ?? 0;
    return [
      `Forgot ${userId} (public profile and private memory).`,
      `Vault: ${result?.vault ?? '-'}`,
      `profile: ${n('profile')}, private memory: ${n('private')}, voice items: ${n('voice')}, recent lines: ${n('recent')}, ` +
        `participation messages: ${n('participation')}, version files: ${n('versions')}`,
      `archive entries: ${n('archive')}, record lines: ${n('record')}, journal records: ${n('journal')}, request dumps: ${n('requests')}, ` +
        `snapshots: ${n('snapshots')}, diary posts redacted: ${n('diary')}, backfill candidates: ${n('backfill')}`,
    ].join('\n');
  }

  /**
   * `/nep memory journal [day] [kind] [n]`: the last `n` (1..50, default 20) journal records of
   * one UTC day (default today), of one kind or all, as short lines (src/memory/journal.js#journalLine).
   * Owner-only (src/discord/access.js); read only, so it works while paused.
   */
  async function cmdMemoryJournal(args, context) {
    if (!journal) return 'the journal is not available';
    const guildId = requireGuildId(context);
    const day = args?.day ?? utcDay(Date.now());
    if (typeof day !== 'string' || !JOURNAL_DAY_RE.test(day)) throw invalid('day must be YYYY-MM-DD');
    const kind = args?.kind ?? 'all';
    if (!JOURNAL_KINDS.includes(kind)) throw invalid(`kind must be one of: ${JOURNAL_KINDS.join(', ')}`);
    const n = args?.n ?? JOURNAL_N_DEFAULT;
    if (!Number.isInteger(n) || n < 1 || n > JOURNAL_N_MAX) throw invalid(`n must be 1..${JOURNAL_N_MAX}`);

    const records = await journal.read(guildId, { day, kind: kind === 'all' ? null : kind, n });
    if (records.length === 0) return `no journal records on ${day}${kind === 'all' ? '' : ` (${kind})`}`;
    return [`journal ${day}${kind === 'all' ? '' : ` (${kind})`}: last ${records.length}`, ...records.map(journalLine)].join('\n');
  }

  /**
   * `/nep memory snapshot`: a consistent copy of `data/` for the tools (tools/memory-sim.mjs,
   * tools/replay.mjs): the store flushed, then every entry of `data/` but `snapshots/` and the vault copied to
   * `data/snapshots/<UTC time>/` while the journal holds its writes (journal.withWriterLock).
   * Owner-only (src/discord/access.js). Nothing under `data/` is changed but the new directory.
   */
  async function cmdMemorySnapshot() {
    if (!dataDir) return 'the memory snapshot is not available';
    store.flush();
    const root = path.join(dataDir, SNAPSHOTS_DIR);
    const dest = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
    // The vault (memory.vaultDir, read now) is the owner's copy of what was forgotten: never copied.
    const vaultTop = path.relative(dataDir, path.resolve(dataDir, hot.config?.memory?.vaultDir ?? DEFAULT_VAULT_DIR)).split(path.sep)[0];
    const copy = async () => {
      await fs.promises.mkdir(dest, { recursive: true });
      for (const name of await fs.promises.readdir(dataDir)) {
        if (name === SNAPSHOTS_DIR || name === vaultTop) continue;
        await fs.promises.cp(path.join(dataDir, name), path.join(dest, name), { recursive: true, errorOnExist: true, force: false });
      }
      return treeSize(dest);
    };
    const { bytes, files } = typeof journal?.withWriterLock === 'function' ? await journal.withWriterLock(copy) : await copy();
    log.info('admin: memory snapshot', { files, bytes });
    return `Snapshot written: ${dest} (${files} files, ${bytes} bytes).`;
  }

  /**
   * `/nep private show`: one member's private layer, with the same line
   * formats as `memory show`'s sections, under the public profile's current
   * name (the user id when there is none). Adds the private and the effective
   * attitude (src/behavior/private.js#effectiveAffinity -- what the persona
   * feels in the DM), today's DM reply count against the member's cap (the
   * numbers the gate decides on, src/behavior/private.js#privateRepliesToday) and the
   * buffer SIZE -- never the buffered messages themselves. No "shown cap"
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
    const bufferSize = Array.isArray(priv.buffer) ? priv.buffer.length : 0;

    const section = (title, items, lines) => [`${title} (${items.length} stored):`, ...lines.map((line) => `  ${line}`)];
    const interests = priv.interests ?? [];
    const details = priv.details ?? [];
    const episodes = priv.episodes ?? [];

    return [
      `private memory: ${label}`,
      `private affinity: ${roundScore(privateAffinity.score ?? 0)} (${affinityBand(privateAffinity.score ?? 0)})${privateReason ? ` — ${privateReason}` : ''}`,
      `effective affinity: ${roundScore(effective.score)} (${affinityBand(effective.score)})`,
      `replies today: ${replies.used} / ${replies.cap}`,
      `buffer: ${bufferSize} messages`,
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
        }),
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
        }),
      ),
      ...section(
        'episodes',
        episodes,
        sortEpisodesForDisplay(episodes)
          .slice(0, MEMORY_SHOW_DEFAULT_LIMIT)
          .map((ep) => episodeLine(ep, resolve)),
      ),
    ].join('\n');
  }

  /** `/nep private forget`: deletes one member's private layer only (store.forgetPrivate), once a
   * live-analyzer run in flight has landed; the public profile stays. Refused while paused, like
   * `memory forget`. */
  async function cmdPrivateForget(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    await waitForAnalyzer();
    store.forgetPrivate(guildId, userId);
    return `Forgot the private memory of ${userId}; the public profile is kept.`;
  }

  /**
   * `/nep private purge`: deletes the bot's own messages in the direct-message chat with one
   * member, then that member's private layer (store.forgetPrivate). Pages back through the DM
   * `PAGE` (100) at a time until a short page or `private.purgeMaxMessages` scanned messages (default
   * 5000), deleting sequentially; a failed delete is counted, never thrown. The member's own
   * messages cannot be deleted by a bot and stay. A user that cannot be fetched or a DM that
   * cannot be opened, or a first history page that cannot be read, throws before anything is
   * deleted; a later page fetch that fails stops the scan and the purge finishes with what it
   * had. Refused while paused; a pause that lands mid-run keeps the private layer.
   */
  async function cmdPrivatePurge(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    const selfId = client?.user?.id;
    if (!selfId) throw new Error('the bot is not logged in yet');

    let dm;
    try {
      const user = await client.users.fetch(userId);
      dm = await user.createDM();
    } catch (err) {
      log.warn('admin: private purge could not open the dm', { error: err });
      throw new Error(`cannot open the private chat with ${userId}; nothing was deleted`);
    }

    const configured = hot.config?.private?.purgeMaxMessages;
    const maxScanned = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 5000;

    let scanned = 0;
    let deleted = 0;
    let failed = 0;
    let before;
    while (scanned < maxScanned) {
      let page;
      try {
        page = await dm.messages.fetch(before ? { limit: PAGE, before } : { limit: PAGE });
      } catch (err) {
        log.warn('admin: private purge page fetch failed', { scanned, error: err });
        if (!before) throw new Error(`cannot read the private chat with ${userId}; nothing was deleted`);
        break;
      }
      const batch = [...page.values()];
      if (batch.length === 0) break;

      for (const message of batch) {
        if (scanned >= maxScanned) break;
        scanned += 1;
        if (message.author?.id !== selfId) continue;
        try {
          await message.delete();
          deleted += 1;
        } catch {
          failed += 1;
        }
      }

      before = oldestMessageId(batch);
      if (batch.length < PAGE) break;
    }

    // A `/nep pause` that landed during a long purge: data/ must not be written any more.
    const pausedMidway = Boolean(store.state.data.paused);
    if (!pausedMidway) store.forgetPrivate(guildId, userId);
    log.info('admin: private purged', { deleted, failed, scanned });
    const capped = scanned >= maxScanned ? `; stopped at the ${maxScanned}-message scan cap, run again for older ones` : '';
    const memoryPart = pausedMidway ? `private memory kept (paused meanwhile, run again after ${slash('resume')})` : 'private memory removed';
    return [
      `Purged ${deleted} own messages in the private chat (${failed} failed, ${scanned} scanned${capped}); ${memoryPart}.`,
      "The member's own messages stay; only they can delete those.",
    ].join('\n');
  }

  /**
   * A deliberate, owner-only clean start: wipes this guild's whole stored
   * memory (store.wipeGuild) once a live-analyzer run in flight has landed, under the journal's
   * writer lock: the guild directory is copied into the vault first (store.vaultGuild) and the reply
   * names it.
   * Runs only when `confirm` matches the served guild's name exactly
   * (trimmed, case-sensitive) — otherwise nothing changes and the reply says
   * what it deletes and what to type.
   */
  async function cmdMemoryWipe(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    if (isWarmingUp()) throw Object.assign(new Error(warmupBusyText()), { code: 'warmup-running' });

    const guildName = client?.guilds?.cache?.get(guildId)?.name || guildId;
    const confirm = String(args?.confirm ?? '').trim();
    if (confirm !== guildName) {
      return (
        'This deletes everything remembered about this server: every member profile and private memory, the server habits, ' +
        'the learned list, the emoji ranking, the voice queue, the recent lines, the channel map, analyzer lore, the record, the archive, the backfill files, the journal, the request dumps, the deletion ledger, this server in every snapshot and the warmup progress; a copy of it all goes to the vault first. ' +
        `To confirm, run again with confirm: ${guildName}`
      );
    }

    await waitForAnalyzer();
    if (isWarmingUp()) throw Object.assign(new Error(warmupBusyText()), { code: 'warmup-running' });
    const vaultDir = hot.config?.memory?.vaultDir ?? DEFAULT_VAULT_DIR;
    const wipe = async () => {
      // The vault first, then the journal (its files are closed before the store deletes the
      // private directories), then the rest.
      const vault = store.vaultGuild(guildId, { vaultDir });
      let journalLines = ['journal: kept (no journal is running)'];
      if (journal) {
        try {
          const removed = await journal.removeGuild(guildId);
          journalLines = [`journal files removed: ${removed?.files ?? 0}`];
        } catch (err) {
          log.warn('admin: journal wipe failed', { code: err?.code ?? null, guildId });
          journalLines = ['journal: not removed (a disk error, see the log)'];
        }
      }
      return { counts: store.wipeGuild(guildId, { vault, vaultDir }), journalLines, vault };
    };
    const { counts, journalLines, vault } = typeof journal?.withWriterLock === 'function' ? await journal.withWriterLock(wipe) : await wipe();
    log.info('admin: memory wiped', { users: counts.users, channels: counts.channels, loreRemoved: counts.loreRemoved, snapshots: counts.snapshots ?? 0 });
    await journalSystem(guildId, { event: 'wipe', by: 'owner' });

    return [
      `Memory wiped for ${guildName}.`,
      `Vault: ${counts.vault ?? vault}`,
      `profiles removed: ${counts.users ?? 0}`,
      `private memory removed: ${counts.privateLayers ?? 0} private layers, with every private directory`,
      `record files removed: ${counts.recordFiles ?? 0}`,
      `archive files removed: ${counts.archiveFiles ?? 0}`,
      `backfill files removed: ${counts.backfillFiles ?? 0}`,
      ...journalLines,
      `snapshots that lost this server: ${counts.snapshots ?? 0}`,
      `channels removed: ${counts.channels}`,
      `lore removed: ${counts.loreRemoved} (kept: ${counts.loreKept})`,
      `buffer messages cleared: ${counts.bufferMessages}`,
      'Also removed: the server habits, the learned list, the emoji ranking, the voice queue, the recent lines, the participation store, the recall trace, the profile versions, the deletion ledger and the warmup progress.',
      'Kept: owner lore, the GIF library, the media description cache, token calibration, the daily request counts and the spontaneous schedule.',
    ].join('\n');
  }

  /** `/nep memory affinity`: without a score, the attitude view (`affinityView`); with one, sets
   * it exactly for a member who has a profile (refused while paused). The owner's `reason` is
   * stored as given; none given stores `labels.affinity.ownerSet` (read at the moment of use), or an
   * empty one when that label is missing (src/memory/affinity.js#applyDelta then keeps the previous
   * reason). */
  function cmdMemoryAffinity(args, context) {
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    const score = args?.score;
    if (score === undefined || score === null) {
      freshenIfPaused();
      const profile = requireProfile(guildId, userId);
      return affinityView(profile.affinity, tokenResolver(guildId).resolve);
    }

    assertNotPaused();
    if (!Number.isInteger(score) || score < -100 || score > 100) {
      throw invalid('score must be an integer between -100 and 100');
    }

    const profile = requireProfile(guildId, userId);
    // No reason given: the stored reason says the owner set it (`labels.affinity.ownerSet`, read now).
    const reason = String(args?.reason ?? '').trim() || (hot.prompts.labels?.affinity?.ownerSet ?? '');
    const current = profile.affinity?.score ?? 0;
    const relCfg = hot.config?.relationships ?? {};
    const affinity = store.adjustAffinity(guildId, userId, score - current, reason, {
      maxDelta: Infinity, // the owner's explicit override bypasses maxDeltaPerUpdate
      historySize: relCfg.historySize ?? 10,
      now: Date.now(),
      damping: false, // an absolute set is never damped
      truncate: false, // `current` may carry two decimals (a damped score); land on `score` exactly
    });
    return `Set affinity for ${userId} to ${roundScore(affinity.score)} (${affinityBand(affinity.score)}).`;
  }

  /** `/nep memory refresh kind:user user:<member>`: forces a portrait refresh (character/style
   * only), ignoring the hours rail, not the daily request cap. No hint is sent with it: the profile
   * prompt then has no `<hint>` block. Refused while paused or while a warmup runs. */
  async function cmdMemoryRefreshUser(args, context) {
    if (!warmup) return 'warmup is not available';
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);
    if (isWarmingUp()) return `Refresh not performed: ${warmupBusyText()}`;

    const result = await warmup.refreshPortrait(guildId, userId, '', { force: true });
    if (!result.ok) {
      const why = result.reason === 'warming-up' ? warmupBusyText() : outcomeText(result, 'unknown reason');
      return `Refresh not performed: ${why}`;
    }
    if (result.characterQueued) {
      return `Portrait refreshed for ${userId}; its character text lands after the next voice run.`;
    }
    return `Portrait refreshed for ${userId}.`;
  }

  /** `/nep memory refresh kind:channel channel:<channel>`: re-describes that channel's notes now
   * (purpose/topics/tone and its facts) through the warmup's own channel pass
   * (src/memory/warmup.js#runChannel, the one tools/warmup.mjs `channels --channel` runs), under the
   * warmup's rails. Refused while paused or while a warmup runs. */
  async function cmdMemoryRefreshChannel(args, context) {
    if (!warmup) return 'warmup is not available';
    assertNotPaused();
    const channelId = args?.channelId;
    if (!channelId) throw invalid('a channel is required');
    const guildId = requireGuildId(context);
    if (isWarmingUp()) return `Refresh not performed: ${warmupBusyText()}`;

    const result = await warmup.runChannel(guildId, channelId);
    return channelWrittenText(result.ok ? result.outcome : result, tokenResolver(guildId).nameOf);
  }

  /** `/nep memory refresh kind:server`: rebuilds the server notes and lore now through the warmup's
   * own server pass (src/memory/warmup.js#runServer, the one tools/warmup.mjs `server` runs), under
   * the warmup's rails. Refused while paused or while a warmup runs. */
  async function cmdMemoryRefreshServer(_args, context) {
    if (!warmup) return 'warmup is not available';
    assertNotPaused();
    const guildId = requireGuildId(context);
    if (isWarmingUp()) return `Refresh not performed: ${warmupBusyText()}`;

    const result = await warmup.runServer(guildId);
    return serverWrittenText(result.ok ? result.outcome : result);
  }

  return { cmdMemoryShow, mainChannelIdSet, cmdMemoryChannel, cmdMemoryServer, cmdMemoryRecent, cmdMemoryArchive, cmdMemoryRestore, cmdMemoryForget, cmdMemoryJournal, cmdMemorySnapshot, cmdPrivateShow, cmdPrivateForget, cmdPrivatePurge, cmdMemoryWipe, cmdMemoryAffinity, cmdMemoryRefreshUser, cmdMemoryRefreshChannel, cmdMemoryRefreshServer };
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
  name: 'memory.refresh.user',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryRefreshUser(args, ctx),
});
defineOp({
  name: 'memory.refresh.channel',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryRefreshChannel(args, ctx),
});
defineOp({
  name: 'memory.refresh.server',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryRefreshServer(args, ctx),
});
defineOp({
  name: 'memory.forget',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryForget(args, ctx),
});
defineOp({
  name: 'memory.affinity.read',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryAffinity({ userId: args?.userId }, ctx),
});
defineOp({
  name: 'memory.affinity.set',
  rights: { kind: 'write' },
  run: (args, ctx) => {
    // A set always carries a score: without one it would fall back to the read view.
    if (args?.score === undefined || args?.score === null) throw invalid('score must be an integer between -100 and 100');
    return handlers(ctx.env).cmdMemoryAffinity(args, ctx);
  },
});
defineOp({
  name: 'memory.wipe',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemoryWipe(args, ctx),
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
defineOp({
  name: 'memory.private.forget',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdPrivateForget(args, ctx),
});
defineOp({
  name: 'memory.private.purge',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdPrivatePurge(args, ctx),
});
