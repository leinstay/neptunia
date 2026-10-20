// Tests for tools/replay.mjs `--inner`: its flags, the hot it runs with (shadow forced, no dry
// run, no journal) and the wake it builds from the inner state read. Pure parts only: the mode
// itself needs Discord and a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heartbeatReplayWake, hiddenCapabilities, hiddenPlaces, hiddenRecord, hideSetsOf, innerAnswerOf, innerReplayHot, innerReplayWake, innerReportMarkdown, parseArgs, readOnlyJournal, recordingLlm } from '../tools/replay.mjs';
import { parseOutput } from '../src/llm/parse.js';
import * as inner from '../src/behavior/inner.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');

test('replay --inner: an intention\'s wake needs --intention, the review takes none; other modes\' flags are refused', () => {
  const due = parseArgs(['--inner', 'intention_due', '--intention', 'i-abc', '--spend', '1']);
  assert.equal(due.inner, 'intention_due');
  assert.equal(due.intention, 'i-abc');
  assert.equal(due.review, false);
  assert.equal(parseArgs(['--inner', 'review']).review, true);
  assert.equal(parseArgs(['--inner', 'review', '--review', '--show-request']).showRequest, true);
  for (const argv of [
    ['--inner', 'intention_due'],
    ['--inner', 'review', '--intention', 'i1'],
    ['--inner', 'errand_deadline', '--intention', 'i1', '--review'],
    ['--inner', 'nap'],
    ['--inner', 'review', '--diary', 'picture'],
    ['--inner', 'review', 'c1', 'm1'],
    ['--review'],
    ['--intention', 'i1'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

test('innerReplayHot: shadow forced, the switch on, no dry run, no journal, no mirror; the live config untouched', () => {
  const live = { config: { features: { innerLife: false, dryRun: true, journal: true, coreTools: true }, bot: { dryRunChannelId: '5', timezone: 'UTC' }, innerLife: { mode: 'live', chatMessages: 7 } }, prompts: {} };
  const config = innerReplayHot(live).config;
  assert.deepEqual(config.features, { innerLife: true, dryRun: false, journal: false, coreTools: true });
  assert.equal(config.innerLife.mode, 'shadow');
  assert.equal(config.innerLife.chatMessages, 7);
  assert.equal(config.bot.dryRunChannelId, '');
  assert.equal(live.config.innerLife.mode, 'live');
});

test('innerReplayWake: the scheduler\'s wake for the intention, its budgets from the state read', () => {
  const settings = inner.innerSettings({});
  const state = { ...inner.emptyState(), turns: [{ at: NOW - 60_000, chainId: 'intention:i1', usd: 0.2 }] };
  const intention = { id: 'i1', status: 'pending', purpose: 'p', dueAt: NOW - 5_000, provenance: { channelId: 'c1', scope: 'group' } };
  const { wake, info } = innerReplayWake({ inner, kind: 'intention_due', intention, state, settings, now: NOW, timezone: 'UTC', day: '2026-10-19' });
  assert.equal(wake.id, `inner.wake:intention_due:i1:${NOW - 5_000}`);
  assert.deepEqual(info.items, [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], taskId: null }]);
  assert.equal(info.budgets.day, undefined);
  assert.equal(info.budgets.chain.left, 2);
  const review = innerReplayWake({ inner, kind: 'review', state, settings, now: NOW, timezone: 'UTC', day: '2026-10-19', channelNames: ['général'] });
  assert.equal(review.wake.kind, 'review');
  assert.deepEqual(review.info.channels, ['général']);
  assert.deepEqual(review.info.intentions, []);
});

test('replay --inner heartbeat: no intention or review flag; samples, prompts, out, show-request and spend are taken', () => {
  const args = parseArgs(['--inner', 'heartbeat', '--samples', '3', '--prompts', 'variant', '--out', 'report.md', '--show-request', '--spend', '2']);
  assert.equal(args.inner, 'heartbeat');
  assert.equal(args.samples, 3);
  assert.equal(args.prompts, 'variant');
  assert.equal(args.outDir, 'report.md');
  assert.equal(args.showRequest, true);
  assert.equal(args.review, false);
  assert.equal(parseArgs(['--inner', 'heartbeat']).samples, 1);
  assert.equal(parseArgs(['--inner', 'review', '--samples', '2']).samples, 2);
  for (const argv of [
    ['--inner', 'heartbeat', '--intention', 'i1'],
    ['--inner', 'heartbeat', '--review'],
    ['--inner', 'heartbeat', '--samples', '0'],
    ['--inner', 'heartbeat', '--pair-prompts', 'a', 'b'],
    ['--inner', 'heartbeat', 'c1', 'm1'],
  ]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

function heartbeatFixture({ stopped = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-data-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-tmp-'));
  const stateFile = path.join(dataDir, 'guilds', 'g1', 'inner.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const kept = JSON.stringify({ ...inner.emptyState(), stopped, heartbeat: { nextAt: NOW - 1000, lastAt: NOW - 3 * 3_600_000 } });
  fs.writeFileSync(stateFile, kept);
  const channel = { id: 'c1', name: 'general', guild: { id: 'g1' } };
  const record = {
    iterate: async function* iterate() {
      yield { kind: 'said', occurredAt: new Date(NOW - 3_600_000).toISOString(), scope: { channel: 'c1' } };
    },
  };
  const deps = {
    record,
    client: { channels: { fetch: async (id) => (id === 'c1' ? channel : null) } },
    discord: { canSend: () => true },
    store: { state: { data: {} }, listUserProfiles: () => [], getDiary: () => ({ posts: [] }) },
    nameOf: () => null,
  };
  const hot = { config: { bot: { timezone: 'UTC' }, features: { innerLife: true }, innerLife: { mode: 'shadow' } }, prompts: {} };
  return { dataDir, tmpRoot, stateFile, kept, channel, deps, hot };
}

test('heartbeatReplayWake: the scheduler\'s heartbeat wake and conversation, read only, the throwaway state removed', async () => {
  const fx = heartbeatFixture({ stopped: true });
  const { info, channel, currentChannel } = await heartbeatReplayWake({ inner, hot: fx.hot, dataDir: fx.dataDir, guildId: 'g1', now: NOW, deps: fx.deps, tmpRoot: fx.tmpRoot });
  assert.equal(info.kind, 'heartbeat');
  assert.deepEqual(info.items.map((item) => item.kind), ['heartbeat']);
  assert.equal(info.chainId, `heartbeat:${NOW}`);
  assert.equal(info.now, NOW);
  assert.ok(info.heartbeat, 'the heartbeat view is on the wake');
  assert.equal(channel.id, 'c1');
  assert.equal(currentChannel, null, 'a heartbeat has no current channel');
  assert.equal(fs.readFileSync(fx.stateFile, 'utf8'), fx.kept, 'the data directory is untouched');
  assert.deepEqual(fs.readdirSync(fx.tmpRoot), [], 'the throwaway directory is gone');
});

test('heartbeatReplayWake: no conversation to run in is a CliError, not a turn', async () => {
  const fx = heartbeatFixture();
  fx.deps.client = { channels: { fetch: async () => null } };
  await assert.rejects(heartbeatReplayWake({ inner, hot: fx.hot, dataDir: fx.dataDir, guildId: 'g1', now: NOW, deps: fx.deps, tmpRoot: fx.tmpRoot }), /would not run the heartbeat/);
  assert.deepEqual(fs.readdirSync(fx.tmpRoot), []);
});

test('innerAnswerOf and innerReportMarkdown: the think whole, the messages, the calls with their arguments, the cost', () => {
  const text = '<think>STEP 1: a\nSTEP 2: b</think><msg>hello</msg><call skill="message.create" channel="c1">body</call>';
  const answer = innerAnswerOf(text, parseOutput);
  assert.equal(answer.think, 'STEP 1: a\nSTEP 2: b');
  assert.deepEqual(answer.messages, ['hello']);
  assert.equal(answer.calls[0].skill, 'message.create');
  assert.equal(answer.calls[0].args.channel, 'c1');
  const markdown = innerReportMarkdown({
    kind: 'heartbeat', intention: null, channelId: 'c1', wake: '<wake>\nfacts\n</wake>', request: { blocks: ['wake'] },
    samples: [{ outcome: 'ok', reason: null, answers: [answer], actions: [{ skill: 'message.create', status: 'proposed' }], posted: 0, usage: { requests: 1, promptTokens: 10, completionTokens: 5, cost: 0.0123 } }],
    usage: { requests: 1, promptTokens: 10, completionTokens: 5, cost: 0.0123 },
  });
  for (const part of ['# Inner turn: heartbeat', '## wake', 'STEP 2: b', '- hello', '"channel": "c1"', 'proposed', '0.0123 USD']) assert.ok(markdown.includes(part), part);
});

test('replay --inner: --hide-channel and --hide-message repeat, take ids, and belong to --inner only', () => {
  const args = parseArgs(['--inner', 'heartbeat', '--hide-channel', '11', '--hide-channel', '12', '--hide-message', '99']);
  assert.deepEqual(args.hideChannels, ['11', '12']);
  assert.deepEqual(args.hideMessages, ['99']);
  assert.deepEqual(parseArgs(['--inner', 'heartbeat']).hideChannels, []);
  for (const argv of [['--inner', 'heartbeat', '--hide-channel', 'abc'], ['--inner', 'heartbeat', '--hide-message'], ['--hide-channel', '11'], ['--hide-message', '5', 'c1', 'm1']]) {
    assert.throws(() => parseArgs(argv), /usage/, argv.join(' '));
  }
});

test('hiddenRecord: lines of a hidden channel or message are not iterated, the rest passes through', async () => {
  const lines = [
    { kind: 'seen', messageId: '1', scope: { channel: 'c1' }, by: 'u1' },
    { kind: 'seen', messageId: '2', scope: { channel: 'c2' }, by: 'u1' },
    { kind: 'seen', messageId: '3', scope: { channel: 'c1' }, by: 'u2' },
    { kind: 'said', messageId: '4', scope: { channel: 'c1' }, sourceMessageIds: ['3'] },
  ];
  const record = { async *iterate() { yield* lines; }, other: () => 'kept' };
  const hide = hideSetsOf({ hideChannels: ['c2'], hideMessages: ['1'] });
  const seen = [];
  for await (const line of hiddenRecord(record, hide).iterate('g')) seen.push(line.messageId);
  assert.deepEqual(seen, ['3', '4']);
  assert.equal(hiddenRecord(record, hide).other(), 'kept');
  assert.equal(hiddenRecord(record, hideSetsOf({})), record);
});

test('hiddenPlaces drops hidden channels from the list', () => {
  const places = () => [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(hiddenPlaces(places, hideSetsOf({ hideChannels: ['a'] }))('g'), [{ id: 'b' }]);
});

test('hiddenCapabilities: history, neighbours and pulls lose the hidden channels and messages; the directory stays', async () => {
  const seenAccept = [];
  const base = {
    channelDirectoryOf: () => [{ id: 'c2' }],
    fetchHistory: async () => [{ id: 'm1' }, { id: 'm2' }],
    fetchNeighbors: async (channel, config, selfId, now, { accept }) => {
      seenAccept.push(accept({ id: 'c2' }), accept({ id: 'c3' }));
      return [{ channelId: 'c3', messages: [{ id: 'm1' }, { id: 'm5' }] }, { channelId: 'c4', messages: [{ id: 'm1' }] }];
    },
    fetchPull: async ({ channelId }) => ({ pulled: { channelId, messages: channelId === 'c5' ? [{ id: 'm1' }] : [{ id: 'm1' }, { id: 'm6' }] }, skip: null }),
  };
  const hide = hideSetsOf({ hideChannels: ['c2', 'c9'], hideMessages: ['m1'] });
  const wrapped = hiddenCapabilities(base, hide);
  assert.deepEqual(wrapped.channelDirectoryOf(), [{ id: 'c2' }]);
  assert.deepEqual(await wrapped.fetchHistory({ id: 'c1' }, {}), [{ id: 'm2' }]);
  assert.deepEqual(await wrapped.fetchHistory({ id: 'c9' }, {}), []);
  assert.deepEqual(await wrapped.fetchNeighbors({}, {}, 's', 0, { accept: () => true }), [{ channelId: 'c3', messages: [{ id: 'm5' }] }]);
  assert.deepEqual(seenAccept, [false, true]);
  assert.deepEqual((await wrapped.fetchPull({ channelId: 'c6' })).pulled.messages, [{ id: 'm6' }]);
  assert.deepEqual(await wrapped.fetchPull({ channelId: 'c9' }), { pulled: null, skip: 'not-found' });
  assert.equal((await wrapped.fetchPull({ channelId: 'c5' })).skip, 'not-found');
  assert.equal(hiddenCapabilities(base, hideSetsOf({})), base);
});

test('innerReportMarkdown prints the hidden ids in the header', () => {
  const md = innerReportMarkdown({ kind: 'heartbeat', channelId: 'c1', hidden: { channels: ['11'], messages: ['99', '98'] }, samples: [], usage: {} });
  assert.match(md, /Hidden channels: 11/);
  assert.match(md, /Hidden messages: 99, 98/);
});

test('replay --inner: the journal handed to the operations can read and nothing else', () => {
  const journal = readOnlyJournal({ read: 1, findTurn: 2, timeline: 3, system: 4, start: 5, withWriterLock: 6 });
  assert.deepEqual(Object.keys(journal).sort(), ['findTurn', 'read', 'timeline']);
});

test('replay --inner: --answers-dir is accepted with its timeout and samples', () => {
  const ok = parseArgs(['--inner', 'heartbeat', '--answers-dir', 'd', '--answers-timeout-min', '5', '--samples', '3']);
  assert.equal(ok.answersDir, 'd');
  assert.equal(ok.answersTimeoutMin, 5);
});

test('innerAnswerOf and innerReportMarkdown: a failed step is an error step, not an empty answer or a skip', () => {
  const ok = innerAnswerOf('<think>one</think><msg>hi</msg>', parseOutput);
  const failed = innerAnswerOf(null, parseOutput, 'provider-limit');
  assert.deepEqual(failed.failed, { code: 'provider-limit' });
  assert.equal(failed.skip, false);
  assert.equal(ok.failed, undefined);
  const usage = { requests: 2, promptTokens: 1, completionTokens: 1, cost: 0 };
  const markdown = innerReportMarkdown({
    kind: 'heartbeat', intention: null, channelId: 'c1', usage,
    samples: [{ outcome: 'ok', reason: null, answers: [ok, failed], actions: [], posted: 0, usage }],
  });
  assert.ok(markdown.includes('### Step 2: error (provider-limit)'));
  assert.ok(markdown.includes('Failed steps: 1 of 2'));
  assert.ok(markdown.includes('ended in error (provider-limit)'));
  const afterFailed = markdown.split('### Step 2')[1].split('actions:')[0];
  assert.ok(!afterFailed.includes('think:') && !afterFailed.includes('skip'));
});

test('recordingLlm notes the failure code of a failed completion', async () => {
  const calls = [];
  const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
  const llm = recordingLlm({ complete: async () => { throw err; } }, calls, { errorCodeOf: (e) => (e.statusCode === 429 ? 'provider-limit' : 'error') });
  await assert.rejects(llm.complete([], { purpose: 'reply' }));
  assert.equal(calls[0].code, 'provider-limit');
  assert.match(calls[0].error, /rate limited/);
});
