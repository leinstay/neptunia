// A maintenance tool holds the writer the way `acquireLock` does while the core is down or starting, and a message
// reaches the interface unit meanwhile. The core opens the live data folder of a fresh install over its own database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, lockPathOf, openMemoryDb } from '../src/memory/db/open.ts';
import {
  FAKE_CLIENT,
  mention,
  query,
  seenIds,
  settle,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from './fixtures/core-units.ts';
import type { Dirs, Rig } from './fixtures/core-units.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** The native ids of the lines the live path stored. */
const lines = (dirs: Dirs): Array<string> => seenIds(dirs).filter((id): id is string => typeof id === 'string');
const countOf = (dirs: Dirs, sql: string): number => Number(query(dirs, sql)[0]?.n ?? 0);

/** One install: its rig and the database file in its data folder, created at the current schema. */
type World = { rig: Rig; db: string };

const maintained = (body: (w: World) => void | Promise<void>): Promise<void> =>
  withRig({ clients: [FAKE_CLIENT] }, async (rig) => {
    const db = path.join(rig.dirs.dataDir, 'memory.db');
    openMemoryDb(db).close();
    await body({ rig, db });
  });

test('a core cannot start while maintenance holds the writer, and the refused start writes nothing', () =>
  maintained(async (w) => {
    // Bug: a second writer opens the database under a maintenance tool and lands a line in it.
    const { dirs, llm } = w.rig;
    const before = sha256(w.db);
    const release = acquireLock(w.db);
    try {
      await assert.rejects(startUnitsCore(dirs, llm), /locked/);
      assert.equal(
        fs.existsSync(path.join(dirs.dataDir, 'run', 'core.sock')),
        false,
        'the refused start left a socket'
      );
    } finally {
      release();
    }
    assert.equal(sha256(w.db), before);
    assert.equal(fs.existsSync(lockPathOf(w.db)), false, 'maintenance released the lock');
  }));

test('a message that arrives while maintenance holds the writer is handled once when the database opens', () =>
  maintained(async (w) => {
    // Bug: the line is lost, answered twice, or stored twice when the interface recovers it after the restart.
    const { dirs, llm, units, cores } = w.rig;
    const core = await startUnitsCore(dirs, llm);
    cores.push(core);
    const first = await startedUnit(dirs);
    units.push(first);
    assert.equal(await (await first.emit(mention('m1', 'before maintenance'))).acked, 'ok');
    await until(() => llm.requests.length === 1, 'the turn of m1');
    await core.stop();
    cores.pop();

    const release = acquireLock(w.db);
    // The core is down, so the line waits in the unit's outbox; the unit then dies before any core takes it.
    const waiting = lineEvent({ id: 'm2', text: 'said during maintenance', at: Date.now() });
    await first.emit(waiting);
    await first.kill('SIGKILL');
    await assert.rejects(startUnitsCore(dirs, llm), /locked/);
    assert.deepEqual(lines(dirs), ['m1'], 'nothing was written while the writer was held');
    release();

    cores.push(await startUnitsCore(dirs, llm));
    const second = await startedUnit(dirs);
    units.push(second);
    await until(() => lines(dirs).includes('m2'), 'm2 kept after the database opened');
    // The interface recovers the same line from the platform's history under an event id of its own.
    const recovered = await second.emit({ ...waiting, id: 'fake:recovered:m2' });
    assert.ok(['ok', 'duplicate'].includes(await recovered.acked), 'the core answered the recovered event');
    await settle(600);
    assert.deepEqual(lines(dirs), ['m1', 'm2'], 'one stored line for m2');
    assert.equal(llm.requests.length, 1, 'the line of the maintenance hours starts no turn of its own');
    assert.equal(countOf(dirs, "SELECT count(*) AS n FROM ingest WHERE event_id = 'fake:message:m2'"), 1);
    // Handling has resumed: the next call is answered.
    assert.equal(await (await second.emit(mention('m3', 'back again'))).acked, 'ok');
    await until(() => llm.requests.length === 2, 'the turn of m3');
  }));
