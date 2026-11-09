// src/setup/model-check.ts: the recorded check of the core model, which lets a launch read its readiness with no model
// request. Only the files of a temp data folder are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { coreSelection, readCoreCheck, recordCoreCheck } from '../src/setup/model-check.ts';
import { tempDir } from './fixtures/tmp.ts';
import { chainsOf } from './fixtures/chains.ts';

const SELECTION = 'openrouter:vendor/core-1';

test('the check of the core model survives a relaunch and answers for its own selection', () => {
  // Catches: readiness kept in the memory of one chat, so every launch needs a paid request again.
  const dataDir = tempDir('nep-readiness-');
  assert.equal(readCoreCheck(dataDir), null);
  const check = { selection: SELECTION, ok: true, code: null, at: 5 };
  recordCoreCheck(dataDir, check);
  assert.deepEqual(readCoreCheck(dataDir), check);
});

test('a record that cannot be read is no check at all', () => {
  // Catches: a torn write crashes the launch that was going to report it.
  const dataDir = tempDir('nep-readiness-');
  recordCoreCheck(dataDir, { selection: SELECTION, ok: true, code: null, at: 5 });
  const [file] = fs.readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((one) => one.isFile());
  fs.writeFileSync(path.join(file?.parentPath ?? '', file?.name ?? ''), '{ torn');
  assert.equal(readCoreCheck(dataDir), null);
});

test('the selection follows the model of the core role', () => {
  // Catches: a selection that stays the same when the owner changes the model, so a stale check reads as current.
  assert.equal(coreSelection({ models: { routes: chainsOf({ core: 'vendor/core-1' }) } }), SELECTION);
  assert.notEqual(coreSelection({ models: { routes: chainsOf({ core: 'vendor/core-2' }) } }), SELECTION);
});
