// Tests for src/memory/db/intentions-write.ts, the write kind `intentions`: the persona's list of intentions and the
// records moved out of it to the archive, written as `intentions` rows directly instead of through the units
// `intentions.json` and `intentions-archive.jsonl` and their mapper. The tests read the stored list and archive back
// and refuse a record without an id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { intentionsArchiveLines, intentionsValue } from '../../../../src/memory/db/readers/intentions.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../../src/memory/db/types.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { observe, OBSERVATION_VERSION } from '../../../../src/memory/db/observe.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');

function intention(id: string, extra: Row = {}): Row {
  return {
    id,
    purpose: 'ask about the trip',
    status: 'pending',
    createdAt: NOW - 3000,
    updatedAt: NOW - 1000,
    dueAt: NOW + 60_000,
    every: null,
    expiresAt: NOW + 86_400_000,
    awaitingErrandId: null,
    waitDeadline: null,
    destination: null,
    completionCondition: null,
    chainId: null,
    attend: null,
    provenance: { kind: 'self', turnId: 't-1', placeId: 'discord:channel:100', scope: 'group' },
    history: [{ at: NOW - 3000, to: 'pending', by: 'persona' }],
    ...extra,
  };
}

function fresh(name: string): { handle: MemoryHandle; db: Db; close: () => void } {
  const handle = openMemoryDb(path.join(tempDir(`intentions-${name}`), 'memory.db'));
  return { handle, db: dbOf(handle), close: () => handle.close() };
}

test('the readers give the list and the archive lines the intentions write stored', () => {
  // Catches: a reader that mixes archived records into the list, or loses the archive's order.
  const direct = fresh('read');
  try {
    applyMemoryWrite(direct.handle, { kind: 'intentions', op: 'value', intentions: [intention('i1')], now: NOW });
    applyMemoryWrite(direct.handle, {
      kind: 'intentions',
      op: 'archive',
      records: [intention('a2', { status: 'done' }), intention('a1', { status: 'done' })],
      now: NOW,
    });
    assert.deepEqual(intentionsValue(direct.db), { found: true, value: { intentions: [intention('i1')] } });
    assert.deepEqual(
      intentionsArchiveLines(direct.db).map((line) => (JSON.parse(line) as Row).id),
      ['a2', 'a1']
    );
  } finally {
    direct.close();
  }
});

test('the intentions write refuses a record without an id', () => {
  // Catches: a record that lands under no key and can never be read or replaced.
  const direct = fresh('refuse');
  try {
    assert.throws(
      () =>
        applyMemoryWrite(direct.handle, {
          kind: 'intentions',
          op: 'value',
          intentions: [{ purpose: 'no id' }],
          now: NOW,
        }),
      { code: 'INTENTIONS_RECORD' }
    );
  } finally {
    direct.close();
  }
});

const AT = '2026-11-08T10:00:00.000Z';
const SCOPE_NOW = Date.parse('2026-11-08T12:00:00.000Z');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const OPTS = { now: () => SCOPE_NOW, log: quiet };
const AUTHORITY: Record<string, string> = { discord: 'discord/global', telegram: 'telegram/global', cli: 'cli/local' };

function withDb(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

/** Observes one line from `native` in a group channel, so the member has an account and a meta-person and no direct chat. */
function seeInGroup(handle: MemoryHandle, native: string, key = `g${native}:1`): void {
  const authority = AUTHORITY.discord ?? 'discord/global';
  const result = observe(
    handle,
    {
      v: OBSERVATION_VERSION,
      iface: 'discord',
      authority,
      native: { kind: 'message', key, revision: 1 },
      place: { authority, key: 'channel:c1', kind: 'channel', chat: 'channel' },
      author: { kind: 'account', key: native },
      occurredAt: AT,
      observedAt: AT,
      text: `synthetic line ${key}`,
    },
    OPTS
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}

test('an intention for one member with no stored direct chat is internal, never a spelled person', () => {
  // Bug: `stringScope` falls back to the spelled person when the member has no stored direct chat.
  withDb((db, handle) => {
    seeInGroup(handle, '701');
    // The intentions write stores the row (src/memory/db/intentions-write.ts), which the mapper built before.
    applyMemoryWrite(handle, {
      kind: 'intentions',
      op: 'value',
      intentions: [{ id: 'i1', status: 'open', provenance: { scope: 'dm', participants: ['701'] } }],
    });
    const row = db.prepare('SELECT scope_kind, scope_dm FROM intentions WHERE id = ?').get('i1');
    assert.equal(row?.scope_kind, 'internal');
    assert.equal(row?.scope_dm, null);
  });
});
