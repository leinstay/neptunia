// The command line edge of the harness (scripts/lib/harness-cli.ts) over a synthetic data folder: a fixed list of the
// owner's commands answered by the core's command desk, one record per command, the config files and the table hashes
// after each write, and the commands of the table it leaves out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCliEdge } from '../../../scripts/lib/harness-cli.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A data folder with one private setting and no memory yet. */
function dataFolder(): { dataDir: string; out: string; root: string } {
  const root = tempDir('harness-cli');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config', 'config.json'),
    JSON.stringify({ bot: { timezone: 'UTC' }, heartbeat: { jitterMinutes: 60 } })
  );
  return { dataDir, out: path.join(root, 'out'), root };
}

const read = (out: string, name: string): string => fs.readFileSync(path.join(out, 'cli', name), 'utf8');

/** The `<table> <rows> <hash>` line of `table` in a record. */
const tableLine = (record: string, table: string): string | undefined =>
  record.split('\n').find((line) => line.startsWith(`${table} `));

test(
  'records each command with its status and text, and the rules table after the rule is added and removed',
  { timeout: 60_000 },
  async () => {
    const { dataDir, out, root } = dataFolder();
    try {
      const counts = await runCliEdge({ root: ROOT, dataDir, out });
      const names = fs.readdirSync(path.join(out, 'cli')).sort();
      assert.equal(counts.recorded, names.length - 1);
      assert.ok(names.includes('01-help.txt'));
      assert.ok(names.some((name) => name.endsWith('-config-get-heartbeat.txt')));
      const help = read(out, '01-help.txt');
      assert.match(help, /^\$ neptunia help\nstatus: ok\ncode: -\n--- text\n\/status /);
      const added = read(out, names.find((name) => name.endsWith('-rule-add.txt')) ?? '');
      const removed = read(out, names.find((name) => name.endsWith('-rule-remove.txt')) ?? '');
      assert.match(tableLine(added, 'rules') ?? '', /^rules 1 /);
      assert.match(tableLine(removed, 'rules') ?? '', /^rules 0 /);
      assert.match(removed, /^\$ neptunia rules remove 1\nstatus: ok/);
      const set = read(out, names.find((name) => name.endsWith('-config-set.txt')) ?? '');
      const unset = read(out, names.find((name) => name.endsWith('-config-unset.txt')) ?? '');
      const sha = (record: string): string | undefined =>
        record.split('\n').find((line) => line.startsWith('config.json '));
      assert.notEqual(sha(set), sha(unset));
      const unrecorded = read(out, 'unrecorded.txt').split('\n');
      assert.equal(counts.unrecorded, unrecorded.length - 1);
      assert.ok(unrecorded.some((line) => line.startsWith('doctor.live  sends a request')));
      assert.ok(!unrecorded.some((line) => line.startsWith('rules.add ')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('two runs over equal folders write the same records', { timeout: 90_000 }, async () => {
  const first = dataFolder();
  const second = dataFolder();
  try {
    await runCliEdge({ root: ROOT, dataDir: first.dataDir, out: first.out });
    await runCliEdge({ root: ROOT, dataDir: second.dataDir, out: second.out });
    const names = fs.readdirSync(path.join(first.out, 'cli')).sort();
    assert.deepEqual(fs.readdirSync(path.join(second.out, 'cli')).sort(), names);
    for (const name of names) assert.equal(read(second.out, name), read(first.out, name), name);
  } finally {
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});
