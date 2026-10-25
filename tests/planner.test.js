// Tests for src/behavior/planner.js: the switch, the request's layout, the strict block parser
// (each block read by its old classifier's parser) and askPlanner's request, logs and fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANNER_BLOCKS, askPlanner, buildPlannerRequest, parsePlannerAnswer, parseRewatchPickDetailed, plannerOn } from '../src/behavior/planner.js';
import { parseRouteAnswer } from '../src/behavior/route.js';
import { parseParticipationPick } from '../src/behavior/participation-pick.js';
import { parseLookupAnswer } from '../src/behavior/recall.js';
import { createLimits } from '../src/llm/limits.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const COUNTS = { channels: 3, episodes: 3, media: 2 };
const PROMPT = 'Plan for {{name}}; today is {{today}}.';

const FULL = [
  'channel: 2 earlier',
  'episodes: 3, 1',
  'rewatch: 1 question: τι χρώμα έχει το αυτοκίνητο;',
  'web: αποτελέσματα αγώνα χθες',
  'server: κουνέλι, κουνελιού',
  'who: Λευτέρης',
  'when: 2026-10-01 .. 2026-10-03',
].join('\n');

const LOOKUP_LINES = ['web: αποτελέσματα αγώνα χθες', 'server: κουνέλι, κουνελιού', 'who: Λευτέρης', 'when: 2026-10-01 .. 2026-10-03'].join('\n');

test('plannerOn: only features.turnPlanner exactly true turns it on', () => {
  assert.equal(plannerOn({ features: { turnPlanner: true } }), true);
  for (const value of [false, undefined, 'true', 1]) assert.equal(plannerOn({ features: { turnPlanner: value } }), false, String(value));
  assert.equal(plannerOn(undefined), false);
});

test('buildPlannerRequest: placeholders filled, blocks in the prompt order, the lists as the stable part', () => {
  const messages = buildPlannerRequest({
    prompt: PROMPT,
    selfName: 'Zoë',
    today: '2026-10-14',
    channelLines: ['1 | #jardin |  | plants'],
    episodeLines: ['1 | #journal | Ana: μια ερώτηση | Zoë: ναι'],
    episodeAgeLines: ['1 | 2 h'],
    mediaLines: ['1 | video | clip.mp4 | watched | ένα αυτοκίνητο'],
    transcriptBlock: '<transcript>\nAna: γεια\n</transcript>\n',
    candidateBlock: '<candidate>\nAna: τι λες;\n</candidate>',
  });
  assert.equal(messages[0].content, 'Plan for Zoë; today is 2026-10-14.');
  const [stable, tail] = messages[1].content;
  assert.equal(stable.cacheSegment, 'stable');
  assert.equal(stable.text, '<channels>\n1 | #jardin |  | plants\n</channels>\n<episodes>\n1 | #journal | Ana: μια ερώτηση | Zoë: ναι\n</episodes>\n');
  assert.equal(tail.cacheSegment, undefined);
  assert.equal(
    tail.text,
    '<episode_ages>\n1 | 2 h\n</episode_ages>\n<media>\n1 | video | clip.mp4 | watched | ένα αυτοκίνητο\n</media>\n<transcript>\nAna: γεια\n</transcript>\n<candidate>\nAna: τι λες;\n</candidate>',
  );
});

test('buildPlannerRequest: absent lists are left out; a blank prompt or no candidate builds nothing', () => {
  const only = buildPlannerRequest({ prompt: PROMPT, selfName: 'Zoë', today: '2026-10-14', candidateBlock: '<candidate>\nAna: ;\n</candidate>' });
  assert.equal(only[1].content, '<candidate>\nAna: ;\n</candidate>');
  assert.equal(buildPlannerRequest({ prompt: '  ', selfName: 'Zoë', today: 'x', candidateBlock: '<candidate>\nA: b\n</candidate>' }), null);
  assert.equal(buildPlannerRequest({ prompt: PROMPT, selfName: 'Zoë', today: 'x', candidateBlock: null }), null);
});

