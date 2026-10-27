// `tools/config-migrate.mjs --compare-with <config.json>` is the deploy proof that moving a local file changes no setting.
// It merges the given `config.json` (the one from before the errand names) under the raw local file and reads every moved
// setting the old way, merges this checkout's `config.json` under the moved local file and reads the same settings
// through the readers of today (`errands.*`, `agentSettings`, the tools granted to the persona, whose id comes from
// `--self`), and prints `equal: <n>, differ: <n>` with one line for each difference. It exits 1 on any difference and 0
// otherwise, and changes no byte of the local file on a dry run. Synthetic settings only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/tmp.js';

type Settings = Record<string, unknown>;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'self-1';
const GRANT = { everyone: false, roles: [], users: [SELF] };

/** The `agents` section the config.json from before the errand names carried. */
const OLD_AGENTS = {
  opencodePath: '/opt/opencode/bin/opencode',
  toolResultChars: 6000,
  maxDownloadBytes: 20_000_000,
  keepFilesHours: 24,
  recentLines: 6,
  maxOpen: 3,
  resultMaxChars: 3000,
  unreadShown: 5,
  resultRetrySeconds: 30,
  resultCooldownSeconds: 60,
  ledger: { socket: null },
  scout: {
    enabled: false,
    cost: { input: 2, output: 6 },
    socket: '/run/neptunia-agent-scout/sock',
    out: '/var/lib/neptunia-agent-scout/out',
    limits: { steps: 25, seconds: 300 },
    daily: { tasks: 40 },
    search: { provider: 'exa' },
  },
  server: {
    enabled: false,
    cost: { input: 2, output: 6 },
    socket: '/run/neptunia-agent-server/sock',
    out: '/var/lib/neptunia-agent-server/out',
    limits: { steps: 20, seconds: 120 },
    daily: { tasks: 40 },
  },
  thinker: {
    cost: { input: 4, output: 20 },
    limits: { steps: 400, minutes: 60 },
    contextLimit: 350_000,
    contextHard: 400_000,
  },
  dev: { cost: { input: 2, output: 10 }, limits: { steps: 300, minutes: 60 } },
};

/** The local file of a production-shaped deployment before the names changed. */
const PRODUCTION_LOCAL = {
  bot: {
    self: SELF,
    owners: ['o1'],
    access: {
      'task.run': GRANT,
      'task.status': GRANT,
      'intent.set': GRANT,
      'message.edit': GRANT,
      'memory.refresh.user': GRANT,
    },
  },
  agents: {
    resultRetrySeconds: 45,
    ledger: { socket: null },
    scout: { enabled: true, search: { provider: 'exa' } },
    server: { enabled: true },
  },
};

function files(local: Settings, old: Settings) {
  const dir = tempDir('nep-compare-');
  const file = path.join(dir, 'config.local.json');
  const oldFile = path.join(dir, 'config.before.json');
  fs.writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`);
  fs.writeFileSync(oldFile, `${JSON.stringify(old)}\n`);
  return { file, oldFile };
}

function compare(local: Settings, old: Settings) {
  const { file, oldFile } = files(local, old);
  const before = fs.readFileSync(file, 'utf8');
  const run = spawnSync(
    process.execPath,
    ['tools/config-migrate.mjs', '--dry-run', '--file', file, '--compare-with', oldFile, '--self', SELF],
    { cwd: ROOT, encoding: 'utf8' }
  );
  return {
    code: run.status,
    text: `${run.stdout}\n${run.stderr}`,
    untouched: fs.readFileSync(file, 'utf8') === before,
  };
}

test('prints differ: 0 and exits 0 for a production-shaped file against the config.json from before', () => {
  const run = compare(PRODUCTION_LOCAL, { agents: OLD_AGENTS, bot: { owners: [], access: {} } });
  assert.match(run.text, /equal: [1-9]\d*, differ: 0/);
  assert.equal(run.code, 0);
  assert.equal(run.untouched, true, 'a dry run writes nothing');
});

test('names the setting and exits 1 when the old config.json gave it a value the new readers do not give', () => {
  // The old default of maxOpen is 4 here, the shipped one is 3, and the local file says nothing: a move that lost the
  // setting would show exactly like this.
  const run = compare(PRODUCTION_LOCAL, { agents: { ...OLD_AGENTS, maxOpen: 4 }, bot: { owners: [], access: {} } });
  assert.match(run.text, /differ: 1\b/);
  assert.match(run.text, /maxOpen/);
  assert.equal(run.code, 1);
});

test('reads a setting the local file overrides the same way before and after, so the override survives the move', () => {
  const local = { ...PRODUCTION_LOCAL, agents: { ...PRODUCTION_LOCAL.agents, maxOpen: 9 } };
  const run = compare(local, { agents: OLD_AGENTS, bot: { owners: [], access: {} } });
  assert.match(run.text, /differ: 0/);
  assert.equal(run.code, 0);
});
