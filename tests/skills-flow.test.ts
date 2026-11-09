// A chain she repeated becomes a skill she uses, end to end (PR 7e's done-criterion), over the real pieces and no
// network: three turns of hers call web.search, web.read and message.create; the `selfimprovement` view lists that
// shape with the count 3; her scripted answer files `task.propose` of kind `skill` with the example turns; a fake
// agent principal claims the task, writes `skills.local/<name>/SKILL.md` and submits, the owner activates the version
// (his decision of 2026-11-04: an agent never does); `/skills` shows the activation; a later turn of the same shape carries the skill as an entry of her tools
// array, her `skill.read` returns its text, and `skill_uses` holds discovered, read, tried and succeeded. Then the
// guards: a SKILL.md nobody activated has no entry, activation grants no tool, and her own switch takes a skill's entry
// away until the owner enables it. The scripted model is the list of tool calls each turn makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { openBoard } from '../src/board/board.ts';
import type { Board, Handoff } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { buildSelfimprovementFacts } from '../src/behavior/selfimprovement-view.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { useCountsBySkill } from '../src/memory/db/skills.ts';
import type { ActiveSkill } from '../src/skills/index-block.ts';
import { skillUsesOfTurn } from '../src/skills/uses.ts';
import type { TurnCall } from '../src/skills/uses.ts';
import { runOpPrechecked } from '../src/tools/operations/index.ts';
import { buildTools } from '../src/tools/tools-json.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { utcDay } from '../src/time.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { SKILLS_T0, skillText, skillsRig } from './fixtures/skills-rig.ts';
import type { SkillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = SKILLS_T0;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROCEDURE = 'PROCEDURE_SENTENCE';

// Slice 8 of the turn frame: the `<skills>` index went, and a skill she can use is an entry of her tools array. The
// checks that read the index read the entries `buildTools` makes from the same active skills.
/** Her skill entries of the tools array for `skills`, as the turn builds them. */
const entriesOf = (skills: ReadonlyArray<ActiveSkill>) =>
  buildTools([], { skills, procedure: PROCEDURE }).map((entry) => entry.function);
/** The names of those entries. */
const entryNames = (skills: ReadonlyArray<ActiveSkill>) => entriesOf(skills).map((entry) => entry.name);
const HANDOFF: Handoff = {
  result: 'The skill is written.',
  evidence: [],
  artifacts: ['skills.local/look-it-up/SKILL.md'],
  tests: [],
  open_issues: [],
};
const iso = (at: number): string => new Date(at).toISOString();

type Rec = Record<string, unknown>;
type Result = { status: string; summary?: string; data?: unknown };

/** What the scripted model does in one turn: the tool calls it makes, in order. */
const LOOKUP_TURN: Array<[string, Array<string>]> = [
  ['web.search', ['query']],
  ['web.read', ['url']],
  ['message.create', ['text']],
];

/** The journal lines of one scripted turn. */
function journalOf(turnId: string, at: number, calls: Array<[string, Array<string>]>): Array<Rec> {
  return calls.flatMap(([tool, args], index) => {
    const base = { kind: 'action', name: 'skill', turnId, opId: `${turnId}-${index}`, scope: { channel: 'c1' } };
    return [
      { ...base, phase: 'started', occurredAt: iso(at + index * 2000), input: { skill: tool, args } },
      { ...base, phase: 'succeeded', occurredAt: iso(at + index * 2000 + 1000) },
    ];
  });
}

const journalReading = (records: ReadonlyArray<Rec>) => ({
  read: (query: { day: string; kind: string }): Array<Rec> =>
    records.filter((r) => r.kind === query.kind && utcDay(Date.parse(String(r.occurredAt))) === query.day),
});

/** The board, a fake agent `hand` with the worker role and an owner `boss`, over a memory database in memory. */
function boardOf(t: { after: (fn: () => void) => void }): Board {
  const dir = tempDir('nep-skills-flow-board-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({
      boss: { kind: 'agent', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] },
      hand: { kind: 'agent', tokenFile: 'clients/hand.token', permissions: [], boardRoles: ['worker'] },
    })
  );
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  // open.js types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
  return openBoard({
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => NOW,
    settings: () => ({
      leaseTtlMinutes: 30,
      autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
      projects: {},
    }),
    builtins: { persona: ['persona'] },
  });
}

