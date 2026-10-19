// The virtual week of the persona's inner life (docs/inner-life.md "Testing it over a week"): the
// production scheduler and intention service over a temporary data directory, a fake clock that
// jumps between the moments that matter, the week scripted by a fixture (tools/fixtures/inner-week/),
// the inner turns answered by a deterministic stub voice -- or, on selected days, by the real voice
// in shadow on the simulator key. Prints the acceptance gates; writes a report per fixture.
//
// Usage (from the checkout):
//   node tools/inner-week.mjs --all [--out <dir>]
//   node tools/inner-week.mjs --fixture <name|file> [--fixture ...] [--out <dir>] [--keep]
//   node tools/inner-week.mjs --fixture <name|file> --live --days <2,4-5> --channel <channelId>
//        [--data <dir>] [--spend <usd>] [--out <dir>]
//
// `--fixture`: a file, or the name of one under tools/fixtures/inner-week/ (`ordinary-talk`).
// `--out <dir>`: `<dir>/<fixture>/report.json` and `report.md` (every wake, inner turn, cap
// refusal, drop, disposition, intention lifecycle, per-day counts and spend, the gates); never
// under the data directory. `--keep` leaves the temporary data directory of each week (its path
// on stderr) instead of removing it.
//
// Stub mode (the default) spends nothing: nothing leaves the process, no data directory is read.
//
// `--live`: the fixture's week again, the inner turns of `--days` (1-based) answered by the real
// turn runner in shadow (`innerLife.mode` forced to `shadow`: her reads run on OPENROUTER_SIM_KEY,
// every other call is only proposed), the other days by the stub. Wired as `replay.mjs --inner`:
// Discord over REST, GET only (`--channel` is the real channel every fixture conversation is played
// in; its sends refused), her memory an unflushed copy of `--data` (default the deployment's data
// directory; read only), the history of each turn the fixture's scripted chat instead of the real
// channel's, the intentions and errands the week's own. So that the week reads as her own world:
// every writable fixture channel is the real channel (`withChannelMap`: the intentions' destinations,
// the wakes, the scripted history; an unwritable one keeps its fixture id and drops as no-channel
// as the fixture intends), and the fixture's people are members of the copied directory with
// their names (`addFixturePeople`; nothing reaches `--data`). The spend gate: a stub pass of the same
// week counts the inner turns on `--days`, at up to 4 requests each (her answer and the tool-loop
// steps) at ~0.15 USD; refused (exit 2) without `--spend` covering it. Once what the provider
// reports spent would pass `--spend`, the stub answers the rest of the week.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliError, REFUSED_EXIT, defaultDataDir, parseFlags, privateDirOf, runCli, simKey, spendGate } from './lib/cli.mjs';
import { computeGates, gatesTable, loadFixtures, parseDays, parseFixture, renderReport, reportOf, runWeek, turnsOnDays, withChannelMap } from './lib/inner-week.mjs';
import { onLog } from '../src/log.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures', 'inner-week');
/** An inner turn's requests at most: her answer and up to three tool-loop steps. */
export const INNER_REQUESTS = 4;
/** The estimate per model request, as replay.mjs uses it. */
export const USD_PER_ANSWER = 0.15;

const USAGE =
  'usage: node tools/inner-week.mjs --all [--out <dir>] [--keep]\n' +
  '       node tools/inner-week.mjs --fixture <name|file> [--fixture ...] [--out <dir>] [--keep]\n' +
  '       node tools/inner-week.mjs --fixture <name|file> --live --days <2,4-5> --channel <channelId> [--data <dir>] [--spend <usd>] [--out <dir>]';

/** The argv of the tool, checked. */
export function parseArgs(argv) {
  const flags = parseFlags(argv, { values: ['--out', '--days', '--channel', '--data', '--spend'], lists: ['--fixture'], switches: ['--all', '--live', '--keep'], usage: USAGE });
  if (flags._.length > 0) throw new CliError(USAGE);
  const out = {
    all: flags['--all'] === true,
    fixtures: flags['--fixture'] ?? [],
    out: flags['--out'] ?? null,
    keep: flags['--keep'] === true,
    live: flags['--live'] === true,
    days: flags['--days'] ?? null,
    channel: flags['--channel'] ?? null,
    data: flags['--data'] ?? null,
    spend: flags['--spend'],
  };
  if (out.all === (out.fixtures.length > 0)) throw new CliError(USAGE);
  if (out.live) {
    if (out.all || out.fixtures.length !== 1) throw new CliError(`${USAGE}\n(--live runs one fixture)`);
    if (!out.days || !out.channel) throw new CliError(`${USAGE}\n(--live needs --days and --channel)`);
    if (!/^\d{17,20}$/.test(out.channel)) throw new CliError('inner-week: --channel must be a channel id');
  } else if (out.days || out.channel || out.data || out.spend !== undefined) {
    throw new CliError(`${USAGE}\n(--days, --channel, --data and --spend belong to --live)`);
  }
  return out;
}

