// The paired switch of code, database and config at the cutover, and its rollback, rehearsed on a copy (plan
// 2026-11-05-master-plan, S10.7). A closed v28 database and its config are copied into a data folder, backed up with
// `backupDatabase`, converted by the offline converter and swapped in. The new code then opens them (the database
// directly, then the core with a fake interface unit on its socket). A rollback is the operator's: stop the core,
// preserve what the new database took in, put the backed-up database and config back. A second group of tests holds the
// writer the way a maintenance tool does (`acquireLock`) while a message reaches the interface unit.
//
// The converter output has the current schema, so "open with the new code" opens a database that is already current.
// The old engine does not exist in this checkout: "open with the restored files" is a read-only look at the v28 file and
// a second conversion of it.
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backupDatabase, checkBackup } from '../src/memory/db/backup.ts';
import { MIGRATIONS, acquireLock, lockPathOf, openMemoryDb, schemaVersion } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
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
import { SCRIPT, convert, rowsOf, scene, sha256, tablesOf } from './fixtures/memory-db/one-server.ts';
import type { Scene } from './fixtures/memory-db/one-server.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';

type Settings = Record<string, unknown>;
type Report = {
  contentHash: string;
  output: { schemaVersion: number };
  tables: Record<string, { output: number }>;
  config: { removed: Array<string>; moved: Array<{ from: string; to: string }> };
};

/** The settings of the install before the switch: the retired main channel and the home server are still in them. */
const OLD_SETTINGS: Settings = {
  bot: { timezone: 'UTC', guildId: 'g1', owners: ['u1'], placeId: 'g1' },
  memory: { mainChannelIds: ['c1'], aliasHalfLifeDays: 3 },
  selfreflection: { enabled: true },
};

const jsonOf = (file: string): Settings => JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
const treeOf = (dir: string): Array<string> => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
/** The native ids of the lines the live path stored; the seeded legacy lines have no message family. */
const lines = (dirs: Dirs): Array<string> => seenIds(dirs).filter((id): id is string => typeof id === 'string');
const countOf = (dirs: Dirs, sql: string): number => Number(query(dirs, sql)[0]?.n ?? 0);

/** Every ordinary table of a database file and its rows, in a stable order. */
function snapshot(file: string): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(tablesOf(file).map((table) => [table, rowsOf(file, table)]));
}

/** One install: the live data folder holding the old v28 database and config, and the files a switch moves around. */
type World = {
  rig: Rig;
  /** The synthetic v28 database as seeded; nothing writes to it. */
  pristine: Scene;
  db: string;
  config: string;
  backup: string;
  work: Scene;
  /** The config as it was before the switch, and the files it was made of. */
  configBefore: Settings;
  treeBefore: Array<string>;
};

function world(rig: Rig): World {
  const pristine = scene();
  const db = path.join(rig.dirs.dataDir, 'memory.db');
  fs.copyFileSync(pristine.input, db);
  const config = path.join(rig.dirs.dataDir, 'config');
  const workDir = path.join(rig.dirs.root, 'work');
  fs.mkdirSync(workDir);
  return {
    rig,
    pristine,
    db,
    config,
    backup: path.join(rig.dirs.root, 'backup', 'pre-switch'),
    work: {
      input: db,
      configIn: config,
      outDir: workDir,
      output: path.join(workDir, 'memory.db'),
      configOut: path.join(workDir, 'config'),
      report: path.join(workDir, 'report.json'),
    },
    configBefore: jsonOf(path.join(config, 'config.json')),
    treeBefore: treeOf(config),
  };
}

/**
 * The cutover as the operator does it with the core stopped: back up the old files, convert them, move the converted
 * database and config into the data folder. Returns the conversion report.
 */
