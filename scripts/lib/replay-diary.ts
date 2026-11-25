// `--diary-day`: one day of the diary as the live diary runs it (src/behavior/diary.ts#createDiary's tick), for the
// record of what it would draw. The day plan: planDay for the local date `--date` (default today in `bot.timezone`) at
// its local midnight, with no hunger carried in, on a random stream seeded by `--seed` (default a fresh one, printed
// and kept in the report): the same config, date and seed give the same slots (scripts/lib/diary-day.ts#planDiaryDay).
// The turns draw from a second stream of the same seed. Then, slot by slot in order, the clock of the turn runner and
// the image client set to the slot (and running on from there), the diary's own checks as the tick makes them (the
// day's posts under `diary.maxPerDay`, else `skip` with reason `cap`), and `runTurn({ placeId, mode: 'diary', diary: {
// kind: null, forced: false } })` of the real turn runner with no chat: the director's request for a kind that takes a
// scene, the persona's requests, the pictures generated, and the entry recorded, which the slot reports as what its publication would
// send. A post a slot made is kept in the in-memory diary and counters, so the next slot sees it as the live diary
// would. What keeps the bot and its memory untouched: every Discord REST call but GET is refused; the turn acts through
// an in-memory interface port only (scripts/lib/fake.ts); the store is the real one over an in-memory copy of its state that is never flushed,
// with today's diary post, diary picture and image counts at 0; no journal and no record are wired; requests carry
// `origin: 'replay'` and never count against `llm.maxRequestsPerDay`.
// `--draw fake` (the default): the image client is the real one
// (src/llm/images.ts#createImageGen, its caps and model check) over a fetch that
// answers a 1x1 fixture PNG, so no picture is paid for. `--draw live`: the real
// client on the key production gives the `drawing` role (`--drawing <key>/<model>` replaces it),
// at most `--max-pictures` pictures (default 2; past it a picture is refused as
// an image cap refuses it), each written to `<out>/pictures/`. Every
// `generate()` call is recorded at the client's boundary: `{ prompt, reference,
// accountId }`, the reference as its media type, size and hash, never its bytes.
// The spend gate: the plan is made first (no request), then the estimate --
// 2 requests per slot (a scene and the entry, 4 for a `randomSet`) at ~USD_PER_ANSWER, plus with
// `--draw live` `--max-pictures` pictures at ~0.025 USD -- and the refusal
// without `--spend` covering it; the run also stops once what the provider
// reports spent reaches `--spend`. A day with no slot sends nothing. Written to
// `--out` (default ./replay-diary-day-<time>/, refused under data/ and when it
// exists and is not empty), rewritten after each slot: `report.json` (`{ date,
// timezone, seed, draw, quiet, plan: { slots, hunger }, slots: [{ n, at, local,
// outcome, reason, kind, scenes: [{ seeds, used, scene, failure }], answers: [{ text, calls }], messages, attachments, draws: [{ prompt,
// reference, accountId, result, file }], requests, cost }], usage, stopped }`) and
// `report.md`. stdout: the paths, the slot outcomes and the usage. Exit code 1
// when a slot ended in `error` or the run was stopped.
// `--diary-day --diary-kind <kind>`: one entry of that kind at this moment, forced as the owner's command forces it,
// `--samples n` times (default 1), sample n drawing from the stream `sample-<n>` of `--seed`, so the same seed gives the
// same scenes and the same seed lines. Each sample is a slot of the report: its scenes with the seed lines of the set the
// director took and the lines it kept, the persona's answers with their calls, and the entry. It takes `--prompts <dir>`
// as `--inner` does and `--draw none`: the fixture picture is generated at no cost, and the persona's look at it answers
// that the picture was not drawn in this run, so a text is calibrated without the drawing model.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Untyped } from '../../src/tools/types.ts';
import { writePrivate, spendGate, CliError, REFUSED_EXIT, defaultDataDir, platformToken } from './cli.ts';
import {
  diaryKindSample,
  planDiaryDay,
  diaryDayEstimate,
  renderDiaryDayReport,
  fixtureImagesFetch,
  recordingImages,
  seededRng,
  notDrawnLook,
} from './diary-day.ts';
import { overlayPromptsHot, diaryPromptLayers } from './prompt-layers.ts';
import { connectDiscord, refuseDiscordWrites } from './replay-discord.ts';
import { diaryReplayRunner } from './replay-inner.ts';
import { USD_PER_ANSWER, replayRouting, recordingLlm, addUsage } from './replay-llm.ts';
import { storeMemoryFor } from './replay-memory.ts';
import type { Rec, ModeCtx } from './replay-types.ts';
import { unflushedStore } from './turn-wiring.ts';

