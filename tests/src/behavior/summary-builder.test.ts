// The summary builder: the step after a web search, web results in and a note out.
// Contract, module src/behavior/summary-builder.ts:
//   `parseSummaryNote(raw)` resolves `{ text }`; the single word `none` is no note, a first `stretch:` line is no part of it
//   `createSummaryBuilder({ hot, llm, now })(evidence, limits)` takes `{ query, results }` and `limits`
//   `{ maxChars, maxOutputTokens }`; it resolves `{ status: 'note' | 'none' | 'failed' | 'no-prompt', text, reason? }`
//   and never rejects; it reads `prompts['summarize/search']` and sends on the analyzer
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryBuilder, parseSummaryNote } from '../../../src/behavior/summary-builder.ts';
import { DailyCapError } from '../../../src/llm/openrouter.ts';
import { createLookup } from '../../../src/web/lookup.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { NOW } from '../../fixtures/recall-run-kit.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

const LIMITS = { maxChars: 100, maxOutputTokens: 50 };

const WEB = {
  query: 'tomato frost',
  results: [{ title: 'Frost dates', url: 'https://example.org/frost', snippet: 'below zero', age: '2 days ago' }],
};

function builder(options: { answer?: string | Error; prompts?: Record<string, unknown> | null } = {}) {
  const calls: Array<{ system: string; user: string; options: Record<string, unknown> }> = [];
  const build = createSummaryBuilder({
    hot: {
      config: {
        bot: { timezone: 'UTC' },
        llm: {},
        // Web evidence condenses on the analyzer, so a `search` chain stays here only to show it is not read.
        models: { routes: chainsOf({ analyzer: 'x/analyzer', search: 'x/search' }) },
      },
      prompts: {
        labels,
        ...(options.prompts === null
          ? {}
          : (options.prompts ?? { 'summarize/search': 'Web on {{query}}, at most {{maxChars}}.' })),
      },
    },
    llm: {
      complete: (messages: Array<{ content: unknown }>, request: Record<string, unknown>) => {
        calls.push({ system: String(messages[0]?.content), user: String(messages[1]?.content), options: request });
        if (options.answer instanceof Error) return Promise.reject(options.answer);
        return Promise.resolve({ text: options.answer ?? 'She said it on Monday.' });
      },
    },
    now: () => NOW,
  });
  return { build, calls };
}

test('web evidence reads its own prompt on the analyzer under the purpose search-summary', async () => {
  // Web evidence condenses on the analyzer, and a `search` chain is not read.
  // Bug: the web note goes out on a chain the routing does not have, or takes the model of a retired setting.
  const { build, calls } = builder();
  await build(WEB, LIMITS);
  assert.equal(calls[0]?.system, 'Web on tomato frost, at most 100.');
  const sent = calls[0]?.options ?? {};
  assert.deepEqual([sent.role, sent.purpose, sent.model], ['analyzer', 'search-summary', 'x/analyzer']);
  const first = calls[0];
  assert.ok(first?.user.includes('https://example.org/frost'));
  assert.ok(first?.user.includes('below zero'));
});

test('none from a web note is no note', async () => {
  // Bug: the picks' word for nothing is shown to the persona as the finding.
  const { build } = builder({ answer: 'none' });
  const note = await build(WEB, LIMITS);
  assert.deepEqual([note.status, note.text], ['none', null]);
});

// A note is kept whole, with no limit of characters.
test('a long web note is kept whole', async () => {
  // Bug: the limit creeps back and cuts the finding the persona reads.
  const answer = 'Μια πρόταση. '.repeat(100).trim();
  const { build } = builder({ answer });
  const note = await build(WEB, LIMITS);
  assert.equal(note.status, 'note');
  assert.equal(note.text, answer);
  assert.ok(answer.length > LIMITS.maxChars);
});

test('an empty web answer is no note', async () => {
  // Bug: an empty string travels on as a found text.
  const { build } = builder({ answer: '  ' });
  const note = await build(WEB, LIMITS);
  assert.deepEqual([note.status, note.reason], ['none', 'empty']);
});

test('a failed web request resolves as failed with its reason', async () => {
  // Bug: the cap's error rejects into a turn, or a failure reads as nothing found.
  const { build } = builder({ answer: new DailyCapError() });
  const note = await build(WEB, LIMITS);
  assert.equal(note.status, 'failed');
  assert.equal(note.reason, 'daily-cap');
  assert.equal(note.text, null);
});

test('a web note leaves its text out of the logs', async () => {
  // Bug: a search writes what it found to the journal.
  const { build } = builder({ answer: 'μυστικό εύρημα' });
  const { logs } = await withCapturedLogs(() => build(WEB, LIMITS));
  assert.equal(JSON.stringify(logs).includes('μυστικό εύρημα'), false);
});

test('a web note with no prompt costs no request', async () => {
  // Bug: a blank system message goes out and the model improvises a finding.
  const { build, calls } = builder({ prompts: null });
  assert.equal((await build(WEB, LIMITS)).status, 'no-prompt');
  assert.equal(calls.length, 0);
});

test('a first stretch line is no part of a web note, a later one is', async () => {
  // Bug: a line naming a numbered section is shown to the persona as part of the finding.
  const { build } = builder({ answer: 'stretch: 1\nFrost comes in November.' });
  assert.equal((await build(WEB, LIMITS)).text, 'Frost comes in November.');
  assert.equal(parseSummaryNote('Frost comes.\nstretch: 1').text, 'Frost comes.\nstretch: 1');
});

test('parseSummaryNote takes none whatever its case and punctuation', () => {
  // Bug: a model's `None.` is published as the finding.
  for (const raw of ['none', 'None', 'NONE.', '"none"', 'stretch: 1\nnone', '', '  ', null]) {
    assert.deepEqual(parseSummaryNote(raw), { text: null }, String(raw));
  }
});

test('parseSummaryNote keeps a note that only starts with none', () => {
  // Bug: a real answer is thrown away for its first word.
  const raw = 'None of them said it, Ana only asked.';
  assert.equal(parseSummaryNote(raw).text, raw);
});

test('a web search whose summary answers none gives the persona no text', async () => {
  // Bug: lookup keeps its own summary path, so the word reaches the diary and the persona as a finding.
  const lookup = createLookup(
    wrongly<Parameters<typeof createLookup>[0]>({
      hot: {
        config: {
          llm: { timeoutMs: 300_000 },
          models: { routes: chainsOf({ analyzer: 'x/reason', search: 'x/search' }) },
          web: {
            acceptLanguage: 'el',
            links: { fetchTimeoutMs: 10_000 },
            quickSearch: {
              enabled: true,
              engine: 'brave',
              maxOutputTokens: 400,
              cacheHours: 24,
              timeoutMs: 10_000,
            },
          },
        },
        prompts: { 'summarize/search': 'The query: {{query}}. Up to {{maxChars}} characters.' },
      },
      store: { ...objectMediaCache({}) },
      llm: { complete: () => Promise.resolve({ text: 'none', usage: {}, estimated: 5 }) },
      state: { data: {}, markDirty() {} },
      pageFetcher: { fetchText: () => Promise.reject(new Error('no page in this test')) },
      searches: {
        brave: {
          search: () =>
            Promise.resolve({ ok: true, results: [{ title: 'One', url: 'https://example.org/one', snippet: 'a' }] }),
        },
      },
      keys: { brave: 'test-key' },
      now: () => NOW,
    })
  );
  const result = await lookup.search('g1', 'Qui a gagné ?');
  assert.equal(result?.text.trim() ?? '', '');
});
