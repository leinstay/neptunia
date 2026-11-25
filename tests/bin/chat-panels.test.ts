// Panel commands use the same core operations as typed commands, without running setup on a mere view.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chatPanel, capabilityPanel } from '../../bin/chat-panels.ts';
import { modelRoleRegistry } from '../../src/subharness/model-capabilities.ts';
import type { RoleSources } from '../../src/subharness/model-capabilities.ts';
import type { PanelResult } from '../../interfaces/cli/panel.ts';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseRequest } from '../../bin/neptunia-request.ts';
import { createConsole } from '../../src/interface/commands/console.ts';
import type { Answer } from '../../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine } from '../../src/interface/commands/table.ts';
import type { Db } from '../../src/memory/db/types.ts';
import { openTestMemory } from '../fixtures/memory-db/service.ts';
import type { TestMemory } from '../fixtures/memory-db/service.ts';
import {
  ALEX,
  KAI,
  MIRA,
  ROOM,
  addEntity,
  addSource,
  candidate,
  commit,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from '../fixtures/memory-db/semantic-world.ts';
import type { World } from '../fixtures/memory-db/semantic-world.ts';

test('editing a setting sends its path and value to config.set, not to the model', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const run = (command: { name: string; args: Record<string, unknown> }) => {
    calls.push(command);
    return Promise.resolve({
      status: 'ok',
      text: command.name === 'config.show' ? '{"heartbeat":{"enabled":false}}' : 'saved',
    });
  };
  const panel = await chatPanel('/config', run);
  const row = panel?.rows?.find((one) => one.id === 'heartbeat.enabled');
  assert.equal(row?.edit?.value, 'false');
  await row?.apply?.('true');
  assert.deepEqual(calls.at(-1), { name: 'config.set', args: { path: 'heartbeat.enabled', value: 'true' } });
});

test('setup shows choices without installing or probing, and a chosen key opens the existing secret dialog', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = await chatPanel(
    '/setup',
    (command) => {
      calls.push(command);
      return Promise.resolve({ status: 'ok', text: 'done' });
    },
    ['discord', 'fake']
  );
  assert.deepEqual(calls, []);
  assert.ok(panel?.rows?.some((row) => row.id === 'interface:fake'));
  await panel?.rows?.find((row) => row.id === 'key')?.apply?.('primary');
  assert.deepEqual(calls, [{ name: 'keys.add', args: { name: 'primary' } }]);
});

// `/model` in the chat opens the nested selector (bin/chat-panels.ts): opening runs nothing, its read and its commit are
// the ordinary commands, and every other `/model` line keeps the normal command path. The same line in Bash stays `show`.

type Called = { name: string; args: Record<string, unknown> };

function runner(answer: (one: Called) => { status: string; text: string; code?: string }) {
  const calls: Array<Called> = [];
  const run = (one: Called): Promise<{ status: string; text: string; code?: string }> => {
    calls.push(one);
    return Promise.resolve(answer(one));
  };
  return { calls, run };
}

test('a bare /model opens the picker and runs no command, no probe and no write', async () => {
  // Catches: a read-only open spending a request or changing a setting.
  const { calls, run } = runner(() => ({ status: 'ok', text: '' }));
  const panel = await chatPanel('/model', run);
  assert.deepEqual(panel?.picker?.registry, modelRoleRegistry());
  assert.deepEqual(calls, []);
});

test('its read is /model sources for the concrete role, parsed back into descriptors', async () => {
  // Catches: the chooser reading sources by a display name, or by a second path beside the command table.
  const answer: RoleSources = { role: 'speech', current: null, sources: [] };
  const { calls, run } = runner(() => ({ status: 'ok', text: JSON.stringify(answer) }));
  const panel = await chatPanel('/model', run);
  assert.deepEqual(await panel?.picker?.read('speech'), answer);
  assert.deepEqual(calls, [{ name: 'model.sources', args: { role: 'speech' } }]);
});

