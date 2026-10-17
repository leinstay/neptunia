// Tests for the errands in tools/replay.mjs's skill scenarios (`--skills`): the errand budget the
// sandbox gateway reads from a read-only task store (sandboxErrandBudget), and the task-result
// scenario (`taskResult`) that runs the turn an errand's end opens -- trigger kind `task`, the
// `<task_result>` block, the files named by their live handles -- with her calls through the real
// resolution and gateway, all against fakes and a scratch data directory: no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { callViewOf, requesterOf } from '../src/behavior/turn.js';
import { answerSkillScenario, liveView, personaGrantsConfig, simulateCall, skillScenarioRequest } from '../src/behavior/sandbox.js';
import { createTaskStore, parseFileHandle } from '../src/errands/store.js';
import { utcDay } from '../src/time.js';
import {
  parseScenarios, renderSkillsReport, runRecord, sandboxErrandBudget, scenarioFileOf, scenarioSummary, scenarioTask, scenarioTaskId, skillRequestEstimate,
} from '../tools/replay.mjs';
import { labels } from './fixtures/labels.js';

const OWNER = '100000000000000042';
const MEMBER = '100000000000000007';
const SELF = '100000000000000001';
const HERE = '200000000000000001';
const NEWS = '200000000000000002';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const GUILD = '300000000000000001';

/** A task-result scenario as the file holds it, with `overrides` on its errand. */
function errandRaw(overrides = {}, scenario = {}) {
  return {
    id: 'errand-1',
    channelId: HERE,
    grants: [],
    taskResult: {
      agent: 'web',
      goal: 'Βρες το πρόγραμμα των αγώνων',
      state: 'done',
      text: 'Le programme est prêt.',
      files: [{ name: 'programme.pdf', contentType: 'application/pdf', bytes: 2048 }],
      asker: MEMBER,
      ...overrides,
    },
    ...scenario,
  };
}

/** parseScenarios over a JSON array of `items`. */
function load(items) {
  return parseScenarios(JSON.stringify(items));
}

/** The live-like config of a scenario: what buildRequest reads, skills on, the owner, the errand caps; her grants over it. */
function scenarioConfig(grants, { agents = {} } = {}) {
  return personaGrantsConfig({
    bot: { owners: [OWNER], timezone: 'UTC', access: {} },
    context: {
      channelMessages: 100, maxMessageChars: 800, gapMarkerMinutes: 20, otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    roles: { voice: 'x/chat' },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    skills: { safeMode: false },
    agents: { maxOpen: 3, web: { daily: { tasks: 2, usd: 8 } }, server: { daily: { tasks: 1, usd: 3 } }, ...agents },
    features: { skills: true, followUpContinuation: true },
  }, SELF, grants);
}

/** A discord.js-like channel: γενικά in a guild with νέα beside it, nobody's roles cached. */
function fakeChannel() {
  return {
    id: HERE,
    name: 'γενικά',
    guild: {
      id: GUILD,
      channels: { cache: new Map([[HERE, { id: HERE, name: 'γενικά', type: 0 }], [NEWS, { id: NEWS, name: 'νέα', type: 0 }]]) },
      roles: { cache: new Map() },
      members: { cache: new Map() },
    },
  };
}

/** A scratch data/ with the guild's tasks.json as given; returns the data directory. */
function scratchData(t, tasksJson) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-errands-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, 'guilds', GUILD);
  fs.mkdirSync(dir, { recursive: true });
  if (tasksJson) fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasksJson));
  return dataDir;
}

/** Every file under `dir` with its size, time and content: what a write would change. */
function treeOf(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const stat = fs.statSync(full);
    out[path.relative(dir, full)] = entry.isDirectory() ? `dir ${stat.mtimeMs}` : `${stat.size} ${stat.mtimeMs} ${fs.readFileSync(full, 'utf8')}`;
  }
  return out;
}

