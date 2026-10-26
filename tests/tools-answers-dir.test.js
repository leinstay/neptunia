import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/ops/index.js';
import { answerSkillScenario, liveView, personaGrantsConfig } from '../src/behavior/sandbox.js';
import {
  requestJson,
  createAnswersDir,
  withAnswersDir,
  renderRequest,
  isAnthropicModel,
} from '../tools/lib/answers-dir.mjs';

// Every directory a test makes is removed when the file ends (PR #225: a test file leaves no temp directory behind).
const made = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'answers-dir-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test('renderRequest lays out the model, the system prompt and every message verbatim', () => {
  const text = renderRequest({
    model: 'anthropic/claude-x',
    purpose: 'reply',
    messages: [
      { role: 'system', content: 'sys  line\n  indented' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image_url', image_url: { url: 'u' } },
          { type: 'text', text: 'b' },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  });
  assert.equal(
    text,
    'model: anthropic/claude-x\npurpose: reply\n\n## system\n\nsys  line\n  indented\n\n## user\n\na\n[image]\nb\n\n## assistant\n\nok\n'
  );
});

test('an Anthropic request waits for its answer file; the numbers are zero-padded', async () => {
  const dir = tmp();
  const answers = createAnswersDir({
    dir,
    pollMs: 1,
    sleep: async () => {
      fs.writeFileSync(path.join(dir, 'ans-001.txt'), 'hello');
    },
  });
  const out = await answers.answer('anthropic/claude-x', [{ role: 'user', content: 'hi' }], { purpose: 'reply' });
  assert.equal(out.text, 'hello');
  assert.equal(out.usage.cost, 0);
  assert.equal(out.provider, 'answers-dir');
  assert.match(fs.readFileSync(path.join(dir, 'req-001.md'), 'utf8'), /^model: anthropic\/claude-x\npurpose: reply\n/);
  answers.finish(0);
  assert.equal(fs.readFileSync(path.join(dir, 'done'), 'utf8'), 'exit 0\n');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    []
  );
});

test('no answer within the timeout fails the request', async () => {
  const dir = tmp();
  let t = 0;
  const answers = createAnswersDir({ dir, timeoutMin: 1, sleep: async () => {}, now: () => (t += 40_000) });
  await assert.rejects(answers.answer('anthropic/claude-x', []), /no ans-001\.txt within 1 min/);
});

test('a directory of an earlier run is refused', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ans-001.txt'), 'old');
  assert.throws(() => createAnswersDir({ dir }), /earlier run/);
});

test('withAnswersDir sends only Anthropic models to the files', async () => {
  const sent = [];
  const createLlm = () => ({
    complete: async (m, o) => {
      sent.push(o.model ?? 'default');
      return { text: 'real' };
    },
  });
  const answers = { answer: async () => ({ text: 'file' }) };
  const llm = withAnswersDir(createLlm, answers, () => 'anthropic/claude-core')({ getConfig: () => ({}) });
  assert.equal((await llm.complete([], { model: 'google/gemini-x' })).text, 'real');
  assert.equal((await llm.complete([], {})).text, 'file');
  assert.equal((await llm.complete([], { model: 'anthropic/claude-y' })).text, 'file');
  assert.deepEqual(sent, ['google/gemini-x']);
  assert.equal(isAnthropicModel('openai/gpt'), false);
});

test('req-NNN.json carries the exact strings, system apart, roles kept', async () => {
  const dir = tmp();
  const answers = createAnswersDir({
    dir,
    pollMs: 1,
    sleep: async () => {
      fs.writeFileSync(path.join(dir, 'ans-001.txt'), 'x');
    },
  });
  const messages = [
    { role: 'system', content: 'sys\n## user\n  card' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    },
    { role: 'assistant', content: 'mid' },
    { role: 'user', content: 'last' },
  ];
  await answers.answer('anthropic/claude-x', messages, { purpose: 'reply' });
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'req-001.json'), 'utf8'));
  assert.deepEqual(json, {
    model: 'anthropic/claude-x',
    purpose: 'reply',
    system: 'sys\n## user\n  card',
    messages: [
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'mid' },
      { role: 'user', content: 'last' },
    ],
  });
  assert.equal(JSON.parse(requestJson({ model: 'm', messages: [{ role: 'user', content: 'q' }] })).system, null);
});

test('withAnswersDir firstOnly: a tool-loop step of the turn goes to the real model', async () => {
  const createLlm = () => ({ complete: async () => ({ text: 'real' }) });
  const answers = { answer: async () => ({ text: 'file' }) };
  const llm = withAnswersDir(createLlm, answers, () => 'anthropic/claude-core', { firstOnly: true })({
    getConfig: () => ({}),
  });
  assert.equal((await llm.complete([{ role: 'user', content: 'wake' }], {})).text, 'file');
  assert.equal(
    (
      await llm.complete(
        [{ role: 'user', content: '<task>\nThis is the same inner turn, continued after your x call.' }],
        {}
      )
    ).text,
    'real'
  );
  assert.equal(
    (
      await llm.complete(
        [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
        ],
        {}
      )
    ).text,
    'real'
  );
});

