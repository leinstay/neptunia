// tools/tools-file-move.mjs: moves a deployment's local tool texts from `prompts.local/skills.json` to
// `config.local/tools.json`, renaming the entry `skills.describe` to `tools.describe` on the way. `--dry-run` says what
// it would do and writes nothing, `--apply` does it, and a rerun finds nothing left to do. With the old file only, it
// moves it. With the new one only, it does nothing. With both and the same content, it deletes the old one. With both
// and different content, it refuses, lists the keys that differ and changes nothing at all. A start with the old file
// still in place refuses with one line that names this tool (src/hot.js). The tool also renames what the errand and
// intention names changed in a local layer: the label keys `tasks`, `triggers.task`, `intentions.notes.task-missing`
// and the code keys under `tools.result.reasons`, the placeholder `{task}` in the label texts that carry it, and the ten
// tool keys of the tool texts (`task.*` and `intent.*`), in place whichever file holds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHot } from '../src/hot.js';
import { layer, moveTool } from './fixtures/private-layer.ts';
import { tempDir } from './fixtures/tmp.js';

type Hot = { prompts: { tools: Record<string, Record<string, string>> }; close: () => void };

/** The engine's live view over a checkout and a private layer, closed at once: only what it loaded is read. */
function load(rootDir: string, privateDir: string): Hot {
  const hot = createHot({ rootDir, privateDir }) as unknown as Hot;
  hot.close();
  return hot;
}

const OLD = 'prompts.local/skills.json';
const NEW = 'config.local/tools.json';

const SEND = { title: 'Send', whenToUse: 'to speak up' };
const LOOK = { whenToUse: 'when a tool is unclear' };

test('moves the old file to the new place with the same texts, and renames the entry skills.describe', () => {
  const home = layer();
  home.write(OLD, { 'message.create': SEND, 'skills.describe': LOOK });
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.deepEqual(home.json(NEW), { 'message.create': SEND, 'tools.describe': LOOK });
  assert.equal(home.bytes(OLD), null);
});

test('says on a dry run which file would go where, and writes nothing', () => {
  const home = layer();
  home.write(OLD, { 'message.create': SEND });
  const before = home.bytes(OLD);
  const run = moveTool(home, ['--dry-run']);
  assert.equal(run.code, 0);
  assert.equal(run.out.includes(OLD) && run.out.includes(NEW), true);
  assert.equal(home.bytes(OLD), before);
  assert.equal(home.bytes(NEW), null);
});

test('does nothing when only the new file exists', () => {
  const home = layer();
  home.write(NEW, { 'message.create': SEND });
  const before = home.bytes(NEW);
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.equal(home.bytes(NEW), before);
});

test('does nothing when neither file exists', () => {
  const run = moveTool(layer(), ['--apply']);
  assert.equal(run.code, 0);
});

test('deletes the old file when the new one already holds the same texts', () => {
  const home = layer();
  home.write(OLD, { 'message.create': SEND, 'skills.describe': LOOK });
  home.write(NEW, { 'tools.describe': LOOK, 'message.create': SEND });
  const before = home.bytes(NEW);
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.equal(home.bytes(OLD), null);
  assert.equal(home.bytes(NEW), before);
});

test('refuses when both files differ, names the keys that differ, and changes neither file', () => {
  const home = layer();
  home.write(OLD, { 'message.create': SEND, 'message.edit': { title: 'Edit' }, 'voice.say': { title: 'Say' } });
  home.write(NEW, { 'message.create': SEND, 'message.edit': { title: 'Change' }, 'draw.create': { title: 'Draw' } });
  const [oldBefore, newBefore] = [home.bytes(OLD), home.bytes(NEW)];
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 1);
  for (const name of ['message.edit', 'voice.say', 'draw.create']) assert.equal(run.err.includes(name), true, name);
  assert.equal(run.err.includes('message.create'), false);
  assert.deepEqual([home.bytes(OLD), home.bytes(NEW)], [oldBefore, newBefore]);
});

