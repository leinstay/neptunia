// tools/config-files-move.mjs moves a deployment's local layer to the places PR 7c reads: `config.local.json` to
// `config.local/config.json` as it is, and the flat `prompts.local/labels.json` to `config.local/labels.json`, split into
// `model` and `owner` by the tracked `config/labels.json`. Without `--apply` it writes nothing. A file at both its old
// and its new place is cleaned when the two agree and refused when they differ, and a refusal stops the whole run
// before a file changes. A second run finds nothing to do. Every layer is a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { layer, ROOT } from './fixtures/private-layer.ts';
import type { Layer } from './fixtures/private-layer.ts';

const OLD_CONFIG = 'config.local.json';
const NEW_CONFIG = 'config.local/config.json';
const OLD_LABELS = 'prompts.local/labels.json';
const NEW_LABELS = 'config.local/labels.json';

const SETTINGS = { pace: { settleMs: 900 }, bot: { owners: ['owner-1'] } };
// `transcript.gap` is wording her requests carry; `status.costs.keyLead` is a line of the owner's status card.
const FLAT_LABELS = { transcript: { gap: 'my gap {duration}' }, status: { costs: { keyLead: 'my lead' } } };
const SPLIT_LABELS = {
  model: { transcript: { gap: 'my gap {duration}' } },
  owner: { status: { costs: { keyLead: 'my lead' } } },
};

function run(target: Layer, flags: ReadonlyArray<string>): { code: number | null; out: string; err: string } {
  const done = spawnSync(process.execPath, ['tools/config-files-move.mjs', '--private', target.dir, ...flags], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: '' },
  });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

/** A layer laid out before the move, with a prompt file and tool texts that the move leaves alone. */
function oldLayer(): Layer {
  const home = layer();
  home.write(OLD_CONFIG, SETTINGS);
  home.write(OLD_LABELS, FLAT_LABELS);
  fs.writeFileSync(path.join(home.dir, 'prompts.local', 'rules.md'), '## Rules\n- one\n');
  home.write('config.local/tools.json', { 'web.search': { description: 'mine' } });
  return home;
}

/** Every file under the layer with its bytes, by path relative to the layer. */
function snapshot(home: Layer): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(home.dir, rel), { withFileTypes: true })) {
      const at = rel === '' ? entry.name : path.join(rel, entry.name);
      if (entry.isDirectory()) walk(at);
      else out[at] = fs.readFileSync(path.join(home.dir, at), 'utf8');
    }
  };
  walk('');
  return out;
}

test('moves config.local.json to config.local/config.json with the same settings', () => {
  const home = oldLayer();
  const done = run(home, ['--apply']);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(home.json(NEW_CONFIG), SETTINGS);
  assert.equal(home.bytes(OLD_CONFIG), null);
});

test("moves the flat local labels to config.local/labels.json, the owner's strings under owner", () => {
  const home = oldLayer();
  const done = run(home, ['--apply']);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(home.json(NEW_LABELS), SPLIT_LABELS);
  assert.equal(home.bytes(OLD_LABELS), null);
});

test('puts a local label the tracked labels do not know under model', () => {
  const home = layer();
  home.write(OLD_LABELS, { custom: { thing: 'only here' } });
  const done = run(home, ['--apply']);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(home.json(NEW_LABELS), { model: { custom: { thing: 'only here' } }, owner: {} });
});

test('leaves the prompt files and the tool texts as they were, byte for byte', () => {
  const home = oldLayer();
  const before = snapshot(home);
  const done = run(home, ['--apply']);
  assert.equal(done.code, 0, done.err);
  const after = snapshot(home);
  assert.equal(after[path.join('prompts.local', 'rules.md')], before[path.join('prompts.local', 'rules.md')]);
  assert.equal(after[path.join('config.local', 'tools.json')], before[path.join('config.local', 'tools.json')]);
});

test('writes nothing without --apply', () => {
  const home = oldLayer();
  const before = snapshot(home);
  const done = run(home, []);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(snapshot(home), before);
});

test('changes nothing on a second run', () => {
  const home = oldLayer();
  assert.equal(run(home, ['--apply']).code, 0);
  const moved = snapshot(home);
  const again = run(home, ['--apply']);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(snapshot(home), moved);
});

test('changes nothing in a layer that has no old file', () => {
  const home = layer();
  home.write(NEW_CONFIG, SETTINGS);
  const before = snapshot(home);
  const done = run(home, ['--apply']);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(snapshot(home), before);
});

test('deletes the old settings file when the new one already holds the same settings', () => {
  const home = oldLayer();
  home.write(NEW_CONFIG, SETTINGS);
  const done = run(home, ['--apply']);
  assert.equal(done.code, 0, done.err);
  assert.equal(home.bytes(OLD_CONFIG), null);
  assert.deepEqual(home.json(NEW_CONFIG), SETTINGS);
});

test('refuses a half-moved layer whose two settings files differ, names the file, and changes no file', () => {
  const home = oldLayer();
  home.write(NEW_CONFIG, { pace: { settleMs: 100 } });
  const before = snapshot(home);
  const done = run(home, ['--apply']);
  assert.notEqual(done.code, 0);
  assert.ok(done.err.includes(OLD_CONFIG), done.err);
  assert.deepEqual(snapshot(home), before, 'the labels are not moved either');
});

test('refuses a half-moved layer whose two labels files differ, names the file, and changes no file', () => {
  const home = oldLayer();
  home.write(NEW_LABELS, { model: { transcript: { gap: 'another gap' } }, owner: {} });
  const before = snapshot(home);
  const done = run(home, ['--apply']);
  assert.notEqual(done.code, 0);
  assert.ok(done.err.includes('labels.json'), done.err);
  assert.deepEqual(snapshot(home), before, 'the settings are not moved either');
});

test('refuses to run without --private, says so, and moves nothing', () => {
  const home = oldLayer();
  const before = snapshot(home);
  const done = spawnSync(process.execPath, ['tools/config-files-move.mjs', '--apply'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: home.dir },
  });
  assert.notEqual(done.status, 0);
  assert.ok(done.stderr.includes('--private'), done.stderr);
  assert.deepEqual(snapshot(home), before);
});
