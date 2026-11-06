#!/usr/bin/env node
// Measurement tool (plan 2026-11-05-master-plan, S12.1): source-only against graph-enabled retrieval on identical synthetic
// graphs, at several sizes and degree distributions, with and without a concurrent ingest. No model runs, no key is read,
// nothing under `data/` is touched: every database lives in a temporary folder that is removed at the end.
//
//   node scripts/graph-retrieval-bench.ts [--sizes 500,5000,20000] [--shapes uniform,zipf,star] [--queries 60]
//        [--ingest-ms 5] [--seed 20261106] [--json]
//
// A graph of size `n` has `n` plain lines in one public room, `n / 6` entities, and `n` relations between two entities
// (one `concept.part_of` fact per line, written through the session's writer operations, so the graph projection and the
// access rows exist as in production). The shape decides which entities the relations pick: `uniform` (every entity alike),
// `zipf` (a few hubs, weight 1/rank^1.1) and `star` (one hub on 30 % of the endpoints). The queries name an entity picked by
// the same shape, so a hub is asked as often as it is linked.
//
// The two modes read the same database through the public readers, on a read-only connection like the main thread's:
//   source-only    `search` of src/memory/db/recall.ts at its default window count, the plain-line streams alone, on the
//                  words of the query.
//   graph-enabled  `retrieveMemory` of src/memory/db/retrieve.ts with the entity as explicit anchor and the query's words,
//                  under the retrieval bounds of config/config.json (`memoryDb.retrieval`): the walk, the semantic hits
//                  and the source stream in one page (the stream keeps one window, as the service does).
// Each (size, shape, mode, ingest) runs in a process of its own, so the peak RSS belongs to it alone. With ingest on, a
// worker thread holds the writer lock and writes one line and one relation every `--ingest-ms`, as the writer thread of the
// core would; its per-write latency is reported.
//
// Output: one block per (size, shape) with the build cost, the database size and, per mode and ingest setting, the p50 and
// p95 latency of a query in milliseconds, the peak RSS in MB, the WAL size in MB, how many pages stopped on a bound
// (`partial`, by reason) or ran past the deadline, and the p50 and p95 of a write; then the SQL statements each mode ran
// with their `EXPLAIN QUERY PLAN`, `SCAN` marked where no index is used. Exit 0 done, 2 usage.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { search, dbSettings } from '../src/memory/db/recall.ts';
import { retrieveMemory } from '../src/memory/db/retrieve.ts';
import { wordsOf } from '../src/memory/db/semantic-search.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { writeSessionAssertion, writeSessionEntity } from '../src/memory/db/semantic-write.ts';
import type { SessionSemantics } from '../src/memory/db/semantic-write.ts';
import type { MemoryQuery, RetrievalBounds } from '../src/memory/db/semantic-types.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { retrievalBounds } from '../src/memory/retrieval-input.ts';

// Semantic argument roles and a sample's kind, named so the request-role scan of tests/roles.test.ts reads no stray literal.
const ROLE_INGEST = 'ingest';
const ROLE_PART = 'part';
const ROLE_WHOLE = 'whole';

const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOM = 'place:room';
const PUBLIC = 'aud:group:discord';
const ACCOUNT = 'account:author';
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const MODES = ['source-only', 'graph-enabled'] as const;
type Mode = (typeof MODES)[number];
const SHAPES = ['uniform', 'zipf', 'star'] as const;
type Shape = (typeof SHAPES)[number];

type Plan = { entities: Array<string>; queries: Array<{ entity: number; text: string }>; sources: number };
type Measured = {
  mode: Mode;
  ingest: boolean;
  latencies: Array<number>;
  rssMb: number;
  rssBaseMb: number;
  walMb: number;
  partial: Record<string, number>;
  overDeadline: number;
  found: number;
  writes: Array<number>;
  statements: Array<{ sql: string; plan: Array<string> }>;
};