test('a refused read rejects, so the selector shows a failure and not an empty list', async () => {
  // Catches: JSON.parse of a refusal, or a failed read drawn as a role with no source.
  const { run } = runner(() => ({ status: 'failed', text: 'the core said no' }));
  const panel = await chatPanel('/model', run);
  await assert.rejects(() => panel?.picker?.read('speech') ?? Promise.resolve());
});

test('its commit is the checked model.set command, once, and keeps the code of a refusal', async () => {
  // The routes are named direct-api, claude-harness, codex-harness and opencode-harness.
  // Catches: a second save path around the checked selection, or the refusal's code lost on the way to the screen.
  const { calls, run } = runner(() => ({ status: 'failed', code: 'model-rejected', text: 'no' }));
  const panel = await chatPanel('/model', run);
  const command = { name: 'model.set', args: { role: 'dev', model: 'sonnet', via: 'claude-harness' } } as const;
  const answer = await panel?.picker?.commit(command);
  assert.deepEqual(calls, [command]);
  assert.equal(answer?.code, 'model-rejected');
});

for (const line of ['/model show', '/model set core vendor/text-1']) {
  test(`${line} keeps the normal command path`, async () => {
    // Catches: the selector taking over a typed command, so a script's line stops working in the chat.
    const { calls, run } = runner(() => ({ status: 'ok', text: '' }));
    assert.equal(await chatPanel(line, run), null);
    assert.deepEqual(calls, []);
  });
}

// The chat's bare `/memory users`, `places`, `graph` and `inspect`: one panel over the same reads a script gets, each row
// prefilling the command that opens it, so the chat and a shell select the same typed ids. There is no
// second browser, and opening a panel asks no model.

function reader(answers: Record<string, unknown>): {
  asked: Array<string>;
  run: (command: { name: string; args: Record<string, unknown> }) => Promise<PanelResult>;
} {
  const asked: Array<string> = [];
  return {
    asked,
    run: (command) => {
      asked.push(command.name);
      const answer = answers[command.name];
      return Promise.resolve(
        answer === undefined
          ? { status: 'failed', text: 'the memory database is closed' }
          : { status: 'ok', text: JSON.stringify(answer) }
      );
    },
  };
}

const page = (items: Array<unknown>, total: number, next: string | null = null): unknown => ({
  items,
  snapshot: '',
  next,
  total,
  truncated: next !== null,
  reason: next === null ? null : 'page',
});

test('/memory users lists every kind of entry, each prefilling its own detail by typed id', async () => {
  // Bug: the panel keeps a display name as its key, so two people who share a name open one record.
  const { run, asked } = reader({
    'memory.users.list': page(
      [
        { kind: 'person', id: 'person:1', names: ['Ελένη'], accountIds: ['account:1'], mergedInto: null },
        { kind: 'account', id: 'account:9', names: ['Ελένη'] },
        { kind: 'participant', id: 'participant:1', display: 'Ανώνυμος' },
      ],
      3
    ),
  });
  const panel = await chatPanel('/memory users', run);
  assert.deepEqual(asked, ['memory.users.list']);
  assert.deepEqual(
    panel?.rows?.map((row) => row.prefill),
    [
      '/memory users show person:1',
      '/memory inspect rows accounts --filters [{"column":"id","value":{"kind":"text","value":"account:9"}}]',
      '/memory inspect rows participants --filters [{"column":"id","value":{"kind":"text","value":"participant:1"}}]',
    ]
  );
});

test('a panel says what the page left out', async () => {
  // Bug: the first page of a long list reads as the whole list.
  const { run } = reader({ 'memory.places.list': page([{ id: 'place:1', name: 'κήπος', childCount: 2 }], 40, 'c1') });
  const panel = await chatPanel('/memory places', run);
  assert.ok(panel?.lines.some((line) => line.includes('1 of 40')));
  const row = panel?.rows?.[0];
  assert.equal(row?.prefill, '/memory places tree place:1');
});

