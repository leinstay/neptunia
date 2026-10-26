// The labels half of tools/tools-file-move.mjs: a deployment's own `prompts.local/labels.json` may carry the wording of
// the tool results under `skills`, which the engine now reads under `tools`. The tool renames that one key of the local
// file and leaves every other key as it was. A local file with both keys is cleaned when they agree and refused when
// they differ. A refusal in either half of the tool, the labels or the tool texts, stops the whole run before it
// changes a file: a run is done or refused, never half done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHot } from '../src/hot.js';
import { layer, moveTool } from './fixtures/private-layer.ts';
import { tempDir } from './fixtures/tmp.js';

const LABELS = 'prompts.local/labels.json';
const TEXTS_OLD = 'prompts.local/skills.json';
const TEXTS_NEW = 'config.local/tools.json';

const REASONS = { 'not-allowed': 'she may not', 'daily-cap': 'out of budget today' };
const TRANSCRIPT = { gap: '--- {duration} passed ---' };

test('renames skills to tools in the local labels and leaves the other keys alone', () => {
  const home = layer();
  home.write(LABELS, { transcript: TRANSCRIPT, skills: { result: { reasons: REASONS } } });
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.deepEqual(home.json(LABELS), { transcript: TRANSCRIPT, tools: { result: { reasons: REASONS } } });
});

test('writes nothing on a dry run and names the file it would rewrite', () => {
  const home = layer();
  home.write(LABELS, { skills: { result: { reasons: REASONS } } });
  const before = home.bytes(LABELS);
  const run = moveTool(home, ['--dry-run']);
  assert.equal(run.code, 0);
  assert.equal(run.out.includes(LABELS), true);
  assert.equal(home.bytes(LABELS), before);
});

test('leaves a local labels file that has no skills key as it is, byte for byte', () => {
  const home = layer();
  home.write(LABELS, { transcript: TRANSCRIPT, tools: { result: { reasons: REASONS } } });
  const before = home.bytes(LABELS);
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.equal(home.bytes(LABELS), before);
});

test('drops the skills key when the tools key already says the same', () => {
  const home = layer();
  home.write(LABELS, { skills: { result: { reasons: REASONS } }, tools: { result: { reasons: REASONS } } });
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.deepEqual(home.json(LABELS), { tools: { result: { reasons: REASONS } } });
});

test('refuses a local labels file whose skills and tools keys differ, names what differs and changes nothing', () => {
  const home = layer();
  home.write(LABELS, {
    skills: { result: { reasons: REASONS }, params: { what: 'it' } },
    tools: { result: { reasons: { 'not-allowed': 'no' } } },
  });
  const before = home.bytes(LABELS);
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 1);
  assert.equal(run.err.includes('result') && run.err.includes('params'), true);
  assert.equal(home.bytes(LABELS), before);
});

test('moves no tool texts when the labels are refused', () => {
  const home = layer();
  home.write(TEXTS_OLD, { 'message.create': { title: 'Send' } });
  home.write(LABELS, { skills: { result: { reasons: REASONS } }, tools: { result: { reasons: {} } } });
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 1);
  assert.equal(run.err.includes('labels.json'), true);
  assert.deepEqual(home.json(TEXTS_OLD), { 'message.create': { title: 'Send' } });
  assert.equal(home.bytes(TEXTS_NEW), null);
});

test('rewrites no labels when the tool texts are refused', () => {
  const home = layer();
  home.write(TEXTS_OLD, { 'message.create': { title: 'Send' } });
  home.write(TEXTS_NEW, { 'message.create': { title: 'Change' } });
  home.write(LABELS, { skills: { result: { reasons: REASONS } } });
  const before = home.bytes(LABELS);
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 1);
  assert.equal(run.err.includes('tools.json'), true);
  assert.equal(home.bytes(LABELS), before);
});

test('moves the labels and the tool texts in one run', () => {
  const home = layer();
  home.write(TEXTS_OLD, { 'message.create': { title: 'Send' } });
  home.write(LABELS, { skills: { result: { reasons: REASONS } } });
  const run = moveTool(home, ['--apply']);
  assert.equal(run.code, 0);
  assert.deepEqual(home.json(TEXTS_NEW), { 'message.create': { title: 'Send' } });
  assert.deepEqual(home.json(LABELS), { tools: { result: { reasons: REASONS } } });
});

test("gives the engine the owner's wording over the shipped wording under the new key after the move", () => {
  const root = tempDir('nep-checkout-');
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(
    path.join(root, 'prompts', 'labels.json'),
    JSON.stringify({ tools: { result: { reasons: { 'not-allowed': 'shipped', 'daily-cap': 'shipped too' } } } })
  );
  const home = layer();
  home.write(LABELS, { skills: { result: { reasons: { 'not-allowed': 'mine' } } } });
  moveTool(home, ['--apply']);
  const hot = createHot({ rootDir: root, privateDir: home.dir }) as unknown as {
    prompts: { labels: { tools: { result: { reasons: Record<string, string> } } } };
    close: () => void;
  };
  hot.close();
  assert.deepEqual(hot.prompts.labels.tools.result.reasons, { 'not-allowed': 'mine', 'daily-cap': 'shipped too' });
});
