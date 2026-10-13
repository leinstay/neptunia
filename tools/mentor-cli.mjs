#!/usr/bin/env node
// Operations tool (untracked): start one mentor run or check from the server's
// shell, as a separate process next to the running bot, and print the result;
// also create a case anchored to a message, and list the cases.
//
//   cd /opt/neptunia-bot && node /path/to/mentor-cli.mjs run <caseId> [--no-post]
//   cd /opt/neptunia-bot && node /path/to/mentor-cli.mjs check [<caseId>] [--no-post]
//   cd /opt/neptunia-bot && node /path/to/mentor-cli.mjs add "<case text>" <messageLink-or-id> [--channel <channelId>] [--target reply]
//   cd /opt/neptunia-bot && node /path/to/mentor-cli.mjs list
//
// `add` creates a case the way `/nep mentor add` does (src/admin.js#cmdMentorAdd):
// refused while the bot is paused; the case text is checked first
// (src/mentor/cases.js#checkCaseText, 10 to 1000 characters); then the message
// is read with the mentor's `readAnchor` - a link
// https://discord.com/channels/<guild>/<channel>/<message>, or a bare message id
// with `--channel` standing for the channel the command would be typed in - and
// the case is stored with target `reply` (the only one) by the case store. Like
// the command it needs neither features.mentor nor a mentor model and spends no
// tokens. `list` prints every case, retired ones included, and writes nothing.
//
// The engine's modules are imported from the current working directory
// (`<cwd>/src/...`), so the same file works wherever it is placed.
//
// What keeps the running bot undisturbed:
// - No gateway session: a discord.js Client that never logs in, its token set
//   on REST only. The guild, its channels, the bot's own user and member are
//   fetched over REST so the mentor's channel and history reads resolve names
//   the way the live client does.
// - No shared state is written: the memory store is the real one (it reads
//   data/) behind a wrapper that passes only the read methods the mentor uses;
//   every other method throws, and its `state` is a frozen copy. The llm
//   client counts on an in-memory copy of the daily counters (the mentor never
//   counts against the chat's daily cap anyway). The mentor budget lives in
//   memory, seeded from today's spend: the larger of state.json's
//   mentorTokens and the tokens of the run records saved today, so
//   `mentor.maxTokensPerDay` holds across several invocations of this tool
//   even though the bot's state.json never sees what this process spends.
// - The only files written are the ones a run or `add` writes by design,
//   through src/mentor/cases.js: the run record under
//   data/guilds/<g>/mentor/runs/<case>/, the case's state and score in
//   data/guilds/<g>/mentor/cases.json, and for `add` the new case in that
//   file (created with its folder when missing). No change store is passed,
//   so nothing is ever repaired and no prompt file is touched.
//
// Output: every log line (the engine's JSON lines included) goes to stderr;
// stdout carries exactly one JSON object at the end. Exit code 0 when every
// run finished normally (passed or not), 1 otherwise (an error, a stop, a
// refused start); `add` and `list` exit 0 on success, 1 with the reason on
// stderr. Ctrl-C once stops the run (it is saved as stopped); twice exits at
// once. Never prints a token or message contents: a case's moments are shown
// as their ids and message counts.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE =
  'usage: node mentor-cli.mjs run <caseId> [--no-post] | check [<caseId>] [--no-post] | add "<case text>" <messageLink-or-id> [--channel <channelId>] [--target reply] | list   (cwd: the bot directory)';
const STATUS_EVERY_MS = 60_000;

/** The store methods the mentor reads through (src/mentor/sandbox.js#liveView, mentor.js#mediaCacheOf). */
export const STORE_READS = Object.freeze(['getGuild', 'getUser', 'listUserProfiles', 'listChannels', 'getChannel', 'getLore', 'getMediaCache', 'getGifs', 'findGif', 'getRecent', 'getBuffer', 'getVoiceQueue', 'getPrivate', 'getPrivateBuffer', 'listPrivate', 'listGuilds']);

/** An operator-facing failure: printed as is, exit code 1. */
class CliError extends Error {}

/** A deep-frozen copy of a JSON value. */
function frozenCopy(value) {
  const copy = value === undefined ? {} : structuredClone(value);
  const freeze = (v) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const item of Object.values(v)) freeze(item);
    }
    return v;
  };
  return freeze(copy);
}

/**
 * The real store with every write refused: the read methods the mentor uses
 * pass through; any other method of the store throws; `state` is a frozen
 * copy whose `markDirty` throws. Reads may normalise cached values in this
 * process's own cache; nothing is ever flushed from here.
 * @param {object} store  From src/memory/store.js#createStore.
 */