test('finds nothing to do on a second run', () => {
  const home = layer();
  home.write(OLD, { 'message.create': SEND, 'skills.describe': LOOK });
  moveTool(home, ['--apply']);
  const settled = home.bytes(NEW);
  const again = moveTool(home, ['--apply']);
  assert.equal(again.code, 0);
  assert.equal(home.bytes(NEW), settled);
  assert.equal(home.bytes(OLD), null);
});

test('refuses to run without --dry-run or --apply, and moves nothing', () => {
  const home = layer();
  home.write(OLD, { 'message.create': SEND });
  const run = moveTool(home, []);
  assert.equal(run.code, 1);
  assert.equal(run.err.includes('--apply') && run.err.includes('--dry-run'), true);
  assert.deepEqual(home.json(OLD), { 'message.create': SEND });
  assert.equal(home.bytes(NEW), null);
});

// ---- the errand and intention names -------------------------------------------------------------------------

const LABELS = 'prompts.local/labels.json';
const TOOL_KEYS: Array<[string, string]> = [
  ['task.run', 'errand.run'],
  ['task.status', 'errand.status'],
  ['task.read', 'errand.read'],
  ['task.resolve', 'errand.resolve'],
  ['task.cancel', 'errand.cancel'],
  ['task.list', 'errand.list'],
  ['intent.set', 'intention.set'],
  ['intent.update', 'intention.update'],
  ['intent.cancel', 'intention.cancel'],
  ['intent.list', 'intention.list'],
];

const OLD_LABELS = {
  locale: 'en-US',
  tasks: { header: 'my errands:', line: '{id} | {agent} | {goal}' },
  triggers: { mention: 'tagged me', task: 'asked for the errand that ended' },
  intentions: {
    header: 'my intentions:',
    waiting: 'waiting for errand {task} until {deadline}',
    outcome: 'errand {task} ended {state}',
    notes: { 'wait-deadline': 'the wait for errand {task} ran out', 'task-missing': 'errand {task} is gone' },
  },
  wake: { kinds: { errand_deadline: 'deadline: {id} errand {task}', review: 'review' } },
  tools: {
    result: { reasons: { 'no-task': 'no such errand', 'task-ended': 'it ended', 'cap-tasks': 'too many today' } },
  },
};
const NEW_LABELS = {
  locale: 'en-US',
  errands: { header: 'my errands:', line: '{id} | {agent} | {goal}' },
  triggers: { mention: 'tagged me', errand: 'asked for the errand that ended' },
  intentions: {
    header: 'my intentions:',
    waiting: 'waiting for errand {errand} until {deadline}',
    outcome: 'errand {errand} ended {state}',
    notes: { 'wait-deadline': 'the wait for errand {errand} ran out', 'errand-missing': 'errand {errand} is gone' },
  },
  wake: { kinds: { errand_deadline: 'deadline: {id} errand {errand}', review: 'review' } },
  tools: {
    result: { reasons: { 'no-errand': 'no such errand', 'errand-ended': 'it ended', 'cap-tasks': 'too many today' } },
  },
};

test('renames the errand label keys, the code keys and the placeholder of a local labels file, and nothing else', () => {
  const home = layer();
  home.write(LABELS, OLD_LABELS);
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.deepEqual(home.json(LABELS), NEW_LABELS);
});

test('renames the ten tool keys of a local tool texts file that is already at its new place', () => {
  const home = layer();
  const texts = Object.fromEntries(TOOL_KEYS.map(([old], index) => [old, { title: `title ${index}` }]));
  home.write(NEW, { 'message.create': SEND, ...texts });
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.deepEqual(home.json(NEW), {
    'message.create': SEND,
    ...Object.fromEntries(TOOL_KEYS.map(([, now], index) => [now, { title: `title ${index}` }])),
  });
});

