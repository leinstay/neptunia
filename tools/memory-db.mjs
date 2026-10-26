#!/usr/bin/env node
// Operations tool for the memory database (`data/memory.db`, spec: the memory store). Run from a checkout:
//
//   node tools/memory-db.mjs stats --db <file>
//        Row counts of every table of the schema (sqlite_master), per scope kind where a table has scopes, and per
//        audience where it has `audience_id` (none, internal, each interface's group, DM rows with the number of DM
//        places; no ids printed).
//   node tools/memory-db.mjs hash --db <file> [--tables a,b]
//        One content hash per table (SHA-256 of every row in primary-key order, every column, retired rows included; a
//        table without a primary key in the order of all its columns; a full-text table by its index content, so two
//        files holding the same rows and the same index hash the same whatever their page layout). The round-trip
//        contract: a `VACUUM INTO` copy hashes like its source. Opens the database read-only.
//   node tools/memory-db.mjs reproject --db <file>
//        Projects every typed row into the graph again (src/memory/db/graph.js#reproject; idempotent), and finishes a
//        projection the v9 migration left pending.
//   node tools/memory-db.mjs rebuild --db <file>
//        The rebuildability contract: drops the derived rows (the graph projection and its `node_access`) and builds
//        them again from the typed tables, then rebuilds the full-text indexes. Prints the hashes of the derived tables
//        before and after. An edge the graph had retired because its row no longer produces it is history the typed
//        tables do not hold: a rebuild does not bring it back (it says how many such edges there were).
//   node tools/memory-db.mjs ledger-import --ledger <ledger.db> --db <file>
//        Copies the task ledger's rows into the reserved ledger_* tables as JSON records (the source is opened
//        read-only).
//   node tools/memory-db.mjs index-policy --db <file> [--apply] [--days <n>]
//        The index policy (src/memory/db/index-policy.js): the tier of every stored line and the vectors outside the
//        owner's classes (older than --days, default `recall.db.vectorDays` 90, and not cited, pinned, touched or
//        consolidated). Without --apply it prints what it would evict and changes nothing (read-only); with --apply it
//        writes the tiers and evicts (the vector rows stay, only their bytes go).
//   node tools/memory-db.mjs media-check --db <file> --data <dir> [--apply]
//        Her diary media: each `media` row of kind diary is `present` when its file under the data directory exists
//        with the stored size, else `missing`; every other row stays `unknown`. Prints the counts; --apply writes them.
//   node tools/memory-db.mjs backup --db <file> --to <dir> [--data <dir>]
//        `VACUUM INTO <dir>/memory.db`, a copy of `media/diary/` (from --data, default the database's directory) and
//        `<dir>/manifest.json`: every file with its size and SHA-256, the schema version, the engine commit and the row
//        count of every table (src/memory/db/backup.js; the bot's own daily backup, `memoryDb.backup`, also names the
//        config's hash). The directory must be new or empty. Opens the database read-only.
//   node tools/memory-db.mjs restore --from <dir> --db <file> [--data <dir>]
//        Checks every file of the backup against its manifest, then restores the database to --db (which must not
//        exist) and the diary media under --data (default the new database's directory; no file is overwritten), and
//        checks the schema version and the row counts of the restored file.
//   node tools/memory-db.mjs restore-test --from <backup dir>
//        The exact-restore rehearsal: `restore` of the backup into a new temporary data directory, the content hash of
//        every table of the restored database compared with the same hash of the backup's own database, then a memory
//        service opened there (no worker, no network, no interface, every job off). Exit 1 on any difference or when
//        the service does not open the restored database. The temporary directory is removed in every case.
//
// reproject, rebuild, ledger-import, index-policy --apply and media-check --apply take the database's writer lock and
// refuse while the bot (or another tool) holds it.
// The database is never added to git. Nothing here starts the bot or calls a model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../src/memory/db/open.js';
import { rebuildGraph, reproject, projectPending } from '../src/memory/db/graph.js';
import { checkMedia, classify as classifyIndex } from '../src/memory/db/index-policy.js';
import { backupDatabase, restoreDatabase, tablesOf } from '../src/memory/db/backup.js';
import { createMemoryDb, engineCommit } from '../src/memory/db/service.js';

export { backupDatabase, restoreDatabase };

const FLAGS = new Set(['apply']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (FLAGS.has(name)) options[name] = true;
    else {
      if (i + 1 >= rest.length) throw new Error(`--${name} needs a value`);
      options[name] = rest[(i += 1)];
    }
  }
  return { command, options };
}

