// Owner commands, driven by Discord slash commands (src/discord/commands.js)
// so the owner can tune the running bot from Discord without a restart and
// without ever touching data/: live rules (prompts.local/rules.md, seeded
// from prompts/rules.md), config overrides (config.local.json, hot-reloaded),
// status, a manual interject/initiate of the spontaneous scheduler, and
// profile inspection/deletion, plus one member command, `/nep pings` (cmdPings: a
// member's own notification switch, open to everyone while
// `features.memberCommands` is on). This is the ONLY place in the project that ever
// deletes stored memory, through the three functions store.js allows for it:
// store.forgetUser (one member everywhere, the vault copy first), store.forgetPrivate
// (one member's private layer only, `/nep memory private action:forget` and
// `action:purge`) and
// store.wipeGuild (a whole guild's memory,
// `/nep memory wipe`, gated by the served guild's exact name); src/index.js only finishes at start
// a forget a crash cut short and re-applies the deletion ledger. The tracked
// prompts/ layer is never written at runtime — live corrections always land
// in the untracked prompts.local/ layer.
//
// This module knows nothing about discord.js: `createAdmin(deps).runCommand`
// takes a `commandKey` (e.g. `'memory.forget'`), a plain `args` object and a
// `context` (`{ guildId, channelId, userId, roleIds }`), checks the caller's
// rights on the operation the key runs and answers `{ status, code, summary,
// data }`; `run` (the tests' entry, no rights check) returns the reply text
// (or, for `/nep draw` and `/nep mentor show`, `{ text, files }` with the
// picture or the report file; for `/nep status`, `{ text, embeds }` with the
// card), or throws an
// `Error` with an operator-facing message on bad input. Mapping a
// discord.js interaction's options onto `args` is src/discord/commands.js's
// job. The handlers themselves are typed operations under src/ops/ (one file
// per area): `run` maps the command key onto its operation
// (src/ops/index.js#COMMAND_TO_OP), runs it and renders the result; only the
// mentor and the commands the new tree drops (`ping`, `reload`,
// `learned list`) still run here. The pure functions (listRules, appendRule,
// removeRule, setPath, unsetPath, buildProfileSummary) live in
// src/ops/shared.js and are re-exported from here.

import { sortByRank } from './memory/ranking.js';
import { isAllowed as accessIsAllowed, isOwnerId } from './discord/access.js';
import { familyOf as imageFamilyOf, IMAGE_ROLE } from './llm/images.js';
import { resolveProvider } from './llm/openrouter.js';
import { anchorMax, checkCaseText } from './mentor/cases.js';
import { renderCard, renderFile, renderLastRun } from './mentor/report.js';
import { NONE, onOff, PING_DISPLAY_ORDER, pingRolesFor, modelForRole, formatPingSuccess, formatPingFailure, formatYoutubeLine, withYoutubeLine, withImageLine, MENTOR_CASE_TEXT_SHOWN, MENTOR_STATES, learnedLine } from './ops/shared.js';
import { createOpsEnv } from './ops/env.js';
import { resolveCommand, runOp, runOpPrechecked, legacyGrantOps, asResult } from './ops/index.js';
import { getOp, listOps } from './ops/registry.js';
import { grantKeys, migrateStoredGrants } from './ops/access.js';

export { listRules, appendRule, removeRule, setPath, unsetPath, buildProfileSummary } from './ops/shared.js';

/** How many archive entries `/nep memory restore`'s autocomplete offers (Discord's cap on choices). */
const ARCHIVE_CHOICES = 25;