/** A diary entry's requests: the director's scene and the persona's entry; a `randomSet` asks for three scenes. */
const DIARY_REQUESTS_PER_BRIEF = 2;

const RANDOM_SET_REQUESTS = 4;

/**
 * The engine modules the diary modes (`--diary-day`) and `--inner` read before their turns, from the checkout at
 * `load`: the day plan, the store, the model clients, the Discord interface and its reads, and the readers of an
 * answer. The turns themselves run on the shared turn runner (diaryReplayRunner, innerTurnRunner).
 */
export async function loadDiaryMods(load: Untyped): Promise<Rec> {
  return {
    ...(await load('behavior/diary.ts')),
    ...(await load('memory/store.ts')),
    ...(await load('llm/tokens.ts')),
    ...(await load('llm/openrouter.ts')),
    ...(await load('llm/embed.ts')),
    ...(await load('llm/images.ts')),
    ...(await load('behavior/turn.ts')),
    ...(await load('../interfaces/discord/index.ts')),
    ...(await load('interface/reads.ts')),
    ...(await load('llm/parse.ts')),
    ...(await load('time.ts')),
  };
}

/**
 * What a diary turn's entry would send (the turn itself sends nothing; its publication does): the persona's messages, and how many
 * files go with them (the pictures and a voice message).
 * @param result the turn's outcome
 */
function entrySends(result: unknown): { messages: Array<string>; attachments: number } {
  const entry = (
    result as {
      diary?: { entry?: { messages?: Array<unknown>; pictures?: Array<unknown>; voice?: unknown } };
    } | null
  )?.diary?.entry;
  const messages = (entry?.messages ?? []).filter((text) => typeof text === 'string' && text !== '');
  return { messages: messages as Array<string>, attachments: (entry?.pictures?.length ?? 0) + (entry?.voice ? 1 : 0) };
}

// ---- a diary day (--diary-day) ---------------------------------------------------

/** The settings of a diary run: `hot`, with every text entry voiced under `--diary-voice` (voicedHot). */
function diaryHot<T extends { config: Untyped }>(args: { diaryVoice?: boolean }, hot: T): T {
  return args.diaryVoice ? voicedHot(hot) : hot;
}

/** `hot` with `diary.voiceChance` at 1, read through to the live settings at each read. */
export function voicedHot<T extends { config: Untyped }>(hot: T): T {
  return new Proxy(hot, {
    get(target, prop) {
      if (prop !== 'config') return Reflect.get(target, prop, target);
      const config = target.config ?? {};
      return { ...config, diary: { ...(config.diary ?? {}), voiceChance: 1 } };
    },
  });
}

/**
 * One diary turn of a replay's diary mode on `turns` (diaryReplayRunner), read as the report shows it: the fields of
 * diaryKindSample over the requests `calls` recorded during it and the journal it kept, and with `request` the
 * persona's first request of the turn, of those `asked` holds, written to a file under `request.outDir` whose path the
 * fields name. `asked` is emptied first, so it holds this turn's requests alone.
 */
export async function diaryReplaySample({
  turns,
  kind,
  calls,
  asked,
  request,
}: {
  turns: ReturnType<typeof diaryReplayRunner>;
  kind: string | null;
  calls: Array<Rec>;
  asked: Array<{ purpose: unknown; messages: unknown }>;
  request: { outDir: string; n: number } | null;
}): Promise<{ result: Untyped; fields: Rec }> {
  const from = calls.length;
  asked.length = 0;
  const { result, journal } = await turns.turn(kind);
  // `--show-request`: the persona's first request, which holds message contents, goes to a file and never to stdout.
  const first = asked.find((one) => one.purpose !== 'diary-scene');
  const file = request && first ? writeDiaryRequest(request.outDir, request.n, first.messages) : null;
  return {
    result,
    fields: { ...diaryKindSample(result, calls.slice(from), journal), ...(file ? { request: file } : {}) },
  };
}