test('/memory graph lists its kinds and names the deferred ones', async () => {
  const { run } = reader({
    'memory.graph.kinds': {
      kinds: [
        { kind: 'person', table: 'people', state: 'implemented', reason: null, nodes: 4 },
        { kind: 'skill', table: null, state: 'deferred', reason: 'not built', nodes: 0 },
      ],
      predicates: [],
    },
  });
  const panel = await chatPanel('/memory graph', run);
  const row = panel?.rows?.[0];
  assert.equal(row?.prefill, '/memory graph nodes --kinds person');
  const secondRow = panel?.rows?.[1];
  assert.ok(secondRow?.detail.includes('deferred'));
});

test('/memory inspect lists every table under one snapshot, whatever its class', async () => {
  // Bug: the rows of the panel read a later moment than the catalog it listed.
  const { run } = reader({
    'memory.inspect.tables': {
      snapshot: 's1',
      catalog: { tables: [{ name: 'future_family', kind: 'table', storageClass: 'unclassified' }] },
    },
  });
  const panel = await chatPanel('/memory inspect', run);
  const row = panel?.rows?.[0];
  assert.equal(row?.prefill, '/memory inspect rows future_family --snapshot s1');
  assert.ok(row?.detail.includes('unclassified'));
});

test('a refused read shows its reason and no empty list', async () => {
  // Bug: a closed database reads as a memory with nobody in it.
  const { run } = reader({});
  const panel = await chatPanel('/memory users', run);
  assert.deepEqual(panel?.lines, ['the memory database is closed']);
  assert.equal(panel?.rows, undefined);
});

function capabilityRunner() {
  const calls: Array<string> = [];
  return {
    calls,
    run: (command: { name: string; args: Record<string, unknown> }) => {
      calls.push(command.name);
      return Promise.resolve({ status: 'ok', text: 'zeta71 available' });
    },
  };
}

test('a capability menu reads through the list operation, and its rows are the table subcommands', async () => {
  // Bug: the menu keeps its own list of actions, or opening it grants or installs something.
  for (const [kind, command] of [
    ['tools', 'tools'],
    ['skills', 'skills'],
    ['interfaces', 'interfaces'],
  ] as const) {
    const { run, calls } = capabilityRunner();
    const panel = await capabilityPanel(kind, run);
    assert.deepEqual(calls, [`${command}.list`]);
    assert.ok(panel.lines.join('\n').includes('zeta71'));
    const rows = panel.rows ?? [];
    assert.ok(rows.length > 0);
    for (const row of rows) assert.ok(row.prefill?.startsWith(`/${command} `), row.id);
    assert.equal(
      rows.some((row) => row.apply !== undefined),
      false,
      'every change goes through its typed command'
    );
  }
});

test('the interfaces menu prefills no command before the interface', async () => {
  // The interface comes first and the old order is no command. Catches: a menu row that
  // prefills `/interfaces setup `, a line the table refuses.
  const commands = [
    'setup',
    'settings',
    'set',
    'clear',
    'add',
    'remove',
    'enable',
    'disable',
    'invite',
    'pair',
    'roots',
  ];
  const panel = await capabilityPanel('interfaces', () =>
    Promise.resolve({ status: 'ok', text: 'zeta71  enabled  connected' })
  );
  for (const row of panel.rows ?? []) {
    const second = (row.prefill ?? '').split(' ')[1] ?? '';
    assert.equal(commands.includes(second), false, `${row.id}: ${row.prefill ?? ''}`);
  }
});

test('the agents menu uses its own command', async () => {
  // Bug: a menu row prefills a command of another family.
  // The menu opens under the command's own word, `/agent`, and `/agents` is no second name for it.
  const agents = await capabilityPanel('agent', capabilityRunner().run);
  for (const row of agents.rows ?? []) assert.ok(row.prefill?.startsWith('/agent '), row.id);
});

test('a failing list read shows its failure and offers no action', async () => {
  // Bug: a dead core draws an empty menu that looks like nothing installed.
  const panel = await capabilityPanel('tools', () => Promise.resolve({ status: 'failed', text: 'zeta72 unreachable' }));
  assert.ok(panel.lines.join('\n').includes('zeta72'));
  assert.deepEqual(panel.rows ?? [], []);
});

