// The query builder: the step before a search that plans whether to search, where, and with which forms. One module for
// every caller, a DM, a group on any interface, the selfreflection planner and the heartbeat.
// Contract, plan 2026-11-04-cli-and-memory B4 and B9, module src/behavior/query-builder.ts:
//   `parseQueryPlan(raw, { timezone, now, maxForms, skillNames })` reads the labelled lines `web:`, `history:`, `who:`,
//   `when:`, `recent:`, `when-role:` and `skills:` into `{ web, history, reason, skills? }`
//   `createQueryBuilder({ hot, llm, now })(input)` sends `prompts['query-builder']` (`{{name}}`, `{{today}}`, `{{skills}}`)
//   under the purpose `query-builder`, takes `{ selfName, question, lines?, skills? }`, names no place, and resolves the
//   plan with `reason` also `failed` or `no-prompt`; it never rejects
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueryBuilder, parseQueryPlan } from '../src/behavior/query-builder.ts';
import { DailyCapError } from '../src/llm/openrouter.ts';
import { PURPOSE_ROLES } from '../src/llm/roles.ts';
import { labels } from './fixtures/labels.ts';
import { queryAnswer } from './fixtures/query-answer.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const OPTIONS = { timezone: 'UTC', now: NOW, maxForms: 8 };

test('a history line becomes the history part with its forms', () => {
  // Bug: the label is renamed in the prompt and the parser still looks for the old one, so she never searches.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const plan = parseQueryPlan(queryAnswer({ history: 'κουνέλι, κουνελιού' }), OPTIONS);
  assert.deepEqual(plan.history?.forms, ['κουνέλι', 'κουνελιού']);
  assert.equal(plan.web, null);
  assert.equal(plan.reason, 'ok');
});

test('web and history are planned in one answer', () => {
  // Bug: the first label wins, and half of the plan is lost.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const plan = parseQueryPlan(queryAnswer({ web: 'tomato frost date', history: 'tomate' }), OPTIONS);
  assert.equal(plan.web, 'tomato frost date');
  assert.deepEqual(plan.history?.forms, ['tomate']);
});

test('the server label is no plan', () => {
  // Bug: both labels stay, and a stale prompt keeps writing the server's word through.
  const plan = parseQueryPlan('server: tomate', OPTIONS);
  assert.equal(plan.history, null);
});

test('who and when belong to the history part', () => {
  // Bug: the rename drops the fields beside the forms.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const plan = parseQueryPlan(queryAnswer({ who: 'Ana', when: '2026-10-01' }), OPTIONS);
  assert.deepEqual(plan.history?.who, ['ana']);
  assert.equal(plan.history?.from, Date.UTC(2026, 9, 1));
});

test('recent and a located time qualify the history part', () => {
  // Bug: the qualifiers are read off the old key and silently stop working.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const plan = parseQueryPlan(
    queryAnswer({ history: 'tomate', recent: 'yes', when: '2026-10-01', when_role: 'locator' }),
    OPTIONS
  );
  assert.equal(plan.history?.recent, true);
  assert.equal(plan.history?.locator, true);
});

test('none plans no search', () => {
  // Bug: the picks' word for nothing is searched for on the web.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  for (const raw of [queryAnswer({}), queryAnswer({ web: 'none', history: 'none' })]) {
    const plan = parseQueryPlan(raw, OPTIONS);
    assert.deepEqual([plan.web, plan.history, plan.reason], [null, null, 'none'], raw);
  }
});

test('an empty answer plans no search', () => {
  // Bug: a reasoning model that spent its cap reads as a query.
  for (const raw of ['', null, undefined, '  \n ']) assert.equal(parseQueryPlan(raw, OPTIONS).reason, 'empty');
});

test('labelled lines with nothing usable are unparsed', () => {
  // Bug: a date nobody can read turns into a search over everything.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const plan = parseQueryPlan(queryAnswer({ when: 'last spring' }), OPTIONS);
  assert.deepEqual([plan.web, plan.history, plan.reason], [null, null, 'unparsed']);
});

test('a skills line is read beside the plan and does not disturb it', () => {
  // Bug: the discovery line is taken for a form or a query.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const plan = parseQueryPlan(queryAnswer({ history: 'tomate', skills: 'none' }), {
    ...OPTIONS,
    skillNames: ['garden'],
  });
  assert.deepEqual(plan.history?.forms, ['tomate']);
  assert.equal(plan.skills?.state, 'none');
});