// ---- small pure helpers ----

/** A seeded generator (mulberry32): the same seed gives the same graph and the same queries. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The nearest-rank percentile of `values` (0 for none). */
export function percentile(values: ReadonlyArray<number>, share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0;
}

/** A function that picks an entity index in `[0, count)` by the degree distribution of `shape`. */
export function picker(shape: Shape, count: number, rng: () => number): () => number {
  if (shape === 'uniform') return () => Math.floor(rng() * count);
  if (shape === 'star') return () => (rng() < 0.3 ? 0 : 1 + Math.floor(rng() * (count - 1)));
  const cumulative: Array<number> = [];
  let total = 0;
  for (let rank = 0; rank < count; rank += 1) {
    total += 1 / Math.pow(rank + 1, 1.1);
    cumulative.push(total);
  }
  return () => {
    const target = rng() * total;
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((cumulative[middle] ?? 0) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;
const ms = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
const sizeOf = (file: string): number => (fs.existsSync(file) ? fs.statSync(file).size : 0);

// ---- the synthetic graph ----

function baseRows(db: Db): void {
  db.exec(`INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('discord', 'discord', 1);
    INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('discord/global', 'discord', 'discord/global');
    INSERT INTO people (id, first_seen_at) VALUES ('person:author', '2026-11-01T00:00:00.000Z');
    INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by, linked_at)
      VALUES ('${ACCOUNT}', 'discord', 'n1', 'n1', 'discord/global', 1, 'user', 'person:author', 'verified', 'owner', '2026-11-01T00:00:00.000Z');
    INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, conversation, scope_kind)
      VALUES ('${ROOM}', 'discord', 'channel', '${ROOM}', '${ROOM}', 'discord/global', 1, 'group', 'group');
    INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES ('${PUBLIC}', 'group', 'discord');`);
}

/** One plain line of the room, as the observer stores it. */
function addLine(db: Db, number: number, text: string): string {
  const id = `src:${number}`;
  const at = new Date(T0 + number * 1000).toISOString();
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, author_kind, occurred_at, recorded_at, text,
      scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (?, 'seen', 'discord', ?, 1, ?, ?, 'account', ?, ?, ?, 'group', 'discord', NULL, ?)`
  ).run(id, `m${number}`, ROOM, ACCOUNT, at, at, text, PUBLIC);
  return id;
}

const roomContext = () => issueContext({ kind: 'group', iface: 'discord', destination: ROOM, now: () => T0 });

/** The session operations over one handle: a counter makes the ids, so the same seed writes the same rows. */
function writer(db: Db, ids: string) {
  let counter = 0;
  const session = (source: string, number: number): SessionSemantics => ({
    ctx: roomContext(),
    read: { sourceIds: [source], versionIds: [] },
    handles: new Map(),
    at: new Date(T0 + number * 1000).toISOString(),
    uuid: () => `00000000-0000-4000-${ids}-${String((counter += 1)).padStart(12, '0')}`,
  });
  return {
    entity(name: string, source: string, number: number): string {
      const out = writeSessionEntity(
        db,
        { handle: 'h', kind: 'project', name, language: 'en', sources: [source] },
        session(source, number)
      );
      if (!out.ok || out.result.kind !== 'entity') throw new Error(`the writer refused entity ${name}`);
      return out.result.entityId;
    },
    relation(part: string, whole: string, source: string, number: number): void {
      const out = writeSessionAssertion(
        db,
        {
          claimId: null,
          baseVersionId: null,
          assertionKind: 'relation',
          predicate: { id: 'concept.part_of', version: 1 },
          text: `${part} is part of ${whole}`,
          arguments: [
            { role: ROLE_PART, position: 0, ref: { kind: 'entity', id: part } },
            { role: ROLE_WHOLE, position: 0, ref: { kind: 'entity', id: whole } },
          ],
          sources: [source],
          polarity: 'positive',
          state: 'current',
          how: 'said',
          validFrom: null,
          validTo: null,
        },
        session(source, number)
      );
      if (!out.ok) throw new Error(`the writer refused a relation: ${out.code}`);
    },
  };
}

/** Builds the graph of `size` lines in `file` and returns what the readers and the ingest need to know. */
function build(file: string, size: number, shape: Shape, queries: number, seed: number): Plan {
  const rng = seeded(seed);
  const count = Math.max(8, Math.round(size / 6));
  const pick = picker(shape, count, rng);
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    handle.transaction(() => baseRows(db));
    const write = writer(db, '8000');
    const edges: Array<[number, number]> = [];
    for (let line = 0; line < size; line += 1) {
      const a = pick();
      let b = pick();
      if (b === a) b = (a + 1) % count;
      edges.push([a, b]);
    }
    handle.transaction(() => {
      for (let line = 0; line < size; line += 1) {
        const [a, b] = edges[line] ?? [0, 1];
        addLine(db, line, `line ${line} links ent${a} and ent${b} under topic${line % 40}`);
      }
    });
    const entities: Array<string> = [];
    handle.transaction(() => {
      for (let index = 0; index < count; index += 1)
        entities.push(write.entity(`ent${index}`, `src:${index % size}`, index));
    });
    const batch = 500;
    for (let from = 0; from < size; from += batch) {
      handle.transaction(() => {
        for (let line = from; line < Math.min(size, from + batch); line += 1) {
          const [a, b] = edges[line] ?? [0, 1];
          write.relation(entities[a] ?? '', entities[b] ?? '', `src:${line}`, count + line);
        }
      });
    }
    const asked = picker(shape, count, rng);
    return {
      entities,
      sources: size,
      queries: Array.from({ length: queries }, () => {
        const entity = asked();
        return { entity, text: `what do we know about ent${entity}` };
      }),
    };
  } finally {
    handle.close();
  }
}

// ---- the ingest worker ----

type IngestStart = {
  role: typeof ROLE_INGEST;
  file: string;
  entities: Array<string>;
  from: number;
  everyMs: number;
  seed: number;
};

async function ingestLoop(job: IngestStart): Promise<void> {
  const rng = seeded(job.seed);
  const handle = openMemoryDb(job.file);
  const db = dbOf(handle);
  const write = writer(db, '8001');
  const latencies: Array<number> = [];
  let stop = false;
  parentPort?.on('message', (message: unknown) => {
    if (message === 'stop') stop = true;
  });
  parentPort?.postMessage('ready');
  let number = job.from;
  while (!stop) {
    const a = Math.floor(rng() * job.entities.length);
    const b = (a + 1 + Math.floor(rng() * (job.entities.length - 1))) % job.entities.length;
    const started = performance.now();
    handle.transaction(() => {
      const source = addLine(db, number, `line ${number} links ent${a} and ent${b} under topic${number % 40}`);
      write.relation(job.entities[a] ?? '', job.entities[b] ?? '', source, number);
    });
    latencies.push(performance.now() - started);
    number += 1;
    await new Promise((resolve) => setTimeout(resolve, job.everyMs));
  }
  const wal = sizeOf(`${job.file}-wal`);
  handle.close();
  parentPort?.postMessage({ latencies, wal });
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === 'ingest') {
  void ingestLoop(workerData as IngestStart);
}

// ---- one measured process ----

const trackedConfig = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')) as Record<string, unknown>;

/** The distinct SQL a call prepares, with the plan SQLite gives each (the parameters stay unbound). */
function plansOf(db: Db, run: (spied: Db) => void | Promise<void>): Promise<Measured['statements']> {
  const seen = new Set<string>();
  const spied = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          seen.add(sql);
          return target.prepare(sql);
        };
      const value = (target as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === 'function' ? (value as (...args: Array<unknown>) => unknown).bind(target) : value;
    },
  });
  return Promise.resolve(run(spied)).then(() =>
    [...seen].map((sql) => {
      try {
        const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: unknown }>;
        return { sql, plan: rows.map((row) => String(row.detail)) };
      } catch {
        return { sql, plan: ['(no plan: the statement needs bound parameters)'] };
      }
    })
  );
}

async function measure(file: string, mode: Mode, ingest: boolean, everyMs: number, seed: number): Promise<Measured> {
  const plan = JSON.parse(fs.readFileSync(`${file}.plan.json`, 'utf8')) as Plan;
  const config = trackedConfig();
  const settings = dbSettings(config);
  const bounds: RetrievalBounds = retrievalBounds(
    {
      recall: { prefetch: (config.recall as { prefetch?: unknown } | undefined)?.prefetch },
      memoryDb: config.memoryDb as never,
    },
    'search'
  );
  const handle = openMemoryDb(file, { readOnly: true });
  const db = dbOf(handle);
  const ctx = roomContext();
  const rssBaseMb = mb(process.memoryUsage().rss);
  const query = (index: number): MemoryQuery => {
    const asked = plan.queries[index % plan.queries.length] ?? { entity: 0, text: 'ent0' };
    return {
      text: asked.text,
      anchors: [{ kind: 'entity', id: plan.entities[asked.entity] ?? '' }],
      predicates: [],
      validAt: null,
      recordedBefore: null,
      includeHistorical: false,
      purpose: 'search',
      bounds,
      cursor: null,
    };
  };
  const once = async (reader: Db, index: number): Promise<{ partial: string | null; found: number }> => {
    if (mode === 'source-only') {
      const asked = plan.queries[index % plan.queries.length] ?? { entity: 0, text: 'ent0' };
      const result = search(reader, {
        ctx,
        plan: { forms: [...new Set(wordsOf(asked.text))].slice(0, 8), who: [], from: null, to: null },
        now: T0 + 10_000_000,
        settings,
      });
      return { partial: null, found: result.hits.length };
    }
    const page = await retrieveMemory(reader, ctx, query(index), {
      now: () => T0 + 10_000_000,
      embedQuery: null,
      model: null,
      recall: settings,
      minSimilarity: settings?.minMeaning,
    });
    return { partial: page.partialReason, found: page.assertions.length + page.sourceIds.length };
  };
  const statements = await plansOf(db, (spied) => once(spied, 0).then(() => undefined));
  for (let warm = 0; warm < 3; warm += 1) await once(db, warm);

  let worker: Worker | null = null;
  let finished: Promise<{ latencies: Array<number>; wal: number }> | null = null;
  if (ingest) {
    worker = new Worker(SELF, {
      workerData: {
        role: ROLE_INGEST,
        file,
        entities: plan.entities,
        from: plan.sources + 1,
        everyMs,
        seed,
      } satisfies IngestStart,
    });
    const ready = new Promise<void>((resolve) => worker?.once('message', () => resolve()));
    finished = new Promise((resolve) =>
      worker?.on('message', (message: unknown) => {
        if (message !== 'ready') resolve(message as { latencies: Array<number>; wal: number });
      })
    );
    await ready;
  }
  const latencies: Array<number> = [];
  const partial: Record<string, number> = {};
  let overDeadline = 0;
  let found = 0;
  for (let index = 0; index < plan.queries.length; index += 1) {
    const started = performance.now();
    const outcome = await once(db, index);
    const took = performance.now() - started;
    latencies.push(took);
    found += outcome.found;
    if (outcome.partial !== null) partial[outcome.partial] = (partial[outcome.partial] ?? 0) + 1;
    if (took > bounds.deadlineMs) overDeadline += 1;
    // Let the ingest worker's timers and the thread messages run between two reads, as the core's loop does.
    await new Promise((resolve) => setImmediate(resolve));
  }
  let writes: Array<number> = [];
  let walMb = mb(sizeOf(`${file}-wal`));
  if (worker !== null && finished !== null) {
    worker.postMessage('stop');
    const done = await finished;
    writes = done.latencies;
    walMb = mb(done.wal);
    await worker.terminate();
  }
  handle.close();
  return {
    mode,
    ingest,
    latencies,
    rssMb: mb(process.resourceUsage().maxRSS * 1024),
    rssBaseMb,
    walMb,
    partial,
    overDeadline,
    found,
    writes,
    statements,
  };
}

// ---- the orchestrator ----

type Options = {
  sizes: Array<number>;
  shapes: Array<Shape>;
  queries: number;
  ingestMs: number;
  seed: number;
  json: boolean;
};

/** The options of the command line; a message names the argument that is wrong. */
export function parseArgs(argv: ReadonlyArray<string>): Options | string {
  const options: Options = {
    sizes: [500, 5000, 20000],
    shapes: [...SHAPES],
    queries: 60,
    ingestMs: 5,
    seed: 20261106,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) return `${flag} needs a value`;
    if (flag === '--sizes') {
      options.sizes = value.split(',').map(Number);
      if (options.sizes.some((one) => !Number.isInteger(one) || one < 20))
        return '--sizes takes whole numbers of at least 20';
    } else if (flag === '--shapes') {
      const shapes = value.split(',');
      if (shapes.some((one) => !(SHAPES as ReadonlyArray<string>).includes(one)))
        return `--shapes takes ${SHAPES.join(', ')}`;
      options.shapes = shapes as Array<Shape>;
    } else if (flag === '--queries' || flag === '--ingest-ms' || flag === '--seed') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) return `${flag} takes a positive whole number`;
      if (flag === '--queries') options.queries = number;
      else if (flag === '--ingest-ms') options.ingestMs = number;
      else options.seed = number;
    } else return `unknown argument ${flag}`;
  }
  return options;
}

function runChild(file: string, mode: Mode, ingest: boolean, options: Options): Measured {
  // An ingest run writes, so it gets a copy of its own: every run starts from the same database.
  const target = ingest ? `${file}.ingest-${mode}` : file;
  if (ingest) {
    fs.copyFileSync(file, target);
    fs.copyFileSync(`${file}.plan.json`, `${target}.plan.json`);
  }
  const done = spawnSync(
    process.execPath,
    [SELF, '--measure', target, mode, ingest ? 'on' : 'off', String(options.ingestMs), String(options.seed)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR } }
  );
  if (done.status !== 0) throw new Error(`the ${mode} run failed: ${done.stderr.slice(-800)}`);
  if (ingest)
    for (const suffix of ['', '-wal', '-shm', '.lock', '.plan.json']) fs.rmSync(`${target}${suffix}`, { force: true });
  return JSON.parse(done.stdout) as Measured;
}

const scans = (plan: ReadonlyArray<string>): boolean =>
  plan.some((line) => /^SCAN /.test(line) && !/USING (COVERING )?INDEX|VIRTUAL TABLE/.test(line));

function report(
  size: number,
  shape: Shape,
  built: { seconds: number; dbMb: number; counts: Record<string, number> },
  runs: Array<Measured>
): string {
  const out: Array<string> = [];
  const counts = Object.entries(built.counts)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  out.push(`size=${size} shape=${shape} build=${built.seconds.toFixed(1)}s db=${built.dbMb}MB ${counts}`);
  out.push(
    '  mode           ingest  n    p50ms   p95ms   rssMB(base)  walMB  partial          overDeadline  found/q  write p50/p95 ms'
  );
  for (const run of runs) {
    const partial =
      Object.entries(run.partial)
        .map(([reason, n]) => `${reason}:${n}`)
        .join(',') || '-';
    const write = run.ingest
      ? `${ms(percentile(run.writes, 0.5))}/${ms(percentile(run.writes, 0.95))} (${run.writes.length} writes)`
      : '-';
    out.push(
      `  ${run.mode.padEnd(14)} ${(run.ingest ? 'on' : 'off').padEnd(7)} ${String(run.latencies.length).padEnd(4)} ${ms(percentile(run.latencies, 0.5)).padStart(7)} ${ms(percentile(run.latencies, 0.95)).padStart(7)}   ${`${run.rssMb}(${run.rssBaseMb})`.padEnd(12)} ${String(run.walMb).padEnd(6)} ${partial.padEnd(16)} ${String(run.overDeadline).padEnd(13)} ${String(Math.round((run.found / Math.max(1, run.latencies.length)) * 10) / 10).padEnd(8)} ${write}`
    );
  }
  for (const mode of MODES) {
    const first = runs.find((run) => run.mode === mode && !run.ingest);
    if (first === undefined) continue;
    const full = first.statements.filter((one) => scans(one.plan)).length;
    out.push(`  plans of ${mode}: ${first.statements.length} statements, ${full} with a scan that uses no index`);
    for (const one of first.statements) {
      const flat = one.sql.replace(/\s+/g, ' ').trim().slice(0, 100);
      const how = one.plan
        .filter((line) => !/^(CORRELATED SCALAR SUBQUERY|LIST SUBQUERY|USE TEMP B-TREE)/.test(line))
        .join('; ');
      out.push(`    ${scans(one.plan) ? 'SCAN' : 'ok  '} ${flat} => ${how.slice(0, 200)}`);
    }
  }
  return out.join('\n');
}

function orchestrate(options: Options): number {
  const folder = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nep-graph-bench-'));
  const blocks: Array<string> = [];
  const all: Array<unknown> = [];
  try {
    process.stdout.write(
      `graph-retrieval-bench: sizes=${options.sizes.join(',')} shapes=${options.shapes.join(',')} queries=${options.queries} ingest-ms=${options.ingestMs} seed=${options.seed}\n`
    );
    for (const size of options.sizes) {
      for (const shape of options.shapes) {
        const file = path.join(folder, `memory-${size}-${shape}.db`);
        const started = performance.now();
        const plan = build(file, size, shape, options.queries, options.seed);
        fs.writeFileSync(`${file}.plan.json`, JSON.stringify(plan));
        const seconds = (performance.now() - started) / 1000;
        const handle = openMemoryDb(file, { readOnly: true });
        const counts: Record<string, number> = {};
        for (const [name, table] of [
          ['sources', 'sources'],
          ['entities', 'semantic_entities'],
          ['claims', 'claims'],
          ['graphNodes', 'graph_nodes'],
          ['graphEdges', 'graph_edges'],
        ] as const) {
          try {
            counts[name] = Number(dbOf(handle).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
          } catch {
            counts[name] = -1;
          }
        }
        handle.close();
        const runs: Array<Measured> = [];
        for (const ingest of [false, true]) for (const mode of MODES) runs.push(runChild(file, mode, ingest, options));
        const built = { seconds, dbMb: mb(sizeOf(file)), counts };
        blocks.push(report(size, shape, built, runs));
        all.push({ size, shape, built, runs });
        process.stdout.write(`${options.json ? '' : `${blocks[blocks.length - 1]}\n`}`);
      }
    }
    if (options.json) process.stdout.write(`${JSON.stringify(all)}\n`);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === '--measure') {
    const [, file, mode, ingest, every, seed] = args;
    const result = await measure(String(file), mode as Mode, ingest === 'on', Number(every), Number(seed));
    process.stdout.write(JSON.stringify(result));
    return 0;
  }
  const options = parseArgs(args);
  if (typeof options === 'string') {
    process.stderr.write(`graph-retrieval-bench: ${options}\n`);
    return 2;
  }
  return orchestrate(options);
}

if (isMainThread && process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().then((code) => {
    process.exitCode = code;
  });
