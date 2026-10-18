// Tests for tools/lib/vision-compare.mjs: the arguments, the media list, the pick from the media
// cache, the tool-local model override over the live describer (with fakes: no network), the
// USD stop and the HTML sheet's escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeOne,
  parseArgs,
  parseMediaList,
  pickFromCache,
  renderHtml,
  runComparison,
  summarizeModels,
  toolHot,
} from '../tools/lib/vision-compare.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const PNG = `data:image/png;base64,${Buffer.from('picture').toString('base64')}`;
const MP4 = `data:video/mp4;base64,${Buffer.from('clip').toString('base64')}`;

/** A live hot view with its own config and prompts; `config` is the object a reload would hold. */
function liveHot() {
  const config = {
    models: { base: { vision: 'live/vision', video: 'live/video', voice: 'live/voice', byPurpose: { describe: 'pinned/describe', reply: 'pinned/reply' } } },
    features: { mediaDescriptions: false },
    llm: { helperTimeoutMs: 1000 },
    media: { descriptionChars: 300, gif: { maxSeconds: 4, maxPerDay: 1 }, video: { maxPerDay: 1, sites: ['youtube.com'] } },
    context: { vision: {} },
  };
  return {
    config,
    prompts: { describe: 'Describe within {{maxChars}}.', 'describe-gif': 'Watch {{seconds}} s within {{maxChars}}.', 'describe-video': 'Summarise within {{maxChars}}.' },
  };
}

/** A fake OpenRouter client: records each call's model and options, answers `text` or throws `fail`. */
function fakeLlm({ text = 'a cat on a sofa', cost = 0.001, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      if (fail) throw fail;
      return { text, usage: { prompt_tokens: 100, completion_tokens: 20, cost } };
    },
  };
}

const imageFetcher = (dataUrl = PNG) => ({ fetchAsDataUrl: async () => (dataUrl ? { dataUrl, bytes: 7, contentType: 'image/png' } : null) });

test('vision-compare parseArgs: models, one media source, kinds, numbers and effort', () => {
  const args = parseArgs(['a/one', 'b/two', 'c/three', '--from-cache', '12', '--kinds', 'gif,picture', '--max-usd', '0.5', '--reasoning', 'low']);
  assert.deepEqual(args.models, ['a/one', 'b/two', 'c/three']);
  assert.equal(args.fromCache, 12);
  assert.equal(args.media, null);
  assert.deepEqual(args.kinds, ['picture', 'gif']);
  assert.equal(args.maxUsd, 0.5);
  assert.equal(args.reasoning, 'low');
  assert.equal(parseArgs(['a/one', 'b/two', '--media', 'list.json']).media, 'list.json');
  for (const argv of [
    ['a/one', '--media', 'x.json'],
    ['a/one', 'a/one', '--media', 'x.json'],
    ['a/one', 'b/two'],
    ['a/one', 'b/two', '--media', 'x.json', '--from-cache', '3'],
    ['a/one', 'b/two', '--from-cache', '0'],
    ['a/one', 'b/two', '--from-cache', '2.5'],
    ['a/one', 'b/two', '--media', 'x.json', '--kinds', 'picture,audio'],
    ['a/one', 'b/two', '--media', 'x.json', '--max-usd', '-1'],
    ['a/one', 'b/two', '--media', 'x.json', '--reasoning', 'loud'],
    ['a/one', 'b/two', '--media', 'x.json', '--spend', '3'],
    ['a/one', '<b>', '--media', 'x.json'],
  ]) {
    assert.throws(() => parseArgs(argv), CliError, argv.join(' '));
  }
});