/**
 * The persona's first request of sample `n` written to `<outDir>/request-<n>.json` for `--show-request`, private as the
 * report is; answers its path relative to `outDir`, which the report names.
 */
function writeDiaryRequest(outDir: string, n: number, messages: unknown): string {
  const file = path.join(outDir, `request-${n}.json`);
  writePrivate(file, { messages });
  return path.relative(outDir, file);
}

/** The file extension of a picture's media type. */
function pictureExtension(mediaType: string | null | undefined) {
  const sub = String(mediaType ?? '').split('/')[1] ?? '';
  if (sub === 'jpeg') return 'jpg';
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'png';
}

/**
 * The plan and the spend gate of a `--diary-day` run, before anything is read or sent: the
 * local date (`args.date`, else the day of `nowMs` in `bot.timezone`), the seed (`args.seed`,
 * else a fresh one), the seeded day plan (scripts/lib/diary-day.ts#planDiaryDay over `config`),
 * its estimate (DIARY_REQUESTS_PER_BRIEF requests per slot at ~USD_PER_ANSWER, the live pictures
 * on top) and scripts/lib/cli.ts#spendGate's verdict on `args.spend`: a refusal is a CliError
 * with exit code REFUSED_EXIT. Returns `{ timezone, date, seed, day, estimate, gate }`.
 * @param args From parseArgs.
 * @param config The live config (hot.config).
 * @param mods src/behavior/diary.ts, src/time.js.
 */
export function diaryDayGate(
  args: Rec,
  config: Untyped,
  {
    planDay,
    zonedEpoch,
    localDayKey,
  }: {
    planDay: (...args: Array<Untyped>) => Untyped;
    zonedEpoch: (...args: Array<Untyped>) => Untyped;
    localDayKey: (...args: Array<Untyped>) => Untyped;
  },
  nowMs: number = Date.now()
): {
  timezone: Untyped;
  date: Untyped;
  seed: Untyped;
  day: { day: string; start: number; slots: Array<number>; quiet: boolean; hunger: Array<number>; quietStreak: number };
  estimate: { requests: number; pictures: number; estimateUsd: number; detail: string };
  gate: { ok: boolean; text: string; budget: number | null };
} {
  const timezone = config?.bot?.timezone || 'UTC';
  const date = args.date ?? localDayKey(nowMs, timezone);
  const seed = args.seed ?? randomBytes(6).toString('hex');
  // `--diary-kind`: every sample is an entry at this moment, and no day is planned.
  const day = args.diaryKind
    ? {
        day: date,
        start: nowMs,
        slots: Array.from({ length: args.samples ?? 1 }, () => nowMs),
        quiet: false,
        hunger: [],
        quietStreak: 0,
      }
    : planDiaryDay({ diaryCfg: config?.diary, timezone, date, seed, planDay, zonedEpoch });
  const estimate = diaryDayEstimate({
    slots: day.slots.length,
    draw: args.draw,
    maxPictures: args.maxPictures ?? 0,
    requestsPerSlot: args.diaryKind === 'randomSet' ? RANDOM_SET_REQUESTS : DIARY_REQUESTS_PER_BRIEF,
    usdPerRequest: USD_PER_ANSWER,
  });
  const gate = spendGate({
    estimateUsd: estimate.estimateUsd,
    requests: estimate.requests,
    spend: args.spend,
    detail: estimate.detail,
  });
  if (!gate.ok) throw new CliError(`replay-cli: ${gate.text}`, { exitCode: REFUSED_EXIT });
  return { timezone, date, seed, day, estimate, gate };
}

/**
 * The `--diary-day` mode (see the header): the seeded day plan, the spend gate, then every slot's
 * diary turn run to the end into an in-memory port, every drawing call recorded. Returns
 * `{ code, result }`.
 */
