// scripts/config-migrate.ts and the key settings that left the schema (spec 2026-11-02, follow-up 3): once keys.json
// exists beside the local layer, `llm.keyByRole` and `llm.keys` are dropped with a line naming scripts/keys-import.ts;
// without the store they stay, because the import has not moved the keys yet. The private folder is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../scripts/config-migrate.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const LEGACY = {
  llm: {
    maxRequestTokens: 50000,
    keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' },
    keys: { OPENROUTER_CORE_KEY: { grant: 200, resetDay: 22 } },
  },
};

/** A private folder with `config.local/config.json` holding `config`, and keys.json beside it when `store` is true. */
function layer(config: Record<string, unknown>, store: boolean): { privateDir: string; file: string } {
  const privateDir = tempDir('nep-migrate-keys-');
  const file = path.join(privateDir, 'config.local', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config));
  if (store) writeKeysFile(privateDir);
  return { privateDir, file };
}

const llmOf = (file: string): Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(file, 'utf8')) as { llm: Record<string, unknown> }).llm;

test('with keys.json beside the local layer, --apply drops llm.keyByRole and llm.keys and keeps the other llm keys', async () => {
  // Catches: the old key map stays in the local layer after the import and /config check reports it as unknown.
  const { file } = layer(LEGACY, true);
  await main(['--apply', '--file', file]);
  assert.deepEqual(llmOf(file), { maxRequestTokens: 50000 });
});

test('the report of the drop names both keys and scripts/keys-import.ts', async () => {
  // Catches: the keys vanish from the file and nothing tells the owner where they went.
  const { file } = layer(LEGACY, true);
  const report = await main(['--dry-run', '--file', file]);
  assert.match(report, /llm\.keyByRole/);
  assert.match(report, /llm\.keys(?![A-Za-z])/);
  assert.match(report, /scripts\/keys-import\.ts/);
});

test('without keys.json, --apply leaves both keys and the report says to run scripts/keys-import.ts first', async () => {
  // Catches: the migration drops the only record of which .env variable serves which role before the import ran.
  const { file } = layer(LEGACY, false);
  const report = await main(['--apply', '--file', file]);
  assert.deepEqual(llmOf(file), LEGACY.llm);
  assert.ok(report.includes('scripts/keys-import.ts'));
});

test('a local layer with neither key says nothing about the import', async () => {
  // Catches: every migration, even of a deployment that never had the old keys, nags about scripts/keys-import.ts.
  const { file } = layer({ llm: { maxRequestTokens: 50000 } }, false);
  const report = await main(['--dry-run', '--file', file]);
  assert.equal(report.includes('keys-import'), false);
});