const need = (options, ...names) => {
  for (const name of names) if (!options[name]) throw new Error(`--${name} is required`);
};

const seconds = (start) => `${((performance.now() - start) / 1000).toFixed(1)}s`;

// ---------- stats ----------

function runStats(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const db = handle.db;
    for (const { name: table } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()) {
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((column) => column.name)
      );
      const total = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
      let line = `${table.padEnd(22)} ${String(total).padStart(8)}`;
      if (columns.has('retired_at'))
        line += `  retired ${db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE retired_at IS NOT NULL`).get().n}`;
      if (columns.has('scope_kind') && total) {
        const scopes = db
          .prepare(`SELECT scope_kind AS k, COUNT(*) AS n FROM "${table}" GROUP BY scope_kind ORDER BY k`)
          .all();
        line += `  scope ${scopes.map((scope) => `${scope.k ?? 'null'}=${scope.n}`).join(' ')}`;
      }
      if (columns.has('audience_id') && total) {
        const kinds = db
          .prepare(
            `SELECT CASE WHEN audience_id IS NULL THEN 'null' WHEN audience_id LIKE 'aud:dm:%' THEN 'dm' ELSE substr(audience_id, 5) END AS k,
          COUNT(*) AS n, COUNT(DISTINCT CASE WHEN audience_id LIKE 'aud:dm:%' THEN audience_id END) AS places FROM "${table}" GROUP BY 1 ORDER BY 1`
          )
          .all();
        line += `  audience ${kinds.map((kind) => `${kind.k}=${kind.n}${kind.k === 'dm' ? ` (${kind.places} places)` : ''}`).join(' ')}`;
      }
      io.out(line);
    }
    return 0;
  } finally {
    handle.close();
  }
}

// ---------- hash, reproject, rebuild ----------

const valueOf = (value) => {
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  if (typeof value === 'bigint') return ['int', String(value)];
  return [value === null ? 'null' : typeof value, value];
};

/**
 * The content hash of every table (or of `only`): `[{ table, rows, hash }]`. Rows in primary-key order, every column;
 * a table without a primary key in the order of all its columns; a full-text table by its index content (fts5vocab
 * `instance`: every term, row, column and offset).
 */
export function tableHashes(db, only = null) {
  const out = [];
  for (const { name, virtual } of tablesOf(db)) {
    if (only && !only.includes(name)) continue;
    const hash = createHash('sha256');
    let rows = 0;
    let statement;
    if (virtual) {
      const vocab = `_hash_${name}`;
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp."${vocab}" USING fts5vocab(main, "${name}", 'instance')`);
      statement = db.prepare(`SELECT term, doc, col, offset FROM temp."${vocab}" ORDER BY term, doc, col, offset`);
    } else {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
      const keys = columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      const order = (keys.length ? keys : columns.map((column) => column.name))
        .map((column) => `"${column}"`)
        .join(', ');
      statement = db.prepare(
        `SELECT ${columns.map((column) => `"${column.name}"`).join(', ')} FROM "${name}" ORDER BY ${order}`
      );
    }
    for (const row of statement.iterate()) {
      hash.update(JSON.stringify(Object.values(row).map(valueOf)));
      hash.update('\n');
      rows += 1;
    }
    out.push({ table: name, rows, hash: hash.digest('hex') });
  }
  return out;
}

function runHash(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const only = options.tables
      ? String(options.tables)
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      : null;
    const hashes = tableHashes(handle.db, only);
    for (const { table, rows, hash } of hashes) io.out(`${table.padEnd(26)} ${String(rows).padStart(8)}  ${hash}`);
    const missing = (only ?? []).filter((name) => !hashes.some((entry) => entry.table === name));
    for (const name of missing) io.out(`${name.padEnd(26)} no such table`);
    return missing.length ? 1 : 0;
  } finally {
    handle.close();
  }
}

function runReproject(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db);
  try {
    const at = new Date().toISOString();
    const pending = projectPending(handle, { at });
    const done = reproject(handle, { at });
    io.out(
      `graph: ${done.units} units projected, ${done.edges} edges, ${done.retired} retired as stale, ${done.ms} ms${pending.units ? ` (the pending projection took ${pending.ms} ms)` : ''}`
    );
    return 0;
  } finally {
    handle.close();
  }
}

/** The derived tables the rebuild drops and builds again. */
export const DERIVED_TABLES = ['graph_nodes', 'graph_edges', 'node_access', 'sources_fts', 'sources_tri'];