/**
 * `hot`, `store` — see src/hot.js, src/memory/store.js.
 * `client` — a discord.js Client (used for channels.fetch, guilds.cache, and users.fetch +
 *   createDM for `/nep private purge`).
 * `spontaneous` — the spontaneous scheduler: `force(channel, mode)` and `status()`.
 * `calibrator` — token calibrator (src/llm/tokens.js), read for `.ratio`.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * `isWarmingUp` — `() => boolean`, optional: true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight. Read by `cmdMemoryWipe`, `cmdMemoryRefresh`,
 *   `/nep warmup run` and `cmdStatus`. Default: never warming up.
 * `turns` — from createTurnRunner() (src/behavior/turn.js), optional: `waitIdle()`, used by
 *   `/nep pause` to wait out a turn already in flight. Absent -> the wait is simply skipped.
 * `memory` — from createMemoryUpdater() (src/memory/update.js), optional: `waitIdle()`, used by
 *   `/nep pause` to wait out a live-analyzer `run()` or a voice run (`runVoice`, the two-stage
 *   analyzer's stage B) already in flight (an LLM call can take 30-90s; a voice answer that
 *   arrives once paused writes nothing) before the pause flushes and drops the store's caches, and by `/nep memory forget`,
 *   `/nep private forget` and `/nep memory wipe` before they delete (the run would re-create what
 *   they removed). Absent -> the wait is skipped.
 * `pending` — `{ clear() }`, optional: clears src/discord/events.js's pending-ping queue on pause.
 *   Absent -> nothing to clear.
 * `llm` — from createLlm() (src/llm/openrouter.js), optional: `complete()`, used by `/nep ping`
 *   to reach each role's model directly, and `modelEndpoints()`, its free check of the drawing
 *   model. Absent -> `/nep ping` reports it is not available.
 * `warmup` — from createWarmup() (src/memory/warmup.js), optional: the sample-based
 *   memory warmup -- `peopleReport` (read-only), `run`/`runPerson`/`runChannel`/`runServer`/
 *   `runUsers`/`runChannels`/`status`/`reset` (write under data/), `refreshPortrait`, `waitIdle`
 *   (awaited by `/nep pause`, same shape as `memory`/`turns`; it also covers portrait refreshes
 *   in flight). Absent -> every `warmup.*`/
 *   `memory.refresh` command reports it is not available.
 * `describer` — from createDescriber() (src/memory/describe.js), optional: `checkYoutube()`, used by
 *   `/nep ping` (video role) to add a line saying which YouTube duration source works on this host.
 *   Absent -> no such line.
 * `lookup` — from createLookup() (src/web/lookup.js), optional: `hasSearch()`, used by `/nep ping`
 *   (classifier.text role) to add a line saying whether the web lookup is on and has a search key.
 *   Absent -> no such line.
 * `images` — from createImageGen() (src/llm/images.js), optional: `generate()` for `/nep draw`,
 *   `quota()` and `familyOf()` for the image lines of `/nep status` and `/nep model show`.
 *   Absent -> `/nep draw` reports it is not available and `/nep status` has no image lines.
 * `imageFetcher` — from createImageFetcher() (src/discord/fetch-image.js), optional: downloads the
 *   bot's avatar as the reference of a `/nep draw self` picture. Absent -> no reference is sent.
 * `emojiBackfill` — from createEmojiBackfill() (src/memory/emoji-backfill.js), optional: `run` (with
 *   `force`, awaited by `/nep emoji rescan`) and `isRunning` (a note in `/nep emoji status`).
 *   Absent -> `/nep emoji rescan` reports it is not available; `/nep emoji status` still works.
 * `gifBackfill` — from createGifBackfill() (src/memory/gif-backfill.js), optional: `run` (with
 *   `force`, awaited by `/nep gifs rescan`) and `isRunning` (a note in `/nep gifs status`).
 *   Absent -> `/nep gifs rescan` reports it is not available; `/nep gifs status` still works.
 * `gifRecache` — from createGifRecache() (src/memory/gif-recache.js), optional: `start` (started by
 *   `/nep gifs recache`, never awaited to the end), `isRunning` (a note in `/nep gifs status`) and
 *   `waitIdle` (`/nep pause` waits for a run in flight). Absent -> `/nep gifs recache` reports it is
 *   not available.
 * `mentor` — from createMentor() (src/mentor/mentor.js), optional: `run`/`check` (started by
 *   `/nep mentor run|check`, never awaited to the end), `readAnchor` (reads the moment of a
 *   message for `/nep mentor add|anchor`), `stop`, `status`; `isRunning` and
 *   `waitIdle` let `/nep pause` stop a run in flight and wait for it. Absent -> every `mentor.*`
 *   command reports it is not available.
 * `mentorCases` — from createCaseStore() (src/mentor/cases.js), optional: the cases, their runs and
 *   the owner's feedback. Absent -> every `mentor.*` command reports it is not available.
 * `mentorBudget` — from createMentorBudget() (src/mentor/budget.js), optional: `snapshot()` for the
 *   token line of `/nep mentor status`. Absent -> that line shows `-`.
 * `diary` — from createDiary() (src/behavior/diary.js), optional: `force({ kind })` (`/nep diary post`)
 *   and `status()` (`/nep diary show`, the plan in the `set` reply). Absent -> `show` prints the
 *   channel and the history size only, and `post` reports the diary is not running.
 * `archive` — from createArchive() (src/memory/archive.js), optional: `iterate` (`/nep memory
 *   archive`), `find` and `append` (`/nep memory restore`, with the store's `restoreArchived`).
 *   Absent -> both report the archive is not available.
 * `journal` — from createJournal() (src/memory/journal.js), optional: `system` records of pause,
 *   resume, forget and wipe (written while `features.journal` is exactly true), `read` for
 *   `/nep memory journal`, handed to store.forgetUser for `/nep memory forget` and `removeGuild`
 *   for `/nep memory wipe` (run whatever the switch says: what was journalled goes with the
 *   member). Absent -> no records, and `/nep memory journal` reports it is not available.
 *   `withWriterLock` holds the journal's, the record's and the archive's writes while `/nep memory
 *   snapshot` copies `data/` and while a forget or a wipe runs; absent, they run without it.
 * `dataDir` — the `data/` directory `/nep memory snapshot` copies (default: `<hot.rootDir>/data`).
 *
 * `run(commandKey, args, context)` throws a plain `Error` (operator-facing
 * message) on bad input; `runCommand` never throws; neither touches discord.js.
 */