test('the help panel lists the plural collections and none of the retired commands', async () => {
  // Catches: the panel keeps a list of its own that drifts from the table.
  const panel = await chatPanel('/help', () => Promise.resolve({ status: 'ok', text: '' }));
  const labels = (panel?.rows ?? []).map((row) => row.label);
  for (const kept of ['/services', '/routes', '/interfaces', '/doctor', '/logs'])
    assert.ok(labels.includes(kept), kept);
  for (const gone of ['/service', '/health', '/wakes', '/report', '/route', '/interface'])
    assert.equal(labels.includes(gone), false, gone);
});

test('the setup panel offers the login of each backend and never the retired enable', async () => {
  // Catches: the panel prefills a command that exits 2.
  const panel = await chatPanel('/setup', () => Promise.resolve({ status: 'ok', text: '' }), []);
  const prefills = (panel?.rows ?? []).map((row) => row.prefill ?? '');
  assert.equal(
    prefills.some((line) => line.startsWith('/subharness enable')),
    false
  );
  for (const backend of ['codex', 'claude', 'opencode'])
    assert.ok(
      prefills.some((line) => line.startsWith(`/subharness ${backend} login`)),
      backend
    );
});

const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };

type Version = { claimId: string; versionId: string };

const written = (result: object): Version => result as Version;

/** What the seed wrote, by name, and the contexts the core would issue for the group and the two DMs. */
type Seeded = {
  open: string;
  secret: string;
  edited: string;
  lumen: string;
  orbis: string;
  hidden: string;
  lumenName: Version;
  hiddenName: Version;
  moth: Version;
  works1: Version;
  works2: Version;
  kai: Version;
  mira: Version;
  event: Version;
  dmMeeting: Version;
  hiddenWork: Version;
  kite: string;
  kyte: string;
  contexts: World['contexts'];
};

type Rig = {
  memory: TestMemory;
  db: Db;
  ops: Array<string>;
  dir: string;
  seeded: Seeded;
  /** One command as argv words, as `neptunia memory ...` hands them over. */
  say(...words: Array<string>): Promise<Answer>;
  /** One command as the chat's line. */
  line(text: string): Promise<Answer>;
  run(command: { name: string; args: Record<string, unknown> }): Promise<Answer>;
};