function runRebuild(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db);
  try {
    const before = tableHashes(handle.db, DERIVED_TABLES);
    const stale = handle.db.prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL').get().n;
    const done = rebuildGraph(handle, { at: new Date().toISOString() });
    handle.transaction(() => {
      handle.db.exec(
        "INSERT INTO sources_fts(sources_fts) VALUES ('rebuild'); INSERT INTO sources_tri(sources_tri) VALUES ('rebuild');"
      );
    });
    const after = tableHashes(handle.db, DERIVED_TABLES);
    const keptRetired = handle.db.prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL').get().n;
    io.out(
      `graph rebuilt: ${done.units} units, ${done.edges} edges in ${done.ms} ms; retired edges ${stale} before, ${keptRetired} after (the rest were stale: their rows no longer produce them)`
    );
    let differ = 0;
    for (const entry of after) {
      const was = before.find((row) => row.table === entry.table);
      const same = was?.hash === entry.hash;
      if (!same) differ += 1;
      io.out(
        `${entry.table.padEnd(26)} ${String(was?.rows ?? 0).padStart(8)} -> ${String(entry.rows).padStart(8)}  ${same ? 'equal' : 'differs'}`
      );
    }
    io.out(
      differ ? `rebuild: ${differ} derived tables differ from before` : 'rebuild: every derived table equal to before'
    );
    return 0;
  } finally {
    handle.close();
  }
}

// ---------- ledger-import ----------

const LEDGER_TABLES = ['tasks', 'attempts', 'questions', 'approvals', 'results', 'comments', 'events', 'outbox'];

function runLedgerImport(io, options) {
  need(options, 'ledger', 'db');
  const source = openMemoryDb(options.ledger, { readOnly: true });
  const target = openMemoryDb(options.db);
  try {
    const counts = {};
    target.transaction(() => {
      for (const table of LEDGER_TABLES) {
        const exists = source.db
          .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table);
        counts[table] = 0;
        if (!exists) continue;
        const insert = target.db.prepare(`INSERT OR REPLACE INTO ledger_${table} (id, record) VALUES (?, ?)`);
        for (const row of source.db.prepare(`SELECT * FROM "${table}"`).all()) {
          insert.run(String(row.id ?? row.seq), JSON.stringify({ ...row }));
          counts[table] += 1;
        }
      }
    });
    io.out(`ledger rows copied: ${LEDGER_TABLES.map((table) => `${table} ${counts[table]}`).join(', ')}`);
    return 0;
  } finally {
    source.close();
    target.close();
  }
}

// ---------- index policy, media, backups ----------

function runIndexPolicy(io, options) {
  need(options, 'db');
  const apply = options.apply === true;
  const days = options.days === undefined ? undefined : Number(options.days);
  if (days !== undefined && !(Number.isFinite(days) && days > 0)) throw new Error('--days must be a positive number');
  const handle = openMemoryDb(options.db, { readOnly: !apply });
  try {
    const config = { recall: { db: { ...(days ? { vectorDays: days } : {}), vectorEviction: apply } } };
    const done = classifyIndex(handle, { now: Date.now(), config, apply, evict: apply });
    io.out(
      `tiers: a ${done.tiers.a}, b ${done.tiers.b}, c ${done.tiers.c} (${Object.entries(done.reasons)
        .sort()
        .map(([reason, n]) => `${reason} ${n}`)
        .join(', ')})`
    );
    const kept = done.vectors.kept;
    io.out(
      `vectors kept: recent ${kept.recent}, cited ${kept.cited}, pinned ${kept.pinned}, touched ${kept.touch}, consolidated ${kept.consolidated}, unlinked ${kept.unlinked}; evicted before ${done.vectors.evicted}`
    );
    io.out(
      apply
        ? `evicted now: ${done.evictedNow}`
        : `would evict: ${done.vectors.evict} (dry run: nothing written; --apply to evict)`
    );
    return 0;
  } finally {
    handle.close();
  }
}

function runMediaCheck(io, options) {
  need(options, 'db', 'data');
  const apply = options.apply === true;
  const handle = openMemoryDb(options.db, { readOnly: !apply });
  try {
    const done = checkMedia(handle, { dataDir: options.data, apply });
    io.out(
      `media: present ${done.present}, missing ${done.missing}, unknown ${done.unknown}; ${apply ? 'marked' : 'would mark'} ${done.changed}`
    );
    return 0;
  } finally {
    handle.close();
  }
}