/** A `task.run` call as she writes one, taken through the real resolution and gateway with `tasks` as the budget. */
function runTask({ config, tasks, agent = 'web', author = OWNER }) {
  const channel = fakeChannel();
  return simulateCall({
    call: { skill: 'task.run', args: { agent }, body: 'Βρες το πρόγραμμα' },
    view: callViewOf({ channel, guildId: GUILD, idByIndex: new Map(), lines: [], pulledIds: new Map(), memoryOn: false, store: null, selfId: SELF, skills: skillRegistry() }),
    config,
    selfId: SELF,
    requester: requesterOf({ id: '1', authorId: author }, channel),
    conversationId: HERE,
    now: NOW,
    ...(tasks ? { tasks } : {}),
    resultText: 'queued',
  });
}

test('replay --skills: task.run passes the sandbox gateway under the live errand budget, is refused at a spent cap, and nothing is written', (t) => {
  const config = scenarioConfig(['task.run']);
  const today = utcDay(NOW);
  const dataDir = scratchData(t, { tasks: [], daily: { webDay: today, webTasks: 1, serverDay: today, serverTasks: 1 } });
  const before = treeOf(dataDir);
  const tasks = sandboxErrandBudget({ createTaskStore, dataDir, guildId: GUILD, config: () => config, now: () => NOW });
  assert.deepEqual(Object.keys(tasks), ['budget'], 'only the budget is handed out: nothing can be queued');

  // Under the cap (1 of 2 web tasks today): it passes and is only recorded.
  const passed = runTask({ config, tasks });
  assert.deepEqual(passed.verdict, { stage: 'gateway', ok: true });
  assert.deepEqual(passed.executed, { skill: 'task.run', args: { agent: 'web', goal: 'Βρες το πρόγραμμα' } });

  // The server agent's cap is spent (1 of 1): refused as live, naming the setting.
  const spent = runTask({ config, tasks, agent: 'server' });
  assert.deepEqual([spent.verdict.stage, spent.verdict.code, spent.verdict.reason, spent.executed], ['gateway', 'cap-tasks', 'agents.server.daily.tasks', null]);

  // Without the budget (the night's sandbox): every task.run was refused `no-budget`.
  const unbudgeted = runTask({ config, tasks: null });
  assert.deepEqual([unbudgeted.verdict.code, unbudgeted.verdict.reason], ['no-budget', 'unavailable']);

  // The caps are read at the moment of use: a lower web cap refuses it the next time.
  const lowered = scenarioConfig(['task.run'], { agents: { web: { daily: { tasks: 1, usd: 8 } } } });
  const live = sandboxErrandBudget({ createTaskStore, dataDir, guildId: GUILD, config: () => lowered, now: () => NOW });
  assert.equal(runTask({ config: lowered, tasks: live }).verdict.code, 'cap-tasks');

  // Open tasks count against agents.maxOpen as live.
  const busyDir = scratchData(t, { tasks: ['a', 'b', 'c'].map((id) => ({ id, agent: 'web', goal: 'x', state: 'running' })), daily: {} });
  const busy = sandboxErrandBudget({ createTaskStore, dataDir: busyDir, guildId: GUILD, config: () => config, now: () => NOW });
  assert.deepEqual([runTask({ config, tasks: busy }).verdict.code, runTask({ config, tasks: busy }).verdict.reason], ['cap-open', 'agents.maxOpen']);

  // A guild without tasks.json starts empty: nothing spent, and no file appears.
  const emptyDir = scratchData(t, null);
  const empty = sandboxErrandBudget({ createTaskStore, dataDir: emptyDir, guildId: GUILD, config: () => config, now: () => NOW });
  assert.equal(runTask({ config, tasks: empty }).verdict.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(emptyDir, 'guilds', GUILD)), []);

  assert.deepEqual(treeOf(dataDir), before, 'no write under data/: tasks.json untouched, no tasks.jsonl');
});