test('parsePlannerAnswer: a full valid answer gives four ok blocks, each what the old parser reads from the same text', () => {
  const options = { counts: COUNTS, timezone: 'UTC', now: NOW, maxForms: 6 };
  const blocks = parsePlannerAnswer(FULL, options);
  assert.deepEqual(PLANNER_BLOCKS.map((name) => blocks[name].state), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(blocks.unknown, 0);

  const route = parseRouteAnswer('2 earlier', COUNTS.channels);
  assert.deepEqual({ index: blocks.channel.index, direction: blocks.channel.direction }, { index: route.index, direction: route.direction });
  assert.deepEqual(blocks.episodes.indices, parseParticipationPick('3, 1', COUNTS.episodes).indices);
  assert.deepEqual(blocks.rewatch.pick, parseRewatchPickDetailed('1 | τι χρώμα έχει το αυτοκίνητο;', COUNTS.media).pick);
  const lookup = parseLookupAnswer(LOOKUP_LINES, { timezone: 'UTC', now: NOW, maxForms: 6 });
  assert.deepEqual({ web: blocks.lookup.web, server: blocks.lookup.server }, { web: lookup.web, server: lookup.server });
});

test('parsePlannerAnswer: the none forms, a retry, a plain channel pick and the labels in any case and order', () => {
  const blocks = parsePlannerAnswer('LOOKUP: none\nrewatch: 2 retry\n**Channel:** 3\nepisodes: none', { counts: COUNTS });
  assert.equal(blocks.lookup.state, 'none');
  assert.equal(blocks.episodes.state, 'none');
  assert.deepEqual(blocks.rewatch.pick, { n: 2, question: 'retry', retry: true });
  assert.deepEqual([blocks.channel.state, blocks.channel.index, blocks.channel.direction], ['ok', 3, null]);
  const nothing = parsePlannerAnswer('channel: none\nepisodes: none\nrewatch: none\nlookup: none', { counts: COUNTS });
  assert.deepEqual(PLANNER_BLOCKS.map((name) => nothing[name].state), ['none', 'none', 'none', 'none']);
});

test('parsePlannerAnswer: a block not answered is missing, the others keep their state', () => {
  const blocks = parsePlannerAnswer('channel: 1\nlookup: none', { counts: COUNTS });
  assert.equal(blocks.channel.state, 'ok');
  assert.equal(blocks.lookup.state, 'none');
  assert.deepEqual([blocks.episodes.state, blocks.episodes.indices], ['missing', []]);
  assert.deepEqual([blocks.rewatch.state, blocks.rewatch.pick], ['missing', null]);
  const empty = parsePlannerAnswer('', { counts: COUNTS });
  assert.deepEqual(PLANNER_BLOCKS.map((name) => empty[name].state), ['missing', 'missing', 'missing', 'missing']);
});

test('parsePlannerAnswer: a number outside its list is invalid, the other blocks unharmed', () => {
  const blocks = parsePlannerAnswer('channel: 9\nepisodes: 1, 7\nrewatch: 5 question: τι;\nlookup: none', { counts: COUNTS });
  assert.deepEqual([blocks.channel.state, blocks.channel.parse, blocks.channel.index], ['invalid', 'unknown-id', null]);
  assert.deepEqual([blocks.episodes.state, blocks.episodes.indices], ['invalid', []], 'one bad number spoils the block');
  assert.deepEqual([blocks.rewatch.state, blocks.rewatch.pick], ['invalid', null]);
  assert.equal(blocks.lookup.state, 'none');
  // A list the request did not carry: any number for it is invalid.
  assert.equal(parsePlannerAnswer('channel: 1', { counts: { channels: 0 } }).channel.state, 'invalid');
});

test('parsePlannerAnswer: unparsable values are invalid', () => {
  const blocks = parsePlannerAnswer('channel: the garden one\nepisodes: first\nrewatch: 1\nlookup: maybe', { counts: COUNTS });
  assert.deepEqual(PLANNER_BLOCKS.map((name) => blocks[name].state), ['invalid', 'invalid', 'invalid', 'invalid']);
  assert.equal(parsePlannerAnswer('lookup:', { counts: COUNTS }).lookup.state, 'invalid');
});

test('parsePlannerAnswer: duplicated lines make their block invalid', () => {
  const blocks = parsePlannerAnswer('channel: 1\nchannel: 2\nepisodes: 1\nepisodes: 1\nrewatch: none\nrewatch: none\nweb: a\nweb: b', { counts: COUNTS });
  for (const name of PLANNER_BLOCKS) assert.deepEqual([blocks[name].state, blocks[name].parse], ['invalid', 'duplicate'], name);
  assert.equal(parsePlannerAnswer('lookup: none\nlookup: none', { counts: COUNTS }).lookup.state, 'invalid');
  assert.deepEqual(
    [parsePlannerAnswer('lookup: none\nweb: Ἀθήνα', { counts: COUNTS }).lookup.state, parsePlannerAnswer('lookup: none\nweb: Ἀθήνα', { counts: COUNTS }).lookup.parse],
    ['invalid', 'conflict'],
  );
});

test('parsePlannerAnswer: a lookup head with its lines, inline or below, reads as the labelled lines alone', () => {
  const below = parsePlannerAnswer('lookup:\nweb: café de Flore', { counts: COUNTS });
  const inline = parsePlannerAnswer('lookup: web: café de Flore', { counts: COUNTS });
  for (const blocks of [below, inline]) assert.deepEqual([blocks.lookup.state, blocks.lookup.web], ['ok', 'café de Flore']);
  assert.equal(parsePlannerAnswer('chatter\nchannel: none', { counts: COUNTS }).unknown, 1);
});

test('parsePlannerAnswer: a when-role line joins the lookup block as the lookup classifier reads it; a repeated one is invalid', () => {
  const options = { counts: COUNTS, timezone: 'UTC', now: NOW };
  const lines = 'server: censure, retirer\nwhen: 2026-10-07';
  for (const role of ['', '\nwhen-role: locator', '\nWHEN_ROLE: scope', '\n- **when role:** scope']) {
    const blocks = parsePlannerAnswer(`lookup:\n${lines}${role}`, options);
    const lookup = parseLookupAnswer(`${lines}${role}`, { timezone: 'UTC', now: NOW });
    assert.equal(blocks.lookup.state, 'ok', role);
    assert.deepEqual(blocks.lookup.server, lookup.server, role);
    assert.equal(blocks.unknown, 0, role);
  }
  assert.equal(parsePlannerAnswer(lines, options).lookup.server.locator, true, 'no role: a locator');
  assert.equal('locator' in parsePlannerAnswer(`${lines}\nwhen-role: scope`, options).lookup.server, false);
  assert.equal(parsePlannerAnswer('lookup: when-role: scope\nserver: censure\nwhen: 2026-10-07', options).lookup.state, 'ok', 'inline after the head');
  const twice = parsePlannerAnswer(`${lines}\nwhen-role: scope\nwhen_role: locator`, options);
  assert.deepEqual([twice.lookup.state, twice.lookup.parse], ['invalid', 'duplicate']);
});

/** A fake llm answering `text` (an Error is thrown), recording each call. */
function fakeLlm(text) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      if (text instanceof Error) throw text;
      return { text, usage: {}, estimated: 5 };
    },
  };
}

