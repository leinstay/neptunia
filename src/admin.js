// The owner's operations as one object the core builds once (src/core.js): live rules
// (prompts.local/rules.md, seeded from prompts/rules.md), config overrides (config.local/config.json,
// hot-reloaded), status, a turn of the persona asked for now (`message.create`) and profile
// inspection. No operation deletes stored memory. The tracked prompts/ layer is never written at
// runtime: live corrections always land in the untracked prompts.local/ layer.
//
// `createAdmin(deps)` runs the typed operations under src/tools/impl/ (one file per area) by their
// names: `runSkillOp` with the requester's full rights check (the owner's console and her tool calls
// for a person), `runOwnSkillOp` and `runInitiativeSkillOp` for her own calls, whose grant the skill
// gateway checks. `run(op, args, context)` is the tests' entry: no rights check, and the result
// rendered as the reply text, as `{ text, files }` with a picture or as `{ text, fields }` with the
// status card, or a thrown `Error` with an operator-facing message on bad input. The pure functions
// (listRules, appendRule, removeRule, setPath, unsetPath, buildProfileSummary) live in
// src/tools/impl/shared.ts and are re-exported from here.

import { createOpsEnv } from './tools/impl/env.ts';
import { runOp, runOpPrechecked } from './tools/impl/index.ts';
import { migrateStoredGrants } from './tools/impl/access.ts';
import { listOps } from './tools/impl/registry.ts';
import { legacyGrantOps } from './config-moves.ts';
import { listAliases } from './tools/impl/alias.ts';
import { listLessons } from './tools/impl/learning.ts';
import { SELF_OWNED_OPS } from './tools/impl/effects.ts';
import { CODE } from './tools/codes.ts';

export { listRules, appendRule, removeRule, setPath, unsetPath, buildProfileSummary } from './tools/impl/shared.ts';

