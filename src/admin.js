// Owner commands, driven by Discord slash commands (src/discord/commands.js)
// so the owner can tune the running bot from Discord without a restart and
// without ever touching data/: live rules (prompts.local/rules.md, seeded
// from prompts/rules.md), config overrides (config.local.json, hot-reloaded),
// status, a turn of the persona asked for now (`/nep message create`), and
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
// (or, for `/nep draw`, `{ text, files }` with the picture; for `/nep status`,
// `{ text, embeds }` with the card), or throws an
// `Error` with an operator-facing message on bad input. Mapping a
// discord.js interaction's options onto `args` is src/discord/commands.js's
// job. The handlers themselves are typed operations under src/ops/ (one file
// per area): `run` maps the command key onto its operation
// (src/ops/index.js#COMMAND_TO_OP), runs it and renders the result. The pure
// functions (listRules, appendRule, removeRule, setPath, unsetPath,
// buildProfileSummary) live in src/ops/shared.js and are re-exported from here.

import { isAllowed as accessIsAllowed } from './discord/access.js';
import { createOpsEnv } from './ops/env.js';
import { resolveCommand, runOp, runOpPrechecked, legacyGrantOps } from './ops/index.js';
import { getOp, listOps } from './ops/registry.js';
import { grantKeys, migrateStoredGrants } from './ops/access.js';
import { skillNames } from './skills/registry.js';
import { SELF_OWNED_OPS } from './ops/effects.js';

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
 *   (src/memory/warmup.js) is in flight. Read by `cmdMemoryWipe`, the `memory.refresh.*`
 *   handlers and `cmdStatus`. Default: never warming up.
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
 * `warmup` — from createWarmup() (src/memory/warmup.js), optional: the sample-based
 *   memory warmup's engine -- `refreshPortrait` (`/nep memory refresh kind:user`),
 *   `refreshChannelNotes` and `refreshServerNotes` (`kind:channel`, `kind:server`: a fresh
 *   sample, the live rails), `summary` (`/nep status detail`) and
 *   `waitIdle` (awaited by `/nep pause`, same shape as `memory`/`turns`; it also covers portrait
 *   refreshes in flight). A warmup run itself is tools/warmup.mjs's, with the bot stopped.
 *   Absent -> every `memory.refresh.*` command reports it is not available.
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
 * `llm` — from createLlm() (src/llm/openrouter.js), optional: `complete()`, the probe the owner's
 *   `/nep status` card sends to each role's model, and `modelEndpoints()`, its free check of the
 *   drawing model. Absent -> the card names the models without probing them.
 * `embedder` — from createEmbedder() (src/llm/embed.js), optional: `embed()`, the one-input
 *   embedding request the owner's `/nep status` card probes the `embedding` role with.
 *   Absent -> that role is shown unchecked.
 * `embedQueue` — from src/memory/embedder.js#createEmbedder, optional: `catchUp(guildId)`, the
 *   meaning index's catch-up pass `/nep resume` starts (never awaited), and `indexSummary(guildId)`,
 *   the owner card's index line. Absent -> no pass on resume and no index line.
 * `record` — from createRecord() (src/memory/record.js), optional: `dayFile`, where the owner's
 *   `/nep status` card finds the record's month indexes for its memory coverage. Absent -> the
 *   record line says it is not available.
 * `metrics` — from src/ops/metrics.js#createMetrics, optional: `summary`, the owner card's speed
 *   field, and the turns of the last hour its storage line weighs. Absent -> no speed figures.
 * `port` — the persona's interface (src/interface/port.js), optional: what `/nep message
 *   send|edit|delete|react` and `/nep draw channel:` post through, as the persona. Absent -> those
 *   report they are not available.
 * `now` — the clock of the status card's coverage cache (default `Date.now`).
 * `dataDir` — the `data/` directory `/nep memory snapshot` copies (default: `<hot.rootDir>/data`).
 *
 * `run(commandKey, args, context)` throws a plain `Error` (operator-facing
 * message) on bad input; `runCommand` never throws; neither touches discord.js.
 */
export function createAdmin(deps) {
  const env = createOpsEnv(deps);
  const { hot, resolvedGuildId } = env;

  /** The operation descriptor a command key runs with `args` (src/ops/index.js#COMMAND_TO_OP);
   * a command with no operation (an unknown key) is owner-only. */
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

  /** `/nep access grant`'s autocomplete keys: `*`, the groups and the grantable operations, then
   * the persona's other skill names (src/skills/registry.js), granted to her with her as the user. */
  function accessKeys() {
    return [...new Set([...grantKeys(listOps()), ...skillNames()])];
  }

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
    const target = resolveCommand(commandKey, args);
    if (!target) throw new Error(`unknown command: ${commandKey}`);
    if (target.invalid) throw Object.assign(new Error(target.invalid), { code: 'invalid-args', status: 'invalid' });
    return render(await runOpPrechecked(target.op, target.args, { ...context, env }));
  }

  /**
   * One slash command for a caller (`context`: `{ guildId, channelId, userId, roleIds }`): the
   * command key mapped to its operation (src/ops/index.js#COMMAND_TO_OP) and run through
   * src/ops/index.js#runOp, the full rights check included; a key with no operation is
   * `invalid`. Never throws: `{ status, code, summary, data }`.
   * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
   */
  async function runCommand(commandKey, args = {}, context = {}) {
    const target = resolveCommand(commandKey, args);
    if (!target) return { status: 'invalid', code: 'unknown-command', summary: `unknown command: ${commandKey}`, data: null };
    if (target.invalid) return { status: 'invalid', code: 'invalid-args', summary: target.invalid, data: null };
    return runOp(target.op, target.args, { ...context, env });
  }

  /**
   * One of the persona's own expressive operations (src/ops/effects.js#SELF_OWNED_OPS) run for
   * her through its command, WITHOUT the requester's rights check: her grant, checked by the skill
   * gateway, alone decides (src/skills/executors.js). Any other operation is refused
   * (`not-self-owned`): it goes through `runCommand`. Never throws.
   * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
   */
  async function runOwnCommand(commandKey, args = {}, context = {}) {
    const target = resolveCommand(commandKey, args);
    if (!target) return { status: 'invalid', code: 'unknown-command', summary: `unknown command: ${commandKey}`, data: null };
    if (target.invalid) return { status: 'invalid', code: 'invalid-args', summary: target.invalid, data: null };
    if (!SELF_OWNED_OPS.includes(target.op)) return { status: 'denied', code: 'not-self-owned', summary: `${target.op} is not the persona's own`, data: null };
    return runOpPrechecked(target.op, target.args, { ...context, env });
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

  return { isAllowed, operationFor, accessKeys, archiveChoices, run, runCommand, runOwnCommand, migrateAccess };
}