const CONFIG = {
  bot: { timezone: 'UTC' },
  llm: { helperTimeoutMs: 25_000 },
  models: { base: { analyzer: 'x/text' } },
  web: { search: { classifierMaxOutputTokens: 321 } },
  recall: { maxForms: 6 },
};

function ask(llm, { offer = { channels: ['1 | #a | | ', '2 | #b | | ', '3 | #c | | '], episodes: ['1 | #a | 1 h | | Zoë: x'], media: ['1 | video | v.mp4 | watched | x'], lookup: true }, limits = createLimits(), prompt = PROMPT, config = CONFIG } = {}) {
  return withCapturedLogs(() =>
    askPlanner({
      llm,
      config,
      prompt,
      selfName: 'Zoë',
      today: '2026-10-14',
      offer,
      transcriptBlock: '<transcript>\nAna: γεια\n</transcript>\n',
      candidateBlock: '<candidate>\nAna: θυμάσαι;\n</candidate>',
      channelId: 'c1',
      kind: 'mention',
      now: () => NOW,
      limits,
    }),
  );
}

test('askPlanner: one request on the analyzer role, purpose planner, capped at the search classifier\'s output cap', async () => {
  const llm = fakeLlm('channel: 2\nepisodes: 1\nrewatch: none\nlookup: none');
  const { result, logs } = await ask(llm);
  assert.equal(llm.calls.length, 1);
  const { options, messages } = llm.calls[0];
  assert.equal(options.role, 'analyzer');
  assert.equal(options.purpose, 'planner');
  assert.equal(options.model, 'x/text');
  assert.equal(options.maxOutputTokens, 321);
  assert.equal(options.timeoutMs, 25_000);
  assert.equal(options.helper, true);
  assert.equal(messages[0].content, 'Plan for Zoë; today is 2026-10-14.');
  assert.equal(result.outcome, 'classified');
  assert.deepEqual(PLANNER_BLOCKS.map((name) => result.blocks[name].state), ['ok', 'ok', 'none', 'none']);
  const line = logs.find((l) => l.msg === 'planner: classified');
  assert.deepEqual(line.states, { channel: 'ok', episodes: 'ok', rewatch: 'none', lookup: 'none' });
  assert.deepEqual([line.offered.channels, line.offered.episodes, line.offered.media, line.offered.lookup], [3, 1, 1, true]);
  assert.ok(!JSON.stringify(logs).includes('γεια') && !JSON.stringify(logs).includes('θυμάσαι'), 'no content in the logs');
});