const label = (entityId: string, role: 'alias', text: string, sources: Array<string>) =>
  candidate(
    'entity.label',
    'label',
    [
      { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
      { role, position: 0, literal: text },
      { role: 'language', position: 0, literal: 'en' },
    ],
    sources
  );

/**
 * A public project, a public event and a project only Alex's DM knows; a DM alias; a relation changed from positive to
 * negative; a public and a private inference resting on its first version; an event with four roles held in the room; a
 * DM meeting in the room; two public concepts declared the same; and an edited revision of the public line the facts cite.
 */
function seed(world: World): Seeded {
  const open = addSource(world, 'public', 'Alex works on Lumen; Orbis met in the room with Mira speaking');
  const secret = addSource(world, 'alex', 'Mira helps on Lumen; Hidden is mine');
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const orbis = addEntity(world, 'event', 'Orbis', [open]);
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  const moth = written(commit(world, label(lumen.entityId, 'alias', 'Moth', [secret]), world.contexts.alex));
  const works1 = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
  const inferred = { how: 'inferred', dependencies: [{ versionId: works1.versionId, role: 'supports' as const }] };
  const kai = written(commit(world, worksOn(KAI, lumen.entityId, [open], inferred)));
  const mira = written(commit(world, worksOn(MIRA, lumen.entityId, [secret], inferred), world.contexts.alex));
  const event = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: orbis.entityId } },
          { role: 'organizer', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'speaker', position: 0, ref: { kind: 'person', id: MIRA } },
          { role: 'project', position: 0, ref: { kind: 'entity', id: lumen.entityId } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [open]
      )
    )
  );
  const dmMeeting = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: hidden.entityId } },
          { role: 'attendee', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [secret]
      ),
      world.contexts.alex
    )
  );
  const hiddenWork = written(commit(world, worksOn(ALEX, hidden.entityId, [secret]), world.contexts.alex));
  const works2 = written(
    commit(world, worksOn(ALEX, lumen.entityId, [open], successor(works1, { polarity: 'negative' })))
  );
  const kite = addEntity(world, 'concept', 'Kite', [open]).entityId;
  const kyte = addEntity(world, 'concept', 'Kyte', [open]).entityId;
  commit(world, sameAs(kyte, kite, [open]));
  const edited = 'src:edited';
  world.db
    .prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, author_kind, occurred_at,
         recorded_at, text, scope_kind, scope_iface, scope_dm, audience_id)
       SELECT ?, kind, iface, native_id, 2, place_id, author_account, author_kind, occurred_at, recorded_at, 'edited later',
         scope_kind, scope_iface, scope_dm, audience_id FROM sources WHERE id = ?`
    )
    .run(edited, open);
  return {
    open,
    secret,
    edited,
    lumen: lumen.entityId,
    orbis: orbis.entityId,
    hidden: hidden.entityId,
    lumenName: lumen,
    hiddenName: hidden,
    moth,
    works1,
    works2,
    kai,
    mira,
    event,
    dmMeeting,
    hiddenWork,
    kite,
    kyte,
    contexts: world.contexts,
  };
}

const rigs: Array<TestMemory> = [];

after(async () => {
  for (const memory of rigs) await memory.close();
});

/** The seed through the writer on a file, then the real service over that file with the console on it. */
async function rig(): Promise<Rig> {
  const world = semanticWorld();
  const seeded = seed(world);
  world.handle.close();
  const dir = dirname(world.file);
  mkdirSync(join(dir, 'config'), { recursive: true });
  const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: BOUNDS } } });
  rigs.push(memory);
  const db = memory.memoryDb.database();
  assert.ok(db);
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.UTC(2026, 10, 5, 12),
  });
  const run = async (command: { name: string; args: Record<string, unknown> }): Promise<Answer> => {
    const real = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('a memory read reached the network'));
    try {
      return await desk.run(command.name, command.args, { id: 'owner' });
    } finally {
      globalThis.fetch = real;
    }
  };
  return {
    memory,
    db,
    ops,
    dir,
    seeded,
    run,
    say: (...words) => {
      const parsed = parseRequest(words).parsed;
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      return run(parsed);
    },
    line: (text) => {
      const parsed = parseCommandLine(text);
      assert.ok(parsed.ok, parsed.ok ? '' : `${text}: ${parsed.reason}`);
      return run(parsed);
    },
  };
}

function data<TData>(answer: Answer): TData {
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  return JSON.parse(answer.text) as TData;
}

// ---- the chat and a shell ---------------------------------------------------------------------------------------------

test('the chat panel of /memory entities prefills the show line of each listed id, and both forms answer alike', async () => {
  // Bug: the panel keys rows by name, so two projects named alike open one record, or the chat and a shell disagree.
  const one = await rig();
  const listed = data<{ items: Array<{ id: string }> }>(await one.say('memory', 'entities', 'list')).items.map(
    (item) => item.id
  );
  const panel = await chatPanel('/memory entities', (command) => one.run(command));
  const prefills = panel?.rows?.map((row) => row.prefill) ?? [];
  assert.deepEqual(
    prefills,
    listed.map((id) => `/memory entities show ${id}`)
  );
  for (const [index, prefill] of prefills.entries()) {
    const fromChat = await one.line(prefill ?? '');
    const fromShell = await one.say(...commandLineWords(prefill ?? '').slice(0));
    assert.equal(fromChat.text, fromShell.text);
    assert.equal(data<{ entity: { id: string } }>(fromChat).entity.id, listed[index]);
  }
});