export function createAdmin(deps) {
  const env = createOpsEnv(deps);
  const { hot, store, llm, describer, lookup, images, mentor, mentorCases, mentorBudget, slash, assertNotPaused, freshenIfPaused, resolvedGuildId, requireGuildId, tokenResolver } = env;

  /** The operation descriptor a command key runs with `args` (src/ops/index.js#COMMAND_TO_OP);
   * a command with no operation (`legacy` below, or an unknown key) is owner-only. */
  function opForCommand(commandKey, args = {}) {
    const target = resolveCommand(commandKey, args);
    return (target?.op && getOp(target.op)) ?? { name: commandKey, rights: { kind: 'write', ownerOnly: true } };
  }

  /** The operation name `commandKey` runs with `args`, or null (a command with no operation, or
   * arguments that pick none): src/discord/commands.js defers and shows replies by operation. */
  function operationFor(commandKey, args = {}) {
    return resolveCommand(commandKey, args)?.op ?? null;
  }

  /** Whether the caller may run `commandKey` (with `args`, which pick the operation for
   * `pings` and `memory.affinity`): src/discord/access.js#isAllowed on its operation, every input
   * read now. For the autocomplete, which runs nothing; a command itself goes through
   * `runCommand`. `roleIds` -- the caller's Discord role ids -- comes from
   * src/discord/commands.js#createInteractionHandler, which reads them off the interaction. */
  function isAllowed(commandKey, { userId, roleIds } = {}, args = {}) {
    return accessIsAllowed({
      op: opForCommand(commandKey, args),
      member: { userId, roleIds },
      owners: hot.config?.bot?.owners ?? [],
      access: hot.config?.bot?.access ?? {},
      features: hot.config?.features,
    });
  }

  /** `/nep access grant`'s autocomplete keys: `*`, the groups and the grantable operations. */
  function accessKeys() {
    return grantKeys(listOps());
  }

  function cmdReload() {
    const configOk = hot.reloadConfig();
    const promptsOk = hot.reloadPrompts();
    return `config reload: ${configOk ? 'ok' : 'FAILED'}\nprompts reload: ${promptsOk ? 'ok' : 'FAILED'}`;
  }

  /** Start the YouTube check when the classifier.video role is pinged and a describer is wired; never rejects. */
  function startPingYoutube(requested) {
    if (!requested.includes('classifier.video') || typeof describer?.checkYoutube !== 'function') return null;
    return Promise.resolve()
      .then(() => describer.checkYoutube())
      .then(formatYoutubeLine, () => 'youtube: API key — unknown');
  }

  /**
   * `lines` with the web lookup line appended when the classifier.text role (the
   * page and search condensers' model) is pinged and a lookup is wired: whether
   * the lookup is on (features.webLookup, a missing key counts as OFF) and a
   * search key is configured. No network call; never the key itself.
   */
  function withWebLine(lines, requested) {
    if (!requested.includes('classifier.text') || typeof lookup?.hasSearch !== 'function') return lines;
    let line;
    if (hot.config?.features?.webLookup !== true) line = 'web: API key — off';
    else line = lookup.hasSearch() ? 'web: API key — ok' : 'web: API key — missing';
    return [...lines, line];
  }

  /** The image line before the drawing switch note: one free GET of the provider's public
   * listing through the llm client, or none at all when no model is set or its family is
   * refused. Never rejects; never generates, never counts against a cap, never writes state. */
  async function checkImageListing(cfg) {
    const model = cfg?.image?.model;
    if (!model) return `${IMAGE_ROLE}: (no model configured)`;
    if (!(images?.familyOf ?? imageFamilyOf)(model)) return `${IMAGE_ROLE}: ${model} — unsupported family`;
    if (typeof llm?.modelEndpoints !== 'function') return `${IMAGE_ROLE}: ${model} — not checked (the llm client has no listing)`;

    const start = Date.now();
    let listing;
    try {
      listing = await llm.modelEndpoints(model, { timeoutMs: cfg?.llm?.pingTimeoutMs ?? 30000 });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
      return `${IMAGE_ROLE}: ${model} — failed: ${reason}`;
    }
    if (listing.status === 404) return `${IMAGE_ROLE}: ${model} — not listed (HTTP 404)`;
    if (!listing.ok) return `${IMAGE_ROLE}: ${model} — failed: HTTP ${listing.status}`;

    const modalities = listing.json?.data?.architecture?.output_modalities;
    if (!Array.isArray(modalities) || !modalities.includes('image')) {
      return `${IMAGE_ROLE}: ${model} — listed, but no image output`;
    }
    const endpoints = Array.isArray(listing.json.data.endpoints) ? listing.json.data.endpoints.length : 0;
    return `${IMAGE_ROLE}: ${model} — listed, image output, ${endpoints} endpoint(s), ${Date.now() - start} ms`;
  }

  /** Start the image check when the image role is requested; never rejects. The line notes when
   * drawing is switched off (features.imageGeneration false; a missing key counts as on). */
  function startPingImage(requested, cfg) {
    if (!requested.includes(IMAGE_ROLE)) return null;
    const off = cfg?.features?.imageGeneration === false;
    return checkImageListing(cfg).then((line) => (off ? `${line} (features.imageGeneration is off)` : line));
  }

  async function cmdPing(args) {
    if (!llm) return 'ping is not available (no llm client configured)';

    const requested = pingRolesFor(args?.role);
    const modelRoles = PING_DISPLAY_ORDER.filter((role) => requested.includes(role));
    const cfg = hot.config;
    const roleModel = new Map(modelRoles.map((role) => [role, modelForRole(role, cfg)]));

    const youtube = startPingYoutube(modelRoles);
    const image = startPingImage(requested, cfg);

    // The model lines come first (the image line among them), the API checks after.
    const assemble = async (lines) => withWebLine(withYoutubeLine(withImageLine(lines, await image), await youtube), modelRoles);

    // One request per distinct (model, route): roles sharing a model share a ping unless a
    // role-specific `llm.providerByModel` key routes one of them elsewhere. Each request is
    // sent as the first role that needs it, so it goes out exactly as that role's would.
    const targetOf = (role) => {
      const model = roleModel.get(role);
      const route = resolveProvider(model, { byModel: cfg?.llm?.providerByModel, fallback: cfg?.llm?.provider, role });
      return `${model}\n${JSON.stringify(route ?? null)}`;
    };

    const promptText = hot.prompts?.labels?.ping?.prompt;
    if (!promptText) {
      const skipped = modelRoles.map((role) => `${role}: ${roleModel.get(role) ?? '(no model configured)'} — skipped: label missing`);
      return (await assemble(skipped)).join('\n');
    }

    const targets = new Map();
    for (const role of modelRoles) {
      const model = roleModel.get(role);
      if (model && !targets.has(targetOf(role))) targets.set(targetOf(role), { model, role });
    }
    const results = new Map();

    await Promise.all(
      [...targets].map(async ([target, { model, role }]) => {
        const start = Date.now();
        try {
          const result = await llm.complete([{ role: 'user', content: promptText }], {
            model,
            role,
            maxOutputTokens: 16,
            countAgainstDailyCap: false,
            skipCalibration: true,
            timeoutMs: cfg?.llm?.pingTimeoutMs ?? 30000,
          });
          results.set(target, { ok: true, ms: Date.now() - start, result });
        } catch (err) {
          results.set(target, { ok: false, ms: Date.now() - start, err });
        }
      }),
    );

    const lines = modelRoles.map((role) => {
      const model = roleModel.get(role);
      if (!model) return `${role}: (no model configured)`;
      const outcome = results.get(targetOf(role));
      return outcome.ok
        ? formatPingSuccess(role, model, outcome.result, outcome.ms)
        : formatPingFailure(role, model, outcome.err, outcome.ms);
    });
    return (await assemble(lines)).join('\n');
  }

  /** `/nep learned list`: every stored item, rank order (`memory.learnedHalfLifeDays`). */
  function cmdLearnedList(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const learned = store.getGuild(guildId).learned ?? [];
    if (learned.length === 0) return NONE;
    const { resolve } = tokenResolver(guildId);
    return sortByRank(learned, hot.config?.memory?.learnedHalfLifeDays)
      .map((item) => learnedLine(item, resolve))
      .join('\n');
  }

  /** The `id` option as a positive integer, or an Error. */
  function mentorCaseId(args) {
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id < 1) throw new Error('a case id is required');
    return id;
  }

  /** The case `id` of `guildId`, or an Error `no case <id>`. */
  function requireCase(guildId, id) {
    const item = mentorCases.get(guildId, id);
    if (!item) throw new Error(`no case ${id}`);
    return item;
  }

  /** The `message` option: a message link or id, or an Error. */
  function mentorMessageRef(args) {
    const ref = typeof args?.message === 'string' ? args.message.trim() : '';
    if (!ref) throw new Error('a message link or id is required');
    return ref;
  }

  /** `moment <id>: <n> messages up to the trigger, an answer of <m> messages`. */
  function momentLine(anchor) {
    return `moment ${anchor.id}: ${anchor.history.length} messages up to the trigger, an answer of ${anchor.original.length} messages`;
  }

  /** A case is a message of the persona plus the owner's comment: both are required, the target is
   * always `reply`. The comment is checked before the message is read; reading it spends no tokens. */
  async function cmdMentorAdd(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const ref = mentorMessageRef(args);
    const text = checkCaseText(args?.text);
    const anchor = await mentor.readAnchor(ref, { channelId: context?.channelId ?? null });
    const item = mentorCases.add(guildId, { text, target: 'reply', anchor });
    return `case ${item.id} added (${item.target}), ${momentLine(item.anchors[0])}`;
  }

  /** Adds another moment to a case, at most `mentor.anchor.max` (read now); a case that cannot take
   * one more is refused before the message is read. */
  async function cmdMentorAnchor(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    const ref = mentorMessageRef(args);
    const item = requireCase(guildId, id);
    const max = anchorMax(hot.config.mentor?.anchor?.max);
    const held = Array.isArray(item.anchors) ? item.anchors.length : 0;
    if (held >= max) throw new Error(`case ${id} has ${held} moments; at most ${max} (mentor.anchor.max)`);
    const anchor = await mentor.readAnchor(ref, { channelId: context?.channelId ?? null });
    const { item: updated, anchor: added } = mentorCases.addAnchor(guildId, id, anchor, { max });
    return `case ${id}: ${momentLine(added)} (${updated.anchors.length} of ${max})`;
  }

  /** One line per active case: `<id> [<state>] <target> <score or -> <text clipped to 80>`, with
   * `moments <n>` before the text for a case that has any. */
  function cmdMentorCases(_args, context) {
    const list = mentorCases.list(requireGuildId(context));
    if (list.length === 0) return NONE;
    return list
      .map((item) => {
        const score = typeof item.lastScore === 'number' && Number.isFinite(item.lastScore) ? String(item.lastScore) : '-';
        const text = String(item.text ?? '').replace(/\s+/g, ' ');
        const shown = text.length > MENTOR_CASE_TEXT_SHOWN ? `${text.slice(0, MENTOR_CASE_TEXT_SHOWN - 3)}...` : text;
        const moments = Array.isArray(item.anchors) && item.anchors.length > 0 ? `moments ${item.anchors.length} ` : '';
        return `${item.id} [${item.state}] ${item.target} ${score} ${moments}${shown}`;
      })
      .join('\n');
  }

  function cmdMentorRemove(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    const item = mentorCases.retire(guildId, id);
    return `case ${item.id} retired`;
  }

  /** Starts the run and answers at once: the run ends far beyond an interaction's lifetime. With an
   * admin channel (`bot.dryRunChannelId`, read now) the mentor posts its report there; without one
   * the reply points at `status` and `show`. An unknown case is refused here, like `show` and
   * `anchor`; a guard of the mentor rejects here too. */
  async function cmdMentorRun(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    await mentor.run(id);
    if (hot.config.bot?.dryRunChannelId) return `run started for case ${id}; the report will come to the admin channel`;
    return `run started for case ${id}; follow it with ${slash('mentor status')}, read the report with ${slash(`mentor show ${id}`)}`;
  }

  /** Starts a check of every case with a run; answers at once, like `run`, and the same way
   * points at `status` and `show` when there is no admin channel. */
  async function cmdMentorCheck() {
    assertNotPaused();
    const { cases } = await mentor.check();
    if (hot.config.bot?.dryRunChannelId) return `check started for ${cases} cases`;
    return `check started for ${cases} cases; follow it with ${slash('mentor status')}, read each report with ${slash('mentor show <id>')}`;
  }

  /** Aborts the run in flight; reads no `data/` itself, so not guarded by assertNotPaused(). */
  function cmdMentorStop() {
    return mentor.stop().ok ? 'stopping' : 'nothing is running';
  }

  /** The case's last run (a `check` run the same way): the card, with the full report attached. */
  function cmdMentorShow(args, context) {
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    const lastRun = mentorCases.lastRun(guildId, id);
    if (!lastRun) throw new Error(`case ${id} has no run yet`);
    const file = renderFile(lastRun);
    return { text: renderCard(lastRun), files: [{ attachment: Buffer.from(file.text, 'utf8'), name: file.name }] };
  }

  /** The owner says the mentor judged a case wrongly; the case store refuses a case without a run. */
  function cmdMentorWrong(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    mentorCases.addFeedback(guildId, { caseId: id, reason: args?.reason });
    return `noted for case ${id}`;
  }

  /** The `last:` line: the newest `finishedAt` among the last runs of every case, retired ones
   * included. A run file or case list that cannot be read gives `last: cannot be read`, never a throw. */
  function mentorLastLine(guildId) {
    let latest = null;
    let latestMs = -Infinity;
    try {
      for (const item of mentorCases.list(guildId, { includeRetired: true })) {
        const lastRun = mentorCases.lastRun(guildId, item.id);
        if (!lastRun) continue;
        const ms = Date.parse(lastRun.finishedAt ?? '');
        const rank = Number.isFinite(ms) ? ms : -Infinity;
        if (!latest || rank > latestMs) {
          latest = lastRun;
          latestMs = rank;
        }
      }
    } catch {
      return 'last: cannot be read';
    }
    return renderLastRun(latest);
  }

  /** Works with the mentor off or without a model -- it is how the owner sees why nothing runs.
   * The last line is always the most recent finished run (`last:`). */
  function cmdMentorStatus(_args, context) {
    const lines = [
      `enabled: ${onOff(hot.config.features?.mentor === true)}`,
      `model: ${hot.config.mentor?.model || '-'}`,
    ];
    if (mentorBudget) {
      const { used, cap, left } = mentorBudget.snapshot();
      lines.push(`tokens today: ${used} / ${cap} (${left} left)`);
    } else {
      lines.push('tokens today: -');
    }
    const guildId = resolvedGuildId(context);
    if (guildId) {
      const counts = Object.fromEntries(MENTOR_STATES.map((state) => [state, 0]));
      for (const item of mentorCases.list(guildId, { includeRetired: true })) {
        if (Object.hasOwn(counts, item.state)) counts[item.state] += 1;
      }
      lines.push(`cases: ${MENTOR_STATES.map((state) => `${counts[state]} ${state}`).join(', ')}`);
    } else {
      lines.push('cases: -');
    }
    const s = mentor.status();
    lines.push(s?.running ? `running: ${s.kind} case ${s.caseId}, ${s.phase}, ${s.tokens} tokens so far${s.stopping ? ', stopping' : ''}` : 'running: no');
    lines.push(guildId ? mentorLastLine(guildId) : 'last: -');
    return lines.join('\n');
  }

  /** Wraps a `mentor.*` handler so all of them report the same thing when a dependency is absent. */
  function withMentor(fn) {
    return (args, context) => {
      if (!mentor || !mentorCases) return 'the mentor is not available';
      return fn(args, context);
    };
  }

  /** The commands that are not operations yet: the mentor (removed in a later step) and the
   * commands the new tree drops. Everything else runs through src/ops/ (COMMAND_TO_OP). */
  const legacy = {
    ping: (args) => cmdPing(args),
    reload: () => cmdReload(),
    'learned.list': (args, context) => cmdLearnedList(args, context),
    'mentor.add': withMentor((args, context) => cmdMentorAdd(args, context)),
    'mentor.anchor': withMentor((args, context) => cmdMentorAnchor(args, context)),
    'mentor.cases': withMentor((args, context) => cmdMentorCases(args, context)),
    'mentor.remove': withMentor((args, context) => cmdMentorRemove(args, context)),
    'mentor.run': withMentor((args, context) => cmdMentorRun(args, context)),
    'mentor.check': withMentor(() => cmdMentorCheck()),
    'mentor.stop': withMentor(() => cmdMentorStop()),
    'mentor.show': withMentor((args, context) => cmdMentorShow(args, context)),
    'mentor.wrong': withMentor((args, context) => cmdMentorWrong(args, context)),
    'mentor.status': withMentor((args, context) => cmdMentorStatus(args, context)),
  };

  /** An operation's result as the reply the command adapter expects: `ok` -> its text (or
   * `{ text, files }`, or `{ text, embeds }` for `status`); anything else -> the operator-facing
   * Error the handler used to throw. */
  function render(result) {
    if (result.status === 'ok') return result.data?.files || result.data?.embeds ? result.data : result.summary;
    throw Object.assign(new Error(result.summary), { code: result.code, status: result.status });
  }

  /**
   * Run one command WITHOUT a rights check and render it: the reply text (or `{ text, files }`),
   * or a thrown operator-facing `Error`. `commandKey` is `'<name>'` for a top-level command or
   * `'<group>.<name>'` for a grouped one. The tests drive the handlers through it; the slash
   * commands use `runCommand`, which checks the rights.
   */
  async function run(commandKey, args = {}, context = {}) {
    if (Object.hasOwn(legacy, commandKey)) return legacy[commandKey](args, context);
    const target = resolveCommand(commandKey, args);
    if (!target) throw new Error(`unknown command: ${commandKey}`);
    if (target.invalid) throw Object.assign(new Error(target.invalid), { code: 'invalid-args', status: 'invalid' });
    return render(await runOpPrechecked(target.op, target.args, { ...context, env }));
  }

  /**
   * One slash command for a caller (`context`: `{ guildId, channelId, userId, roleIds }`): the
   * command key mapped to its operation (src/ops/index.js#COMMAND_TO_OP) and run through
   * src/ops/index.js#runOp, the full rights check included; a command with no operation
   * (`legacy`) runs for an owner only. Never throws: `{ status, code, summary, data }`.
   * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
   */
  async function runCommand(commandKey, args = {}, context = {}) {
    if (Object.hasOwn(legacy, commandKey)) {
      if (!isOwnerId(hot.config, context.userId)) return { status: 'denied', code: 'owner-only', summary: `${commandKey} is owner-only`, data: null };
      try {
        return asResult(await legacy[commandKey](args, context));
      } catch (err) {
        return { status: 'failed', code: typeof err?.code === 'string' && err.code ? err.code : 'error', summary: String(err?.message ?? err), data: null };
      }
    }
    const target = resolveCommand(commandKey, args);
    if (!target) return { status: 'invalid', code: 'unknown-command', summary: `unknown command: ${commandKey}`, data: null };
    if (target.invalid) return { status: 'invalid', code: 'invalid-args', summary: target.invalid, data: null };
    return runOp(target.op, target.args, { ...context, env });
  }

  /** Once per guild at start: the stored grants re-expanded under the operation names
   * (src/ops/access.js#migrateStoredGrants). */
  function migrateAccess(guildId) {
    return migrateStoredGrants(env, guildId, legacyGrantOps);
  }

  /**
   * `/nep memory restore`'s autocomplete: the item ids of the newest ARCHIVE_CHOICES entries of
   * the guild's archive (a restore line left out) whose id holds `typed`, newest first, each once,
   * as `{ name, value }` choices. Empty without an archive or a guild; never throws.
   */
  async function archiveChoices(context, typed = '') {
    const guildId = resolvedGuildId(context);
    if (!guildId || typeof env.archive?.iterate !== 'function') return [];
    const needle = String(typed ?? '').toLowerCase();
    const newest = [];
    try {
      for await (const entry of env.archive.iterate(guildId, { scope: null, kinds: null })) {
        if (typeof entry?.itemId !== 'string' || !entry.itemId || entry.event === 'restored') continue;
        if (needle && !entry.itemId.toLowerCase().includes(needle)) continue;
        newest.push(entry);
        if (newest.length > ARCHIVE_CHOICES) newest.shift();
      }
    } catch {
      return [];
    }
    const seen = new Set();
    const choices = [];
    for (const entry of newest.reverse()) {
      if (seen.has(entry.itemId)) continue;
      seen.add(entry.itemId);
      choices.push({ name: `${entry.itemId} (${entry.itemKind ?? '?'})`.slice(0, 100), value: entry.itemId.slice(0, 100) });
    }
    return choices;
  }

  return { isAllowed, operationFor, accessKeys, archiveChoices, run, runCommand, migrateAccess };
}