/** Her tool calls as the operations' environment runs them, with the board and the skills port the core gives it. */
function herCalls(board: Board | null, rig: SkillsRig) {
  const hot = {
    config: { bot: { owners: ['42'], access: {} }, features: {} },
    prompts: { labels: {} },
    rootDir: tempDir('nep-skills-flow-root-'),
    reloadConfig: () => true,
  };
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    board,
    skills: rig.port,
    now: () => NOW,
  });
  return async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const { result } = await withCapturedLogs(() =>
      runOpPrechecked(name, args, {
        env,
        placeId: 'g1',
        chatId: 'c1',
        accountId: null,
        roleIds: [],
        actor: 'persona',
      })
    );
    return result;
  };
}

function ownerConsole(rig: SkillsRig) {
  const dir = tempDir('nep-skills-flow-console-');
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => NOW,
    skills: rig.port,
  };
  const desk = createConsole(deps);
  return async (line: string) => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, line);
    return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  };
}

/** The scripted calls of a turn as the use rules read them: `skill.read` names its skill. */
const callsOf = (script: Array<[string, string?]>): Array<TurnCall> =>
  script.map(([tool, name]) => (name === undefined ? { tool, ok: true } : { tool, name, ok: true }));

const indexOf = (skills: ReadonlyArray<ActiveSkill>) =>
  skills.map((skill) => ({ name: skill.name, versionId: skill.versionId, tools: skill.tools }));