/** One builder over a fake model. */
function builder(
  options: { answer?: string | Error; prompt?: string | null; timezone?: string; capLeft?: number } = {}
) {
  const calls: Array<{ system: string; user: string; options: Record<string, unknown> }> = [];
  const build = createQueryBuilder({
    hot: {
      config: { bot: { timezone: options.timezone ?? 'UTC' }, llm: {}, models: {}, recall: { maxForms: 8 } },
      prompts: {
        labels,
        ...(options.prompt === null
          ? {}
          : { 'query-builder': options.prompt ?? 'For {{name}} on {{today}}, skills {{skills}}.' }),
      },
    },
    llm: {
      complete: (messages: Array<{ content: unknown }>, request: Record<string, unknown>) => {
        calls.push({ system: String(messages[0]?.content), user: String(messages[1]?.content), options: request });
        if (options.answer instanceof Error) return Promise.reject(options.answer);
        // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
        return Promise.resolve({ text: options.answer ?? queryAnswer({ history: 'tomate' }) });
      },
    },
    now: () => NOW,
  });
  return { build, calls };
}

const QUESTION = { authorName: 'Eleni', content: 'τι έγινε με τις ντομάτες;' };

test('one call goes out under the purpose query-builder on the analyzer', async () => {
  // Bug: the new purpose has no role, so the classifier bills the core key.
  const { build, calls } = builder();
  const plan = await build({ selfName: 'Nova', question: QUESTION });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options.purpose, 'query-builder');
  assert.equal(PURPOSE_ROLES['query-builder'], 'analyzer');
  assert.deepEqual(plan.history?.forms, ['tomate']);
});

test('the prompt is filled with her name, the day and the skills', async () => {
  // Bug: a placeholder reaches the model as literal text.
  const { build, calls } = builder();
  await build({ selfName: 'Nova', question: QUESTION, skills: 'garden' });
  assert.equal(calls[0]?.system, 'For Nova on 2026-11-05, skills garden.');
});

test('a caller with no chat around it, as a heartbeat, still gets a plan and sends no transcript', async () => {
  // Bug: the builder assumes a chat, so a wake or the planner cannot call it.
  const { build, calls } = builder();
  const plan = await build({ selfName: 'Nova', question: QUESTION });
  assert.equal(plan.reason, 'ok');
  assert.equal(calls[0]?.user.includes('<transcript>'), false);
  assert.ok(calls[0]?.user.includes('τι έγινε με τις ντομάτες;'));
});

test('the lines of a DM reach the request as its transcript', async () => {
  // Bug: only a group's lines are rendered, and a DM's question loses its context.
  const { build, calls } = builder();
  const line = {
    id: 'm1',
    placeId: 'd1',
    authorId: 'u1',
    authorName: 'Eleni',
    content: 'φύτεψα ντομάτες',
    ts: NOW - 60_000,
    self: false,
    bot: false,
    reactions: [],
    attachments: [],
    stickers: [],
    emojis: [],
    links: [],
    forwarded: [],
  };
  await build({ selfName: 'Nova', question: QUESTION, lines: [line] });
  assert.ok(calls[0]?.user.includes('<transcript>'));
  assert.ok(calls[0]?.user.includes('φύτεψα ντομάτες'));
});

test('a date in the answer is read in the configured zone', async () => {
  // Bug: the builder parses in UTC, and a day's range is off by the zone.
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { build } = builder({ answer: queryAnswer({ when: '2026-10-01' }), timezone: 'Europe/Athens' });
  const plan = await build({ selfName: 'Nova', question: QUESTION });
  assert.equal(plan.history?.from, Date.parse('2026-10-01T00:00:00+03:00'));
});

test('a question with no text costs no request', async () => {
  // Bug: an empty wake pays a classifier call for nothing.
  const { build, calls } = builder();
  const plan = await build({ selfName: 'Nova', question: { authorName: 'Eleni', content: '   ' } });
  assert.equal(calls.length, 0);
  assert.equal(plan.reason, 'empty');
});

test('a missing prompt costs no request and says so', async () => {
  // Bug: a blank system message goes out and the model improvises.
  const { build, calls } = builder({ prompt: null });
  const plan = await build({ selfName: 'Nova', question: QUESTION });
  assert.equal(calls.length, 0);
  assert.equal(plan.reason, 'no-prompt');
});

test('a failed request resolves as failed and plans nothing', async () => {
  // Bug: the daily cap's error reaches the turn, or a failure reads as her choice not to search.
  const { build } = builder({ answer: new DailyCapError() });
  const plan = await build({ selfName: 'Nova', question: QUESTION });
  assert.deepEqual([plan.web, plan.history, plan.reason], [null, null, 'failed']);
});