test('a request with tools lists them in req-<n>.json and .md; the answer may carry tool calls from ans-<n>.tool-calls.json', async () => {
  const dir = tmp();
  const tools = [
    { type: 'function', function: { name: 'draw_create', description: 'd', parameters: { type: 'object' } } },
  ];
  const answers = createAnswersDir({
    dir,
    pollMs: 1,
    sleep: async () => {
      fs.writeFileSync(
        path.join(dir, 'ans-001.tool-calls.json'),
        JSON.stringify([
          { name: 'draw_create', arguments: { text: 'a cat' } },
          { id: 'x', name: 'draw_create', arguments: '{bad' },
        ])
      );
      fs.writeFileSync(path.join(dir, 'ans-001.txt'), '<think>t</think>');
    },
  });
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c0', type: 'function', function: { name: 'draw_create', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c0', content: 'ok' },
  ];
  const out = await answers.answer('anthropic/claude-x', messages, { tools });
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'req-001.json'), 'utf8'));
  assert.deepEqual(req.tools, tools);
  assert.equal(req.toolChoice, 'auto');
  assert.equal(req.messages[1].tool_calls[0].id, 'c0');
  assert.equal(req.messages[2].tool_call_id, 'c0');
  assert.match(fs.readFileSync(path.join(dir, 'req-001.md'), 'utf8'), /## tools\n\ntool_choice: auto/);
  assert.equal(out.text, '<think>t</think>');
  assert.deepEqual(
    out.toolCalls.map((c) => [c.id, c.name, c.parsed]),
    [
      ['call_1', 'draw_create', { text: 'a cat' }],
      ['x', 'draw_create', null],
    ]
  );
  assert.equal(typeof out.toolCalls[1].parseError, 'string');
});

test('without tools the request files and the result have no tool fields', async () => {
  const dir = tmp();
  const answers = createAnswersDir({
    dir,
    pollMs: 1,
    sleep: async () => {
      fs.writeFileSync(path.join(dir, 'ans-001.txt'), 'hello');
    },
  });
  const out = await answers.answer('anthropic/claude-x', [{ role: 'user', content: 'hi' }]);
  assert.equal('toolCalls' in out, false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'req-001.json'), 'utf8'))), [
    'model',
    'purpose',
    'system',
    'messages',
  ]);
  assert.ok(!fs.readFileSync(path.join(dir, 'req-001.md'), 'utf8').includes('## tools'));
});

test('an answer whose tool-calls.json holds a data call drives two steps of a replay turn: the second request appends her call and its result to the first messages', async () => {
  const dir = tmp();
  const reached = [];
  const answers = createAnswersDir({
    dir,
    pollMs: 1,
    sleep: async () => {
      // The simulator answers each request that waits: the first with speech and a web search, the second with speech only.
      const n = fs.readdirSync(dir).filter((name) => /^req-\d+\.json$/.test(name)).length;
      reached.push(n);
      const id = String(n).padStart(3, '0');
      if (n === 1) {
        fs.writeFileSync(
          path.join(dir, `ans-${id}.tool-calls.json`),
          JSON.stringify([{ id: 'w1', name: 'web_search', arguments: { query: 'chess' } }])
        );
        fs.writeFileSync(path.join(dir, `ans-${id}.txt`), '<think>a</think><msg>one moment</msg>');
      } else fs.writeFileSync(path.join(dir, `ans-${id}.txt`), '<think>b</think><msg>found it</msg>');
    },
  });
  const llm = { complete: (messages, options) => answers.answer('anthropic/claude-x', messages, options) };
  const config = personaGrantsConfig(
    {
      bot: { timezone: 'UTC' },
      context: {
        channelMessages: 100,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      },
      models: { base: { core: 'x/chat' } },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
      features: {},
    },
    '900000000000000001',
    ['web.search']
  );
  const hot = {
    config,
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      format: 'FORMAT',
      reply: 'REPLY {{author}}',
      labels: (await import('./fixtures/labels.js')).labels,
    },
  };
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {} },
  };
  const view = liveView({ hot, store, guildId: 'g1' });
  const at = Date.UTC(2026, 9, 20, 12, 0, 0);
  const trigger = {
    id: '800000000000000002',
    channelId: '500000000000000001',
    channelName: 'general',
    authorId: '111111111111111111',
    authorName: 'Alice',
    self: false,
    bot: false,
    content: 'who won?',
    ts: at,
    mentionedUserIds: ['900000000000000001'],
    replyToId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
  const out = await answerSkillScenario({
    view,
    situation: { history: [trigger], triggerId: trigger.id, kind: 'mention', mode: 'reply' },
    selfId: '900000000000000001',
    selfName: 'Zoe',
    channel: { id: trigger.channelId, name: 'general' },
    llm,
    runs: 1,
    at,
    onCall: (call) => ({
      verdict: { stage: 'gateway', ok: true },
      executed: { skill: call.skill, args: call.args },
      result: { skill: call.skill, status: 'ok', data: { text: 'RESULT_MARKER' } },
    }),
  });
  assert.equal(answers.count(), 2);
  const first = JSON.parse(fs.readFileSync(path.join(dir, 'req-001.json'), 'utf8'));
  const second = JSON.parse(fs.readFileSync(path.join(dir, 'req-002.json'), 'utf8'));
  assert.ok(
    first.tools.some((tool) => tool.function.name === 'web_search'),
    'her tools go with the first request'
  );
  assert.deepEqual(
    second.messages.slice(0, first.messages.length),
    first.messages,
    'the second request starts with the first messages, byte for byte'
  );
  assert.equal(second.messages[first.messages.length].tool_calls[0].id, 'w1');
  assert.deepEqual(
    second.messages.slice(first.messages.length + 1).map((message) => message.role),
    ['tool', 'user']
  );
  assert.ok(second.messages[first.messages.length + 1].content.includes('RESULT_MARKER'));
  const [run] = out.runs;
  assert.equal(run.loop.steps[0].held, true);
  assert.deepEqual(
    run.followUp.answer.messages.map((m) => m.text),
    ['found it']
  );
  assert.match(fs.readFileSync(path.join(dir, 'req-002.md'), 'utf8'), /RESULT_MARKER/);
});