/**
 * `hot`, `store` — see src/hot.js, src/memory/store.js.
 * `selfId` — the persona's own member id (null before the interface has said it), `getSelfName` — the name she goes
 *   by in a community, `memberNameOf` — a member's name in the member directory, `directory` — the
 *   conversations the interface reported (`isPrivate`), `connection` — `{ lastReconnectAt }`, filled from
 *   `connection.changed`. The operations read them as `env.selfId()` and the like.
 * `reads` — the core's reads of the interface (src/interface/reads.ts): the permission checks of an operation
 *   posting in another conversation (src/tools/impl/shared.ts#postingConversation), a message's event for a turn asked on
 *   a message (src/tools/impl/message.ts). The operations read it as `env.reads`.
 * `spontaneous` — the spontaneous scheduler: `force(conversation, mode)` and `status()`, the conversation as a
 *   reference `{ iface, conversationId }`.
 * `calibrator` — token calibrator (src/llm/tokens.js), read for `.ratio`.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * `turns` — from createTurnRunner() (src/behavior/turn.js), optional: `waitIdle()`, used by
 *   `bot.pause` to wait out a turn already in flight. Absent -> the wait is simply skipped.
 * `pending` — `{ clear() }`, optional: clears src/behavior/pipeline.js's pending-ping queue on pause.
 *   Absent -> nothing to clear.
 * `images` — from createImageGen() (src/llm/images.js), optional: `generate()` for `draw.create`,
 *   `quota()` and `familyOf()` for the image lines of `status.show` and `model.show`.
 *   Absent -> `draw.create` reports it is not available and `status.show` has no image lines.
 * `imageFetcher` — from createImageFetcher() (src/media/fetch-image.js), optional: downloads the
 *   bot's avatar as the reference of a `draw.create` picture of herself. Absent -> no reference is sent.
 * `emojiBackfill` — from createEmojiBackfill() (src/memory/emoji-backfill.js), optional: `run` (with
 *   `force`, awaited by `media.rescan` for emoji) and `isRunning` (a note in `media.status`).
 *   Absent -> that rescan reports it is not available; `media.status` still works.
 * `gifBackfill` — from createGifBackfill() (src/memory/gif-backfill.js), optional: `run` (with
 *   `force`, awaited by `media.rescan` for GIFs) and `isRunning` (a note in `media.status`).
 *   Absent -> that rescan reports it is not available; `media.status` still works.
 * `gifRecache` — from createGifRecache() (src/memory/gif-recache.js), optional: `start` (started by
 *   `media.recache` for GIFs, never awaited to the end), `startMedia` (the same for pictures),
 *   `isRunning` (a note in `media.status`) and `waitIdle` (`bot.pause` waits for a run in flight). Absent -> either recache reports it is not available.
 * `archive` — from createArchive() (src/memory/archive.js), optional: `iterate`
 *   (`memory.archive.read`), `find` and `append` (`memory.restore`, with the store's `restoreArchived`).
 *   Absent -> both report the archive is not available.
 * `journal` — from createJournal() (src/memory/journal.js), optional: `system` records of pause
 *   and resume (written while `features.journal` is exactly true), `read` for
 *   `memory.journal.read`. Absent -> no records, and that read reports it is not available.
 *   `withWriterLock` holds the journal's, the record's and the archive's writes while
 *   `memory.snapshot` copies `data/`; absent, it runs without it.
 * `llm` — from createLlm() (src/llm/openrouter.js), optional: `complete()`, the probe the owner's
 *   status card sends to each role's model, and `modelEndpoints()`, its free check of the
 *   drawing model. Absent -> the card names the models without probing them.
 * `embedder` — from createEmbedder() (src/llm/embed.js), optional: `embed()`, the one-input
 *   embedding request the owner's status card probes the `embedding` role with.
 *   Absent -> that role is shown unchecked.
 * `embedQueue` — from src/memory/embedder.js#createEmbedder, optional: `catchUp(guildId)`, the
 *   meaning index's catch-up pass `bot.resume` starts (never awaited), and `indexSummary(guildId)`,
 *   the owner card's index line. Absent -> no pass on resume and no index line.
 * `record` — from createRecord() (src/memory/record.js), optional: `dayFile`, where the owner's
 *   status card finds the record's month indexes for its memory coverage. Absent -> the
 *   record line says it is not available.
 * `metrics` — from src/tools/impl/metrics.ts#createMetrics, optional: `summary`, the owner card's speed
 *   field, and the turns of the last hour its storage line weighs. Absent -> no speed figures.
 * `lookup` — from src/web/lookup.js#createLookup, optional: `searchEngine` and `hasSearch`, the
 *   `search:` line of the limits field. Absent -> no search line.
 * `describer` — from src/memory/describe.js#createDescriber, optional: its second look
 *   (`relookImage`, `rewatchVideo`, `rewatchGif`, `videoCapsLeft`) behind `media.look`.
 *   Absent -> that operation reports it is not available.
 * `usage` — from src/tools/impl/usage.ts#createUsage, optional: `byRole`, today's requests per role on
 *   the owner card's costs field. Absent -> no role lines.
 * `simKey` — the optional simulator key (OPENROUTER_SIM_KEY), a string: used for one read-only GET of
 *   its limit on the owner card's costs field, never for a model request. Absent -> a "not set" line.
 * `managementKey` — the optional management key (OPENROUTER_MANAGEMENT_KEY), a string: used only for
 *   the read-only activity GETs behind each key's last 7 and 30 days on the owner card. Absent -> the
 *   bot's own accumulator (the simulator key: its calendar week and month).
 * `port` — the persona's interface (src/interface/port.js), optional: what the `message.*`
 *   operations and `draw.create` in another channel post through, as the persona. Absent -> those
 *   report they are not available.
 * `errands` — from createErrandService() (src/errands/service.ts), optional: what the `errand.*`
 *   operations submit to and read. Absent -> those report they are not available.
 * `intentions` — from createIntentionService() (src/intentions/service.ts), optional: what the
 *   `intention.*` operations change and read. Absent -> those report they are not available.
 * `inner` — from createInnerLife() (src/behavior/inner.ts), optional: what `inner.stop`,
 *   `inner.start` and `inner.status` change and report. Absent -> those report it is not running.
 * `now` — the clock of the status card's coverage cache (default `Date.now`).
 * `dataDir` — the data directory `memory.snapshot` copies: src/index.js passes the one it
 *   resolved (src/paths.js, `NEPTUNIA_DATA_DIR`); default `<hot.rootDir>/data`.
 *
 * `run(op, args, context)` throws a plain `Error` (operator-facing message) on bad input; the
 * `run*SkillOp` functions never throw.
 * @param {import('./tools/impl/env.ts').OpsDeps} deps
 */