/** A fixture by file path or by name under tools/fixtures/inner-week/. */
export function readFixture(value, { cwd = process.cwd(), dir = FIXTURES } = {}) {
  const candidates = [path.resolve(cwd, value), path.join(dir, value), path.join(dir, `${value}.json`)];
  const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) throw new CliError(`inner-week: no fixture ${value}`);
  try {
    return parseFixture(fs.readFileSync(file, 'utf8'), { name: path.basename(file).replace(/\.json$/, '') });
  } catch (err) {
    throw new CliError(err.message);
  }
}

/** The registry's effect class of each skill (`read`, `write`, ...), null for an unknown one. */
export function effectsLookup() {
  const registry = skillRegistry();
  return (skill) => registry.get(skill)?.effects ?? null;
}

/** A fresh temporary data directory under TMPDIR. */
function tempData(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nep-inner-week-${name}-`));
}

/** One week of `fixture` in a temporary data directory (removed after unless `keep`), with its report. */
export async function weekOf(fixture, { effectsOf, keep = false, ...options } = {}) {
  const dataDir = tempData(fixture.name);
  try {
    const run = await runWeek({ fixture, dataDir, skills: { effectsOf }, ...options });
    const gates = computeGates(run, fixture, effectsOf);
    return { run, gates, report: reportOf(run, fixture, gates, effectsOf) };
  } finally {
    if (keep) process.stderr.write(`inner-week: kept ${dataDir}\n`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function writeReport(outDir, report) {
  const dir = path.join(outDir, report.fixture);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'report.md'), renderReport(report));
}

// ---- the live voice ------------------------------------------------------------------

/**
 * The channel map of a live run (withChannelMap's): every writable channel of `fixture` onto the
 * real `channel` (`{ id, name }`; a null name keeps the fixture's). The unwritable ones are left
 * out, so they stay channels she cannot write in.
 */
export function liveChannelMap(fixture, channel) {
  const target = { id: String(channel.id), name: typeof channel.name === 'string' && channel.name ? channel.name : null };
  return Object.fromEntries(fixture.channels.filter((c) => c.writable !== false).map((c) => [c.id, target]));
}

/**
 * The fixture's people (`name -> id`) as members of `guildId` in `store`'s cache, each with its
 * name, so her `<directory>` lists them as the scripted lines show them; one already there is
 * left alone. Called on the unflushed copy of the live store: nothing reaches the disk. Returns
 * the ids added.
 */
export function addFixturePeople(store, guildId, people, at) {
  const added = [];
  for (const [name, id] of Object.entries(people ?? {})) {
    if (typeof id !== 'string' || !id || store.getUser(guildId, id)) continue;
    store.touchUser(guildId, id, name, at);
    added.push(id);
  }
  return added;
}

/** A Discord snowflake of `ts` (ms) with `seq` in its low bits: ids that sort as the lines do. */
function snowflakeOf(ts, seq) {
  return ((BigInt(Math.max(ts, 1420070400000)) - 1420070400000n) << 22n | BigInt(seq & 0x3fffff)).toString();
}

/**
 * The fixture's scripted chat of one conversation as fetchHistory's lines (interfaces/discord/collect.js
 * normalizeMessage's shape), in the real channel `channel`, up to `now`, the last `limit`.
 */
export function scriptedHistory(lines, { channel, selfId, selfName, now, limit }) {
  return lines
    .filter((line) => line.ts <= now)
    .slice(-limit)
    .map((line, i) => ({
      id: snowflakeOf(line.ts, i + 1),
      channelId: String(channel.id),
      channelName: channel.name ?? null,
      channelCategory: null,
      channelTopic: null,
      authorId: line.self ? selfId : String(line.authorId),
      authorName: line.self ? selfName : line.authorName,
      self: line.self === true,
      bot: false,
      content: line.content,
      ts: line.ts,
      mentionedUserIds: [],
      mentionedChannelIds: [],
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    }));
}

/**
 * The real voice in shadow, wired as `replay.mjs --inner` wires it (see the header), the
 * fixture's people in her copied directory. Resolves `{ voice, guildId, channel, close }`
 * (`channel`: the real channel's id and name); `voice.runTurn` answers null once the spend is used up.
 */
async function createLiveVoice({ args, fixture, clock, budget, log }) {
  const replay = await import('./replay.mjs');
  const load = (rel) => import(pathToFileURL(path.join(ROOT, 'src', rel)).href);
  const mods = { ...(await replay.loadDiaryMods(load)), ...(await load('admin.js')) };
  const { loadDotEnv } = await load('config.js');
  const { createHot } = await load('hot.js');
  loadDotEnv(privateDirOf(ROOT));
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new CliError('inner-week: DISCORD_TOKEN is not set (.env)');
  const apiKey = simKey('inner-week');
  const dataDir = args.data ? path.resolve(args.data) : defaultDataDir(ROOT);
  if (!fs.existsSync(dataDir)) throw new CliError(`inner-week: no data directory at ${dataDir}`);

  const liveHot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  const shadowHot = replay.innerReplayHot(liveHot);
  // Her intentions shown as on any turn (the week's own, in its temporary directory).
  const hot = new Proxy(shadowHot, {
    get(target, prop) {
      if (prop === 'config') {
        const config = target.config;
        return { ...config, features: { ...config.features, intentions: true } };
      }
      return Reflect.get(target, prop, target);
    },
  });
  let client = null;
  try {
    const { store, state } = replay.unflushedStore(mods.createStore({ dataDir }));
    const calibrator = mods.createCalibrator(state.data.calibration);
    const calls = [];
    const llm = replay.recordingLlm(mods.createLlm({ apiKey, getConfig: () => hot.config, calibrator, state }), calls, { noCache: true });
    const discord = createRequire(path.join(ROOT, 'package.json'))('discord.js');
    const connection = await replay.connectDiscord({ discord, token, configuredGuildId: hot.config.bot?.guildId || '', resolveGuild: mods.resolveGuild, log });
    client = connection.client;
    const { guildId, self } = connection;
    const queueRequest = client.rest.queueRequest.bind(client.rest);
    client.rest.queueRequest = (request) => {
      const method = String(request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return Promise.reject(new Error(`inner-week: Discord ${method} refused (read-only tool)`));
      return queueRequest(request);
    };
    const channel = await client.channels.fetch(args.channel).catch(() => null);
    if (!channel || String(channel.guildId ?? channel.guild?.id ?? '') !== String(guildId)) throw new CliError('inner-week: --channel is not a channel of the served guild');
    const refuse = (name) => async () => {
      throw new Error(`inner-week: channel.${name} refused (read-only tool)`);
    };
    channel.send = refuse('send');
    channel.sendTyping = refuse('sendTyping');
    addFixturePeople(store, guildId, fixture.people, fixture.startMs);

    // The turn's history: the fixture's chat of the conversation the scheduler picked.
    let scripted = { lines: [], name: null };
    const capabilities = mods.createDiscordInterface({ client }).capabilities;
    const scriptedCapabilities = {
      ...capabilities,
      fetchHistory: async (_channel, options = {}) => scriptedHistory(scripted.lines, { channel: { id: channel.id, name: scripted.name ?? channel.name }, selfId: self.id, selfName: self.name, now: clock.now(), limit: options.limit ?? 30 }),
    };
    const port = mods.createFakeAdapter({ iface: 'inner-week', selfId: self.id, now: clock.now, limits: { maxAttachmentBytes: 64 * 1024 * 1024 } });
    let week = null;
    // The week's intention service (rebound after a restart); errands: none shown, an open budget
    // (a proposed task.run is checked by the gateway as live, against no real caps).
    const intentions = new Proxy({}, {
      get(_target, prop) {
        const service = week?.intentions;
        const value = service?.[prop];
        return typeof value === 'function' ? value.bind(service) : value;
      },
    });
    const errands = { view: () => [], markSeen: () => {}, budget: () => ({ spent: false }), store: () => null };
    const admin = mods.createAdmin({ hot, store, client, discord: scriptedCapabilities, port, intentions, errands, getGuildId: () => guildId, dataDir: null });
    const turns = replay.diaryTurnRunner(mods, {
      hot, store, llm, calibrator, client, guildId, self, images: null, state, port, now: clock.now,
      extra: { discord: scriptedCapabilities, skills: skillRegistry(), runCommand: admin.runCommand, runOwnCommand: admin.runOwnCommand, runInitiativeCommand: admin.runInitiativeCommand, intentions, errands },
    });
    const spent = () => calls.reduce((sum, call) => sum + (Number(call.usage?.cost_details?.upstream_inference_cost ?? call.usage?.cost ?? 0) || 0), 0);
    const voice = {
      kind: 'live',
      bind(service) {
        week = { intentions: service };
      },
      async runTurn(params, { world }) {
        if (budget !== null && spent() + INNER_REQUESTS * USD_PER_ANSWER > budget) return null;
        scripted = { lines: world.chat.get(String(params.channel.id)) ?? [], name: params.channel.name ?? null };
        const before = calls.length;
        let result;
        try {
          result = await turns.runTurn({ channel, guildId, mode: 'inner', triggerKind: 'inner', inner: { ...params.inner, shadow: true } });
        } catch (err) {
          result = { outcome: 'error', reason: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
        }
        const answers = calls.slice(before).filter((call) => call.purpose === 'reply').map((call) => call.text);
        return { ...result, answers };
      },
    };
    return {
      voice,
      guildId,
      channel: { id: String(channel.id), name: channel.name ?? null },
      spent,
      close: async () => {
        liveHot.close?.();
        if (client) await Promise.resolve(client.destroy()).catch(() => {});
      },
    };
  } catch (err) {
    liveHot.close?.();
    if (client) await Promise.resolve(client.destroy()).catch(() => {});
    throw err;
  }
}

// ---- main ------------------------------------------------------------------------------

export async function main(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const effectsOf = effectsLookup();
  const fixtures = args.all ? loadFixtures(FIXTURES) : args.fixtures.map((value) => readFixture(value, { cwd }));
  if (args.out) {
    const out = path.resolve(cwd, args.out);
    const data = path.resolve(defaultDataDir(ROOT));
    if (out === data || out.startsWith(`${data}${path.sep}`)) throw new CliError('inner-week: --out may not be under the data directory');
  }

  if (!args.live) {
    const reports = [];
    for (const fixture of fixtures) {
      const { report } = await weekOf(fixture, { effectsOf, keep: args.keep });
      reports.push(report);
      if (args.out) writeReport(path.resolve(cwd, args.out), report);
    }
    return gatesTable(reports);
  }

  // --live: the stub pass first (the estimate), then the week with the real voice on --days.
  // Both play the fixture's writable channels as the real channel (liveChannelMap, withChannelMap).
  const fixture = fixtures[0];
  const liveDays = parseDays(args.days, fixture.days);
  if (!liveDays) throw new CliError(`inner-week: --days must name days 1..${fixture.days}`);
  const dry = await weekOf(withChannelMap(fixture, liveChannelMap(fixture, { id: args.channel, name: null })), { effectsOf, mode: 'shadow' });
  const turns = turnsOnDays(dry.run, liveDays);
  const requests = turns * INNER_REQUESTS;
  const gate = spendGate({ estimateUsd: requests * USD_PER_ANSWER, requests, spend: args.spend, detail: `${turns} inner turn(s) on day(s) ${liveDays.join(',')} in the stub pass, up to ${INNER_REQUESTS} requests each at ~${USD_PER_ANSWER} USD` });
  if (!gate.ok) throw new CliError(`inner-week: ${gate.text}`, { exitCode: REFUSED_EXIT });
  process.stderr.write(`inner-week: ${gate.text}\n`);
  const clockBox = { now: () => fixture.startMs };
  const { log } = await import('../src/log.js');
  const live = await createLiveVoice({ args, fixture, clock: { now: () => clockBox.now() }, budget: gate.budget, log });
  try {
    const liveFixture = withChannelMap(fixture, liveChannelMap(fixture, live.channel));
    const dataDir = tempData(fixture.name);
    try {
      const run = await runWeek({
        fixture: liveFixture,
        dataDir,
        skills: { effectsOf },
        voice: live.voice,
        liveDays,
        mode: 'shadow',
        guildId: live.guildId,
        subscribeLog: onLog,
        onReady: ({ clock, intentions }) => {
          clockBox.now = clock.now;
          live.voice.bind(intentions);
        },
      });
      const gates = computeGates(run, liveFixture, effectsOf);
      const report = { ...reportOf(run, liveFixture, gates, effectsOf), live: { days: liveDays, spentUsd: Math.round(live.spent() * 10000) / 10000, budgetUsd: gate.budget } };
      if (args.out) writeReport(path.resolve(cwd, args.out), report);
      return `${gatesTable([report])}\nlive days ${liveDays.join(',')}: ${run.turns.filter((t) => t.voice === 'live').length} live inner turn(s), ${report.live.spentUsd} USD reported\n`;
    } finally {
      if (args.keep) process.stderr.write(`inner-week: kept ${dataDir}\n`);
      else fs.rmSync(dataDir, { recursive: true, force: true });
    }
  } finally {
    await live.close();
  }
}

runCli(import.meta.url, main);