function runBackup(io, options) {
  need(options, 'db', 'to');
  const start = performance.now();
  const manifest = backupDatabase({
    db: options.db,
    to: options.to,
    commit: engineCommit(),
    ...(options.data ? { data: options.data } : {}),
  });
  io.out(
    `backup: schema ${manifest.schemaVersion}, ${manifest.files.length} files, ${Object.keys(manifest.rows).length} tables in ${seconds(start)}`
  );
  return 0;
}

function runRestore(io, options) {
  need(options, 'from', 'db');
  const start = performance.now();
  const manifest = restoreDatabase({
    from: options.from,
    db: options.db,
    ...(options.data ? { data: options.data } : {}),
  });
  io.out(
    `restore ok: schema ${manifest.schemaVersion}, ${manifest.files.length} files checked and restored, row counts equal (${seconds(start)})`
  );
  return 0;
}

// ---------- restore-test ----------

/** The config of the isolated service a restore test opens: every job off. */
const RESTORE_TEST_CONFIG = Object.freeze({
  memoryDb: { session: { mode: 'off' }, backup: { enabled: false } },
});

/**
 * Restores a backup into a temporary data directory, compares the content hash of every table of the restored
 * database with the backup's own database, then opens a service there (no worker, no network, no interface). The
 * backup itself is only read. The temporary directory is removed in every case.
 * @returns {Promise<number>} the exit code
 */
async function runRestoreTest(io, options) {
  need(options, 'from');
  const start = performance.now();
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'restore-test-'));
  const data = path.join(scratch, 'data');
  let service = null;
  try {
    const manifest = restoreDatabase({ from: options.from, db: path.join(data, 'memory.db'), data });
    io.out(`restored: schema ${manifest.schemaVersion}, ${manifest.files.length} files checked`);
    const hashesOf = (file) => {
      const handle = openMemoryDb(file, { readOnly: true });
      try {
        return tableHashes(handle.db);
      } finally {
        handle.close();
      }
    };
    const expected = hashesOf(path.join(options.from, 'memory.db'));
    const restored = new Map(hashesOf(path.join(data, 'memory.db')).map((entry) => [entry.table, entry]));
    const warnings = [];
    const log = {
      info() {},
      debug() {},
      error: (message, fields) => warnings.push(fields?.code ?? message),
      warn: (message, fields) => warnings.push(fields?.code ?? message),
    };
    service = createMemoryDb({
      hot: { config: structuredClone(RESTORE_TEST_CONFIG), prompts: {} },
      dataDir: data,
      log,
      worker: false,
    });
    await service.tick();
    if (!service.readHandle()) {
      io.out(
        `restore-test FAILED: the service did not open the restored database (${warnings.filter(Boolean).join(', ') || 'unknown'})`
      );
      return 1;
    }
    let differ = 0;
    for (const entry of expected) {
      const got = restored.get(entry.table);
      const same = got !== undefined && got.hash === entry.hash;
      if (!same) {
        differ += 1;
        io.out(
          `${entry.table.padEnd(26)} ${String(entry.rows).padStart(8)} -> ${String(got?.rows ?? 0).padStart(8)}  differs`
        );
      }
    }
    io.out(
      differ === 0
        ? `restore-test ok: every table of the restored database equals the backup's (${expected.length} tables, ${seconds(start)})`
        : `restore-test FAILED: ${differ} tables differ (${seconds(start)})`
    );
    return differ === 0 ? 0 : 1;
  } finally {
    if (service) await service.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------- entry ----------

const COMMANDS = {
  stats: runStats,
  hash: runHash,
  reproject: runReproject,
  rebuild: runRebuild,
  'ledger-import': runLedgerImport,
  'index-policy': runIndexPolicy,
  'media-check': runMediaCheck,
  backup: runBackup,
  restore: runRestore,
  'restore-test': runRestoreTest,
};

/** Runs a command line; returns the exit code (a promise of it for `restore-test`). `io` is { out(line), err(line) }. */
export function main(argv, io = { out: (line) => console.log(line), err: (line) => console.error(line) }) {
  try {
    const { command, options } = parseArgs(argv);
    const run = COMMANDS[command];
    if (!run) {
      io.err(`usage: memory-db.mjs <${Object.keys(COMMANDS).join('|')}> [options] (see the header of this file)`);
      return 2;
    }
    const code = run(io, options);
    if (code && typeof code.then === 'function') {
      return code.catch((error) => {
        io.err(`memory-db: ${error.message}`);
        return 2;
      });
    }
    return code;
  } catch (error) {
    io.err(`memory-db: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}
