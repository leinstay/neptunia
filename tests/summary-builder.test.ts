// The summary builder: the step after a search. One contract, evidence in and a bounded note out, over two prompt files,
// because chat stretches and web results read differently. Every caller goes through it.
// Contract, plan 2026-11-04-cli-and-memory B4 and B9, module src/behavior/summary-builder.ts:
//   `parseSummaryNote(raw, { maxChars, count })` resolves `{ text, stretch }`; the single word `none` is no note
//   `createSummaryBuilder({ hot, llm, now })(evidence, limits)` takes `{ kind: 'history', selfName, question, windows,
//   people?, memory? }` or `{ kind: 'web', query, results }`, and `limits` `{ maxChars, maxOutputTokens, signal?, timeoutMs? }`;
//   it resolves `{ status: 'note' | 'none' | 'failed' | 'no-prompt', text, stretch, reason? }` and never rejects
//   history reads `prompts['recall-summary']` on the analyzer, web reads `prompts['search-summary']` on the `search` role
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecall } from '../src/behavior/recall-run.ts';
import { createSummaryBuilder, parseSummaryNote } from '../src/behavior/summary-builder.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import { DailyCapError } from '../src/llm/openrouter.ts';
import { createLookup } from '../src/web/lookup.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { channel as channelInfo } from './fixtures/reads-rig.ts';
import { eventOfLine, neutralSearch } from './fixtures/recall-lines.ts';
import {
  GUILD,
  NOW,
  PROMPT,
  RABBIT_LINES,
  RABBIT_SERVER,
  config as recallConfig,
  rabbitAnswers,
} from './fixtures/recall-run-kit.ts';

const LIMITS = { maxChars: 100, maxOutputTokens: 50 };

const HISTORY = {
  kind: 'history' as const,
  selfName: 'Nova',
  question: { authorName: 'Eleni', content: 'ποιος το είπε;' },
  windows: [
    {
      placeId: 'c1',
      channelName: 'general',
      hitIds: [],
      messages: [
        {
          id: 'm1',
          placeId: 'c1',
          authorId: 'u1',
          authorName: 'Ana',
          content: 'το είπα εγώ',
          ts: NOW - 60_000,
          self: false,
          bot: false,
          reactions: [],
          attachments: [],
          stickers: [],
          emojis: [],
          links: [],
          forwarded: [],
        },
      ],
    },
  ],
};

