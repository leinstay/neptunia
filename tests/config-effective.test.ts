// `scripts/config-effective.ts` is the deploy proof of a settings change. `--snapshot <file>` writes the effective config of a private
// layer (`--private <dir>`) and the settings objects the readers derive from it, as `{ config, settings }`, the
// settings keyed by the reader's name (`recallSettings`, `innerSettings`, ...). `--compare <file>` derives the same from
// the layer as it is now and prints one line per difference, `<path>: before <json>, after <json>`, ending in
// ` (declared)` for a daily cap's field. Its last line is `equal: <n>, differ: <n>, declared: <n>`, and it exits 1 on
// an undeclared difference. Synthetic layers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, layer } from './fixtures/private-layer.ts';
import type { Layer } from './fixtures/private-layer.ts';
import { tempDir } from './fixtures/tmp.ts';

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

function tool(flags: Array<string>): { code: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ['scripts/config-effective.ts', ...flags], { cwd: ROOT, encoding: 'utf8' });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

/** A private layer of the new layout whose settings file sets the recall timeout. */
function recallLayer(timeoutMs: number): Layer {
  const target = layer();
  target.write('config/config.json', { recall: { timeoutMs } });
  return target;
}

function snapshot(target: Layer): string {
  const file = path.join(tempDir('nep-effective-snap-'), 'before.json');
  const run = tool(['--snapshot', file, '--private', target.dir]);
  assert.equal(run.code, 0, run.err);
  return file;
}

const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

test('writes the effective config and the settings the readers derive from it', () => {
  const file = snapshot(recallLayer(25000));
  const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(isTree(written) && isTree(written.config) && isTree(written.settings));
  assert.equal(isTree(written.config.recall) ? written.config.recall.timeoutMs : null, 25000);
  const recall = written.settings.recallSettings;
  assert.equal(isTree(recall) ? recall.timeoutMs : null, 25000);
});

test('finds no difference against a snapshot of the same layer', () => {
  const target = recallLayer(25000);
  const file = snapshot(target);
  const run = tool(['--compare', file, '--private', target.dir]);
  assert.equal(run.code, 0, run.err);
  assert.match(lastLine(run.out), /^equal: [1-9]\d*, differ: 0, declared: 0$/);
});

test('names a derived setting that changed and exits 1', () => {
  const target = recallLayer(25000);
  const file = snapshot(target);
  target.write('config/config.json', { recall: { timeoutMs: 9000 } });
  const run = tool(['--compare', file, '--private', target.dir]);
  assert.equal(run.code, 1);
  assert.ok(run.out.split('\n').includes('settings.recallSettings.timeoutMs: before 25000, after 9000'), run.out);
});

test('refuses to run without --snapshot or --compare, and writes nothing', () => {
  const run = tool(['--private', recallLayer(25000).dir]);
  assert.equal(run.code === 0, false);
  assert.match(run.err, /--snapshot|--compare/);
});