export function readOnlyStore(store) {
  const refused = (name) => () => {
    throw new Error(`mentor-cli: the memory store is read-only here (${name} refused)`);
  };
  const out = {};
  for (const key of Object.keys(store)) {
    if (key === 'state') continue;
    if (typeof store[key] !== 'function') continue;
    out[key] = STORE_READS.includes(key) ? (...args) => store[key](...args) : refused(key);
  }
  const data = frozenCopy(store.state?.data);
  out.state = {
    get data() {
      return data;
    },
    markDirty: refused('state.markDirty'),
  };
  return out;
}

/** 'YYYY-MM-DD' (UTC) of a millisecond time. */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Tokens spent by the mentor runs saved on `day` (UTC), from their records:
 * a run's id is its save time in ms (src/mentor/cases.js#saveRun). Counts
 * only; an unreadable record is counted in `unreadable` and skipped.
 * @returns {{ tokens: number, runs: number, unreadable: number }}
 */
export function spentInRecords(dataDir, guildId, day) {
  const root = path.join(dataDir, 'guilds', String(guildId), 'mentor', 'runs');
  const result = { tokens: 0, runs: 0, unreadable: 0 };
  let caseDirs = [];
  try {
    caseDirs = fs.readdirSync(root);
  } catch {
    return result;
  }
  for (const caseDir of caseDirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, caseDir));
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^(\d+)\.json$/.exec(name);
      if (!match || utcDay(Number(match[1])) !== day) continue;
      try {
        const spent = JSON.parse(fs.readFileSync(path.join(root, caseDir, name), 'utf8'))?.tokens?.spent;
        if (Number.isFinite(spent) && spent > 0) result.tokens += spent;
        result.runs += 1;
      } catch {
        result.unreadable += 1;
      }
    }
  }
  return result;
}

/**
 * The in-memory state the mentor budget counts on: today's spend is the
 * larger of state.json's (`mentorDay` / `mentorTokens`, read only) and the
 * saved records' (which include this tool's earlier runs). Pure.
 */
export function seedBudgetState({ stateData, recordTokens, day }) {
  const fromState = stateData?.mentorDay === day && Number.isFinite(stateData?.mentorTokens) ? Math.max(0, stateData.mentorTokens) : 0;
  const data = { mentorDay: day, mentorTokens: Math.max(fromState, Math.max(0, recordTokens || 0)) };
  return { data, markDirty() {}, fromState };
}

/**
 * `add`'s arguments (after the command) as `{ command: 'add', text, ref, channelId, target }`: two
 * positional values (the case text, then the message link or id) and the options `--channel <id>`
 * and `--target reply`, in any order. Throws a CliError with the usage, or naming the bad option.
 */
function parseAdd(rest) {
  const positional = [];
  let channelId = null;
  let target = 'reply';
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--channel' || arg === '--target') {
      const value = rest[i + 1];
      if (value === undefined) throw new CliError(USAGE);
      i += 1;
      if (arg === '--channel') channelId = value.trim();
      else target = value.trim();
      continue;
    }
    if (arg.startsWith('--')) throw new CliError(USAGE);
    positional.push(arg);
  }
  if (positional.length !== 2) throw new CliError(USAGE);
  if (target !== 'reply') throw new CliError('mentor-cli: --target takes only reply (the one target a case has)');
  if (channelId !== null && !/^\d+$/.test(channelId)) throw new CliError('mentor-cli: --channel takes a channel id');
  const [text, ref] = positional;
  // As the command's `message` option (src/admin.js#mentorMessageRef): required, trimmed.
  if (!ref.trim()) throw new CliError('mentor-cli: a message link or id is required');
  return { command: 'add', text, ref: ref.trim(), channelId, target, noPost: false };
}

/**
 * `argv` (after the script) as `{ command, caseId, noPost }` for run and check, `{ command: 'list' }`,
 * or `add`'s (see `parseAdd`); throws a CliError with the usage.
 */
export function parseArgs(argv) {
  if (argv[0] === 'add') return parseAdd(argv.slice(1));
  if (argv[0] === 'list') {
    if (argv.length !== 1) throw new CliError(USAGE);
    return { command: 'list', noPost: false };
  }
  const args = argv.filter((a) => a !== '--no-post');
  const noPost = args.length !== argv.length;
  const [command, id, extra] = args;
  const caseId = id === undefined ? null : Number(id);
  if (extra !== undefined || (id !== undefined && !(Number.isInteger(caseId) && caseId > 0))) throw new CliError(USAGE);
  if (command === 'run' && caseId !== null) return { command, caseId, noPost };
  if (command === 'check') return { command, caseId, noPost };
  throw new CliError(USAGE);
}

