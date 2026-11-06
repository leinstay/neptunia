// The audience fill over the entries as production holds them: an old group entry carries the kind it was written with
// (none, `meme`, `selfPicture`), not the literal `entry`, and its `extra` may hold a `$null` key. Real temporary
// database built by the public migration path, synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle, Row } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const KINDS: Array<string | null> = [null, 'meme', 'selfPicture'];

type Filled = { ok: true; written: number; dryRun: boolean };

function withKindedEntries(body: (handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(join(tempDir('nep-audience-fill-kinds-'), 'memory.db'));
  try {
    const put = dbOf(handle).prepare(
      `INSERT INTO selfreflection (id, at_ms, kind, text, status, scope_kind, scope_iface, extra, retired_at)
       VALUES (?, ?, ?, 'a synthetic evening', 'done', 'group', 'discord', ?, NULL)`
    );
    KINDS.forEach((kind, i) => put.run(`e:kind-${i}`, i + 1, kind, JSON.stringify({ $null: ['search'] })));
    body(handle);
  } finally {
    handle.close();
  }
}

const fill = (handle: MemoryHandle, update: Row = {}): Filled =>
  applyMemoryWrite(handle, { kind: 'selfreflection-audience-fill', by: 'owner', now: NOW, ...update }) as Filled;

test('a fill writes a group entry of any kind and keeps its `$null` key', () => {
  // Bug: the fill selects `kind = 'entry'`, so the 78 old entries (kinds NULL, meme, facts, picture, status...) are skipped.
  withKindedEntries((handle) => {
    assert.equal(fill(handle).written, 3);
    for (let i = 0; i < KINDS.length; i += 1) {
      const row = dbOf(handle).prepare('SELECT extra FROM selfreflection WHERE id = ?').get(`e:kind-${i}`);
      assert.deepEqual(JSON.parse(String(row?.extra)), {
        $null: ['search'],
        publicationAudience: { kind: 'unrestricted' },
      });
    }
  });
});

test('a dry run counts group entries of any kind', () => {
  // Bug: `--dry-run` reports 0 on production because no old entry has the kind `entry`.
  withKindedEntries((handle) => {
    const dry = fill(handle, { dryRun: true });
    assert.deepEqual([dry.written, dry.dryRun], [3, true]);
  });
});
