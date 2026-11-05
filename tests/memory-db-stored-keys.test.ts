// The stored JSON keys of plan 2026-11-04-cli-and-memory B0: the last schema migration and the offline converter both put
// an account and a tree's top under their one name, so a row written before the rename reads back whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryDb, MIGRATIONS } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { neutralJson } from '../src/memory/migration/convert-map.ts';

function opened(): { file: string; remove(): void } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stored-keys-'));
  const file = path.join(root, 'memory.db');
  openMemoryDb(file).close();
  return { file, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the migration renames the keys of a stored row and leaves a value spelled the same alone', () => {
  // Bug: a waiting errand or a held message keeps `requester.userId`, and the renamed reader finds nobody.
  const stored = opened();
  try {
    const raw = new DatabaseSync(stored.file);
    const row = {
      requester: { userId: 'u1', kind: 'member' },
      conversation: { id: 'c1', communityId: 'g1' },
      note: 'the word "userId" in a text',
    };
    raw.prepare('INSERT INTO operational (kind, owner, value) VALUES (?, ?, ?)').run('state', 'o', JSON.stringify(row));
    const step = MIGRATIONS.at(-1);
    if (typeof step !== 'function') throw new Error('the last migration is a function of the connection');
    step(dbOf({ db: raw }), {});
    const value = raw.prepare('SELECT value FROM operational WHERE owner = ?').get('o') as { value: string };
    raw.close();
    assert.deepEqual(JSON.parse(value.value), {
      requester: { accountId: 'u1', kind: 'member' },
      conversation: { id: 'c1', rootId: 'g1' },
      note: 'the word "userId" in a text',
    });
  } finally {
    stored.remove();
  }
});

test('the converter names an account and a tree top as the engine reads them', () => {
  // Bug: a converted database keeps the old keys and the first turn after the cutover loses its partner.
  assert.deepEqual(
    neutralJson({
      requester: { userId: 'u1' },
      turn: { privateUserId: 'u2' },
      conversation: { communityId: 'g1', id: 'c1' },
      addressing: { mentionedUserIds: ['u3'] },
      message: { replyPingUserId: 'u4' },
    }),
    {
      requester: { accountId: 'u1' },
      turn: { privateAccountId: 'u2' },
      conversation: { rootId: 'g1', id: 'c1' },
      addressing: { mentionedAccountIds: ['u3'] },
      message: { replyPingAccountId: 'u4' },
    }
  );
});