/** One saved run as this tool prints it (no message contents). */
export function runSummary(saved, { dataDir, guildId }) {
  const runId = saved?.id ?? null;
  const file = runId ? path.join(dataDir, 'guilds', String(guildId), 'mentor', 'runs', String(saved.caseId), `${runId}.json`) : null;
  return {
    caseId: saved?.caseId ?? null,
    runId,
    passed: saved?.passed === true,
    medians: saved?.medians ?? null,
    situationMedians: saved?.situationMedians ?? [],
    reasons: saved?.reasons ?? [],
    tokens: saved?.tokens ?? null,
    file: file && fs.existsSync(file) ? file : null,
    stopped: saved?.stopped ?? null,
    error: saved?.error ?? null,
  };
}

/** One stored moment of a case as this tool prints it: ids and counts, never message contents. */
export function anchorSummary(anchor) {
  const summary = {
    id: anchor?.id ?? null,
    channelId: anchor?.channelId ?? null,
    messageId: anchor?.messageId ?? null,
    triggerId: anchor?.triggerId ?? null,
    messages: Array.isArray(anchor?.history) ? anchor.history.length : 0,
    original: Array.isArray(anchor?.original) ? anchor.original.length : 0,
    pulled: Array.isArray(anchor?.pulled) ? anchor.pulled.length : 0,
  };
  if (anchor?.mode !== undefined) summary.mode = anchor.mode;
  if (anchor?.triggerKind !== undefined) summary.triggerKind = anchor.triggerKind;
  if (anchor?.sourceChannelId !== undefined) summary.sourceChannelId = anchor.sourceChannelId;
  if (anchor?.triggerGuessed === true) summary.triggerGuessed = true;
  if (anchor?.addedAt !== undefined) summary.addedAt = anchor.addedAt;
  return summary;
}

/** The moments of a case as printed (see `anchorSummary`). */
function anchorsOf(item) {
  return Array.isArray(item?.anchors) ? item.anchors.map(anchorSummary) : [];
}

/** Whether a summarised run ended normally (passed or not). */
function finished(summary) {
  return Boolean(summary.runId) && !summary.stopped && !summary.error;
}