const WEB = {
  kind: 'web' as const,
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
        models: { base: { analyzer: 'x/analyzer' } },
        web: { search: { model: 'x/search' } },
      },
      prompts: {
        labels,
        ...(options.prompts === null
          ? {}
          : (options.prompts ?? {
              'recall-summary': 'History for {{name}}, at most {{answerChars}}.',
              'search-summary': 'Web on {{query}}, at most {{maxChars}}.',
            })),
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

test('chat evidence reads its own prompt on the analyzer', async () => {
  // Bug: one prompt for both, so a web note is written under the rules of chat stretches.
  const { build, calls } = builder();
  const note = await build(HISTORY, LIMITS);
  assert.equal(calls[0]?.system, 'History for Nova, at most 100.');
  assert.equal(calls[0]?.options.role, 'analyzer');
  assert.ok(calls[0]?.user.includes('το είπα εγώ'));
  assert.deepEqual([note.status, note.text], ['note', 'She said it on Monday.']);
});

test('web evidence reads its own prompt on the search role with the search model', async () => {
  // Bug: the merge puts the web note on the analyzer, past the key the owner bound to quick search.
  const { build, calls } = builder();
  await build(WEB, LIMITS);
  assert.equal(calls[0]?.system, 'Web on tomato frost, at most 100.');
  assert.equal(calls[0]?.options.role, 'search');
  assert.equal(calls[0]?.options.model, 'x/search');
  assert.ok(calls[0]?.user.includes('https://example.org/frost'));
  assert.ok(calls[0]?.user.includes('below zero'));
});

for (const evidence of [HISTORY, WEB]) {
  test(`none from a ${evidence.kind} note is no note`, async () => {
    // Bug: the picks' word for nothing is shown to the persona as the finding.
    const { build } = builder({ answer: 'none' });
    const note = await build(evidence, LIMITS);
    assert.deepEqual([note.status, note.text, note.stretch], ['none', null, null]);
  });

  test(`a ${evidence.kind} note stays inside its bound`, async () => {
    // Bug: one path clamps and the other trusts the model, so a long note overruns the block.
    const { build } = builder({ answer: 'Μια πρόταση. '.repeat(100) });
    const note = await build(evidence, LIMITS);
    assert.equal(note.status, 'note');
    assert.ok([...(note.text ?? '')].length <= LIMITS.maxChars, String(note.text?.length));
  });

  test(`an empty ${evidence.kind} answer is no note`, async () => {
    // Bug: an empty string travels on as a found text.
    const { build } = builder({ answer: '  ' });
    assert.equal((await build(evidence, LIMITS)).status, 'none');
  });

  test(`a failed ${evidence.kind} request resolves as failed with its reason`, async () => {
    // Bug: the cap's error rejects into a turn, or a failure reads as nothing found.
    const { build } = builder({ answer: new DailyCapError() });
    const note = await build(evidence, LIMITS);
    assert.equal(note.status, 'failed');
    assert.equal(note.reason, 'daily-cap');
    assert.equal(note.text, null);
  });

  test(`a ${evidence.kind} note with no prompt costs no request`, async () => {
    // Bug: a blank system message goes out and the model improvises a finding.
    const { build, calls } = builder({ prompts: null });
    assert.equal((await build(evidence, LIMITS)).status, 'no-prompt');
    assert.equal(calls.length, 0);
  });

  test(`a ${evidence.kind} note leaves its text out of the logs`, async () => {
    // Bug: a search over private history writes what it found to the journal.
    const { build } = builder({ answer: 'μυστικό εύρημα' });
    const { logs } = await withCapturedLogs(() => build(evidence, LIMITS));
    assert.equal(JSON.stringify(logs).includes('μυστικό εύρημα'), false);
  });
}

test('a stretch line names one stretch of the chat evidence and leaves the note', async () => {
  // Bug: the line that names the stretch is shown as part of the note.
  const { build } = builder({ answer: 'stretch: 1\nAna said it.' });
  const note = await build(HISTORY, LIMITS);
  assert.deepEqual([note.text, note.stretch], ['Ana said it.', 1]);
});

test('a web note names no stretch', async () => {
  // Bug: the web path indexes the chat windows it does not have.
  const { build } = builder({ answer: 'stretch: 1\nFrost comes in November.' });
  const note = await build(WEB, LIMITS);
  assert.equal(note.stretch, null);
});

test('parseSummaryNote takes none whatever its case and punctuation', () => {
  // Bug: a model's `None.` is published as the finding.
  for (const raw of ['none', 'None', 'NONE.', '"none"']) {
    assert.deepEqual(parseSummaryNote(raw, { maxChars: 50, count: 1 }), { text: null, stretch: null }, raw);
  }
});

test('parseSummaryNote keeps a note that only starts with none', () => {
  // Bug: a real answer is thrown away for its first word.
  const raw = 'None of them said it, Ana only asked.';
  assert.equal(parseSummaryNote(raw, { maxChars: 50, count: 1 }).text, raw);
});

test('parseSummaryNote takes a stretch out of range as no stretch and keeps the note', () => {
  // Bug: a wrong number costs the whole note or points past the windows.
  assert.deepEqual(parseSummaryNote('stretch: 4\nAna.', { maxChars: 50, count: 1 }), { text: 'Ana.', stretch: null });
});

test('a web search whose summary answers none gives her no text', async () => {
  // Bug: lookup keeps its own summary path, so the word reaches the diary and the persona as a finding.
  const lookup = createLookup(
    wrongly<Parameters<typeof createLookup>[0]>({
      hot: {
        config: {
          llm: { timeoutMs: 300_000 },
          models: { base: { analyzer: 'x/reason' } },
          web: {
            acceptLanguage: 'el',
            links: { maxOutputTokens: 300, fetchTimeoutMs: 10_000 },
            search: {
              enabled: true,
              engine: 'brave',
              model: 'x/search',
              maxOutputTokens: 400,
              cacheHours: 24,
              timeoutMs: 10_000,
            },
          },
        },
        prompts: { 'search-summary': 'The query: {{query}}. Up to {{maxChars}} characters.' },
      },
      store: { getMediaCache: () => ({}), markMediaCacheDirty() {} },
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

test('a recall whose summary answers none finds nothing', async () => {
  // Bug: the runner keeps its own parser, so she is told the history says "none".
  const info = channelInfo('c1', { name: 'general', viewers: {} });
  const reads = {
    searchMessages: (_scope: unknown, query: { text?: string }) =>
      Promise.resolve(neutralSearch(rabbitAnswers('/messages/search', { content: query.text }))),
    searchMembers: () => Promise.resolve(neutralSearch({ total_results: 0, messages: [] })),
    history: (_ref: unknown, query: { limit: number; around?: string }) => {
      const at = RABBIT_LINES.findIndex((line) => line.id === query.around);
      const from = Math.max(0, at - Math.floor(query.limit / 2));
      const rows = RABBIT_LINES.slice(from, from + query.limit);
      return Promise.resolve({ events: rows.map((line) => eventOfLine(info, line)), complete: true });
    },
  };
  const recaller = createRecall(
    wrongly<Parameters<typeof createRecall>[0]>({
      reads,
      hot: {
        config: recallConfig({ llm: { analyzerTimeoutMs: 30000 } }),
        prompts: { 'recall-summary': PROMPT, labels },
      },
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
      llm: { capLeft: () => 100, complete: () => Promise.resolve({ text: 'none' }) },
      now: () => NOW,
    })
  );
  const question = {
    id: 'h1',
    placeId: 'c9',
    ts: NOW - 1000,
    self: false,
    bot: false,
    authorName: 'Nikos',
    content: 'ποιος σκότωσε το κουνέλι;',
  };
  const { result } = await withCapturedLogs(() =>
    recaller.run(
      wrongly({
        placeId: GUILD,
        channel: channelInfo('c9', { name: 'other', viewers: {} }),
        snapshot: snapshotOf(GUILD, { conversations: [info], groups: [] }),
        partnerId: null,
        selfId: 'self',
        selfName: 'Zoë',
        history: [question],
        candidate: question,
        server: RABBIT_SERVER,
      })
    )
  );
  assert.equal(result?.text ?? null, null);
});