test('a chain she repeated becomes a skill she uses: view, proposal, agent, activation, index, read, uses', async (t) => {
  const rig = skillsRig(t);
  const board = boardOf(t);
  const her = herCalls(board, rig);
  const owner = ownerConsole(rig);

  // 1. Three turns of the same shape, and the view of her `selfimprovement` wake lists it with the count 3.
  const records = ['t1', 't2', 't3'].flatMap((id, n) => journalOf(id, NOW - (3 - n) * DAY, LOOKUP_TURN));
  const facts = await buildSelfimprovementFacts({
    now: NOW,
    since: null,
    journal: journalReading(records),
    granted: ['web.search', 'web.read', 'message.create'],
    skills: [],
    proposals: [],
    outbox: [],
  });
  const shape = facts.shapes[0];
  assert.equal(shape?.count, 3);
  assert.deepEqual(
    shape?.steps.map((step) => step.tool),
    ['web.search', 'web.read', 'message.create']
  );

  // 2. Her scripted answer files `task.propose` of kind skill; the task holds the shape and the example turns.
  const proposed = await her('task.propose', {
    title: 'A skill for the fact lookup',
    evidence: `Chain ${shape?.steps.map((step) => step.tool).join(', ')} seen ${shape?.count} times.`,
    kind: 'skill',
    examples: shape?.turnIds ?? [],
    benefit: 'One search and one read before every fact answer.',
    evaluation: 'A fact question gets one search and one read before the answer.',
  });
  assert.equal(proposed.status, 'ok');
  const taskId = String((proposed.data as { task: { id: string } }).task.id);
  const filed = board.call('boss', 'task.show', { id: taskId }).task;
  assert.deepEqual(filed.metadata?.examples, ['t3', 't2', 't1']);
  assert.ok(String(filed.description).includes('web.search, web.read, message.create'));

  // 3. A fake agent claims the task, writes the skill file and submits.
  const plan = board.call('boss', 'task.transition', {
    id: taskId,
    status: 'triaged',
    revision: filed.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  board.call('boss', 'task.approve', { id: plan.id, scope: 'plan' });
  const held = board.call('hand', 'task.claim', { id: taskId });
  rig.writeLocal(
    'look-it-up',
    skillText(
      'look-it-up',
      'I search and read before I answer a fact',
      ['web.search', 'web.read', 'message.create'],
      'Search, read the best hit, answer.',
      taskId
    )
  );
  board.call('hand', 'task.submit', { id: taskId, generation: held.lease_generation, handoff: HANDOFF });
  assert.equal(board.call('boss', 'task.show', { id: taskId }).task.status, 'needs_validation');

  // 4. `/skills pending` lists the version, and it is in no index yet.
  const pending = await owner('/skills pending');
  assert.ok(pending.text.includes('look-it-up') && pending.text.includes(taskId), pending.text);
  assert.deepEqual(entryNames(rig.port.active()), []);

  // 5. The owner activates it; `/skills` shows the activation with who made it. Changed from the agent's own
  // activation by the owner's decision of 2026-11-04.
  assert.equal((await owner('/skills activate look-it-up')).status, 'ok');
  const listed = (await owner('/skills list')).text.split('\n').find((line) => line.includes('look-it-up')) ?? '';
  assert.ok(listed.includes('owner'), listed);

  // 6. A later turn of the same shape: the index carries the skill, `skill.read` returns its text.
  assert.deepEqual(
    entriesOf(rig.port.active()).map(({ name, description }) => [name, description]),
    [['look-it-up', `I search and read before I answer a fact\n${PROCEDURE}`]]
  );
  const read = await her('skill.read', { name: 'look-it-up' });
  assert.equal(read.status, 'ok');
  assert.ok(String(read.summary).includes('Search, read the best hit, answer.'));

  // 7. The turn's calls become uses: discovered, read, tried and succeeded.
  const turnCalls = callsOf([['skill.read', 'look-it-up'], ['web.search'], ['web.read'], ['message.create']]);
  const uses = skillUsesOfTurn({ turnId: 't4', at: NOW + HOUR, index: indexOf(rig.port.active()), calls: turnCalls });
  assert.equal(rig.port.record(uses), uses.length);
  const counts = useCountsBySkill(rig.handle, { since: 0 })['look-it-up'];
  assert.deepEqual(counts, { discovered: 1, read: 1, tried: 1, succeeded: 1, corrected: 0, declined: 0 });
});

test('a SKILL.md that no agent activated is never in her index, and she cannot read it', async (t) => {
  const rig = skillsRig(t);
  const her = herCalls(null, rig);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I search and read first', ['web.search']));
  rig.writeTracked('tracked-habit', skillText('tracked-habit', 'a tracked one', ['web.read']));
  for (let turn = 0; turn < 3; turn += 1) assert.deepEqual(entryNames(rig.port.active()), []);
  assert.equal((await her('skill.read', { name: 'look-it-up' })).status, 'failed');
  assert.equal(
    (await ownerConsole(rig)('/skills pending')).text.includes('tracked-habit'),
    true,
    'a tracked skill is pending too'
  );
});

test('an activation grants no tool: the skill is unavailable until the owner grants the tool, and her grants never moved', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('ping-someone', skillText('ping-someone', 'I ping when asked', ['pings.set']));
  const grantedBefore = [...rig.granted].sort();
  rig.port.activate('ping-someone', 'owner');
  const line =
    (await ownerConsole(rig)('/skills list')).text.split('\n').find((one) => one.includes('ping-someone')) ?? '';
  assert.ok(line.includes('pings.set') && line.includes('not-granted'), line);
  assert.deepEqual(entryNames(rig.port.active()), []);
  assert.deepEqual([...rig.granted].sort(), grantedBefore);
  rig.granted.add('pings.set');
  assert.ok(entryNames(rig.port.active()).includes('ping-someone'));
});

test('her own switch takes a skill out of the index and the owner brings it back with /skills enable', async (t) => {
  const rig = skillsRig(t);
  const her = herCalls(null, rig);
  const owner = ownerConsole(rig);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I search and read first', ['web.search']));
  rig.port.activate('look-it-up', 'owner');
  assert.ok(entryNames(rig.port.active()).includes('look-it-up'));
  assert.equal((await her('skill.disable', { name: 'look-it-up' })).status, 'ok');
  assert.deepEqual(entryNames(rig.port.active()), []);
  assert.equal((await owner('/skills enable look-it-up')).status, 'ok');
  assert.ok(entryNames(rig.port.active()).includes('look-it-up'));
});
