// The scene tool (scripts/diary-scenes.ts) over a scratch data folder and a fake llm client: what it sends, what it
// prints and what it refuses. No provider is called and no real data folder is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../scripts/diary-scenes.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CARD = 'MARKER OF THE CHARACTER TEXT';

type Call = { messages: Array<{ role: string; content: string }>; options: Record<string, unknown> };

/** A fake client that builds on set 1, keeping its first line, and records each request. */
function fakeLlm() {
  const calls: Array<Call> = [];
  return {
    calls,
    complete: (messages: Call['messages'], options: object) => {
      calls.push({ messages, options: options as Record<string, unknown> });
      const first = /<sets>\n1\.\n(.*)\n/.exec(messages[1].content)?.[1] ?? '';
      const text = JSON.stringify({ set: 1, used: [first], scene: 'A quiet scene.' });
      return Promise.resolve({ text, usage: { prompt_tokens: 300, completion_tokens: 50 } });
    },
  };
}

/** A scratch data folder whose prompts hold a character text, and a run of the tool over it. */
function setup() {
  const dir = tempDir('diary-scenes-');
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts', 'character-card.md'), CARD);
  const env = { ...process.env, NEPTUNIA_DATA_DIR: dir };
  const llm = fakeLlm();
  const run = (argv: Array<string>) => main(argv, { env, now: () => Date.UTC(2026, 10, 18, 9), llmOf: () => llm });
  return { dir, llm, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

type Printed = Record<string, Array<{ sets: Array<Array<string>>; set: number; used: Array<string>; scene: string }>>;

test('sends the prompt file as the system message and no character text, on the replay origin', async () => {
  // Bug: the helper gets the persona as its system message, or the tool's requests count against the day's cap.
  const { llm, run, done } = setup();
  try {
    await run(['--kinds', 'status', '--count', '1', '--seed', 'a']);
    const tracked = fs.readFileSync(path.join(ROOT, 'prompts', 'diary-scene.md'), 'utf8');
    const [call] = llm.calls;
    assert.equal(call.messages[0].content, tracked.trim());
    assert.ok(!call.messages.some((message) => message.content.includes(CARD)));
    assert.equal(call.options.origin, 'replay');
    assert.equal(call.options.countAgainstDailyCap, false);
  } finally {
    done();
  }
});

test('prints count results per kind, each with eight sets, and the same sets for the same seed', async () => {
  // Bug: a kind or a run goes missing, or the seed does not fix the draw.
  const { run, done } = setup();
  try {
    const argv = ['--kinds', 'status,picture', '--count', '2', '--seed', 'same'];
    const first = JSON.parse(await run(argv)) as Printed;
    assert.deepEqual(Object.keys(first), ['status', 'picture']);
    assert.ok(Object.values(first).every((results) => results.length === 2));
    assert.ok(first.status.every((result) => result.sets.length === 8 && result.set === 1));
    const second = JSON.parse(await run(argv)) as Printed;
    assert.deepEqual(
      second.picture.map((result) => result.sets),
      first.picture.map((result) => result.sets)
    );
  } finally {
    done();
  }
});

test('refuses a kind outside the five before any request', async () => {
  // Bug: a text kind reaches the helper and spends a request.
  const { llm, run, done } = setup();
  try {
    await assert.rejects(run(['--kinds', 'status,thought']), /thought/);
    assert.equal(llm.calls.length, 0);
  } finally {
    done();
  }
});

test('lays a variant of the prompt from --prompts over the prompts', async () => {
  // Bug: the variant is ignored and the tracked prompt is calibrated instead.
  const { dir, llm, run, done } = setup();
  try {
    const variant = path.join(dir, 'variant');
    fs.mkdirSync(variant);
    fs.writeFileSync(path.join(variant, 'diary-scene.md'), 'A VARIANT OF THE TASK');
    await run(['--kinds', 'randomSet', '--count', '1', '--prompts', variant]);
    assert.equal(llm.calls[0].messages[0].content, 'A VARIANT OF THE TASK');
  } finally {
    done();
  }
});

test('writes a report with the chosen set, its kept lines marked, the scene and then the sets passed over', async () => {
  // Bug: the report loses the chosen set or mixes it with the ones passed over.
  const { dir, run, done } = setup();
  try {
    const out = path.join(dir, 'report.md');
    const printed = JSON.parse(
      await run(['--kinds', 'photoset', '--count', '1', '--seed', 'r', '--out', out])
    ) as Printed;
    const report = fs.readFileSync(out, 'utf8');
    const [result] = printed.photoset;
    const kept = report.indexOf(`[x] ${result.used[0]}`);
    const scene = report.indexOf('A quiet scene.');
    const passed = report.indexOf(result.sets[7].join('; '));
    assert.ok(report.indexOf('photoset') < kept && kept < scene && scene < passed);
    assert.ok(!report.includes(result.sets[0].join('; ')));
  } finally {
    done();
  }
});
