// tools/tools-file-move.mjs: moves a deployment's local tool texts from `prompts.local/skills.json` to
// `config.local/tools.json`, renaming the entry `skills.describe` to `tools.describe` on the way. `--dry-run` says what
// it would do and writes nothing, `--apply` does it, and a rerun finds nothing left to do. With the old file only, it
// moves it. With the new one only, it does nothing. With both and the same content, it deletes the old one. With both
// and different content, it refuses, lists the keys that differ and changes nothing at all. A start with the old file
// still in place refuses with one line that names this tool (src/hot.js).
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
