import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestJson, createAnswersDir, withAnswersDir, renderRequest, isAnthropicModel } from '../tools/lib/answers-dir.mjs';

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'answers-dir-'));

test('renderRequest lays out the model, the system prompt and every message verbatim', () => {
  const text = renderRequest({
    model: 'anthropic/claude-x',
    purpose: 'reply',
    messages: [
      { role: 'system', content: 'sys  line\n  indented' },
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'u' } }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: 'ok' },
    ],
  });
  assert.equal(text, 'model: anthropic/claude-x\npurpose: reply\n\n## system\n\nsys  line\n  indented\n\n## user\n\na\n[image]\nb\n\n## assistant\n\nok\n');
});

test('an Anthropic request waits for its answer file; the numbers are zero-padded', async () => {
  const dir = tmp();
  const answers = createAnswersDir({ dir, pollMs: 1, sleep: async () => { fs.writeFileSync(path.join(dir, 'ans-001.txt'), 'hello'); } });
  const out = await answers.answer('anthropic/claude-x', [{ role: 'user', content: 'hi' }], { purpose: 'reply' });
  assert.equal(out.text, 'hello');
  assert.equal(out.usage.cost, 0);
  assert.equal(out.provider, 'answers-dir');
  assert.match(fs.readFileSync(path.join(dir, 'req-001.md'), 'utf8'), /^model: anthropic\/claude-x\npurpose: reply\n/);
  answers.finish(0);
  assert.equal(fs.readFileSync(path.join(dir, 'done'), 'utf8'), 'exit 0\n');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
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
  const createLlm = () => ({ complete: async (m, o) => { sent.push(o.model ?? 'default'); return { text: 'real' }; } });
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
  const answers = createAnswersDir({ dir, pollMs: 1, sleep: async () => { fs.writeFileSync(path.join(dir, 'ans-001.txt'), 'x'); } });
  const messages = [
    { role: 'system', content: 'sys\n## user\n  card' },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    { role: 'assistant', content: 'mid' },
    { role: 'user', content: 'last' },
  ];
  await answers.answer('anthropic/claude-x', messages, { purpose: 'reply' });
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'req-001.json'), 'utf8'));
  assert.deepEqual(json, {
    model: 'anthropic/claude-x',
    purpose: 'reply',
    system: 'sys\n## user\n  card',
    messages: [{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'mid' }, { role: 'user', content: 'last' }],
  });
  assert.equal(JSON.parse(requestJson({ model: 'm', messages: [{ role: 'user', content: 'q' }] })).system, null);
});

test('withAnswersDir firstOnly: a tool-loop step of the turn goes to the real model', async () => {
  const createLlm = () => ({ complete: async () => ({ text: 'real' }) });
  const answers = { answer: async () => ({ text: 'file' }) };
  const llm = withAnswersDir(createLlm, answers, () => 'anthropic/claude-core', { firstOnly: true })({ getConfig: () => ({}) });
  assert.equal((await llm.complete([{ role: 'user', content: 'wake' }], {})).text, 'file');
  assert.equal((await llm.complete([{ role: 'user', content: '<task>\nThis is the same inner turn, continued after your x call.' }], {})).text, 'real');
  assert.equal((await llm.complete([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], {})).text, 'real');
});
