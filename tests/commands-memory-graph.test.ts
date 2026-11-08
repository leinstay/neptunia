// `/memory graph` from the owner's line to the answer. Each read answers the reader's own result as JSON, with the owner's
// internal context, and asks no model and writes no row. Plan 2026-11-04-cli-and-memory task 9; S9 reruns these commands over
// semantic witnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine } from '../src/interface/commands/table.ts';
import {
  graphEdges,
  graphKinds,
  graphNeighbors,
  graphNode,
  graphNodes,
  graphPath,
  graphWalk,
} from '../src/memory/db/graph-read.ts';
import type { GraphEdgeRequest } from '../src/memory/db/graph-read.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { addAuthority, addEdge, addNode, clearGraph, databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const PAGE_ROWS = 50;
const INTERNAL = internalContext();
const ACTIVE: GraphEdgeRequest = { predicates: null, mode: 'active', validAt: null, recordedBefore: null };
const node = (name: string): string => `claim:${name}`;

type Rig = { db: Db; ops: Array<string>; say(line: string): Promise<Answer>; close(): void };

function rig(memoryClosed = false): Rig {
  const dir = tempDir('nep-commands-graph-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  const seed = dbOf(writer);
  clearGraph(seed);
  addAuthority(seed, 'zeta', 'zeta/one');
  addEdge(seed, { id: 'edge:ab', src: node('a'), dst: node('b'), predicate: 'mentions' });
  addEdge(seed, { id: 'edge:bc', src: node('b'), dst: node('c'), predicate: 'quotes' });
  addEdge(seed, {
    id: 'edge:gone',
    src: node('a'),
    dst: node('z'),
    retiredAt: '2026-01-01T00:00:00.000Z',
    recordedAt: '2020-01-01T00:00:00.000Z',
  });
  addNode(seed, node('isolated'));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => null,
    hot: {
      config: {
        memoryDb: {
          file: 'memory.db',
          inspection: { pageRows: PAGE_ROWS, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 },
        },
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: { database: () => (memoryClosed ? null : dbOf(reader)) },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => 0,
  });
  return {
    db: dbOf(reader),
    ops,
    say: async (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      return desk.run(parsed.name, parsed.args, { id: 'owner' });
    },
    close: () => reader.close(),
  };
}

async function withRig(body: (one: Rig) => Promise<void>): Promise<void> {
  const one = rig();
  try {
    await body(one);
  } finally {
    one.close();
  }
}

function data(answer: Answer): unknown {
  assert.equal(answer.status, 'ok', answer.text);
  return JSON.parse(answer.text);
}
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const LINES = [
  ['/memory graph kinds', 'memory.graph.kinds'],
  ['/memory graph nodes --kinds claim,person --limit 5 --cursor c1', 'memory.graph.nodes'],
  [
    '/memory graph edges --predicates quotes --mode historical --valid-at 2026-01-01T00:00:00.000Z --recorded-before 2026-02-01T00:00:00.000Z --limit 5 --cursor c1',
    'memory.graph.edges',
  ],
  ['/memory graph node claim:a', 'memory.graph.node'],
  [
    '/memory graph neighbors claim:a --direction both --predicates quotes --mode active --limit 5 --cursor c1',
    'memory.graph.neighbors',
  ],
  [
    '/memory graph walk claim:a --direction in --predicates quotes --mode historical --depth 3 --nodes 9 --cursor c1',
    'memory.graph.walk',
  ],
  ['/memory graph path claim:a claim:b --direction both --mode active --depth 4', 'memory.graph.path'],
] as const;

for (const [line, name] of LINES) {
  test(`${line} parses to ${name}, the same from the chat and from argv`, () => {
    const fromChat = parseCommandLine(line);
    assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
    assert.equal(fromChat.name, name);
    assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
  });
}

test('/memory graph kinds answers the reader, deferred entries included', async () => {
  await withRig(async (one) => {
    assert.deepEqual(data(await one.say('/memory graph kinds')), json(graphKinds(one.db, INTERNAL)));
  });
});

test('/memory graph nodes reaches an isolated node, and pages by its flags', async () => {
  await withRig(async (one) => {
    const expected = graphNodes(one.db, INTERNAL, { kinds: null, limit: PAGE_ROWS, cursor: null });
    assert.deepEqual(data(await one.say('/memory graph nodes')), json(expected));
    assert.ok(expected.items.some((item) => item.id === node('isolated')));
    const first = data(await one.say('/memory graph nodes --limit 1')) as {
      items: Array<{ id: string }>;
      next: string;
    };
    assert.equal(first.items.length, 1);
    const second = data(await one.say(`/memory graph nodes --limit 1 --cursor ${first.next}`)) as {
      items: Array<{ id: string }>;
    };
    assert.notDeepEqual(second.items, first.items);
  });
});

test('/memory graph nodes passes its kinds filter down', async () => {
  await withRig(async (one) => {
    const page = data(await one.say('/memory graph nodes --kinds person')) as { items: Array<unknown>; total: number };
    assert.deepEqual([page.items, page.total], [[], 0]);
  });
});

test('/memory graph edges is active by default and historical by request', async () => {
  await withRig(async (one) => {
    assert.deepEqual(
      data(await one.say('/memory graph edges')),
      json(graphEdges(one.db, INTERNAL, { ...ACTIVE, limit: PAGE_ROWS, cursor: null }))
    );
    assert.deepEqual(
      data(await one.say('/memory graph edges --mode historical')),
      json(graphEdges(one.db, INTERNAL, { ...ACTIVE, mode: 'historical', limit: PAGE_ROWS, cursor: null }))
    );
  });
});

test('/memory graph edges passes its predicate, valid-time and recording filters down', async () => {
  await withRig(async (one) => {
    const ids = async (flags: string): Promise<Array<string>> =>
      (
        data(await one.say(`/memory graph edges --mode historical ${flags}`)) as { items: Array<{ id: string }> }
      ).items.map((item) => item.id);
    assert.deepEqual(await ids('--predicates quotes'), ['edge:bc']);
    assert.deepEqual(await ids('--recorded-before 2021-01-01T00:00:00.000Z'), ['edge:gone']);
  });
});

test('/memory graph node answers the reader, and an unknown node its code', async () => {
  await withRig(async (one) => {
    assert.deepEqual(
      data(await one.say(`/memory graph node ${node('a')}`)),
      json(graphNode(one.db, INTERNAL, node('a')))
    );
    const missing = await one.say('/memory graph node claim:unknown');
    assert.deepEqual([missing.status, missing.code], ['invalid', 'NODE_NOT_FOUND']);
  });
});

test('/memory graph neighbors passes its direction down', async () => {
  await withRig(async (one) => {
    const expected = graphNeighbors(one.db, INTERNAL, {
      ...ACTIVE,
      node: node('b'),
      direction: 'in',
      limit: PAGE_ROWS,
      cursor: null,
    });
    assert.deepEqual(data(await one.say(`/memory graph neighbors ${node('b')} --direction in`)), json(expected));
    assert.deepEqual(
      expected.items.map((item) => item.id),
      ['edge:ab']
    );
  });
});

test('/memory graph walk answers its visited nodes, edges and frontier', async () => {
  await withRig(async (one) => {
    const expected = graphWalk(one.db, INTERNAL, {
      ...ACTIVE,
      from: [node('a')],
      direction: 'out',
      maxDepth: 1,
      maxNodes: PAGE_ROWS,
      cursor: null,
    });
    assert.deepEqual(data(await one.say(`/memory graph walk ${node('a')} --depth 1`)), json(expected));
    assert.deepEqual(expected.frontier, [node('b')]);
  });
});

test('/memory graph path answers the reader, its reason when there is no path', async () => {
  await withRig(async (one) => {
    const expected = graphPath(one.db, INTERNAL, {
      ...ACTIVE,
      from: node('a'),
      to: node('c'),
      direction: 'out',
      maxDepth: 5,
    });
    assert.deepEqual(data(await one.say(`/memory graph path ${node('a')} ${node('c')} --depth 5`)), json(expected));
    const none = data(await one.say(`/memory graph path ${node('a')} ${node('isolated')} --depth 5`)) as {
      found: boolean;
      reason: string;
    };
    assert.deepEqual([none.found, none.reason], [false, 'none']);
  });
});

for (const [flag, value] of [
  ['--mode', 'sometimes'],
  ['--direction', 'sideways'],
  ['--depth', 'deep'],
  ['--nodes', '-1'],
  ['--limit', '0'],
] as const) {
  test(`/memory graph walk refuses ${flag} ${value} and reads nothing`, async () => {
    // Bug: a bad word falls back to a default, so the owner reads an unbounded walk as the one he asked for.
    await withRig(async (one) => {
      const line = `/memory graph walk ${node('a')} ${flag} ${value}`;
      const parsed = parseCommandLine(line);
      if (!parsed.ok) return;
      assert.equal((await one.say(line)).status, 'invalid');
    });
  });
}

test('a bad cursor answers invalid with its code', async () => {
  await withRig(async (one) => {
    const answer = await one.say('/memory graph edges --cursor garbage');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'INSPECTION_BAD_CURSOR']);
  });
});

const READS = [
  '/memory graph kinds',
  '/memory graph nodes',
  '/memory graph edges --mode historical',
  `/memory graph node ${node('a')}`,
  `/memory graph neighbors ${node('a')}`,
  `/memory graph walk ${node('a')}`,
  `/memory graph path ${node('a')} ${node('c')}`,
];

test('a graph read runs no operation and changes no row, node_access included', async () => {
  // Bug: the walk goes through the tool that records a turn read, or a read witnesses what it opened.
  await withRig(async (one) => {
    const before = databaseDigest(one.db);
    assert.notEqual(before.node_access.split(':')[0], '0');
    for (const line of READS) assert.equal((await one.say(line)).status, 'ok', line);
    assert.deepEqual(one.ops, []);
    assert.deepEqual(databaseDigest(one.db), before);
  });
});

test('a closed database answers failed', async () => {
  const one = rig(true);
  try {
    for (const line of READS) assert.equal((await one.say(line)).status, 'failed', line);
  } finally {
    one.close();
  }
});
