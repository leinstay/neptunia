#!/usr/bin/env node
// Operations tool: describe the same media with two or more vision/video models through the
// persona's own describer and put the answers side by side. Exists so a candidate for
// `models.base.vision` / `models.base.video` is judged on the server's real pictures, GIFs and videos, by
// the very code path the bot uses, before the owner switches the role.
//
//   cd /opt/neptunia/app && node tools/vision-compare.mjs <modelA> <modelB> [more models...]
//        (--media <file.json> | --from-cache N) [--kinds picture,gif,video,emoji,sticker]
//        [--out <file.html>] [--max-usd 2] [--reasoning <effort>] [--guild <id>] [--data <dir>]
//
// Media. `--media`: a JSON list `[{ kind, url, label? }]` (tools/lib/vision-compare.mjs#parseMediaList;
// a GIF's url is its animation, a video's a video file or a link of `media.video.sites`).
// `--from-cache N`: N recent entries of the guild's media cache (data/guilds/<id>/media.json,
// read only), spread across the kinds (pickFromCache). The cache keeps descriptions, not URLs,
// so each picked entry is found again as the live media recache finds it
// (src/memory/gif-recache.js): an emoji from its id; a library GIF from its library entry's
// message; anything else from the messages the record says may hold it, read again over the
// Discord REST API (GET only, no gateway, DISCORD_TOKEN from .env), newest first, at most
// MAX_MESSAGE_READS messages. An entry not found again is counted and left out.
//
// Each item with each model: tools/lib/vision-compare.mjs#describeOne -- the live describer
// (src/memory/describe.js: `describe` for a picture, an emoji, a sticker and a GIF, which is
// watched first and falls back to one frame as live; `describeVideo` with `force` for a video)
// over a tool-local hot view whose `models.base.vision` and `models.base.video` are the model (the live
// config is never changed), provider routing as configured (`llm.providerByModel`), an empty
// in-memory media cache and throwaway daily counters. Requests spend OPENROUTER_SIM_KEY
// (tools/lib/cli.mjs#simKey), are marked `origin: vision-compare` and never count against
// `llm.maxRequestsPerDay`; the per-request token caps stay on. `--reasoning <effort>` sends
// `{ effort }` as the reasoning settings of every request.
//
// Rails: one request at a time; no item is started once the summed cost has passed
// `--max-usd` (default 2). Output: one self-contained HTML sheet, by default
// data/vision-compare/<time>.html (`--out` must stay under data/vision-compare/; nothing else
// is written), and a per-model summary on stdout. Logs carry ids, codes and counts only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defaultDataDir, privateDirOf, resolveGuildId, runCli, simKey } from './lib/cli.mjs';
import {
  ORIGIN,
  describeOne,
  lookupSince,
  parseArgs,
  parseMediaList,
  pickFromCache,
  renderHtml,
  runComparison,
  summarizeModels,
} from './lib/vision-compare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** At most this many messages are read again from Discord to find the picked cache entries. */
const MAX_MESSAGE_READS = 200;

/** The file time of a sheet: an ISO time with `:` and `.` replaced. */
function fileTime(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** `file` resolved, refused when it is not under `dataDir/vision-compare`. */
function outPath(dataDir, cwd, given, nowMs) {
  const base = path.join(dataDir, 'vision-compare');
  const file = given ? path.resolve(cwd, given) : path.join(base, `${fileTime(nowMs)}.html`);
  if (!file.startsWith(`${base}${path.sep}`))
    throw new CliError('vision-compare: the output must stay under data/vision-compare/');
  return file;
}

/** A JSON file read, or `fallback` when it is missing; a CliError when it does not parse. */
function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`vision-compare: ${file} is not valid JSON`);
  }
}

/** A REST-only Discord client (no login, no gateway); every request but GET is refused. As tools/recall-eval.mjs connects. */
async function connectDiscord(token) {
  const { Client } = await import('discord.js');
  const client = new Client({ intents: [] });
  client.rest.setToken(token);
  const restRequest = client.rest.request.bind(client.rest);
  client.rest.request = (options) => {
    if (String(options?.method ?? 'GET').toUpperCase() !== 'GET')
      throw new Error('vision-compare: only GET requests reach Discord');
    return restRequest(options);
  };
  return client;
}

/**
 * The picked cache entries as describer items (see the header): `{ items, unlocated }`.
 * Read only: the GIF library and the record are read, never written; Discord over GET.
 */