/** `hot` with `bot.dryRunChannelId` blanked, so the report is saved but not posted. */
function withoutPosting(hot) {
  return new Proxy(hot, {
    get(target, prop) {
      if (prop === 'config') {
        const config = target.config;
        return { ...config, bot: { ...config.bot, dryRunChannelId: '' } };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * A REST-only Discord connection: no login, no gateway, no event handler.
 * Fetches the served guild (`bot.guildId`, else the only guild the bot is
 * in), its channels (so channel names, categories and `#channel` mentions
 * resolve as in the live cache), the bot's own user (also set as
 * `client.user`, so `guild.members.me` resolves) and its member (its display
 * name, as the live `getSelfName`).
 */
async function connectDiscord({ discord, token, configuredGuildId, resolveGuild, log }) {
  const { Client, Routes } = discord;
  const client = new Client({ intents: [] });
  client.rest.setToken(token);
  try {
    const guilds = await client.rest.get(Routes.userGuilds());
    const resolved = resolveGuild(configuredGuildId, (Array.isArray(guilds) ? guilds : []).map((g) => ({ id: g.id, name: g.name })));
    if (resolved.error) throw new CliError(`mentor-cli: ${resolved.error}`);
    const guildId = resolved.guildId;
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const me = await client.rest.get(Routes.user());
    try {
      client.user = new discord.ClientUser(client, me);
    } catch {
      // Only `guild.members.me` needs it, and the mentor's run and check never read it.
    }
    // A reaction's emoji getter reads `client.application.emojis`; without a gateway login the application is null.
    try {
      if (!client.application) client.application = new discord.ClientApplication(client, { id: me.id });
    } catch (err) {
      log.warn('mentor-cli: the application object cannot be built', { errorName: err?.name });
    }
    let member = null;
    try {
      member = await guild.members.fetch(me.id);
    } catch (err) {
      log.warn('mentor-cli: the bot member cannot be fetched, using the user name', { errorName: err?.name, statusCode: err?.status });
    }
    const self = { id: String(me.id), name: member?.displayName ?? me.username ?? 'bot' };
    log.info('mentor-cli: discord over REST', { guild: guildId, channels: channels.size, self: self.id });
    return { client, guildId, getSelf: () => self };
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
}

/**
 * The whole tool. Returns `{ code, result }`; never prints to stdout itself.
 * `hooks` replace the network edges for an offline smoke test only:
 * `connect(args)` -> `{ client, guildId, getSelf }`, `createLlm(deps)`,
 * `fetchHistoryWindow`, `fetchMoment`.
 * @param {string[]} argv
 * @param {{ root?: string, hooks?: object, onMentor?: (mentor: object) => void }} [options]
 */
export async function main(argv, { root = process.cwd(), hooks = {}, onMentor } = {}) {
  const args = parseArgs(argv);
  const src = path.join(root, 'src');
  if (!fs.existsSync(path.join(src, 'mentor', 'mentor.js'))) throw new CliError(`mentor-cli: no engine under ${src}; run it from the bot's directory`);
  const load = (rel) => import(pathToFileURL(path.join(src, rel)).href);

  const { loadDotEnv } = await load('config.js');
  const { createHot } = await load('hot.js');
  const { log } = await load('log.js');

  // Reads config.json, config.local.json and both prompt layers; writes nothing.
  const hot = createHot({ rootDir: root });
  // A run or check measures; add and list only read a message or the cases, as the bot's commands do without the switch.
  const measuring = args.command === 'run' || args.command === 'check';
  if (measuring && hot.config.features?.mentor !== true) throw new CliError('mentor-cli: the mentor is not enabled (features.mentor)');
  if (measuring && !hot.config.mentor?.model) throw new CliError('mentor-cli: no mentor model is set (mentor.model)');
  loadDotEnv(root);
  const discordToken = process.env.DISCORD_TOKEN;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!discordToken) throw new CliError('mentor-cli: DISCORD_TOKEN is not set (.env)');
  if (measuring && !openrouterKey) throw new CliError('mentor-cli: OPENROUTER_API_KEY is not set (.env)');

  const { createStore } = await load('memory/store.js');
  const { createCalibrator } = await load('llm/tokens.js');
  const { createLlm } = await load('llm/openrouter.js');
  const { createMentor } = await load('mentor/mentor.js');
  const { createCaseStore, checkCaseText } = await load('mentor/cases.js');
  const { createMentorBudget } = await load('mentor/budget.js');
  const { fetchHistoryWindow, fetchMoment } = await load('discord/collect.js');
  const { resolveGuild } = await load('discord/guild.js');

  // As /nep mentor add: the comment is checked before the message is read (here, before Discord is reached).
  let caseText = null;
  if (args.command === 'add') {
    try {
      caseText = checkCaseText(args.text);
    } catch (err) {
      throw new CliError(`mentor-cli: ${err?.message ?? err}`);
    }
  }

  // Live edits apply as in the bot: turning features.mentor off ends the run as 'disabled'.
  hot.watch();
  let client = null;
  let timer = null;
  try {
    const connect =
      hooks.connect ??
      ((opts) => {
        const discord = createRequire(path.join(root, 'package.json'))('discord.js');
        return connectDiscord({ discord, ...opts });
      });
    const connection = await connect({ token: discordToken, configuredGuildId: hot.config.bot?.guildId || '', resolveGuild, log });
    client = connection.client;
    const { guildId, getSelf } = connection;

    const dataDir = path.join(root, 'data');
    const realStore = createStore({ dataDir });
    const store = readOnlyStore(realStore);
    const stateData = store.state.data;
    // As the bot's assertNotPaused: a paused bot takes no new case.
    if (args.command === 'add' && stateData.paused) throw new CliError('mentor-cli: refused: the bot is paused (/nep resume first)');

    const calibrator = createCalibrator(stateData.calibration);
    const llmState = { data: { llmDay: stateData.llmDay, llmCount: stateData.llmCount }, markDirty() {} };
    const llm = (hooks.createLlm ?? createLlm)({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state: llmState });

    const day = utcDay(Date.now());
    const records = spentInRecords(dataDir, guildId, day);
    const budgetState = seedBudgetState({ stateData, recordTokens: records.tokens, day });
    const budget = createMentorBudget({ state: budgetState, getConfig: () => hot.config });
    const snap = budget.snapshot();
    log.info('mentor-cli: budget seeded', { day, fromState: budgetState.fromState, fromRuns: records.tokens, runsToday: records.runs, unreadable: records.unreadable, used: snap.used, cap: snap.cap, left: snap.left });

    const realCases = createCaseStore({ dataDir });
    if (args.command === 'list') {
      const listed = realCases.list(guildId, { includeRetired: true }).map((item) => ({ id: item.id, state: item.state, text: item.text, anchors: anchorsOf(item) }));
      return { code: 0, result: { cases: listed } };
    }
    let cases = realCases;
    if (args.command === 'check' && args.caseId !== null) {
      const item = realCases.get(guildId, args.caseId);
      if (!item) throw new CliError(`mentor-cli: no case ${args.caseId}`);
      if (item.state === 'retired') throw new CliError(`mentor-cli: case ${args.caseId} is retired`);
      // The mentor's check takes no id: it checks every case `list` returns, so the list is narrowed to one.
      cases = { ...realCases, list: (g, opts) => realCases.list(g, opts).filter((c) => c.id === args.caseId) };
    }

    const mentor = createMentor({
      hot: args.noPost ? withoutPosting(hot) : hot,
      store,
      llm,
      client,
      cases,
      budget,
      // No `changes`: the repair loop never runs, nothing in the private layer is written.
      getGuildId: () => guildId,
      getSelf,
      fetchHistoryWindow: hooks.fetchHistoryWindow ?? fetchHistoryWindow,
      fetchMoment: hooks.fetchMoment ?? fetchMoment,
      calibrator,
    });
    onMentor?.(mentor);

    if (args.command === 'add') {
      let anchor;
      try {
        anchor = await mentor.readAnchor(args.ref, { channelId: args.channelId });
      } catch (err) {
        throw new CliError(`mentor-cli: refused: ${err?.message ?? err}`);
      }
      let item;
      try {
        item = realCases.add(guildId, { text: caseText, target: args.target, anchor });
      } catch (err) {
        throw new CliError(`mentor-cli: refused: ${err?.message ?? err}`);
      }
      log.info('mentor-cli: case added', { caseId: item.id, anchors: item.anchors?.length ?? 0, warnings: item.warnings ?? [] });
      return { code: 0, result: { id: item.id, target: item.target, text: item.text, anchors: anchorsOf(item) } };
    }
    timer = setInterval(() => log.info('mentor-cli: status', mentor.status()), STATUS_EVERY_MS);
    timer.unref?.();

    const summaryOf = (saved) => runSummary(saved, { dataDir, guildId });
    if (args.command === 'run') {
      let started;
      try {
        started = await mentor.run(args.caseId);
      } catch (err) {
        throw new CliError(`mentor-cli: refused: ${err?.message ?? err}`);
      }
      log.info('mentor-cli: run started', { caseId: args.caseId, posting: !args.noPost && Boolean(hot.config.bot?.dryRunChannelId) });
      const saved = await started.done;
      if (!saved) throw new CliError('mentor-cli: the run failed unexpectedly (see the log above)');
      const summary = summaryOf(saved);
      return { code: finished(summary) ? 0 : 1, result: summary };
    }

    let started;
    try {
      started = await mentor.check();
    } catch (err) {
      throw new CliError(`mentor-cli: refused: ${err?.message ?? err}`);
    }
    log.info('mentor-cli: check started', { cases: started.cases, posting: !args.noPost && Boolean(hot.config.bot?.dryRunChannelId) });
    const runs = (await started.done).map(summaryOf);
    const ok = runs.length > 0 && runs.every(finished);
    return { code: ok ? 0 : 1, result: { kind: 'check', cases: started.cases, runs } };
  } finally {
    if (timer) clearInterval(timer);
    hot.close();
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}

// ---- entry point -------------------------------------------------------------

/** Whether this file is the script node was started with (symlinks and drive-letter case allowed for). */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    return norm(fs.realpathSync(process.argv[1])) === norm(fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

const invokedDirectly = isEntryPoint();

if (invokedDirectly) {
  // Every log line, the engine's included, goes to stderr; stdout keeps only the final JSON object.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  const finish = (code, result) => stdoutWrite(`${JSON.stringify(result)}\n`, () => process.exit(code));

  let mentor = null;
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts === 1 && mentor?.isRunning()) {
      process.stderr.write('mentor-cli: stopping the run (Ctrl-C again to exit at once)\n');
      mentor.stop();
      return;
    }
    process.exit(130);
  });
  process.on('unhandledRejection', (err) => process.stderr.write(`mentor-cli: unhandled rejection: ${err?.name ?? 'Error'}: ${err?.message ?? err}\n`));

  main(process.argv.slice(2), { onMentor: (m) => (mentor = m) }).then(
    ({ code, result }) => finish(code, result),
    (err) => {
      const message = err instanceof CliError ? err.message : `mentor-cli: ${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      process.stderr.write(`${message}\n`);
      finish(1, { error: message });
    },
  );
}