test('vision-compare parseMediaList: entries become the live describer items, problems are named by index', () => {
  const raw = [
    { kind: 'picture', url: 'https://cdn.example.com/a.png', label: 'café' },
    { kind: 'gif', url: 'https://media.example.com/b.mp4' },
    { kind: 'video', url: 'https://www.youtube.com/watch?v=abc' },
    { kind: 'video', url: 'https://files.example.com/clip.mp4' },
    { kind: 'emoji', url: 'https://cdn.discordapp.com/emojis/1.webp' },
    { kind: 'sticker', url: 'https://media.discordapp.net/stickers/2.png' },
  ];
  const { items, errors } = parseMediaList(raw, { videoSites: ['youtube.com'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((i) => [i.kind, i.item.kind, i.item.source]), [
    ['picture', 'image', 'attachment'],
    ['gif', 'gif', 'attachment'],
    ['video', 'link', 'link'],
    ['video', 'video', 'attachment'],
    ['emoji', 'emoji', 'emoji'],
    ['sticker', 'sticker', 'sticker'],
  ]);
  assert.equal(items[0].label, 'café');
  assert.equal(items[2].item.site, 'youtube.com');
  assert.equal(new Set(items.map((i) => i.item.itemId)).size, items.length);

  const bad = parseMediaList(
    [
      'x',
      { kind: 'audio', url: 'https://a.example/x.mp3' },
      { kind: 'picture', url: 'javascript:alert(1)' },
      { kind: 'picture', url: 'https://a.example/x.png', label: 'x'.repeat(201) },
      { kind: 'video', url: 'https://unknown.example/watch/1' },
    ],
    { videoSites: ['youtube.com'] },
  );
  assert.equal(bad.items.length, 0);
  assert.deepEqual(bad.errors.map((e) => e.split(':')[0]), ['entry 0', 'entry 1', 'entry 2', 'entry 3', 'entry 4']);
  assert.equal(parseMediaList({}).errors.length, 1);
  const onlyGifs = parseMediaList(raw, { videoSites: ['youtube.com'], kinds: ['gif'] });
  assert.deepEqual(onlyGifs.items.map((i) => i.kind), ['gif']);
});

test('vision-compare pickFromCache: newest first per kind, one kind after another, only real descriptions', () => {
  const cache = {
    '111111111111111111': { text: 'p old', ts: 1 },
    '222222222222222222': { text: 'p new', ts: 50 },
    'link:abc': { text: 'p mid', ts: 10, usedAt: 40 },
    '333333333333333333#e0': { text: 'g', ts: 5, gif: true, watched: true },
    'video:444444444444444444': { text: 'v', ts: 7, watched: true },
    'video:video:url:def': { text: 'v2', ts: 9, watched: true },
    'video:555555555555555555': { miss: true, ts: 60, reason: 'error' },
    'video:666:q:aa': { text: 'answer', ts: 70 },
    'emoji:777': { text: 'e', ts: 3 },
    'sticker:888': { text: 's', ts: 4 },
    'video:url:999': { text: 'thumb', ts: 2 },
    '123123123123123123': { miss: true, ts: 80 },
    'search:xyz': { text: 'web', ts: 90 },
  };
  const picked = pickFromCache(cache, { n: 7 });
  assert.deepEqual(picked.map((p) => p.key), [
    '222222222222222222',
    '333333333333333333#e0',
    'video:video:url:def',
    'emoji:777',
    'sticker:888',
    'link:abc',
    'video:444444444444444444',
  ]);
  assert.equal(picked[2].itemId, 'video:url:def');
  assert.equal(picked[6].itemId, '444444444444444444');
  assert.deepEqual(pickFromCache(cache, { n: 10, kinds: ['picture'] }).map((p) => p.key), ['222222222222222222', 'link:abc', 'video:url:999', '111111111111111111']);
  assert.equal(pickFromCache(cache, { n: 100 }).length, 9);
});

test('vision-compare toolHot: the model is overridden in the tool view only', () => {
  const base = liveHot();
  const before = structuredClone(base.config);
  const view = toolHot(base, { model: 'cand/model' });
  assert.equal(view.config.models.base.vision, 'cand/model');
  assert.equal(view.config.models.base.video, 'cand/model');
  assert.equal(view.config.models.base.byPurpose.describe, undefined);
  assert.equal(view.config.models.base.byPurpose.reply, 'pinned/reply');
  assert.equal(view.config.features.mediaDescriptions, true);
  assert.equal(view.prompts, base.prompts);
  assert.deepEqual(base.config, before);
  // A live reload is seen by the view at the next read.
  base.config.media.descriptionChars = 120;
  assert.equal(view.config.media.descriptionChars, 120);
});

test('vision-compare describeOne: a picture goes through the live describer with the overridden model', async () => {
  const base = liveHot();
  const before = structuredClone(base.config);
  const llm = fakeLlm({ cost: 0.002 });
  const entry = parseMediaList([{ kind: 'picture', url: 'https://cdn.example.com/a.png' }]).items[0];
  let clock = 1000;
  const now = () => (clock += 10);
  const { result } = await withCapturedLogs(() => describeOne({ base, model: 'cand/model', entry, guildId: 'g1', llm, imageFetcher: imageFetcher(), now, reasoning: 'minimal' }));
  assert.equal(result.ok, true);
  assert.equal(result.text, 'a cat on a sofa');
  assert.equal(result.error, null);
  assert.equal(result.costUsd, 0.002);
  assert.equal(result.promptTokens, 100);
  assert.equal(result.completionTokens, 20);
  assert.ok(result.latencyMs > 0);
  assert.equal(result.preview.dataUrl, PNG);
  assert.equal(llm.calls.length, 1);
  const options = llm.calls[0].options;
  assert.equal(options.model, 'cand/model');
  assert.equal(options.role, 'vision');
  assert.equal(options.origin, 'vision-compare');
  assert.equal(options.countAgainstDailyCap, false);
  assert.equal(options.cache, false);
  assert.deepEqual(options.reasoning, { effort: 'minimal' });
  assert.deepEqual(base.config, before);
});

test('vision-compare describeOne: a GIF is watched on the video role, each call on counters of its own', async () => {
  const base = liveHot();
  const llm = fakeLlm({ text: 'reaction: delight\naction: a dog spins\ntext: none' });
  const videoFetcher = { fetchGif: async () => ({ ok: true, dataUrl: MP4, seconds: 3, bytes: 4 }) };
  const entry = parseMediaList([{ kind: 'gif', url: 'https://media.example.com/b.mp4' }]).items[0];
  const { result } = await withCapturedLogs(() => describeOne({ base, model: 'cand/model', entry, guildId: 'g1', llm, imageFetcher: imageFetcher(), videoFetcher }));
  assert.equal(result.ok, true);
  assert.equal(result.text, 'a dog spins');
  assert.equal(result.mode, 'watched');
  assert.equal(llm.calls[0].options.model, 'cand/model');
  assert.equal(llm.calls[0].options.role, 'video');
  assert.equal(result.preview.dataUrl, MP4);
  // media.gif.maxPerDay is 1: a second call is watched too, its daily counter a fresh one.
  const again = (await withCapturedLogs(() => describeOne({ base, model: 'cand/model', entry, guildId: 'g1', llm, imageFetcher: imageFetcher(), videoFetcher }))).result;
  assert.equal(again.mode, 'watched');
});

test('vision-compare describeOne: a failure carries its code', async () => {
  const base = liveHot();
  const entry = parseMediaList([{ kind: 'picture', url: 'https://cdn.example.com/a.png' }]).items[0];
  const failed = Object.assign(new Error('upstream'), { statusCode: 503 });
  const run = (llm, fetcher) => withCapturedLogs(() => describeOne({ base, model: 'cand/model', entry, guildId: 'g1', llm, imageFetcher: fetcher }));
  const http = (await run(fakeLlm({ fail: failed }), imageFetcher())).result;
  assert.equal(http.ok, false);
  assert.equal(http.error, 'http-503');
  const download = (await run(fakeLlm(), imageFetcher(null))).result;
  assert.equal(download.error, 'download');
  const empty = (await run(fakeLlm({ text: '   ' }), imageFetcher())).result;
  assert.equal(empty.error, 'empty');
});

test('vision-compare runComparison: no item starts once the cost has passed --max-usd', async () => {
  const items = [1, 2, 3].map((n) => ({ id: `item-${n}`, kind: 'picture', url: 'https://a.example/x.png', label: null }));
  const seen = [];
  const runOne = async (model, item) => {
    seen.push(`${item.id}:${model}`);
    if (item.id === 'item-2' && model === 'b') throw new TypeError('boom');
    return { model, ok: true, text: 't', error: null, mode: null, latencyMs: 10, requests: 1, promptTokens: 1, completionTokens: 1, costUsd: 0.4, preview: null };
  };
  const outcome = await runComparison({ items, models: ['a', 'b'], maxUsd: 1, runOne });
  assert.deepEqual(seen, ['item-1:a', 'item-1:b', 'item-2:a', 'item-2:b']);
  assert.equal(outcome.stopped, 'max-usd');
  assert.equal(outcome.skipped, 1);
  assert.equal(outcome.rows.length, 2);
  assert.equal(outcome.rows[1].cells[1].error, 'TypeError');
  const summary = summarizeModels(outcome.rows, ['a', 'b']);
  assert.deepEqual(summary.map((s) => [s.model, s.items, s.failures, s.costUsd]), [
    ['a', 2, 0, 0.8],
    ['b', 2, 1, 0.4],
  ]);
  const all = await runComparison({ items, models: ['a'], maxUsd: 5, runOne });
  assert.equal(all.stopped, null);
  assert.equal(all.rows.length, 3);
});

test('vision-compare renderHtml: every outside text is escaped and only media data URLs are inlined', () => {
  const evil = '<script>alert(1)</script>';
  const rows = [
    {
      item: { id: 'item-1', kind: 'picture', url: 'https://a.example/x.png?a=1&b="2"', label: `"><img src=x onerror=alert(1)>` },
      preview: { dataUrl: PNG },
      cells: [
        { model: 'a/one', ok: true, text: evil, error: null, mode: null, latencyMs: 12, promptTokens: 3, completionTokens: 4, costUsd: 0.01 },
        { model: '<b>two</b>', ok: false, text: null, error: '<i>x</i>', mode: null, latencyMs: 5, promptTokens: 0, completionTokens: 0, costUsd: 0 },
      ],
    },
    {
      item: { id: 'item-2', kind: 'video', url: 'javascript:alert(1)', label: 'Ελληνικά' },
      preview: { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' },
      cells: [{ model: 'a/one', ok: true, text: 'fine', error: null, mode: 'one frame', latencyMs: 1, promptTokens: 1, completionTokens: 1, costUsd: 0 }],
    },
  ];
  const html = renderHtml({ at: '2026-10-16T00:00:00.000Z', models: ['a/one', '<b>two</b>'], rows, summary: summarizeModels(rows, ['a/one', '<b>two</b>']), source: 'media file', stopped: 'max-usd', skipped: 2 });
  assert.equal(/<script/i.test(html), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<b>two</b>'), false);
  assert.equal(html.includes('<i>x</i>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes(`<img src="${PNG}"`));
  assert.ok(html.includes('href="https://a.example/x.png?a=1&amp;b=&quot;2&quot;"'));
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('data:text/html'), false);
  assert.ok(html.includes('Ελληνικά'));
  assert.ok(html.includes('error: &lt;i&gt;x&lt;/i&gt;'));
  assert.ok(html.includes('stopped: max-usd'));
});