async function resolveFromCache({ picked, dataDir, guildId, hot, nowMs, token }) {
  const { collectPictures, collectVideos } = await import('../src/media/classify.js');
  const { emojiUrl } = await import('../interfaces/discord/collect.js');
  const { normalizeMessage } = await import('../interfaces/discord/index.js');
  const { normalizeGifs } = await import('../src/memory/gifs.js');
  const { recordFinder, snowflakeMs } = await import('../src/memory/gif-recache.js');
  const found = new Map();
  for (const p of picked) {
    if (p.kind === 'emoji')
      found.set(p.key, {
        source: 'emoji',
        itemId: p.itemId,
        kind: 'emoji',
        url: emojiUrl(p.itemId.slice('emoji:'.length)),
        name: null,
      });
  }
  // By cache key: a video's summary and its poster share one item id.
  const wanted = new Map(picked.filter((p) => !found.has(p.key)).map((p) => [p.key, p]));
  const wantsItem = (itemId) => [...wanted.values()].some((p) => p.itemId === itemId);
  if (wanted.size > 0 && !token) {
    process.stderr.write(
      `vision-compare: no DISCORD_TOKEN (.env): ${wanted.size} cache entr(ies) other than emoji cannot be found again\n`
    );
  }
  if (wanted.size > 0 && token) {
    const client = await connectDiscord(token);
    const videoSites = hot.config.media?.video?.sites ?? [];
    let reads = 0;
    const readMessage = async (channelId, messageId) => {
      reads += 1;
      try {
        const channel = await client.channels.fetch(channelId);
        const message = await channel?.messages?.fetch(messageId);
        if (!message) return null;
        return normalizeMessage(message, null, {
          embedTextChars: hot.config.media?.embedTextChars,
          videoSites,
          maxUrlChars: hot.config.context?.maxUrlChars,
        });
      } catch (err) {
        process.stderr.write(
          `vision-compare: message read failed (${err?.name ?? 'Error'}) channel ${channelId} message ${messageId}\n`
        );
        return null;
      }
    };
    const take = (normalized) => {
      const pictures = collectPictures(normalized);
      const videos = collectVideos(normalized, { videoSites });
      for (const [key, p] of [...wanted]) {
        const item = (p.kind === 'video' ? videos : pictures).find((v) => v.itemId === p.itemId);
        if (!item) continue;
        found.set(key, item);
        wanted.delete(key);
      }
    };
    try {
      // A library GIF from its library entry's message.
      const gifs = normalizeGifs(readJson(path.join(dataDir, 'guilds', guildId, 'gifs.json'), {}));
      for (const entry of Object.values(gifs.entries)) {
        if (!wantsItem(entry.itemId) || !entry.channelId || !entry.messageId || reads >= MAX_MESSAGE_READS) continue;
        const normalized = await readMessage(entry.channelId, entry.messageId);
        if (normalized) take(normalized);
      }
      // The rest from the messages the record says may hold them, newest first.
      if (wanted.size > 0) {
        const { createRecord } = await import('../src/memory/record.js');
        const { readOnlyMemory } = await import('./lib/memory-read.mjs');
        // Iteration only: the memory database read only.
        const memory = readOnlyMemory(dataDir);
        const record = createRecord({ dataDir, memoryDb: memory.memoryDb });
        const finder = recordFinder(
          [...wanted.values()].map((p) => p.itemId),
          lookupSince(picked, nowMs)
        );
        const refs = new Map();
        for await (const line of record.iterate(guildId, { from: new Date(finder.fromMs).toISOString() })) {
          if (!finder.matches(line)) continue;
          const at = snowflakeMs(line.messageId) ?? Date.parse(line.occurredAt);
          refs.set(line.messageId, {
            messageId: line.messageId,
            channelId: line.scope.channel,
            at: Number.isFinite(at) ? at : 0,
          });
        }
        for (const ref of [...refs.values()].sort((a, b) => b.at - a.at)) {
          if (wanted.size === 0 || reads >= MAX_MESSAGE_READS) break;
          const normalized = await readMessage(ref.channelId, ref.messageId);
          if (normalized) take(normalized);
        }
      }
    } finally {
      await client.destroy().catch(() => {});
    }
  }
  const items = [];
  for (const p of picked) {
    const item = found.get(p.key);
    if (item) items.push({ id: p.key, kind: p.kind, url: item.url, label: `${p.kind} ${p.key}`, item });
  }
  return { items, unlocated: picked.length - items.length };
}