export function createAdmin(deps) {
  const env = createOpsEnv(deps);

  /** An operation's result as the reply the tests read: `ok` -> its text (or `{ text, files }`,
   * or `{ text, fields }` for `status.show`); anything else -> the operator-facing Error. */
  function render(result) {
    if (result.status === 'ok') return result.data?.files || result.data?.fields ? result.data : result.summary;
    throw Object.assign(new Error(result.summary), { code: result.code, status: result.status });
  }

  /**
   * Run one operation by its name WITHOUT a rights check and render it: the reply text (or
   * `{ text, files }`, or `{ text, fields }`), or a thrown operator-facing `Error`. The tests drive the
   * operations through it.
   * @param {string} op
   */
  async function run(op, args = {}, context = {}) {
    return render(await runOpPrechecked(op, args, { ...context, env }));
  }

  /**
   * One operation run for the persona by its name (src/tools/impl/index.ts#runOp), the requester's full
   * rights check included. Never throws.
   * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
   */
  async function runSkillOp(op, args = {}, context = {}) {
    return runOp(op, args, { ...context, env });
  }

  /**
   * One of the persona's own expressive operations (src/tools/impl/effects.ts#SELF_OWNED_OPS) run for
   * her by its name, WITHOUT the requester's rights check: her grant, checked by the skill
   * gateway, alone decides (src/tools/executors.ts). Any other operation is refused
   * (`not-self-owned`): it goes through `runSkillOp`. Never throws.
   * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
   */
  async function runOwnSkillOp(op, args = {}, context = {}) {
    if (!SELF_OWNED_OPS.includes(op))
      return { status: 'denied', code: CODE.NOT_SELF_OWNED, summary: `${op} is not the persona's own`, data: null };
    return runOpPrechecked(op, args, { ...context, env });
  }

  /**
   * Any operation run for the persona on her own initiative (an inner turn, src/behavior/inner.ts:
   * nobody asked) by its name, WITHOUT a requester's rights check: her grant, checked by the
   * skill gateway as her own initiative, alone decides (src/tools/executors.ts). Never throws.
   * @returns {Promise<{ status: string, code: string, summary: string, data: unknown }>}
   */
  async function runInitiativeSkillOp(op, args = {}, context = {}) {
    return runOpPrechecked(op, args, { ...context, env });
  }

  /**
   * The owner's console reads that are no operation, so no tool of hers (src/interface/commands/console.ts):
   * `lessons(context)` and `aliases({ userId }, context)`, each the reply text or a thrown operator-facing `Error`.
   */
  const ownerReads = {
    lessons: (context = {}) => listLessons(env, { ...context, env }),
    aliases: (args = {}, context = {}) => listAliases(env, args, { ...context, env }),
  };

  /** Once per guild at start: the stored grants re-expanded under the operation names
   * (src/tools/impl/access.ts#migrateStoredGrants). */
  function migrateAccess(guildId) {
    const everyOp = listOps().map((op) => op.name);
    return migrateStoredGrants(env, guildId, (key) => legacyGrantOps(key, everyOp));
  }

  return {
    run,
    runSkillOp,
    runOwnSkillOp,
    runInitiativeSkillOp,
    migrateAccess,
    ownerReads,
  };
}
