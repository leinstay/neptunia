// Stage T.9 of the master plan: the inspection port (src/memory/db/inspection-snapshots.ts) holds at most
// `bounds.maxSnapshots` snapshots open at once, each a read-only connection with a transaction pinned. The next
// `openInspection` is refused with the code INSPECTION_TOO_MANY and a message that names the cap, before any connection
// is opened. A closed or expired snapshot frees its place. The bound is the documented setting
// `memoryDb.inspection.maxSnapshots`. The clock is injected, the database is a real temporary file.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkConfig } from '../src/config/check.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { createInspectionPort } from '../src/memory/db/inspection-snapshots.ts';
import type { InspectionBounds } from '../src/memory/db/inspection-snapshots.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const OWNER = 'owner-1';
const BOUNDS: InspectionBounds = { pageRows: 100, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 2 };

const writers: Array<MemoryHandle> = [];
const ports: Array<{ closeAll(): void }> = [];
after(() => {
  for (const port of ports) port.closeAll();
  for (const writer of writers) writer.close();
});

function rig() {
  const file = join(tempDir('nep-inspect-cap-'), 'memory.db');
  writers.push(openMemoryDb(file));
  const clock = { at: T0 };
  const opens: Array<unknown> = [];
  const port = createInspectionPort({
    dbPath: file,
    now: () => clock.at,
    engineRevision: 'rev-synthetic',
    open: (path, options = {}) => {
      opens.push(options);
      return openMemoryDb(path, options);
    },
  });
  ports.push(port);
  return { port, clock, opens };
}

test('the open that passes the cap is refused with INSPECTION_TOO_MANY and names the cap', () => {
  // Catches: every /memory inspect holds a pinned read connection with no bound, so the write-ahead log cannot reset.
  const { port } = rig();
  port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  assert.throws(
    () => port.openInspection({ ownerId: OWNER, bounds: BOUNDS }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INSPECTION_TOO_MANY');
      assert.match(error.message, /\b2\b/);
      return true;
    }
  );
});

test('a refused open opens no connection', () => {
  // Catches: the refusal comes after the read-only connection was opened, which leaks one per refused command.
  const { port, opens } = rig();
  port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  assert.throws(() => port.openInspection({ ownerId: OWNER, bounds: BOUNDS }));
  assert.equal(opens.length, 2);
});

test('closing a snapshot frees its place for the next open', () => {
  // Catches: the count only grows, so the cap locks inspection until the process restarts.
  const { port } = rig();
  const first = port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  port.closeInspection(first);
  assert.doesNotThrow(() => port.openInspection({ ownerId: OWNER, bounds: BOUNDS }));
});

test('a snapshot that expired without a close frees its place too', () => {
  // Catches: an abandoned snapshot keeps counting after it expired, so the owner is refused by a ghost.
  const { port, clock } = rig();
  port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  clock.at += 61_000;
  assert.doesNotThrow(() => port.openInspection({ ownerId: OWNER, bounds: BOUNDS }));
});

test('the cap is documented as memoryDb.inspection.maxSnapshots and typed by the schema', () => {
  // Catches: the cap is a constant in the code, or /config check calls the owner's setting unknown.
  const inspection = { pageRows: 3, snapshotIdleSeconds: 7, snapshotMaxSeconds: 11, maxSnapshots: 4 };
  assert.deepEqual(checkConfig({ memoryDb: { inspection } }, CONFIG_SCHEMA), []);
  assert.notDeepEqual(
    checkConfig({ memoryDb: { inspection: { ...inspection, maxSnapshots: 'several' } } }, CONFIG_SCHEMA),
    []
  );
});