test('parseScenarios: a taskResult scenario takes the place of author and text; defaults and refusals', () => {
  const [scenario] = load([errandRaw({ text: undefined, files: undefined })]);
  assert.deepEqual(scenario, {
    id: 'errand-1', channelId: HERE, before: null,
    taskResult: { agent: 'web', goal: 'Βρες το πρόγραμμα των αγώνων', state: 'done', text: '', files: [], asker: MEMBER },
    grants: [], runs: 1, result: '', discovery: 'inventory',
  });
  const [full] = load([errandRaw({ state: 'failed', files: [{ name: 'a.png' }, { name: 'b.csv', contentType: 'text/csv', bytes: 0 }] })]);
  assert.deepEqual(full.taskResult.files, [{ name: 'a.png', contentType: '', bytes: 0 }, { name: 'b.csv', contentType: 'text/csv', bytes: 0 }]);
  assert.equal(full.taskResult.state, 'failed');
  assert.equal(skillRequestEstimate([scenario]), 2, 'one decision: her answer and the follow-up');

  const refused = [
    [errandRaw({}, { author: MEMBER }), /taskResult replaces author, text and steps/],
    [errandRaw({}, { steps: [{ author: MEMBER, text: 'α' }] }), /taskResult replaces author, text and steps/],
    [{ ...errandRaw(), taskResult: 'done' }, /taskResult: not an object/],
    [errandRaw({ extra: 1 }), /taskResult: unknown field extra/],
    [errandRaw({ agent: '' }), /agent must be/],
    [errandRaw({ agent: 'w b' }), /agent must be/],
    [errandRaw({ goal: '  ' }), /goal must be/],
    [errandRaw({ state: 'cancelled' }), /state must be "done" or "failed"/],
    [errandRaw({ text: 3 }), /text must be text/],
    [errandRaw({ files: {} }), /files must be a list/],
    [errandRaw({ files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}` })) }), /files must be a list of at most 10/],
    [errandRaw({ files: [{ name: 'a/b' }] }), /file 1: name must be/],
    [errandRaw({ files: [{ name: '..' }] }), /file 1: name must be/],
    [errandRaw({ files: [{ name: 'a', size: 1 }] }), /file 1: unknown field size/],
    [errandRaw({ files: [{ name: 'a' }, { name: 'a' }] }), /file 2: the name is used twice/],
    [errandRaw({ files: [{ name: 'a', bytes: -1 }] }), /file 1: bytes/],
    [errandRaw({ asker: 'x' }), /asker must be a member id/],
  ];
  for (const [raw, message] of refused) assert.throws(() => load([raw]), message);
});

test('scenarioTask: the errand as the store keeps a finished task; its files resolve by their live handles only', () => {
  const [scenario] = load([errandRaw()]);
  const task = scenarioTask(scenario, { at: NOW });
  assert.match(task.id, /^t[0-9a-f]{8}$/);
  assert.equal(task.id, scenarioTaskId('errand-1'), 'the same id every run');
  assert.notEqual(scenarioTaskId('errand-2'), task.id);
  assert.deepEqual([task.agent, task.state, task.error, task.scope, task.seen], ['web', 'done', null, 'group', false]);
  assert.deepEqual(task.requester, { userId: MEMBER, kind: 'member' });
  assert.deepEqual(task.origin, { channelId: HERE, messageId: null });
  assert.equal(scenarioTask(load([errandRaw({ state: 'failed' })])[0], { at: NOW }).error, 'failed');

  const fileOf = scenarioFileOf(task, parseFileHandle);
  const found = fileOf(`file:${task.id}/programme.pdf`);
  assert.deepEqual([found.name, found.contentType, found.bytes, found.task.id], ['programme.pdf', 'application/pdf', 2048, task.id]);
  assert.equal(fileOf(`file:${task.id}/other.pdf`), null);
  assert.equal(fileOf('file:t00000000/programme.pdf'), null);
  assert.equal(fileOf('programme.pdf'), null);
});

test('replay --skills taskResult: the turn an errand\'s end opens; her message.create with the file handle is recorded through the real gateway', async (t) => {
  const [scenario] = load([errandRaw()]);
  const at = NOW + 60_000;
  const task = scenarioTask(scenario, { at });
  const handle = `file:${task.id}/programme.pdf`;
  const config = scenarioConfig([]);
  const hot = { config, prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', format: 'FORMAT', reply: 'REPLY {{author}}', interject: 'INTERJECT {{trigger}}', labels } };
  const store = { getGuild: () => ({}), getUser: () => null, listChannels: () => [], listUserProfiles: () => [], getLore: () => [], state: { data: {} } };
  const view = liveView({ hot, store, guildId: GUILD });
  const here = { id: HERE, name: 'γενικά' };
  const history = [{
    id: '400000000000000001', channelId: HERE, channelName: 'γενικά', authorId: OWNER, authorName: 'Élodie', self: false, bot: false, content: 'καλημέρα', ts: NOW,
    mentionedUserIds: [], replyToId: null, forwardedFrom: null, attachments: [], links: [], forwarded: [], stickers: [], emojis: [], reactions: [],
  }];
  const situation = { history, mode: 'interject' };
  const dataDir = scratchData(t, { tasks: [], daily: {} });
  const before = treeOf(dataDir);
  const tasks = sandboxErrandBudget({ createTaskStore, dataDir, guildId: GUILD, config: () => config, now: () => NOW });
  const channel = fakeChannel();
  // The requester a live result turn hands in: the asker's id, no roles.
  const requester = { id: MEMBER, roleIds: [] };
  const input = { view, situation, selfId: SELF, selfName: 'Persona', channel: here, at, skillsGranted: null, taskResult: task };

  // What --dry builds: the request of the turn, with <task_result> and the file's handle in it.
  const dry = skillScenarioRequest(input);
  assert.ok(dry.user.includes('<task_result>'), dry.user);
  assert.ok(dry.user.includes(`errand ${task.id} (web) ended done: Βρες το πρόγραμμα των αγώνων`));
  assert.ok(dry.user.includes(`${handle} | application/pdf | 2048 bytes`));
  assert.ok(dry.user.includes('INTERJECT asked for the errand that just ended'), 'trigger kind task, an interjection');
  assert.ok(!dry.user.includes('<tasks>'), 'no other errand of hers is known');

  const calls = [];
  const llm = {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return { text: `<msg>έτοιμο</msg><call skill="message.create" channel="γενικά">Voilà le programme\n${handle}</call>`, usage: { prompt_tokens: 100, completion_tokens: 10 } };
    },
  };
  const answered = await answerSkillScenario({
    ...input, llm, runs: 1,
    onCall: (call, { idByIndex, history: lines }) =>
      simulateCall({
        call,
        view: callViewOf({ channel, guildId: GUILD, idByIndex, lines, pulledIds: new Map(), memoryOn: false, store: null, selfId: SELF, skills: skillRegistry(), fileOf: scenarioFileOf(task, parseFileHandle) }),
        config, selfId: SELF, requester, conversationId: HERE, now: at, tasks, resultText: '',
      }),
  });
  assert.equal(calls.length, 1, 'a message that went out is its own answer: no follow-up');
  const [run] = answered.runs;
  assert.deepEqual(run.outcome.verdict, { stage: 'gateway', ok: true });
  assert.deepEqual(run.outcome.executed, { skill: 'message.create', args: { channel: HERE, text: 'Voilà le programme', file: handle } });

  // Reported like any other scenario: runs.jsonl's line, the counts, the report with the errand's end.
  const record = runRecord(scenario.id, 0, run);
  assert.deepEqual([record.decision, record.skill, record.executed.args.file, record.executed.args.channel], ['call', 'message.create', handle, HERE]);
  const summary = scenarioSummary([record]);
  assert.deepEqual([summary.calls, summary.passed], [1, 1]);
  const report = renderSkillsReport([{ scenario, grantNames: [], records: [record], summary }]);
  assert.ok(report.includes(`errand ${task.id} (web, done) asked by ${MEMBER}:`), report);
  assert.ok(report.includes(`\`${handle}\``) && report.includes('> Le programme est prêt.'));
  assert.ok(report.includes('call: `message.create`') && report.includes('gateway: passed'));

  // A handle of no file of hers is refused at the resolution, as live.
  const wrong = simulateCall({
    call: { skill: 'message.create', args: {}, body: `x\nfile:${task.id}/autre.pdf` },
    view: callViewOf({ channel, guildId: GUILD, idByIndex: new Map(), lines: [], pulledIds: new Map(), memoryOn: false, store: null, selfId: SELF, skills: skillRegistry(), fileOf: scenarioFileOf(task, parseFileHandle) }),
    config, selfId: SELF, requester, conversationId: HERE, now: at, tasks,
  });
  assert.deepEqual([wrong.verdict.stage, wrong.verdict.code], ['resolve', 'unknown-file']);

  assert.deepEqual(treeOf(dataDir), before, 'no write under data/');
});