test('askPlanner: an invalid or missing offered block is a helper-fallback entry; a block not offered is not', async () => {
  const limits = createLimits();
  const llm = fakeLlm('channel: 7\nlookup: none');
  const { result } = await ask(llm, { limits, offer: { channels: ['1 | #a | | '], episodes: ['1 | #a | 1 h | | Zoë: x'], lookup: true } });
  assert.equal(result.blocks.channel.state, 'invalid');
  assert.deepEqual(limits.list(), [
    { kind: 'helper-fallback', where: 'planner:channel', lost: null, detail: 'invalid' },
    { kind: 'helper-fallback', where: 'planner:episodes', lost: null, detail: 'missing' },
  ]);
});

test('askPlanner: a throw or an empty answer is a failed call -- every offered block falls back, logged with a code only', async () => {
  for (const [answer, reason] of [[new Error('hedged timeout'), 'classifier-failed'], ['  \n ', 'empty']]) {
    const limits = createLimits();
    const { result, logs } = await ask(fakeLlm(answer), { limits });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, reason);
    assert.deepEqual(PLANNER_BLOCKS.map((name) => result.blocks[name].state), ['missing', 'missing', 'missing', 'missing']);
    assert.deepEqual(limits.list().map((entry) => [entry.where, entry.detail]), PLANNER_BLOCKS.map((name) => [`planner:${name}`, reason]));
    const line = logs.find((l) => l.msg === 'planner: failed');
    assert.equal(line.reason, reason);
  }
});

test('askPlanner: nothing offered or no prompt sends no request and records no fallback', async () => {
  const llm = fakeLlm('channel: 1');
  const limits = createLimits();
  const none = await ask(llm, { offer: { channels: [], lookup: false }, limits });
  assert.deepEqual([none.result.outcome, none.result.reason], ['skipped', 'nothing']);
  const blank = await ask(llm, { prompt: '', limits });
  assert.deepEqual([blank.result.outcome, blank.result.reason], ['skipped', 'no-prompt']);
  assert.ok(blank.logs.some((l) => l.msg === 'planner: skipped' && l.reason === 'no-prompt'));
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(limits.list(), []);
});