/**
 * The whole tool: the per-model summary on stdout; the sheet written under data/vision-compare/.
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number }} [options]
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now } = {}) {
  const args = parseArgs(argv);
  const dataDir = args.data ? path.resolve(cwd, args.data) : defaultDataDir(ROOT);
  const file = outPath(dataDir, cwd, args.out, now());

  const { createHot } = await import('../src/hot.js');
  const hot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  try {
    // The keys (OPENROUTER_SIM_KEY, DISCORD_TOKEN, YOUTUBE_API_KEY) from .env; never printed.
    const { loadDotEnv } = await import('../src/config.js');
    loadDotEnv(privateDirOf(ROOT));
    const configuredGuild = hot.config.bot?.guildId || undefined;
    let guildId;
    let items;
    let source;
    const notes = [];
    if (args.fromCache !== null) {
      guildId = resolveGuildId(dataDir, args.guild ?? configuredGuild);
      const cache = readJson(path.join(dataDir, 'guilds', guildId, 'media.json'), {});
      const picked = pickFromCache(cache, { n: args.fromCache, kinds: args.kinds });
      const token = (process.env.DISCORD_TOKEN || '').trim() || null;
      const resolved = await resolveFromCache({ picked, dataDir, guildId, hot, nowMs: now(), token });
      items = resolved.items;
      source = `media cache, ${picked.length} picked`;
      if (resolved.unlocated > 0) notes.push(`${resolved.unlocated} picked cache entr(ies) not found again`);
      process.stderr.write(
        `vision-compare: ${picked.length} cache entr(ies) picked, ${items.length} found again, ${resolved.unlocated} not\n`
      );
    } else {
      const raw = readJson(path.resolve(cwd, args.media), undefined);
      if (raw === undefined) throw new CliError(`vision-compare: cannot read the media file ${args.media}`);
      const parsed = parseMediaList(raw, { videoSites: hot.config.media?.video?.sites ?? [], kinds: args.kinds });
      if (parsed.errors.length > 0)
        throw new CliError(
          `vision-compare: the media file has ${parsed.errors.length} problem(s):\n${parsed.errors.slice(0, 20).join('\n')}`
        );
      items = parsed.items;
      source = 'media file';
      guildId = args.guild ?? configuredGuild ?? ORIGIN;
    }
    if (items.length === 0) throw new CliError('vision-compare: no media to describe');
    process.stderr.write(
      `vision-compare: ${items.length} item(s) x ${args.models.length} model(s), one request at a time (a GIF up to 2), none started once the cost passes ${args.maxUsd} USD\n`
    );

    const { createLlm } = await import('../src/llm/openrouter.js');
    const { createCalibrator } = await import('../src/llm/tokens.js');
    const { createImageFetcher } = await import('../src/media/fetch-image.js');
    const { createVideoFetcher } = await import('../src/media/fetch-video.js');
    const apiKey = simKey(ORIGIN);
    const stored = readJson(path.join(dataDir, 'state.json'), {});
    const calibrator = createCalibrator(stored?.calibration);
    // Throwaway counters; per-role keys are not looked up (env {}): the simulator key pays.
    const llm = createLlm({
      apiKey,
      env: {},
      getConfig: () => hot.config,
      calibrator,
      state: { data: {}, markDirty() {} },
    });
    const imageFetcher = createImageFetcher();
    const videoFetcher = createVideoFetcher();
    const youtubeApiKey = (process.env.YOUTUBE_API_KEY || '').trim() || null;

    const outcome = await runComparison({
      items,
      models: args.models,
      maxUsd: args.maxUsd,
      runOne: (model, entry) =>
        describeOne({
          base: hot,
          model,
          entry,
          guildId,
          llm,
          reasoning: args.reasoning,
          imageFetcher,
          videoFetcher,
          youtubeApiKey,
          now,
        }),
      onCell: (entry, cell, index) =>
        process.stderr.write(
          `vision-compare: ${index + 1}/${items.length} ${entry.kind} ${entry.id} ${cell.model} ${cell.ok ? 'ok' : `error ${cell.error}`} ${cell.latencyMs ?? '-'} ms ${cell.costUsd.toFixed(4)} USD\n`
        ),
    });
    const summary = summarizeModels(outcome.rows, args.models);
    const at = new Date(now()).toISOString();
    const html = renderHtml({
      at,
      models: args.models,
      rows: outcome.rows,
      summary,
      stopped: outcome.stopped,
      skipped: outcome.skipped,
      source,
      reasoning: args.reasoning,
      notes,
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);

    const lines = ['| model | items | failures | total USD | median ms |', '|---|---|---|---|---|'];
    for (const s of summary)
      lines.push(`| ${s.model} | ${s.items} | ${s.failures} | ${s.costUsd.toFixed(4)} | ${s.medianLatencyMs ?? '-'} |`);
    if (outcome.stopped) lines.push('', `stopped: ${outcome.stopped}, ${outcome.skipped} item(s) not described`);
    lines.push('', file);
    return `${lines.join('\n')}\n`;
  } finally {
    hot.close?.();
  }
}

runCli(import.meta.url, main);