function switchOver(w: World): Report {
  backupDatabase({ db: w.db, to: w.backup, data: w.rig.dirs.dataDir });
  const { status, stderr } = convert(w.work);
  assert.equal(status, 0, stderr);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${w.db}${suffix}`, { force: true });
  fs.rmSync(w.config, { recursive: true });
  fs.renameSync(w.work.output, w.db);
  fs.renameSync(w.work.configOut, w.config);
  return JSON.parse(fs.readFileSync(w.work.report, 'utf8')) as Report;
}

/** The rollback: the backed-up database and config go back; whatever the new config added goes with it. */
function rollBack(w: World): void {
  checkBackup(w.backup);
  for (const suffix of ['', '-wal', '-shm', '.lock']) fs.rmSync(`${w.db}${suffix}`, { force: true });
  fs.rmSync(w.config, { recursive: true });
  fs.copyFileSync(path.join(w.backup, 'memory.db'), w.db);
  fs.cpSync(path.join(w.backup, 'config'), w.config, { recursive: true });
}

const switched = (body: (w: World, report: Report) => void | Promise<void>): Promise<void> =>
  withRig({ config: OLD_SETTINGS, clients: [FAKE_CLIENT] }, async (rig) => {
    const w = world(rig);
    await body(w, switchOver(w));
  });

// ---- the new code opens what the converter wrote ----

test('the switched database opens at the current schema with every table the size the report states', () =>
  switched((w, report) => {
    // Bug: the converter promises a count the opened database does not hold, and the cutover looks clean.
    const handle = openMemoryDb(w.db, { readOnly: true });
    try {
      assert.equal(schemaVersion(dbOf(handle)), MIGRATIONS.length);
    } finally {
      handle.close();
    }
    assert.equal(report.output.schemaVersion, MIGRATIONS.length);
    const wrong = tablesOf(w.db).flatMap((table) => {
      const promised = report.tables[table]?.output;
      return promised === undefined || promised === rowsOf(w.db, table).length ? [] : [`${table}: ${promised}`];
    });
    assert.deepEqual(wrong, []);
    assert.ok(Object.keys(report.tables).length > 50, 'the report covers the tables');
  }));

test('the switched config keeps every other setting and moves exactly the two retired ones', () =>
  switched((w, report) => {
    // Bug: the converted config drops a setting of the install, or keeps the home server and the main channel.
    const after = jsonOf(path.join(w.config, 'config.json'));
    const bot = { ...(w.configBefore.bot as Settings) };
    delete bot.guildId;
    const memory = { ...(w.configBefore.memory as Settings) };
    delete memory.mainChannelIds;
    assert.deepEqual(after, { ...w.configBefore, bot, memory });
    assert.deepEqual(jsonOf(path.join(w.config, 'interfaces', 'discord', 'config.json')), { servers: ['g1'] });
    assert.deepEqual(report.config.removed, ['memory.mainChannelIds']);
  }));

test('the core starts over the switched files, answers a message once and keeps the seeded rows', () =>
  switched(async (w) => {
    // Bug: the new code refuses or mangles the converted install, or the first message after the switch is lost.
    const { dirs, llm, units, cores } = w.rig;
    const seeded = countOf(dirs, "SELECT count(*) AS n FROM sources WHERE kind = 'seen'");
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(await (await unit.emit(mention('m1', 'hello after the switch'))).acked, 'ok');
    await until(() => llm.requests.length === 1, 'the turn of m1');
    assert.equal(countOf(dirs, "SELECT count(*) AS n FROM sources WHERE kind = 'seen'"), seeded + 1);
    assert.equal(lines(dirs).filter((id) => id === 'm1').length, 1);
  }));

// ---- rollback ----

/** The switch, one message taken by the new code, the core stopped: the state a rollback decision starts from. */
async function resumed(w: World): Promise<void> {
  const { dirs, llm, units, cores } = w.rig;
  const core = await startUnitsCore(dirs, llm);
  cores.push(core);
  const unit = await startedUnit(dirs);
  units.push(unit);
  assert.equal(await (await unit.emit(mention('m1', 'written after the switch'))).acked, 'ok');
  await until(() => llm.requests.length === 1, 'the turn of m1');
  await unit.kill();
  await core.stop();
  cores.pop();
}

test('a backup taken before the rollback holds the lines the new code wrote after the switch', () =>
  switched(async (w) => {
    // Bug: the rollback replaces the database first, and the messages of the resumed hours are gone with it.
    await resumed(w);
    const preserved = path.join(w.rig.dirs.root, 'backup', 'post-switch');
    const live = backupDatabase({ db: w.db, to: preserved, data: w.rig.dirs.dataDir });
    assert.equal(checkBackup(preserved).schemaVersion, MIGRATIONS.length);
    const pre = checkBackup(w.backup);
    assert.ok((live.rows?.sources ?? 0) > (pre.rows?.sources ?? 0), 'the preserved copy has the new lines');
    const handle = openMemoryDb(path.join(preserved, 'memory.db'), { readOnly: true });
    try {
      const texts = dbOf(handle)
        .prepare("SELECT text FROM sources WHERE kind = 'seen' AND text LIKE '%written after the switch%'")
        .all() as Array<{ text: string }>;
      assert.equal(texts.length, 1);
    } finally {
      handle.close();
    }
  }));

test('after a rollback every table and every setting is what the install had before the switch', () =>
  switched(async (w) => {
    // Bug: the restored database or config differs from the pre-switch one, so the old engine starts on altered data.
    await resumed(w);
    rollBack(w);
    assert.deepEqual(snapshot(w.db), snapshot(w.pristine.input));
    assert.deepEqual(jsonOf(path.join(w.config, 'config.json')), w.configBefore);
    assert.deepEqual(treeOf(w.config), w.treeBefore);
    const handle = openMemoryDb(w.db, { readOnly: true });
    try {
      assert.equal(schemaVersion(dbOf(handle)), 28);
    } finally {
      handle.close();
    }
  }));

test('a switch repeated after a rollback converts to the same content as the first', () =>
  switched((w, first) => {
    // Bug: the restore leaves the old files in a state the converter reads differently, so a retry gives other data.
    const converted = snapshot(w.db);
    rollBack(w);
    fs.rmSync(w.work.outDir, { recursive: true });
    fs.mkdirSync(w.work.outDir);
    const { status, stderr } = convert(w.work);
    assert.equal(status, 0, stderr);
    const again = JSON.parse(fs.readFileSync(w.work.report, 'utf8')) as Report;
    assert.equal(again.contentHash, first.contentHash);
    assert.deepEqual(snapshot(w.work.output), converted);
  }));

// ---- a message that arrives while maintenance holds the writer ----

const hold = (w: World): (() => void) => acquireLock(w.db);

test('a core cannot start while maintenance holds the writer, and the refused start writes nothing', () =>
  switched(async (w) => {
    // Bug: a second writer opens the database under a maintenance tool and lands a line in it.
    const { dirs, llm } = w.rig;
    const before = sha256(w.db);
    const release = hold(w);
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
  switched(async (w) => {
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

    const release = hold(w);
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

test('the converter holds the writer lock while it runs, so no core opens the input mid-conversion', async () => {
  // Bug: a core started during the conversion writes into the old database, and the swap that follows drops its lines.
  const probe = scene();
  const child = spawn(
    process.execPath,
    [
      SCRIPT,
      '--input',
      probe.input,
      '--output',
      probe.output,
      '--config-in',
      probe.configIn,
      '--config-out',
      probe.configOut,
      '--report',
      probe.report,
      '--now',
      '2026-11-06T00:00:00.000Z',
    ],
    { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: 'ignore' }
  );
  let over = false;
  const ended = new Promise<void>((resolve) =>
    child.once('exit', () => {
      over = true;
      resolve();
    })
  );
  let held = false;
  while (!over && !held) {
    held = fs.existsSync(lockPathOf(probe.input));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await ended;
  assert.equal(held, true, 'no writer lock stood beside the input while the converter ran');
});