test('moves the old tool texts file and renames the tool keys in it in the same run', () => {
  const home = layer();
  home.write(OLD, {
    'message.create': SEND,
    'skills.describe': LOOK,
    'task.run': { title: 'Ask' },
    'intent.set': { title: 'Want' },
  });
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.deepEqual(home.json(NEW), {
    'message.create': SEND,
    'tools.describe': LOOK,
    'errand.run': { title: 'Ask' },
    'intention.set': { title: 'Want' },
  });
  assert.equal(home.bytes(OLD), null);
});

test('refuses when a labels file holds both `tasks` and `errands` and they differ, naming the section, and changes nothing', () => {
  const home = layer();
  home.write(LABELS, { tasks: { header: 'a' }, errands: { header: 'b' } });
  const before = home.bytes(LABELS);
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 1);
  assert.equal(run.err.includes('tasks') && run.err.includes('errands'), true);
  assert.equal(home.bytes(LABELS), before);
});

test('refuses a run whole when one file is refused, so the other file keeps its old keys', () => {
  const home = layer();
  home.write(LABELS, { tasks: { header: 'a' }, errands: { header: 'b' } });
  home.write(NEW, { 'task.run': { title: 'Ask' } });
  const before = home.bytes(NEW);
  assert.equal(moveTool(home, ['--apply']).code, 1);
  assert.equal(home.bytes(NEW), before);
});

test('says what it would rename on a dry run, writes nothing, and finds nothing left to do after --apply', () => {
  const home = layer();
  home.write(LABELS, OLD_LABELS);
  home.write(NEW, { 'task.run': { title: 'Ask' } });
  const [labelsBefore, textsBefore] = [home.bytes(LABELS), home.bytes(NEW)];
  const dry = moveTool(home, ['--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(dry.out.includes(LABELS) && dry.out.includes(NEW), true);
  assert.deepEqual([home.bytes(LABELS), home.bytes(NEW)], [labelsBefore, textsBefore]);
  moveTool(home, ['--apply']);
  const settled = [home.bytes(LABELS), home.bytes(NEW)];
  const again = moveTool(home, ['--apply']);
  assert.equal(again.code, 0);
  assert.equal(again.out, 'nothing to move\n');
  assert.deepEqual([home.bytes(LABELS), home.bytes(NEW)], settled);
});

// ---- what the engine reads afterwards ------------------------------------------------------------------------

/** A checkout with a config.json and the tracked tool texts, to lay a private layer over. */
function checkout(): string {
  const root = tempDir('nep-checkout-');
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(
    path.join(root, 'config', 'tools.json'),
    JSON.stringify({
      'message.create': { title: 'Post', whenToUse: 'to speak up' },
      'tools.describe': { title: 'Describe', whenToUse: 'to read up on a tool' },
    })
  );
  return root;
}

test('gives the same effective tool texts after the move: the override on top of the tracked ones, the renamed entry included', () => {
  const home = layer();
  home.write(OLD, { 'message.create': { title: 'Send' }, 'skills.describe': LOOK });
  moveTool(home, ['--apply']);
  const hot = load(checkout(), home.dir);
  assert.deepEqual(hot.prompts.tools, {
    'message.create': { title: 'Send', whenToUse: 'to speak up' },
    'tools.describe': { title: 'Describe', whenToUse: LOOK.whenToUse },
  });
});

test('refuses a start with the old file in place, in one line that names the move tool', () => {
  const home = layer();
  home.write(OLD, { 'message.create': SEND });
  assert.throws(
    () => load(checkout(), home.dir),
    (error: Error) => error.message.includes('tools/tools-file-move.mjs') && !error.message.includes('\n')
  );
});

test('starts with the new file in place and with no local file at all', () => {
  const moved = layer();
  moved.write(NEW, { 'message.create': { title: 'Send' } });
  assert.equal(load(checkout(), moved.dir).prompts.tools['message.create']?.title, 'Send');
  assert.equal(load(checkout(), layer().dir).prompts.tools['message.create']?.title, 'Post');
});