export async function runDiaryDay({
  args,
  root,
  load,
  hot: liveHot,
  createHot,
  log,
  signal,
  answers,
  routes,
}: ModeCtx): Promise<{ code: Untyped; result: Rec }> {
  const mods = await loadDiaryMods(load);
  const { deepMerge } = await load('config.ts');
  const { localDayKey, planDay } = mods;
  const { createStore, createCalibrator, createLlm, createImageGen, resolveGuild } = mods;
  const { zonedEpoch } = mods;

  // The day plan, before anything is read from Discord or sent: its slots are the estimate.
  const { timezone, date, seed, day, gate } = diaryDayGate(args, liveHot.config, {
    planDay,
    zonedEpoch,
    localDayKey,
  });
  process.stderr.write(`replay-cli: ${gate.text}\n`);

  const liveData = defaultDataDir(root);
  if (!fs.existsSync(liveData)) throw new CliError(`replay-cli: no data directory at ${liveData}`);
  const outDir = path.resolve(
    root,
    args.outDir ?? `replay-diary-day-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`))
    throw new CliError('replay-cli: --out may not be under data/');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0)
    throw new CliError(`replay-cli: ${outDir} is not empty`);

  const report: Untyped = {
    date,
    timezone,
    seed,
    draw: args.draw,
    quiet: day.quiet,
    plan: { slots: day.slots.map((at) => new Date(at).toISOString()), hunger: day.hunger },
    slots: [],
    usage: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, pictures: 0 },
    stopped: null,
  };
  const reportJson = path.join(outDir, 'report.json');
  const reportMd = path.join(outDir, 'report.md');
  const writeReport = () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(reportJson, `${JSON.stringify(report, null, 1)}\n`);
    fs.writeFileSync(reportMd, renderDiaryDayReport(report));
  };
  const done = (code: Untyped) => ({
    code,
    result: {
      out: outDir,
      report: reportJson,
      date,
      seed,
      draw: args.draw,
      quiet: day.quiet,
      slots: report.slots.map((slot: Rec) => ({
        n: slot.n,
        at: slot.at,
        outcome: slot.outcome,
        ...(slot.reason ? { reason: slot.reason } : {}),
        draws: slot.draws.length,
      })),
      usage: report.usage,
      stopped: report.stopped,
    },
  });
  if (day.slots.length === 0) {
    writeReport();
    log.info('replay-cli: diary day without a slot', { date, quiet: day.quiet });
    return done(0);
  }
  const discordToken = platformToken('discord', { rootDir: root });

  let client: Untyped = null;
  let layered: Untyped = null;
  let dayRunner: ReturnType<typeof diaryReplayRunner> | null = null;
  try {
    // `--prompts <dir>` (with `--diary-kind`): the directory laid over the live prompts, as `--inner` lays it.
    if (args.prompts !== null) {
      layered = overlayPromptsHot(createHot, root, args.prompts, { mergeJson: deepMerge });
      log.info('replay-cli: diary prompt layers', { layers: diaryPromptLayers(root, args.prompts).length });
    }
    const hot = diaryHot(args, layered?.hot ?? liveHot);
    const config = hot.config;

    // The clock of the turn runner and the image client: the slot's instant, running on from there.
    const clock = { base: day.start, real: Date.now() };
    const now = () => clock.base + (Date.now() - clock.real);

    // The store and the counters: an in-memory copy, today's diary and image counts at 0.
    const { state } = unflushedStore(createStore({ dataDir: liveData, memoryDb: storeMemoryFor(liveData) }));
    state.data.imageCount = 0;
    if (state.data.paused) log.warn('replay-cli: the bot is paused; every slot will answer paused', {});

    const calibrator = createCalibrator(state.data.calibration);
    const live = args.draw === 'live';
    const routing = await replayRouting(createLlm, hot, calibrator, state, {
      root,
      answers,
      routes,
      drawing: live,
    });
    const calls: Array<Untyped> = [];
    // The persona's requests of the running turn, for `--show-request`.
    const asked: Array<{ purpose: unknown; messages: unknown }> = [];
    const recorded = recordingLlm(routing.llm, calls);
    const llm = {
      ...recorded,
      complete: (messages: Untyped, options: Untyped = {}) => {
        asked.push({ purpose: options?.purpose ?? null, messages });
        return recorded.complete(messages, options);
      },
    };
    // The embedder of the turn's recall, on the embedding role's key; an offline run embeds nothing.
    const embedder = answers ? null : mods.createEmbedder({ apiKey: '', keyOf: routing.keyOf, state });
    const embed = (texts: Array<string>, options?: unknown) =>
      embedder === null ? Promise.resolve(texts.map(() => null)) : embedder.embed(texts, options);
    const picturesDir = path.join(outDir, 'pictures');
    const realImages = createImageGen({
      apiKey: () => routing.keyOf('drawing') ?? '',
      getConfig: () => hot.config,
      state,
      now,
      ...(live ? {} : { fetchImpl: fixtureImagesFetch() }),
    });
    const images = recordingImages({
      images: realImages,
      maxPictures: live ? args.maxPictures : null,
      onPicture: live
        ? (picture, index) => {
            fs.mkdirSync(picturesDir, { recursive: true });
            const file = path.join(picturesDir, `picture-${index}.${pictureExtension(picture.mediaType)}`);
            fs.writeFileSync(file, picture.buffer);
            return path.relative(outDir, file);
          }
        : null,
    });

    // Discord over REST, every write refused; the turn's posts go to an in-memory port.
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({
      discord,
      token: discordToken,
      configuredGuildId: config.bot?.placeId || '',
      resolveGuild,
      log,
    });
    client = connection.client;
    refuseDiscordWrites(client);
    const { placeId } = connection;
    // The Discord interface's reads answer the turn; every write is kept in process (innerTurnRunner).
    const port = mods.createDiscordInterface({ client, config: () => hot.config }).port;
    const runnerOf = (stream: string) =>
      diaryReplayRunner({
        root,
        dataDir: liveData,
        hot,
        port,
        llm,
        embed,
        rng: seededRng(seed, stream),
        now,
        turnId: `t-replay-diary-${stream}`,
        images,
        // `--draw none`: the persona is told the picture was not drawn.
        ...(args.draw === 'none' ? { describePicture: notDrawnLook } : {}),
      });
    // A day draws from one stream on one runner; each sample of `--diary-kind` from its own, so sample n is the same on
    // every run.
    dayRunner = args.diaryKind ? null : runnerOf('turns');
    const dayTurns = dayRunner;
    log.info('replay-cli: diary day ready', { placeId, date, slots: day.slots.length, draw: args.draw });

    const budget = gate.budget;
    for (const [index, at] of day.slots.entries()) {
      if (signal?.aborted) {
        report.stopped = 'interrupted';
        break;
      }
      if (budget !== null && report.usage.cost >= budget) {
        report.stopped = 'spend';
        break;
      }
      clock.base = at;
      clock.real = Date.now();
      const slot = {
        n: index + 1,
        at: new Date(at).toISOString(),
        local: `${localDayKey(at, timezone)} ${new Date(at).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })}`,
        outcome: null,
        draws: [],
        messages: [],
        attachments: 0,
        requests: 0,
        cost: 0,
      };
      const fromCalls = calls.length;
      const fromDraws = images.calls.length;
      // As the live diary runs it: the diary wake, no chat; a named kind is forced as the owner's command forces it.
      const turns = dayTurns ?? runnerOf(`sample-${index + 1}`);
      const sample = await diaryReplaySample({
        turns,
        kind: args.diaryKind,
        calls,
        asked,
        request: args.showRequest ? { outDir, n: index + 1 } : null,
      });
      if (turns !== dayTurns) turns.close();
      const mine = calls.slice(fromCalls);
      const { result } = sample;
      const draws = images.calls.slice(fromDraws);
      const pictureCost = draws.reduce((sum, d) => sum + (Number.isFinite(d.result?.cost) ? d.result.cost : 0), 0);
      const before = report.usage;
      const after = addUsage(before, mine);
      report.usage = {
        ...after,
        cost: Math.round((after.cost + pictureCost) * 10000) / 10000,
        pictures: before.pictures + draws.filter((d) => d.result && !d.result.error).length,
      };
      Object.assign(slot, {
        ...sample.fields,
        ...entrySends(result),
        draws,
        requests: mine.length,
        cost: Math.round((report.usage.cost - before.cost) * 10000) / 10000,
      });
      report.slots.push(slot);
      writeReport();
      log.info('replay-cli: diary slot', {
        n: slot.n,
        outcome: slot.outcome,
        draws: draws.length,
        requests: mine.length,
      });
    }
    writeReport();
    const failed = report.slots.some((slot: Rec) => slot.outcome === 'error');
    return done(failed || report.stopped !== null ? 1 : 0);
  } finally {
    dayRunner?.close();
    layered?.hot?.close?.();
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}
